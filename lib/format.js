/**
 * 输出给人看的小格式化工具（CLI、诊断、状态文档共用）。
 *
 * 为什么单独成模块：同一句「预计还能用多久」以前在 `bin.js` 里写成
 * 「预计可用 363476 分钟」、在 `diagnostics.js` 里写成「预计可用: 363476 分钟」，
 * 两处都由 `Math.round(ms / 60000)` 拼出来。252 天的预算被摊成六位数的分钟，
 * 读者得先做一次除法才知道那是「很久」。这里统一成 `45m` / `3h 20m` / `252d`，
 * 与浏览器半边 `formatCompactDuration()` 的规则保持一致。
 *
 * 纯函数、不依赖 Node 内建模块，浏览器 bundle 也可以直接复制同样的规则。
 *
 * @module dsh-reverse-proxy-connect/format
 */

/** 一分钟的毫秒数。 */
const MINUTE_MS = 60_000

/**
 * 毫秒 → 紧凑时长。
 *
 * @param ms - 毫秒；非有限数或 <= 0 返回 `—`。
 * @returns `45m` / `3h 20m` / `252d`。
 */
export function formatCompactDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS))
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return `${String(hours)}h${restMinutes > 0 ? ` ${String(restMinutes)}m` : ''}`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  if (days < 365) return `${String(days)}d${restHours > 0 ? ` ${String(restHours)}h` : ''}`
  // 超过一年只给年，别再拼天数：那种数字本身说明速度样本太小。
  return `${String(Math.round(days / 365))}y`
}

/**
 * 毫秒 → 中文紧凑时长（给中文诊断/CLI 用）。
 *
 * 与 `formatCompactDuration()` 同一套切分，只是单位换成中文。
 *
 * @param ms - 毫秒。
 * @returns `45 分钟` / `3 小时 20 分` / `252 天`。
 */
export function formatDurationZh(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS))
  if (minutes < 60) return `${String(minutes)} 分钟`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return `${String(hours)} 小时${restMinutes > 0 ? ` ${String(restMinutes)} 分` : ''}`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return `${String(days)} 天${restHours > 0 ? ` ${String(restHours)} 小时` : ''}`
}
