/**
 * 第 16 轮审计的回归用例。
 *
 * 每条都对应一个真实可复现的缺陷（修前 FAIL / 修后 PASS）：
 * - 改一个账号不再把同一家其它账号的额度、曲线、冷却与测试结论一起作废；
 * - 连续无内容超时不再被报成「用户取消」（ABORTED）；
 * - 消耗速度不再把「刚过去的几分钟」当成一整小时；
 * - stats.json 的「今日」缺日期时不再被当成今天；
 * - Qoder 等位接口缺字段时不再被误判成「没有容量」；
 * - 候选账号在正文前失败时不再被写回成当前账号；
 * - 没有额度缓存时换凭证也要推进删除代数；
 * - 诊断不再把 Qoder Free 写成「已用尽」。
 *
 * @module dsh-reverse-proxy-connect/tests/audit-r16
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { mergeAccountSecrets } from '../lib/accounts.js'
import { summarizeHistory } from '../lib/credit-history.js'
import { buildDiagnostics } from '../lib/diagnostics.js'
import { credentialTargetsOf, sanitizePatch } from '../lib/patch.js'
import { fetchQueueStatus } from '../lib/qoder/transport.js'
import { Runtime } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'
import { Stats, statsPathOf } from '../lib/stats.js'
import { withIdleTimeout } from '../lib/timeout.js'

/** 临时目录。 */
function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `dsh-r16-${tag}-`))
}

test('账号改名 / 启停只影响自己：凭证目标取自浏览器提交的原始行，不是合并后的整表', () => {
  const current = {
    accounts: {
      qoder: [
        { id: 'a1', label: 'A', enabled: true, pat: 'p1' },
        { id: 'a2', label: 'B', enabled: true, pat: 'p2' },
        { id: 'a3', label: 'C', enabled: true, pat: 'p3' },
      ],
    },
  }
  const submitted = sanitizePatch({ accounts: { qoder: [{ id: 'a1', label: 'A-改名' }] } })
  // 合并后的整表每一行都带着 pat：拿它判断「哪些凭证变了」会把三家全算上。
  const merged = mergeAccountSecrets(submitted, current)
  assert.equal(credentialTargetsOf(merged).length, 3, '这是修复前的错误输入')
  assert.deepEqual(credentialTargetsOf(submitted), [], '改名不该作废任何凭证')

  // 真正换 PAT：只作废这一行。
  const changed = sanitizePatch({ accounts: { qoder: [{ id: 'a2', pat: 'p2-new' }] } })
  assert.deepEqual(credentialTargetsOf(changed), [{ provider: 'qoder', accountId: 'a2' }])
  // 显式清空密钥同样算凭证变更（以前因为行里没有 pat/token 被当成「没改」）。
  const cleared = sanitizePatch({ accounts: { qoder: [{ id: 'a2', forget: true }] } })
  assert.deepEqual(credentialTargetsOf(cleared), [{ provider: 'qoder', accountId: 'a2' }])
})

test('连续无内容看门狗到点：抛超时而不是「已取消」', async () => {
  const source = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'text', text: 'hi' }
      await new Promise((resolve) => setTimeout(resolve, 400))
      yield { type: 'text', text: 'late' }
    },
  }
  const controller = new AbortController()
  const stream = withIdleTimeout(source, {
    idleMs: 60_000,
    maxSilentMs: 120,
    signal: controller.signal,
    onIdle: () => controller.abort(),
  })
  let failure
  try {
    for await (const _event of stream) {
      // 宿主处理一帧较慢：停在 yield 期间 silent 看门狗到点并 abort。
      await new Promise((resolve) => setTimeout(resolve, 260))
    }
  } catch (error) {
    failure = error
  }
  assert.ok(failure !== undefined, '看门狗应该终止这条流')
  assert.equal(failure.code, 'timeout', '超时必须归 TIMEOUT（可重试），不能是 ABORTED')
  assert.notEqual(failure.code, 'ABORTED')
})

test('消耗速度：当前这一小时只算到「现在」，不能算满整点', () => {
  const at = (hour, minute = 0) => new Date(2026, 9, 18, hour, minute, 0, 0).getTime()
  const trend = summarizeHistory({
    // 原始点只跨 4 分钟（低于 10 分钟门限），计算退回小时桶。
    recent: [
      { at: at(10, 0), remain: 190 },
      { at: at(10, 4), remain: 185 },
    ],
    hours: [
      { at: at(9, 0), first: at(9, 0), last: at(9, 55), spent: 10, topup: 0, samples: 2 },
      { at: at(10, 0), first: at(10, 0), last: at(10, 4), spent: 5, topup: 0, samples: 2 },
    ],
  }, { now: at(10, 5) })
  // 09:00 → 10:05 花 15：13.85/h。旧实现把 10 点算成完整一小时（共 2h）→ 7.5/h。
  assert.ok(Math.abs(trend.burnPerHour - 15 / (65 / 60)) < 0.01, `速度应为 13.85，实际 ${String(trend.burnPerHour)}`)
})

test('stats.json：今日块缺 date 时按「跨天」清零，与 providerToday 保持一致', () => {
  const dir = tempDir('stats')
  try {
    const path = statsPathOf(dir)
    const seed = new Stats({ filePath: path, enabled: () => true })
    seed.record({ provider: 'workbuddy', accountId: 'a', model: 'm', kind: 'stop', durationMs: 10 })
    seed.flush()
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    // 半迁移 / 手改后的形状：有计数，没有日期。
    delete doc.today.date
    doc.today.requests = 9
    writeFileSync(path, JSON.stringify(doc))

    const stats = new Stats({ filePath: path, enabled: () => true })
    try {
      const snapshot = stats.snapshot()
      assert.equal(snapshot.today.requests, 0, '无日期的今日计数不能当成今天')
      assert.equal(snapshot.providerToday.workbuddy.requests, 0, 'provider 维度已清零，页头不能还留着旧数字')
    } finally {
      stats.stop()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Qoder 等位接口缺 serviceAvailable：不写 available，不能被当成「没有容量」', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ isQueued: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  try {
    const identity = { region: 'china', userID: 'u', authToken: 't', machineID: 'm', name: '', email: '' }
    const status = await fetchQueueStatus(identity, { requestSetId: 'r1', modelKey: 'k' })
    assert.equal(status.queued, true)
    assert.equal('available' in status, false, '缺失字段必须保持 undefined，交给错误体里的值决定')
  } finally {
    globalThis.fetch = original
  }
})

test('换号只在候选真的产出内容后才写回设置（正文前失败不钉住坏账号）', async () => {
  const dir = tempDir('switch')
  const original = globalThis.fetch
  const switches = []
  const encoder = new TextEncoder()
  globalThis.fetch = async (url, init) => {
    const auth = String(init?.headers?.Authorization ?? '')
    if (auth.includes('token-a')) {
      return new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })
    }
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"error":{"message":"额度不足","code":110}}\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const settings = defaults()
    settings.workbuddy.workbuddy.authFile = 'Z:\\missing\\workbuddy.info'
    const token = (uid, accessToken) => ({
      accessToken,
      refreshToken: '',
      expiresAtMs: Date.now() + 3600_000,
      refreshExpiresAtMs: 0,
      domain: 'codebuddy.cn',
      uid,
      enterpriseId: '',
    })
    settings.accounts.workbuddy = [
      { id: 'a', label: 'A', enabled: true, token: token('ua', 'token-a') },
      { id: 'b', label: 'B', enabled: true, token: token('ub', 'token-b') },
    ]
    settings.activeAccount.workbuddy = 'a'
    const runtime = new Runtime({
      settings: () => settings,
      dataDir: dir,
      logger: {},
      onAccountSwitch: (provider, accountId) => switches.push({ provider, accountId }),
    })
    try {
      const opened = await runtime.openStream('workbuddy', {
        model: 'hy3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: AbortSignal.timeout(5000),
      })
      await assert.rejects(async () => {
        for await (const _event of opened.events) { /* 消费到失败 */ }
      })
      assert.deepEqual(switches, [], 'B 只拿到了响应头，还没证明可用，不能写回设置')
    } finally {
      runtime.flushCaches()
    }
  } finally {
    globalThis.fetch = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('换凭证时即使没有额度缓存，也要推进删除代数（挡住旧令牌续期写回）', () => {
  const dir = tempDir('epoch')
  try {
    const runtime = new Runtime({ settings: () => defaults(), dataDir: dir, logger: {} })
    runtime.forgetCredentialState([{ provider: 'qoder', accountId: 'x' }])
    assert.equal(runtime.forgetEpoch.get('qoder::x'), 1)
    runtime.forgetCredentialState([{ provider: 'qoder', accountId: 'x' }])
    assert.equal(runtime.forgetEpoch.get('qoder::x'), 2, '每次换凭证都要推进，不能只在有缓存时推进')
    runtime.flushCaches()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('诊断：只有 planUnknown 证据时也要认成 Qoder Free，不能写成「已用尽」', () => {
  const { text } = buildDiagnostics({
    plugin: { version: 'test' },
    providers: [{
      provider: 'qoder',
      displayName: 'Qoder',
      enabled: true,
      credits: { state: 'ok', remain: 0, total: 0, unit: 'credits', exceeded: true, planUnknown: true },
    }],
  }, { now: Date.now() })
  assert.match(text, /Free 付费额度为 0/)
  assert.doesNotMatch(text, /已用尽/)
})

test('删除账号后目录墓碑立刻落盘（不靠 1.5 秒去抖）', async () => {
  const dir = tempDir('catalog')
  try {
    const runtime = new Runtime({ settings: () => defaults(), dataDir: dir, logger: {} })
    runtime.forgetAccount('workbuddy', 'gone')
    // 进程若在这 1.5 秒内退出，墓碑没写进磁盘，重启后又会把已删账号的目录读回来。
    const doc = JSON.parse(readFileSync(join(dir, 'catalog-cache.json'), 'utf8'))
    assert.deepEqual(doc.forgotten, ['workbuddy::gone'])
    runtime.flushCaches()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('测试结果只对发起时的账号有效：期间删号不再写回徽章', async () => {
  const dir = tempDir('late-test')
  const original = globalThis.fetch
  const encoder = new TextEncoder()
  globalThis.fetch = async () => {
    const body = new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
          controller.close()
        }, 60)
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const settings = defaults()
    settings.workbuddy.workbuddy.authFile = 'Z://missing//workbuddy.info'
    settings.accounts.workbuddy = [{
      id: 'a',
      label: 'A',
      enabled: true,
      token: {
        accessToken: 'token-a',
        refreshToken: '',
        expiresAtMs: Date.now() + 3600_000,
        refreshExpiresAtMs: 0,
        domain: 'codebuddy.cn',
        uid: 'ua',
        enterpriseId: '',
      },
    }]
    settings.activeAccount.workbuddy = 'a'
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    // 没有真实目录：直接给这个账号一份目录，避免 testAccount 因 NO_MODEL 提前返回。
    runtime.catalogs.set('workbuddy::a', {
      models: [{ id: 'hy3', name: 'HY3', contextWindow: 128000, maxTokens: 8192, supportsImages: false, supportsReasoning: false, reasoningEfforts: [] }],
      fetchedAt: Date.now(),
      source: 'live',
    })
    try {
      const task = runtime.testAccount('workbuddy', 'a')
      await new Promise((resolve) => setTimeout(resolve, 10))
      runtime.forgetAccount('workbuddy', 'a')
      const result = await task
      assert.equal(result.ok, true, '测试本身应该成功')
      assert.equal(runtime.lastTestFor('workbuddy', 'a'), undefined, '已删账号不能继承这次测试结论')
      assert.deepEqual(runtime.modelTestsFor('workbuddy', 'a'), {}, '账号 × 模型结论同样不能写回')
    } finally {
      runtime.flushCaches()
    }
  } finally {
    globalThis.fetch = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('测试一个不存在的账号：返回 NO_ACCOUNT，但不留下会传染给新账号的徽章', async () => {
  const dir = tempDir('ghost-test')
  try {
    const runtime = new Runtime({ settings: () => defaults(), dataDir: dir, logger: {} })
    const result = await runtime.testAccount('workbuddy', 'ghost')
    assert.equal(result.code, 'NO_ACCOUNT')
    assert.equal(runtime.lastTestFor('workbuddy', 'ghost'), undefined)
    runtime.flushCaches()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
