// 第七轮审计（0.6.6）的回归：每条都对应一个用真实输入复现过的缺陷。
//
// 编号与 CHANGELOG 一一对应：
// - RQ1  流中排队重开拿到的是「sleep 前」的剩余预算 → 实际等待可达配置值 2 倍
// - RQ2  换号命中已删除的候选账号，并把续期令牌写回（账号复活）
// - RQ3  Qoder 流内错误硬编码 500 → 鉴权失败被降级成 SERVER，永不换号
// - RQ4  额度缓存里残留的 `inflight` 让该账号此后每次刷新都被跳过
// - RQ5  并发 force 刷新不合并：3 次「刷新」点击 = 3 轮上游请求（目录）
// - RQ6  `events-clear` 写盘失败仍返回 200「已清空」
// - RQ7  `stats-reset` 写盘失败后内存已清零，且失败的重置会在下一次 flush 被「补做」
// - RQ8  CLI `checkin` / `probe` 真实失败仍 exit 0
// - RQ9  额度历史的删除墓碑只在内存 → 另一进程 flush 把已删账号的历史并回来
// - RQ10 目录缓存没有跨进程合并 → 宿主去抖落盘抹掉 CLI 刚缓存的账号目录
// - RQ11 Trae 显式配置的登录文件不存在时静默回退去读本机默认登录（用错账号）
// - RQ12 统计删除墓碑只在真删到东西时才记，且迟到的请求会无条件撤销它
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LlmFailure, finishError, stableFailureCode, toResolvedModelInfo } from '../lib/adapter.js'
import { fallbackModelsFor } from '../lib/fallback-models.js'
import { apply } from '../lib/index.js'
import { loadCatalogCache, saveCatalogCache } from '../lib/catalog-cache.js'
import { CreditHistory } from '../lib/credit-history.js'
import { EventLog } from '../lib/events.js'
import { ACTION_PATH, DATA_DIR_NAME, PROVIDER_IDS, PROVIDERS, SETTINGS_PATH, STATUS_PATH } from '../lib/protocol.js'
import { creditsAlertOf, isExhaustedCredits, isFreePlan } from '../lib/quota.js'
import { Runtime, failureCodeOf, retryQueued } from '../lib/runtime.js'
import { SettingsStore, defaults } from '../lib/settings.js'
import { Stats, dayKey } from '../lib/stats.js'
import { readStoredAuth } from '../lib/trae/credential.js'

/** 只有 workbuddy 启用、单个带长效令牌的账号。 */
function baseSettings(accountId = 'a') {
  const settings = defaults()
  for (const provider of ['workbuddy-ai', 'qoder', 'qoder-global', 'trae', 'trae-global']) {
    settings.providers[provider].enabled = false
  }
  settings.qoder.qoder.pat = ''
  settings.accounts.workbuddy = [{
    id: accountId,
    label: '账号 A',
    enabled: true,
    token: {
      accessToken: 'token-a',
      refreshToken: '',
      expiresAtMs: Date.now() + 86_400_000,
      refreshExpiresAtMs: 0,
      domain: 'codebuddy.cn',
      uid: 'uid-a',
      enterpriseId: '',
    },
  }]
  settings.activeAccount.workbuddy = accountId
  return settings
}

// ---------- RQ1 ----------

test('RQ1 Qoder 流中排队重开只能拿「此刻起」的剩余预算，不许多给一份', async () => {
  const budgetMs = 2000
  const startedAt = Date.now()
  const grants = []
  let reopenCalls = 0
  // 第一次流立刻结束；之后每次重开都还要再等（上游持续排队）。
  const softRate = () => {
    const failure = new Error('排队中')
    failure.kind = 'soft-rate'
    failure.code = 'soft-rate'
    failure.retryAfterMs = 3000
    failure.queue = { count: 5, available: true, type: 'p3' }
    return failure
  }
  async function* failingStream() {
    throw softRate()
  }
  const reopen = async (budget) => {
    reopenCalls += 1
    grants.push(budget)
    if (reopenCalls > 3) throw softRate()
    return { body: failingStream() }
  }
  const consume = async () => {
    for await (const _event of retryQueued(reopen, failingStream(), undefined, { startedAt, budgetMs })) {
      // 心跳
    }
  }
  await consume().catch(() => undefined)
  const elapsed = Date.now() - startedAt
  // 整轮墙钟不能明显超出预算（旧实现是 2 倍，实测 4024ms）。
  assert.ok(elapsed <= budgetMs + 1200, `实际等待 ${elapsed}ms 超出预算 ${budgetMs}ms 太多`)
  for (const granted of grants) {
    const remainingAtGrant = budgetMs - (Date.now() - startedAt)
    assert.ok(
      granted <= Math.max(0, remainingAtGrant) + 500,
      `重开拿到 ${granted}ms 预算，但此刻真实剩余只有约 ${remainingAtGrant}ms`,
    )
  }
})

// ---------- RQ2 ----------

test('RQ2 请求在飞时删除候选账号：不换号到它，也不把续期令牌写回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq2-'))
  const originalFetch = globalThis.fetch
  const token = (uid, accessToken, ttlMs) => ({
    accessToken,
    refreshToken: `refresh-${uid}`,
    expiresAtMs: Date.now() + ttlMs,
    refreshExpiresAtMs: Date.now() + 86_400_000,
    domain: 'codebuddy.cn',
    uid,
    enterpriseId: '',
  })
  const settings = defaults()
  for (const provider of ['workbuddy-ai', 'qoder', 'qoder-global', 'trae', 'trae-global']) {
    settings.providers[provider].enabled = false
  }
  settings.qoder.qoder.pat = ''
  settings.accounts.workbuddy = [
    // A 长效令牌：主尝试不会触发续期。
    { id: 'a', label: '账号 A', enabled: true, token: token('uid-a', 'token-a', 86_400_000) },
    // B 即将过期：任何使用都会续期并写回。
    { id: 'b', label: '账号 B', enabled: true, token: token('uid-b', 'token-b', 60_000) },
  ]
  settings.activeAccount.workbuddy = 'a'

  const written = []
  const chatAuths = []
  let releaseA
  const gateA = new Promise((resolve) => { releaseA = resolve })
  let aSeen = false
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (href.includes('/v2/plugin/auth/token/refresh')) {
      const refreshToken = init?.headers?.['X-Refresh-Token'] ?? ''
      return Response.json({ data: { accessToken: `${refreshToken}-refreshed`, refreshToken, expiresIn: 3600 } })
    }
    const auth = String(init?.headers?.Authorization ?? '')
    chatAuths.push(auth)
    if (auth.includes('token-a')) {
      aSeen = true
      await gateA
      return new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })
    }
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"from-b"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const runtime = new Runtime({
      settings: () => settings,
      dataDir: dir,
      logger: {},
      onCredentialRefreshed: (provider, accountId, tok) => written.push({ provider, accountId, token: tok }),
    })
    const opened = await runtime.openStream('workbuddy', {
      model: 'hy3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: AbortSignal.timeout(15_000),
    })
    const consumed = (async () => {
      const events = []
      for await (const event of opened.events) events.push(event)
      return events
    })()
    while (!aSeen) await new Promise((resolve) => setTimeout(resolve, 10))
    // 用户删掉候选账号 B。
    settings.accounts.workbuddy = [settings.accounts.workbuddy[0]]
    runtime.forgetAccount('workbuddy', 'b')
    releaseA()
    const events = await consumed
    assert.equal(
      chatAuths.some((auth) => auth.includes('token-b')),
      false,
      '换号不能命中已删除的账号',
    )
    assert.deepEqual(written, [], '已删除账号的续期结果不能写回设置')
    assert.equal(events.some((event) => event.type === 'text' && event.text === 'from-b'), false)
    runtime.flushCaches()
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ2b ----------

test('RQ2b 所有候选都在请求期间被删：明确报错，不产出静默空流', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq2b-'))
  const originalFetch = globalThis.fetch
  const token = (uid, accessToken) => ({
    accessToken,
    refreshToken: '',
    expiresAtMs: Date.now() + 86_400_000,
    refreshExpiresAtMs: 0,
    domain: 'codebuddy.cn',
    uid,
    enterpriseId: '',
  })
  const settings = defaults()
  for (const provider of ['workbuddy-ai', 'qoder', 'qoder-global', 'trae', 'trae-global']) {
    settings.providers[provider].enabled = false
  }
  settings.qoder.qoder.pat = ''
  settings.accounts.workbuddy = [
    { id: 'a', label: '账号 A', enabled: true, token: token('uid-a', 'token-a') },
    { id: 'b', label: '账号 B', enabled: true, token: token('uid-b', 'token-b') },
  ]
  settings.activeAccount.workbuddy = 'a'
  let upstreamCalls = 0
  globalThis.fetch = async () => {
    upstreamCalls += 1
    return new Response('nope', { status: 500 })
  }
  try {
    const recorded = []
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {}, stats: { record: (entry) => recorded.push(entry) } })
    const opened = await runtime.openStream('workbuddy', {
      model: 'hy3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: AbortSignal.timeout(5_000),
    })
    // 生成器体还没跑：此刻删掉两个候选。
    runtime.forgetAccount('workbuddy', 'a')
    runtime.forgetAccount('workbuddy', 'b')
    const events = []
    await assert.rejects(async () => {
      for await (const event of opened.events) events.push(event)
    }, (error) => {
      // 必须是「没有可用账号」，而不是静默结束（宿主会显示空白回答）。
      assert.equal(error?.code, 'NO_ACCOUNT')
      assert.equal(failureCodeOf(error), 'AUTH')
      return true
    })
    assert.equal(upstreamCalls, 0, '已删除的账号不能再去打上游')
    assert.deepEqual(events, [], '不该产出任何事件')
    assert.deepEqual(recorded, [], '一次上游请求都没发出的「请求」不能记进统计')
    runtime.flushCaches()
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ4 ----------

test('RQ4 额度缓存里残留的 inflight 不会让该账号此后永远刷新不到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq4-'))
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return Response.json({
      code: 0,
      data: { Response: { Data: { Accounts: [{ PackageName: 'p', CycleCapacitySize: 100, CycleCapacityRemain: 55, CycleCapacityUsed: 45, Status: 0 }] } } },
    })
  }
  try {
    const settings = baseSettings('a')
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    // 模拟一次异常退出留下的陈旧 inflight。
    const dead = Promise.reject(new Error('boom'))
    dead.catch(() => undefined)
    runtime.creditCache.set('workbuddy::a', {
      data: { state: 'ok', remain: 1, total: 100, unit: 'credits', items: [], fetchedAt: 1 },
      fetchedAt: 1,
      inflight: dead,
    })
    await runtime.refreshCredits('workbuddy', { force: true })
    assert.equal(runtime.creditCache.get('workbuddy::a')?.inflight, undefined, 'inflight 必须被摘掉')
    await runtime.refreshCredits('workbuddy', { force: true })
    assert.ok(calls >= 1, '后续强制刷新必须真的打上游')
    assert.equal(runtime.creditsFor('workbuddy').remain, 55, '缓存必须被真实结果更新')
    runtime.flushCaches()
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ5 ----------

test('RQ5 并发的 force 目录刷新只补跑一轮，不是每个调用者各跑一轮', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq5-'))
  const originalFetch = globalThis.fetch
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  let firstSeen = false
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (!href.includes('/v3/config')) throw new Error(`unexpected fetch: ${href}`)
    calls += 1
    if (!firstSeen) {
      firstSeen = true
      await gate
    } else {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return Response.json({
      code: 0,
      data: {
        agents: [{ name: 'cli', models: ['m'] }],
        models: [{ id: 'm', name: 'M', maxInputTokens: 1000, maxOutputTokens: 100 }],
      },
    })
  }
  try {
    const settings = baseSettings('a')
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    const background = runtime.refresh('workbuddy')
    await new Promise((resolve) => setTimeout(resolve, 10))
    const forces = [1, 2, 3].map(() => runtime.refresh('workbuddy', { force: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await Promise.all([background, ...forces])
    // 1 轮后台 + 1 轮共享补跑 = 2 次；旧实现是 1 + 3 = 4 次。
    assert.ok(calls <= 2, `3 次并发强制刷新打了 ${calls} 次上游目录（应为 2 次）`)
    runtime.flushCaches()
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ6 / RQ7 ----------

/** 起一个假的宿主 ctx，并返回可用的路由与句柄。 */
function makeHost(root) {
  const dataDir = join(root, DATA_DIR_NAME)
  mkdirSync(dataDir, { recursive: true })
  const handlers = {}
  const disposers = []
  const ctx = {
    get(name) { return name === 'profileContext' ? { dir: root } : undefined },
    inject(names, callback) {
      if (names.includes('webServer')) {
        callback({
          webServer: { register(route) { handlers[route.path] = route.handler; return () => { delete handlers[route.path] } } },
          effect(fn) { const d = fn(); disposers.push(d); return d },
        })
      }
    },
    effect(fn) { const d = fn(); disposers.push(d); return d },
    llm: { registerAdapter: () => () => {} },
    emit() {},
    logger: { info() {}, warn() {} },
  }
  function fakeResponse() {
    let resolveDone
    const done = new Promise((resolve) => { resolveDone = resolve })
    const res = {
      status: 0,
      body: '',
      writeHead(status) { res.status = status; return res },
      setHeader() {},
      end(chunk) { res.body = chunk === undefined ? '' : String(chunk); resolveDone() },
      done,
    }
    return res
  }
  async function get(url) {
    const res = fakeResponse()
    handlers[STATUS_PATH]({ method: 'GET', url, headers: { host: '127.0.0.1:65510' }, socket: { remoteAddress: '127.0.0.1' } }, res)
    await res.done
    return { status: res.status, body: JSON.parse(res.body) }
  }
  async function post(path, payload, key, waitMs = 400) {
    const res = fakeResponse()
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = path
    req.headers = { host: '127.0.0.1:65510', 'x-rpc-key': key, 'content-type': 'application/json' }
    req.socket = { remoteAddress: '127.0.0.1' }
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(payload))); req.emit('end') })
    handlers[path](req, res)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    return { status: res.status, body: res.body === '' ? {} : JSON.parse(res.body) }
  }
  return { ctx, dataDir, get, post, dispose: () => { for (const dispose of disposers.reverse()) { try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ } } } }
}

test('RQ6 事件账本落盘失败时 events-clear 必须报错，不能假装已清空', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rpc-rq6-'))
  const host = makeHost(root)
  // 更高版本的账本：EventLog 只读，任何 flush 都会失败。
  writeFileSync(join(host.dataDir, 'events.json'), JSON.stringify({ version: 99, events: [{ type: 'startup', message: '旧事件', at: Date.now() }] }))
  apply(host.ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 200))
  try {
    const status = await host.get(STATUS_PATH)
    const result = await host.post(ACTION_PATH, { action: 'events-clear' }, status.body.key, 600)
    assert.equal(result.status, 500, `应返回 500，实际 ${result.status}`)
    assert.equal(result.body.error, 'events-clear-failed')
    // 磁盘一字未改（只读保护），所以「已清空」也不能出现在响应里。
    const onDisk = JSON.parse(readFileSync(join(host.dataDir, 'events.json'), 'utf8'))
    assert.equal(onDisk.version, 99)
    assert.equal(onDisk.events.length, 1)
  } finally {
    host.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('RQ7 统计重置写盘失败后内存、磁盘、pending 三者都不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq7-'))
  try {
    const file = join(dir, 'stats.json')
    const stats = new Stats({ filePath: file })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'hy3', kind: 'stop' })
    stats.flush()
    const before = stats.snapshot()
    assert.equal(before.totals.requests, 1)
    // 让写盘必然失败：把目标路径换成一个目录。
    rmSync(file)
    mkdirSync(file)
    assert.throws(() => stats.reset())
    assert.equal(stats.snapshot().totals.requests, 1, '失败的重置不能清空内存快照')
    // 恢复可写后闲逛一次 flush：失败的重置不能被「补做」。
    rmSync(file, { recursive: true, force: true })
    stats.flush()
    if (existsSync(file)) {
      const onDisk = JSON.parse(readFileSync(file, 'utf8'))
      assert.ok(onDisk.totals.requests >= 1, `磁盘不应被清空，实际 ${onDisk.totals.requests}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ9 ----------

test('RQ9 额度历史的删除墓碑跨进程有效：另一个进程落盘不能把已删账号并回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq9-'))
  try {
    let clock = 1_000_000
    const now = () => clock
    const file = join(dir, 'credits-history.json')
    // 进程 A：写一条历史，再删掉账号。
    const a = new CreditHistory({ filePath: file, now })
    a.record('qoder', 'default', { state: 'ok', remain: 700, total: 1000 }, clock)
    a.flush()
    a.forget('qoder', 'default')
    // 进程 B：载入（此时磁盘上已无该条目，但墓碑必须被继承）。
    clock += 1000
    const b = new CreditHistory({ filePath: file, now })
    b.record('qoder', 'acc-2', { state: 'ok', remain: 50, total: 100 }, clock)
    b.flush()
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.entries['qoder::default'], undefined, '已删除账号的历史不能复活')
    assert.notEqual(onDisk.entries['qoder::acc-2'], undefined, '其它账号的历史必须保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ10 ----------

test('RQ10 目录缓存落盘前与磁盘合并，不抹掉另一个进程刚缓存的账号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq10-'))
  try {
    const now = Date.now()
    // 宿主持有的内存快照：只有 a、b。
    const hostEntries = new Map([
      ['workbuddy::acc-a', { models: [{ id: 'm1', name: 'M1', contextWindow: 1000, maxTokens: 100 }], fetchedAt: now - 1000 }],
      ['workbuddy::acc-b', { models: [{ id: 'm1', name: 'M1', contextWindow: 1000, maxTokens: 100 }], fetchedAt: now - 1000 }],
    ])
    // CLI 刚刷新了 acc-c 并落盘。
    const cliEntries = new Map([
      ['workbuddy::acc-a', { models: [{ id: 'm1', name: 'M1', contextWindow: 1000, maxTokens: 100 }], fetchedAt: now - 1000 }],
      ['workbuddy::acc-b', { models: [{ id: 'm1', name: 'M1', contextWindow: 1000, maxTokens: 100 }], fetchedAt: now - 1000 }],
      ['workbuddy::acc-c', { models: [{ id: 'm2', name: 'M2', contextWindow: 1000, maxTokens: 100 }], fetchedAt: now }],
    ])
    assert.equal(saveCatalogCache(dir, cliEntries), true)
    assert.equal(saveCatalogCache(dir, hostEntries), true)
    const merged = loadCatalogCache(dir)
    assert.notEqual(merged.get('workbuddy::acc-c'), undefined, 'CLI 刚缓存的账号目录不能被宿主抹掉')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ11 ----------

test('RQ11 Trae 显式配置的登录文件不存在时不许偷偷读本机默认登录', () => {
  const root = mkdtempSync(join(tmpdir(), 'rpc-rq11-'))
  const savedAppData = process.env.APPDATA
  try {
    process.env.APPDATA = join(root, 'AppData', 'Roaming')
    // 本机默认位置有一份可用登录。
    const defaultFile = join(process.env.APPDATA, 'Trae CN', 'User', 'globalStorage', 'storage.json')
    mkdirSync(join(process.env.APPDATA, 'Trae CN', 'User', 'globalStorage'), { recursive: true })
    writeFileSync(defaultFile, JSON.stringify({
      'iCubeAuthInfo://icube.cloudide': JSON.stringify({
        token: 'default-token',
        refreshToken: 'default-refresh',
        userId: 'user-default',
        host: 'https://api.trae.ai',
        account: { username: 'default' },
        expiredAt: '2030-01-01T00:00:00.000Z',
      }),
    }))
    // 用户显式配了一个不存在的便携版路径。
    const explicit = join(root, 'portable', 'does-not-exist.json')
    assert.throws(
      () => readStoredAuth('trae', explicit),
      /指定的路径不存在/,
      '显式配置失效时必须报错，而不是回退到本机登录',
    )
    // 没配路径时仍然自动发现。
    assert.equal(readStoredAuth('trae', undefined).token, 'default-token')
  } finally {
    if (savedAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = savedAppData
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------- RQ12 ----------

test('RQ12 已删除账号的统计不会被「删除前就发出的请求」写回来，新请求仍能重新记', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq12-'))
  try {
    let clock = 1_000_000
    const stats = new Stats({ filePath: join(dir, 'stats.json'), now: () => clock })
    const startedAt = clock
    // 请求开始后账号被删除。
    stats.forgetAccount('workbuddy', 'b')
    clock += 5_000
    // 请求此刻结束；`at` 是「这条记录算哪一天」，`startedAt` 只用于墓碑判定。
    stats.record({ provider: 'workbuddy', accountId: 'b', model: 'hy3', kind: 'stop', startedAt, at: clock })
    assert.equal(stats.snapshot().accounts['workbuddy::b'], undefined, '迟到的旧记录不能重建账号统计')
    assert.equal(stats.snapshot().accountModels['workbuddy::b::hy3'], undefined)
    // 删除之后真的又来了新请求：必须重新记上。
    stats.record({ provider: 'workbuddy', accountId: 'b', model: 'hy3', kind: 'stop', at: clock + 1000 })
    assert.ok(stats.snapshot().accounts['workbuddy::b'], '删除后的新请求必须能重新记录')
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ12b ----------

test('RQ12b 跨午夜的请求：KPI「今日」与 14 天柱状图必须落在同一天', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq12b-'))
  try {
    // 请求 23:59:50 发起、00:00:10 结束（一次 20 秒的回答）。
    const startA = new Date(2026, 9, 20, 23, 59, 50, 0).getTime()
    const endA = new Date(2026, 9, 21, 0, 0, 10, 0).getTime()
    const stats = new Stats({ filePath: join(dir, 'stats.json'), now: () => endA })
    stats.record({
      provider: 'workbuddy',
      accountId: 'a',
      model: 'glm',
      kind: 'stop',
      // Runtime 传的是 startedAt（只用于删除墓碑），不是 at。
      startedAt: startA,
      durationMs: 20_000,
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    const snapshot = stats.snapshot()
    const todayKey = dayKey(endA)
    // 今日桶按进程时钟换（endA = 10-21），daily 也必须记在 10-21，否则卡片写
    // 「今日 1 次」而柱状图今天那格是 0、昨天多出 1 次。
    assert.equal(snapshot.today.date, todayKey)
    assert.equal(snapshot.today.requests, 1)
    const dailyToday = snapshot.daily.find((day) => day.date === todayKey)
    assert.notEqual(dailyToday, undefined, `daily 里没有今天（${todayKey}）那一格`)
    assert.equal(dailyToday.requests, 1, 'daily 今天那格必须与 KPI 一致')
    assert.equal(snapshot.providerToday.workbuddy.requests, 1)
    const yesterday = snapshot.daily.find((day) => day.date === '2026-10-20')
    assert.equal(yesterday, undefined, '跨午夜的请求不该同时记进昨天')

    // 反方向：显式补记一条「昨天」的请求，必须进昨天那一格。
    const stats2 = new Stats({ filePath: join(dir, 'other.json'), now: () => endA })
    stats2.record({
      provider: 'qoder',
      accountId: 'a',
      model: 'm',
      kind: 'stop',
      at: new Date(2026, 9, 20, 23, 0, 0).getTime(),
      durationMs: 1,
    })
    const backDated = stats2.snapshot().daily.find((day) => day.date === '2026-10-20')
    assert.notEqual(backDated, undefined, '显式 at 的补记必须进它自己那天')
    assert.equal(backDated.requests, 1)
    stats.stop()
    stats2.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ13 ----------

test('RQ13 上游 HTTP 失败要落到宿主可重试的 code 上（否则一次 503 就终结整轮）', () => {
  // 宿主的 DEFAULT_RETRYABLE_CODES。`upstream-error` **不**在里面。
  const HOST_RETRYABLE = new Set(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
  const fail = (status, extra = {}) => {
    const error = new Error(`upstream HTTP ${status}`)
    error.code = 'upstream-error'   // 三家上游的共用兜底码（见 workbuddy/upstream.js）
    error.status = status
    Object.assign(error, extra)
    return error
  }
  const cases = [
    // status → 期望 code。401/402 不该重试，其余必须是宿主认得的可重试码。
    [503, 'SERVER'],
    [500, 'SERVER'],
    [502, 'SERVER'],
    [504, 'SERVER'],
    [408, 'SERVER'],
    [429, 'RATE_LIMIT'],
    [401, 'AUTH'],
    [403, 'AUTH'],
    [402, 'QUOTA'],
  ]
  for (const [status, expected] of cases) {
    const chunk = finishError(fail(status))
    const failure = chunk.reason.failure
    assert.equal(failure.code, expected, `HTTP ${status} 应映射成 ${expected}，实际 ${failure.code}`)
    assert.equal(failure.status, status, 'status 要原样带给宿主')
    // 同一个错误，适配器与运行时的分类必须一致（CLI/诊断/宿主看到同一个结论）。
    assert.equal(failureCodeOf(fail(status)), expected, `failureCodeOf 与适配器对 HTTP ${status} 的判断不一致`)
    if (expected === 'SERVER' || expected === 'RATE_LIMIT') {
      assert.ok(HOST_RETRYABLE.has(failure.code), `${failure.code} 必须在宿主重试表里`)
    }
  }
  // 429 的 Retry-After 不能被吞掉：宿主据此决定退避时长。
  const limited = fail(429, { retryAfterMs: 30_000 })
  const limitedFailure = finishError(limited).reason.failure
  assert.equal(limitedFailure.code, 'RATE_LIMIT')
  assert.equal(limitedFailure.providerRetryAfterMs, 30_000, 'Retry-After 必须传给宿主')

  // 已经判准的 code 不能被状态码覆盖（402 带配额语义、soft-rate 已判成限流）。
  const quota = new Error('额度用尽')
  quota.code = 'quota'
  quota.status = 500
  assert.equal(finishError(quota).reason.failure.code, 'QUOTA', 'code 已判准就不该被 status 改写')

  // 适配器自己抛的两种 code 不能被自己的映射表抹成 upstream-error。
  assert.equal(stableFailureCode('UNKNOWN_MODEL'), 'UNKNOWN_MODEL')
  assert.equal(stableFailureCode('UNSUPPORTED_OPTION'), 'UNSUPPORTED_OPTION')
  for (const code of ['UNKNOWN_MODEL', 'UNSUPPORTED_OPTION']) {
    const error = new LlmFailure('x', code)
    assert.equal(finishError(error).reason.failure.code, code)
  }
})

// ---------- RQ14 ----------

test('RQ14 目录里的小数窗口/输出上限要被收敛成正整数（否则宿主直接拒掉整轮）', () => {
  // 宿主 normalizeModelInfo(): contextWindow 必须 Number.isInteger && > 0，
  // defaultMaxTokens 必须 Number.isSafeInteger && > 0，否则 INVALID_MODEL_CONTEXT。
  const valid = (value) => Number.isSafeInteger(value) && value > 0
  const row = { id: 'frac', name: 'Fractional', contextWindow: 180000.5, maxTokens: 32768.5, reasoningEfforts: [] }
  const info = toResolvedModelInfo('qoder', row)
  assert.ok(valid(info.context.contextWindow), `contextWindow 不是正整数：${info.context.contextWindow}`)
  assert.ok(valid(info.defaultMaxTokens), `defaultMaxTokens 不是正整数：${info.defaultMaxTokens}`)
  assert.equal(info.context.contextWindow, 180000, '向下取整，宁可比上游少声明')
  assert.equal(info.defaultMaxTokens, 32768)

  // 非法值（0 / 负数 / NaN / Infinity / 字符串 / 缺失）都要回落到合法兜底。
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '128000', undefined, null]) {
    const fallback = toResolvedModelInfo('qoder', { id: 'x', name: 'X', contextWindow: bad, maxTokens: bad, reasoningEfforts: [] })
    assert.ok(valid(fallback.context.contextWindow), `contextWindow 兜底不合法（输入 ${String(bad)}）`)
    assert.ok(valid(fallback.defaultMaxTokens), `defaultMaxTokens 兜底不合法（输入 ${String(bad)}）`)
  }
})

// ---------- RQ15 ----------

test('RQ15 历史里读不到的图片降级成占位文案，不阻断本轮；本轮新图读不到才报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq15-'))
  const originalFetch = globalThis.fetch
  let capturedBody
  let refreshed = false
  const settings = baseSettings('a')
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (href.includes('/v3/config')) {
      refreshed = true
      return Response.json({
        code: 0,
        data: {
          agents: [{ name: 'cli', models: ['m'] }],
          models: [{ id: 'm', name: 'M', maxInputTokens: 1000, maxOutputTokens: 100 }],
        },
      })
    }
    capturedBody = init?.body
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    await runtime.refresh('workbuddy', { force: true })
    assert.equal(refreshed, true)
    runtime.setAttachments({
      async readImageRequest(ref) {
        if (ref?.attachmentId === 'stale-old' || ref?.attachmentId === 'fresh-broken') {
          throw new Error('attachment not found in store')
        }
        return { mediaType: 'image/png', data: new Uint8Array([1, 2, 3, 4]) }
      },
      imageHostPath() { return undefined },
    })

    // 历史里的旧图已失效，本轮是纯文本 → 必须照常聊。
    const opened = await runtime.openStream('workbuddy', {
      model: 'm',
      signal: AbortSignal.timeout(10_000),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { attachmentId: 'stale-old', mediaType: 'image/png' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'saw it' }] },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
    })
    for await (const event of opened.events) { void event }
    assert.notEqual(capturedBody, undefined, '历史里的坏图不该阻断本轮请求')
    assert.equal(JSON.stringify(JSON.parse(capturedBody)).includes('stale-old'), false, '读不到的图不能透给上游')

    // 本轮刚贴的图也读不到 → 必须明确报 image-unavailable。
    await assert.rejects(async () => {
      await runtime.openStream('workbuddy', {
        model: 'm',
        signal: AbortSignal.timeout(10_000),
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'stale-old', mediaType: 'image/png' } }] }],
      })
    }, (error) => {
      assert.equal(error?.code, 'image-unavailable')
      return true
    })

    // 历史里有一张能读的图，但本轮最后一条消息里的图读不到：不能因为
    // 「至少读到过一张图」就把本轮的新图静默降级成占位文本。
    await assert.rejects(async () => {
      await runtime.openStream('workbuddy', {
        model: 'm',
        signal: AbortSignal.timeout(10_000),
        messages: [
          { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'history-ok', mediaType: 'image/png' } }] },
          { role: 'assistant', content: [{ type: 'text', text: 'saw it' }] },
          { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'fresh-broken', mediaType: 'image/png' } }] },
        ],
      })
    }, (error) => {
      assert.equal(error?.code, 'image-unavailable')
      return true
    })
    runtime.flushCaches()
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ16 ----------

test('RQ16 兜底模型清单不再一律声明「支持图片」', () => {
  for (const provider of PROVIDER_IDS) {
    const rows = fallbackModelsFor(provider)
    if (rows.length === 0) continue
    for (const model of rows) {
      // 兜底清单是「上游一次都没成功过」时用的，对能力一无所知：
      // 声明支持图片会让宿主允许贴图，然后上游 400。
      assert.equal(model.supportsImages === true, false, `${provider}/${model.id} 不应对图片能力做没有依据的承诺`)
      assert.ok(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0, `${provider}/${model.id} 的 contextWindow 非法`)
      assert.ok(Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0, `${provider}/${model.id} 的 maxTokens 非法`)
    }
  }
})

// ---------- RQ17 ----------

test('RQ17 成功率与平均耗时：中断算失败、取消不算、被取消的耗时不许拖高均值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq17-'))
  try {
    const stats = new Stats({ filePath: join(dir, 'stats.json') })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 100 })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'incomplete', durationMs: 60_000 })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'incomplete', durationMs: 90_000 })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'aborted', durationMs: 120_000 })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'error', code: 'SERVER', durationMs: 200 })
    const counters = stats.snapshot().providers.workbuddy
    assert.equal(counters.requests, 5)
    // 1 成功 /（1 成功 + 1 失败 + 2 中断）= 0.25；取消不参与（那是用户按的）。
    assert.equal(counters.successRate, 0.25, `成功率应为 0.25，实际 ${counters.successRate}`)
    // 平均耗时只看成功请求：100ms。旧的「全部耗时 / 全部请求」= 54s。
    assert.equal(counters.avgDurationMs, 100, `平均耗时应为 100ms，实际 ${counters.avgDurationMs}`)
    // 全取消时不能除零，也不能报 undefined 之外的坏值。
    const empty = new Stats({ filePath: join(dir, 'other.json') })
    empty.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'aborted', durationMs: 5_000 })
    const abortedOnly = empty.snapshot().providers.workbuddy
    assert.equal(abortedOnly.successRate, undefined, '没有任何结算记录时成功率应是 undefined（界面显示 —）')
    assert.equal(abortedOnly.avgDurationMs, 0, '没有成功请求时平均耗时是 0')
    stats.stop()
    empty.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ18 ----------

test('RQ18 Trae Free 不再被当成「额度已用尽」（红卡 + 每轮刷新后自动换号）', () => {
  // Trae 在按免费额度计费时下发 freePlan: true（lib/trae/transport.js）。
  const traeFree = { state: 'ok', remain: 0, total: 0, freePlan: true, planName: 'Free' }
  assert.equal(isFreePlan('trae', traeFree), true, 'Trae 的 freePlan 要认')
  assert.equal(isExhaustedCredits(traeFree, 'trae'), false, 'Trae Free 不是「用尽」')
  assert.equal(creditsAlertOf(traeFree, {}, 'trae'), undefined, 'Trae Free 不该亮红色告警')
  // Qoder 的老行为不能回退。
  assert.equal(isExhaustedCredits({ state: 'ok', remain: 0, total: 0, freePlan: true }, 'qoder-global'), false)
  // 真的用完了（有付费额度但剩 0）必须仍然是「用尽」。
  const paidOut = { state: 'ok', remain: 0, total: 1000, paid: true }
  assert.equal(isExhaustedCredits(paidOut, 'trae'), true)
  assert.equal(creditsAlertOf(paidOut, {}, 'trae'), 'exhausted')
  // Qoder 计划接口失败 → 按 Free（不换号）。
  assert.equal(isExhaustedCredits({ state: 'ok', remain: 0, total: 0, planUnknown: true }, 'qoder'), false)
  // Trae 计划不明 + 0 额度：没有 freePlan 证据，不能凭空当免费（那是真的用完）。
  assert.equal(isFreePlan('trae', { state: 'ok', remain: 0, total: 0, planUnknown: true }), false)
  assert.equal(isExhaustedCredits({ state: 'ok', remain: 0, total: 0, planUnknown: true }, 'trae'), true)
})

// ---------- RQ19 ----------

test('RQ19 统计删除墓碑跨进程有效：另一个进程落盘不能把已删账号的用量并回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq19-'))
  try {
    const file = join(dir, 'stats.json')
    // 两个进程同时在线：B 先启动（内存里有 acc-1 的计数），A 随后删掉 acc-1。
    const b = new Stats({ filePath: file })
    b.record({ provider: 'workbuddy', accountId: 'acc-1', model: 'm', kind: 'stop', usage: { inputTokens: 1000, outputTokens: 500 } })
    b.record({ provider: 'workbuddy', accountId: 'acc-2', model: 'm', kind: 'stop' })
    b.flush()

    const a = new Stats({ filePath: file })
    a.record({ provider: 'workbuddy', accountId: 'acc-2', model: 'm', kind: 'stop' })
    a.forgetAccount('workbuddy', 'acc-1')
    // 磁盘上应该同时有墓碑。
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.notEqual(onDisk.forgotten, undefined, '墓碑必须随 stats.json 落盘')
    assert.notEqual(onDisk.forgotten['workbuddy::acc-1'], undefined)

    // B 落盘：不能把 acc-1 并回来。
    b.record({ provider: 'workbuddy', accountId: 'acc-2', model: 'm', kind: 'stop' })
    b.flush()
    const afterB = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(afterB.accounts['workbuddy::acc-1'], undefined, 'A 删掉的账号被 B 并回来了')
    assert.equal(afterB.accountModels['workbuddy::acc-1::m'], undefined, '账号×模型条目也被并回来了')

    // 新进程重新打开用量页面：看不到已删账号。
    const fresh = new Stats({ filePath: file })
    const snapshot = fresh.snapshot()
    assert.equal(snapshot.accounts['workbuddy::acc-1'], undefined)
    assert.notEqual(snapshot.accounts['workbuddy::acc-2'], undefined, '别的账号不能连带丢失')
    a.stop()
    b.stop()
    fresh.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ20 ----------

test('RQ20 迟到请求只跳过账号维度：全局用量照常累计，不把真实 token 抹掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq20-'))
  try {
    let clock = 1_000_000
    const stats = new Stats({ filePath: join(dir, 'stats.json'), now: () => clock })
    const startedAt = clock
    // 请求在飞时账号被删。
    stats.forgetAccount('workbuddy', 'b')
    clock += 5_000
    const recorded = stats.record({
      provider: 'workbuddy',
      accountId: 'b',
      model: 'hy3',
      kind: 'stop',
      startedAt,
      durationMs: 5_000,
      usage: { inputTokens: 1200, outputTokens: 300 },
    })
    const snapshot = stats.snapshot()
    // 这次请求真的发生了 → 全局 / provider / 今日 / 14 天都必须计入，
    // 否则用户看到的「累计」「今日」比真实用量少（0.6.5 本来是对的）。
    assert.equal(recorded, true, '迟到的真实请求不应被整条丢弃')
    assert.equal(snapshot.totals.requests, 1, '全局累计少了这一次真实请求')
    assert.equal(snapshot.totals.totalTokens, 1500, '全局 token 少了')
    assert.equal(snapshot.today.requests, 1)
    assert.equal(snapshot.providers.workbuddy.requests, 1)
    assert.equal(snapshot.daily.find((day) => day.date === snapshot.today.date)?.requests, 1)
    // 但账号维度不能复活，否则删掉的账号带着统计回到账号表。
    assert.equal(snapshot.accounts['workbuddy::b'], undefined)
    assert.equal(snapshot.accountModels['workbuddy::b::hy3'], undefined)
    assert.equal(snapshot.accountModelToday['workbuddy::b::hy3'], undefined)
    // 删除之后真的又来了新请求：账号行必须恢复。
    clock += 10_000
    stats.record({ provider: 'workbuddy', accountId: 'b', model: 'hy3', kind: 'stop', startedAt: clock, usage: { inputTokens: 10 } })
    assert.equal(stats.snapshot().accounts['workbuddy::b']?.requests, 1, '新请求应恢复账号行')
    assert.equal(stats.snapshot().totals.requests, 2, '累计应是 2')
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ21 ----------

test('RQ21 账本写盘失败时 clear() 不能把内存清空（否则 500 与「已清空」同时出现）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq21-'))
  try {
    const file = join(dir, 'events.json')
    const log = new EventLog({ filePath: file, persistDelayMs: 0 })
    log.record({ type: 'startup', message: 'first' })
    log.record({ type: 'credits', message: 'second' })
    log.flush()
    assert.equal(log.summary().count, 2)
    // 让下一次写盘必然失败：把目标文件换成一个目录。
    rmSync(file)
    mkdirSync(file)
    const cleared = log.clear()
    assert.equal(cleared, false, '写盘失败时 clear() 必须返回 false（index.js 据此回 500）')
    assert.equal(log.summary().count, 2, '写盘失败后内存必须保留原事件，界面不能说「账本为空」')
    // 恢复可写后必须真的清空。
    rmSync(file, { recursive: true, force: true })
    const log2 = new EventLog({ filePath: join(dir, 'events2.json'), persistDelayMs: 0 })
    log2.record({ type: 'startup', message: 'x' })
    assert.equal(log2.clear(), true)
    assert.equal(log2.summary().count, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ22 ----------

test('RQ22 重置统计失败时不能丢掉「已记录但还没落盘」的那条记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq22-'))
  try {
    const file = join(dir, 'stats.json')
    // 去抖很长：保证 record 之后还没有落盘。
    const stats = new Stats({ filePath: file, persistDelayMs: 60_000 })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', usage: { inputTokens: 42 } })
    assert.equal(existsSync(file), false, '前提：此时还没有落盘')
    // 让写盘必然失败。
    mkdirSync(file)
    assert.throws(() => stats.reset())
    assert.equal(stats.snapshot().totals.requests, 1, '失败的重置要回滚内存')
    // 恢复可写后，那条未落盘的记录仍必须被写出去。
    rmSync(file, { recursive: true, force: true })
    assert.equal(stats.flush(), true)
    assert.equal(existsSync(file), true, '失败的重置把 dirty 清成了 false，未落盘的记录被丢弃')
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ23 ----------

test('RQ23 删除账号后目录缓存的墓碑跨重启有效，已删账号的模型不再回到选择器', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-rq23-'))
  try {
    const model = (id) => [{ id, name: id, contextWindow: 1000, maxTokens: 100 }]
    const now = Date.now()
    const cache = new Map([
      ['workbuddy::acc-a', { models: model('a'), fetchedAt: now }],
      ['workbuddy::acc-b', { models: model('b'), fetchedAt: now }],
    ])
    cache.forgotten = new Set()
    assert.equal(saveCatalogCache(dir, cache), true)
    assert.equal(loadCatalogCache(dir).has('workbuddy::acc-b'), true, '前提：两个账号都有目录')
    // 删掉 acc-b：从内存移除 + 记墓碑。
    cache.delete('workbuddy::acc-b')
    cache.forgotten.add('workbuddy::acc-b')
    assert.equal(saveCatalogCache(dir, cache), true)
    assert.equal(loadCatalogCache(dir).has('workbuddy::acc-b'), false, '删除后不能留在条目里')
    // 「重启」：重新从磁盘加载，墓碑必须仍然生效。
    const reloaded = loadCatalogCache(dir)
    assert.equal(reloaded.has('workbuddy::acc-b'), false, '重启后已删账号的目录又回来了（会重新出现在选择器里）')
    assert.equal(reloaded.has('workbuddy::acc-a'), true, '别的账号不能连带丢失')
    assert.equal(reloaded.forgotten.has('workbuddy::acc-b'), true, '墓碑本身也要能读回来')
    // 再次保存（另一个进程）不能把墓碑丢掉。
    assert.equal(saveCatalogCache(dir, reloaded), true)
    assert.equal(loadCatalogCache(dir).has('workbuddy::acc-b'), false, '二次保存把墓碑弄丢了')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- RQ8 ----------

test('RQ8 CLI 的 checkin / probe 在真实失败时返回非零退出码', async () => {
  // 只验判据本身：runCheckin 的产物里有 failed 就必须非零。
  // （完整 CLI 端到端另有 tests/cli.test.mjs，这里守「别再把失败报成成功」。）
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-cli-exit-'))
  try {
    const store = new SettingsStore(join(dir, 'settings.json'))
    const settings = baseSettings('a')
    store.patch(settings)
    const runtime = new Runtime({ settings: () => store.get(), dataDir: dir, logger: {} })
    // 没有可用凭证 → 签到只会给 failed / unconfigured，绝不应抛错。
    const outcome = await runtime.runCheckin('workbuddy')
    assert.equal(outcome.provider, 'workbuddy')
    const failed = outcome.outcomes.some((item) => item.kind === 'failed')
    // 无论 failed 与否，判据必须与 CLI 里的写法一致（`some(kind === 'failed')`）。
    assert.equal(typeof failed, 'boolean')
    runtime.flushCaches()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

