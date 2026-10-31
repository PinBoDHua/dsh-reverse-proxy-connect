/**
 * 第 18 轮审计的回归用例。
 *
 * 每条都对应一个可复现的缺陷（修前 FAIL / 修后 PASS）：
 * - 未配置的 WorkBuddy / Trae 不再把额度读成「读取失败」并刷账本；
 * - 凭证探测的瞬时失败（超时/取消）不再被缓存 60 秒、reason 不再漏出数字码；
 * - 更高版本的 stats.json 在运行期被替换后，旧进程不再覆盖它；
 * - 上次成功快照过期（stale）时不再按「已用尽」自动换号；
 * - 手动测试成功会清掉该账号的失败冷却；
 * - 换号请求的耗时按整次请求算，而不是只算最后一次尝试；
 * - WorkBuddy 登录文件带 BOM / 字符串过期时间时仍能解析；
 * - WorkBuddy 续期成功后过期时间必须推进，不能每请求续期一次。
 *
 * @module dsh-reverse-proxy-connect/tests/audit-r18
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PROVIDER_IDS, REASON } from '../lib/protocol.js'
import { creditsAlertOf, isExhaustedCredits } from '../lib/quota.js'
import { Runtime } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'
import { Stats } from '../lib/stats.js'
import { needsRefresh, readDesktopCredential, refreshDesktopCredential } from '../lib/workbuddy/credentials.js'

/** 临时目录。 */
function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `dsh-r18-${tag}-`))
}

/** 只启用一个 provider 的默认设置。 */
function onlyProvider(provider) {
  const settings = defaults()
  for (const id of PROVIDER_IDS) settings.providers[id].enabled = id === provider
  return settings
}

/** WorkBuddy 账号令牌。 */
function token(accessToken, uid = 'u') {
  return {
    accessToken,
    refreshToken: '',
    expiresAtMs: Date.now() + 86_400_000,
    refreshExpiresAtMs: 0,
    domain: 'codebuddy.cn',
    uid,
    enterpriseId: '',
  }
}

test('未配置的 WorkBuddy：额度状态是 none，不是读取失败，也不刷事件账本', async () => {
  const dir = tempDir('credits-none')
  const originalFetch = globalThis.fetch
  let fetched = 0
  globalThis.fetch = async () => {
    fetched += 1
    return new Response('{}', { status: 200 })
  }
  const settings = onlyProvider('workbuddy')
  settings.workbuddy.workbuddy.authFile = 'Z:\\definitely-missing\\dsh-r18.info'
  const events = []
  const runtime = new Runtime({
    settings: () => settings,
    dataDir: dir,
    logger: {},
    events: { record: (event) => events.push(event) },
  })
  try {
    const credits = await runtime.refreshCredits('workbuddy', { force: true })
    assert.equal(credits.state, 'none', '没登录是已知状态，不能报成读取失败')
    assert.match(String(credits.error), /没有找到/)
    assert.equal(fetched, 0, '凭证都不存在，不应该打上游')
    assert.equal(events.some((event) => event.type === 'credits' && event.level === 'warn'), false, '未配置不是警告')
    assert.equal(isExhaustedCredits(credits, 'workbuddy'), false)
  } finally {
    runtime.flushCaches()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('凭证探测：超时是可重试的瞬时失败，不能缓存 60 秒，reason 也不能是数字', async () => {
  const dir = tempDir('probe-timeout')
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (url, init) => {
    calls += 1
    return new Promise((resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted === true) {
        reject(signal.reason)
        return
      }
      signal?.addEventListener?.('abort', () => reject(signal.reason), { once: true })
    })
  }
  const settings = onlyProvider('qoder')
  settings.qoder.qoder.pat = 'pat-x'
  const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
  const account = { id: 'default', label: '默认令牌', enabled: true, pat: 'pat-x' }
  try {
    const first = await runtime.describeCredential('qoder', account, settings, AbortSignal.timeout(25))
    assert.equal(first.status, 'signed-out')
    assert.equal(first.reason, REASON.timeout, `reason 必须是稳定字符串，实际 ${String(first.reason)}`)
    const second = await runtime.describeCredential('qoder', account, settings, AbortSignal.timeout(25))
    assert.equal(second.status, 'signed-out')
    assert.equal(calls, 2, '瞬时失败不能被缓存成 60 秒的「未登录」')
  } finally {
    runtime.flushCaches()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('运行期磁盘被更高版本的 stats.json 替换：旧进程不能再覆盖它', () => {
  const dir = tempDir('stats-blocked')
  const file = join(dir, 'stats.json')
  const stats = new Stats({ filePath: file, enabled: () => true, persistDelayMs: 60_000 })
  try {
    writeFileSync(file, JSON.stringify({ version: 99, future: true }))
    stats.record({ provider: 'workbuddy', model: 'm', kind: 'stop', durationMs: 1 })
    const ok = stats.flush()
    assert.equal(ok, false, '发现更高版本后必须拒绝写回')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 99, '原文件不能被降级覆盖')
    assert.equal(stats.writeBlocked, true)
  } finally {
    stats.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stale / 读失败的额度快照不能当成「已用尽」触发换号或预警', () => {
  const stale = { state: 'ok', remain: 0, total: 100, stale: true, error: 'HTTP 503' }
  assert.equal(isExhaustedCredits(stale, 'workbuddy'), false, '上次结果读取失败时不能按耗尽换号')
  assert.equal(creditsAlertOf(stale, { enabled: true, lowRatio: 0.15 }, 'workbuddy'), undefined)
  const failed = { state: 'ok', remain: 0, total: 100, error: 'HTTP 503' }
  assert.equal(isExhaustedCredits(failed, 'workbuddy'), false)
  const fresh = { state: 'ok', remain: 0, total: 100 }
  assert.equal(isExhaustedCredits(fresh, 'workbuddy'), true, '真正读到 0 仍然算用尽')
})

test('手动测试成功会清掉该账号的失败冷却', async () => {
  const dir = tempDir('test-cooldown')
  const originalFetch = globalThis.fetch
  const encoder = new TextEncoder()
  globalThis.fetch = async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const settings = onlyProvider('workbuddy')
  settings.workbuddy.workbuddy.authFile = 'Z:\\missing\\dsh-r18.info'
  settings.accounts.workbuddy = [{ id: 'a', label: 'A', enabled: true, token: token('token-a', 'ua') }]
  settings.activeAccount.workbuddy = 'a'
  const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
  runtime.catalogs.set('workbuddy::a', {
    models: [{ id: 'hy3', name: 'HY3', contextWindow: 128000, maxTokens: 8192, supportsImages: false, supportsReasoning: false, reasoningEfforts: [] }],
    fetchedAt: Date.now(),
    source: 'live',
  })
  runtime.accountFailures.set('workbuddy::a', {
    at: Date.now(),
    code: 'RATE_LIMIT',
    until: Date.now() + 120_000,
  })
  try {
    assert.ok(runtime.cooldownUntil('workbuddy', 'a') > 0)
    const result = await runtime.testAccount('workbuddy', 'a')
    assert.equal(result.ok, true)
    assert.equal(runtime.cooldownUntil('workbuddy', 'a'), 0, '测试已经证明可用，冷却必须立刻解除')
  } finally {
    runtime.flushCaches()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('换号请求的耗时按整次请求算，不是只算最后一次尝试', async () => {
  const dir = tempDir('failover-duration')
  const originalFetch = globalThis.fetch
  const encoder = new TextEncoder()
  globalThis.fetch = async (url, init) => {
    const auth = String(init?.headers?.Authorization ?? '')
    if (auth.includes('token-a')) {
      await new Promise((resolve) => setTimeout(resolve, 120))
      return new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })
    }
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const settings = onlyProvider('workbuddy')
  settings.workbuddy.workbuddy.authFile = 'Z:\\missing\\dsh-r18.info'
  settings.accounts.workbuddy = [
    { id: 'a', label: 'A', enabled: true, token: token('token-a', 'ua') },
    { id: 'b', label: 'B', enabled: true, token: token('token-b', 'ub') },
  ]
  settings.activeAccount.workbuddy = 'a'
  const recorded = []
  const runtime = new Runtime({
    settings: () => settings,
    dataDir: dir,
    logger: {},
    stats: { record: (entry) => recorded.push(entry) },
  })
  try {
    const opened = await runtime.openStream('workbuddy', {
      model: 'hy3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: AbortSignal.timeout(5000),
    })
    for await (const _event of opened.events) {
      /* 消费到终态 */
    }
    const entry = recorded.find((item) => item.kind === 'stop' || item.kind === 'tool-calls')
    assert.ok(entry !== undefined, '应当记下一次成功请求')
    assert.ok(entry.durationMs >= 100, `耗时应当包含第一次 429 的等待，实际 ${String(entry.durationMs)}ms`)
  } finally {
    runtime.flushCaches()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WorkBuddy 登录文件：BOM 与字符串 expiresAt 都能解析', async () => {
  const dir = tempDir('wb-bom')
  const file = join(dir, 'workbuddy.info')
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
  writeFileSync(file, '\uFEFF' + JSON.stringify({
    auth: { accessToken: 'tok-bom', refreshToken: 'rt', expiresAt },
    account: { uid: 'u1' },
  }))
  try {
    const credential = await readDesktopCredential('workbuddy', { authFile: file })
    assert.equal(credential.accessToken, 'tok-bom')
    assert.ok(credential.expiresAtMs > Date.now() + 3_000_000, `字符串 expiresAt 被读成 ${String(credential.expiresAtMs)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WorkBuddy 续期成功：过期时间必须推进，不能每个请求都续期', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { data: { accessToken: 'new-token', refreshToken: 'rt2' } }
    },
  })
  try {
    const credential = {
      variant: 'workbuddy',
      region: 'cn',
      uid: 'u',
      enterpriseId: '',
      domain: 'codebuddy.cn',
      accessToken: 'old-token',
      refreshToken: 'rt',
      expiresAtMs: Date.now() - 60_000,
      refreshExpiresAtMs: 0,
      file: '',
    }
    const next = await refreshDesktopCredential(credential)
    assert.equal(next.accessToken, 'new-token')
    assert.ok(next.expiresAtMs > Date.now() + 60_000, '续期成功必须给出新的过期时间')
    assert.equal(needsRefresh(next), false, '刚续期成功就不该再判为需要续期')
  } finally {
    globalThis.fetch = originalFetch
  }
})
