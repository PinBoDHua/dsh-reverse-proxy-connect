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

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 缓存文件名。 */
const FILE = 'credits-cache.json'

/**
 * 超过这个年龄的缓存不再展示：一周前的余额看着像真的，其实早就不作数了。
 */
const MAX_AGE_MS = 7 * 24 * 3600_000

/**
 * 读缓存。
 * @param dataDir - 插件数据目录。
 * @returns provider → `{data, fetchedAt}`，读不到就是空 Map。
 */
export function loadCreditsCache(dataDir) {
  const out = new Map()
  if (typeof dataDir !== 'string' || dataDir === '') return out
  let raw
  try {
    raw = JSON.parse(readFileSync(join(dataDir, FILE), 'utf8'))
  } catch {
    return out
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const now = Date.now()
  for (const [rawKey, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.data === null || typeof entry.data !== 'object') continue
    if (entry.data.state !== 'ok') continue
    const fetchedAt = typeof entry.fetchedAt === 'number' ? entry.fetchedAt : 0
    if (fetchedAt <= 0 || now - fetchedAt > MAX_AGE_MS) continue
    // 老格式的键是纯 provider（`workbuddy`），新版是 `provider::账号`。
    // 老格式一律视为默认账号，升级后第一帧仍然有数字可显示。
    const key = rawKey.includes('::') ? rawKey : `${rawKey}::default`
    out.set(key, { data: entry.data, fetchedAt, stale: true })
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
  try {
    mkdirSync(dirname(join(dataDir, FILE)), { recursive: true })
    writeFileSync(join(dataDir, FILE), JSON.stringify(payload), 'utf8')
    return true
  } catch {
    return false
  }
}
