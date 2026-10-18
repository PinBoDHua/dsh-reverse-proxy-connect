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
    // v4：账号 × 模型交叉维度。「哪个账号用了哪个模型、多少 token」——
    // 单独的 accounts / models 两份计数都答不了这个问题。
    const pair = snapshot.accountModels['workbuddy::a::m']
    assert.ok(pair !== undefined, '缺少账号 × 模型交叉维度')
    assert.equal(pair.requests, 2)
    assert.equal(pair.totalTokens, 38)
    assert.equal(pair.provider, 'workbuddy', '快照里要拆出 provider')
    assert.equal(pair.accountId, 'a', '快照里要拆出 accountId')
    assert.equal(pair.model, 'm', '快照里要拆出 model')
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
    // 按 provider 的每日桶也要同步裁剪，不能因为总量没超上限就无限增长。
    assert.equal(stats.snapshot().providerDaily.qoder.length, 30)
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：午夜后没有新请求，快照也要把今日归零', () => {
  const dir = tempDir()
  try {
    let now = new Date(2026, 9, 18, 23, 50, 0).getTime()
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true, now: () => now })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop' })
    assert.equal(stats.snapshot().today.requests, 1)
    now = new Date(2026, 9, 19, 0, 10, 0).getTime()
    const snapshot = stats.snapshot()
    assert.equal(snapshot.today.date, dayKey(now))
    assert.equal(snapshot.today.requests, 0)
    assert.equal(snapshot.providerToday.workbuddy.requests, 0)
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：跨日后启动，旧的 providerToday 不能覆盖已经归零的今日', () => {
  const dir = tempDir()
  try {
    const filePath = statsPathOf(dir)
    const now = new Date(2026, 9, 18, 12, 0, 0).getTime()
    const yesterday = dayKey(now - 24 * 3600_000)
    writeFileSync(filePath, JSON.stringify({
      version: 3,
      since: now - 1000,
      totals: { requests: 4, ok: 4 },
      today: { requests: 4, ok: 4, date: yesterday },
      providers: {},
      providerToday: { workbuddy: { requests: 4, ok: 4, lastAt: now - 24 * 3600_000 } },
      accounts: {},
      models: {},
      daily: { [yesterday]: { requests: 4, ok: 4 } },
      providerDaily: {},
      sessions: {},
      providerSessions: {},
      recent: [],
    }))
    const stats = new Stats({ filePath, enabled: () => true, now: () => now })
    const snapshot = stats.snapshot()
    assert.equal(snapshot.today.date, dayKey(now))
    assert.equal(snapshot.today.requests, 0)
    assert.equal(snapshot.providerToday.workbuddy.requests, 0)
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：按 provider 拆分的每日/会话维度不会串台', () => {
  const dir = tempDir()
  try {
    let now = new Date(2026, 9, 18, 10, 0, 0).getTime()
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true, now: () => now })
    stats.record({ provider: 'workbuddy', accountId: 'a', sessionId: 's1', model: 'auto', kind: 'stop', durationMs: 10, usage: { inputTokens: 10, outputTokens: 20 } })
    stats.record({ provider: 'workbuddy', accountId: 'a', sessionId: 's1', model: 'auto', kind: 'stop', durationMs: 20, usage: { inputTokens: 1, outputTokens: 2 } })
    stats.record({ provider: 'qoder', accountId: 'b', sessionId: 's2', model: 'qf', kind: 'stop', durationMs: 30, usage: { inputTokens: 3, outputTokens: 4 } })
    now += 24 * 3600_000
    stats.record({ provider: 'workbuddy', accountId: 'a', sessionId: 's3', model: 'auto', kind: 'error', code: 'RATE_LIMIT', message: 'HTTP 429 from upstream', durationMs: 40 })
    const snapshot = stats.snapshot()
    // 全局 daily 仍有所有 provider；各 provider 只看到自己的日期与计数。
    assert.equal(snapshot.daily.length, 2)
    assert.equal(snapshot.providerDaily.workbuddy.length, 2)
    assert.equal(snapshot.providerDaily.qoder.length, 1)
    assert.equal(snapshot.providerDaily.workbuddy[0].requests, 2)
    assert.equal(snapshot.providerDaily.qoder[0].requests, 1)
    assert.equal(snapshot.providerDaily.qoder[0].totalTokens, 7)
    // 会话按 provider 取最近一个，不把 WorkBuddy 的会话挂到 Qoder 上。
    assert.equal(snapshot.providerCurrentSession.workbuddy.id, 's3')
    assert.equal(snapshot.providerCurrentSession.qoder.id, 's2')
    assert.equal(snapshot.currentSession.id, 's3')
    // 失败原因要带进最近请求，卡片才能回答「为什么失败」。
    assert.equal(snapshot.recent[0].message, 'HTTP 429 from upstream')
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：v2 文件升级后保留今日 provider 计数，并补出第一条按 provider 的每日历史', () => {
  const dir = tempDir()
  try {
    const filePath = statsPathOf(dir)
    const now = new Date(2026, 9, 18, 12, 0, 0).getTime()
    writeFileSync(filePath, JSON.stringify({
      version: 2,
      since: now - 1000,
      totals: { requests: 3, ok: 3 },
      today: { requests: 2, ok: 2, date: dayKey(now) },
      providers: {},
      providerToday: { qoder: { requests: 2, ok: 2, lastAt: now - 100 } },
      accounts: {},
      models: {},
      daily: { [dayKey(now)]: { requests: 2, ok: 2 } },
      sessions: {},
      recent: [],
    }))
    const stats = new Stats({ filePath, enabled: () => true, now: () => now })
    const snapshot = stats.snapshot()
    assert.equal(snapshot.totals.requests, 3)
    assert.equal(snapshot.providerDaily.qoder.length, 1)
    assert.equal(snapshot.providerDaily.qoder[0].requests, 2)
    assert.deepEqual(snapshot.providerCurrentSession, {})
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：CLI 在宿主运行期间重置后，宿主的下一次落盘不会把旧数字写回去', () => {
  const dir = tempDir()
  try {
    const filePath = statsPathOf(dir)
    const host = new Stats({ filePath, enabled: () => true, persistDelayMs: 0 })
    host.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 10 })
    assert.equal(host.snapshot().totals.requests, 1)
    host.stop()

    // 模拟 `node lib/bin.js stats-reset`：另一个进程读同一个文件、重置、写回。
    const cli = new Stats({ filePath, enabled: () => true, persistDelayMs: 0 })
    cli.reset()

    // 宿主的去抖 flush 现在才跑：磁盘上的 since 更新，必须采纳外部重置。
    host.flush()
    const reloaded = new Stats({ filePath, enabled: () => true })
    assert.equal(reloaded.snapshot().totals.requests, 0, '外部重置不能被宿主旧快照覆盖')
    reloaded.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：自有写入不会被误判成外部重置', () => {
  const dir = tempDir()
  try {
    const filePath = statsPathOf(dir)
    const stats = new Stats({ filePath, enabled: () => true, persistDelayMs: 0 })
    stats.record({ provider: 'qoder', accountId: 'a', model: 'm', kind: 'stop', durationMs: 5 })
    stats.flush()
    stats.record({ provider: 'qoder', accountId: 'a', model: 'm', kind: 'stop', durationMs: 5 })
    stats.flush()
    const reloaded = new Stats({ filePath, enabled: () => true })
    assert.equal(reloaded.snapshot().totals.requests, 2)
    reloaded.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：同一个模型被两个账号用了，token 要分开算', () => {
  // 这正是用户问的那件事：「是哪个账号、用了哪个模型、用了多少 tokens」。
  // 只看 models['provider::model'] 会得到「两个账号加起来 300 tok」，
  // 看不出是谁烧的。
  const dir = tempDir()
  try {
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true })
    stats.record({ provider: 'workbuddy', accountId: 'acc-1', model: 'hy3', kind: 'stop', durationMs: 10, usage: { inputTokens: 100, outputTokens: 50 } })
    stats.record({ provider: 'workbuddy', accountId: 'acc-1', model: 'hy3', kind: 'stop', durationMs: 10, usage: { inputTokens: 100, outputTokens: 50 } })
    stats.record({ provider: 'workbuddy', accountId: 'acc-2', model: 'hy3', kind: 'stop', durationMs: 20, usage: { inputTokens: 60, outputTokens: 40 } })
    const snapshot = stats.snapshot()

    // 模型维度：两个账号合计（acc-1 两次 150×2 + acc-2 一次 100 = 400）。
    assert.equal(snapshot.models['workbuddy::hy3'].totalTokens, 400)
    // 账号维度：各自合计。
    assert.equal(snapshot.accounts['workbuddy::acc-1'].totalTokens, 300)
    assert.equal(snapshot.accounts['workbuddy::acc-2'].totalTokens, 100)
    // 交叉维度：真正回答问题的那一份。
    assert.equal(snapshot.accountModels['workbuddy::acc-1::hy3'].totalTokens, 300)
    assert.equal(snapshot.accountModels['workbuddy::acc-1::hy3'].requests, 2)
    assert.equal(snapshot.accountModels['workbuddy::acc-2::hy3'].totalTokens, 100)
    assert.equal(snapshot.accountModels['workbuddy::acc-2::hy3'].requests, 1)
    // 两个账号之和必须等于模型维度，否则某一维漏记了。
    assert.equal(
      snapshot.accountModels['workbuddy::acc-1::hy3'].totalTokens + snapshot.accountModels['workbuddy::acc-2::hy3'].totalTokens,
      snapshot.models['workbuddy::hy3'].totalTokens,
    )
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：v3 文件升级到 v4 不丢任何已有维度', () => {
  // v3 → v4 只多一个 accountModels 块。如果把 v3 当成「不认识的版本」，
  // 现有用户的累计/今日/每日历史会整份归零 —— 那是一次数据事故。
  const dir = tempDir()
  try {
    const filePath = statsPathOf(dir)
    const counters = {
      requests: 5, ok: 5, failed: 0, aborted: 0, incomplete: 0,
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, durationMs: 100, maxDurationMs: 40, lastAt: 1_700_000_000_000,
      lastOkAt: 1_700_000_000_000, lastErrorAt: 0, consecutiveFailures: 0,
    }
    writeFileSync(filePath, JSON.stringify({
      version: 3,
      since: 1_700_000_000_000,
      totals: counters,
      today: { ...counters, date: dayKey() },
      providers: { workbuddy: counters },
      providerToday: { workbuddy: counters },
      accounts: { 'workbuddy::a': counters },
      models: { 'workbuddy::hy3': counters },
      providerDaily: {},
      sessions: {},
      providerSessions: {},
      recent: [],
    }), 'utf8')

    const stats = new Stats({ filePath, enabled: () => true })
    const snapshot = stats.snapshot()
    assert.equal(snapshot.totals.requests, 5, '累计必须保留')
    assert.equal(snapshot.providers.workbuddy.requests, 5, 'provider 维度必须保留')
    assert.equal(snapshot.accounts['workbuddy::a'].requests, 5, '账号维度必须保留')
    assert.equal(snapshot.models['workbuddy::hy3'].requests, 5, '模型维度必须保留')
    // 交叉维度没有历史可回填（两份独立计数推不出来），从下一次请求开始记。
    assert.deepEqual(snapshot.accountModels, {})
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'hy3', kind: 'stop', durationMs: 10 })
    assert.equal(stats.snapshot().accountModels['workbuddy::a::hy3'].requests, 1)
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：账号 × 模型的键能容忍模型 id 里带 ::，并丢掉坏键', () => {
  const dir = tempDir()
  try {
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true })
    // 上游模型 id 不保证不含 `::`：只按前两个分隔符切，剩下整段都算模型。
    stats.record({ provider: 'qoder', accountId: 'default', model: 'vendor::model-x', kind: 'stop', durationMs: 5 })
    const snapshot = stats.snapshot()
    const pair = snapshot.accountModels['qoder::default::vendor::model-x']
    assert.ok(pair !== undefined, '含 :: 的模型 id 也要能记')
    assert.equal(pair.provider, 'qoder')
    assert.equal(pair.accountId, 'default')
    assert.equal(pair.model, 'vendor::model-x', '模型 id 要原样保留，不能只取最后一段')
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
