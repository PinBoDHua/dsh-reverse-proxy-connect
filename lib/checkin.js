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
 *   - 两个接口都要桌面客户端身份：`cosy-clienttype: 10`；**国际版**还要
 *     umid 机器身份（`Cosy-MachineToken/Code/Type`），否则每日活动会被
 *     裁成只剩常驻的 `VIEW_DETAILS` 横幅——看起来就像「没有签到活动」。
 *
 * 设计原则：**任何失败都只是「这次没领到」**，绝不让签到把插件搞挂。
 *
 * @module dsh-reverse-proxy-connect/checkin
 */

import { qoderCampaignsReady } from './checkin-schedule.js'
import { endpointsFor as qoderEndpoints } from './qoder/transport.js'
import { umidHeadersFor, invalidateUmidCache } from './qoder/umid.js'
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

/** Qoder 活动列表里视为「可领取」的 claimStatus。 */
const CLAIMABLE_STATUS = new Set(['CLAIMABLE', 'AVAILABLE'])

/** UTC+8 自然日键，用于判断活动属于哪一轮。 */
function utc8DayKey(at) {
  const shifted = new Date(at + 8 * 3600_000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${String(shifted.getUTCFullYear())}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/** 活动开始时间（上游给秒，兼容毫秒；数字字符串也认，R25）。 */
function campaignStartAtMs(item) {
  const raw = item?.startAt
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isFinite(value) || value <= 0) return undefined
  return value > 1e12 ? value : value * 1000
}

/** 这个活动是否是今天（UTC+8）这一轮。 */
function campaignStartsToday(item, now) {
  const start = campaignStartAtMs(item)
  if (start === undefined) return false
  return utc8DayKey(start) === utc8DayKey(now)
}

/** 活动是否可领。 */
function campaignClaimable(item) {
  if (item?.actionType !== 'CLAIM_BENEFIT') return false
  // 实测当前网关用 CLAIMABLE；历史/测试里出现过 AVAILABLE。claimStatus 缺失时
  // 仍尝试一次（旧实现就是这么做的），明确的状态值（EXPIRED / CLAIMED……）则跳过。
  if (item.claimStatus === undefined || item.claimStatus === null) return true
  return CLAIMABLE_STATUS.has(item.claimStatus)
}

/** 活动展示名（列表顶层的 title 常为空，真正文案在 placements 里）。 */
function campaignTitle(item) {
  const placements = Array.isArray(item?.placements) ? item.placements : []
  for (const placement of placements) {
    const content = placement?.content
    if (content === null || typeof content !== 'object') continue
    const localized = content.zh ?? content.en
    if (localized !== null && typeof localized === 'object' && typeof localized.title === 'string' && localized.title !== '') {
      return localized.title
    }
  }
  return typeof item?.title === 'string' ? item.title : ''
}

/**
 * 解释 Qoder 的活动列表。
 *
 * 这里有四件容易被忽略的事，都会直接导致「今天领不到」：
 *
 * 1. **请求头必须是桌面客户端身份**（`Cosy-ClientType: 10`）。用 CLI 身份
 *    （`5`）时网关返回 `showCampaign:false` + 空数组——卡片上就是「没有
 *    可领取的活动」，而官方客户端里明明有 100 Credits。
 * 2. **国际版还要 umid 机器身份**（`Cosy-MachineToken/Code/Type`）。缺这组
 *    头时网关只回常驻的 `VIEW_DETAILS` 横幅，每日 `CLAIM_BENEFIT` 轮次被
 *    整条裁掉。这种「列表被裁」必须报「需要桌面端机器身份 / 稍后重试」，
 *    不能报「当前账号没有签到活动」——后者会让用户以为活动不存在。
 * 3. **每天 10:00（UTC+8）才刷新**。10 点前看到的是昨天那一轮；即使它已经
 *    显示 CLAIMED，也不能算今天已完成，否则 10 点后调度器不再重试。
 * 4. 活动自带 `startAt`。用它判断「这一轮是不是今天的」比单纯看钟点更稳：
 *    新活动延迟上架时，旧活动的 startAt 仍是昨天，结论会是「等下一轮」
 *    而不是「今天已领」。
 *
 * @param body - `GET /sash/api/v1/me/campaigns` 的响应体。
 * @param now - 当前时间（测试可注入）。
 * @param options - `{ region, machineIdentity }`：请求发往哪个区域、这次请求
 *   是否真的带上了 umid 三件套。省略时按「国内版 / 身份齐全」处理，保持
 *   旧调用方的语义不变。
 * @returns 归一化列表（`active` / `already` / `pending` / `inactive` / `failed`）。
 */
export function interpretQoderCampaigns(body, now = Date.now(), options = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return result('failed', { message: '活动列表响应格式异常' })
  }
  const region = options.region ?? 'china'
  const machineIdentity = options.machineIdentity !== false
  const campaigns = Array.isArray(body.campaigns) ? body.campaigns : []
  const benefits = campaigns.filter((item) => item?.actionType === 'CLAIM_BENEFIT')
  const claimable = benefits.filter((item) => campaignClaimable(item))
  const claimedToday = benefits.filter((item) => item?.claimStatus === 'CLAIMED' && campaignStartsToday(item, now))
  const ready = qoderCampaignsReady(now)

  if (claimable.length > 0) {
    // 刷新前能领的是昨天那一轮：可以领，但 `coversToday:false` 会阻止调度器
    // 把今天标成已完成；10 点后还会再跑一次领今天这一轮。
    //
    // 注意不能写成 `ready || startsToday`：10 点后新活动可能延迟上架，旧的
    // 可领活动 `startAt` 仍是昨天，此时 ready 为真会把「领了昨天那一轮」
    // 当成今天已完成。有 startAt 就只认「活动开始日是不是今天」。
    const hasStart = claimable.some((item) => campaignStartAtMs(item) !== undefined)
    // 无 startAt 证明不了「这一轮是今天的」：即使过了刷新时刻也不能写
    // coversToday=true，否则新轮次延迟上架时今天的奖励静默丢失（R25）。
    // 真实网关恒发 startAt，此分支只在上游 schema 漂移时生效；领取照常，
    // 调度器保持 10 分钟复查（事件去重 1 小时，不会刷满账本）。
    const coversToday = hasStart && claimable.some((item) => campaignStartsToday(item, now))
    return result('active', {
      claimable: claimable.length,
      total: campaigns.length,
      campaigns: claimable.map((item) => ({
        id: String(item.campaignId ?? ''),
        title: campaignTitle(item),
      })),
      coversToday,
      machineIdentity,
      ...(coversToday ? {} : {
        message: hasStart
          ? '今天 10:00（UTC+8）后的新一轮还没刷新，本次先领上一轮'
          : '活动没带开始时间，先领取可见奖励，今天这一轮稍后自动复查',
      }),
    })
  }
  if (claimedToday.length > 0) {
    return result('already', { coversToday: true, machineIdentity, message: '今天已签到' })
  }
  if (!ready) {
    return result('pending', {
      coversToday: false,
      machineIdentity,
      message: '今天的活动 10:00（UTC+8）才刷新，稍后自动领取',
    })
  }
  if (benefits.length === 0) {
    // 国际版的每日轮次按 umid 机器身份下发。没有这组头时网关只回
    // `VIEW_DETAILS` 横幅或空列表；把它说成「没有活动」正是这次要修的谎。
    // 空列表同样可能是被裁的结果（R25：旧判据要求 campaigns.length>0）。
    if (region === 'global' && !machineIdentity) {
      return result('pending', {
        coversToday: false,
        gated: true,
        machineIdentity,
        message: 'Qoder 国际版的每日活动按桌面客户端的机器身份下发；当前读不到 umid 身份，请安装/打开 Qoder 桌面端后点「立即签到」重试',
      })
    }
    // 到了刷新时刻却只有常驻活动 / 空数组：可能是新轮次延迟上架，也可能是
    // 后端刚滚动的瞬间。记 pending（10 分钟后再看），不要一整天钉死成
    // 「没有签到活动」。
    if (body.showCampaign === true || campaigns.length > 0) {
      return result('pending', {
        coversToday: false,
        machineIdentity,
        message: '活动列表里暂时只有常驻活动，今天这一轮还没出现，稍后自动重试',
      })
    }
    return result('inactive', {
      machineIdentity,
      message: '当前账号没有每日领取活动（若从未领取，请先用 Qoder 客户端登录一次开通）',
    })
  }
  // 到了刷新时刻，但列表里只有上一轮（startAt 仍是昨天）——新活动可能延迟上架。
  // 记 pending 而不是 already，保留 10 分钟重试。
  return result('pending', {
    coversToday: false,
    machineIdentity,
    message: '今天的新一轮活动还没出现，稍后自动重试',
  })
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
    const headers = await qoderHeaders(identity, region)
    const response = await fetch(`${openApiUrl}/sash/api/v1/me/campaigns`, {
      headers,
      signal: withTimeout(signal, TIMEOUT_MS),
    })
    if (!response.ok) return result('failed', { message: `HTTP ${String(response.status)}` })
    const interpreted = interpretQoderCampaigns(await response.json(), Date.now(), {
      region,
      machineIdentity: typeof headers['Cosy-MachineToken'] === 'string' && headers['Cosy-MachineToken'] !== '',
    })
    // 国际版仍「被裁 / 待就绪」：作废 umid 成功缓存，下一轮重试重新读二进制，
    // 覆盖 machineToken 轮换（R25）。国内版不读 umid，无需作废。
    if (region === 'global' && (interpreted.gated === true || interpreted.kind === 'pending')) {
      invalidateUmidCache()
    }
    return interpreted
  } catch (error) {
    return result('failed', { message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Qoder 请求头。
 *
 * `cosy-clienttype` 必须是 **10**（桌面客户端）。实测同一枚 job token 下：
 * `5` → `{showCampaign:false, campaigns:[]}`；`10` → 正常返回每日活动。
 * 这不是 UA 或版本号的问题（UA 换成 `Qoder` 也是同样的结果）。
 *
 * 国际版还要带 umid 机器身份三件套，否则每日活动会被裁成只剩
 * `VIEW_DETAILS` 横幅（见 `qoder/umid.js`）。国内版不需要这组头，这里也就
 * 不去启动本机的 umid 二进制。领取接口按官方客户端补 `origin`，重复领取时
 * 网关仍会幂等返回 `replayed:true`。
 *
 * @param identity - 身份。
 * @param region - `china` / `global`。
 * @param json - 是否带 JSON 请求体（领取接口）。
 * @returns 头字典（异步：首次调用可能要启动 umid 二进制）。
 */
async function qoderHeaders(identity, region, json = false) {
  const { openApiUrl } = qoderEndpoints(region)
  return {
    accept: 'application/json',
    'accept-encoding': 'identity',
    'user-agent': 'Qoder',
    'cosy-version': '1.0.1',
    'cosy-clienttype': '10',
    ...(region === 'global' ? await umidHeadersFor() : {}),
    ...(json ? { 'content-type': 'application/json', origin: openApiUrl } : {}),
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
 * 当前 Qoder 的成功形状是：
 * `{status:'CLAIMED', replayed:true|false, benefit:{amount:100}, ...}`。
 * 重复领取会带 `replayed:true`，必须认成 already，不能报成新领到 100 分。
 *
 * 判据刻意保守：只有**明确的失败证据**（非 0 的业务码 / `success:false` /
 * 顶层 `error`）才算失败。空响应体或无法识别字段按「上游已收下」处理 ——
 * 把它当成失败会让一次网络代理的裁剪响应触发整天的重试。
 *
 * @param body - 领取接口的响应 JSON（可能是 undefined）。
 * @returns `{kind:'claimed'|'already'|'failed', credit?, message?}`。
 */
export function interpretCampaignClaim(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return result('claimed', { credit: 0 })
  }
  if (body.replayed === true) return result('already', { message: '今天已签到' })
  if (typeof body.status === 'string') {
    if (body.status === 'CLAIMED') {
      const amount = [body?.benefit?.amount, body?.data?.credit, body?.data?.amount, body?.credit]
        .find((value) => typeof value === 'number' && Number.isFinite(value))
      return result('claimed', { credit: typeof amount === 'number' ? amount : 0 })
    }
    return result('failed', { message: `领取未成功（status=${body.status}）` })
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
  // active 以外（already / pending / inactive / failed）都不需要再打领取接口，
  // 原样带回：pending 的结论必须是「稍后重试」，不能被改写成 inactive。
  if (list.kind !== 'active') return list

  const { openApiUrl } = qoderEndpoints(region)
  const headers = await qoderHeaders(identity, region, true)
  const coversToday = list.coversToday !== false
  let credit = 0
  let claimed = 0
  let already = 0
  let firstError
  for (const campaign of list.campaigns) {
    try {
      const response = await fetch(
        `${openApiUrl}/sash/api/v1/me/campaigns/${encodeURIComponent(campaign.id)}/claim`,
        { method: 'POST', headers, body: '{}', signal: withTimeout(signal, TIMEOUT_MS) },
      )
      if (!response.ok) {
        if (firstError === undefined) firstError = `HTTP ${String(response.status)}`
        continue
      }
      const body = await response.json().catch(() => undefined)
      const verdict = interpretCampaignClaim(body)
      if (verdict.kind === 'claimed') {
        claimed += 1
        credit += verdict.credit ?? 0
      } else if (verdict.kind === 'already') {
        already += 1
      } else if (firstError === undefined) {
        firstError = verdict.message ?? '领取失败'
      }
    } catch (error) {
      if (firstError === undefined) firstError = error instanceof Error ? error.message : String(error)
    }
  }
  if (claimed > 0) {
    const suffix = coversToday ? '' : '；今天 10:00（UTC+8）后的新一轮会再自动领取'
    return result('claimed', {
      credit,
      claimed,
      coversToday,
      message: firstError === undefined
        ? `已领取 ${String(claimed)} 个活动${suffix}`
        : `已领取 ${String(claimed)} 个活动（另有一项失败：${firstError}）${suffix}`,
    })
  }
  if (already > 0) return result('already', { coversToday, message: '今天已签到' })
  return result('failed', { message: firstError ?? '领取失败' })
}

