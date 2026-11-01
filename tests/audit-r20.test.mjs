/**
 * 第 20 轮审计的回归用例。
 *
 * 每条都对应一个可复现的缺陷（修前 FAIL / 修后 PASS）：
 * - 事件账本被另一个进程清空后，本进程的**读视图**要立刻对齐，而不是等到落盘；
 * - 去重签名必须包含账号：两个账号同一个错误不能被压成一条；
 * - 申请登录地址撞上瞬时故障要重试，确定性 4xx 仍然一次失败；
 * - 额度缓存落盘时按「时效 + 条目上限」淘汰，不能越写越多；
 * - `login-start` / `login-cancel` 收到未知 provider 时回 400，而不是假装成功。
 *
 * @module dsh-reverse-proxy-connect/tests/audit-r20
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadCreditsCache, saveCreditsCache } from '../lib/credits-cache.js'
import { EventLog, eventsPathOf } from '../lib/events.js'
import { apply } from '../lib/index.js'
import { ACTION_PATH, DATA_DIR_NAME, STATUS_PATH } from '../lib/protocol.js'
import { requestAuthState } from '../lib/workbuddy/browser-login.js'

/** 临时目录。 */
function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `dsh-r20-${tag}-`))
}

/** 等一小会儿：让下一次写盘的 mtime / size 与上一次确实不同。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('事件账本：另一个进程清空后，本进程的读视图立刻为空（不必等下一次落盘）', async () => {
  const dir = tempDir('events-read')
  const file = eventsPathOf(dir)
  let clock = 1000
  const now = () => clock
  try {
    const writer = new EventLog({ filePath: file, now, persistDelayMs: 60_000 })
    clock = 1500
    writer.record({ type: 'startup', message: '清空前的事件' })
    assert.equal(writer.flush(), true)

    // 第二个进程：启动时读到那条事件，之后一直没落盘。
    const reader = new EventLog({ filePath: file, now, persistDelayMs: 60_000 })
    assert.equal(reader.list().length, 1, '冷启动应读到磁盘上已有的事件')

    await sleep(20)
    clock = 2000
    const clearer = new EventLog({ filePath: file, now, persistDelayMs: 60_000 })
    assert.equal(clearer.clear(), true)

    // 关键：reader 一次 flush 都没做，读视图也必须立刻反映外部清空。
    assert.equal(reader.list().length, 0, '读视图仍显示已被另一个进程清空的事件')
    assert.equal(reader.summary().count, 0, '摘要里的 count 也必须归零')

    // 清空之后的新事件照常记录，旧事件不会被带回来。
    clock = 3000
    reader.record({ type: 'startup', message: '清空后的事件' })
    assert.deepEqual(reader.list().map((event) => event.message), ['清空后的事件'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('事件账本：去重签名包含账号，两个账号的同一错误不能被压成一条', () => {
  let clock = 1000
  const now = () => clock
  const log = new EventLog({ now, persistDelayMs: 60_000 })
  clock = 1000
  assert.equal(log.record({ type: 'upstream', provider: 'qoder', accountId: 'acc-a', message: 'HTTP 503' }, { dedupeMs: 3_600_000 }) !== false, true)
  clock = 1500
  assert.equal(log.record({ type: 'upstream', provider: 'qoder', accountId: 'acc-b', message: 'HTTP 503' }, { dedupeMs: 3_600_000 }) !== false, true)
  assert.equal(log.list().length, 2, '另一个账号的同款失败被当成重复吞掉了')

  // 同一个账号、同一条消息在时间窗内仍然只留一条。
  clock = 2000
  assert.equal(log.record({ type: 'upstream', provider: 'qoder', accountId: 'acc-a', message: 'HTTP 503' }, { dedupeMs: 3_600_000 }), false)
  assert.equal(log.list().length, 2)
})

test('浏览器登录：申请登录地址遇到瞬时故障会重试，确定性 4xx 仍然一次失败', async () => {
  const originalFetch = globalThis.fetch
  try {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      if (calls === 1) return { ok: false, status: 503, text: async () => '{"code":500}' }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { state: 'state-1', authUrl: 'https://example.com/login?state=state-1' } }),
      }
    }
    const state = await requestAuthState('workbuddy', undefined, { attempts: 3, retryDelayMs: 5 })
    assert.equal(state.state, 'state-1')
    assert.equal(calls, 2, '503 是瞬时故障，应当重试到成功')

    calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return { ok: false, status: 400, text: async () => '{"code":400,"msg":"bad request"}' }
    }
    await assert.rejects(
      () => requestAuthState('workbuddy', undefined, { attempts: 3, retryDelayMs: 5 }),
      /HTTP 400/,
    )
    assert.equal(calls, 1, '确定性 4xx 重试没有意义')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('额度缓存：落盘时淘汰过期条目并限制条目数，与读取视图同一口径', () => {
  const dir = tempDir('credits-prune')
  try {
    const now = Date.now()
    const entries = new Map()
    for (let index = 0; index < 30; index++) {
      entries.set(`qoder::acc-${String(index)}`, {
        data: { state: 'ok', remain: index, total: 100, unit: 'credits' },
        fetchedAt: now - index * 1000,
      })
    }
    entries.set('qoder::expired', {
      data: { state: 'ok', remain: 1, total: 2, unit: 'credits' },
      fetchedAt: now - 8 * 24 * 3600_000,
    })
    assert.equal(saveCreditsCache(dir, entries), true)
    const loaded = loadCreditsCache(dir)
    assert.equal(loaded.size, 24, '超过上限的条目应当按新旧淘汰')
    assert.equal(loaded.has('qoder::expired'), false, '超过时效的条目不应继续留在文件里')
    assert.equal(loaded.has('qoder::acc-0'), true, '最新的条目必须保留')
    assert.equal(loaded.has('qoder::acc-23'), true)
    assert.equal(loaded.has('qoder::acc-24'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
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

test('动作接口：login-start / login-cancel 拒绝未知 provider（400），不再假装成功', async () => {
  const root = tempDir('login-provider')
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
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '{"code":503}' })
  const host = fakeHost(root)
  try {
    apply(host.ctx, {})
    await sleep(60)
    const status = await hostGet(host.handlers[STATUS_PATH], STATUS_PATH)
    assert.equal(status.status, 200)
    const key = status.body.key

    const started = await hostPost(host.handlers[ACTION_PATH], ACTION_PATH, { action: 'login-start', provider: 'workbudd' }, key)
    assert.equal(started.status, 400)
    assert.equal(started.body.error, 'invalid-provider')

    const cancelled = await hostPost(host.handlers[ACTION_PATH], ACTION_PATH, { action: 'login-cancel' }, key)
    assert.equal(cancelled.status, 400)
    assert.equal(cancelled.body.error, 'invalid-provider')
  } finally {
    globalThis.fetch = originalFetch
    for (const dispose of host.disposers.reverse()) {
      try { dispose() } catch { /* 已停止 */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
})
