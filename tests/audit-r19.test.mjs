/**
 * 第 19 轮审计的回归用例。
 *
 * 每条都对应一个可复现的缺陷（修前 FAIL / 修后 PASS）：
 * - WorkBuddy 浏览器登录：扫码期间撞上 5xx / 429 不再立刻失败；
 * - `/status` 的 Qoder「已配置」认可环境变量 PAT；
 * - 事件账本被另一个进程清空后，旧进程落盘不能把旧事件复活；
 * - 运行期删掉 stats.json 视为外部重置，旧计数不能被写回；
 * - 凭证探测遇到网络错误时给出可重试的 upstream-error，而不是「登录文件坏了」；
 * - Trae 账号里已有续期令牌时，即使 storage.json 被搬走也能显示已登录。
 *
 * @module dsh-reverse-proxy-connect/tests/audit-r19
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EventLog, eventsPathOf } from '../lib/events.js'
import { apply } from '../lib/index.js'
import { DATA_DIR_NAME, REASON, STATUS_PATH } from '../lib/protocol.js'
import { Runtime } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'
import { Stats } from '../lib/stats.js'
import { pollAuthToken, pollLoginAccount } from '../lib/workbuddy/browser-login.js'

/** 临时目录。 */
function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `dsh-r19-${tag}-`))
}

/** 只有 qoder 启用的设置。 */
function qoderOnly() {
  const settings = defaults()
  for (const id of Object.keys(settings.providers)) settings.providers[id].enabled = id === 'qoder'
  return settings
}

test('浏览器登录：token 轮询遇到 5xx / 429 会继续等，而不是立刻把登录判死', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  const responses = [
    { status: 503, body: { code: 500 } },
    { status: 429, body: { code: 429 } },
    { status: 502, body: { code: 502 } },
    { status: 200, body: { code: 0, data: { accessToken: 'tok', refreshToken: 'r' } } },
  ]
  globalThis.fetch = async () => {
    const item = responses[Math.min(calls, responses.length - 1)]
    calls += 1
    return { ok: item.status === 200, status: item.status, text: async () => JSON.stringify(item.body) }
  }
  try {
    const token = await pollAuthToken('workbuddy', 'state-1', { pollMs: 5, timeoutMs: 3000 })
    assert.equal(token.accessToken, 'tok')
    assert.equal(calls, 4, '三次瞬时失败后应当继续轮询到成功')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('浏览器登录：账号信息轮询遇到 500 也会重试（令牌已经拿到，不该在最后一步失败）', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) return { ok: false, status: 500, text: async () => '{"code":500}' }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { uid: 'uid-1', nickname: '小号' } }),
    }
  }
  try {
    const account = await pollLoginAccount('workbuddy', 'state-1', { accessToken: 'jwt', domain: '' }, { pollMs: 5, timeoutMs: 3000 })
    assert.equal(account.uid, 'uid-1')
    assert.equal(account.nickname, '小号')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('浏览器登录：非瞬时的 4xx 仍然立刻失败，不把真正的错误吞掉', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: false, status: 400, text: async () => '{"code":400,"msg":"bad state"}' }
  }
  try {
    await assert.rejects(() => pollAuthToken('workbuddy', 'state-x', { pollMs: 5, timeoutMs: 1000 }), /HTTP 400/)
    assert.equal(calls, 1, '400 是确定性失败，重试没有意义')
  } finally {
    globalThis.fetch = originalFetch
  }
})

/** 收集路由与 disposer 的最小宿主。 */
function fakeHost(root) {
  const handlers = {}
  const disposers = []
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { dir: root }
      return undefined
    },
    inject(names, callback) {
      if (names.includes('webServer')) {
        callback({
          webServer: {
            register(route) {
              handlers[route.path] = route.handler
              return () => { delete handlers[route.path] }
            },
          },
          effect(fn) {
            const dispose = fn()
            disposers.push(dispose)
            return dispose
          },
        })
      }
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    llm: { registerAdapter() { return () => {} } },
    emit() {},
    logger: { info() {}, warn() {} },
  }
  return { handlers, disposers, ctx }
}

/** 发一个带控制密钥的 GET。 */
async function hostGet(handler, url) {
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const res = {
    status: 0,
    body: '',
    writeHead(status) { res.status = status; return res },
    end(chunk) { res.body = chunk === undefined ? '' : String(chunk); resolveDone() },
  }
  handler({
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:65466' },
    socket: { remoteAddress: '127.0.0.1' },
  }, res)
  await done
  return { status: res.status, body: JSON.parse(res.body) }
}

test('环境变量 PAT：账号行能用时，/status 的连接区也必须说「已配置」', async () => {
  const root = tempDir('env-pat')
  const dataDir = join(root, DATA_DIR_NAME)
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
    version: 2,
    providers: {
      workbuddy: { enabled: false },
      'workbuddy-ai': { enabled: false },
      qoder: { enabled: true },
      'qoder-global': { enabled: false },
      trae: { enabled: false },
      'trae-global': { enabled: false },
    },
  }))
  const previous = process.env.QODER_CN_PERSONAL_ACCESS_TOKEN
  process.env.QODER_CN_PERSONAL_ACCESS_TOKEN = 'pt-env-only'
  const originalFetch = globalThis.fetch
  // 凭证探测会交换 job token / 读 userinfo；目录请求失败没关系。
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/jobToken/exchange')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ token: 'job', expires_at: new Date(Date.now() + 3600_000).toISOString() }) }
    }
    if (href.includes('/userinfo')) {
      return { ok: true, status: 200, json: async () => ({ id: 'u-env', name: 'Env', email: 'env@x' }) }
    }
    return { ok: false, status: 500, text: async () => '{"code":500}' }
  }
  const host = fakeHost(root)
  try {
    apply(host.ctx, {})
    await new Promise((resolve) => setTimeout(resolve, 60))
    const full = await hostGet(host.handlers[STATUS_PATH], STATUS_PATH)
    assert.equal(full.status, 200)
    assert.equal(full.body.settings.qoder.qoder.configured, true, '环境变量 PAT 也是「已配置」')
    const qoder = full.body.providers.find((entry) => entry.provider === 'qoder')
    assert.equal(qoder.credential.status, 'signed-in', '账号探测确实是用环境变量里的令牌成功的')
  } finally {
    globalThis.fetch = originalFetch
    if (previous === undefined) delete process.env.QODER_CN_PERSONAL_ACCESS_TOKEN
    else process.env.QODER_CN_PERSONAL_ACCESS_TOKEN = previous
    for (const dispose of host.disposers.reverse()) {
      try { dispose() } catch { /* 已停止 */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('事件账本：另一个进程清空后，旧进程落盘不能把旧事件写回来', () => {
  const dir = tempDir('events-clear')
  const file = eventsPathOf(dir)
  let clock = 1000
  const now = () => clock
  try {
    const older = new EventLog({ filePath: file, now, persistDelayMs: 60_000 })
    older.record({ type: 'startup', message: '清空前的事件' })
    clock = 1500
    assert.equal(older.flush(), true)
    assert.equal(existsSync(file), true)

    const clearer = new EventLog({ filePath: file, now, persistDelayMs: 60_000 })
    clock = 2000
    assert.equal(clearer.clear(), true, '清空应成功')
    assert.equal(clearer.list().length, 0)

    // 旧进程还在跑：它内存里仍有清空前的事件；清空之后它又记了一条新事件。
    clock = 3000
    older.record({ type: 'startup', message: '清空后的事件' })
    assert.equal(older.flush(), true, '旧进程落盘应成功')

    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const messages = raw.events.map((event) => event.message)
    assert.deepEqual(messages, ['清空后的事件'], `旧事件被写回来了：${JSON.stringify(messages)}`)
    assert.equal(raw.clearedAt, 2000, '清空时刻要随文件落盘，供其它进程采纳')

    const reloaded = new EventLog({ filePath: file, now })
    assert.deepEqual(reloaded.list().map((event) => event.message), ['清空后的事件'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计：运行期删除 stats.json 视为外部重置，不能把旧计数写回去', () => {
  const dir = tempDir('stats-deleted')
  const file = join(dir, 'stats.json')
  try {
    const stats = new Stats({ filePath: file, persistDelayMs: 60_000 })
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', usage: { inputTokens: 42 } })
    assert.equal(stats.flush(), true)
    assert.equal(existsSync(file), true)
    assert.equal(stats.snapshot().totals.requests, 1)

    rmSync(file, { force: true })
    assert.equal(stats.flush(), true)
    assert.equal(existsSync(file), false, '删除后旧进程不能把文件又建回来')
    assert.equal(stats.snapshot().totals.requests, 0, '内存也必须跟着归零')

    // 重置之后的新请求照常累积（写一份新的空文档）。
    stats.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop' })
    assert.equal(stats.flush(), true)
    assert.equal(stats.snapshot().totals.requests, 1)
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('凭证探测：网络错误是可重试的 upstream-error，不是「登录文件坏了」', async () => {
  const dir = tempDir('probe-network')
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    const failure = new TypeError('fetch failed')
    failure.cause = { code: 'ENOTFOUND' }
    throw failure
  }
  const settings = qoderOnly()
  settings.qoder.qoder.pat = 'pt-x'
  const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
  const account = { id: 'default', label: '默认令牌', enabled: true, pat: 'pt-x' }
  try {
    const first = await runtime.describeCredential('qoder', account, settings)
    assert.equal(first.status, 'signed-out')
    assert.equal(first.reason, REASON.upstreamError, `网络错误不能说成登录文件损坏：${String(first.reason)}`)
    const second = await runtime.describeCredential('qoder', account, settings)
    assert.equal(second.status, 'signed-out')
    assert.ok(calls >= 2, '瞬时失败不能进 60 秒失败缓存')
  } finally {
    globalThis.fetch = originalFetch
    runtime.flushCaches()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Trae：账号里有续期过的令牌时，storage.json 不在也能显示已登录', async () => {
  const dir = tempDir('trae-stored')
  const settings = defaults()
  const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
  const token = {
    accessToken: 'stored-jwt',
    refreshToken: 'rt',
    expiresAtMs: Date.now() + 86_400_000,
    refreshExpiresAtMs: 0,
    domain: '',
    uid: 'u-trae',
    enterpriseId: '',
  }
  const account = {
    id: 'default',
    label: '本机登录',
    enabled: true,
    authFile: join(dir, 'definitely-missing-storage.json'),
    token,
  }
  try {
    const status = await runtime.describeCredential('trae', account, settings)
    assert.equal(status.status, 'signed-in', '请求路径能用账号令牌，探测也必须说已登录')
    assert.equal(status.source, 'stored')
    assert.equal(status.userId, 'u-trae')
  } finally {
    runtime.flushCaches()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Trae：令牌已过期且没有 refreshToken 时，缺失的登录文件仍然如实报「未配置」', async () => {
  const dir = tempDir('trae-expired')
  const settings = defaults()
  const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
  const account = {
    id: 'default',
    label: '本机登录',
    enabled: true,
    authFile: join(dir, 'definitely-missing-storage.json'),
    token: {
      accessToken: 'expired-jwt',
      refreshToken: '',
      expiresAtMs: Date.now() - 86_400_000,
      refreshExpiresAtMs: 0,
      domain: '',
      uid: 'u-trae',
      enterpriseId: '',
    },
  }
  try {
    const status = await runtime.describeCredential('trae', account, settings)
    assert.equal(status.status, 'signed-out')
    assert.equal(status.reason, REASON.noCredential)
  } finally {
    runtime.flushCaches()
    rmSync(dir, { recursive: true, force: true })
  }
})
