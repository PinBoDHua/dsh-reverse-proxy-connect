import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildChatEnvelope,
  classifyUpstreamBody,
  encodeBody,
  parseCatalog as parseQoderCatalog,
  parseRetryAfter as parseQoderRetryAfter,
  parseStream as parseQoderStream,
  finishKind,
  normalizeUsage,
  translateMessages,
  translateTools,
} from '../lib/qoder/transport.js'
import { prepareChatBody, parseCatalog as parseWorkBuddyCatalog, parseRetryAfter } from '../lib/workbuddy/upstream.js'
import { openAiFinishKind, normalizeOpenAiUsage, parseOpenAiSse, qoderQueueFailure, failureCodeOf, isFailoverCode, toOpenAiMessages, toOpenAiTools, accountLimitation } from '../lib/runtime.js'
import { toModelInfo, toResolvedModelInfo, failureCode, stableFailureCode, ReverseProxyAdapter } from '../lib/adapter.js'
import { defaults, normalize, providerOptions, isModelVisible } from '../lib/settings.js'
import { withTimeout } from '../lib/timeout.js'

test('Retry-After：秒数与 HTTP 日期都能解析，且夹到 10 分钟', () => {
  const now = Date.parse('2026-10-18T12:00:00Z')
  assert.equal(parseRetryAfter('30', now), 30_000)
  assert.equal(parseRetryAfter('600', now), 600_000)
  assert.equal(parseRetryAfter('99999', now), 600_000)
  assert.equal(parseRetryAfter('Sun, 18 Oct 2026 12:01:00 GMT', now), 60_000)
  assert.equal(parseRetryAfter('Sun, 18 Oct 2026 11:59:00 GMT', now), 0)
  assert.equal(parseRetryAfter('', now), undefined)
  assert.equal(parseRetryAfter('soon', now), undefined)
})

test('withTimeout：外部取消与单请求超时取并集，不能被 signal 覆盖掉超时', async () => {
  // 旧写法 `signal ?? AbortSignal.timeout(ms)` 在调用方传了 signal 时
  // 永远走左边 —— 上游挂死的那次请求会一直挂着。这里锁住「两者都生效」。
  const controller = new AbortController()
  const merged = withTimeout(controller.signal, 5_000)
  assert.notEqual(merged, controller.signal, '不能把外部 signal 原样返回，否则超时丢失')
  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(merged.aborted, true, '外部取消必须立即生效')

  // 只有超时、没有外部 signal 时按超时 abort。
  const timed = withTimeout(undefined, 30)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(timed.aborted, true)

  // 传非法毫秒也不该抛错，而是当成 1ms 的超时。
  assert.ok(withTimeout(undefined, 0) !== undefined)
  assert.ok(withTimeout(undefined, Number.NaN) !== undefined)
})

test('WAF 编码可逆且长度为 4 的倍数', () => {
  const encoded = encodeBody('{"a":1}')
  assert.equal(encoded.length, Buffer.from('{"a":1}').toString('base64').length)
  // 自定义字母表里的字符，且不再含标准 base64 的 `=`。
  assert.ok(!encoded.includes('='))
  assert.ok(!encoded.includes('['))
})

test('Qoder 目录只保留 enable=true 的 chat 模型并解析上下文/档位', () => {
  const models = parseQoderCatalog({
    chat: [
      {
        key: 'qfmodel',
        display_name: 'Qwen3.8-Flash',
        enable: true,
        is_vl: true,
        is_reasoning: true,
        price_factor: 0,
        max_input_tokens: 180000,
        max_output_tokens: 32768,
        context_config: { '200K': { token_count: 200000, is_default: true }, '1M': { token_count: 1000000 } },
        thinking_config: { enabled: { efforts: { xhigh: {}, low: {}, medium: { is_default: true } } } },
      },
      { key: 'offmodel', enable: false, display_name: 'Off' },
    ],
  })
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'qfmodel')
  assert.equal(models[0].contextWindow, 200000)
  assert.equal(models[0].maxTokens, 32768)
  assert.equal(models[0].supportsImages, true)
  assert.deepEqual(models[0].reasoningEfforts, ['low', 'medium', 'xhigh'])
  assert.equal(models[0].defaultEffort, 'medium')
  assert.equal(models[0].credits, 'x0')
  assert.equal(models[0].canDisableThinking, false)
})

test('Qoder envelope 带 context_config 与 reasoning_effort，且 system 走 messages', () => {
  const row = {
    id: 'qfmodel',
    maxTokens: 8192,
    supportsReasoning: true,
    source: 'system',
    contextOptions: { '200K': { tokenCount: 200000, isDefault: true }, '1M': { tokenCount: 1000000 } },
  }
  const envelope = buildChatEnvelope({
    model: 'qfmodel',
    modelRow: row,
    sessionUser: 'user-1',
    body: {
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 128,
      reasoning_effort: 'low',
    },
  })
  assert.equal(envelope.model_config.key, 'qfmodel')
  assert.equal(envelope.model_config.max_output_tokens, 128)
  assert.equal(envelope.parameters.reasoning_effort, 'low')
  assert.deepEqual(Object.keys(envelope.model_config.context_config).sort(), ['1M', '200K'])
  assert.equal(envelope.messages[0].role, 'system')
  // 上下文窗口不作为数字直接发送（上游只认 context_config）。
  assert.equal(envelope.model_config.context_window, undefined)
})

test('Qoder 消息翻译：空 assistant 补空格、tool 带 tool_call_id', () => {
  const out = translateMessages([
    { role: 'assistant', content: '' },
    { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
    { role: 'developer', content: 'dev' },
  ])
  assert.equal(out[0].content, ' ')
  assert.equal(out[1].role, 'tool')
  assert.equal(out[1].tool_call_id, 'call-1')
  assert.equal(out[2].role, 'system')
})

test('Qoder finish kind：见过 tool_calls 就以 tool-calls 为准', () => {
  assert.equal(finishKind('stop', true), 'tool-calls')
  assert.equal(finishKind('stop', false), 'stop')
  assert.equal(finishKind('length', false), 'max-tokens')
  assert.equal(finishKind('tool_calls', false), 'tool-calls')
})

test('Qoder usage 把 cache 从 prompt 里扣掉', () => {
  const usage = normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } })
  assert.equal(usage.inputTokens, 70)
  assert.equal(usage.outputTokens, 20)
  assert.equal(usage.cacheReadTokens, 30)
})

test('WorkBuddy 请求体修正：developer→system、流式、首条 system、tool_choice 扁平化', () => {
  const prepared = JSON.parse(
    prepareChatBody(
      JSON.stringify({
        stream: false,
        reasoning_effort: 'off',
        messages: [{ role: 'developer', content: 'x' }],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      }),
    ),
  )
  assert.equal(prepared.stream, true)
  assert.equal(prepared.reasoning_effort, undefined)
  assert.equal(prepared.messages[0].role, 'system')
  assert.equal(prepared.tool_choice, 'get_weather')
})

test('WorkBuddy 目录按 cli 花名册取交集，虚拟 id 保留为保守默认', () => {
  const models = parseWorkBuddyCatalog(
    {
      agents: [{ name: 'cli', models: ['a', 'b', 'auto'] }],
      models: [
        { id: 'a', name: 'A', maxInputTokens: 1000, maxOutputTokens: 100, supportsImages: false },
        { id: 'b', name: 'B', maxInputTokens: 2000, maxOutputTokens: 200, supportsImages: true, supportsReasoning: true, reasoning: { supportedEfforts: ['low', 'max'] } },
        { id: 'c', name: 'C', maxInputTokens: 500, maxOutputTokens: 50 },
      ],
    },
    'workbuddy',
  )
  // `auto` 是虚拟 id：不在 models[] 里但确实能聊，所以保留。
  assert.deepEqual(models.map((model) => model.id), ['a', 'b', 'auto'])
  assert.equal(models[1].supportsImages, true)
  assert.deepEqual(models[1].reasoningEfforts, ['low', 'max'])
  assert.equal(models[2].virtual, true)
  assert.equal(models[2].name, 'Auto')
})

test('WorkBuddy 目录：重复 id 只保留第一份（宿主会拒绝整份重复目录）', () => {
  const models = parseWorkBuddyCatalog(
    {
      agents: [{ name: 'cli', models: ['dup', 'dup', 'ok'] }],
      models: [
        { id: 'dup', name: 'First', maxInputTokens: 1000, maxOutputTokens: 100 },
        { id: 'dup', name: 'Second', maxInputTokens: 2000, maxOutputTokens: 200 },
        { id: 'ok', name: 'OK', maxInputTokens: 3000, maxOutputTokens: 300 },
      ],
    },
    'workbuddy',
  )
  assert.deepEqual(models.map((model) => model.id), ['dup', 'ok'])
  assert.equal(models.length, 2)
})

test('WorkBuddy：没有 cli 花名册时必须报错，而不是退到 agents[0]', () => {
  assert.throws(
    () =>
      parseWorkBuddyCatalog(
        {
          // App 身份会返回 craft/ask/plan，没有 cli —— 拿它当花名册会得到假目录。
          agents: [{ name: 'craft', models: ['x'] }],
          models: [{ id: 'x', maxInputTokens: 1000, maxOutputTokens: 100 }],
        },
        'workbuddy',
      ),
    /没有 cli 花名册/,
  )
})

test('WorkBuddy：隐含 effort（只有 reasoning.effort）被收敛成唯一可选档位', () => {
  const models = parseWorkBuddyCatalog(
    {
      agents: [{ name: 'cli', models: ['glm-5.1', 'hy3'] }],
      models: [
        // glm-5.1：有 reasoning 但没 supportedEfforts —— 上游要求显式发 effort。
        { id: 'glm-5.1', name: 'GLM-5.1', maxInputTokens: 200000, maxOutputTokens: 48000, supportsReasoning: true, reasoning: { effort: 'medium', summary: 'auto' } },
        // hy3：完全没有 reasoning —— 发不发都行。
        { id: 'hy3', name: 'Hy3', maxInputTokens: 192000, maxOutputTokens: 64000, supportsReasoning: true },
      ],
    },
    'workbuddy',
  )
  assert.deepEqual(models[0].reasoningEfforts, ['medium'])
  assert.equal(models[0].defaultEffort, 'medium')
  assert.deepEqual(models[1].reasoningEfforts, [])
})

test('prepareChatBody 只在模型有隐含档位时补 reasoning_effort', () => {
  const single = JSON.parse(prepareChatBody(JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }), 'medium'))
  assert.equal(single.reasoning_effort, 'medium')

  const none = JSON.parse(prepareChatBody(JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }), undefined))
  assert.equal(none.reasoning_effort, undefined)

  // 调用方显式给了档位时不覆盖。
  const explicit = JSON.parse(prepareChatBody(JSON.stringify({ messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'high' }), 'medium'))
  assert.equal(explicit.reasoning_effort, 'high')

  // off 仍然删除，且不会被隐含档位顶回来。
  const off = JSON.parse(prepareChatBody(JSON.stringify({ messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'off' }), 'medium'))
  assert.equal(off.reasoning_effort, 'medium')
})

test('Qoder 普通 HTTP 429/402 按限流/额度处理，不再落成 malformed', () => {
  const limited = classifyUpstreamBody('{"message":"Too Many Requests"}', 429)
  assert.equal(limited.kind, 'soft-rate')
  assert.equal(limited.status, 429)
  const quota = classifyUpstreamBody('', 402)
  assert.equal(quota.kind, 'quota')
  assert.equal(quota.status, 402)
  // 401/403 仍然是认证失败，不受新分支影响。
  assert.equal(classifyUpstreamBody('<html>forbidden</html>', 403).kind, 'auth')
})

test('Qoder 限流：响应体没给等待时间时读 Retry-After 头', () => {
  // 网关/WAF 层限流通常只有标准头，没有 retryAfterSeconds。
  const fromHeader = classifyUpstreamBody('{"message":"Too Many Requests"}', 429, '30')
  assert.equal(fromHeader.kind, 'soft-rate')
  assert.equal(fromHeader.retryAfterMs, 30_000)

  // HTTP 日期形式同样支持：给一个「20 秒后」的日期（相对真实 now，否则会被夹到上限）。
  const now = Date.now()
  const fromDate = classifyUpstreamBody('', 429, new Date(now + 20_000).toUTCString())
  assert.equal(typeof fromDate.retryAfterMs, 'number')
  assert.ok(
    fromDate.retryAfterMs >= 18_000 && fromDate.retryAfterMs <= 21_000,
    `日期形式的等待量不对：${String(fromDate.retryAfterMs)}`,
  )

  // body 里的 retryAfterSeconds 优先于头。
  const fromBody = classifyUpstreamBody('{"isQueued":true,"retryAfterSeconds":12}', 429, '30')
  assert.equal(fromBody.retryAfterMs, 12_000)
  assert.equal(fromBody.kind, 'soft-rate')

  // 解析器本身：秒数、日期、垃圾值、上限。
  assert.equal(parseQoderRetryAfter('45'), 45_000)
  assert.equal(parseQoderRetryAfter(''), undefined)
  assert.equal(parseQoderRetryAfter('not-a-date'), undefined)
  assert.ok(parseQoderRetryAfter('99999') <= 10 * 60_000, '超过 10 分钟要夹住')
  // HTTP 日期只精确到秒，给 1.5 秒容差。
  const dated = parseQoderRetryAfter(new Date(now + 20_000).toUTCString(), now)
  assert.ok(Math.abs(dated - 20_000) < 1_500, `日期解析偏差过大：${String(dated)}`)
  // 已经过去的日期夹到 0，不会是负数。
  assert.equal(parseQoderRetryAfter(new Date(now - 60_000).toUTCString(), now), 0)
})

test('Qoder PAT 失效：错误码优先于默认 kind=server，分类为 AUTH', () => {
  const failure = classifyUpstreamBody('', 403)
  assert.equal(failure.kind, 'auth')
  const patError = Object.assign(new Error('Qoder 拒绝了该个人访问令牌'), {
    name: 'QoderFailure',
    code: 'pat-invalid',
    kind: 'server',
    status: 401,
  })
  assert.equal(failureCodeOf(patError), 'AUTH')
  assert.equal(isFailoverCode(failureCodeOf(patError)), true)
})

test('SSE 末行没有换行时也要处理，不能丢最后一段正文/终态', async () => {
  const encoder = new TextEncoder()
  const openai = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"tail"}}]}'))
      controller.close()
    },
  })
  const openaiEvents = []
  for await (const event of parseOpenAiSse(openai)) openaiEvents.push(event)
  // 心跳是给空闲看门狗看的内部信号，这里只断言真正的内容事件。
  const openaiTypes = openaiEvents.filter((event) => event.type !== 'heartbeat').map((event) => event.type)
  assert.equal(openaiTypes.join(','), 'text,finish')
  assert.equal(openaiEvents.find((event) => event.type === 'text').text, 'tail')

  const qoder = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: 'tail' }, finish_reason: 'length' }] }) })}`))
      controller.close()
    },
  })
  const qoderEvents = []
  for await (const event of parseQoderStream(qoder)) qoderEvents.push(event)
  const qoderTypes = qoderEvents.filter((event) => event.type !== 'heartbeat').map((event) => event.type)
  assert.equal(qoderTypes.join(','), 'text,finish')
  assert.equal(qoderEvents.at(-1).kind, 'max-tokens')
})

test('WorkBuddy 目录：disabled 的模型即使还在花名册里也不能复活成 virtual', () => {
  const models = parseWorkBuddyCatalog({
    agents: [{ name: 'cli', models: ['auto', 'retired-model', 'live-model'] }],
    models: [
      { id: 'retired-model', name: 'Retired', disabled: true, maxInputTokens: 1000, maxOutputTokens: 100 },
      { id: 'live-model', name: 'Live', maxInputTokens: 1000, maxOutputTokens: 100 },
    ],
  }, 'workbuddy')
  assert.deepEqual(models.map((model) => model.id), ['auto', 'live-model'])
  assert.equal(models[0].virtual, true)
  assert.equal(models[1].supportsImages, false)
})

test('OpenAI SSE 终态与 usage 归一化', () => {
  assert.equal(openAiFinishKind('stop', true), 'tool-calls')
  assert.equal(openAiFinishKind('length', false), 'max-tokens')
  // 被 max_tokens 截断时，即使已经发过 tool_calls 也必须报 max-tokens：
  // 截断的工具参数一定不完整，报成 tool-calls 会让宿主拿半截参数执行工具。
  assert.equal(openAiFinishKind('length', true), 'max-tokens', '截断优先于 tool-calls')
  assert.equal(openAiFinishKind('content_filter', true), 'error', '内容拦截优先于 tool-calls')
  assert.equal(openAiFinishKind('tool_calls', false), 'tool-calls')
  const usage = normalizeOpenAiUsage({
    prompt_tokens: 50,
    completion_tokens: 10,
    prompt_cache_hit_tokens: 20,
    completion_thinking_tokens: 4,
  })
  assert.equal(usage.inputTokens, 30)
  assert.equal(usage.cacheReadTokens, 20)
  assert.equal(usage.reasoningTokens, 4)
})

test('截断的工具调用：端到端终态是 max-tokens，不会让宿主执行半截参数', async () => {
  // 上游先发 tool_call 分片（arguments 是一段被截断的 JSON），再发 finish_reason=length。
  const frames = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":"{\\"path\\":\\"C:\\\\tmp\\\\a"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
    'data: [DONE]',
  ]
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${frames.join('\n\n')}\n\n`))
      controller.close()
    },
  })
  const events = []
  for await (const event of parseOpenAiSse(body)) events.push(event)
  const finish = events.find((event) => event.type === 'finish')
  assert.equal(finish.kind, 'max-tokens', '截断的工具调用不能被上报成 tool-calls')
  // 工具分片本身照常产出（宿主需要看到它才能决定怎么收尾）。
  assert.ok(events.some((event) => event.type === 'tool'))
})

test('Qoder 排队超时：给出 RATE_LIMIT 与明确文案，而不是空等两分钟', () => {
  const error = qoderQueueFailure({ retryAfterMs: 30_000 }, 61_000, 60_000)
  assert.equal(error.kind, 'soft-rate')
  assert.equal(error.status, 429)
  assert.equal(error.retryAfterMs, 30_000)
  assert.match(error.message, /排队/)
  assert.match(error.message, /61 秒/)
  assert.match(error.message, /不是令牌失效/)
  // 次数用尽与时间用尽要能区分，不能出现「已等待 2 秒，超过 45 秒上限」。
  const attempts = qoderQueueFailure({}, 2_000, 60_000, { attemptsExhausted: true })
  assert.match(attempts.message, /重开次数已用尽/)
})

test('OpenAI SSE：finish_reason 之后的 usage 不会丢失，finish 永远在最后', async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'))
      // OpenAI 的 include_usage 就是这样：finish_reason 之后再单独发 usage。
      controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\n'))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  const events = []
  for await (const event of parseOpenAiSse(body)) events.push(event)
  const kinds = events.map((event) => event.type)
  assert.deepEqual(kinds, ['text', 'usage', 'finish'])
  assert.equal(events[1].usage.inputTokens, 10)
  assert.equal(events[2].kind, 'stop')
})

test('Qoder SSE：finish_reason 之后的 usage 不会丢，finish 永远在最后且只出现一次', async () => {
  const encoder = new TextEncoder()
  const inner = (value) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(value) })}\n\n`
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(inner({ choices: [{ delta: { content: 'hi' } }] })))
      controller.enqueue(encoder.encode(inner({ choices: [{ delta: {}, finish_reason: 'stop' }] })))
      // Qoder 与 OpenAI 一样，可能先给 finish_reason，再单独给 usage。
      controller.enqueue(encoder.encode(inner({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } })))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  const events = []
  for await (const event of parseQoderStream(body)) events.push(event)
  assert.deepEqual(events.map((event) => event.type), ['text', 'usage', 'finish'])
  assert.equal(events[1].usage.inputTokens, 10)
  assert.equal(events[2].kind, 'stop')
})

test('Qoder SSE：取消不能被当成正常结束（否则 adapter 会补一个成功的 finish）', async () => {
  const controller = new AbortController()
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(streamController) {
      streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: 'x' } }] }) })}\n\n`))
      // 不关闭：模拟上游一直挂着。先 abort 再迭代，解析器必须在循环顶部抛取消。
      controller.abort()
    },
  })
  await assert.rejects(
    async () => {
      for await (const _event of parseQoderStream(body, controller.signal)) {
        /* 不应该有内容 */
      }
    },
    (error) => error?.code === 'ABORTED',
  )
})

test('Qoder SSE：statusCodeValue 是字符串时也能识别 200 / 429', async () => {
  const encoder = new TextEncoder()
  const ok = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ statusCodeValue: '200', body: JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) })}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  const events = []
  for await (const event of parseQoderStream(ok)) events.push(event)
  assert.equal(events.map((event) => event.type).join(','), 'text,finish')

  const limited = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ statusCodeValue: '429', body: JSON.stringify({ code: '10605', isQueued: true, retryAfterSeconds: 30 }) })}\n\n`))
      controller.close()
    },
  })
  await assert.rejects(
    async () => {
      for await (const _event of parseQoderStream(limited)) {
        /* 不应该有内容 */
      }
    },
    (error) => error?.kind === 'soft-rate' && error?.retryAfterMs === 30_000,
  )
})

test('OpenAI SSE：取消不能被当成正常结束', async () => {
  const controller = new AbortController()
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(streamController) {
      streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'))
      controller.abort()
    },
  })
  await assert.rejects(
    async () => {
      for await (const _event of parseOpenAiSse(body, controller.signal)) {
        /* 不应该有内容 */
      }
    },
    (error) => error?.code === 'ABORTED',
  )
})

test('DSH 消息 → OpenAI 消息：tool-call 合成 tool_calls，tool 角色带 id', () => {
  const messages = toOpenAiMessages([
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: 'call-1', name: 'get_weather', arguments: '{"city":"Beijing"}' },
      ],
    },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'sunny' }] },
    { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
  ])
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[1].tool_calls[0].id, 'call-1')
  assert.equal(messages[2].role, 'tool')
  assert.equal(messages[2].tool_call_id, 'call-1')
  assert.equal(messages[3].content, 'thanks')
})

test('适配器：流中途失败也要关掉已经打开的文本/工具块', async () => {
  const adapter = new ReverseProxyAdapter({
    openStream: async () => ({
      events: (async function* () {
        yield { type: 'text', text: 'hi' }
        yield { type: 'tool', index: 0, id: 'call-1', name: 'f', argumentsDelta: '{}' }
        throw new Error('连接中断')
      })(),
      close: async () => undefined,
    }),
    listModels: async () => [],
    resolveModel: async () => undefined,
    canAcceptImages: () => false,
    showRateInModelName: () => false,
  })
  const chunks = []
  for await (const chunk of adapter.streamWithMeta({ provider: 'workbuddy', model: 'm' }, {
    id: 'm',
    name: 'M',
    contextWindow: 1000,
    maxTokens: 100,
    inputModalities: ['text'],
  })) chunks.push(chunk)
  assert.deepEqual(chunks.map((chunk) => chunk.type), [
    'block-start',
    'text-delta',
    'block-end',
    'tool-call-delta',
    'block-end',
    'finish',
  ])
  assert.equal(chunks[2].block.text, 'hi')
  assert.equal(chunks[4].block.type, 'tool-call')
  assert.equal(chunks[5].reason.kind, 'error')
})

test('适配器：工具块首片等 name 到位，id 与 name 不同步也不会拆成两段', async () => {
  const adapter = new ReverseProxyAdapter({
    openStream: async () => ({
      events: (async function* () {
        // OpenAI 兼容上游常见顺序：先给 arguments，下一片才补 name。
        yield { type: 'tool', index: 0, id: 'call_1', name: '', argumentsDelta: '{"city":' }
        yield { type: 'tool', index: 0, id: '', name: 'get_weather', argumentsDelta: '"Beijing"}' }
        yield { type: 'finish', kind: 'tool-calls' }
      })(),
      close: async () => undefined,
    }),
    listModels: async () => [],
    resolveModel: async () => undefined,
    canAcceptImages: () => false,
    showRateInModelName: () => false,
  })
  const chunks = []
  for await (const chunk of adapter.streamWithMeta({ provider: 'workbuddy', model: 'm' }, {
    id: 'm',
    name: 'M',
    contextWindow: 1000,
    maxTokens: 100,
    inputModalities: ['text'],
  })) chunks.push(chunk)

  const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(deltas.length, 1, '整个工具调用只应发一片首片')
  assert.equal(deltas[0].id, 'call_1')
  assert.equal(deltas[0].name, 'get_weather', '宿主按 name 认工具块，首片必须带名字')
  assert.equal(deltas[0].argumentsDelta, '{"city":"Beijing"}', '先到的参数要攒进首片，不能丢')
  const ends = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.equal(ends.length, 1)
  assert.equal(ends[0].block.arguments, '{"city":"Beijing"}')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('适配器：上游不给 name 时也要在收尾把工具块补出去', async () => {
  const adapter = new ReverseProxyAdapter({
    openStream: async () => ({
      events: (async function* () {
        yield { type: 'tool', index: 0, id: 'call_x', name: '', argumentsDelta: '{}' }
        yield { type: 'finish', kind: 'stop' }
      })(),
      close: async () => undefined,
    }),
    listModels: async () => [],
    resolveModel: async () => undefined,
    canAcceptImages: () => false,
    showRateInModelName: () => false,
  })
  const chunks = []
  for await (const chunk of adapter.streamWithMeta({ provider: 'workbuddy', model: 'm' }, {
    id: 'm',
    name: 'M',
    contextWindow: 1000,
    maxTokens: 100,
    inputModalities: ['text'],
  })) chunks.push(chunk)
  const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(deltas.length, 1, '残缺响应也要发一片首片，否则宿主看不到工具块')
  assert.equal(deltas[0].id, 'call_x')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('适配器：断流时 usage 合计也要含缓存 token', async () => {
  const adapter = new ReverseProxyAdapter({
    openStream: async () => ({
      events: (async function* () {
        yield { type: 'text', text: 'hi' }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 900 } }
        // 没有 finish：上游直接断流
      })(),
      close: async () => undefined,
    }),
    listModels: async () => [],
    resolveModel: async () => undefined,
    canAcceptImages: () => false,
    showRateInModelName: () => false,
  })
  const chunks = []
  for await (const chunk of adapter.streamWithMeta({ provider: 'workbuddy', model: 'm' }, {
    id: 'm',
    name: 'M',
    contextWindow: 1000,
    maxTokens: 100,
    inputModalities: ['text'],
  })) chunks.push(chunk)
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.equal(usage.usage.totalTokens, 912, 'input+output+cacheRead 才是真实合计')
})

test('tools 翻译丢掉 deferLoading 之外的一切无关字段', () => {
  const tools = toOpenAiTools([
    { name: 'a', description: 'A', parameters: { type: 'object' }, deferLoading: true },
    { name: 'b', description: 'B', parameters: { type: 'object', properties: {} } },
  ])
  assert.equal(tools.length, 2)
  assert.equal(tools[0].function.name, 'a')
})

test('适配器模型信息：reasoning.efforts 必须由弱到强且带中文名', () => {
  const info = toResolvedModelInfo('qoder', {
    id: 'm',
    name: 'M',
    contextWindow: 1000,
    maxTokens: 100,
    supportsImages: false,
    reasoningEfforts: ['xhigh', 'low', 'medium'],
    defaultEffort: 'medium',
  })
  assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['low', 'medium', 'xhigh'])
  assert.equal(info.reasoning.defaultEffort, 'medium')
  assert.equal(info.context.contextWindow, 1000)
  assert.equal(info.defaultMaxTokens, 100)
  assert.deepEqual(info.inputModalities, ['text'])
})

test('失败种类映射到 DSH 的稳定 code', () => {
  assert.equal(failureCode('soft-rate'), 'RATE_LIMIT')
  assert.equal(failureCode('quota'), 'QUOTA')
  assert.equal(failureCode('auth'), 'AUTH')
  assert.equal(failureCode('weird'), 'upstream-error')
  // 内部码不能原样透给宿主。
  assert.equal(stableFailureCode('image-unavailable'), 'IMAGE_UNAVAILABLE')
  assert.equal(stableFailureCode('pat-invalid'), 'AUTH')
  assert.equal(stableFailureCode('timeout'), 'TIMEOUT')
  assert.equal(stableFailureCode('AUTH'), 'AUTH')
})

test('设置归一化容忍缺字段与错类型', () => {
  const value = normalize({ providers: { workbuddy: { enabled: false, disabledModels: ['a', 3] } }, qoder: { qoder: { pat: 'x' } } })
  assert.equal(value.providers.workbuddy.enabled, false)
  assert.deepEqual(value.providers.workbuddy.disabledModels, ['a'])
  assert.equal(value.qoder.qoder.pat, 'x')
  assert.equal(value.providers.qoder.enabled, true)
  // 1.0.6 的布尔 autoSwitch 升级后不能丢失用户的选择。
  assert.equal(normalize({ autoSwitch: false }).autoSwitch.enabled, false)
  assert.equal(normalize({ autoSwitch: true }).autoSwitch.enabled, true)
  assert.equal(normalize({ autoSwitch: { enabled: false, thresholdRatio: 0.2 } }).autoSwitch.thresholdRatio, 0.2)
  // 签到账号集合去重/排序，坏值丢弃。
  assert.deepEqual(
    normalize({ checkin: { accountIds: { workbuddy: ['b', 'a', 'a', 3] } } }).checkin.accountIds.workbuddy,
    ['a', 'b'],
  )
})

test('设置默认值六个 provider 都存在且默认启用', () => {
  const value = defaults()
  for (const provider of ['workbuddy', 'workbuddy-ai', 'qoder', 'qoder-global', 'trae', 'trae-global']) {
    assert.equal(value.providers[provider].enabled, true)
    assert.equal(providerOptions(value, provider).enabled, true)
  }
  // 只列四个的话，新增的两家即使默认被关掉也测不出来。
  assert.deepEqual(Object.keys(value.providers).sort(), ['qoder', 'qoder-global', 'trae', 'trae-global', 'workbuddy', 'workbuddy-ai'])
})

test('模型可见性：用户屏蔽与账号不支持都隐藏，但强制覆盖能救回来', () => {
  const value = normalize({
    providers: { workbuddy: { disabledModels: ['off-by-user'] } },
    unavailableModels: { workbuddy: ['not-in-plan'] },
    forcedModels: { workbuddy: ['rescued'] },
  })
  // 补一条「被探测判不可用但用户强制显示」的。
  value.unavailableModels.workbuddy.push('rescued')
  const options = providerOptions(value, 'workbuddy')

  assert.equal(isModelVisible(options, 'fine'), true)
  assert.equal(isModelVisible(options, 'off-by-user'), false)
  assert.equal(isModelVisible(options, 'not-in-plan'), false)
  assert.equal(isModelVisible(options, 'rescued'), true)
})

test('模型可见性：探测结论只对探测时的账号生效，切号后不能把能用的模型藏起来', () => {
  const token = (uid) => ({
    accessToken: `token-${uid}`,
    refreshToken: '',
    expiresAtMs: Date.now() + 3600_000,
    refreshExpiresAtMs: 0,
    domain: 'codebuddy.cn',
    uid,
    enterpriseId: '',
  })
  const value = normalize({
    accounts: { workbuddy: [
      { id: 'a', label: 'A', enabled: true, token: token('a') },
      { id: 'b', label: 'B', enabled: true, token: token('b') },
    ] },
    activeAccount: { workbuddy: 'a' },
    unavailableModels: { workbuddy: ['premium-only'] },
    probe: { results: { workbuddy: { probed: 4, unavailable: 1, accountId: 'a', at: 1 } } },
  })
  // 当前账号就是探测账号：结论生效。
  assert.equal(isModelVisible(providerOptions(value, 'workbuddy'), 'premium-only'), false)

  // 切到另一个账号：免费账号看不到付费模型，付费账号却可能看得到 —— 结论不能再套用。
  const switched = normalize({ ...value, activeAccount: { workbuddy: 'b' } })
  assert.equal(isModelVisible(providerOptions(switched, 'workbuddy'), 'premium-only'), true)

  // 老设置没有 accountId：保留旧行为，避免升级后突然多出一堆用不了的模型。
  const legacy = normalize({ unavailableModels: { workbuddy: ['old'] }, probe: { results: {} } })
  assert.equal(isModelVisible(providerOptions(legacy, 'workbuddy'), 'old'), false)
})

test('设置归一化保留不可用/强制/探测三块，并丢掉未知 provider', () => {
  const value = normalize({
    unavailableModels: { 'workbuddy-ai': ['a', 'b'], bogus: ['c'] },
    forcedModels: { qoder: ['x'] },
    probe: { enabled: false, lastRunAt: 123, results: { qoder: { probed: 1, unavailable: 0, at: 1 } } },
  })
  assert.deepEqual(value.unavailableModels['workbuddy-ai'], ['a', 'b'])
  assert.equal(value.unavailableModels.bogus, undefined)
  assert.deepEqual(value.forcedModels.qoder, ['x'])
  assert.equal(value.probe.enabled, false)
  assert.equal(value.probe.lastRunAt, 123)
  assert.deepEqual(value.probe.results.qoder, { probed: 1, unavailable: 0, at: 1 })
})

test('探测默认开启，缺字段时不会误关', () => {
  assert.equal(defaults().probe.enabled, true)
  assert.equal(normalize({}).probe.enabled, true)
  assert.equal(normalize({ probe: {} }).probe.enabled, true)
})

test('能力探测只认「账号档位不支持」，不认限流/超时/故障', () => {
  // 真·档位限制：400 + 明确文案。
  assert.equal(accountLimitation('WorkBuddy 聊天返回 HTTP 400：当前账号类型暂不支持该模型。', 400), true)
  assert.equal(accountLimitation('not supported for your account', 400), true)

  // 单模型每日频率限制（实测 429，明天重置）——绝不能当成能力缺失。
  assert.equal(
    accountLimitation('您的使用量已超出频率限制，将在 2026-10-18 12:51:06 UTC+8 重置，您也可以切换其他模型继续使用。', 429),
    false,
  )
  // 状态未知的流内错误也不认（曾经把这种当成证据，误藏了 qfmodel）。
  assert.equal(accountLimitation('当前账号类型暂不支持该模型。', undefined), false)
  // 服务端故障、认证、网络。
  assert.equal(accountLimitation('WorkBuddy 聊天返回 HTTP 502：bad gateway', 502), false)
  assert.equal(accountLimitation('Unauthorized', 401), false)
  assert.equal(accountLimitation('fetch failed', undefined), false)
  // 400 但不是档位问题。
  assert.equal(accountLimitation('WorkBuddy 聊天返回 HTTP 400：模型不支持该思考强度，请调整', 400), false)
})
