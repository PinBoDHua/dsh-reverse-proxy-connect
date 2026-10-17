import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildChatEnvelope,
  encodeBody,
  parseCatalog as parseQoderCatalog,
  finishKind,
  normalizeUsage,
  translateMessages,
  translateTools,
} from '../lib/qoder/transport.js'
import { prepareChatBody, parseCatalog as parseWorkBuddyCatalog } from '../lib/workbuddy/upstream.js'
import { openAiFinishKind, normalizeOpenAiUsage, toOpenAiMessages, toOpenAiTools, accountLimitation } from '../lib/runtime.js'
import { toModelInfo, toResolvedModelInfo, failureCode, stableFailureCode } from '../lib/adapter.js'
import { defaults, normalize, providerOptions, isModelVisible } from '../lib/settings.js'

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

test('OpenAI SSE 终态与 usage 归一化', () => {
  assert.equal(openAiFinishKind('stop', true), 'tool-calls')
  assert.equal(openAiFinishKind('length', false), 'max-tokens')
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
})

test('设置默认值四个 provider 都存在且默认启用', () => {
  const value = defaults()
  for (const provider of ['workbuddy', 'workbuddy-ai', 'qoder', 'qoder-global']) {
    assert.equal(value.providers[provider].enabled, true)
    assert.equal(providerOptions(value, provider).enabled, true)
  }
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
