import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { ACTION_PATH, DATA_DIR_NAME, DIAGNOSTICS_PATH, SETTINGS_PATH, STATUS_PATH } from '../lib/protocol.js'

/** 一个只记录路由的 webServer。 */
function fakeWebServer(handlers) {
  return {
    register(route) {
      handlers[route.path] = route.handler
      return () => {
        delete handlers[route.path]
      }
    },
  }
}

/** 收集响应的假 res。 */
function fakeResponse() {
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      res.status = status
      return res
    },
    end(chunk) {
      res.body = chunk === undefined ? '' : String(chunk)
      resolveDone()
    },
    done,
  }
  return res
}

/** 发一个 GET。 */
async function get(handler, url) {
  const res = fakeResponse()
  handler({ method: 'GET', url, headers: { host: '127.0.0.1:65466' } }, res)
  await res.done
  return { status: res.status, body: JSON.parse(res.body) }
}

/** 发一个 POST（带控制密钥）。 */
async function post(handler, url, key, payload) {
  const res = fakeResponse()
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = url
  req.headers = { host: '127.0.0.1:65466', 'x-rpc-key': key }
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
  })
  handler(req, res)
  await res.done
  return { status: res.status, body: JSON.parse(res.body) }
}

test('宿主入口：注册四个 provider，status v6 与诊断接口可用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-host-'))
  const dataDir = join(root, DATA_DIR_NAME)
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
    version: 2,
    providers: {
      workbuddy: { enabled: false },
      'workbuddy-ai': { enabled: false },
      qoder: { enabled: false },
      'qoder-global': { enabled: false },
    },
  }))

  const handlers = {}
  const disposers = []
  let registeredAdapter
  const attachments = {
    async readImageRequest() {
      return { mediaType: 'image/png', data: Buffer.from('png'), bytes: 3, width: 1, height: 1 }
    },
    imageHostPath() {
      return undefined
    },
  }
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { dir: root }
      return undefined
    },
    inject(names, callback) {
      for (const name of names) {
        if (name === 'webServer') {
          callback({
            webServer: fakeWebServer(handlers),
            effect(fn) {
              const dispose = fn()
              disposers.push(dispose)
              return dispose
            },
          })
        }
        if (name === 'attachments') {
          callback({
            get(service) {
              if (service === 'attachments') return attachments
              return undefined
            },
            attachments,
          })
        }
      }
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    llm: {
      registerAdapter(ids, adapter) {
        assert.deepEqual(ids, ['workbuddy', 'workbuddy-ai', 'qoder', 'qoder-global'])
        registeredAdapter = adapter
        return () => {}
      },
    },
    emit() {},
    logger: { info() {}, warn() {} },
  }

  apply(ctx, {})
  try {
    // 首轮刷新是后台跑的；等它落定再断言。
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(typeof handlers[STATUS_PATH], 'function')
    assert.equal(typeof handlers[SETTINGS_PATH], 'function')
    assert.equal(typeof handlers[ACTION_PATH], 'function')
    assert.equal(typeof handlers[DIAGNOSTICS_PATH], 'function')

    const full = await get(handlers[STATUS_PATH], STATUS_PATH)
    assert.equal(full.status, 200)
    assert.equal(full.body.version, 6)
    assert.equal(full.body.plugin.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
    assert.equal(full.body.providers.length, 4)
    assert.equal(full.body.host.images, true, '注入了附件服务后应声明图片可用')
    // 适配器门面必须把 canAcceptImages 透给 runtime；漏掉时模型会永远只声明
    // text 模态，宿主在附件准入阶段就会拒绝图片。
    assert.equal(typeof registeredAdapter.runtime.canAcceptImages, 'function')
    assert.equal(registeredAdapter.runtime.canAcceptImages(), true)
    assert.equal(full.body.providers[0].credential.status, 'disabled')
    assert.equal(full.body.settings.advanced.idleTimeoutMs, 180_000)
    assert.equal(full.body.settings.alerts.enabled, true)
    assert.equal(full.body.settings.alerts.lowRatio, 0.15)
    assert.match(full.body.key, /^[0-9a-f]{48}$/)
    assert.equal(full.body.providers[0].credits.trend.spentToday, 0)

    // Host 头可以伪造；socket 对端不是回环时必须拒绝，且不返回控制密钥。
    const remoteRes = fakeResponse()
    handlers[STATUS_PATH]({
      method: 'GET',
      url: STATUS_PATH,
      headers: { host: '127.0.0.1:65466' },
      socket: { remoteAddress: '203.0.113.7' },
    }, remoteRes)
    await remoteRes.done
    assert.equal(remoteRes.status, 403)
    assert.ok(!remoteRes.body.includes(full.body.key))

    const light = await get(handlers[STATUS_PATH], `${STATUS_PATH}?light=1`)
    assert.equal(light.status, 200)
    assert.equal(light.body.providers[0].models, undefined, '轻量状态不带模型清单')
    assert.equal(light.body.providers[0].usage.today.requests, 0)
    assert.ok(Array.isArray(light.body.stats.daily), '轻量状态带最近 14 天用量')

    const diagnostics = await get(handlers[DIAGNOSTICS_PATH], DIAGNOSTICS_PATH)
    assert.equal(diagnostics.status, 200)
    assert.equal(diagnostics.body.plugin.version, full.body.plugin.version)
    assert.equal(diagnostics.body.key, undefined)
    assert.equal(diagnostics.body.providers.length, 4)
    assert.ok(!JSON.stringify(diagnostics.body).includes(full.body.key), '诊断里不能带控制密钥')

    const reset = await post(handlers[ACTION_PATH], ACTION_PATH, full.body.key, { action: 'stats-reset' })
    assert.equal(reset.status, 200)
    assert.equal(reset.body.version, 6)

    // 账号测试在没有模型时给出明确错误，而不是伪造成功。
    const tested = await post(handlers[ACTION_PATH], ACTION_PATH, full.body.key, {
      action: 'test-account',
      provider: 'workbuddy',
      accountId: 'default',
    })
    assert.equal(tested.status, 200)
    assert.equal(tested.body.test.ok, false)
    assert.equal(tested.body.test.code, 'NO_MODEL')

    const cooled = await post(handlers[ACTION_PATH], ACTION_PATH, full.body.key, {
      action: 'reset-account',
      provider: 'workbuddy',
      accountId: 'default',
    })
    assert.equal(cooled.status, 200)
    assert.equal(cooled.body.providers[0].accounts[0].cooldownUntil, 0)

    const patched = await post(handlers[SETTINGS_PATH], SETTINGS_PATH, full.body.key, {
      advanced: { idleTimeoutMs: 60_000, stats: false },
      unknown: 'ignored',
    })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.settings.advanced.idleTimeoutMs, 60_000)
    assert.equal(patched.body.settings.advanced.stats, false)
    const saved = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
    assert.equal(saved.version, 2)
    assert.equal(saved.advanced.idleTimeoutMs, 60_000)

    // 错误的控制密钥必须被拒。
    const denied = await post(handlers[ACTION_PATH], ACTION_PATH, 'nope', { action: 'stats-reset' })
    assert.equal(denied.status, 403)
  } finally {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 忽略清理失败 */
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('手动「检测账号可用模型」不会被正在跑的后台探测静默吞掉', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-probe-'))
  const dataDir = join(root, DATA_DIR_NAME)
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
    version: 2,
    providers: {
      workbuddy: { enabled: true },
      'workbuddy-ai': { enabled: false },
      qoder: { enabled: false },
      'qoder-global': { enabled: false },
    },
    accounts: {
      workbuddy: [{
        id: 'a',
        label: 'A',
        enabled: true,
        token: {
          accessToken: 'tok', refreshToken: '', expiresAtMs: Date.now() + 3600_000,
          refreshExpiresAtMs: 0, domain: 'codebuddy.cn', uid: 'u', enterpriseId: '',
        },
      }],
    },
    activeAccount: { workbuddy: 'a' },
    probe: { enabled: true, lastRunAt: 0, results: {} },
  }))

  const handlers = {}
  const disposers = []
  const originalFetch = globalThis.fetch
  let chatRequests = 0
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })

  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.includes('/v3/config')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { agents: [{ name: 'cli', models: ['auto'] }], models: [{ id: 'auto', maxInputTokens: 8000, maxOutputTokens: 1000 }] },
      }), { status: 200 })
    }
    if (text.includes('/meter/get-user-resource')) {
      return new Response(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }), { status: 200 })
    }
    if (text.includes('/chat/completions')) {
      chatRequests += 1
      if (chatRequests === 1) await firstGate
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(body, { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }

  const ctx = {
    get(name) {
      if (name === 'profileContext') return { dir: root }
      return undefined
    },
    inject(names, callback) {
      if (names.includes('webServer')) {
        callback({
          webServer: fakeWebServer(handlers),
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
    llm: { registerAdapter: () => () => {} },
    emit() {},
    logger: { info() {}, warn() {} },
  }

  try {
    apply(ctx, {})
    // 等后台那轮探测真的发出请求（并被 gate 卡住）。
    for (let index = 0; index < 100 && chatRequests === 0; index++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(chatRequests, 1, '后台探测应当已经发出一个请求')

    const full = await get(handlers[STATUS_PATH], STATUS_PATH)
    const actionRes = fakeResponse()
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = ACTION_PATH
    req.headers = { host: '127.0.0.1:65466', 'x-rpc-key': full.body.key }
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify({ action: 'probe' })))
      req.emit('end')
    })
    handlers[ACTION_PATH](req, actionRes)

    // 手动请求此刻应当还在等后台那一轮，而不是立刻返回。
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(actionRes.status, 0, '手动探测不能在前一轮还没结束时提前返回')

    releaseFirst()
    await actionRes.done
    assert.equal(actionRes.status, 200)
    // 放行后必须补跑一轮：总请求数应当 ≥ 2。
    for (let index = 0; index < 100 && chatRequests < 2; index++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(chatRequests >= 2, `手动探测应当补跑一轮，实际只发了 ${String(chatRequests)} 个请求`)
  } finally {
    globalThis.fetch = originalFetch
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 忽略清理失败 */
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
})

