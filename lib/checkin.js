/**
 * 每日签到 / 领取积分。
 *
 * 协议不是猜的，是从上游客户端行为里核对过的（另外 `dsh-our-free-model`
 * 的实现也印证了同一组端点）：
 *
 * - **WorkBuddy / CodeBuddy**
 *   - `POST {endpoint}/v2/billing/meter/checkin-activity-status`  body `{}`
 *     返回 `data.{active, today_checked_in, streak_days, daily_credit, ...}`；
 *   - `POST {endpoint}/v2/billing/meter/daily-checkin`  body `{}`
 *     返回 `code`：`0` 成功；`10001/1001` 今天已领；`1002` 无资格；`1003` 活动结束。
 *   - 额外头：`X-Domain` / `X-Product: SaaS` / `X-Product-Code`。
 * - **Qoder**
 *   - `GET  {openApi}/sash/api/v1/me/campaigns` 列出活动；
 *   - `POST {openApi}/sash/api/v1/me/campaigns/{id}/claim` 逐个领取。
 *   只领 `actionType === 'CLAIM_BENEFIT'` 且可领的那些。
 *
 * 设计原则：**任何失败都只是「这次没领到」**，绝不让签到把插件搞挂。
 *
 * @module dsh-reverse-proxy-connect/checkin
 */

import { endpointsFor as qoderEndpoints } from './qoder/transport.js'
import { endpointsFor } from './workbuddy/credentials.js'
import { attributionHeaders } from './attribution.js'
import { withTimeout } from './timeout.js'

/** 单次签到请求超时。 */
const TIMEOUT_MS = 20_000

/** WorkBuddy 的签到响应码。 */
const CODE = {
  ok: 0,
  alreadyClaimed: [10001, 1001],
  noQualification: 1002,
  activityEnded: 1003,
}

/**
 * 归一化的签到结果。
 * @param kind - `active | inactive | already | claimed | failed`
 * @param extra - 附加字段。
 * @returns 结果对象。
 */
function result(kind, extra = {}) {
  return { kind, fetchedAt: Date.now(), ...extra }
}

/** WorkBuddy 签到请求头。 */
function checkinHeaders(credential, productCode, userAgent) {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Domain': credential.domain || '',
    'X-Product': 'SaaS',
    'X-Product-Code': productCode,
    'User-Agent': userAgent,
    ...attributionHeaders(),
    ...(credential.uid === undefined || credential.uid === '' ? {} : { 'X-User-Id': credential.uid }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? {}
      : { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId }),
  }
}

/** 每个变体的端点与产品标识。 */
function workbuddyTarget(variantId) {
  const { chatBase } = endpointsFor(variantId)
  return variantId === 'workbuddy'
    ? { endpoint: chatBase, productCode: 'codebuddy', userAgent: 'CodeBuddyIDE/1.106.1' }
    : { endpoint: chatBase, productCode: 'workbuddy', userAgent: 'WorkBuddy/5.5.2' }
}

/** 发一个签到相关的 POST，返回 `{ok, status, body, message}`。 */
async function postCheckin(variantId, credential, path, signal) {
  const target = workbuddyTarget(variantId)
  try {
    const response = await fetch(`${target.endpoint}${path}`, {
      method: 'POST',
      headers: checkinHeaders(credential, target.productCode, target.userAgent),
      body: '{}',
      // 必须与外部取消取并集：只写 `signal ?? timeout` 时，runtime 永远会传
      // signal，单请求超时就永远不生效，挂死的计费端点会把签到一直拖住。
      signal: withTimeout(signal, TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) return { ok: false, status: response.status, message: `HTTP ${String(response.status)}：${text.slice(0, 120)}` }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, status: response.status, message: '响应不是 JSON' }
    }
    if (body === null || typeof body !== 'object') return { ok: false, status: response.status, message: '响应格式异常' }
    return { ok: true, status: response.status, body }
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 把 `checkin-activity-status` 的响应体解释成归一化状态。
 *
 * 单独抽出来是为了可测：签到这类「一天只能点一次」的接口，线上没法反复试，
 * 只能靠纯函数把各种码覆盖住。
 *
 * @param body - 响应 JSON。
 * @returns 归一化状态。
 */
export function interpretCheckinStatus(body) {
  if (body === null || typeof body !== 'object') return result('failed', { message: '响应格式异常' })
  if (body.code !== CODE.ok) return result('failed', { message: String(body.msg ?? `code ${String(body.code)}`) })
  const data = body.data !== null && typeof body.data === 'object' ? body.data : {}
  if (data.active === false) return result('inactive', { activityName: '', dailyCredit: 0, streakDays: 0 })
  if (data.active !== true) {
    // `data` 为空对象/null 是上游明确表示「没有活动」；但 data 里已经有别的
    // 字段却没有 active，通常是 schema 改名。后者不能当成「今天已完成」，
    // 否则用户整天都不会再重试，额度也永远领不到。
    const hasFields = Object.keys(data).length > 0
    if (hasFields) return result('failed', { message: '签到状态响应缺少 active 字段' })
    return result('inactive', { activityName: '', dailyCredit: 0, streakDays: 0 })
  }
  return result(data.today_checked_in === true ? 'already' : 'active', {
    activityName: typeof data.activity_name === 'string' ? data.activity_name : '',
    dailyCredit: typeof data.daily_credit === 'number' ? data.daily_credit : 0,
    todayCredit: typeof data.today_credit === 'number' ? data.today_credit : 0,
    streakDays: typeof data.streak_days === 'number' ? data.streak_days : 0,
    totalCredits: typeof data.total_credits === 'number' ? data.total_credits : 0,
    checkinDates: Array.isArray(data.checkin_dates) ? data.checkin_dates.filter((item) => typeof item === 'string') : [],
    endsAt: typeof data.end_time === 'string' ? data.end_time : '',
  })
}

/**
 * 把 `daily-checkin` 的响应体解释成归一化结果。
 * @param body - 响应 JSON。
 * @returns 归一化结果。
 */
export function interpretClaim(body) {
  if (body === null || typeof body !== 'object') return result('failed', { message: '响应格式异常' })
  const code = typeof body.code === 'number' ? body.code : -1
  if (CODE.alreadyClaimed.includes(code)) return result('already', { message: '今天已签到' })
  if (code === CODE.noQualification) return result('inactive', { message: '当前账号没有签到资格' })
  if (code === CODE.activityEnded) return result('inactive', { message: '签到活动已结束' })
  if (code !== CODE.ok) return result('failed', { message: String(body.msg ?? `code ${String(code)}`) })
  const data = body.data !== null && typeof body.data === 'object' ? body.data : {}
  const credit = [data.credit, data.creditAmount, data.amount, data.daily_credit]
    .find((value) => typeof value === 'number' && value > 0)
  return result('claimed', {
    credit: credit ?? 0,
    streakDays: typeof data.streak_days === 'number' ? data.streak_days : 0,
    message: '签到成功',
  })
}

/**
 * 读 WorkBuddy 的签到状态。
 *
 * @param variantId - `workbuddy` 或 `workbuddy-ai`。
 * @param credential - 凭证。
 * @param signal - 取消。
 * @returns 归一化状态。
 */
export async function workbuddyCheckinStatus(variantId, credential, signal) {
  const response = await postCheckin(variantId, credential, '/v2/billing/meter/checkin-activity-status', signal)
  if (!response.ok) return result('failed', { message: response.message })
  return interpretCheckinStatus(response.body)
}

/**
 * 执行 WorkBuddy 的每日签到。
 *
 * @param variantId - 变体。
 * @param credential - 凭证。
 * @param signal - 取消。
 * @returns 归一化结果（`claimed` / `already` / `inactive` / `failed`）。
 */
export async function workbuddyClaimCheckin(variantId, credential, signal) {
  const response = await postCheckin(variantId, credential, '/v2/billing/meter/daily-checkin', signal)
  if (!response.ok) return result('failed', { message: response.message })
  return interpretClaim(response.body)
}

/**
 * Qoder 的活动列表（只读）。
 *
 * @param identity - `resolveIdentity()` 的返回值。
 * @param region - `china` / `global`。
 * @param signal - 取消。
 * @returns 归一化列表。
 */
export async function qoderCampaigns(identity, region, signal) {
  const { openApiUrl } = qoderEndpoints(region)
  try {
    const response = await fetch(`${openApiUrl}/sash/api/v1/me/campaigns`, {
      headers: qoderHeaders(identity),
      signal: withTimeout(signal, TIMEOUT_MS),
    })
    if (!response.ok) return result('failed', { message: `HTTP ${String(response.status)}` })
    const body = await response.json()
    const campaigns = Array.isArray(body?.campaigns) ? body.campaigns : []
    const claimable = campaigns.filter((item) => item?.actionType === 'CLAIM_BENEFIT' && item?.claimStatus !== 'CLAIMED')
    return result(claimable.length > 0 ? 'active' : 'inactive', {
      claimable: claimable.length,
      total: campaigns.length,
      campaigns: claimable.map((item) => ({
        id: String(item.campaignId ?? ''),
        title: typeof item.title === 'string' ? item.title : '',
      })),
    })
  } catch (error) {
    return result('failed', { message: error instanceof Error ? error.message : String(error) })
  }
}

/** Qoder 请求头。 */
function qoderHeaders(identity) {
  return {
    accept: 'application/json',
    'accept-encoding': 'identity',
    'user-agent': 'qoder/1.1.47',
    'cosy-version': '1.0.1',
    'cosy-clienttype': '5',
    ...attributionHeaders(),
    authorization: `Bearer ${identity.authToken}`,
  }
}

/**
 * 解释一次活动领取的响应体。
 *
 * HTTP 200 只代表「请求被接收」，Qoder 的业务失败同样会以 200 + `{code, message}`
 * 返回。旧实现只要状态码是 2xx 就 `claimed += 1`：活动已结束 / 无资格的日子，
 * 卡片与账本照样写「本次领到 0 分、已领取 1 个活动」，签到被测成成功、当天
 * 不会重试 —— 而奖励一分都没到账。
 *
 * 判据刻意保守：只有**明确的失败证据**（非 0 的业务码 / `success:false` /
 * 顶层 `error`）才算失败。空响应体或无法识别字段按「上游已收下」处理 ——
 * 把它当成失败会让一次网络代理的裁剪响应触发整天的重试。
 *
 * @param body - 领取接口的响应 JSON（可能是 undefined）。
 * @returns `{kind:'claimed'|'failed', credit?, message?}`。
 */
export function interpretCampaignClaim(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return result('claimed', { credit: 0 })
  }
  const rawCode = body.code
  const code = typeof rawCode === 'number'
    ? rawCode
    : typeof rawCode === 'string' && /^-?\d+$/.test(rawCode.trim()) ? Number(rawCode.trim()) : undefined
  const error = body.error
  // `0` / `200` 是两家 Qoder 网关出现过的「成功」业务码；`success:true` 直接放行，
  // 避免把上游换了成功码的日子全判成失败。
  const failure =
    body.success === false
    || (body.success !== true && typeof code === 'number' && code !== 0 && code !== 200)
    || (body.data !== null && typeof body.data === 'object' && body.data.success === false)
    || (typeof error === 'string' && error.trim() !== '')
    || (error !== null && typeof error === 'object' && !Array.isArray(error))
  if (failure) {
    const message = [body.message, body.msg, typeof error === 'string' ? error : error?.message]
      .find((value) => typeof value === 'string' && value.trim() !== '')
    return result('failed', {
      message: message ?? (typeof code === 'number' ? `领取失败（code ${String(code)}）` : '领取失败'),
    })
  }
  const amount = [body?.data?.credit, body?.data?.amount, body?.credit]
    .find((value) => typeof value === 'number' && Number.isFinite(value))
  return result('claimed', { credit: typeof amount === 'number' ? amount : 0 })
}

/**
 * 领取 Qoder 当前可领的活动奖励。
 *
 * @param identity - 身份。
 * @param region - 区域。
 * @param signal - 取消。
 * @returns 归一化结果。
 */
export async function qoderClaimCampaigns(identity, region, signal) {
  const list = await qoderCampaigns(identity, region, signal)
  if (list.kind === 'failed') return list
  if (list.kind === 'inactive') return result('inactive', { message: '今天没有可领取的活动' })

  const { openApiUrl } = qoderEndpoints(region)
  let credit = 0
  let claimed = 0
  let firstError
  for (const campaign of list.campaigns) {
    try {
      const response = await fetch(
        `${openApiUrl}/sash/api/v1/me/campaigns/${encodeURIComponent(campaign.id)}/claim`,
        { method: 'POST', headers: qoderHeaders(identity), body: '{}', signal: withTimeout(signal, TIMEOUT_MS) },
      )
      if (!response.ok) {
        if (firstError === undefined) firstError = `HTTP ${String(response.status)}`
        continue
      }
      const body = await response.json().catch(() => undefined)
      const verdict = interpretCampaignClaim(body)
      if (verdict.kind !== 'claimed') {
        if (firstError === undefined) firstError = verdict.message ?? '领取失败'
        continue
      }
      claimed += 1
      credit += verdict.credit ?? 0
    } catch (error) {
      if (firstError === undefined) firstError = error instanceof Error ? error.message : String(error)
    }
  }
  if (claimed === 0) return result('failed', { message: firstError ?? '领取失败' })
  return result('claimed', {
    credit,
    claimed,
    message: firstError === undefined ? `已领取 ${String(claimed)} 个活动` : `已领取 ${String(claimed)} 个活动（另有一项失败：${firstError}）`,
  })
}

