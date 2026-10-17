/**
 * 自动签到的调度判断。
 *
 * 这里刻意不写「距上次 N 小时」：签到是按**本地自然日**重置的，20 小时节流会在
 * 「昨天 23:00 签过」时把今天一整天都错过。所以判据是：
 *
 * 1. 今天该 provider 已经完成（claimed / already / inactive）→ 不再跑；
 * 2. 今天失败过 → 10 分钟后重试，而不是放弃当天；
 * 3. 其余情况 → 跑。
 *
 * 抽成纯函数是为了能在跨午夜、失败退避这类边界上做单测。
 *
 * @module dsh-reverse-proxy-connect/checkin-schedule
 */

import { dayKey } from './stats.js'

/** 失败后的重试间隔。 */
export const CHECKIN_RETRY_MS = 10 * 60_000

/**
 * 这个 provider 现在该不该自动签到。
 *
 * @param checkin - `settings.checkin`。
 * @param provider - provider id。
 * @param now - 当前时间（测试可注入）。
 * @returns 是否该跑。
 */
export function checkinDue(checkin, provider, now = Date.now()) {
  if (checkin === null || typeof checkin !== 'object') return true
  if (checkin.enabled === false) return false
  const today = dayKey(now)
  if (checkin.completedOn?.[provider] === today) return false
  const lastAttempt = checkin.lastAttemptAt?.[provider]
  if (typeof lastAttempt === 'number' && lastAttempt > 0 && dayKey(lastAttempt) === today && now - lastAttempt < CHECKIN_RETRY_MS) {
    return false
  }
  return true
}

/**
 * 这次签到结果是否已经「今天结束」（无论有没有领到）。
 *
 * - `claimed`：领到了；
 * - `already`：今天已经签过；
 * - `inactive`：这个账号没有活动 / 活动结束 / 无资格；
 * - 没有任何账号可签：也算结束。
 *
 * 必须**所有账号**都到终态才算结束 —— 多账号里一个失败、一个已签时，10 分钟后
 * 再试一次（已签的会返回 already，不会重复领），不能因为另一个成功就把失败账号
 * 丢到明天。
 *
 * @param outcome - `Runtime.runCheckin()` 的返回值。
 * @returns 是否终态。
 */
export function checkinTerminal(outcome) {
  if (outcome === null || typeof outcome !== 'object') return false
  const outcomes = Array.isArray(outcome.outcomes) ? outcome.outcomes : []
  if (outcomes.length === 0) return true
  return outcomes.every((item) => item?.kind === 'claimed' || item?.kind === 'already' || item?.kind === 'inactive')
}
