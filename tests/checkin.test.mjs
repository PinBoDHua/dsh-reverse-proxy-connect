import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { interpretCheckinStatus, interpretClaim } from '../lib/checkin.js'
import { checkinDue, checkinTerminal } from '../lib/checkin-schedule.js'
import { EventLog } from '../lib/events.js'
import { Runtime } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'

test('签到状态：活动进行中且今天已签', () => {
  const value = interpretCheckinStatus({
    code: 0,
    data: {
      active: true,
      today_checked_in: true,
      streak_days: 8,
      daily_credit: 100,
      total_credits: 800,
      activity_name: 'Buddy应用',
      end_time: '2026-10-31 23:59:59',
      checkin_dates: ['2026-10-17', '2026-10-16'],
    },
  })
  assert.equal(value.kind, 'already')
  assert.equal(value.streakDays, 8)
  assert.equal(value.dailyCredit, 100)
  assert.equal(value.activityName, 'Buddy应用')
  assert.deepEqual(value.checkinDates, ['2026-10-17', '2026-10-16'])
})

test('签到状态：活动进行中但今天未签 → active（可领）', () => {
  const value = interpretCheckinStatus({ code: 0, data: { active: true, today_checked_in: false, streak_days: 3 } })
  assert.equal(value.kind, 'active')
  assert.equal(value.streakDays, 3)
})

test('签到状态：没有活动（国际版实测返回 active:false）', () => {
  const value = interpretCheckinStatus({ code: 0, data: { active: false, today_checked_in: false } })
  assert.equal(value.kind, 'inactive')
  assert.equal(value.dailyCredit, 0)
})

test('签到状态：上游报错与非 JSON 都要退化成 failed', () => {
  assert.equal(interpretCheckinStatus({ code: 500, msg: 'boom' }).kind, 'failed')
  assert.equal(interpretCheckinStatus(null).kind, 'failed')
  assert.equal(interpretCheckinStatus({ code: 0, data: null }).kind, 'inactive')
})

test('签到状态：data 有字段但缺 active 视为失败（schema 改名不能吞掉整天）', () => {
  assert.equal(interpretCheckinStatus({ code: 0, data: { today_checked_in: false } }).kind, 'failed')
  assert.equal(interpretCheckinStatus({ code: 0, data: {} }).kind, 'inactive')
})

test('领取：成功时带出积分与连续天数', () => {
  const value = interpretClaim({ code: 0, data: { credit: 100, streak_days: 9 } })
  assert.equal(value.kind, 'claimed')
  assert.equal(value.credit, 100)
  assert.equal(value.streakDays, 9)
})

test('领取：已领取的两种码都算 already，不是失败', () => {
  assert.equal(interpretClaim({ code: 10001 }).kind, 'already')
  assert.equal(interpretClaim({ code: 1001 }).kind, 'already')
})

test('领取：无资格 / 活动结束算 inactive', () => {
  assert.equal(interpretClaim({ code: 1002 }).kind, 'inactive')
  assert.equal(interpretClaim({ code: 1003 }).kind, 'inactive')
})

test('领取：未知码算 failed，并带上原文', () => {
  const value = interpretClaim({ code: 4242, msg: '限流' })
  assert.equal(value.kind, 'failed')
  assert.equal(value.message, '限流')
})

test('领取：响应里没给积分数时不编造', () => {
  const value = interpretClaim({ code: 0, data: {} })
  assert.equal(value.kind, 'claimed')
  assert.equal(value.credit, 0)
})

test('签到降噪：未配置登录的账号记 unconfigured（info、不算失败、不请求上游、不触发重试）', async () => {
  // 用户可见行为：没登录/没配 PAT 的账号不再每天在事件账本里报「签到失败」，
  // 也不会每 10 分钟重试一次；卡片上显示的是「未登录，已跳过」这种已知状态。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-checkin-unconfigured-'))
  const originalFetch = globalThis.fetch
  const savedCnToken = process.env.QODER_CN_PERSONAL_ACCESS_TOKEN
  const savedGlobalToken = process.env.QODER_PERSONAL_ACCESS_TOKEN
  delete process.env.QODER_CN_PERSONAL_ACCESS_TOKEN
  delete process.env.QODER_PERSONAL_ACCESS_TOKEN

  const events = new EventLog({})
  const settings = defaults()
  const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {}, events })
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('未配置账号不应该请求上游')
  }
  try {
    const outcome = await runtime.runCheckin('qoder')
    assert.equal(outcome.outcomes.length, 1)
    assert.equal(outcome.outcomes[0].kind, 'unconfigured', '未配置账号应记 unconfigured，而不是 failed')
    assert.match(outcome.outcomes[0].message, /令牌|登录/, '原因要能读懂（未配置登录）')
    assert.equal(outcome.claimed, 0)
    assert.equal(fetchCalls, 0, '未配置账号不应该打上游签到接口')

    const checkinEvents = events.list({ type: 'checkin' })
    assert.equal(checkinEvents.length, 1)
    assert.equal(checkinEvents[0].level, 'info', '未登录是已知状态，事件级别必须是 info 而不是 warn')
    assert.match(checkinEvents[0].message, /未登录，已跳过/)

    // index.js 的终态判定：排除 unconfigured 之后才算「今天结束」，
    // 否则调度器看到非终态会每 10 分钟重试一次。
    assert.equal(checkinTerminal(outcome), false, '原始结果不算终态（需要 index 过滤）')
    const settled = { ...outcome, outcomes: outcome.outcomes.filter((item) => item.kind !== 'unconfigured') }
    assert.equal(checkinTerminal(settled), true, '排除未配置账号后必须是终态，不能触发 10 分钟重试')
  } finally {
    runtime.flushCaches()
    globalThis.fetch = originalFetch
    if (savedCnToken !== undefined) process.env.QODER_CN_PERSONAL_ACCESS_TOKEN = savedCnToken
    if (savedGlobalToken !== undefined) process.env.QODER_PERSONAL_ACCESS_TOKEN = savedGlobalToken
    rmSync(dir, { recursive: true, force: true })
  }
})

test('签到回归：瞬时凭证读取失败记为 failed（保留 10 分钟重试），不能变成 unconfigured', async () => {
  // 用户可见行为：网络抖动/登录文件被占用时，当天签到不能被标成「已完成」而
  // 直接跳过 —— 必须记 failed，10 分钟后自动重试，不能漏掉当天奖励。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-checkin-transient-'))
  const originalFetch = globalThis.fetch
  const events = new EventLog({})
  const settings = defaults()
  settings.accounts.qoder = [{ id: 'a', label: 'PAT 账号', enabled: true, pat: 'pt-real' }]
  settings.activeAccount.qoder = 'a'
  const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {}, events })
  globalThis.fetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
  }
  try {
    const outcome = await runtime.runCheckin('qoder')
    const accountOutcome = outcome.outcomes[0]
    assert.equal(accountOutcome.kind, 'failed', '瞬时读取失败必须是 failed，不能是 unconfigured')
    assert.match(accountOutcome.message, /fetch failed/)

    const checkinEvent = events.list({ type: 'checkin' })[0]
    assert.equal(checkinEvent.level, 'warn', '真失败仍要 warn，不能被降噪吞掉')

    // 复刻 lib/index.js 的终态判定：failed 不是终态 → 不写 completedOn。
    const settled = outcome.outcomes.filter((item) => item.kind !== 'unconfigured')
    assert.equal(checkinTerminal({ ...outcome, outcomes: settled }), false, 'failed 不能算今天已结束')

    // 按 failed 写入（completedOn 为空）后，11 分钟时应允许重试。
    const now = Date.now()
    assert.equal(
      checkinDue({ enabled: true, completedOn: {}, lastAttemptAt: { qoder: now } }, 'qoder', now + 11 * 60_000, ['a']),
      true,
      '瞬时失败后 11 分钟必须重试，不能整天跳过',
    )
  } finally {
    runtime.flushCaches()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})
