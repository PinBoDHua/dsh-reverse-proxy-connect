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
 * 5. **模型路由键是 `config_name` + `model_name`，`model` 不是**。请求体里只发
 *    `model` 会被上游忽略，按「账号默认模型」回答（实测一律 Doubao-Seed-2.1-
 *    Turbo）；必须同时带 `config_name`（目录的 config_name）与 `model_name`
 *    （`model_detail_list[].model_name`，标准档带 `__dev` 后缀）才能选到模型。
 * 6. **`messages[].content` 必须是块数组**（`[{type:'text',text}]`），字符串会被
 *    400 拒绝（`cannot unmarshal string into ... LLMRawMessageContent`）。
 *
 * @module dsh-reverse-proxy-connect/trae/transport
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { attributionHeaders } from '../attribution.js'
import { REASON } from '../protocol.js'
import { abortReasonOf, withTimeout } from '../timeout.js'
import { endpointsFor } from './credential.js'

/** 单行 SSE 缓冲的上限（R24 的 T-11）：没有换行的超大响应不能把堆吃光。 */
const MAX_SSE_BUFFER = 4 * 1024 * 1024

/**
 * 工具块的参数是否**残缺**（非空但不是合法 JSON）。
 *
 * 流在工具调用中途断开时解析器会在 EOF 合成 `finish`；把半截 JSON 当成完整
 * 的 `tool-calls` 交给宿主，等于让它拿坏参数执行工具（R24 的 T-1）。
 *
 * @param toolCalls - `Map<index, {arguments}>`。
 * @returns 是否存在残缺参数。
 */
function hasBrokenToolArguments(toolCalls) {
  for (const call of toolCalls.values()) {
    const text = typeof call?.arguments === 'string' ? call.arguments.trim() : ''
    if (text === '') continue
    try {
      JSON.parse(text)
    } catch {
      return true
    }
  }
  return false
}

/** 目录请求超时。 */
const CATALOG_TIMEOUT_MS = 30_000

/**
 * 目录用的 function。
 *
 * 实测同一个账号：`solo_work_lite` 只下发标准档（`context_window_tokens.dev`），
 * `solo_agent_lite` 才对同一批模型下发 `context_window_tokens.max` 与
 * `model_detail_list[].max_mode / __max`。Max 档只存在于后者。
 */
const CATALOG_FUNCTION = 'solo_agent_lite'

/** 标准档聊天用的 function；保持插件原有行为不变。 */
const CHAT_FUNCTION = 'solo_work_lite'

/**
 * Max 档聊天用的 function。
 *
 * 实测 `solo_work_lite` 不认 `__max` 后端（回 4023 model is unknown），
 * `solo_agent_lite` 才认；因此只有 Max 模型行会切到这个 function。
 */
const MAX_CHAT_FUNCTION = 'solo_agent_lite'

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
 * 用「种子 + 盐」派生一串确定性字节。
 *
 * 签到端点的设备身份必须**稳定**：官方客户端从 user id 派生 `X-Device-Id` /
 * `X-Market-User-Id` / `Vscode-Sessionid`，每次签到都用同一组值。旧实现把聊天
 * 用的随机设备头带进签到，上游会把它当成陌生设备并回 `code 9074`
 * （「当前参与用户太多」）—— 实测同一秒钟换成官方头就能领到。
 *
 * @param seed - 种子（user id，带代次时附 `#generation`）。
 * @param salt - 用途盐。
 * @param nbytes - 字节数。
 * @returns 字节数组。
 */
function seededStream(seed, salt, nbytes) {
  const prefix = `${salt}:${seed}`
  const out = []
  let counter = 0
  while (out.length < nbytes) {
    const counterBuffer = Buffer.alloc(4)
    counterBuffer.writeUInt32BE(counter, 0)
    const digest = createHash('sha256').update(prefix, 'utf8').update(counterBuffer).digest()
    for (const byte of digest) {
      out.push(byte)
      if (out.length >= nbytes) break
    }
    counter += 1
  }
  return out.slice(0, nbytes)
}

/** 由种子派生固定长度数字串。 */
function seededDigits(length, seed, salt) {
  return seededStream(seed, salt, length).map((byte) => (byte % 10).toString()).join('')
}

/** 官方客户端的 `X-Market-User-Id`（UUID v4 形态，由 user id 确定性派生）。 */
function deriveMarketUserId(userId) {
  const bytes = seededStream(userId, 'market', 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** 签到设备 id（15 位数字）；`generation > 0` 用于 9074 后换一个身份重试。 */
function deriveCheckinDeviceId(userId, generation) {
  const seed = generation > 0 ? `${userId}#${generation}` : userId
  return seededDigits(15, seed, 'devid')
}

/** 签到会话 id（32 字节十六进制）。 */
function deriveSessionId(userId, generation) {
  const seed = generation > 0 ? `${userId}#${generation}` : userId
  return seededStream(seed, 'sess', 32).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 生成 n 位十六进制随机串。 */
function randomHex(length) {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length)
}

/**
 * 构造 Trae **签到端点**专用的请求头。
 *
 * 与聊天头（`traeHeaders`）刻意不同：签到走的是活动/市场那套设备身份，
 * 官方客户端带 `X-Market-Client-Id` / `X-Market-User-Id` / `X-Device-Id` /
 * `Vscode-Sessionid`，而不是聊天的 `X-Machine-Id` / `X-Device-Id` 随机值。
 * 实测国内版用聊天头领取会稳定返回 `{"code":9074,"message":"当前参与用户太多，
 * 请稍后再试"}`，换成本函数这组头立刻 `{"code":0,"message":"success"}`。
 *
 * @param variantId - 变体。
 * @param credential - 凭证。
 * @param generation - 设备代次（0 为官方默认；9074 后可用 1 再试）。
 * @returns 头字典。
 */
export function traeCheckinHeaders(variantId, credential, generation = 0) {
  const endpoints = endpointsFor(variantId)
  const isChina = variantId !== 'trae-global'
  const userId = typeof credential.userId === 'string' ? credential.userId : ''
  // userId 缺失时回落到按账号稳定的标识（邮箱/名字/登录文件路径）：空串派生
  // 出的设备身份是全局常量，所有缺 userId 的安装会共用同一枚「设备」，
  // 上游风控可能据此回 9074（R25）。
  const seed = userId !== '' ? userId
    : typeof credential.email === 'string' && credential.email !== '' ? credential.email
      : typeof credential.name === 'string' && credential.name !== '' ? credential.name
        : typeof credential.file === 'string' && credential.file !== '' ? credential.file
          : variantId
  return {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate',
    'Accept-Language': isChina ? 'zh-CN' : 'en-US',
    'User-Agent': isChina ? 'VSCode 1.107.1 (TRAE SOLO CN)' : 'VSCode 1.107.1 (TRAE SOLO)',
    Authorization: `Cloud-IDE-JWT ${credential.jwt}`,
    'X-Market-Client-Id': 'VSCode 1.107.1',
    'X-Market-User-Id': deriveMarketUserId(seed),
    'X-User-Region': endpoints.region,
    'X-Device-Id': deriveCheckinDeviceId(seed, generation),
    'X-Lgw-Req-Sdk-Type': '3',
    'Package-Type': isChina ? 'stable_cn' : 'stable',
    'X-Lscbd-Aid': '787976',
    'X-Lscbd-Platform': 'windows',
    'App-Version': endpoints.ideVersion,
    'X-Tt-Trace-Id': `00-${randomHex(16)}-01`,
    'Vscode-Sessionid': deriveSessionId(seed, generation),
    'X-Request-Id': randomUUID(),
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'none',
    ...attributionHeaders(),
  }
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
  try {
    const models = await fetchCatalogWithFunction(variantId, credential, CATALOG_FUNCTION, signal)
    if (models.length > 0) return models
  } catch (error) {
    // 只有「这套 function 不存在 / 不适用」才退回标准目录；鉴权、额度、限流
    // 与超时换一个 function 也不会变好，重试只会把同一份错误打两遍。
    if (!canFallbackCatalog(error)) throw error
  }
  return await fetchCatalogWithFunction(variantId, credential, CHAT_FUNCTION, signal)
}

/**
 * 目录失败是否值得换用标准档 function 重试。
 *
 * @param error - `fetchCatalogWithFunction()` 抛出的错误。
 * @returns 是否重试。
 */
function canFallbackCatalog(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return false
  // 400 / 403 / 404 / 405：function 不被该账号或套餐识别，换标准档值得一试。
  const status = typeof error?.status === 'number' ? error.status : 0
  if (status === 400 || status === 403 || status === 404 || status === 405) return true
  if (status === 401 || error?.kind === 'auth' || error?.kind === 'quota' || error?.kind === 'soft-rate') return false
  // 非 JSON 响应也可能是这个 function 的后端异常，退回标准档再试一次。
  return error?.kind === 'malformed'
}

/**
 * 用指定的 function 拉一次目录。
 *
 * @param variantId - 变体。
 * @param credential - 凭证。
 * @param functionName - `solo_agent_lite` 或 `solo_work_lite`。
 * @param signal - 取消。
 * @returns 展开后的模型行。
 * @throws {TraeFailure}
 */
async function fetchCatalogWithFunction(variantId, credential, functionName, signal) {
  const { chatHost } = endpointsFor(variantId)
  let response
  try {
    response = await fetch(`${chatHost}/api/ide/v1/get_detail_param`, {
      method: 'POST',
      headers: traeHeaders(variantId, credential, 'application/json'),
      body: JSON.stringify({ function: functionName, config_names: [], need_prompt: false }),
      signal: withTimeout(signal, CATALOG_TIMEOUT_MS),
    })
  } catch (cause) {
    // 超时让原始 TimeoutError 穿透（与 Qoder/WorkBuddy 同位置一致）：包成
    // server 会把 TIMEOUT 标签/统计口径弄错（R25）。
    if (cause?.name === 'TimeoutError') throw cause
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
  return expandMaxModels(parseCatalog(body))
}

/**
 * 把 `parseCatalog()` 的标准档模型行展开成「标准 + Max」两行。
 *
 * DSH 的模型信息只支持一个 `contextWindow`，没有 Trae 客户端那种 Max 开关；
 * 所以把 Max 档做成独立模型行（`<id>__max`），用户在模型选择器里直接选。
 * 只有上游真的给出更大的 `context_window_tokens.max` 时才展开 —— 等于 dev
 * 的 `max`（如 Seed-2.1-Turbo 的 256K→256K）不会产生重复行。
 *
 * @param models - `parseCatalog()` 的结果。
 * @returns 展开后的模型行（标准行在前，Max 行紧随其后）。
 */
export function expandMaxModels(models) {
  if (!Array.isArray(models)) return []
  const out = []
  const knownIds = new Set()
  for (const model of models) {
    if (model === null || typeof model !== 'object') continue
    knownIds.add(model.id)
  }
  for (const model of models) {
    if (model === null || typeof model !== 'object') continue
    out.push(model)
    if (model.maxMode === true) continue
    const { maxContextWindow, maxWireName, ...base } = model
    if (
      typeof maxContextWindow !== 'number'
      || !Number.isFinite(maxContextWindow)
      || maxContextWindow <= model.contextWindow
    ) continue
    const id = `${model.id}__max`
    // 重复展开（旧缓存里标准行仍带 max 元数据）不能再造一层 Max。
    if (knownIds.has(id)) continue
    knownIds.add(id)
    const wireName = typeof maxWireName === 'string' && maxWireName !== ''
      ? maxWireName
      : `${model.id}__max`
    out.push({
      ...base,
      id,
      name: `${model.name} · Max`,
      contextWindow: Math.floor(maxContextWindow),
      wireName,
      chatFunction: MAX_CHAT_FUNCTION,
      maxMode: true,
      baseId: model.id,
    })
  }
  return out
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
    const contextWindow = CONTEXT_WINDOW_OVERRIDES[id] ?? readContextWindow(entry.context_window_tokens)
    if (contextWindow <= 0) continue
    seen.add(id)
    const rate = readRate(entry.display_contact_config)
    const wireName = readWireModelName(entry)
    const maxContextWindow = readMaxContextWindow(entry.context_window_tokens, contextWindow)
    const maxWireName = maxContextWindow === undefined ? undefined : readMaxWireModelName(entry)
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
      // 聊天请求的路由键：config_name（=id）之外还要发 model_name，它就是
      // model_detail_list 里的标准档后端名（带 __dev 后缀）。见 buildChatBody。
      ...(wireName === undefined ? {} : { wireName }),
      // Max 档元数据：窗口只有比标准档大时才保留，由 fetchCatalog() 展开成
      // 独立的 `<id>__max` 模型行。等于 dev 的 max 不产生重复模型。
      ...(maxContextWindow === undefined ? {} : { maxContextWindow }),
      ...(maxWireName === undefined ? {} : { maxWireName }),
      ...(typeof entry.config_source === 'number' && Number.isFinite(entry.config_source) ? { configSource: entry.config_source } : {}),
      ...(display.is_beta === true ? { beta: true } : {}),
    })
  }
  return models
}

/**
 * 读标准档的 wire 模型名（`model_detail_list[].model_name`）。
 *
 * 目录里每条 config 带一个 `model_detail_list`：标准档是 `<config_name>__dev`，
 * Max 上下文档是 `<config_name>__max`（`max_mode: true`，部分模型才有）。
 * 插件的窗口/输出上限一直按标准档（dev）记，所以这里取**非 max**的那条；
 * 全是 max 的畸形条目退回第一条，实在没有就返回 undefined（请求侧再派生）。
 *
 * @param entry - 目录条目。
 * @returns wire 模型名，或 undefined。
 */
function readWireModelName(entry) {
  const details = Array.isArray(entry?.model_detail_list) ? entry.model_detail_list : []
  let fallback
  for (const detail of details) {
    if (detail === null || typeof detail !== 'object') continue
    const name = typeof detail.model_name === 'string' ? detail.model_name.trim() : ''
    if (name === '') continue
    if (fallback === undefined) fallback = name
    if (detail.max_mode === true || name.endsWith('__max')) continue
    return name
  }
  return fallback
}

/**
 * 读 Max 档的 wire 模型名（`model_detail_list[].model_name`）。
 *
 * 目录里 Max 档是 `<config_name>__max`（`max_mode: true`）。只有标准档、
 * 没有 Max 后端时返回 undefined，展开阶段会按命名规则派生。
 *
 * @param entry - 目录条目。
 * @returns wire 模型名，或 undefined。
 */
function readMaxWireModelName(entry) {
  const details = Array.isArray(entry?.model_detail_list) ? entry.model_detail_list : []
  for (const detail of details) {
    if (detail === null || typeof detail !== 'object') continue
    const name = typeof detail.model_name === 'string' ? detail.model_name.trim() : ''
    if (name === '') continue
    if (detail.max_mode === true || name.endsWith('__max')) return name
  }
  return undefined
}

/**
 * 上游窗口的覆盖值。
 *
 * `DeepSeek-V4-Flash` 的两个 id 实际已支持 1M，但 `context_window_tokens.dev`
 * 仍停在 200000。只按上游写会把窗口算小，宿主会过早压缩上下文 —— 这两个 id
 * 按 1M 记。
 */
const CONTEXT_WINDOW_OVERRIDES = Object.freeze({
  'DeepSeek-V4-Flash': 1_000_000,
  'DeepSeek-V4-Flash-Official': 1_000_000,
})

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
 * 读 Max 档窗口。
 *
 * 只有比标准档**更大**时才返回值：上游对不少模型也写 `max`，但数值等于 dev
 * （例如 Seed-2.1-Turbo 的 256K→256K），那不是真正的 Max 档，展开成独立模型
 * 只会让选择器多出一行没有意义的重复项。
 *
 * @param value - 字段值。
 * @param devWindow - 已选定的标准档窗口。
 * @returns Max 窗口，或 undefined。
 */
function readMaxContextWindow(value, devWindow) {
  if (value === null || typeof value !== 'object') return undefined
  const max = typeof value.max === 'number' && Number.isFinite(value.max) ? Math.floor(value.max) : 0
  return max > devWindow ? max : undefined
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
 * 模型路由的**真正键是 `config_name` + `model_name`，不是 `model`**：
 *
 * 实测（国内版，账号默认模型为 Doubao-Seed-2.1-Turbo）：只发 `model`（旧实现）
 * 时，无论选 kimi-k3 还是 glm-5.3，上游都按「账号默认模型」回答 —— 自报家门
 * 全是豆包；带上 `config_name`（目录里的 config_name）与 `model_name`
 * （目录里 `model_detail_list[].model_name`，带 `__dev` 后缀的标准档后端）后，
 * kimi-k3 回 Moonshot、glm-5.3 回 GLM，选择才真正生效。`model` 字段与
 * `model_name` 同值保留（官方客户端也这么发，网关忽略未知字段）。
 *
 * 旧缓存 / 内置兜底清单里的行没有 `wireName`：标准档按 Trae 的命名规则
 * （`<config_name>__dev`）派生，Max 行按 `<config_name>__max` 派生 ——
 * 实测在架的内置模型全部符合该规则。
 *
 * @param options - `{ messages, model, modelRow, tools, maxTokens, temperature, sessionId, reasoningEffort }`。
 *   `modelRow` 是 `resolveModel()` 找到的模型行（可省略，省略时按 `model` 派生）。
 * @returns 请求体。
 */
export function buildChatBody(options) {
  const sessionId = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : randomUUID()
  const row = options.modelRow === null || typeof options.modelRow !== 'object' ? undefined : options.modelRow
  const maxMode = row?.maxMode === true
  // Max 模型行的 id 是 `<config_name>__max`；发给上游的 config_name 必须回到
  // 目录里的原值，否则路由键对不上。
  const rawConfigName = typeof row?.baseId === 'string' && row.baseId !== ''
    ? row.baseId
    : typeof row?.id === 'string' && row.id !== ''
      ? row.id
      : String(options.model ?? '')
  const configName = maxMode && rawConfigName.endsWith('__max') ? rawConfigName.slice(0, -5) : rawConfigName
  // wire 名：标准档取 model_detail_list 里不带 max_mode / __max 的那条；
  // Max 行取 `__max` 后端。
  const wireName = typeof row?.wireName === 'string' && row.wireName !== ''
    ? row.wireName
    : `${configName}${maxMode ? '__max' : '__dev'}`
  const body = {
    messages: toTraeMessages(options.messages ?? []),
    // 三个字段一起发：config_name + model_name 是路由键，model 与官方客户端
    // 一样带同值（部分网关会用它做日志/统计，丢了不影响路由但形状不再对齐）。
    config_name: configName,
    model_name: wireName,
    model: wireName,
    // 标准档保持 `solo_work_lite`；Max 后端只在 `solo_agent_lite` 下可见
    // （`solo_work_lite` 会回 4023 model is unknown）。
    function: typeof row?.chatFunction === 'string' && row.chatFunction !== '' ? row.chatFunction : CHAT_FUNCTION,
    stream: true,
    request_id: randomUUID(),
    session_id: sessionId,
    config_source: typeof row?.configSource === 'number' && Number.isFinite(row.configSource) ? row.configSource : 1,
    is_custom_model: false,
    provider: '',
    conversation_id: sessionId,
    request_seq: 1,
  }
  if (maxMode) {
    // 与官方客户端切 Max 时同形状：告诉上游走 Max 策略，并带上实际窗口。
    body.model_auto_selection = { strategy: 'max' }
    if (typeof row.contextWindow === 'number' && Number.isFinite(row.contextWindow) && row.contextWindow > 0) {
      body.context_window_size = Math.floor(row.contextWindow)
    }
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
    // 响应体不会被读，必须显式取消，否则连接挂到 GC 才释放（R24 的 T-12）。
    try {
      await response.body?.cancel()
    } catch {
      /* 取消失败不影响错误本身 */
    }
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
        // 必须走 abortReasonOf：宿主用 AbortSignal.timeout() 或内部死线中止时，
        // 伪造一个 AbortError 会把"超时"报成"用户取消"（不可重试、统计记 aborted）。
        // Qoder / WorkBuddy 的同一位置都是这样处理的（R24 的 T-6）。
        throw abortReasonOf(signal)
      }
      const { done, value } = await reader.read()
      let emitted = false
      if (done) {
        buffer += decoder.decode()
        if (buffer !== '' && !buffer.endsWith('\n')) buffer += '\n'
      } else {
        buffer += decoder.decode(value, { stream: true })
      }
      if (buffer.length > MAX_SSE_BUFFER) {
        throw new TraeFailure(
          REASON.upstreamError,
          `Trae 流里累积了 ${String(buffer.length)} 字节仍没有换行，已放弃这条流。`,
          502,
          'malformed',
        )
      }
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        // 空行 = 一帧结束：`event:` 名必须在这里复位。只在上面的 data 分支里
        // 清空时，`event: done` 后面若没有 `data:` 行（合法 SSE，或代理裁掉了
        // 空 data 行），这个名字会泄漏到下一帧，把正常输出误判成 done/error
        // （R24 的 T-17）。
        if (line === '') {
          eventName = ''
          continue
        }
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
        // `event: error` 是权威失败信号：data 为空、纯文本、JSON 字符串都算。
        // 旧实现先判空、再只有「以 { 开头的损坏 JSON」才抛错，其余整帧丢弃 ——
        // 上游已经报错，用户却拿到半截回答 + finish: stop（统计记成功）。
        // 先于 done 判定：`event: error` + `data: [DONE]` 也不能被当成正常结束。
        if (errorEvent) {
          let parsedError
          if (payload !== '') {
            try {
              parsedError = JSON.parse(payload)
            } catch {
              parsedError = payload
            }
          }
          throw classifyStreamError(parsedError)
        }
        // `event: done` 的空 `data:` 行是合法 SSE（Trae 真会发 `event: done\ndata:\n\n`）。
        // 必须先判 done 再判空 payload：旧顺序把 `payload === ''` 的白名单放在前面，
        // 空 done 被当成「无内容的 data 行」跳过，流永远等不到终态，只能等
        // 180s 空闲看门狗把它判成 TIMEOUT。
        //
        // done 帧的 data **不是**永远为空：真实上游把 `finish_reason` 放在
        // `event: done` 里，`usage` 有时也在。旧实现一看到 done 就 break，
        // 于是 `length` 被兜底成 tool-calls（宿主拿半截工具参数去执行）、
        // `content_filter` 被兜底成成功、终帧 usage 整个丢掉。先解析再收流。
        if (doneEvent || payload === '[DONE]') {
          if (doneEvent && payload !== '' && payload !== '[DONE]') {
            let terminalChunk
            try {
              terminalChunk = JSON.parse(payload)
            } catch {
              terminalChunk = undefined
            }
            if (terminalChunk !== null && typeof terminalChunk === 'object') {
              if (typeof terminalChunk.finish_reason === 'string' && terminalChunk.finish_reason !== '') {
                finishKind = finishKindOf(terminalChunk.finish_reason, toolCalls.size > 0)
              }
              if (terminalChunk.usage !== undefined && terminalChunk.usage !== null) {
                yield { type: 'usage', usage: normalizeUsage(terminalChunk.usage) }
              }
              if (terminalChunk.token_usage !== undefined && terminalChunk.token_usage !== null) {
                yield { type: 'usage', usage: normalizeUsage(terminalChunk.token_usage) }
              }
            }
          }
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

        // 没有事件名的旧启发式（带 code、带 message、又不是正文/工具帧），
        // 用来兜住那些形状明显是错误信封的帧。
        //
        // 只看启发式时，`event: error` + `data: {"code":1005}`（message 缺省）
        // 会被整帧丢掉：流以 `finish: stop` 收场，正文已经吐出来时连 runtime 的
        // EMPTY_RESPONSE 兜底都不会触发 —— 用户看到半截回答却记成成功。
        const errorShaped = chunk.code !== undefined && chunk.code !== 0
          && chunk.message !== undefined && chunk.response === undefined && chunk.tool_calls === undefined
        if (errorShaped) throw classifyStreamError(chunk)

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
            const rawArguments = call?.function_call?.arguments
            // arguments 偶尔是对象而不是字符串；直接丢掉会让工具按空参数执行
            // （R24 的 T-9）。
            const deltaText = typeof rawArguments === 'string'
              ? rawArguments
              : rawArguments !== null && typeof rawArguments === 'object' ? JSON.stringify(rawArguments) : ''
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
    const base = finishKind ?? (sawContent && toolCalls.size > 0 ? 'tool-calls' : 'stop')
    // 工具参数残缺（EOF 之前的半截 JSON）不能报成 tool-calls（R24 的 T-1）。
    const broken = base === 'tool-calls' && hasBrokenToolArguments(toolCalls)
    const kind = broken ? 'error' : base
    yield {
      type: 'finish',
      kind,
      // 无终态帧（event:done / [DONE] / finish_reason）的 EOF：宿主侧保持
      // stop 兼容，统计侧记 incomplete（R25）。
      ...(terminal || finishKind !== undefined || kind === 'error' ? {} : { incomplete: true }),
      // `error` 有两个来源：content_filter，以及残缺的工具参数；两者都必须带
      // 可路由的 failure，否则宿主只看到一个没有 code 与 message 的 error。
      ...(kind === 'error'
        ? {
            failure: broken
              ? { message: '工具调用的参数不完整（连接在流结束前中断），已放弃这次调用。', code: 'MALFORMED_RESPONSE' }
              : { message: '上游内容安全策略拦截了这次回复（content_filter）。', code: 'CONTENT_FILTER' },
          }
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
 * - `1001` / `401` / `403` —— 登录失效（客户端把 1001 当"登录失效"用）；
 * - `3003` —— 下游模型报错（消息里常带真正的 400 原因）；
 * - 其余 —— 按服务端错误处理。
 *
 * @param chunk - 帧。
 * @returns 失败对象。
 */
function classifyStreamError(chunk) {
  const frame = chunk !== null && typeof chunk === 'object' ? chunk : {}
  // 上游存在字符串数字 code（签到解释器 interpretClaim 已兼容，流内分类器是
  // 漏网同类，R26 T-3）：不归一会把 "1001"/"401" 全归 server，不换号不记冷却。
  const rawCode = frame.code
  const code = typeof rawCode === 'number'
    ? rawCode
    : typeof rawCode === 'string' && /^-?\d+$/.test(rawCode.trim()) ? Number(rawCode.trim()) : 0
  const raw = typeof frame.message === 'string' ? frame.message.trim() : ''
  // data 不是 JSON 对象时（空、纯文本、JSON 字符串），把原文作为原因：
  // 上游都明确标了 `event: error`，不能因为形状不标准就把失败吞掉。
  const text = typeof chunk === 'string' ? chunk.trim() : ''
  // 1005 的 `message` 经常是空字符串（真正的信息在 `extra: {"plan":4}` 里），
  // 直接透传会得到一句「Trae 流返回错误 1005」，对用户没有任何帮助。
  const message = code === 1005
    ? '当前 Trae 套餐不能使用这个模型（上游回 1005）。请换一个模型，或在 Trae 里升级套餐。'
    : raw !== '' ? raw : text !== '' ? `Trae 返回错误：${text.slice(0, 160)}` : code > 0 ? `Trae 流返回错误 ${String(code)}` : 'Trae 返回了错误帧（没有给出 code 与 message）。'
  // 1001/401/403 是登录失效：归 server 会让它既不换号也不记 AUTH 冷却，
  // 上游明明说了"令牌不行"，用户看到的却是"服务端错误"（R24 的 T-19）。
  const authLike = code === 1001 || code === 401 || code === 403
  const status = code === 1005 ? 402 : authLike ? 401 : 502
  const kind = code === 1005 ? 'quota' : authLike ? 'auth' : 'server'
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
  const shapeError = (why) => ({
    state: 'error',
    remain: 0,
    total: 0,
    unit: 'credits',
    items: [],
    message: `Trae 额度响应格式异常：${why}`,
    fetchedAt: Date.now(),
  })
  // 200 只说明 HTTP 通了，不等于这份 JSON 就是额度快照。旧实现直接取
  // `body.usage_summary ?? {}`，字段缺失时会得到 total=0、consumed=0，
  // 再被 `freePlan = total <= 0` 判成「Free / 0 积分」—— 上游改 schema、
  // 或 200 包一层错误体时，读取失败被伪装成「你真的没有额度」，
  // 也不进任何失败分支（卡片不显示原因、账本不记 warn）。
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return shapeError('响应不是对象')
  if (typeof body.code === 'number' && Number.isFinite(body.code) && body.code !== 0) {
    return shapeError(`业务返回码 ${String(body.code)}`)
  }
  const summary = body.usage_summary
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) {
    return shapeError('缺少 usage_summary')
  }
  const hasTotal = typeof summary.total_amount === 'number' && Number.isFinite(summary.total_amount)
  const hasConsumed = typeof summary.consumed_amount === 'number' && Number.isFinite(summary.consumed_amount)
  if (!hasTotal && !hasConsumed) return shapeError('usage_summary 里没有可读的金额字段')
  const total = hasTotal ? summary.total_amount : 0
  const consumed = hasConsumed ? summary.consumed_amount : 0
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
 * 发一次签到请求（状态/领取共用）。
 *
 * @param variantId - 变体。
 * @param credential - 凭证。
 * @param path - 端点路径。
 * @param generation - 设备代次（9074 后换身份重试）。
 * @param signal - 取消。
 * @returns `{ok, status, body?, message?, inactive?}`。
 */
async function postTraeCheckin(variantId, credential, path, generation, signal) {
  const endpoints = endpointsFor(variantId)
  try {
    const response = await fetch(`${endpoints.apiHost}${path}`, {
      method: 'POST',
      headers: traeCheckinHeaders(variantId, credential, generation),
      body: '{}',
      signal: withTimeout(signal, CHECKIN_TIMEOUT_MS),
    })
    if (!response.ok) {
      // 404→「无活动」的理由只对国际版成立（它本来就没有这个活动）。国内版
      // 吃到 404 说明路由变了或被网关挡住，当成 inactive 会把真故障藏起来：
      // 当天直接标完成，奖励静默丢失。与额度端点 404 同一套区分。
      if (response.status === 404 && variantId === 'trae-global') {
        return { ok: false, inactive: true, status: 404, message: 'Trae 国际版没有签到活动' }
      }
      return { ok: false, status: response.status, message: `HTTP ${String(response.status)}` }
    }
    const body = await response.json().catch(() => undefined)
    return { ok: true, status: response.status, body }
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 构造一个失败结论。 */
function failedAt(message, extra = {}) {
  return { kind: 'failed', fetchedAt: Date.now(), message, ...extra }
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
  const response = await postTraeCheckin(variantId, credential, '/trae/api/v2/ug/checkin_credits/status', 0, signal)
  if (!response.ok) {
    if (response.inactive === true) return { kind: 'inactive', fetchedAt: Date.now(), message: response.message }
    return failedAt(response.message)
  }
  return interpretCheckinStatus(response.body)
}

/**
 * 解释签到状态。
 * @param body - 响应。
 * @returns 归一化状态。
 */
export function interpretCheckinStatus(body) {
  const at = Date.now()
  if (body === null || typeof body !== 'object') return { kind: 'failed', fetchedAt: at, message: '响应格式异常' }
  const rawCode = body.code
  const code = typeof rawCode === 'number'
    ? rawCode
    : typeof rawCode === 'string' && /^-?\d+$/.test(rawCode.trim()) ? Number(rawCode.trim()) : undefined
  if (code !== undefined && code !== 0) {
    const message = [body.message, body.msg].find((value) => typeof value === 'string' && value.trim() !== '')
    return { kind: 'failed', fetchedAt: at, message: message ?? `code ${String(code)}` }
  }
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
 * 国内版命中 `code 9074`（「当前参与用户太多」）时，换一代设备身份再试一次：
 * 上游把它当成设备级风控（官方客户端也会记录 `traeCheckinDeviceGeneration`），
 * 只换请求头里的设备/会话 id，不动账号。只重试一次 —— 如果确实全员繁忙，
 * 连续请求只会加重风控，剩下的交给调度器 10 分钟后再来。
 *
 * @param variantId - 变体。
 * @param credential - 凭证。
 * @param signal - 取消。
 * @returns `{kind, credit?, message?}`。
 */
export async function claimCheckin(variantId, credential, signal) {
  const first = await postTraeCheckin(variantId, credential, '/trae/api/v2/ug/checkin_credits/claim', 0, signal)
  if (!first.ok) {
    if (first.inactive === true) return { kind: 'inactive', fetchedAt: Date.now(), message: first.message }
    return failedAt(first.message)
  }
  const verdict = interpretClaim(first.body)
  if (verdict.busy !== true || signal?.aborted === true) return verdict
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  if (signal?.aborted === true) return verdict
  const second = await postTraeCheckin(variantId, credential, '/trae/api/v2/ug/checkin_credits/claim', 1, signal)
  if (!second.ok) return verdict
  return interpretClaim(second.body)
}

/**
 * 解释领取结果。
 *
 * 上游只回 `{code, message}`：`0` 成功、`10001` 今天已领。
 * `9074` 是「当前参与用户太多」——不是账号没资格，也不是今天已领，
 * 必须保留成可重试的失败（`busy:true`），让调度器 10 分钟后再来。
 * 其他非零一律当失败，并原样带上上游文案。
 *
 * @param body - 响应。
 * @returns 归一化结果。
 */
export function interpretClaim(body) {
  const at = Date.now()
  if (body === null || typeof body !== 'object') return { kind: 'failed', fetchedAt: at, message: '响应格式异常' }
  const rawCode = body.code
  const code = typeof rawCode === 'number'
    ? rawCode
    : typeof rawCode === 'string' && /^-?\d+$/.test(rawCode.trim()) ? Number(rawCode.trim()) : -1
  if (code === 0) {
    // 上游的成功体通常只有 `{code:0,message:'success'}`，没有积分数。此时不要
    // 编造 `credit:0`（那会让运行时无法回落到状态端点的 100/200 分，卡片显示
    // 「签到成功 +0」）；只有上游真的给了数字才带上。
    const credit = typeof body.credits === 'number' ? body.credits : typeof body.credit === 'number' ? body.credit : undefined
    return { kind: 'claimed', fetchedAt: at, ...(credit === undefined ? {} : { credit }), message: '签到成功' }
  }
  if (code === 10001 || code === 1001) return { kind: 'already', fetchedAt: at, message: '今天已签到' }
  if (code === 9074) {
    return { kind: 'failed', fetchedAt: at, busy: true, message: '签到人数过多，请稍后再试（会自动重试）' }
  }
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
