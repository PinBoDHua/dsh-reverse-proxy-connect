/**
 * 各账号的积分 / 额度。
 *
 * WorkBuddy 与 Qoder 的账目各有两套口径（Trae 的额度在 `lib/trae/transport.js`）：
 *
 * - **WorkBuddy（个人）**：`POST {billing}/v2/billing/meter/get-user-resource`，
 *   返回一张套餐包列表（`Accounts[]`）。每个包同时有「周期额度」与「总量」两组字段，
 *   必须按周期优先来算，否则会把已过周期的一次性余额当成可用。
 * - **WorkBuddy（企业）**：`POST {cnBilling}/v2/billing/meter/get-enterprise-user-usage`，
 *   只有一个 `limitNum` / `credit` 对，`limitNum === -1` 表示不限量。
 * - **Qoder**：`GET {openApi}/api/v2/quota/usage` 给 `userQuota{total,used,remaining}`，
 *   `GET /api/v2/user/plan` 给套餐名，`GET /api/v3/user/status` 给 `nextResetAt`。
 *
 * 额度读取**绝不能**影响模型可用性：任何失败都退化成 `state:'error'` 并带上原因，
 * 卡片上显示为「暂时读不到」，而不是让整张卡片崩掉。
 *
 * @module dsh-reverse-proxy-connect/credits
 */

import { REASON } from './protocol.js'
import { attributionHeaders } from './attribution.js'
import { withTimeout } from './timeout.js'
import { endpointsFor as workbuddyEndpoints } from './workbuddy/credentials.js'
import { endpointsFor as qoderEndpoints } from './qoder/transport.js'

/** 单次额度请求的超时。 */
const CREDITS_TIMEOUT_MS = 20_000

/** 空结果（未登录 / 尚未取过）。 */
export function emptyCredits() {
  return { state: 'none', remain: 0, total: 0, unit: 'credits', items: [], fetchedAt: 0 }
}

/**
 * 解析 `"2026-10-18 12:04:44"` 这种无时区时间，按**本机本地时区**理解。
 *
 * 上游给的是用户在客户端里看到的挂钟时间，不带偏移；`new Date("2026-10-18 12:04:44")`
 * 在部分引擎里会被当 UTC 或被拒，所以手工拼。
 *
 * @param value - 时间字符串。
 * @returns 毫秒时间戳，或 undefined。
 */
export function parseLocalTime(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim())
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  const time = date.getTime()
  return Number.isNaN(time) ? undefined : time
}

/**
 * 把一个套餐包折算成「这个周期还能用多少」。
 *
 * 周期优先：`CycleCapacitySize > 0` 时这个包是周期配额，只能看 `CycleCapacityRemain`；
 * 否则才退到一次性余额 `CapacityRemain`。这条规则来自上游客户端自己的口径 ——
 * 否则会把已过期周期里的一次性余额算成可用。
 *
 * @param row - `Accounts[]` 里的一项。
 * @returns `{remain, total, countToward}`。
 */
function remainingOfPackage(row) {
  const number = (key) => (typeof row[key] === 'number' ? row[key] : 0)
  const cycleSize = number('CycleCapacitySize')
  const cycleRemain = number('CycleCapacityRemain')
  const cycleUsed = number('CycleCapacityUsed')
  const capacityRemain = number('CapacityRemain')
  const capacitySize = number('CapacitySize')

  if (cycleSize > 0) return { remain: Math.max(0, cycleRemain), total: cycleSize, countToward: true }
  if (cycleRemain > 0 || cycleUsed > 0) return { remain: Math.max(0, cycleRemain), total: Math.max(cycleSize, cycleRemain), countToward: true }
  return { remain: Math.max(0, capacityRemain), total: capacitySize, countToward: true }
}

/**
 * 读 WorkBuddy 一个变体的额度。
 *
 * @param variantId - `workbuddy` 或 `workbuddy-ai`。
 * @param credential - `readDesktopCredential()` 的返回值。
 * @param signal - 取消。
 * @returns 归一化额度。
 */
export async function fetchWorkBuddyCredits(variantId, credential, signal) {
  const { chatBase } = workbuddyEndpoints(variantId)
  const billingBase = variantId === 'workbuddy' ? 'https://www.codebuddy.cn' : chatBase
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...attributionHeaders(),
    ...(credential.uid === '' ? {} : { 'X-User-Id': credential.uid }),
    ...(credential.enterpriseId === ''
      ? {}
      : { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId }),
    ...(credential.domain === '' ? {} : { 'X-Domain': credential.domain }),
  }
  // 外部取消与单请求超时取并集：只写 `signal ?? timeout` 时，runtime 传了
  // signal 就永远不会有超时，一张卡住的额度请求能让卡片永远停在「读取中」。
  const timeout = withTimeout(signal, CREDITS_TIMEOUT_MS)

  // 企业账号走另一条端点（只有一个总量，不是套餐列表）。
  if (variantId === 'workbuddy' && credential.enterpriseId !== '') {
    return await fetchEnterpriseCredits(billingBase, headers, timeout)
  }

  const now = new Date()
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatLocal(now),
    // 上游自己的客户端也往后看 100 年，这里照抄，避免漏掉长期包。
    PackageEndTimeRangeEnd: formatLocal(new Date(now.getTime() + 3_185_136_000_000)),
  }
  const response = await fetch(`${billingBase}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: timeout,
  })
  const text = await response.text()
  if (!response.ok) throw new CreditsError(`WorkBuddy 额度接口返回 HTTP ${String(response.status)}：${text.slice(0, 160)}`)
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch (cause) {
    throw new CreditsError('WorkBuddy 额度接口返回了非 JSON。', cause)
  }
  if (envelope?.code !== 0) throw new CreditsError(`WorkBuddy 额度接口：${String(envelope?.msg ?? 'unknown')}`)
  const rows = Array.isArray(envelope?.data?.Response?.Data?.Accounts) ? envelope.data.Response.Data.Accounts : []

  let remain = 0
  let total = 0
  const items = []
  let soonestEnd
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const { remain: rowRemain, total: rowTotal } = remainingOfPackage(row)
    const endAtMs = parseLocalTime(row.CycleEndTime) ?? parseLocalTime(row.ExpiredTime)
    const expired = typeof row.Status === 'number' && row.Status !== 0
    items.push({
      name: typeof row.PackageName === 'string' && row.PackageName !== '' ? row.PackageName : '额度包',
      remain: rowRemain,
      total: rowTotal,
      ...(endAtMs === undefined ? {} : { endAtMs }),
      ...(expired ? { expired: true } : {}),
    })
    // 已耗尽的包不计入总量：把 5000 的过期包算进去会让「675 / 7700」这种
    // 数字看起来像额度快没了，而实际可用的是那 675。
    if (expired) continue
    remain += rowRemain
    total += rowTotal
    if (rowRemain > 0 && endAtMs !== undefined && (soonestEnd === undefined || endAtMs < soonestEnd)) soonestEnd = endAtMs
  }
  return {
    state: 'ok',
    remain,
    total,
    unit: 'credits',
    ...(soonestEnd === undefined ? {} : { resetAtMs: soonestEnd }),
    items: items.sort((a, b) => Number(a.expired === true) - Number(b.expired === true) || b.remain - a.remain),
    fetchedAt: Date.now(),
  }
}

/**
 * 企业账号的额度：单个周期额度，`limitNum === -1` 表示不限量。
 * @param billingBase - 计费基址。
 * @param headers - 认证头。
 * @param signal - 取消。
 * @returns 归一化额度。
 */
async function fetchEnterpriseCredits(billingBase, headers, signal) {
  const response = await fetch(`${billingBase}/v2/billing/meter/get-enterprise-user-usage`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
    signal,
  })
  const text = await response.text()
  if (!response.ok) throw new CreditsError(`WorkBuddy 企业额度接口返回 HTTP ${String(response.status)}：${text.slice(0, 160)}`)
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch (cause) {
    throw new CreditsError('WorkBuddy 企业额度接口返回了非 JSON。', cause)
  }
  if (envelope?.code !== 0) throw new CreditsError(`WorkBuddy 企业额度接口：${String(envelope?.msg ?? 'unknown')}`)
  // 官方客户端两处拼写不一致，两种都收。
  const sources = [envelope?.data?.data, envelope?.data].filter((value) => value !== null && typeof value === 'object')
  for (const source of sources) {
    const limit = typeof source.limitNum === 'number' ? source.limitNum : typeof source.limit_num === 'number' ? source.limit_num : undefined
    if (limit === undefined) continue
    if (limit === -1) {
      return { state: 'ok', remain: 0, total: 0, unlimited: true, unit: 'credits', items: [{ name: '企业额度', remain: 0, total: 0, unlimited: true }], fetchedAt: Date.now() }
    }
    const used = typeof source.credit === 'number' ? source.credit : typeof source.used_num === 'number' ? source.used_num : 0
    const remain = Math.max(0, limit - used)
    return {
      state: 'ok',
      remain,
      total: limit,
      unit: 'credits',
      items: [{ name: '企业额度', remain, total: limit }],
      fetchedAt: Date.now(),
    }
  }
  throw new CreditsError('WorkBuddy 企业额度接口没有返回可识别的额度字段。')
}

/** 把 Date 格式化成上游要的 `YYYY-MM-DD HH:mm:ss`（本机时区）。 */
function formatLocal(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 读 Qoder 一个区域的额度。
 *
 * @param identity - `resolveIdentity()` 的返回值。
 * @param region - `china` 或 `global`。
 * @param signal - 取消。
 * @returns 归一化额度。
 */
export async function fetchQoderCredits(identity, region, signal) {
  const { openApiUrl } = qoderEndpoints(region)
  const headers = {
    accept: 'application/json',
    'accept-encoding': 'identity',
    'user-agent': 'qoder/1.1.47',
    'cosy-version': '1.0.1',
    'cosy-clienttype': '5',
    ...attributionHeaders(),
    authorization: `Bearer ${identity.authToken}`,
  }
  // 外部取消与单请求超时取并集：只写 `signal ?? timeout` 时，runtime 传了
  // signal 就永远不会有超时，一张卡住的额度请求能让卡片永远停在「读取中」。
  const timeout = withTimeout(signal, CREDITS_TIMEOUT_MS)

  const readJson = async (path) => {
    const response = await fetch(`${openApiUrl}${path}`, { headers, signal: timeout })
    if (!response.ok) throw new CreditsError(`Qoder ${path} 返回 HTTP ${String(response.status)}`)
    return await response.json()
  }

  // 三个接口并行；任何一个失败都只影响它自己那一块信息。
  const [usage, plan, status] = await Promise.allSettled([
    readJson('/api/v2/quota/usage'),
    readJson('/api/v2/user/plan'),
    readJson('/api/v3/user/status'),
  ])
  if (usage.status === 'rejected') throw new CreditsError(`Qoder 额度读取失败：${String(usage.reason?.message ?? usage.reason)}`)

  const quota = usage.value?.userQuota ?? {}
  const total = typeof quota.total === 'number' ? quota.total : 0
  const used = typeof quota.used === 'number' ? quota.used : 0
  const remaining = typeof quota.remaining === 'number' ? quota.remaining : Math.max(0, total - used)
  const planName = plan.status === 'fulfilled' && typeof plan.value?.plan_tier_name === 'string' ? plan.value.plan_tier_name : undefined
  const paid = plan.status === 'fulfilled' ? plan.value?.is_paid_plan === true : undefined
  const nextResetAt = status.status === 'fulfilled' && typeof status.value?.nextResetAt === 'number' ? status.value.nextResetAt : undefined
  // Free 套餐的 0 是「付费额度为 0」，不是「额度用尽」。把结论落进快照，
  // 客户端 / CLI / 诊断就不必各自再猜一次（老缓存仍由 quota.js 的兜底识别）。
  const planText = typeof planName === 'string' ? planName.trim().toLowerCase() : ''
  const freePlan = total <= 0 && (paid === false || planText === 'free' || planText.includes('free') || planText.includes('免费'))

  return {
    state: 'ok',
    remain: Math.max(0, remaining),
    total,
    used,
    unit: typeof quota.unit === 'string' ? quota.unit : 'credits',
    ...(planName === undefined ? {} : { planName }),
    ...(paid === undefined ? {} : { paid }),
    ...(freePlan ? { freePlan: true } : {}),
    ...(nextResetAt === undefined ? {} : { resetAtMs: nextResetAt }),
    ...(usage.value?.isQuotaExceeded === true ? { exceeded: true } : {}),
    items: [],
    fetchedAt: Date.now(),
  }
}

/** 额度读取失败（与模型请求失败区分开）。 */
export class CreditsError extends Error {
  /**
   * @param message - 说明。
   * @param cause - 底层错误。
   */
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'CreditsError'
    this.code = REASON.upstreamError
  }
}
