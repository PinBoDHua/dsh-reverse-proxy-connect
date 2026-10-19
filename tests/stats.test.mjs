import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Stats, dayKey, emptyCounters, healthOf, mergeCountersMax, mergeStatsData, statsPathOf } from '../lib/stats.js'

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

test('统计：另一个窗口刚写过计数时，本机点「重置统计」不会被旧文档合并回来', () => {
  // 用户可见行为：重置后仪表盘仍显示旧数字，而且文件里也被写回旧值。
  // 原因：reset() 生成的空白文档 since 更新，但 flush 先把磁盘上的外部文档
  // 按 max 合并，旧计数又被加回来。外部重置方向已有测试，这里是反方向。
  const dir = tempDir()
  try {
    const filePath = statsPathOf(dir)
    const now = Date.now()
    const host = new Stats({ filePath, enabled: () => true, persistDelayMs: 0, now: () => now })
    host.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 10 })
    host.stop()
    assert.equal(host.snapshot().totals.requests, 1)

    // 另一个窗口/进程在宿主重置前又写了 1 条。
    const other = new Stats({ filePath, enabled: () => true, persistDelayMs: 0, now: () => now })
    other.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 10 })
    other.stop()

    const snapshot = host.reset()
    assert.equal(snapshot.totals.requests, 0, '重置后的内存快照必须是空的')
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'))
    assert.equal(onDisk.totals.requests, 0, '落盘不能被另一个进程的旧计数合并回来')
    assert.equal(onDisk.recent.length, 0)
    const reloaded = new Stats({ filePath, enabled: () => true, now: () => now })
    assert.equal(reloaded.snapshot().totals.requests, 0, '其它进程重载后也必须是空的')
    reloaded.stop()
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

test('统计：账号 × 模型有「今日」口径，且跨天自动清零', () => {
  // 事故现场：卡片上方写「今日 1,159 次 / 366M tokens」，交叉表却给累计的
  // 24 次 / 10M —— 交叉维度是升级后才开始累积的，累计值天然小于历史总量，
  // 两个数并排放着，用户只会以为坏了。所以必须单独记一份「今日」。
  const dir = tempDir()
  const day1 = new Date(2026, 9, 18, 10, 0, 0).getTime()
  const day2 = new Date(2026, 9, 19, 10, 0, 0).getTime()
  try {
    let clock = day1
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true, now: () => clock })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'hy3', kind: 'stop', durationMs: 10, usage: { inputTokens: 100, outputTokens: 50 } })
    stats.record({ provider: 'workbuddy', accountId: 'b', model: 'hy3', kind: 'stop', durationMs: 10, usage: { inputTokens: 60, outputTokens: 40 } })
    let snapshot = stats.snapshot()
    // 今日与累计在第一天相同。
    assert.equal(snapshot.accountModelToday['workbuddy::a::hy3'].totalTokens, 150)
    assert.equal(snapshot.accountModels['workbuddy::a::hy3'].totalTokens, 150)
    assert.equal(snapshot.accountModelToday['workbuddy::b::hy3'].totalTokens, 100)

    // 跨天：今日清零，累计保留。
    clock = day2
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'hy3', kind: 'stop', durationMs: 10, usage: { inputTokens: 7, outputTokens: 3 } })
    snapshot = stats.snapshot()
    assert.equal(snapshot.accountModelToday['workbuddy::a::hy3'].totalTokens, 10, '今日应只剩新的一天那 10 tok')
    assert.equal(snapshot.accountModelToday['workbuddy::b::hy3'], undefined, '前一天 b 账号的今日应被清掉')
    assert.equal(snapshot.accountModels['workbuddy::a::hy3'].totalTokens, 160, '累计不能被日切影响')
    assert.equal(snapshot.accountModels['workbuddy::b::hy3'].totalTokens, 100, '累计不能丢另一个账号')
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：今日口径落盘后重启仍是今日，跨天则不复活', () => {
  const dir = tempDir()
  const day1 = new Date(2026, 9, 18, 10, 0, 0).getTime()
  const day2 = new Date(2026, 9, 19, 10, 0, 0).getTime()
  try {
    const filePath = statsPathOf(dir)
    const first = new Stats({ filePath, enabled: () => true, now: () => day1 })
    first.record({ provider: 'workbuddy', accountId: 'a', model: 'hy3', kind: 'stop', durationMs: 10, usage: { inputTokens: 11, outputTokens: 22 } })
    first.stop()

    // 同一天重启：今日还在。
    const sameDay = new Stats({ filePath, enabled: () => true, now: () => day1 + 3600_000 })
    assert.equal(sameDay.snapshot().accountModelToday['workbuddy::a::hy3'].totalTokens, 33)
    sameDay.stop()

    // 第二天重启：今日必须为空，累计还在 —— 否则「今日」会跨天累积。
    const nextDay = new Stats({ filePath, enabled: () => true, now: () => day2 })
    const snapshot = nextDay.snapshot()
    assert.deepEqual(snapshot.accountModelToday, {}, '跨天重启后今日口径必须清零')
    assert.equal(snapshot.accountModels['workbuddy::a::hy3'].totalTokens, 33, '累计不受日切影响')
    nextDay.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：today 缺失时 providerToday 也不能复活（与 accountModelToday 同一条判据）', () => {
  const dir = tempDir()
  try {
    const filePath = statsPathOf(dir)
    const now = new Date(2026, 9, 18, 10, 0, 0).getTime()
    const raw = {
      version: 4,
      since: now,
      totals: { requests: 7 },
      providers: { workbuddy: { requests: 7 } },
      // 故意没有 today：providerToday 看起来是「今天」的，但没有日期可证明。
      providerToday: { workbuddy: { requests: 7, ok: 7 } },
    }
    writeFileSync(filePath, JSON.stringify(raw), 'utf8')
    const stats = new Stats({ filePath, enabled: () => true, now: () => now })
    const snapshot = stats.snapshot()
    assert.equal(snapshot.today.requests, 0)
    assert.equal(snapshot.providerToday.workbuddy.requests, 0, '今天缺失时不能把 providerToday 当成今天')
    assert.equal(snapshot.providers.workbuddy.requests, 7, '累计仍然保留')
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：只读命令不会重写文件；未知版本拒绝写回', () => {
  const dir = tempDir()
  try {
    const filePath = statsPathOf(dir)
    const writer = new Stats({ filePath, enabled: () => true })
    writer.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 1 })
    writer.stop()
    const saved = readFileSync(filePath, 'utf8')

    // 只读实例：构造 + snapshot + stop 不应该产生任何写入。
    const reader = new Stats({ filePath, enabled: () => true })
    assert.equal(reader.dirty, false)
    reader.snapshot()
    assert.equal(reader.stop(), true)
    assert.equal(readFileSync(filePath, 'utf8'), saved, '只读命令不能重写统计文件')

    // 更新版本（例如降级安装）：只读加载，flush 必须拒绝，文件保持原样。
    const newer = JSON.stringify({ version: 5, since: Date.now(), totals: { requests: 9 }, secret: 'keep' })
    writeFileSync(filePath, newer, 'utf8')
    const blocked = new Stats({ filePath, enabled: () => true })
    assert.equal(blocked.writeBlocked, true)
    assert.equal(blocked.unsupportedVersion, 5)
    assert.equal(blocked.flush(), false)
    assert.equal(readFileSync(filePath, 'utf8'), newer, '未知版本不能被旧代码覆盖')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：显式传入更早的 at 不会把今日桶回滚清空', () => {
  const dir = tempDir()
  try {
    const day1 = new Date(2026, 9, 18, 10, 0, 0).getTime()
    const earlier = new Date(2026, 9, 17, 23, 0, 0).getTime()
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true, now: () => day1 })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 1, at: day1 })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 1, at: earlier })
    assert.equal(stats.snapshot().today.requests, 2, '两条都应记在当前的今日桶里')
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：两个进程同时写入时按 max 合并，不再互相覆盖', () => {
  const dir = tempDir()
  try {
    const filePath = statsPathOf(dir)
    const host = new Stats({ filePath, enabled: () => true })
    host.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 1 })
    host.flush()

    // 模拟 CLI：读到 host 的 1 次，再追加 5 次。
    const cli = new Stats({ filePath, enabled: () => true })
    for (let index = 0; index < 5; index++) {
      cli.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 1 })
    }
    cli.stop()
    assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).totals.requests, 6)

    // 宿主再记 1 次（内存里是 2 次）后落盘：不能把 CLI 的 6 次覆盖成 2 次。
    host.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 1 })
    host.stop()
    const saved = JSON.parse(readFileSync(filePath, 'utf8'))
    assert.equal(saved.totals.requests, 6, '必须保留另一个进程已经写下的更大进度')
    assert.ok(saved.recent.length >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：删除账号时清掉该账号的累计与交叉维度', () => {
  const dir = tempDir()
  try {
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 1 })
    stats.record({ provider: 'workbuddy', accountId: 'b', model: 'm', kind: 'stop', durationMs: 1 })
    assert.equal(stats.forgetAccount('workbuddy', 'a'), true)
    const snapshot = stats.snapshot()
    assert.equal(snapshot.accounts['workbuddy::a'], undefined)
    assert.equal(snapshot.accountModels['workbuddy::a::m'], undefined)
    assert.equal(snapshot.accountModelToday['workbuddy::a::m'], undefined)
    assert.ok(snapshot.accounts['workbuddy::b'] !== undefined, '只删指定账号')
    assert.equal(stats.forgetAccount('workbuddy', 'nope'), false)
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('统计合并：跨午夜时 providerToday / accountModelToday 不能把昨天并进今天', () => {
  // 只给 `today` 加日期门是不够的：另两个「今日」维度同样是无条件 max 合并，
  // 跨进程跨午夜后会显示「今日 3 次，WorkBuddy 今日 10 次」这种自相矛盾的数字。
  const base = {
    since: 1,
    totals: emptyCounters(),
    providers: {},
    accounts: {},
    models: {},
    accountModels: {},
    daily: {},
    providerDaily: {},
    sessions: {},
    providerSessions: {},
    recent: [],
  }
  const left = {
    ...base,
    today: { ...emptyCounters(), date: '2026-10-19', requests: 3 },
    providerToday: { workbuddy: { ...emptyCounters(), requests: 3, lastAt: 10 } },
    accountModelToday: { 'workbuddy::acc-b::hy3': { ...emptyCounters(), requests: 3 } },
  }
  const right = {
    ...base,
    today: { ...emptyCounters(), date: '2026-10-18', requests: 10 },
    providerToday: { workbuddy: { ...emptyCounters(), requests: 10, lastAt: 5 } },
    accountModelToday: { 'workbuddy::acc-a::hy3': { ...emptyCounters(), requests: 10 } },
  }
  const merged = mergeStatsData(left, right)
  assert.equal(merged.today.date, '2026-10-19')
  assert.equal(merged.today.requests, 3, 'today 只认新的一天')
  assert.equal(merged.providerToday.workbuddy.requests, 3, '分 provider 的今日同样只认新的一天')
  assert.equal(merged.accountModelToday['workbuddy::acc-a::hy3'], undefined, '昨天的账号×模型今日计数不能复活')
  assert.equal(merged.accountModelToday['workbuddy::acc-b::hy3'].requests, 3)
  // 同一天时仍然要合并（否则两个窗口会互相覆盖）。
  const sameDay = mergeStatsData(
    { ...left, providerToday: { workbuddy: { ...emptyCounters(), requests: 3 } } },
    {
      ...right,
      today: { ...emptyCounters(), date: '2026-10-19', requests: 4 },
      providerToday: { workbuddy: { ...emptyCounters(), requests: 4 } },
    },
  )
  assert.equal(sameDay.today.requests, 4)
  assert.equal(sameDay.providerToday.workbuddy.requests, 4)
})

test('统计合并：已恢复的 provider 不会因为另一侧旧连败继续显示「不可用」', () => {
  // consecutiveFailures 不是单调累计量：成功会清零，而 healthOf() 只凭 ≥3 判 down。
  // 按 max 合并会让「另一个窗口成功过一次」被本进程的旧连败覆盖回去。
  const stale = { ...emptyCounters(), consecutiveFailures: 3, lastAt: 1000, lastErrorAt: 1000 }
  const recovered = { ...emptyCounters(), consecutiveFailures: 0, lastAt: 2000, lastOkAt: 2000 }
  // 谁的最后一次请求更新，谁说了算 —— 与参数顺序无关。
  assert.equal(mergeCountersMax(stale, recovered).consecutiveFailures, 0, '较新的成功必须赢')
  assert.equal(mergeCountersMax(recovered, stale).consecutiveFailures, 0, '较新的成功必须赢（参数顺序无关）')
  // 反过来：较新的失败同样要能覆盖旧的 0。
  const freshFailure = { ...emptyCounters(), consecutiveFailures: 2, lastAt: 3000, lastErrorAt: 3000 }
  assert.equal(mergeCountersMax(recovered, freshFailure).consecutiveFailures, 2, '较新的失败同样必须赢')
  assert.equal(mergeCountersMax(freshFailure, recovered).consecutiveFailures, 2)
  // 累计量仍然按 max。
  assert.equal(mergeCountersMax({ ...emptyCounters(), requests: 9 }, { ...emptyCounters(), requests: 2 }).requests, 9)
})

test('统计：时钟前跳后回拨不会把今日钉在未来日期', () => {
  const dir = tempDir()
  const T0 = new Date(2026, 9, 18, 10, 0, 0).getTime()
  const req = () => ({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 1 })
  try {
    let clock = T0
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true, now: () => clock })
    stats.record(req())
    stats.record(req())
    assert.equal(stats.snapshot().today.requests, 2)
    // 时钟前跳两天（NTP / 虚拟机快照恢复），然后被校正回来。
    clock = T0 + 2 * 86_400_000
    stats.record(req())
    assert.equal(stats.snapshot().today.date, dayKey(clock))
    clock = T0 + 1000
    stats.record(req())
    const snapshot = stats.snapshot()
    assert.equal(snapshot.today.date, dayKey(T0), '时钟回到今天后今日桶必须跟着回来')
    assert.equal(snapshot.today.requests, 1, '今天从 0 重新开始计数，而不是继续往未来日期累加')
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：today 日期缺失或损坏时，不以「今天」的名义复活旧今日桶', () => {
  // `data.today.date` 在 today 缺失时会被归一化成「今天」，用它当判据会把
  // 昨天的 accountModelToday 当成今天的。判据必须看**文件里**写的日期。
  const dir = tempDir()
  const day1 = new Date(2026, 9, 18, 10, 0, 0).getTime()
  const day2 = new Date(2026, 9, 19, 10, 0, 0).getTime()
  try {
    const filePath = statsPathOf(dir)
    const first = new Stats({ filePath, enabled: () => true, now: () => day1 })
    first.record({ provider: 'workbuddy', accountId: 'a', model: 'hy3', kind: 'stop', durationMs: 10, usage: { inputTokens: 5, outputTokens: 5 } })
    first.stop()

    // 手改文件：把 today 整块删掉（模拟半截写入 / 手改），只留今日桶。
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    delete raw.today
    writeFileSync(filePath, JSON.stringify(raw), 'utf8')

    const reloaded = new Stats({ filePath, enabled: () => true, now: () => day2 })
    assert.deepEqual(reloaded.snapshot().accountModelToday, {}, 'today 缺失时不能复活旧今日桶')
    assert.equal(reloaded.snapshot().accountModels['workbuddy::a::hy3'].totalTokens, 10, '累计仍然保留')
    reloaded.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
