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
 * 今天这个 provider 是否已经完成签到。
 *
 * 1.3.0 起按「provider + 账号集合」判断，而不是只看 provider：
 * 上午账号 A 签完、中午新增账号 B 时，B 的奖励不能整天漏领。
 * `accountIds` 省略时保留旧的「只看 provider 日期」语义（兼容老调用方/测试）。
 *
 * @param checkin - `settings.checkin`。
 * @param provider - provider id。
 * @param now - 当前时间。
 * @param accountIds - 当前启用的账号 id 数组（可选）。
 * @returns 是否完成。
 */
export function checkinCompleted(checkin, provider, now = Date.now(), accountIds) {
  if (checkin === null || typeof checkin !== 'object') return false
  if (checkin.completedOn?.[provider] !== dayKey(now)) return false
  if (accountIds === undefined) return true
  const recorded = checkin.accountIds?.[provider]
  // 老设置没有账号集合：先当未完成跑一次，已签的账号会返回 already，
  // 新账号则会真正领取；跑完写入 accountIds 后恢复正常。
  if (!Array.isArray(recorded)) return false
  const current = new Set(accountIds)
  if (recorded.length !== current.size) return false
  for (const id of recorded) if (!current.has(id)) return false
  return true
}

/**
 * 这个 provider 现在该不该自动签到。
 *
 * @param checkin - `settings.checkin`。
 * @param provider - provider id。
 * @param now - 当前时间（测试可注入）。
 * @param accountIds - 当前启用的账号 id 数组（可选）。
 * @returns 是否该跑。
 */
export function checkinDue(checkin, provider, now = Date.now(), accountIds) {
  if (checkin === null || typeof checkin !== 'object') return true
  if (checkin.enabled === false) return false
  const today = dayKey(now)
  if (checkinCompleted(checkin, provider, now, accountIds)) return false
  const lastAttempt = checkin.lastAttemptAt?.[provider]
  if (typeof lastAttempt === 'number' && lastAttempt > 0 && dayKey(lastAttempt) === today && now - lastAttempt < CHECKIN_RETRY_MS) {
    return false
  }
  return true
}

/**
 * 凭证补上后，要不要重开当天的签到。
 *
 * 启动时没登录 / 没配 PAT 的账号会记 `unconfigured`，并把 provider 标成当天
 * 已完成；用户随后补上 PAT，如果不动完成标记，调度器会一直跳过，当天的奖励
 * 就丢了。这里只处理**确实因为未配置而被跳过**的 provider：
 * - 已完成 + 结果里有 `unconfigured` → 清完成标记，让下一轮重新检查；
 * - 已完成 + 全部 claimed/already/inactive → 不动（避免多打一次签到接口）；
 * - 今天还没完成 → 不用动。
 *
 * @param checkin - `settings.checkin`。
 * @param providers - 这次改了凭证的 provider 集合。
 * @param now - 当前时间（测试可注入）。
 * @returns 可直接交给 `store.patch({checkin})` 的补丁。
 */
export function checkinReopenPatch(checkin, providers, now = Date.now()) {
  const today = dayKey(now)
  const completedOn = {}
  const accountIds = {}
  for (const provider of providers) {
    const outcomes = checkin?.results?.[provider]?.outcomes
    const hasUnconfigured = Array.isArray(outcomes)
      && outcomes.some((item) => item !== null && typeof item === 'object' && item.kind === 'unconfigured')
    if (checkin?.completedOn?.[provider] !== today || !hasUnconfigured) continue
    // 空字符串 / 空数组会被 normalize 丢弃，效果就是「今天还没签」。
    completedOn[provider] = ''
    accountIds[provider] = []
  }
  return { completedOn, accountIds }
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
