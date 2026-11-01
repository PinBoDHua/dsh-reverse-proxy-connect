/**
 * 第 22 轮审计的回归用例。
 *
 * 每条都对应一个可复现的缺陷（修前 FAIL / 修后 PASS）：
 * - 浏览器原样回传未改动的凭证，仍把这家 provider 的额度历史写成墓碑；
 * - Qoder 身份交换的共享任务绑在第一个调用方的 signal 上，一方取消拖死另一方；
 * - 能力探测把所有请求失败算成「探测成功」，清空旧结论并推后 6 小时；
 * - 目录缓存只认安全整数，上游合法的小数 token 数让整条模型行消失。
 *
 * @module dsh-reverse-proxy-connect/tests/audit-r22
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeCachedModel } from '../lib/catalog-cache.js'
import { activeAccountFor } from '../lib/accounts.js'
import { apply } from '../lib/index.js'
import { credentialTargetsOf } from '../lib/patch.js'
import { DATA_DIR_NAME, PROVIDERS, SETTINGS_PATH, STATUS_PATH } from '../lib/protocol.js'
import { Runtime } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'

/** 临时目录。 */
function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `dsh-r22-${tag}-`))
}

/** 等一小会儿。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('凭证目标：原样回传的 pat / authFile 不算「换了凭证」', () => {
  const current = defaults()
  current.accounts[PROVIDERS.qoder] = [{ id: 'acc-1', label: 'A', enabled: true, pat: 'tok' }]
  const unchanged = credentialTargetsOf({ accounts: { [PROVIDERS.qoder]: [{ id: 'acc-1', label: 'A', pat: 'tok' }] } }, current)
  assert.deepEqual(unchanged, [], '没改令牌的保存不该作废额度历史')

  const changed = credentialTargetsOf({ accounts: { [PROVIDERS.qoder]: [{ id: 'acc-1', label: 'A', pat: 'tok-2' }] } }, current)
  assert.deepEqual(changed, [{ provider: PROVIDERS.qoder, accountId: 'acc-1' }])

  const forget = credentialTargetsOf({ accounts: { [PROVIDERS.qoder]: [{ id: 'acc-1', forget: true }] } }, current)
  assert.deepEqual(forget, [{ provider: PROVIDERS.qoder, accountId: 'acc-1' }], '显式清空密钥必须作废旧状态')

  const added = credentialTargetsOf({ accounts: { [PROVIDERS.qoder]: [{ id: 'acc-2', label: 'B', pat: 'tok' }] } }, current)
  assert.deepEqual(added, [{ provider: PROVIDERS.qoder, accountId: 'acc-2' }], '新账号按「变了」处理')
})

test('设置接口：原样保存登录文件路径不会清空今日消耗', async () => {
  const root = tempDir('settings-unchanged')
  const dataDir = join(root, DATA_DIR_NAME)
  mkdirSync(dataDir, { recursive: true })
  const authFile = 'Z:\\r22\\same-login.info'
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
    workbuddy: { workbuddy: { authFile }, 'workbuddy-ai': { authFile: '' } },
  }))
  // 预置一份「今天已消耗 100」的额度历史。
  const now = Date.now()
  const hourStart = new Date(now)
  hourStart.setMinutes(0, 0, 0)
  writeFileSync(join(dataDir, 'credits-history.json'), JSON.stringify({
    version: 1,
    entries: {
      'workbuddy::default': {
        recent: [
          { at: now - 50 * 60_000, remain: 500, total: 500 },
          { at: now - 5 * 60_000, remain: 400, total: 500 },
        ],
        hours: [{ at: hourStart.getTime(), first: 500, last: 400, spent: 100, topup: 0, samples: 2 }],
      },
    },
  }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '{}' })
  const host = fakeHost(root)
  try {
    apply(host.ctx, {})
    await sleep(80)
    const before = await hostGet(host.handlers[STATUS_PATH], STATUS_PATH)
    const trendBefore = before.body.providers.find((entry) => entry.provider === PROVIDERS.workbuddy).credits.trend
    assert.equal(trendBefore.spentToday, 100, '前置数据没有生效')

    // 用户只是点了「保存」，路径一个字都没改。
    const response = await hostPost(host.handlers[SETTINGS_PATH], SETTINGS_PATH, {
      workbuddy: { workbuddy: { authFile, electronPath: '' } },
    }, before.body.key)
    assert.equal(response.status, 200)
    const trendAfter = response.body.providers.find((entry) => entry.provider === PROVIDERS.workbuddy).credits.trend
    assert.equal(trendAfter.spentToday, 100, '原样保存不该把今日消耗清零')

    const history = JSON.parse(readFileSync(join(dataDir, 'credits-history.json'), 'utf8'))
    assert.deepEqual(Object.keys(history.entries), ['workbuddy::default'], '未变化的凭证不该写墓碑')
    assert.equal(history.forgotten, undefined)
  } finally {
    globalThis.fetch = originalFetch
    for (const dispose of host.disposers.reverse()) {
      try { dispose() } catch { /* 已停止 */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('Qoder 身份交换：共享任务不绑第一个调用方的 signal', async () => {
  const dir = tempDir('qoder-identity')
  const originalFetch = globalThis.fetch
  const settings = defaults()
  settings.qoder.qoder.pat = 'pat-1'
  /** 手工可控的 fetch：打开前挂起；signal 中止时立即失败。 */
  let open = false
  globalThis.fetch = async (url, init) => {
    const signal = init?.signal
    if (signal?.aborted) throw signal.reason
    if (!open) {
      await new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        const timer = setInterval(() => {
          if (!open) return
          clearInterval(timer)
          resolve()
        }, 5)
        timer.unref?.()
      })
    }
    const isInfo = String(url).includes('userinfo')
    return {
      ok: true,
      headers: new Headers(),
      text: async () => JSON.stringify(isInfo ? { id: 'u1' } : { token: 'job-token', expires_at: '' }),
      json: async () => (isInfo ? { id: 'u1', name: 'n', email: 'e' } : { token: 'job-token', expires_at: '' }),
    }
  }
  try {
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    const account = activeAccountFor(PROVIDERS.qoder, settings)
    const first = new AbortController()
    const p1 = runtime.identityFor(PROVIDERS.qoder, account, settings, first.signal)
    p1.catch(() => undefined)
    const p2 = runtime.identityFor(PROVIDERS.qoder, account, settings, undefined)
    await sleep(30)
    first.abort(new Error('caller-1 cancelled'))
    open = true
    const [a, b] = await Promise.allSettled([p1, p2])
    assert.equal(a.status, 'rejected', '取消方应当立刻结束')
    assert.equal(b.status, 'fulfilled', '没取消的那一方被共享任务的取消拖死了')
    assert.equal(b.value.authToken, 'job-token')
    runtime.flushCaches()
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('能力探测：全部请求失败时不能算「探测成功」', async () => {
  const dir = tempDir('probe-failed')
  try {
    const settings = defaults()
    settings.accounts[PROVIDERS.workbuddy] = [{
      id: 'a',
      label: '账号 A',
      enabled: true,
      token: { accessToken: 'token-a', refreshToken: '', expiresAtMs: Date.now() + 3600_000 },
    }]
    settings.activeAccount[PROVIDERS.workbuddy] = 'a'
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    runtime.catalogs.set('workbuddy::a', {
      models: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
      fetchedAt: Date.now(),
      source: 'live',
    })
    runtime.openStream = async () => {
      const error = new Error('上游 503')
      error.status = 503
      error.kind = 'server'
      throw error
    }
    const outcome = await runtime.probeProvider(PROVIDERS.workbuddy, { accountId: 'a' })
    assert.equal(outcome.probed, 0, '每个请求都失败时不能报告「探测了 3 个」')
    assert.deepEqual(outcome.unavailable, [], '上游故障不是「账号不支持」')
    assert.deepEqual(outcome.unknown, ['m1', 'm2', 'm3'], '没有结论的模型要如实列出')
    runtime.flushCaches()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('能力探测：可用 / 不支持 / 无结论分开计数', async () => {
  const dir = tempDir('probe-mixed')
  try {
    const settings = defaults()
    settings.accounts[PROVIDERS.workbuddy] = [{
      id: 'a',
      label: '账号 A',
      enabled: true,
      token: { accessToken: 'token-a', refreshToken: '', expiresAtMs: Date.now() + 3600_000 },
    }]
    settings.activeAccount[PROVIDERS.workbuddy] = 'a'
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    runtime.catalogs.set('workbuddy::a', {
      models: [{ id: 'ok-model' }, { id: 'plan-model' }, { id: 'broken-model' }],
      fetchedAt: Date.now(),
      source: 'live',
    })
    runtime.openStream = async (provider, request) => {
      if (request.model === 'ok-model') {
        return {
          events: (async function* () { yield { type: 'finish', kind: 'stop' } })(),
          close: async () => {},
        }
      }
      const error = new Error(request.model === 'plan-model'
        ? '当前账号类型暂不支持该模型'
        : '上游 503')
      error.status = request.model === 'plan-model' ? 400 : 503
      error.kind = 'server'
      throw error
    }
    const outcome = await runtime.probeProvider(PROVIDERS.workbuddy, { accountId: 'a' })
    assert.equal(outcome.probed, 2, '可用 + 账号不支持 = 两个有结论的模型')
    assert.deepEqual(outcome.unavailable, ['plan-model'])
    assert.deepEqual(outcome.unknown, ['broken-model'])
    runtime.flushCaches()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录缓存：上游合法的小数 token 数不再让整条模型行消失', () => {
  const model = normalizeCachedModel({ id: 'glm-5', name: 'GLM-5', contextWindow: 128000.5, maxTokens: 4096.5 })
  assert.equal(model.contextWindow, 128000, '与实时路径同一口径：向下取整')
  assert.equal(model.maxTokens, 4096)
  // 合法整数的行为不变。
  assert.equal(normalizeCachedModel({ id: 'm', name: 'M', contextWindow: 256000, maxTokens: 32000 }).contextWindow, 256000)
  // 非正 / 非有限仍然丢弃。
  assert.equal(normalizeCachedModel({ id: 'm', name: 'M', contextWindow: 0.5, maxTokens: 32000 }), undefined)
  assert.equal(normalizeCachedModel({ id: 'm', name: 'M', contextWindow: Infinity, maxTokens: 32000 }), undefined)
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
