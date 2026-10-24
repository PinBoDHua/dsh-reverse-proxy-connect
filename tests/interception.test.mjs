// 回归：2026-10-21 19:02–19:05 的「HTTP 400 请求被拦截，请重新发送」。
//
// 现场证据（stats.json 的 recent 与当时的设置卡片）：
//   - 同一账号、同一模型，失败的 400 只用 266–287ms 就返回 —— 请求没进模型，是网关拒的；
//   - 8 秒后同账号同模型的 1-token 测试返回 200；
//   - 按同样的请求形状（21KB 系统提示词 + 工具表 + max_tokens=128000 + 并发）重放 13 次全部 200。
// 所以这是**上游短时拦截**，语义是「重发一次」。旧实现把它归成 `upstream-error`，
// 而宿主的可重试表里没有这个码 → 一次拦截结束整轮，用户只能手动重发。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { finishError } from '../lib/adapter.js'
import { Runtime } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'
import { isInterceptedReply, openChatStream, UpstreamFailure } from '../lib/workbuddy/upstream.js'

const CREDENTIAL = Object.freeze({
  accessToken: 'token-x',
  refreshToken: 'refresh-x',
  expiresAtMs: Date.now() + 3_600_000,
  refreshExpiresAtMs: Date.now() + 86_400_000,
  domain: '',
  uid: 'uid-x',
  enterpriseId: '',
})

/** 上游拦截时的响应体（与线上原文一致）。 */
const INTERCEPTED_BODY = JSON.stringify({
  code: 10000,
  msg: '请求被拦截，请重新发送',
  displayMsg: { zh: '请求被拦截，请重新发送', en: 'Request intercepted, please resend' },
  requestId: 'req-42',
})

/** 一条最小的合法 SSE 响应（正文 + [DONE]）。 */
function sseResponse(text = 'ok') {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('只把上游「请重新发送」类的 400/403 判成拦截', () => {
  assert.equal(isInterceptedReply(INTERCEPTED_BODY, 400), true)
  assert.equal(isInterceptedReply('{"msg":"请求被拦截，请重新发送"}', 403), true)
  assert.equal(isInterceptedReply('Request intercepted, please resend', 400), true)
  // 状态不对：429 是限流、500 是服务端，各有各的处理，不该走这条重发路径。
  assert.equal(isInterceptedReply(INTERCEPTED_BODY, 429), false)
  assert.equal(isInterceptedReply(INTERCEPTED_BODY, 500), false)
  // 确定性的 400 不能重试三遍：模型不支持 / 思考强度不支持 / 参数错。
  assert.equal(isInterceptedReply('{"msg":"当前账号类型暂不支持该模型"}', 400), false)
  assert.equal(isInterceptedReply('{"msg":"模型不支持该思考强度，请调整"}', 400), false)
  assert.equal(isInterceptedReply('', 400), false)
})

test('被拦截时换一组会话 id 立刻重发，第二次成功', async () => {
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (_url, init) => {
    seen.push({
      conversation: init?.headers?.['X-Conversation-ID'],
      request: init?.headers?.['X-Conversation-Request-ID'],
    })
    if (seen.length === 1) {
      return new Response(INTERCEPTED_BODY, { status: 400, headers: { 'content-type': 'application/json' } })
    }
    return sseResponse('ok')
  }
  try {
    const response = await openChatStream('workbuddy', CREDENTIAL, '{"model":"m","stream":true}')
    assert.equal(response.status, 200)
    assert.equal(seen.length, 2, '第一次被拦后必须再发一次')
    assert.notEqual(seen[0].conversation, seen[1].conversation, '重发必须换新的会话 id（同一组会被当成重放）')
    assert.notEqual(seen[0].request, seen[1].request)
    // 成功前被拦的次数要暴露给运行时：拦截被就地自愈时事件账本靠它留痕。
    assert.equal(response.interceptionRetries, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('拦截被就地自愈时，运行时把它写进事件账本（info，60 秒去重）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-recover-'))
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls <= 2) {
      return new Response(INTERCEPTED_BODY, { status: 400, headers: { 'content-type': 'application/json' } })
    }
    return sseResponse('ok')
  }
  const recorded = []
  try {
    const runtime = deepTestRuntime(dir)
    runtime.events = { record: (input, options) => { recorded.push({ input, options }); return true } }
    const opened = await runtime.openStream('workbuddy', { model: 'm1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], noFailover: true })
    for await (const event of opened.events) {
      if (event.type === 'finish') break
    }
    await opened.close?.()
    assert.equal(calls, 3, '两次拦截 + 第三次成功')
    const note = recorded.find((entry) => entry.input?.type === 'upstream' && entry.input?.data?.recovered === true)
    assert.ok(note !== undefined, '拦截自愈必须留痕（否则只有三次都失败才可见）')
    assert.equal(note.input.level, 'info')
    assert.equal(note.input.accountId, 'a')
    assert.equal(note.input.messageKey.key, 'eventUpstreamRecovered')
    assert.equal(note.input.messageKey.params.attempts, 2)
    assert.equal(note.options?.dedupeMs, 60_000)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('三次都被拦截：抛 soft-rate（宿主可重试）并保留原始响应体', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response(INTERCEPTED_BODY, { status: 400, headers: { 'content-type': 'application/json' } })
  }
  try {
    await assert.rejects(
      () => openChatStream('workbuddy', CREDENTIAL, '{"model":"m","stream":true}'),
      (error) => {
        assert.ok(error instanceof UpstreamFailure)
        assert.equal(error.code, 'soft-rate')
        assert.equal(error.kind, 'soft-rate')
        assert.equal(error.status, 400)
        // 排障要看原文里的 code / requestId，不能只剩一句被截断的中文。
        assert.match(String(error.responseBody), /请求被拦截/)
        assert.match(String(error.responseBody), /req-42/)
        return true
      },
    )
    assert.equal(calls, 3, '首次 + 2 次重发')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('普通 400 不重试，仍是 upstream-error', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('{"msg":"模型不存在"}', { status: 400, headers: { 'content-type': 'application/json' } })
  }
  try {
    await assert.rejects(
      () => openChatStream('workbuddy', CREDENTIAL, '{"model":"m","stream":true}'),
      (error) => {
        assert.equal(error.code, 'upstream-error')
        assert.equal(error.status, 400)
        assert.match(String(error.responseBody), /模型不存在/)
        return true
      },
    )
    assert.equal(calls, 1, '确定性 400 不该重发')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('soft-rate 在适配器层映射成 RATE_LIMIT（宿主会按退避重试，而不是结束整轮）', () => {
  const failure = new UpstreamFailure('soft-rate', 'WorkBuddy 聊天返回 HTTP 400：请求被拦截，请重新发送', 400, undefined, undefined, 'soft-rate', INTERCEPTED_BODY)
  const chunk = finishError(failure)
  assert.equal(chunk.type, 'finish')
  assert.equal(chunk.reason.kind, 'error')
  assert.equal(chunk.reason.failure.code, 'RATE_LIMIT')
  assert.equal(chunk.reason.failure.status, 400)
})

// ---------- 深度测试 ----------

/** 只启用 workbuddy、带一个账号与一条目录的运行时。 */
function deepTestRuntime(dir) {
  const settings = defaults()
  for (const provider of ['workbuddy-ai', 'qoder', 'qoder-global', 'trae', 'trae-global']) {
    settings.providers[provider].enabled = false
  }
  settings.accounts.workbuddy = [{ id: 'a', label: '账号 A', enabled: true, token: { ...CREDENTIAL } }]
  settings.activeAccount.workbuddy = 'a'
  const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
  runtime.catalogs.set('workbuddy::a', {
    models: [{ id: 'm1', name: 'M1', contextWindow: 128_000, maxTokens: 8_192, supportsImages: false, supportsReasoning: false, onlyReasoning: false, reasoningEfforts: [] }],
    source: 'live',
    fetchedAt: Date.now(),
  })
  return runtime
}

test('深度测试按真实对话请求的形状发（系统提示词 + 工具表 + 正常输出上限）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-deep-'))
  try {
    const runtime = deepTestRuntime(dir)
    let captured
    runtime.openStream = async (_provider, request) => {
      captured = request
      return {
        events: (async function* () {
          yield { type: 'text', text: '可用' }
          yield { type: 'finish', kind: 'stop' }
        })(),
        close: async () => {},
      }
    }
    const result = await runtime.testAccount('workbuddy', 'a', 'm1', { deep: true })
    assert.equal(result.ok, true)
    assert.equal(result.deep, true)
    assert.equal(typeof captured.system, 'string')
    assert.ok(captured.system.length > 0, '深度测试必须带系统提示词')
    assert.ok(Array.isArray(captured.tools) && captured.tools.length > 0, '深度测试必须带工具表')
    assert.equal(captured.maxTokens, 512, '不能用 1 token：那正是普通测试测不出问题的原因')
    assert.equal(captured.probe, true, '深度测试也不该写进用量统计 / 触发换号')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('普通测试仍然只发 ping + 1 token（便宜、可用于能力探测）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-shallow-'))
  try {
    const runtime = deepTestRuntime(dir)
    let captured
    runtime.openStream = async (_provider, request) => {
      captured = request
      return {
        events: (async function* () {
          yield { type: 'finish', kind: 'stop' }
        })(),
        close: async () => {},
      }
    }
    const result = await runtime.testAccount('workbuddy', 'a', 'm1')
    assert.equal(result.ok, true)
    assert.equal(result.deep, undefined)
    assert.equal(captured.maxTokens, 1)
    assert.equal(captured.system, undefined)
    assert.equal(captured.tools, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('深度测试遇到 200 空响应要报失败（普通测试不查这一点）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-deep-empty-'))
  try {
    const runtime = deepTestRuntime(dir)
    runtime.openStream = async () => ({
      events: (async function* () {
        yield { type: 'finish', kind: 'stop' }
      })(),
      close: async () => {},
    })
    const result = await runtime.testAccount('workbuddy', 'a', 'm1', { deep: true })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'EMPTY_RESPONSE')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
