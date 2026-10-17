import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Stats, dayKey, healthOf, statsPathOf } from '../lib/stats.js'

/** 临时目录。 */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-rpc-stats-'))
}

test('统计：成功请求累加 token、次数与延迟', () => {
  const dir = tempDir()
  try {
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 100, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 } })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'tool-calls', durationMs: 300, usage: { inputTokens: 1, outputTokens: 2 } })
    const snapshot = stats.snapshot()
    assert.equal(snapshot.totals.requests, 2)
    assert.equal(snapshot.totals.ok, 2)
    assert.equal(snapshot.totals.inputTokens, 11)
    assert.equal(snapshot.totals.outputTokens, 22)
    assert.equal(snapshot.totals.cacheReadTokens, 5)
    assert.equal(snapshot.totals.totalTokens, 38)
    assert.equal(snapshot.totals.avgDurationMs, 200)
    assert.equal(snapshot.providers.workbuddy.requests, 2)
    assert.equal(snapshot.providerToday.workbuddy.requests, 2)
    assert.equal(snapshot.accounts['workbuddy::a'].requests, 2)
    assert.equal(snapshot.models['workbuddy::m'].requests, 2)
    assert.equal(snapshot.recent.length, 2)
    assert.equal(snapshot.recent[0].kind, 'tool-calls')
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：失败与取消分开计数，健康状态按连续失败升级', () => {
  const dir = tempDir()
  try {
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true })
    stats.record({ provider: 'qoder', accountId: 'a', model: 'm', kind: 'error', code: 'AUTH', durationMs: 50 })
    assert.equal(stats.healthFor('qoder').state, 'degraded')
    stats.record({ provider: 'qoder', accountId: 'a', model: 'm', kind: 'error', code: 'AUTH', durationMs: 50 })
    stats.record({ provider: 'qoder', accountId: 'a', model: 'm', kind: 'error', code: 'AUTH', durationMs: 50 })
    assert.equal(stats.healthFor('qoder').state, 'down')
    const snapshot = stats.snapshot()
    assert.equal(snapshot.providers.qoder.failed, 3)
    assert.equal(snapshot.totals.failed, 3)
    // 一次成功立刻恢复。
    stats.record({ provider: 'qoder', accountId: 'a', model: 'm', kind: 'stop', durationMs: 50 })
    assert.equal(stats.healthFor('qoder').state, 'ok')
    // 取消既不算成功也不算失败。
    stats.record({ provider: 'qoder', accountId: 'a', model: 'm', kind: 'aborted', durationMs: 10 })
    assert.equal(stats.snapshot().providers.qoder.aborted, 1)
    assert.equal(stats.snapshot().providers.qoder.consecutiveFailures, 0)
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：写盘后能恢复，reset 清空', () => {
  const dir = tempDir()
  try {
    const first = new Stats({ filePath: statsPathOf(dir), enabled: () => true })
    first.record({ provider: 'workbuddy-ai', accountId: 'x', model: 'glm', kind: 'stop', durationMs: 80, usage: { inputTokens: 3, outputTokens: 4 } })
    first.flush()
    const second = new Stats({ filePath: statsPathOf(dir), enabled: () => true })
    assert.equal(second.snapshot().totals.requests, 1)
    assert.equal(second.snapshot().providers['workbuddy-ai'].inputTokens, 3)
    second.reset()
    assert.equal(second.snapshot().totals.requests, 0)
    const third = new Stats({ filePath: statsPathOf(dir), enabled: () => true })
    assert.equal(third.snapshot().totals.requests, 0)
    third.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：关闭时不记录，最近请求只保留上限', () => {
  const dir = tempDir()
  try {
    const off = new Stats({ filePath: statsPathOf(dir), enabled: () => false })
    assert.equal(off.record({ provider: 'qoder', accountId: 'a', model: 'm', kind: 'stop' }), false)
    assert.equal(off.snapshot().totals.requests, 0)
    off.stop()

    const on = new Stats({ filePath: statsPathOf(dir), enabled: () => true })
    for (let index = 0; index < 60; index++) {
      on.record({ provider: 'qoder', accountId: 'a', model: 'm', kind: 'stop', durationMs: 1 })
    }
    assert.equal(on.snapshot().recent.length, 40)
    on.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：日切只清 today，累计保留', () => {
  const dir = tempDir()
  try {
    let now = Date.now()
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true, now: () => now })
    stats.record({ provider: 'qoder', accountId: 'a', model: 'm', kind: 'stop', durationMs: 1 })
    assert.equal(stats.snapshot().today.requests, 1)
    // 跳到两天后：today 归零，totals 仍然有 1。
    now += 2 * 24 * 3600_000
    stats.record({ provider: 'qoder', accountId: 'a', model: 'm', kind: 'stop', durationMs: 1 })
    const snapshot = stats.snapshot()
    assert.equal(snapshot.totals.requests, 2)
    assert.equal(snapshot.today.requests, 1)
    assert.equal(snapshot.today.date, dayKey(now))
    assert.equal(snapshot.providerToday.qoder.requests, 1)
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('健康状态：无记录是 unknown，单次失败近期降级，久远失败恢复 ok', () => {
  const now = 1_800_000_000_000
  assert.equal(healthOf(undefined, now).state, 'unknown')
  assert.equal(healthOf({ lastOkAt: now - 1000 }, now).state, 'ok')
  assert.equal(healthOf({ lastOkAt: now - 5000, lastErrorAt: now - 1000, consecutiveFailures: 1 }, now).state, 'degraded')
  assert.equal(healthOf({ lastOkAt: now - 5000, lastErrorAt: now - 10_000_000, consecutiveFailures: 1 }, now).state, 'ok')
  assert.equal(healthOf({ consecutiveFailures: 4 }, now).state, 'down')
})

test('统计：每日历史与当前会话分开累计', () => {
  const dir = tempDir()
  try {
    let now = new Date(2026, 9, 18, 10, 0, 0).getTime()
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true, now: () => now })
    stats.record({ provider: 'workbuddy', accountId: 'a', sessionId: 's1', model: 'auto', kind: 'stop', durationMs: 10, usage: { inputTokens: 10, outputTokens: 20 } })
    stats.record({ provider: 'workbuddy', accountId: 'a', sessionId: 's1', model: 'auto', kind: 'stop', durationMs: 20, usage: { inputTokens: 1, outputTokens: 2 } })
    now += 24 * 3600_000
    stats.record({ provider: 'qoder', accountId: 'b', sessionId: 's2', model: 'qf', kind: 'stop', durationMs: 30, usage: { inputTokens: 3, outputTokens: 4 } })
    const snapshot = stats.snapshot()
    assert.equal(snapshot.daily.length, 2)
    assert.equal(snapshot.daily[0].date, '2026-10-18')
    assert.equal(snapshot.daily[0].requests, 2)
    assert.equal(snapshot.daily[0].totalTokens, 33)
    assert.equal(snapshot.daily[1].requests, 1)
    assert.equal(snapshot.sessions.s1.requests, 2)
    assert.equal(snapshot.sessions.s2.requests, 1)
    assert.equal(snapshot.currentSession.id, 's2')
    assert.equal(snapshot.currentSession.totalTokens, 7)
    assert.equal(snapshot.recent[0].sessionId, 's2')
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：v1 文件升级后保留累计，今日补成第一条每日历史', () => {
  const dir = tempDir()
  try {
    const filePath = statsPathOf(dir)
    const now = new Date(2026, 9, 18, 12, 0, 0).getTime()
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      since: now - 1000,
      totals: { requests: 7, ok: 7, inputTokens: 10, outputTokens: 20, durationMs: 70 },
      today: { requests: 2, ok: 2, date: dayKey(now), inputTokens: 1, outputTokens: 2, durationMs: 20 },
      providers: {},
      providerToday: {},
      accounts: {},
      models: {},
      recent: [],
    }))
    const stats = new Stats({ filePath, enabled: () => true, now: () => now })
    const snapshot = stats.snapshot()
    assert.equal(snapshot.totals.requests, 7)
    assert.equal(snapshot.today.requests, 2)
    assert.equal(snapshot.daily.length, 1)
    assert.equal(snapshot.daily[0].date, dayKey(now))
    assert.equal(snapshot.daily[0].requests, 2)
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：每日历史最多保留 30 天', () => {
  const dir = tempDir()
  try {
    let now = new Date(2026, 8, 1, 12, 0, 0).getTime()
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true, now: () => now })
    for (let day = 0; day < 40; day++) {
      stats.record({ provider: 'qoder', accountId: 'a', model: 'm', kind: 'stop' })
      now += 24 * 3600_000
    }
    assert.equal(stats.snapshot().daily.length, 30)
    assert.equal(stats.snapshot().daily[0].date, dayKey(now - 30 * 24 * 3600_000))
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
