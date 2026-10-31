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
 * 与浏览器半边的 `formatCompactDuration()` 逐字同一套规则（那里是浏览器 bundle，
 * 不能 import 本模块，只能手动保持一致）。`credit-history.js` 已经把超过一年的
 * 估算直接丢弃，所以这里不需要「年」这一档。
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
  return `${String(days)}d${restHours > 0 ? ` ${String(restHours)}h` : ''}`
}

/**
 * 额度数字按单位收敛精度。
 *
 * 金额（`usd` / `cny`）必须保留两位小数：Trae 的按美元计费账号一次对话可能只花
 * `$0.04`，按积分的一位小数会被四舍五入成 `0`，看起来像额度没变。积分仍保留
 * 一位小数，与浏览器半边的 `formatCreditsNumber()` 同一套规则。
 *
 * @param value - 额度数字。
 * @param unit - 快照的单位（`credits` / `usd` / `cny` …）。
 * @returns 显示用字符串；非有限数返回 `—`。
 */
export function formatCreditsAmount(value, unit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const normalized = typeof unit === 'string' ? unit.trim().toLowerCase() : ''
  const money = normalized === 'usd' || normalized === 'dollar' || normalized === 'dollars'
    || normalized === 'cny' || normalized === 'rmb'
  const factor = money ? 100 : 10
  return String(Math.round(value * factor) / factor)
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

/**
 * 日期时间格式化：与 `formatCompactDuration` 一样追求「非法输入不产出乱码」。
 *
 * 为什么单独成模块：`bin.js` 与 `diagnostics.js` 以前各处直接
 * `new Date(x).toLocaleString()`，浏览器半边 `client.js` 又用
 * `toLocaleString()`。两个问题：
 * - **无效/超范围时间戳会渲染出字面 "Invalid Date"**（`toLocaleString` 不抛异常，
 *   `try/catch` 形同虚设）——中文卡面或贴进 issue 的诊断里冒出一串英文；
 * - 输出随机器 locale 变（美式 12 小时制 / 分隔符），与插件自己的中文文案割裂，
 *   跨机器粘贴的时间戳也对不齐。
 *
 * 这里统一成**本机时区、零填充、定宽**的 `YYYY-MM-DD HH:MM:SS` / `HH:MM:SS` /
 * `YYYY-MM-DD`，任何无效值（非数字 / NaN / Infinity / 超出 Date 范围）一律回
 * `—`。浏览器半边 `client.js` 的 `formatTime` 手抄同一套规则，由
 * `tests/credits-state.test.mjs` 逐字校验两边一致。
 *
 * 纯函数、不依赖 Node 内建模块。
 */

/** 时间戳是否足够安全地构造一个有效 Date（有限数字且落在 Date 可表示范围内）。 */
function dateOf(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date : undefined
}

/** 两位补零。 */
function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * 毫秒 → `YYYY-MM-DD HH:MM:SS`（本机时区）。无效输入返回 `—`。
 * @param ms - 时间戳。
 * @returns 定宽日期时间或 `—`。
 */
export function formatDateTime(ms) {
  const date = dateOf(ms)
  if (date === undefined) return '—'
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 毫秒 → `HH:MM:SS`（本机时区）。无效输入返回 `—`。
 * @param ms - 时间戳。
 * @returns 定宽时分秒或 `—`。
 */
export function formatClock(ms) {
  const date = dateOf(ms)
  if (date === undefined) return '—'
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 毫秒 → `YYYY-MM-DD`（本机时区）。无效输入返回 `—`。
 * @param ms - 时间戳。
 * @returns 定宽日期或 `—`。
 */
export function formatDateOnly(ms) {
  const date = dateOf(ms)
  if (date === undefined) return '—'
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
