/**
 * 额度语义：把上游账目翻译成「这个账号还能不能直接用 / 要不要提醒 / 要不要换号」。
 *
 * 这里集中三件容易各写各的事：
 *
 * 1. **Qoder Free 的 0 不是「额度用尽」**。Free 套餐的 `userQuota.total` 本来就是 0，
 *    上游还会回 `isQuotaExceeded=true`；但 `qfmodel` 这类免费模型仍然可用，只是高峰期
 *    排队。把它当成「已用尽」会让卡片变红、预警横幅误报，甚至自动切换到付费账号。
 * 2. **预警等级**只由额度快照与 `alerts` 设置决定，不在 index.js / runtime / client
 *    各写一份阈值判断。
 * 3. **耗尽判定**与「低于阈值」分开：前者是「已经用不了」，后者是「快用完了」。
 *
 * 纯函数，不依赖任何 Node 内建模块，服务端与测试都可以直接引用。
 *
 * @module dsh-reverse-proxy-connect/quota
 */

import { CREDITS_ABS_LIMIT } from './protocol.js'

/**
 * 这是不是 Qoder 的免费套餐。
 *
 * 判据刻意保守：
 * - 有付费额度（`total > 0`）就绝不是 Free；
 * - 优先认上游的 `freePlan` 标记（`fetchQoderCredits` 写入）；
 * - 其次认 `paid === false`；
 * - 最后才看套餐名（大小写不敏感，兼容 `Free` / `FREE` / `免费`）。
 *
 * 老缓存里没有 `freePlan` 字段，所以后面的兜底不能省。
 *
 * @param provider - provider id。
 * @param credits - `runtime.creditsFor()` 的返回值。
 * @returns 是否按 Free 处理。
 */
export function isQoderFreePlan(provider, credits) {
  if (typeof provider !== 'string' || !provider.startsWith('qoder')) return false
  if (credits === null || typeof credits !== 'object') return false
  if (credits.state !== undefined && credits.state !== 'ok') return false
  const total = typeof credits.total === 'number' && Number.isFinite(credits.total) ? credits.total : 0
  if (total > 0) return false
  if (credits.freePlan === true) return true
  if (credits.paid === false) return true
  // 计划接口失败（`planUnknown`）时三件证据全缺：Free 的 total 本来就是 0，
  // 把它判成「用尽」会让卡片变红并触发自动换号，而账号其实还能用；
  // 判成 Free 最坏只是少一次本该发生的换号，代价小得多。
  if (credits.planUnknown === true && credits.paid !== true) return true
  const plan = typeof credits.planName === 'string' ? credits.planName.trim().toLowerCase() : ''
  return plan === 'free' || plan.includes('free') || plan.includes('免费')
}

/**
 * 这个账号的额度是不是已经用完了。
 *
 * Qoder Free 永远不算用完：它的 0 是「付费额度为 0」，免费模型仍然可用。
 * 「读不到」（`state !== 'ok'`）也不算用完 —— 否则一次网络抖动就会触发自动换号。
 *
 * @param credits - 额度快照。
 * @param provider - provider id（用于识别 Qoder Free；省略时保持旧的纯额度语义）。
 * @returns 是否耗尽。
 */
export function isExhaustedCredits(credits, provider) {
  if (credits === undefined || credits === null) return false
  if (credits.unlimited === true) return false
  if (credits.state !== 'ok') return false
  if (isQoderFreePlan(provider, credits)) return false
  if (credits.exceeded === true) return true
  return typeof credits.remain === 'number' && credits.remain <= 0
}

/**
 * 剩余比例是否低到该亮警示色。
 *
 * 分母必须是**有限正数**：`total = Infinity` 会让 `remain / total` 恒为 0，
 * 于是任何一个「读到了数字」的账号都会永久亮着低额度警示；`1e308` 这类合法
 * 有限大数也一样（它只可能来自被手改 / 被旧版本写坏的 `credits-cache.json`）。
 * 用 `CREDITS_ABS_LIMIT` 把两者一起挡住。
 *
 * @param credits - 额度快照。
 * @param lowRatio - 0–1 的阈值。
 * @returns 是否低于阈值。
 */
function belowRatio(credits, lowRatio) {
  const total = credits.total
  const remain = credits.remain
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0 || total > CREDITS_ABS_LIMIT) return false
  if (typeof remain !== 'number' || !Number.isFinite(remain) || remain > CREDITS_ABS_LIMIT) return false
  return remain / total <= lowRatio
}

/**
 * 额度预警等级。
 *
 * `alerts.enabled === false` 时返回 undefined：这个开关不仅控制顶部横幅，也控制
 * 侧栏与卡片上的琥珀色。1.2.0 只关掉了横幅，颜色仍然在亮，属于同一个开关两套行为。
 *
 * @param credits - `runtime.creditsFor()` 的返回值。
 * @param alerts - 设置里的 `alerts`。
 * @param provider - provider id（Qoder Free 的 0 付费额度不算「用尽」）。
 * @returns `'exhausted' | 'low' | undefined`。
 */
export function creditsAlertOf(credits, alerts, provider) {
  if (alerts?.enabled === false) return undefined
  if (credits === undefined || credits === null || credits.state !== 'ok') return undefined
  if (isQoderFreePlan(provider, credits)) return undefined
  if (isExhaustedCredits(credits, provider)) return 'exhausted'
  if (credits.unlimited === true) return undefined
  const ratio = typeof alerts?.lowRatio === 'number' && Number.isFinite(alerts.lowRatio) ? alerts.lowRatio : 0.15
  return belowRatio(credits, ratio) ? 'low' : undefined
}
