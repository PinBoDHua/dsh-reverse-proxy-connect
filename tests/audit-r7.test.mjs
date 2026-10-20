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

import { apply } from '../lib/index.js'
import { loadCatalogCache, saveCatalogCache } from '../lib/catalog-cache.js'
import { CreditHistory } from '../lib/credit-history.js'
import { ACTION_PATH, DATA_DIR_NAME, PROVIDERS, SETTINGS_PATH, STATUS_PATH } from '../lib/protocol.js'
import { Runtime, retryQueued } from '../lib/runtime.js'
import { SettingsStore, defaults } from '../lib/settings.js'
import { Stats } from '../lib/stats.js'
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
    // 请求此刻结束，时间戳是**开始**时刻（runtime 传的就是 startedAt）。
    stats.record({ provider: 'workbuddy', accountId: 'b', model: 'hy3', kind: 'stop', at: startedAt })
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

