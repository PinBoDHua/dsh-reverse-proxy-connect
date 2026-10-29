/**
 * Trae 上游：模型目录、聊天流、额度与签到。
 *
 * 这一层把 Trae 自己的协议翻译成插件内部统一的形状。四处与另外两家都不一样：
 *
 * 1. **认证头是一组，不是一枚 token**。`Authorization: Cloud-IDE-JWT <jwt>` 之外
 *    还要 `X-Cloudide-Token` / `X-Ide-Token` / `X-Uid` / `X-App-Id` /
 *    `X-Ide-Version(-Code)` / `X-Device-*` / `Request-Traffic-Type`。少一个就 401，
 *    而 401 的文案是「not able to authenticate you」，完全看不出缺了哪个。
 * 2. **模型目录不是 model_list**。`/api/ide/v1/model_list` 需要 `type` 参数且对
 *    SOLO 客户端直接 400；真正可用的是 `/api/ide/v1/get_detail_param`，返回
 *    `config_info_list[]`，里面带展示名、上下文窗口、多模态与倍率。
 * 3. **聊天是 `llm_utils_chat` + 事件流**，不是 OpenAI 的 `choices[].delta`。
 *    每帧是 `event: output` + `{response, reasoning_content, tool_calls}`。
 *    工具调用的 `arguments` 还会**跨帧拼接**，且第一帧常常只有 `name`。
 * 4. **工具定义的 `parameters` 必须是字符串**，传对象会被上游 Go 反序列化拒绝
 *    （`cannot unmarshal object into ... parameters of type string`）。
 *
 * @module dsh-reverse-proxy-connect/trae/transport
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { attributionHeaders } from '../attribution.js'
import { REASON } from '../protocol.js'
import { withTimeout } from '../timeout.js'
import { endpointsFor } from './credential.js'

/** 目录请求超时。 */
const CATALOG_TIMEOUT_MS = 30_000

/** 额度请求超时。 */
const CREDITS_TIMEOUT_MS = 20_000

/** 签到请求超时。 */
const CHECKIN_TIMEOUT_MS = 20_000

/** Trae 的客户端 App ID（国内版与国际版实测相同）。 */
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'

/**
 * 上游承认的思考档位（与客户端前端包里的集合一致）。
 *
 * 注意 `none` 也在里面：Trae 把它当成「显式关闭思考」。但实测把 `reasoning_effort`
 * 设成 `none` 会被下游模型拒绝（`Invalid combination of reasoning_effort and
 * thinking type: high + disabled`），所以这里**只用于解析**，不会真的发出去。
 */
const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

/** 上游失败：带 HTTP 状态与失败类别。 */
export class TraeFailure extends Error {
  /**
   * @param code - REASON 码。
   * @param message - 说明。
   * @param status - HTTP 状态。
   * @param kind - 失败类别（`auth` / `quota` / `soft-rate` / `server` / `malformed`）。
   * @param retryAfterMs - 上游建议的重试等待。
   */
  constructor(code, message, status, kind = 'server', retryAfterMs) {
    super(message)
    this.name = 'TraeFailure'
    this.code = code
    this.status = status
    this.kind = kind
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * 一次请求的设备身份。
 *
 * 上游会拿 `x-machine-id` / `x-device-id` 做风控：同一个账号短时间内在几十个
 * 「设备」上请求会被限流。所以每**次**请求随机生成一对，但同一条流的所有请求
 * （目录 → 聊天）不共享 —— 与官方客户端「一台机器一个 id」的行为接近，又不会
 * 让插件被当成固定设备长期追踪。
 *
 * @returns `{machineId, deviceId}`。
 */
function newDevice() {
  const machineId = randomBytes(32).toString('hex')
  const deviceId = createHash('sha256').update(machineId).digest('hex').substring(0, 32)
  return { machineId, deviceId }
}

/**
 * 构造 Trae 上游请求头。
 *
 * @param variantId - 变体。
 * @param credential - `resolveTraeCredential()` 的返回值。
 * @param accept - `Accept` 头。
 * @returns 头字典。
 */
export function traeHeaders(variantId, credential, accept) {
  const endpoints = endpointsFor(variantId)
  const { machineId, deviceId } = newDevice()
  const jwt = credential.jwt
  return {
    'Content-Type': 'application/json',
    Accept: accept,
    'User-Agent': `Trae/${endpoints.ideVersion}`,
    Authorization: `Cloud-IDE-JWT ${jwt}`,
    'X-Cloudide-Token': jwt,
    'X-Ide-Token': jwt,
    ...(credential.userId === '' ? {} : { 'X-Uid': credential.userId }),
    'X-App-Id': APP_ID,
    'X-App-Version': 'default',
    'X-Ide-Version': endpoints.ideVersion,
    'X-Ide-Version-Code': endpoints.ideVersionCode,
    'X-App-Version-Code': endpoints.ideVersionCode,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'windows',
    'X-OS-Version': endpoints.osVersion,
    'X-Device-Brand': '83DG',
    'Request-Traffic-Type': 'prod',
    'X-Machine-Id': machineId,
    'X-Device-Id': deviceId,
    'X-User-Region': endpoints.region,
    ...attributionHeaders(),
  }
}

/**
 * 把 Trae 的错误信封翻成一句人话。
 * @param text - 响应体。
 * @returns 一句话。
 */
function describeError(text) {
  const trimmed = text.trim()
  if (trimmed === '') return '(空响应)'
  try {
    const parsed = JSON.parse(trimmed)
    const message = parsed?.message ?? parsed?.msg ?? parsed?.ResponseMetadata?.Error?.Message
    const code = parsed?.code ?? parsed?.ResponseMetadata?.Error?.Code
    if (typeof message === 'string' && message !== '') return code === undefined ? message : `${String(code)} · ${message}`
  } catch {
    /* 不是 JSON，原样截断 */
  }
  return trimmed.slice(0, 200)
}

/**
 * HTTP 状态 → 失败类别。
 *
 * Trae 的 401 只说明「认证不了」，既可能是令牌过期也可能是设备被踢，
 * 两种都该换号/续期，所以归成 `auth`。402/403 归 `quota`，429 归 `soft-rate`。
 *
 * @param status - HTTP 状态。
 * @returns 失败类别。
 */
export function kindOfStatus(status) {
  if (status === 401) return 'auth'
  if (status === 402) return 'quota'
  if (status === 403) return 'auth'
  if (status === 429) return 'soft-rate'
  if (status === 408 || status >= 500) return 'server'
  return 'malformed'
}

/**
 * 读一次 Trae 的模型目录。
 *
 * 只保留「真的能给用户选」的条目：
 * - `config_switch === false` 的关掉了；
 * - `is_invisible_to_user === true` 的是内部 agent（`browser_use_subagent` 之类），
 *   选了也用不了；
 * - `custom_model_*` 是自定义模型的占位槽，名字为空，留给用户自己填，这里跳过；
 * - 名字为空的一律跳过（选择器里会显示成一个空行）。
 *
 * @param variantId - 变体。
 * @param credential - 凭证。
 * @param signal - 取消。
 * @returns 模型行数组。
 * @throws {TraeFailure}
 */
export async function fetchCatalog(variantId, credential, signal) {
  const { chatHost } = endpointsFor(variantId)
  let response
  try {
    response = await fetch(`${chatHost}/api/ide/v1/get_detail_param`, {
      method: 'POST',
      headers: traeHeaders(variantId, credential, 'application/json'),
      body: JSON.stringify({ function: 'solo_work_lite', config_names: [], need_prompt: false }),
      signal: withTimeout(signal, CATALOG_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new TraeFailure(REASON.upstreamError, `Trae 模型目录请求失败：${cause instanceof Error ? cause.message : String(cause)}`, 0, 'server')
  }
  const text = await response.text()
  if (!response.ok) {
    throw new TraeFailure(
      response.status === 401 ? REASON.credentialExpired : REASON.upstreamError,
      `Trae 模型目录返回 HTTP ${String(response.status)}：${describeError(text)}`,
      response.status,
      kindOfStatus(response.status),
    )
  }
  let body
  try {
    body = JSON.parse(text)
  } catch (cause) {
    throw new TraeFailure(REASON.upstreamError, 'Trae 模型目录返回了非 JSON。', 502, 'malformed')
  }
  return parseCatalog(body)
}

/**
 * 把 `get_detail_param` 的响应解析成模型行。
 *
 * @param body - 响应 JSON。
 * @returns 模型行。
 */
export function parseCatalog(body) {
  const list = Array.isArray(body?.config_info_list) ? body.config_info_list : []
  const models = []
  const seen = new Set()
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.config_name === 'string' ? entry.config_name.trim() : ''
    if (id === '' || seen.has(id)) continue
    if (entry.config_switch === false) continue
    if (entry.is_invisible_to_user === true) continue
    // `custom_model_*` 是用户自定义模型的空槽位，名字与窗口都是占位值。
    if (id.startsWith('custom_model_')) continue
    const display = entry.display_config !== null && typeof entry.display_config === 'object' ? entry.display_config : {}
    const name = typeof display.display_name === 'string' && display.display_name.trim() !== ''
      ? display.display_name.trim()
      : id
    const contextWindow = readContextWindow(entry.context_window_tokens)
    if (contextWindow <= 0) continue
    seen.add(id)
    const rate = readRate(entry.display_contact_config)
    models.push({
      id,
      name,
      contextWindow,
      maxTokens: Math.min(64_000, Math.max(4_096, Math.round(contextWindow / 4))),
      supportsImages: display.multimodal === true,
      // Trae 把「能不能思考」写在 reasoning_effort_config 里；实测几乎所有在架模型
      // 都是 support_thinking: false，即上游自己也不让调档位。这里照实反映。
      supportsReasoning: entry?.reasoning_effort_config?.support_thinking === true,
      onlyReasoning: false,
      reasoningEfforts: readEfforts(entry.reasoning_effort_config),
      credits: rate === undefined ? undefined : `x${String(rate)}`,
      ...(display.is_beta === true ? { beta: true } : {}),
    })
  }
  return models
}

/**
 * 从 `context_window_tokens` 里挑一个窗口大小。
 *
 * 上游给的是 `{dev, max}`：`dev` 是默认档，`max` 只有部分模型有（1M 上下文那批）。
 * 优先用 `dev`（与客户端默认一致），没有才退到 `max`。
 *
 * @param value - 字段值。
 * @returns 窗口大小（0 = 认不出）。
 */
function readContextWindow(value) {
  if (value === null || typeof value !== 'object') return 0
  const dev = typeof value.dev === 'number' && Number.isFinite(value.dev) ? value.dev : 0
  if (dev > 0) return dev
  const max = typeof value.max === 'number' && Number.isFinite(value.max) ? value.max : 0
  return max > 0 ? max : 0
}

/**
 * 从 `display_contact_config`（一个 JSON 字符串）里读倍率。
 *
 * 读不到就返回 undefined —— 编一个倍率比没有倍率更误导。
 *
 * @param value - 字段值。
 * @returns 倍率数字或 undefined。
 */
function readRate(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const parsed = JSON.parse(value)
    const rate = parsed?.consumption_rate?.data?.rate
    if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) return rate
  } catch {
    /* 解析不了就当没有 */
  }
  return undefined
}

/**
 * 读思考档位。
 *
 * 实测在架的 Trae 模型基本都是 `{support_thinking: false}`，也就是上游不开放
 * 档位选择。此时返回空数组，DSH 就不会显示档位选择器 —— 这比列出一堆选了
 * 会被上游拒掉的档位好。
 *
 * @param config - `reasoning_effort_config`。
 * @returns 档位数组（由弱到强）。
 */
function readEfforts(config) {
  if (config === null || typeof config !== 'object' || config.support_thinking !== true) return []
  const declared = Array.isArray(config.reasoning_effort_options) ? config.reasoning_effort_options : []
  const efforts = []
  for (const value of declared) {
    const text = String(value).trim().toLowerCase()
    // `none` 只是解析用：发出去会被下游拒绝，不列给用户。
    if (!EFFORT_LEVELS.includes(text) || text === 'none' || efforts.includes(text)) continue
    efforts.push(text)
  }
  return efforts
}

/**
 * 把内部消息翻译成 Trae 的 `messages`。
 *
 * 形状与 OpenAI 高度相似，只有三处必须改：
 * - `role: "developer"` → `"system"`；
 * - `content` 必须是**块数组**（纯字符串会被上游当成缺字段）；
 * - 工具结果的图片不能塞进 tool 消息（上游只接受文本），由调用方提前拆出去。
 *
 * @param messages - OpenAI 形状的消息。
 * @returns Trae 形状的消息。
 */
export function toTraeMessages(messages) {
  const out = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role === 'developer' ? 'system' : message.role
    if (role === 'tool') {
      out.push({
        role: 'tool',
        content: [{ type: 'text', text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') }],
        ...(typeof message.tool_call_id === 'string' ? { tool_call_id: message.tool_call_id } : {}),
      })
      continue
    }
    if (role === 'assistant') {
      const blocks = []
      const text = flattenContent(message.content)
      if (text !== '') blocks.push({ type: 'text', text })
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        blocks.push({
          type: 'tool_calls',
          tool_calls: message.tool_calls.map((call) => ({
            id: typeof call.id === 'string' ? call.id : '',
            type: 'function',
            function_call: {
              name: typeof call.function?.name === 'string' ? call.function.name : '',
              arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : '',
            },
          })),
        })
      }
      out.push({ role: 'assistant', content: blocks })
      continue
    }
    out.push({ role, content: normalizeContent(message.content) })
  }
  return out
}

/**
 * 把内容块归一成 Trae 的块数组。
 *
 * 文本原样保留；`image_url` 的 `{url}` 结构也原样保留（实测上游认这个形状）。
 * 其余块一律折成文本，避免上游因为一个不认识的 `type` 整条 400。
 *
 * @param content - 字符串或块数组。
 * @returns 块数组。
 */
function normalizeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content ?? '') }]
  const out = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image_url' && typeof block.image_url?.url === 'string') {
      out.push({ type: 'image_url', image_url: { url: block.image_url.url } })
      continue
    }
    if (typeof block.text === 'string' && block.text !== '') {
      out.push({ type: 'text', text: block.text })
    }
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }]
}

/** 把内容压成一段纯文本（用于 assistant 历史）。 */
function flattenContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * 把 OpenAI 形状的工具定义转成 Trae 能接受的样子。
 *
 * 唯一的硬要求：`parameters` 必须是**字符串**。上游的 Go 结构体是
 * `FunctionDefinition.parameters string`，传对象会被 400
 * （`cannot unmarshal object into Go struct field ... of type string`）。
 *
 * @param tools - OpenAI 工具数组。
 * @returns Trae 工具数组。
 */
export function toTraeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out = []
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue
    const fn = tool.function ?? tool
    const name = typeof fn.name === 'string' ? fn.name : ''
    if (name === '') continue
    const parameters = fn.parameters === undefined || fn.parameters === null
      ? { type: 'object', properties: {} }
      : fn.parameters
    out.push({
      type: 'function',
      function: {
        name,
        ...(typeof fn.description === 'string' && fn.description !== '' ? { description: fn.description } : {}),
        parameters: typeof parameters === 'string' ? parameters : JSON.stringify(parameters),
      },
    })
  }
  return out.length === 0 ? undefined : out
}

/**
 * 构造聊天请求体。
 *
 * @param options - `{ messages, model, tools, maxTokens, temperature, sessionId, reasoningEffort }`。
 * @returns 请求体。
 */
export function buildChatBody(options) {
  const sessionId = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : randomUUID()
  const body = {
    messages: toTraeMessages(options.messages ?? []),
    model: options.model,
    function: 'solo_work_lite',
    stream: true,
    request_id: randomUUID(),
    session_id: sessionId,
  }
  const tools = toTraeTools(options.tools)
  if (tools !== undefined) body.tools = tools
  if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
    body.max_tokens = Math.round(options.maxTokens)
  }
  if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
    body.temperature = options.temperature
  }
  // 用户显式选了思考档位时必须真的发出去：Trae 的目录里
  // `reasoning_effort_config.support_thinking === true` 的模型会给出档位，
  // 丢掉这个字段等于「选了 high 仍然按上游默认跑」。`none` / `off` 不发 ——
  // 实测 `reasoning_effort: 'none'` 会被下游以
  // `Invalid combination of reasoning_effort and thinking type` 拒绝。
  const effort = typeof options.reasoningEffort === 'string' ? options.reasoningEffort.trim() : ''
  if (effort !== '' && effort !== 'none' && effort !== 'off') body.reasoning_effort = effort
  return body
}

/**
 * 打开一条 Trae 聊天流。
 *
 * @param variantId - 变体。
 * @param credential - 凭证。
 * @param body - 请求体。
 * @param signal - 取消。
 * @returns 响应。
 * @throws {TraeFailure}
 */
export async function openChat(variantId, credential, body, signal) {
  const { chatHost } = endpointsFor(variantId)
  let response
  try {
    response = await fetch(`${chatHost}/api/agent/v3/llm_utils_chat`, {
      method: 'POST',
      headers: traeHeaders(variantId, credential, 'text/event-stream'),
      body: JSON.stringify(body),
      signal,
    })
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause
    throw new TraeFailure(REASON.upstreamError, `Trae 聊天请求失败：${cause instanceof Error ? cause.message : String(cause)}`, 0, 'server')
  }
  if (!response.ok) {
    const text = await response.text()
    throw new TraeFailure(
      response.status === 401 ? REASON.credentialExpired : REASON.upstreamError,
      `Trae 聊天返回 HTTP ${String(response.status)}：${describeError(text)}`,
      response.status,
      kindOfStatus(response.status),
      parseRetryAfter(response.headers.get('retry-after')),
    )
  }
  const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    throw new TraeFailure(
      REASON.upstreamError,
      `Trae 聊天返回了非流式内容（Content-Type: ${contentType}），通常意味着登录失效或被网关拦截。`,
      502,
      'malformed',
    )
  }
  return response
}

/**
 * 解析 `Retry-After`（秒数或 HTTP 日期），夹到 10 分钟。
 * @param value - 响应头。
 * @param now - 当前时间。
 * @returns 毫秒，或 undefined。
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim()
  if (/^\d+$/.test(text)) {
    const seconds = Number(text)
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 10 * 60_000) : undefined
  }
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(Math.max(0, parsed - now), 10 * 60_000)
}

/**
 * 把 Trae 的事件流解析成内部统一事件。
 *
 * 事件种类（实测）：
 * - `metadata` / `timing_cost` / `extra_info` —— 元信息，转成心跳；
 * - `output` —— 正文 / 思考 / 工具调用，真正的内容；
 * - `token_usage` —— 用量；
 * - `done` —— 终态；
 * - `error` —— 失败，`code` 常见 1005（无权限/额度）、3003（下游模型报错）。
 *
 * 工具调用的分片规则要特别注意：上游第一帧常常只给 `id + name`（`arguments` 为空），
 * 后续帧给 `arguments` 但 `id` / `name` 为空。所以按 `index` 累积，
 * 并且**首片等 name 到位再发** —— 宿主按 `id + name` 认工具块，name 为空的那片
 * 会被当成普通 chunk，补到 name 时又另起一段，一次正常调用就被拆成两截。
 *
 * @param stream - `response.body`。
 * @param signal - 取消。
 * @yields 内部事件。
 */
export async function* parseStream(stream, signal) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finishKind
  let sawContent = false
  let eventName = ''
  let terminal = false
  let lastToolIndex
  const toolCalls = new Map()

  try {
    while (true) {
      if (signal?.aborted === true) {
        const cancelled = new Error('aborted')
        cancelled.name = 'AbortError'
        cancelled.code = 'ABORTED'
        cancelled.kind = 'timeout'
        throw cancelled
      }
      const { done, value } = await reader.read()
      let emitted = false
      if (done) {
        buffer += decoder.decode()
        if (buffer !== '' && !buffer.endsWith('\n')) buffer += '\n'
      } else {
        buffer += decoder.decode(value, { stream: true })
      }
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        // SSE 的 `event:` 字段：Trae 用 `event: done` 表示结束，而旧实现
        // 只认 EOF。若上游在 done 之后保持连接（心跳），用户会白等到超时。
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
          continue
        }
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        const doneEvent = eventName === 'done'
        const errorEvent = eventName === 'error'
        eventName = ''
        // `event: done` 的空 `data:` 行是合法 SSE（Trae 真会发 `event: done\ndata:\n\n`）。
        // 必须先判 done 再判空 payload：旧顺序把 `payload === ''` 的白名单放在前面，
        // 空 done 被当成「无内容的 data 行」跳过，流永远等不到终态，只能等
        // 180s 空闲看门狗把它判成 TIMEOUT。
        if (doneEvent || payload === '[DONE]') {
          terminal = true
          break
        }
        if (payload === '') continue
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          if (payload.startsWith('{') || payload.startsWith('[')) {
            const failure = new TraeFailure(REASON.upstreamError, `Trae 流返回了损坏的 JSON 帧：${payload.slice(0, 120)}`, 502, 'malformed')
            throw failure
          }
          continue
        }
        if (chunk === null || typeof chunk !== 'object') continue

        // 错误帧有两条判据，任一成立即算失败：
        // 1. 上游自己标了 `event: error` —— 这是权威信号；
        // 2. 旧启发式（带 code、带 message、又不是正文/工具帧），用来兜住那些
        //    没写事件名、但形状明显是错误信封的帧。
        //
        // 只看第 2 条时，`event: error` + `data: {"code":1005}`（message 缺省）
        // 会被整帧丢掉：流以 `finish: stop` 收场，正文已经吐出来时连 runtime 的
        // EMPTY_RESPONSE 兜底都不会触发 —— 用户看到半截回答却记成成功。
        const errorShaped = chunk.code !== undefined && chunk.code !== 0
          && chunk.message !== undefined && chunk.response === undefined && chunk.tool_calls === undefined
        if (errorEvent || errorShaped) throw classifyStreamError(chunk)

        if (typeof chunk.reasoning_content === 'string' && chunk.reasoning_content !== '') {
          emitted = true
          sawContent = true
          yield { type: 'reasoning', text: chunk.reasoning_content }
        }
        if (typeof chunk.response === 'string' && chunk.response !== '') {
          emitted = true
          sawContent = true
          yield { type: 'text', text: chunk.response }
        }
        if (Array.isArray(chunk.tool_calls) && chunk.tool_calls.length > 0) {
          for (const call of chunk.tool_calls) {
            if (call === null || typeof call !== 'object') continue
            const at = typeof call.index === 'number' ? call.index : (lastToolIndex ?? 0)
            // 上游省略 index 时用「上一个已知 index」而不是 `toolCalls.size`：
            // size 在插入前读取，第二片无 index 会被分到新槽位，把一次工具调用
            // 拆成两段（一段没有 name，另一段参数也不完整）。
            lastToolIndex = at
            const previous = toolCalls.get(at) ?? { id: '', name: '', arguments: '', emitted: false }
            if (typeof call.id === 'string' && call.id !== '') previous.id = call.id
            const name = typeof call?.function_call?.name === 'string' ? call.function_call.name : ''
            if (name !== '') previous.name = name
            const deltaText = typeof call?.function_call?.arguments === 'string' ? call.function_call.arguments : ''
            previous.arguments += deltaText
            toolCalls.set(at, previous)
            emitted = true
            // 还没给宿主发过这一片：等 name 到位再一次性发出（先到的参数一起带上）。
            // 宿主按 `id + name` 认工具块，name 为空的那片会被当成普通 chunk，
            // 补到 name 时又另起一段 —— 一次正常调用就被拆成两截。
            if (!previous.emitted) {
              if (previous.name === '') continue
              previous.emitted = true
              sawContent = true
              yield { type: 'tool', index: at, id: previous.id, name: previous.name, argumentsDelta: previous.arguments }
              continue
            }
            if (deltaText === '') continue
            sawContent = true
            yield { type: 'tool', index: at, id: previous.id, name: previous.name, argumentsDelta: deltaText }
          }
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          emitted = true
          yield { type: 'usage', usage: normalizeUsage(chunk.usage) }
        }
        // `token_usage` 帧本身就是用量：`name` 字段是空字符串，不能用它排除。
        if (chunk.token_usage !== undefined && chunk.token_usage !== null) {
          emitted = true
          yield { type: 'usage', usage: normalizeUsage(chunk.token_usage) }
        }
        if (chunk.prompt_tokens !== undefined || chunk.completion_tokens !== undefined) {
          // 直接就是用量对象（有些版本把 token_usage 摊平到顶层）。
          emitted = true
          yield { type: 'usage', usage: normalizeUsage(chunk) }
        }
        if (typeof chunk.finish_reason === 'string' && chunk.finish_reason !== '') {
          finishKind = finishKindOf(chunk.finish_reason, toolCalls.size > 0)
          emitted = true
        }
        if (typeof chunk.input_token === 'number' && chunk.response === undefined) {
          // `extra_info` 帧带 input_token（上下文估算），不是真实 usage，忽略。
          emitted = true
        }
      }
      if (terminal) break
      if (done) break
      if (!emitted) yield { type: 'heartbeat' }
    }
    // 兜底：name 一直没到（残缺响应）的工具也要发一片，否则宿主找不到对应的
    // block-end，工具块会永远挂着。
    for (const [at, call] of toolCalls) {
      if (call.emitted === true) continue
      if (call.name === '' && call.id === '') continue
      call.emitted = true
      sawContent = true
      yield { type: 'tool', index: at, id: call.id, name: call.name, argumentsDelta: call.arguments }
    }
    const kind = finishKind ?? (sawContent && toolCalls.size > 0 ? 'tool-calls' : 'stop')
    yield {
      type: 'finish',
      kind,
      // `error` 目前只来自 content_filter；与 WorkBuddy / Qoder 对齐带上可路由的
      // failure，否则宿主只看到一个没有 code 与 message 的 error。
      ...(kind === 'error'
        ? { failure: { message: '上游内容安全策略拦截了这次回复（content_filter）。', code: 'CONTENT_FILTER' } }
        : {}),
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 把流里的 `event: error` 帧翻成失败。
 *
 * 上游把「下游模型拒绝」也包成 200 + error 帧，所以这里必须按 `code` 分：
 * - `1005` —— 套餐/额度不允许（实测国际版免费账号对全部模型都回这个）；
 * - `3003` —— 下游模型报错（消息里常带真正的 400 原因）；
 * - 其余 —— 按服务端错误处理。
 *
 * @param chunk - 帧。
 * @returns 失败对象。
 */
function classifyStreamError(chunk) {
  const code = typeof chunk.code === 'number' ? chunk.code : 0
  const raw = typeof chunk.message === 'string' ? chunk.message.trim() : ''
  // 1005 的 `message` 经常是空字符串（真正的信息在 `extra: {"plan":4}` 里），
  // 直接透传会得到一句「Trae 流返回错误 1005」，对用户没有任何帮助。
  const message = code === 1005
    ? '当前 Trae 套餐不能使用这个模型（上游回 1005）。请换一个模型，或在 Trae 里升级套餐。'
    : raw !== '' ? raw : code > 0 ? `Trae 流返回错误 ${String(code)}` : 'Trae 返回了错误帧（没有给出 code 与 message）。'
  const status = code === 1005 ? 402 : 502
  const kind = code === 1005 ? 'quota' : 'server'
  const failure = new TraeFailure(REASON.upstreamError, message, status, kind)
  failure.upstreamCode = code
  return failure
}

/**
 * Trae 的 `finish_reason` → 内部 kind。
 *
 * `length` 优先于「见过 tool_calls」：被 max_tokens 截断的工具调用参数不完整，
 * 报成 `tool-calls` 会让宿主拿半截参数去执行工具。与另外两家同一判据。
 */
function finishKindOf(value, sawToolCalls) {
  if (value === 'length') return 'max-tokens'
  if (value === 'content_filter') return 'error'
  if (sawToolCalls) return 'tool-calls'
  if (value === 'tool_calls' || value === 'function_call') return 'tool-calls'
  return 'stop'
}

/**
 * Trae 的 usage → DSH 的 TokenUsage。
 *
 * `prompt_tokens` 已经包含缓存命中量，所以 `inputTokens` 要减掉 `cache_read`，
 * 否则「今日 token」会偏大。
 *
 * @param usage - `token_usage` 帧。
 * @returns TokenUsage。
 */
export function normalizeUsage(usage) {
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const cached = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
  const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  const reasoning = typeof usage.reasoning_tokens === 'number' ? usage.reasoning_tokens : undefined
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: Math.max(0, completion),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/**
 * 读 Trae 的额度。
 *
 * 国内版走 `/trae/api/v2/pay/ide_user_ent_usage`（`api.trae.cn`），返回
 * `usage_summary{consumed_amount, total_amount, consumption_ratio}` 与一串
 * `user_entitlement_pack_list`。国际版这个端点不存在（404），此时退化成
 * 「不限量 + 只报套餐」—— 比编一个假数字好。
 *
 * @param variantId - 变体。
 * @param credential - 凭证。
 * @param signal - 取消。
 * @returns 归一化额度。
 */
export async function fetchCredits(variantId, credential, signal) {
  const endpoints = endpointsFor(variantId)
  const url = `${endpoints.apiHost}/trae/api/v2/pay/ide_user_ent_usage`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: traeHeaders(variantId, credential, 'application/json'),
      body: '{}',
      signal: withTimeout(signal, CREDITS_TIMEOUT_MS),
    })
  } catch (cause) {
    return {
      state: 'error',
      remain: 0,
      total: 0,
      unit: 'credits',
      items: [],
      message: `Trae 额度读取失败：${cause instanceof Error ? cause.message : String(cause)}`,
      fetchedAt: Date.now(),
    }
  }
  const text = await response.text()
  if (response.status === 404 && variantId === 'trae-global') {
    // 国际版没有这条计费端点：这是**已知的「不可读」**，不是一次读取失败。
    // 以前这里返回 `state:'error'`，于是后台每轮额度刷新都往事件账本写一条
    // warn（实测 15 小时 14 条），把真正的失败挤出了最近 50 条。`none` 与
    // 「没配 PAT / 没有额度端点」同一语义：界面显示「未读取（原因）」，不记 warn。
    return {
      state: 'none',
      remain: 0,
      total: 0,
      unit: 'credits',
      items: [],
      message: 'Trae 国际版没有提供额度查询接口，额度请在 Trae 客户端里查看。',
      fetchedAt: Date.now(),
    }
  }
  if (!response.ok) {
    return {
      state: 'error',
      remain: 0,
      total: 0,
      unit: 'credits',
      items: [],
      message: `Trae 额度接口返回 HTTP ${String(response.status)}：${describeError(text)}`,
      fetchedAt: Date.now(),
    }
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { state: 'error', remain: 0, total: 0, unit: 'credits', items: [], message: 'Trae 额度接口返回了非 JSON。', fetchedAt: Date.now() }
  }
  return parseCredits(body)
}

/**
 * 解析额度响应。
 *
 * 口径（与客户端一致）：
 * - `usage_summary.total_amount` 是本周期总额，`consumed_amount` 是已消耗；
 * - 剩余 = 总额 − 已消耗，**不**直接用 `consumption_ratio` 反推（那个值带四舍五入）；
 * - `total_amount <= 0` 表示这个账号没有付费额度（Free），按「免费额度」显示，
 *   而不是「已用尽」。
 *
 * @param body - 响应 JSON。
 * @returns 归一化额度。
 */
export function parseCredits(body) {
  const summary = body?.usage_summary !== null && typeof body?.usage_summary === 'object' ? body.usage_summary : {}
  const total = typeof summary.total_amount === 'number' && Number.isFinite(summary.total_amount) ? summary.total_amount : 0
  const consumed = typeof summary.consumed_amount === 'number' && Number.isFinite(summary.consumed_amount) ? summary.consumed_amount : 0
  // 上游给的是带小数的积分数（`600.1`）。直接相减会留下 `199.89999999999998`
  // 这种浮点尾巴，卡片上会显示成「199.89999999999998」。
  const remain = Math.max(0, Math.round((total - consumed) * 100) / 100)
  const packs = Array.isArray(body?.user_entitlement_pack_list) ? body.user_entitlement_pack_list : []
  const items = []
  for (const pack of packs) {
    if (pack === null || typeof pack !== 'object') continue
    const name = typeof pack?.display_desc === 'string' && pack.display_desc !== '' ? pack.display_desc : '额度包'
    const quota = pack?.entitlement_base_info?.quota ?? pack?.quota
    const amount = typeof quota?.credit_amount === 'number'
      ? quota.credit_amount
      : typeof quota?.amount === 'number' ? quota.amount : undefined
    if (amount === undefined) {
      items.push({ name, remain: 0, total: 0 })
      continue
    }
    items.push({ name, remain: amount, total: amount })
  }
  const freePlan = total <= 0
  return {
    state: 'ok',
    remain,
    total,
    used: consumed,
    unit: body?.is_dollar_usage_billing === true ? 'usd' : 'credits',
    ...(freePlan ? { freePlan: true, planName: 'Free' } : {}),
    items,
    fetchedAt: Date.now(),
  }
}

/**
 * 读签到状态。
 *
 * @param variantId - 变体。
 * @param credential - 凭证。
 * @param signal - 取消。
 * @returns `{kind, credit?, message?}`。
 */
export async function checkinStatus(variantId, credential, signal) {
  const endpoints = endpointsFor(variantId)
  const url = `${endpoints.apiHost}/trae/api/v2/ug/checkin_credits/status`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: traeHeaders(variantId, credential, 'application/json'),
      body: '{}',
      signal: withTimeout(signal, CHECKIN_TIMEOUT_MS),
    })
    if (!response.ok) {
      // 404→「无活动」的理由只对国际版成立（它本来就没有这个活动）。国内版
      // 吃到 404 说明路由变了或被网关挡住，当成 inactive 会把真故障藏起来：
      // 当天直接标完成，奖励静默丢失。与额度端点 404 同一套区分。
      if (response.status === 404 && variantId === 'trae-global') {
        return { kind: 'inactive', fetchedAt: Date.now(), message: 'Trae 国际版没有签到活动' }
      }
      return { kind: 'failed', fetchedAt: Date.now(), message: `HTTP ${String(response.status)}` }
    }
    const body = await response.json()
    return interpretCheckinStatus(body)
  } catch (error) {
    return { kind: 'failed', fetchedAt: Date.now(), message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 解释签到状态。
 * @param body - 响应。
 * @returns 归一化状态。
 */
export function interpretCheckinStatus(body) {
  const at = Date.now()
  if (body === null || typeof body !== 'object') return { kind: 'failed', fetchedAt: at, message: '响应格式异常' }
  if (body.enable === false) return { kind: 'inactive', fetchedAt: at, message: '签到活动已关闭', credit: 0 }
  const credit = typeof body.credits === 'number' ? body.credits : 0
  const extra = typeof body.extra_credits === 'number' ? body.extra_credits : 0
  if (body.checked_in === true || body.did_checked_in === true) {
    return { kind: 'already', fetchedAt: at, credit: credit + extra, message: '今天已签到' }
  }
  return { kind: 'active', fetchedAt: at, credit: credit + extra, message: '可以签到' }
}

/**
 * 领取签到奖励。
 *
 * @param variantId - 变体。
 * @param credential - 凭证。
 * @param signal - 取消。
 * @returns `{kind, credit?, message?}`。
 */
export async function claimCheckin(variantId, credential, signal) {
  const endpoints = endpointsFor(variantId)
  const url = `${endpoints.apiHost}/trae/api/v2/ug/checkin_credits/claim`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: traeHeaders(variantId, credential, 'application/json'),
      body: '{}',
      signal: withTimeout(signal, CHECKIN_TIMEOUT_MS),
    })
    if (!response.ok) {
      // 与 checkinStatus 同一判据：只有国际版的 404 才是「没有这个活动」。
      if (response.status === 404 && variantId === 'trae-global') {
        return { kind: 'inactive', fetchedAt: Date.now(), message: 'Trae 国际版没有签到活动' }
      }
      return { kind: 'failed', fetchedAt: Date.now(), message: `HTTP ${String(response.status)}` }
    }
    const body = await response.json().catch(() => undefined)
    return interpretClaim(body)
  } catch (error) {
    return { kind: 'failed', fetchedAt: Date.now(), message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 解释领取结果。
 *
 * 上游只回 `{code, message}`：`0` 成功、`10001` 今天已领。没有单独的「无资格」码，
 * 所以其他非零一律当失败，并原样带上上游文案。
 *
 * @param body - 响应。
 * @returns 归一化结果。
 */
export function interpretClaim(body) {
  const at = Date.now()
  if (body === null || typeof body !== 'object') return { kind: 'failed', fetchedAt: at, message: '响应格式异常' }
  const code = typeof body.code === 'number' ? body.code : -1
  if (code === 0) {
    const credit = typeof body.credits === 'number' ? body.credits : typeof body.credit === 'number' ? body.credit : 0
    return { kind: 'claimed', fetchedAt: at, credit, message: '签到成功' }
  }
  if (code === 10001 || code === 1001) return { kind: 'already', fetchedAt: at, message: '今天已签到' }
  return { kind: 'failed', fetchedAt: at, message: String(body.message ?? `code ${String(code)}`) }
}

/**
 * 探测账号身份（不消耗模型额度）。
 *
 * `GetUserInfo` 用的是 cloudide 令牌而不是 JWT —— 这一点与聊天相反，
 * 所以这里单独收一份 `cloudideToken`。
 *
 * @param variantId - 变体。
 * @param cloudideToken - 登录文件里的令牌。
 * @param signal - 取消。
 * @returns `{ok, name?, userId?, message?}`。
 */
export async function getUserInfo(variantId, cloudideToken, signal) {
  const endpoints = endpointsFor(variantId)
  try {
    const response = await fetch(`${endpoints.apiHost}/cloudide/api/v3/trae/GetUserInfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cloudide-token': cloudideToken, 'User-Agent': `Trae/${endpoints.ideVersion}` },
      body: JSON.stringify({ IDEVersion: endpoints.ideVersion }),
      signal: withTimeout(signal, CREDITS_TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, message: `HTTP ${String(response.status)}` }
    const body = await response.json()
    const result = body?.Result
    if (result === undefined || typeof result !== 'object') {
      return { ok: false, message: describeError(JSON.stringify(body)) }
    }
    return {
      ok: true,
      name: typeof result.ScreenName === 'string' ? result.ScreenName : typeof result.UserName === 'string' ? result.UserName : '',
      userId: typeof result.UserID === 'string' ? result.UserID : '',
      email: typeof result.NonPlainTextEmail === 'string' ? result.NonPlainTextEmail : '',
      avatarUrl: typeof result.AvatarUrl === 'string' ? result.AvatarUrl : '',
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
