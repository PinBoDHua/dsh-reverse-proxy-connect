import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, thinTrend } from '../lib/index.js'
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
  handler({ method: 'GET', url, headers: { host: '127.0.0.1:65466' }, socket: { remoteAddress: '127.0.0.1' } }, res)
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
  req.socket = { remoteAddress: '127.0.0.1' }
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
  })
  handler(req, res)
  await res.done
  return { status: res.status, body: JSON.parse(res.body) }
}

test('宿主入口：注册六个 provider，status v8 与诊断接口可用', async () => {
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
      trae: { enabled: false },
      'trae-global': { enabled: false },
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
        assert.deepEqual(ids, ['workbuddy', 'workbuddy-ai', 'qoder', 'qoder-global', 'trae', 'trae-global'])
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
    assert.equal(full.body.version, 8)
    assert.ok(full.body.events.count >= 1, '启动事件应已写入账本')
    assert.ok(Array.isArray(full.body.events.items), '完整状态带事件明细')
    assert.equal(typeof full.body.events.items[0].type, 'string')
    assert.equal(full.body.plugin.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
    assert.equal(full.body.providers.length, 6)
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
    assert.equal(light.body.events.items, undefined, '轻量状态只带事件摘要')
    assert.ok(typeof light.body.events.count === 'number')
    assert.equal(light.body.providers[0].usage.today.requests, 0)
    assert.ok(Array.isArray(light.body.stats.daily), '轻量状态带最近 14 天用量')
    // 侧栏小卡只读「当前账号」的 label；账号级额度/用量/冷却全由卡片使用。
    // 轻量状态里不能带这些字段（占整份响应三分之一以上），但完整状态必须保留。
    const lightAccount = light.body.providers[0].accounts[0]
    assert.equal(typeof lightAccount.label, 'string', '轻量账号仍要有 label')
    assert.equal(typeof lightAccount.active, 'boolean', '轻量账号仍要有 active')
    assert.equal(lightAccount.credits, undefined, '轻量状态不该带账号级额度')
    assert.equal(lightAccount.usage, undefined, '轻量状态不该带账号级用量')
    assert.equal(lightAccount.lastTest, undefined, '轻量状态不该带账号测试结果')
    const fullAccount = full.body.providers[0].accounts[0]
    assert.ok(fullAccount.credits !== undefined, '完整状态必须带账号级额度（卡片要用）')
    assert.ok('cooldownUntil' in fullAccount, '完整状态必须带冷却时间')

    // 轻量状态的趋势折线只留最后 20 个点（侧栏画 100×24 的迷你折线用不到更多）。
    // 这里直接验纯函数，避免为了造 60 个样本去写一份额度历史文件。
    const manyPoints = Array.from({ length: 60 }, (_, index) => ({ at: 1_700_000_000_000 + index * 60_000, remain: 100 - index }))
    const thinned = thinTrend({ points: manyPoints, sampleCount: 60, spentToday: 3 }, 20)
    assert.equal(thinned.points.length, 20)
    assert.equal(thinned.points.at(-1).remain, manyPoints.at(-1).remain, '保留的是最后一段，不是最前一段')
    assert.equal(thinned.sampleCount, 60, '其余字段原样保留')
    // 点数本来就少时原样返回（不要制造一个「总是新对象」的假变化）。
    const short = { points: manyPoints.slice(0, 5), sampleCount: 5 }
    assert.equal(thinTrend(short, 20), short)
    // 坏输入不炸。
    assert.equal(thinTrend(undefined, 20), undefined)
    assert.equal(thinTrend({ points: 'nope' }, 20)?.points, 'nope')
    assert.deepEqual(thinTrend({ points: manyPoints }, 0).points, [])

    const diagnostics = await get(handlers[DIAGNOSTICS_PATH], DIAGNOSTICS_PATH)
    assert.equal(diagnostics.status, 200)
    assert.equal(diagnostics.body.plugin.version, full.body.plugin.version)
    assert.equal(diagnostics.body.key, undefined)
    assert.equal(diagnostics.body.providers.length, 6)
    assert.ok(!JSON.stringify(diagnostics.body).includes(full.body.key), '诊断里不能带控制密钥')

    // 登录任务同时下发稳定文案键：英文界面不能直接渲染服务端中文。
    const traeLogin = await post(handlers[ACTION_PATH], ACTION_PATH, full.body.key, { action: 'login-start', provider: 'trae' })
    assert.equal(traeLogin.status, 200)
    assert.equal(traeLogin.body.login.phase, 'failed')
    assert.equal(traeLogin.body.login.messageKey.key, 'loginUnsupportedTrae')
    const qoderLogin = await post(handlers[ACTION_PATH], ACTION_PATH, full.body.key, { action: 'login-start', provider: 'qoder' })
    assert.equal(qoderLogin.body.login.messageKey.key, 'loginUnsupportedPat')

    const reset = await post(handlers[ACTION_PATH], ACTION_PATH, full.body.key, { action: 'stats-reset' })
    assert.equal(reset.status, 200)
    assert.equal(reset.body.version, 8)
    assert.ok(reset.body.events.items.some((event) => event.type === 'stats'), '重置统计要写进事件账本')

    const cleared = await post(handlers[ACTION_PATH], ACTION_PATH, full.body.key, { action: 'events-clear' })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.events.count, 1, '清空后只留「已清空」这一条')
    assert.equal(cleared.body.events.items[0].type, 'events')

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
    // 「解除」后不能立刻又显示上一次的测试失败，否则用户会以为按钮没生效。
    assert.equal(cooled.body.providers[0].accounts[0].lastTest, undefined, '解除冷却时同时清掉失败测试结论')

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
    req.socket = { remoteAddress: '127.0.0.1' }
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

test('手动「立即签到」不会被正在跑的自动签到静默跳过', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-checkin-race-'))
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
    checkin: { enabled: true, lastRunAt: 0, completedOn: {}, accountIds: {}, lastAttemptAt: {}, results: {} },
  }))

  const handlers = {}
  const disposers = []
  const originalFetch = globalThis.fetch
  let checkinRequests = 0
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })

  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.includes('/checkin-activity-status')) {
      checkinRequests += 1
      if (checkinRequests === 1) await firstGate
      return new Response(JSON.stringify({ code: 0, data: { active: false } }), { status: 200 })
    }
    if (text.includes('/v3/config')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { agents: [{ name: 'cli', models: ['auto'] }], models: [{ id: 'auto', maxInputTokens: 8000, maxOutputTokens: 1000 }] },
      }), { status: 200 })
    }
    if (text.includes('/meter/get-user-resource')) {
      return new Response(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }), { status: 200 })
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
    // 等自动那轮签到真的发出请求（并被 gate 卡住）。
    for (let index = 0; index < 150 && checkinRequests === 0; index++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(checkinRequests, 1, '自动签到应当已经发出一个请求')

    const full = await get(handlers[STATUS_PATH], STATUS_PATH)
    const actionRes = fakeResponse()
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = ACTION_PATH
    req.headers = { host: '127.0.0.1:65466', 'x-rpc-key': full.body.key }
    req.socket = { remoteAddress: '127.0.0.1' }
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify({ action: 'checkin', provider: 'workbuddy' })))
      req.emit('end')
    })
    handlers[ACTION_PATH](req, actionRes)

    // 手动请求此刻应当还在等自动那一轮，而不是立刻返回空结果。
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(actionRes.status, 0, '手动签到不能在前一轮还没结束时提前返回')

    releaseFirst()
    await actionRes.done
    assert.equal(actionRes.status, 200)
    // 放行后必须补跑一轮：总签到请求数应当 ≥ 2。
    for (let index = 0; index < 100 && checkinRequests < 2; index++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(checkinRequests >= 2, `手动签到应当补跑一轮，实际只发了 ${String(checkinRequests)} 个请求`)
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

test('额度定时刷新：到点必须真的请求，不能被「上一拍刚完成」的新鲜窗口跳过', async () => {
  // 真实缺陷：调度器把 lastCreditsAt 记成「发起这一拍」的时刻，而新鲜窗口按
  // 「上次请求完成」的时刻算。设 120 秒时第二拍会在 240 秒才真正请求（2 倍）。
  // 这里用假时钟 + 捕获的 tick 直接复现两拍。
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-credits-tick-'))
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
    accounts: {
      qoder: [{ id: 'default', label: '默认令牌', enabled: true, pat: 'pat-tick' }],
    },
    activeAccount: { qoder: 'default' },
    advanced: { creditsRefreshMs: 120_000, catalogRefreshMs: 86_400_000 },
  }))

  const handlers = {}
  const disposers = []
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  const originalSetInterval = globalThis.setInterval
  const T0 = originalNow()
  let fakeNow = T0
  let tick
  let quotaCalls = 0
  Date.now = () => fakeNow
  // 只捕获调度器，不真的启动 30 秒节拍（测试里手动调用 tick）。
  globalThis.setInterval = (fn) => {
    tick = fn
    return { unref() {} }
  }
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'job-1', expires_at: new Date(fakeNow + 3_600_000).toISOString() }), { status: 200 })
    }
    if (text.includes('/api/v1/userinfo')) return new Response(JSON.stringify({ id: 'user-1' }), { status: 200 })
    if (text.includes('/api/v2/quota/usage')) {
      quotaCalls += 1
      // 单次请求 2 秒：这一拍结束时的 fetchedAt 比 lastCreditsAt 晚 2 秒。
      fakeNow += 2_000
      return new Response(JSON.stringify({ userQuota: { total: 100, used: quotaCalls, remaining: 100 - quotaCalls } }), { status: 200 })
    }
    if (text.includes('/api/v2/user/plan')) return new Response(JSON.stringify({ plan_tier_name: 'Pro', is_paid_plan: true }), { status: 200 })
    if (text.includes('/api/v3/user/status')) return new Response(JSON.stringify({ nextResetAt: fakeNow }), { status: 200 })
    return new Response('{}', { status: 404 })
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
    globalThis.setInterval = originalSetInterval
    // 等首轮刷新完成（lastCreditsAt 在完成回调里才写入）。
    for (let index = 0; index < 200 && quotaCalls === 0; index++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(quotaCalls, 1, '首轮应当读取一次额度')
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(typeof tick, 'function', '没有捕获到调度器')

    // 第一拍：到点 → 必须请求。
    fakeNow += 2_000 + 120_000
    tick()
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(quotaCalls, 2, '到点的那一拍必须真的请求')

    // 第二拍：到点，但缓存只差 2 秒（旧实现会判「还新鲜」并跳过整整一拍）。
    fakeNow += 118_000
    tick()
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(quotaCalls, 3, '不能被 freshness 窗口跳过一整拍（120 秒的间隔不能变成 240 秒）')
  } finally {
    Date.now = originalNow
    globalThis.setInterval = originalSetInterval
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


test('手动刷新额度：带 provider 时只刷新这一家，不带 provider 才刷全部', async () => {
  // 卡片上的「刷新积分」在 provider 详情页里，一次点击却会把六家一起刷新：
  // 界面只在这一家显示「读取中」，另外五家的数字悄悄变化，还多打五份上游请求。
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-credits-scope-'))
  const dataDir = join(root, DATA_DIR_NAME)
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
    version: 2,
    providers: {
      workbuddy: { enabled: false },
      'workbuddy-ai': { enabled: false },
      qoder: { enabled: true },
      'qoder-global': { enabled: true },
      trae: { enabled: false },
      'trae-global': { enabled: false },
    },
    accounts: {
      qoder: [{ id: 'default', label: '国内', enabled: true, pat: 'cn-pat' }],
      'qoder-global': [{ id: 'default', label: '国际', enabled: true, pat: 'global-pat' }],
    },
    activeAccount: { qoder: 'default', 'qoder-global': 'default' },
    checkin: { enabled: false },
    advanced: { creditsRefreshMs: 86_400_000, catalogRefreshMs: 86_400_000 },
  }))

  const handlers = {}
  const disposers = []
  const originalFetch = globalThis.fetch
  const counts = { cn: 0, global: 0 }
  const json = (value) => new Response(JSON.stringify(value), { status: 200 })
  globalThis.fetch = async (url) => {
    const text = String(url)
    const region = text.includes('openapi.qoder.com.cn')
      ? 'cn'
      : text.includes('openapi.qoder.sh') ? 'global' : undefined
    if (region === undefined) return new Response('{}', { status: 404 })
    if (text.includes('/api/v1/jobToken/exchange')) {
      return json({ token: `${region}-job`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    }
    if (text.includes('/api/v1/userinfo')) return json({ id: `${region}-user` })
    if (text.includes('/api/v2/quota/usage')) {
      counts[region] += 1
      return json({ userQuota: { total: 100, used: 1, remaining: 99 } })
    }
    if (text.includes('/api/v2/user/plan')) return json({ plan_tier_name: 'Pro', is_paid_plan: true })
    if (text.includes('/api/v3/user/status')) return json({ nextResetAt: 0 })
    return new Response('{}', { status: 404 })
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
    // 等首轮额度刷新落定（两家各至少一次），再多等一会儿避免把收尾请求算进来。
    for (let index = 0; index < 200 && (counts.cn === 0 || counts.global === 0); index++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
    const full = await get(handlers[STATUS_PATH], STATUS_PATH)
    const before = { ...counts }

    const scoped = await post(handlers[ACTION_PATH], ACTION_PATH, full.body.key, { action: 'credits', provider: 'qoder' })
    assert.equal(scoped.status, 200)
    assert.ok(counts.cn > before.cn, '带 provider 时必须刷新这一家')
    assert.equal(counts.global, before.global, '带 provider 时不能顺带刷新另一家')

    const all = await post(handlers[ACTION_PATH], ACTION_PATH, full.body.key, { action: 'credits' })
    assert.equal(all.status, 200)
    assert.ok(counts.global > before.global, '不带 provider 时仍要刷新全部')
    assert.ok(counts.cn > before.cn)
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

test('宿主入口：更高版本写过的 stats / events 在状态里标成只读，重置不会假成功', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-host-readonly-'))
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
  // 更高版本写过的文件：Stats / EventLog 都会只读加载，且拒绝写回。
  writeFileSync(join(dataDir, 'stats.json'), JSON.stringify({ version: 999, totals: { requests: 42 } }))
  writeFileSync(join(dataDir, 'events.json'), JSON.stringify({ version: 99, events: [] }))

  const handlers = {}
  const disposers = []
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

  apply(ctx, {})
  try {
    await new Promise((resolve) => setTimeout(resolve, 80))
    const full = await get(handlers[STATUS_PATH], STATUS_PATH)
    assert.equal(full.status, 200)
    assert.deepEqual(full.body.storage.statsReadOnly, { version: 999 })
    assert.deepEqual(full.body.storage.eventsReadOnly, { version: 99 })
    // 只读加载 = 不读内容：旧数字不会冒充当前统计。
    assert.equal(full.body.stats.totals.requests, 0)

    const reset = await post(handlers[ACTION_PATH], ACTION_PATH, full.body.key, { action: 'stats-reset' })
    assert.equal(reset.status, 500, '只读文件的「重置」不能报成功')
    assert.equal(reset.body.error, 'stats-reset-failed')

    // 磁盘上的高版本文件必须原样保留，不能被这次操作降级或清空。
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'stats.json'), 'utf8')).version, 999)
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'stats.json'), 'utf8')).totals.requests, 42)
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'events.json'), 'utf8')).version, 99)
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

test('刷新 / 签到等动作的响应必须是动作之后的状态，不能复用动作前的缓存', async () => {
  // 缺陷：handleAction 只在入口失效状态缓存；动作要跑几秒，期间卡片/侧栏的
  // GET /status 会把「动作前」的文档写进 750ms 缓存，动作结束后的响应直接
  // 复用它 —— 用户点了「刷新」，拿回来的却是点击前的快照，界面回退且要等
  // 下一轮轮询才更新。
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-fresh-status-'))
  const dataDir = join(root, DATA_DIR_NAME)
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
    version: 2,
    providers: {
      workbuddy: { enabled: true },
      'workbuddy-ai': { enabled: false },
      qoder: { enabled: false },
      'qoder-global': { enabled: false },
      trae: { enabled: false },
      'trae-global': { enabled: false },
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
  }))

  const handlers = {}
  const disposers = []
  const originalFetch = globalThis.fetch
  let catalogCalls = 0
  let releaseCatalog
  const catalogGate = new Promise((resolve) => { releaseCatalog = resolve })

  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.includes('/v3/config')) {
      catalogCalls += 1
      await catalogGate
      return new Response(JSON.stringify({
        code: 0,
        data: { agents: [{ name: 'cli', models: ['auto'] }], models: [{ id: 'auto', maxInputTokens: 8000, maxOutputTokens: 1000 }] },
      }), { status: 200 })
    }
    if (text.includes('/meter/get-user-resource')) {
      return new Response(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }), { status: 200 })
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
    for (let index = 0; index < 100 && catalogCalls === 0; index++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(catalogCalls, 1, '首轮目录刷新应当已经发出')

    const full = await get(handlers[STATUS_PATH], STATUS_PATH)
    const eventsBefore = full.body.events.count

    const actionRes = fakeResponse()
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = ACTION_PATH
    req.headers = { host: '127.0.0.1:65466', 'x-rpc-key': full.body.key }
    req.socket = { remoteAddress: '127.0.0.1' }
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify({ action: 'refresh' })))
      req.emit('end')
    })
    handlers[ACTION_PATH](req, actionRes)

    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(actionRes.status, 0, '刷新动作应当还在等首轮目录')
    // 动作进行中：侧栏/卡片轮询会把「动作前」的文档写进缓存。
    const during = await get(handlers[STATUS_PATH], STATUS_PATH)
    assert.equal(during.body.events.count, eventsBefore)

    releaseCatalog()
    await actionRes.done
    assert.equal(actionRes.status, 200)
    const after = JSON.parse(actionRes.body)
    assert.ok(
      after.events.items.some((event) => event.type === 'catalog' && /手动刷新/.test(String(event.message))),
      `动作响应里缺少「已手动刷新」事件：${JSON.stringify(after.events.items?.slice(0, 3))}`,
    )
    assert.ok(after.events.count > eventsBefore, '动作响应必须是动作之后的状态')
  } finally {
    releaseCatalog?.()
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

test('修改登录文件路径会同步到已物化的默认账号，卡片保存后真的生效', async () => {
  // 缺陷：令牌续期会把隐式默认账号连同当时的 authFile 物化成显式行；之后
  // 卡片改 `trae.storageFile` / `workbuddy.*.authFile` 只写旧字段，而
  // accountsFor() 一旦有显式行就忽略旧字段 —— 用户看到「已保存」，实际仍读旧路径。
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-legacy-path-'))
  const dataDir = join(root, DATA_DIR_NAME)
  mkdirSync(dataDir, { recursive: true })
  const settingsFile = join(dataDir, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify({
    version: 2,
    providers: {
      workbuddy: { enabled: false },
      'workbuddy-ai': { enabled: false },
      qoder: { enabled: false },
      'qoder-global': { enabled: false },
      trae: { enabled: false },
      'trae-global': { enabled: false },
    },
    workbuddy: { workbuddy: { authFile: 'C:/old/workbuddy.info' } },
    trae: { trae: { storageFile: 'C:/old/storage.json' } },
    accounts: {
      workbuddy: [{ id: 'default', label: '本机登录', enabled: true, authFile: 'C:/old/workbuddy.info' }],
      trae: [{ id: 'default', label: '本机登录', enabled: true, authFile: 'C:/old/storage.json' }],
    },
  }))

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
    const full = await get(handlers[STATUS_PATH], STATUS_PATH)
    const saved = await post(handlers[SETTINGS_PATH], SETTINGS_PATH, full.body.key, {
      workbuddy: { workbuddy: { authFile: 'C:/new/workbuddy.info' } },
      trae: { trae: { storageFile: 'C:/new/storage.json' } },
    })
    assert.equal(saved.status, 200)
    const doc = JSON.parse(readFileSync(settingsFile, 'utf8'))
    assert.equal(doc.accounts.workbuddy[0].authFile, 'C:/new/workbuddy.info', 'WorkBuddy 默认账号仍在读旧路径')
    assert.equal(doc.accounts.trae[0].authFile, 'C:/new/storage.json', 'Trae 默认账号仍在读旧路径')
    assert.equal(doc.accounts.trae[0].label, '本机登录', '同步路径不能顺手改掉账号名')
    assert.equal(doc.accounts.trae[0].enabled, true, '同步路径不能顺手改掉停用状态')
    assert.equal(saved.body.settings.trae.trae.storageFile, 'C:/new/storage.json')
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

test('无效 provider 的 action 不会被静默当成「全部」或写进签到状态', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-invalid-provider-'))
  const dataDir = join(root, DATA_DIR_NAME)
  mkdirSync(dataDir, { recursive: true })
  const settingsFile = join(dataDir, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify({
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
    const full = await get(handlers[STATUS_PATH], STATUS_PATH)
    const badCheckin = await post(handlers[ACTION_PATH], ACTION_PATH, full.body.key, {
      action: 'checkin',
      provider: 'not-a-provider',
    })
    assert.equal(badCheckin.status, 400)
    assert.equal(badCheckin.body.error, 'invalid-provider')
    const badCredits = await post(handlers[ACTION_PATH], ACTION_PATH, full.body.key, {
      action: 'credits',
      provider: 'not-a-provider',
    })
    assert.equal(badCredits.status, 400)
    assert.equal(badCredits.body.error, 'invalid-provider')
    // 不传 provider 的旧语义保持不变（侧栏胶囊 = 刷全部）。
    const allCredits = await post(handlers[ACTION_PATH], ACTION_PATH, full.body.key, { action: 'credits' })
    assert.equal(allCredits.status, 200)
    // 无效 provider 不能把「最近签到」点亮。
    const doc = JSON.parse(readFileSync(settingsFile, 'utf8'))
    assert.equal(doc.checkin?.lastRunAt ?? 0, 0)
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
