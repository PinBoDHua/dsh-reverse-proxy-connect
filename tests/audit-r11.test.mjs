/**
 * 第十一轮审计回归：前后端各模块逐行复查后，用真实输入复现并修掉的问题。
 *
 * 覆盖：
 * - 默认账号被写进显式账号池后仍保留本地化键；
 * - `NO_ACCOUNT` 必须以 AUTH 交给宿主；
 * - 目录缓存的删除墓碑不占名额，且账号复活后墓碑会被撤销；
 * - Qoder 身份交换并发单飞；
 * - 凭证变化后旧的失败探测/测试结论立刻失效（含宿主 /settings 链路）；
 * - Qoder「计划接口成功但缺 is_paid_plan」不再被误判成 Free；
 * - 显式 accountId 不存在时不许退回当前账号；
 * - 删除账号会清掉「账号 × 模型」的测试结论。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { accountsFor, mergeAccountSecrets } from '../lib/accounts.js'
import { finishError, stableFailureCode } from '../lib/adapter.js'
import { loadCatalogCache, saveCatalogCache } from '../lib/catalog-cache.js'
import { fetchQoderCredits } from '../lib/credits.js'
import { apply } from '../lib/index.js'
import { DATA_DIR_NAME, SETTINGS_PATH, STATUS_PATH } from '../lib/protocol.js'
import { isExhaustedCredits, isQoderFreePlan } from '../lib/quota.js'
import { Runtime } from '../lib/runtime.js'
import { defaults, normalize } from '../lib/settings.js'

/** 一个只有 qoder 启用的设置。 */
function qoderOnly() {
  const settings = defaults()
  for (const provider of ['workbuddy', 'workbuddy-ai', 'qoder-global', 'trae', 'trae-global']) {
    settings.providers[provider].enabled = false
  }
  return settings
}

/** 最小可用的缓存模型行。 */
function cachedModel(id) {
  return { id, name: id, contextWindow: 1000, maxTokens: 100 }
}

/** Qoder 端点的一组最小响应；`accept` 决定 PAT 是否被接受。 */
function qoderFetch(accept) {
  return async (url, init) => {
    const href = String(url)
    if (href.includes('/jobToken/exchange')) {
      let token = ''
      try {
        token = JSON.parse(init?.body ?? '{}').personal_token ?? ''
      } catch {
        token = ''
      }
      if (accept(token)) return Response.json({ token: 'job-token' })
      return new Response('个人访问令牌无效', { status: 401 })
    }
    if (href.includes('/api/v1/userinfo')) return Response.json({ id: 'user-1', name: 'N', email: 'n@example.com' })
    if (href.includes('/api/v2/model/list')) {
      return Response.json({
        chat: [{
          key: 'cmodel',
          enable: true,
          display_name: 'Cantus',
          max_input_tokens: 128_000,
          max_output_tokens: 8_192,
          context_config: {},
          thinking_config: {},
        }],
      })
    }
    if (href.includes('/api/v2/quota/usage')) {
      return Response.json({ userQuota: { total: 100, used: 1, remaining: 99 } })
    }
    if (href.includes('/api/v2/user/plan')) return Response.json({ plan_tier_name: 'Pro', is_paid_plan: true })
    if (href.includes('/api/v3/user/status')) return Response.json({ nextResetAt: Date.now() + 86_400_000 })
    return new Response('unexpected', { status: 500 })
  }
}

// ---------- 账号池 ----------

test('默认账号写进显式账号池后仍保留 labelKey（英文界面不再显示中文）', () => {
  const settings = defaults()
  settings.qoder.qoder.pat = 'legacy-pat'
  // 客户端添加第二个账号时只发新增行；服务端会把隐式默认账号一起并进账号池。
  const merged = mergeAccountSecrets({
    accounts: { qoder: [{ id: 'acc-2', label: '备用', enabled: true, pat: 'p2' }] },
    activeAccount: { qoder: 'acc-2' },
  }, settings)
  const next = normalize({ ...settings, ...merged })
  const list = accountsFor('qoder', next)
  assert.deepEqual(list.map((account) => account.id), ['default', 'acc-2'])
  assert.equal(list[0].label, '默认令牌')
  assert.equal(list[0].labelKey, 'accountDefaultPat', '默认账号的文案键不能在落盘时丢掉')
  assert.equal(list[1].labelKey, undefined, '用户自己命名的账号没有文案键')
})

// ---------- 适配器契约 ----------

test('NO_ACCOUNT 映射为 AUTH，而不是不可重试的 upstream-error', () => {
  assert.equal(stableFailureCode('NO_ACCOUNT'), 'AUTH')
  const chunk = finishError(Object.assign(new Error('没有可用账号'), {
    name: 'NoAccountError',
    code: 'NO_ACCOUNT',
    kind: 'auth',
  }))
  assert.equal(chunk.type, 'finish')
  assert.equal(chunk.reason.kind, 'error')
  assert.equal(chunk.reason.failure.code, 'AUTH')
})

// ---------- 目录缓存 ----------

test('目录缓存：磁盘墓碑不占 MAX_ENTRIES 名额，也不会被写回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-r11-catalog-slot-'))
  try {
    const file = join(dir, 'catalog-cache.json')
    const fetchedAt = Date.now()
    writeFileSync(file, JSON.stringify({ version: 1, entries: {}, forgotten: ['qoder::ghost'] }))
    const entries = new Map()
    for (let index = 0; index < 24; index++) {
      entries.set(`qoder::acc-${String(index)}`, { models: [cachedModel('m')], fetchedAt })
    }
    // 另一个进程还没看到删除：它的内存里仍有已删账号的旧目录。
    entries.set('qoder::ghost', { models: [cachedModel('m')], fetchedAt })
    assert.equal(saveCatalogCache(dir, entries), true)

    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.entries['qoder::ghost'], undefined, '已删账号的目录不能被写回')
    assert.ok(raw.forgotten.includes('qoder::ghost'), '墓碑必须继续保留')
    assert.equal(Object.keys(raw.entries).length, 24, '墓碑不能挤掉一个活账号')
    assert.equal(loadCatalogCache(dir).size, 24)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录缓存：账号复活后撤销墓碑，重启仍能读到刚拉到的目录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-r11-catalog-revive-'))
  const originalFetch = globalThis.fetch
  const settings = qoderOnly()
  settings.qoder.qoder.pat = 'pat-good'
  settings.activeAccount.qoder = 'default'
  globalThis.fetch = qoderFetch((token) => token === 'pat-good')
  try {
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    // 模拟：这个默认账号以前被删过，墓碑已随 catalog-cache 落盘。
    runtime.forgetAccount('qoder', 'default')
    const result = await runtime.refresh('qoder', { force: true })
    assert.equal(result.status, 'signed-in')
    assert.deepEqual(runtime.modelsFor('qoder').map((model) => model.id), ['cmodel'])
    runtime.flushCaches()

    const restarted = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    assert.deepEqual(restarted.modelsFor('qoder').map((model) => model.id), ['cmodel'], '重启后目录缓存不能又被墓碑过滤掉')
    assert.equal(restarted.catalogCache.forgotten.has('qoder::default'), false, '复活后磁盘墓碑要摘掉')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- Qoder 身份与额度 ----------

test('Qoder 身份交换并发只打一次（启动时目录/额度/状态可能同时解析）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-r11-identity-'))
  const originalFetch = globalThis.fetch
  const settings = qoderOnly()
  settings.accounts.qoder = [{ id: 'acc-x', label: 'X', enabled: true, pat: 'pat-1' }]
  settings.activeAccount.qoder = 'acc-x'
  let exchanges = 0
  let infos = 0
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/jobToken/exchange')) {
      exchanges += 1
      await new Promise((resolve) => setTimeout(resolve, 25))
      return Response.json({ token: 'job-token' })
    }
    if (href.includes('/api/v1/userinfo')) {
      infos += 1
      return Response.json({ id: 'user-1', name: 'N', email: 'n@example.com' })
    }
    return new Response('unexpected', { status: 500 })
  }
  try {
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    const account = settings.accounts.qoder[0]
    const identities = await Promise.all([
      runtime.identityFor('qoder', account, settings),
      runtime.identityFor('qoder', account, settings),
      runtime.identityFor('qoder', account, settings),
    ])
    assert.equal(exchanges, 1, '同一 PAT 的并发交换必须共用一个任务')
    assert.equal(infos, 1)
    assert.ok(identities.every((identity) => identity.userID === 'user-1'))

    // PAT 换了：旧任务不能复用到新凭证上，缓存也要写回新身份。
    settings.accounts.qoder[0].pat = 'pat-2'
    const refreshed = await runtime.identityFor('qoder', settings.accounts.qoder[0], settings)
    assert.equal(exchanges, 2)
    assert.equal(refreshed.pat, 'pat-2')
    assert.equal(runtime.identities.get('qoder::acc-x').pat, 'pat-2')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Qoder 计划接口成功但缺 is_paid_plan：付费套餐的 0 额度不算 Free', async () => {
  const originalFetch = globalThis.fetch
  const respond = (plan) => async (url) => {
    const href = String(url)
    if (href.includes('/quota/usage')) {
      return Response.json({ userQuota: { total: 0, used: 0, remaining: 0 }, isQuotaExceeded: true })
    }
    if (href.includes('/user/plan')) return Response.json(plan)
    if (href.includes('/user/status')) return Response.json({})
    return new Response('unexpected', { status: 500 })
  }
  try {
    globalThis.fetch = respond({ plan_tier_name: 'Pro' })
    const paidPlan = await fetchQoderCredits({ authToken: 'job' }, 'china')
    assert.equal(paidPlan.paid, undefined, '字段缺失只能算「不知道」，不能当成 paid=false')
    assert.equal(paidPlan.freePlan, undefined)
    assert.equal(isQoderFreePlan('qoder', paidPlan), false)
    assert.equal(isExhaustedCredits(paidPlan, 'qoder'), true, '非 Free 套餐的 0 额度应当按用尽处理')

    globalThis.fetch = respond({ plan_tier_name: 'Free' })
    const freePlan = await fetchQoderCredits({ authToken: 'job' }, 'china')
    assert.equal(freePlan.freePlan, true)
    assert.equal(isQoderFreePlan('qoder', freePlan), true)
    assert.equal(isExhaustedCredits(freePlan, 'qoder'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------- 运行时状态 ----------

test('显式 accountId 不存在时报 NO_ACCOUNT，不静默改用当前账号', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-r11-explicit-'))
  const originalFetch = globalThis.fetch
  const settings = qoderOnly()
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('unexpected', { status: 500 })
  }
  const recorded = []
  try {
    const runtime = new Runtime({
      settings: () => settings,
      dataDir: dir,
      logger: {},
      stats: { record: (entry) => recorded.push(entry) },
      events: { record() {} },
    })
    await assert.rejects(runtime.openStream('qoder', {
      model: 'auto',
      accountId: 'deleted-account',
      noFailover: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }), (error) => {
      assert.equal(error?.code, 'NO_ACCOUNT')
      assert.equal(error?.kind, 'auth')
      return true
    })
    assert.equal(calls, 0, '账号都不存在，不能打上游')
    assert.deepEqual(recorded, [], '没有发出的请求不该记统计')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('删除账号会清掉它残留的「账号 × 模型」测试结论', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-r11-tests-'))
  try {
    const runtime = new Runtime({ settings: () => defaults(), dataDir: dir, logger: {} })
    runtime.modelTests.set('qoder::default::cmodel', { ok: true, at: Date.now(), latencyMs: 10 })
    runtime.modelTests.set('workbuddy::other::auto', { ok: false, at: Date.now(), latencyMs: 20 })
    runtime.accountTests.set('qoder::default', { ok: true, at: Date.now() })
    runtime.forgetAccount('qoder', 'default')
    assert.equal(runtime.modelTests.has('qoder::default::cmodel'), false)
    assert.equal(runtime.accountTests.has('qoder::default'), false)
    assert.equal(runtime.modelTests.has('workbuddy::other::auto'), true, '别的 provider 的测试结论不受影响')
    runtime.flushCaches()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('凭证变化后旧的失败探测与测试结论立刻失效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-r11-cred-'))
  const originalFetch = globalThis.fetch
  const settings = qoderOnly()
  settings.accounts.qoder = [{ id: 'acc-x', label: 'X', enabled: true, pat: 'bad-pat' }]
  settings.activeAccount.qoder = 'acc-x'
  globalThis.fetch = qoderFetch((token) => token === 'good-pat')
  try {
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    const account = settings.accounts.qoder[0]
    const before = await runtime.describeCredential('qoder', account, settings)
    assert.equal(before.status, 'signed-out')
    runtime.accountTests.set('qoder::acc-x', { ok: false, at: Date.now(), code: 'AUTH' })
    runtime.modelTests.set('qoder::acc-x::cmodel', { ok: false, at: Date.now(), code: 'AUTH' })

    // 用户把 PAT 换成好的：宿主保存设置时会调用 forgetCredentialState()。
    settings.accounts.qoder[0].pat = 'good-pat'
    runtime.forgetCredentialState(['qoder'])
    const after = await runtime.describeCredential('qoder', settings.accounts.qoder[0], settings)
    assert.equal(after.status, 'signed-in', '新 PAT 不能继续吃 60 秒的失败缓存')
    assert.equal(runtime.accountTests.has('qoder::acc-x'), false)
    assert.equal(runtime.modelTests.has('qoder::acc-x::cmodel'), false)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 宿主接口 ----------

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

async function get(handler, url) {
  const res = fakeResponse()
  handler({ method: 'GET', url, headers: { host: '127.0.0.1:65466' }, socket: { remoteAddress: '127.0.0.1' } }, res)
  await res.done
  return { status: res.status, body: JSON.parse(res.body) }
}

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

test('宿主：保存新 PAT 后返回的状态立刻是已登录（不被旧失败缓存挡住）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rpc-r11-host-cred-'))
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
    accounts: { qoder: [{ id: 'acc-x', label: 'X', enabled: true, pat: 'bad-pat' }] },
    activeAccount: { qoder: 'acc-x' },
    checkin: { enabled: false },
    probe: { enabled: false },
  }))

  const handlers = {}
  const disposers = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = qoderFetch((token) => token === 'good-pat')
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { dir: root }
      return undefined
    },
    inject(names, callback) {
      if (!names.includes('webServer')) return
      callback({
        webServer: fakeWebServer(handlers),
        effect(fn) {
          const dispose = fn()
          disposers.push(dispose)
          return dispose
        },
      })
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    llm: {
      registerAdapter() {
        return () => {}
      },
    },
    emit() {},
    logger: { info() {}, warn() {} },
  }
  apply(ctx, {})
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const full = await get(handlers[STATUS_PATH], STATUS_PATH)
    const before = full.body.providers.find((provider) => provider.provider === 'qoder')
    assert.equal(before.credential.status, 'signed-out')

    const saved = await post(handlers[SETTINGS_PATH], SETTINGS_PATH, full.body.key, {
      accounts: { qoder: [{ id: 'acc-x', label: 'X', enabled: true, pat: 'good-pat' }] },
    })
    assert.equal(saved.status, 200)
    const after = saved.body.providers.find((provider) => provider.provider === 'qoder')
    assert.equal(after.credential.status, 'signed-in', '保存新 PAT 后的第一份状态就该是已登录')
    assert.equal(after.accounts[0].lastTest, undefined)
    const stored = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
    assert.equal(stored.accounts.qoder[0].pat, 'good-pat')
  } finally {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 忽略清理失败 */
      }
    }
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})
