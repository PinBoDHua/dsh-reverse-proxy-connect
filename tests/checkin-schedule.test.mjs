import assert from 'node:assert/strict'
import test from 'node:test'

import { CHECKIN_RETRY_MS, checkinDue, checkinTerminal } from '../lib/checkin-schedule.js'

/** 某个本地日期的中午。 */
function at(year, month, day, hour = 12, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0).getTime()
}

test('自动签到：关闭时永不自动跑', () => {
  assert.equal(checkinDue({ enabled: false }, 'workbuddy', at(2026, 10, 18)), false)
  assert.equal(checkinDue({ enabled: true }, 'workbuddy', at(2026, 10, 18)), true)
  assert.equal(checkinDue(undefined, 'workbuddy', at(2026, 10, 18)), true)
})

test('自动签到：今天已完成就跳过，跨过午夜重新跑', () => {
  const checkin = { enabled: true, completedOn: { workbuddy: '2026-10-18' } }
  assert.equal(checkinDue(checkin, 'workbuddy', at(2026, 10, 18, 23, 59)), false)
  assert.equal(checkinDue(checkin, 'workbuddy', at(2026, 10, 19, 0, 1)), true)
  assert.equal(checkinDue(checkin, 'workbuddy-ai', at(2026, 10, 18)), true, '按 provider 独立判断')
})

test('自动签到：当天失败后 10 分钟内不重试，之后重试', () => {
  const started = at(2026, 10, 18, 9, 0)
  const checkin = { enabled: true, completedOn: {}, lastAttemptAt: { workbuddy: started } }
  assert.equal(checkinDue(checkin, 'workbuddy', started + 5 * 60_000), false)
  assert.equal(checkinDue(checkin, 'workbuddy', started + CHECKIN_RETRY_MS - 1), false)
  assert.equal(checkinDue(checkin, 'workbuddy', started + CHECKIN_RETRY_MS), true)
})

test('自动签到：昨天失败过，今天立即重试', () => {
  const checkin = { enabled: true, completedOn: {}, lastAttemptAt: { workbuddy: at(2026, 10, 17, 23, 50) } }
  assert.equal(checkinDue(checkin, 'workbuddy', at(2026, 10, 18, 0, 5)), true)
})

test('签到终态：所有账号都到终态才算今天结束', () => {
  assert.equal(checkinTerminal({ outcomes: [] }), true)
  assert.equal(checkinTerminal({ outcomes: [{ kind: 'claimed' }, { kind: 'already' }] }), true)
  assert.equal(checkinTerminal({ outcomes: [{ kind: 'inactive' }] }), true)
  assert.equal(checkinTerminal({ outcomes: [{ kind: 'failed' }] }), false)
  assert.equal(checkinTerminal({ outcomes: [{ kind: 'claimed' }, { kind: 'failed' }] }), false, '一个失败仍要重试')
  assert.equal(checkinTerminal(undefined), false)
})
