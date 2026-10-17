import assert from 'node:assert/strict'
import test from 'node:test'

import { interpretCheckinStatus, interpretClaim } from '../lib/checkin.js'

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
