/**
 * 额度快照的磁盘缓存。
 *
 * 为什么需要：额度是网络请求，冷启动时至少几百毫秒、慢的时候几秒。而侧栏小卡
 * 一挂载就会读 `/status` —— 那会儿内存里什么都没有，于是「DSH 都开了 10 秒，
 * 积分才出现」。把上一次成功的快照落到磁盘，启动瞬间就能显示上次的数字，
 * 后台再刷新，观感上就没有空窗期。
 *
 * 缓存只读不改语义：写盘失败、文件损坏、字段过期，全部安静退化成「没有缓存」，
 * 绝不能让额度这种东西把插件搞挂。
 *
 * @module dsh-reverse-proxy-connect/credits-cache
 */

import { join } from 'node:path'

import { readJsonFile, writeJsonAtomic } from './atomic.js'

/** 缓存文件名。 */
const FILE = 'credits-cache.json'

/** 缓存文件格式版本。旧版本是无 version 的裸 provider map，仍然兼容读取。 */
const VERSION = 1

/**
 * 超过这个年龄的缓存不再展示：一周前的余额看着像真的，其实早就不作数了。
 */
const MAX_AGE_MS = 7 * 24 * 3600_000

/**
 * 归一化磁盘里的额度快照：只保留卡片认识的字段与数组元素。
 *
 * credits-cache 是「外部数据」：可能被手改、被旧版本写过。1.2.0 只检查
 * `state === 'ok'`，于是 `items:[null]` 这类坏行会原样进 /status，客户端
 * 渲染明细时直接抛 TypeError，整张设置卡片被宿主的 SlotErrorBoundary 替换。
 *
 * @param data - 缓存里的 data。
 * @returns 可安全展示的额度快照。
 */
function normalizeCachedCredits(data) {
  const out = { ...data }
  out.items = Array.isArray(data.items)
    ? data.items
        .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
        .filter((item) => typeof item.name === 'string' || (typeof item.remain === 'number' && Number.isFinite(item.remain)))
        .slice(0, 50)
        .map((item) => ({
          name: typeof item.name === 'string' && item.name !== '' ? item.name.slice(0, 120) : '额度包',
          remain: typeof item.remain === 'number' && Number.isFinite(item.remain) ? item.remain : 0,
          total: typeof item.total === 'number' && Number.isFinite(item.total) ? item.total : 0,
          ...(typeof item.endAtMs === 'number' && Number.isFinite(item.endAtMs) ? { endAtMs: item.endAtMs } : {}),
          ...(item.expired === true ? { expired: true } : {}),
        }))
    : []
  // 数字字段一律收敛成有限数：坏缓存里的 "x" / null 会让卡片算出 NaN，
  // 渲染出来是「NaN / NaN」且进度条宽度变成非法 CSS。
  for (const key of ['remain', 'total', 'used', 'resetAtMs', 'fetchedAt']) {
    if (out[key] !== undefined && (typeof out[key] !== 'number' || !Number.isFinite(out[key]))) delete out[key]
  }
  // 布尔与字符串同样只保留认识的形态，避免 `credits.paid === false` 之类的判定被 "false" 骗过。
  for (const key of ['exceeded', 'stale', 'unlimited', 'freePlan']) {
    if (out[key] !== undefined && typeof out[key] !== 'boolean') delete out[key]
  }
  if (out.paid !== undefined && typeof out.paid !== 'boolean') delete out.paid
  for (const key of ['unit', 'planName', 'error', 'message']) {
    if (out[key] !== undefined && typeof out[key] !== 'string') delete out[key]
  }
  return out
}

/**
 * 读缓存。
 * @param dataDir - 插件数据目录。
 * @returns provider → `{data, fetchedAt}`，读不到就是空 Map。
 */
export function loadCreditsCache(dataDir) {
  const out = new Map()
  if (typeof dataDir !== 'string' || dataDir === '') return out
  const raw = readJsonFile(join(dataDir, FILE))
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  // 新格式是 `{version:1, entries}`；旧格式是裸 provider map。遇到未来版本
  // 不要按当前字段硬读（可能把不同语义的值当成余额）。
  if (raw.version !== undefined && raw.version !== VERSION) return out
  const entries = raw.version === VERSION && raw.entries !== null && typeof raw.entries === 'object' && !Array.isArray(raw.entries)
    ? raw.entries
    : raw.version === undefined ? raw : {}
  const now = Date.now()
  for (const [rawKey, entry] of Object.entries(entries)) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.data === null || typeof entry.data !== 'object') continue
    if (entry.data.state !== 'ok') continue
    const fetchedAt = typeof entry.fetchedAt === 'number' ? entry.fetchedAt : 0
    if (fetchedAt <= 0 || now - fetchedAt > MAX_AGE_MS) continue
    // 老格式的键是纯 provider（`workbuddy`），新版是 `provider::账号`。
    // 老格式一律视为默认账号，升级后第一帧仍然有数字可显示。
    const key = rawKey.includes('::') ? rawKey : `${rawKey}::default`
    out.set(key, { data: normalizeCachedCredits(entry.data), fetchedAt, stale: true })
  }
  return out
}

/**
 * 写缓存。只存成功快照 —— 错误态存下来毫无意义。
 * @param dataDir - 插件数据目录。
 * @param entries - provider → `{data, fetchedAt}`。
 * @returns 是否写成功（失败不抛）。
 */
export function saveCreditsCache(dataDir, entries) {
  if (typeof dataDir !== 'string' || dataDir === '') return false
  const payload = {}
  for (const [provider, entry] of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.data === null || typeof entry.data !== 'object') continue
    if (entry.data.state !== 'ok') continue
    payload[provider] = { data: entry.data, fetchedAt: entry.fetchedAt }
  }
  return writeJsonAtomic(join(dataDir, FILE), { version: VERSION, entries: payload })
}
