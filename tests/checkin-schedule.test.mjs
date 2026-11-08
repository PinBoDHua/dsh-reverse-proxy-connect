import assert from 'node:assert/strict'
import test from 'node:test'

import { CHECKIN_RETRY_MS, checkinCompleted, checkinDue, checkinReopenPatch, checkinTerminal, qoderCampaignRefreshAt, qoderCampaignsReady } from '../lib/checkin-schedule.js'

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

test('签到按 provider + 账号集合判断：当天新增账号仍会补签', () => {
  const now = at(2026, 10, 18, 12)
  const checkin = {
    enabled: true,
    completedOn: { workbuddy: '2026-10-18' },
    accountIds: { workbuddy: ['a'] },
  }
  assert.equal(checkinCompleted(checkin, 'workbuddy', now, ['a']), true)
  assert.equal(checkinDue(checkin, 'workbuddy', now, ['a']), false)
  assert.equal(checkinDue(checkin, 'workbuddy', now, ['a', 'b']), true, '新增账号 B 后不能整天漏签')
  // 老设置没有 accountIds：有账号集合时先跑一次（已签账号会返回 already）。
  assert.equal(checkinDue({ enabled: true, completedOn: { workbuddy: '2026-10-18' } }, 'workbuddy', now, ['a']), true)
})

test('凭证补上后：只重开当天被「未配置」跳过的 provider', () => {
  const now = at(2026, 10, 18, 12)
  const checkin = {
    completedOn: { qoder: '2026-10-18', workbuddy: '2026-10-18', trae: '2026-10-17' },
    accountIds: { qoder: ['default'], workbuddy: ['a'], trae: ['default'] },
    results: {
      qoder: { outcomes: [{ accountId: 'default', kind: 'unconfigured' }] },
      workbuddy: { outcomes: [{ accountId: 'a', kind: 'claimed' }] },
      trae: { outcomes: [{ accountId: 'default', kind: 'unconfigured' }] },
    },
  }
  const patch = checkinReopenPatch(checkin, ['qoder', 'workbuddy', 'trae'], now)
  assert.deepEqual(Object.keys(patch.completedOn), ['qoder'], '只有今天且确实有未配置账号的才重开')
  assert.equal(patch.completedOn.qoder, '')
  assert.deepEqual(patch.accountIds.qoder, [])
  // 全成功 / 未完成 / 没有结果都不要动。
  assert.deepEqual(checkinReopenPatch(checkin, ['workbuddy'], now).completedOn, {})
  assert.deepEqual(checkinReopenPatch({ completedOn: {}, results: checkin.results }, ['qoder'], now).completedOn, {})
  assert.deepEqual(checkinReopenPatch({ completedOn: { qoder: '2026-10-18' } }, ['qoder'], now).completedOn, {})
})

test('签到终态：所有账号都到终态才算今天结束', () => {
  assert.equal(checkinTerminal({ outcomes: [] }), true)
  assert.equal(checkinTerminal({ outcomes: [{ kind: 'claimed' }, { kind: 'already' }] }), true)
  assert.equal(checkinTerminal({ outcomes: [{ kind: 'inactive' }] }), true)
  assert.equal(checkinTerminal({ outcomes: [{ kind: 'failed' }] }), false)
  assert.equal(checkinTerminal({ outcomes: [{ kind: 'claimed' }, { kind: 'failed' }] }), false, '一个失败仍要重试')
  assert.equal(checkinTerminal(undefined), false)
  assert.equal(checkinTerminal({ outcomes: [{ kind: 'pending' }] }), false, '活动未刷新不是终态')
  assert.equal(
    checkinTerminal({ outcomes: [{ kind: 'claimed', coversToday: false }] }),
    false,
    '10:00 前领到的是上一轮，今天这一轮还没结束',
  )
})

test('Qoder：每日活动按 UTC+8 的 10:00 判定是否已刷新', () => {
  // 2026-11-08 09:59 / 10:00（UTC+8）= 01:59 / 02:00 UTC。
  const before = Date.UTC(2026, 10, 8, 1, 59)
  const ready = Date.UTC(2026, 10, 8, 2, 0)
  assert.equal(qoderCampaignRefreshAt(before), ready)
  assert.equal(qoderCampaignRefreshAt(ready), ready)
  assert.equal(qoderCampaignsReady(before), false)
  assert.equal(qoderCampaignsReady(ready), true)
  // 本机时区不参与：UTC 00:30 是北京 08:30，仍然没刷新。
  assert.equal(qoderCampaignsReady(Date.UTC(2026, 10, 8, 0, 30)), false)
})

test('Qoder：刷新前写下的「今天已完成」作废，10:00 后必须重新跑', () => {
  const now = at(2026, 11, 8, 9, 0)
  const preRefreshAt = at(2026, 11, 8, 8, 14)
  const checkin = {
    completedOn: { qoder: '2026-11-08' },
    accountIds: { qoder: ['a'] },
    results: { qoder: { at: preRefreshAt, outcomes: [{ kind: 'pending' }] } },
    lastAttemptAt: { qoder: preRefreshAt },
  }
  assert.equal(checkinCompleted(checkin, 'qoder', now, ['a']), false, '08:14 的结果不能算今天已完成')
  assert.equal(checkinDue(checkin, 'qoder', now, ['a']), true, '升级后第一次检查应重开当天签到')
  // 10:05 真正签完的新结果才是完成。
  const doneAt = at(2026, 11, 8, 10, 5)
  const done = {
    ...checkin,
    results: { qoder: { at: doneAt, outcomes: [{ kind: 'claimed', coversToday: true }] } },
    lastAttemptAt: { qoder: doneAt },
  }
  assert.equal(checkinCompleted(done, 'qoder', at(2026, 11, 8, 11, 0), ['a']), true)
  // 其它 provider 不受这条规则影响。
  assert.equal(
    checkinCompleted(
      { ...checkin, completedOn: { workbuddy: '2026-11-08' }, accountIds: { workbuddy: ['a'] } },
      'workbuddy',
      now,
      ['a'],
    ),
    true,
  )
})
