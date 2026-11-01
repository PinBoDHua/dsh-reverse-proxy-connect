/**
 * 第 21 轮审计的回归用例。
 *
 * 每条都对应一个可复现的缺陷（修前 FAIL / 修后 PASS）：
 * - Trae 续期把 429 / 5xx 说成「登录失效」（换号 + AUTH 冷却 + 60 秒缓存）；
 * - 两个请求共享一次凭证续期，一方取消会拖死另一方；
 * - Trae 额度响应缺字段被伪装成「Free / 0 积分」，而不是读取失败；
 * - 登录任务结束后永久驻留，`/status` 一直带着过期的 authUrl；
 * - 未知 provider 的删除行能写进统计 / 额度历史 / 目录缓存三份墓碑。
 *
 * @module dsh-reverse-proxy-connect/tests/audit-r21
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { DATA_DIR_NAME, PROVIDERS, SETTINGS_PATH, STATUS_PATH } from '../lib/protocol.js'
import { failureCodeOf, Runtime } from '../lib/runtime.js'
import { exchangeRefreshToken } from '../lib/trae/credential.js'
import { parseCredits } from '../lib/trae/transport.js'

/** 临时目录。 */
function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `dsh-r21-${tag}-`))
}

/** 等一小会儿。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('Trae 续期：只有 401/403 才是登录失效，429 / 5xx 是瞬时故障', async () => {
  const originalFetch = globalThis.fetch
  const respond = (status, body) => {
    globalThis.fetch = async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })
    return exchangeRefreshToken('trae', 'refresh-token', 'u1', undefined).then(
      (value) => value,
      (error) => error,
    )
  }
  try {
    const rejected = await respond(401, '{"ResponseMetadata":{"Error":{"Code":"InvalidRefreshToken"}}}')
    assert.equal(rejected.code, 'credential-expired', '401 应当判成登录失效')
    assert.equal(failureCodeOf(rejected), 'AUTH')

    const throttled = await respond(429, '{}')
    assert.equal(throttled.code, 'soft-rate', '429 是限流，不能要求用户重新登录')
    assert.equal(failureCodeOf(throttled), 'RATE_LIMIT')

    const unavailable = await respond(503, '')
    assert.equal(unavailable.code, 'upstream-error', '5xx 是上游暂时不可用')
    assert.equal(failureCodeOf(unavailable), 'SERVER')
    assert.match(unavailable.message, /不是登录失效/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('共享凭证续期：一个调用方取消，另一个仍能拿到新令牌', async () => {
  const dir = tempDir('shared-refresh')
  const now = Date.now()
  const settings = {
    accounts: {
      [PROVIDERS.workbuddy]: [{
        id: 'acc-1',
        label: 'A',
        enabled: true,
        token: { accessToken: 'old', refreshToken: 'rt', expiresAtMs: now - 5_000, refreshExpiresAtMs: now + 86_400_000 },
      }],
    },
    workbuddy: {},
    advanced: { catalogCache: false },
  }
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      if (!String(url).includes('/v2/plugin/auth/token/refresh')) throw new Error(`unexpected url ${String(url)}`)
      // 共享任务本身不绑任何调用方的 signal：这里故意不监听 abort。
      await sleep(40)
      return new Response(JSON.stringify({ data: { accessToken: 'new-token', refreshToken: 'rt-2', expiresIn: 7200 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    const account = settings.accounts[PROVIDERS.workbuddy][0]
    const abortFirst = new AbortController()
    const first = runtime.credentialForAccount(PROVIDERS.workbuddy, account, settings, abortFirst.signal)
    const second = runtime.credentialForAccount(PROVIDERS.workbuddy, account, settings, undefined)
    first.catch(() => undefined)
    setTimeout(() => abortFirst.abort(), 10)

    const [settledFirst, settledSecond] = await Promise.allSettled([first, second])
    assert.equal(settledFirst.status, 'rejected')
    assert.equal(failureCodeOf(settledFirst.reason), 'ABORTED', '取消方应当是「已取消」，不是「凭证失效」')
    assert.equal(settledSecond.status, 'fulfilled', '没取消的那一方被共享任务的取消拖死了')
    assert.equal(settledSecond.value.accessToken, 'new-token')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Trae 额度：响应缺字段是读取失败，不再伪装成 Free 0', () => {
  for (const body of [
    {},
    { usage_summary: null },
    { usage_summary: { other: 1 } },
    { code: 401, data: {} },
    { code: 0, data: { usage_summary: { total_amount: 100 } } },
  ]) {
    const credits = parseCredits(body)
    assert.equal(credits.state, 'error', `形状不对的响应被当成可读额度：${JSON.stringify(body)}`)
    assert.match(credits.message, /格式异常/)
  }
  // 合法响应不变：总额 0 仍然是「免费套餐」，不是错误。
  const free = parseCredits({ usage_summary: { consumed_amount: 0, total_amount: 0 } })
  assert.equal(free.state, 'ok')
  assert.equal(free.freePlan, true)
  const paid = parseCredits({ usage_summary: { consumed_amount: 10, total_amount: 100 } })
  assert.equal(paid.state, 'ok')
  assert.equal(paid.remain, 90)
})

test('登录任务：终态只保留一小段时间，进行中的任务始终可见', async () => {
  // 动态导入：0.7.9 快照里没有这个导出，用静态导入会让整份用例文件在修前
  // 直接加载失败，无法逐条证明其它四条的行为缺陷。
  const { loginJobExpired } = await import('../lib/index.js')
  const now = Date.now()
  assert.equal(loginJobExpired({ phase: 'waiting', startedAt: now - 60_000 }, now), false)
  assert.equal(loginJobExpired({ phase: 'done', startedAt: now - 60_000, finishedAt: now - 60_000 }, now), false)
  assert.equal(loginJobExpired({ phase: 'done', startedAt: now - 60 * 60_000, finishedAt: now - 60 * 60_000 }, now), true)
  assert.equal(loginJobExpired({ phase: 'failed', startedAt: now - 10 * 60_000, finishedAt: now - 10 * 60_000 }, now), true)
  assert.equal(loginJobExpired({ phase: 'done' }, now), false, '缺时间戳时宁可留着，也不凭猜测删除')
  assert.equal(loginJobExpired(undefined, now), true)
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

/** 发一个带控制密钥与 JSON 体的 POST。 */
async function hostPost(handler, url, body, key) {
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const res = {
    status: 0,
    body: '',
    writeHead(status) { res.status = status; return res },
    setHeader() {},
    end(chunk) { res.body = chunk === undefined ? '' : String(chunk); resolveDone() },
  }
  const req = new EventEmitter()
  Object.assign(req, {
    method: 'POST',
    url,
    headers: {
      host: '127.0.0.1:65466',
      'x-rpc-key': key,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(JSON.stringify(body))),
    },
    socket: { remoteAddress: '127.0.0.1' },
  })
  handler(req, res)
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  await done
  return { status: res.status, body: JSON.parse(res.body) }
}

test('设置接口：未知 provider 的删除行不再写进墓碑文件', async () => {
  const root = tempDir('settings-tombstone')
  const dataDir = join(root, DATA_DIR_NAME)
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
    version: 2,
    providers: {
      workbuddy: { enabled: false },
      'workbuddy-ai': { enabled: false },
      qoder: { enabled: false },
      'qoder-global': { enabled: false },
      trae: { enabled: false },
      'trae-global': { enabled: false },
    },
  }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '{}' })
  const host = fakeHost(root)
  try {
    apply(host.ctx, {})
    await sleep(60)
    const status = await hostGet(host.handlers[STATUS_PATH], STATUS_PATH)
    assert.equal(status.status, 200)
    const key = status.body.key

    const response = await hostPost(host.handlers[SETTINGS_PATH], SETTINGS_PATH, {
      accounts: { evil: [{ id: 'x', forget: true }] },
      removedAccounts: { evil: ['y'] },
    }, key)
    assert.equal(response.status, 200, '未知 provider 与未知字段一样被忽略，不该整次失败')

    // 墓碑必须只来自已知 provider：任意字符串都不能落进三份持久化文件。
    for (const name of readdirSync(dataDir)) {
      if (!name.endsWith('.json') || name === 'settings.json') continue
      const raw = readFileSync(join(dataDir, name), 'utf8')
      assert.equal(raw.includes('evil::x'), false, `${name} 里出现了未知账号的墓碑`)
      assert.equal(raw.includes('evil::y'), false, `${name} 里出现了未知账号的墓碑`)
    }
  } finally {
    globalThis.fetch = originalFetch
    for (const dispose of host.disposers.reverse()) {
      try { dispose() } catch { /* 已停止 */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
})
