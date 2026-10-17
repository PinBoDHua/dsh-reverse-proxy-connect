/**
 * WorkBuddy 上游：模型目录 + 聊天流代理。
 *
 * 上游就是一个 OpenAI chat-completions 端点，所以「反代」这一侧几乎是透明的：
 * 我们只补认证与身份头、修几个上游不接受的写法，响应体原样回传。
 *
 * @module dsh-reverse-proxy-connect/workbuddy/upstream
 */

import { randomUUID } from 'node:crypto'

import { REASON } from '../protocol.js'
import { endpointsFor, readDesktopCredential, needsRefresh, refreshDesktopCredential } from './credentials.js'

/** 上游只接受流式；同时它认 OpenAI 的字段名。 */
const CLIENT_UA_BASE = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** 上游承认的思考档位（由弱到强）。 */
const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * 虚拟模型（花名册里有、`models[]` 里没有元数据，例如 `auto`）。
 *
 * 实测 `auto` 能正常聊天，只是上游不下发它的窗口与上限。用一组偏保守的默认值：
 * 上下文 128K、输出 32K —— 都远小于上游实际能力，宁可按小算也不要越界 400。
 *
 * @param id - 模型 id。
 * @returns 模型行。
 */
function virtualModel(id) {
  return {
    id,
    name: id === 'auto' ? 'Auto' : id,
    contextWindow: 128_000,
    maxTokens: 32_000,
    supportsImages: true,
    supportsReasoning: true,
    onlyReasoning: false,
    reasoningEfforts: [],
    defaultEffort: undefined,
    canDisableThinking: false,
    credits: undefined,
    virtual: true,
  }
}

/**
 * 该变体的一份可用凭证视图。
 * @param variantId - 变体。
 * @param settings - 插件设置。
 * @param state - 进程内的凭证缓存（`{credential, checkedAt}`）。
 * @returns 凭证。
 */
async function usableCredential(variantId, settings, state) {
  const options = settings.workbuddy?.[variantId] ?? {}
  let credential = await readDesktopCredential(variantId, options)
  if (needsRefresh(credential)) {
    credential = await refreshDesktopCredential(credential)
    state.credential = credential
  }
  return credential
}

/**
 * 所有聊天/目录请求共用的头。
 * @param credential - 凭证。
 * @param variantId - 变体。
 * @returns 头字典。
 */
function identityHeaders(credential, variantId) {
  const { webBase } = endpointsFor(variantId)
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: webBase,
    Referer: `${webBase}/`,
    'User-Agent': catalogUserAgent(variantId),
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': readClientVersion(variantId),
    ...(credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid }),
    ...(credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId }),
    ...(credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain }),
  }
}

/**
 * 目录请求的 User-Agent —— 这是取到**哪一份**花名册的唯一开关。
 *
 * 上游 `/v3/config` 按客户端身份分流（实测结论）：
 * - 纯 CLI UA（`CLI/2.63.2 CodeBuddy/2.63.2`）→ 只有 `cli` agent 的 18 个模型，
 *   **没有** `auto`；
 * - 纯 App UA（`WorkBuddy/5.5.6`）→ **没有 `cli` agent**，只有 craft/ask/plan 等
 *   桌面端内部花名册，聊天根本用不了；
 * - 桌面端自己的复合身份（`WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.63.2`）→
 *   `cli` agent 的 18 个模型**加上** `auto`，且 `models[]` 最完整（60 条）。
 *
 * 所以目录与聊天都用复合身份 —— 两处必须一致，否则会出现「目录里列了但聊天拒绝」。
 *
 * @param variantId - 变体。
 * @returns User-Agent 字符串。
 */
function catalogUserAgent(variantId) {
  const version = readClientVersion(variantId)
  if (variantId === 'workbuddy-ai') return `WorkBuddyAI/${version}`
  return `WorkBuddy/${version} WorkBuddy/${version} CLI/2.63.2`
}

/**
 * 浏览器身份版本号：目录接口按它分流 CLI 花名册 / App 花名册，必须与聊天一致。
 * @param variantId - 变体。
 * @returns 版本字符串。
 */
function readClientVersion(variantId) {
  return variantId === 'workbuddy-ai' ? '5.5.2' : '5.5.6'
}

/**
 * 把 OpenAI 请求体修正成上游能接受的写法。
 *
 * 四处是硬要求，缺一个就 400：
 * - `stream` 必须为 true；
 * - `role:"developer"` 必须改成 `"system"`；
 * - `reasoning_effort:"off"` 必须删掉（上游不认这个值）；
 * - 模型声明了「隐含档位」时**必须显式带上** `reasoning_effort`，见下。
 *
 * 最后一条是最反直觉的：`glm-5.1` 这类模型的 `reasoning` 只有
 * `{effort:"medium"}`、没有 `supportedEfforts`，此时**省略** `reasoning_effort`
 * 会被判为「不支持的思考强度」并 400；显式发 `"medium"` 反而正常。
 * 而 `hy3` 那种完全没有 `reasoning` 字段的模型，发不发都行。
 * 所以由调用方传入该模型的默认档位，命中第一类时才补上。
 *
 * @param text - 原始 JSON 文本。
 * @param impliedEffort - 该模型的隐含/默认思考档位（可省略）。
 * @returns 修正后的 JSON 文本。
 */
export function prepareChatBody(text, impliedEffort) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return text
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return text
  body.stream = true
  if (body.reasoning_effort === 'off') delete body.reasoning_effort
  if (body.reasoning_effort === undefined && typeof impliedEffort === 'string' && impliedEffort !== '') {
    body.reasoning_effort = impliedEffort
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message !== null && typeof message === 'object' && message.role === 'developer') message.role = 'system'
    }
    // 国际版网关要求首条是 system；国内版加与不加都接受，所以两个地区统一加。
    if (body.messages.length > 0 && body.messages[0]?.role !== 'system') {
      body.messages.unshift({ role: 'system', content: 'You are a helpful assistant.' })
    }
  }
  // 上游 tool_choice 只收字符串；对象形式一律 400。
  if (body.tool_choice !== undefined && typeof body.tool_choice === 'object' && body.tool_choice !== null) {
    const type = typeof body.tool_choice.type === 'string' ? body.tool_choice.type : ''
    if (type === 'auto' || type === 'required') body.tool_choice = type
    else if (type === 'function' && typeof body.tool_choice.function?.name === 'string') body.tool_choice = body.tool_choice.function.name
    else delete body.tool_choice
  }
  return JSON.stringify(body)
}

/**
 * 读上游错误信封，挑出最适合给人看的那句。
 * @param text - 响应体。
 * @returns 一句话。
 */
function describeError(text) {
  try {
    const parsed = JSON.parse(text)
    return parsed?.displayMsg?.zh ?? parsed?.displayMsg?.en ?? parsed?.msg ?? text.slice(0, 200)
  } catch {
    return text.slice(0, 200) || '(empty body)'
  }
}

/**
 * 列该变体的模型目录。
 * @param variantId - 变体。
 * @param settings - 插件设置。
 * @param state - 进程内缓存。
 * @param signal - 取消。
 * @returns 模型行列表。
 * @throws 上游失败时抛错，调用方决定是降级还是报错。
 */
export async function fetchCatalog(variantId, settings, state, signal) {
  const credential = await usableCredential(variantId, settings, state)
  const { chatBase } = endpointsFor(variantId)
  const response = await fetch(`${chatBase}/v3/config`, {
    headers: { ...identityHeaders(credential, variantId), Authorization: `Bearer ${credential.accessToken}` },
    signal: signal ?? AbortSignal.timeout(25_000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new UpstreamFailure(REASON.upstreamError, `WorkBuddy 模型目录返回 HTTP ${String(response.status)}：${describeError(text)}`, response.status)
  }
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch (cause) {
    throw new UpstreamFailure(REASON.upstreamError, 'WorkBuddy 模型目录不是合法 JSON。', 502, cause)
  }
  if (envelope?.code !== 0) {
    throw new UpstreamFailure(REASON.upstreamError, `WorkBuddy 模型目录：${describeError(text)}`, 502)
  }
  return parseCatalog(envelope.data ?? {}, variantId)
}

/** 上游失败：带 HTTP 状态，反代据此决定回给 pi-ai 的状态码。 */
export class UpstreamFailure extends Error {
  /**
   * @param code - REASON 码。
   * @param message - 说明。
   * @param status - HTTP 状态。
   * @param cause - 底层错误。
   */
  constructor(code, message, status, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'UpstreamFailure'
    this.code = code
    this.status = status
  }
}

/**
 * 把 `/v3/config` 的文档解析成模型行。
 *
 * 花名册来自 `agents[]` 里名为 `cli` 的那个 agent 的 `models[]`（字符串 id 列表），
 * 模型元数据来自 `models[]`。两者取交集，顺序按花名册 —— 这是上游自己客户端的行为。
 *
 * 三个必须小心的点：
 * 1. **没有 `cli` agent 时不能退到 `agents[0]`**。App 身份的响应里第一个 agent 是
 *    `craft`（桌面端内部编码用），拿它当花名册会得到一个 10 条的假目录。
 *    没有 cli agent 就说明这次请求的客户端身份不对，直接报错比给出假清单好。
 * 2. **`auto` 是虚拟 id**：它出现在花名册里但不在 `models[]` 里。它确实能聊天
 *    （实测 200），所以不能因为查不到元数据就丢掉，得给它一组保守默认值。
 * 3. `reasoning` 存在但 `supportedEfforts` 为空时（如 `glm-5.1` 只有
 *    `{effort:"medium"}`），上游**要求显式发** `reasoning_effort`，否则 400。
 *    所以要把这个隐含档位当成唯一可选档位记下来。
 *
 * @param data - 文档。
 * @param variantId - 变体。
 * @returns 模型行。
 */
export function parseCatalog(data, variantId) {
  const rows = new Map()
  for (const row of Array.isArray(data?.models) ? data.models : []) {
    if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue
    if (row.disabled === true) continue
    const maxInput = typeof row.maxInputTokens === 'number' ? row.maxInputTokens : 0
    const maxOutput = typeof row.maxOutputTokens === 'number' ? row.maxOutputTokens : 0
    if (maxInput <= 0 || maxOutput <= 0) continue
    rows.set(row.id, row)
  }

  const agents = Array.isArray(data?.agents) ? data.agents : []
  const cli = agents.find((agent) => agent?.name === 'cli')
  if (cli === undefined || !Array.isArray(cli.models)) {
    throw new UpstreamFailure(
      REASON.upstreamError,
      `WorkBuddy ${variantId} 的模型目录里没有 cli 花名册（说明请求的客户端身份不对）。这是一个 bug，请反馈。`,
      502,
    )
  }
  const roster = cli.models.filter((id) => typeof id === 'string' && id !== '')

  const models = []
  for (const id of roster) {
    const row = rows.get(id)
    if (row === undefined) {
      // 虚拟 id（`auto` 之类）：没有元数据，但确实可聊，给保守默认值。
      models.push(virtualModel(id))
      continue
    }
    const supportsImages = row.supportsImages === true && row.disabledMultimodal !== true
    const declared = Array.isArray(row.reasoning?.supportedEfforts)
      ? row.reasoning.supportedEfforts.filter((effort) => REASONING_LEVELS.includes(effort))
      : []
    // 隐含档位：`reasoning.effort` 有值但没声明可选集时，那就是唯一可用的档位。
    const implied = typeof row.reasoning?.effort === 'string' && REASONING_LEVELS.includes(row.reasoning.effort) ? row.reasoning.effort : undefined
    const efforts = declared.length > 0 ? declared : implied === undefined ? [] : [implied]
    const defaultEffort =
      typeof row.reasoning?.defaultEffort === 'string' && efforts.includes(row.reasoning.defaultEffort)
        ? row.reasoning.defaultEffort
        : implied ?? (efforts.length > 0 ? efforts[0] : undefined)
    models.push({
      id,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : id,
      contextWindow: Math.max(1, Number(row.maxInputTokens) || 0),
      maxTokens: Math.max(1, Number(row.maxOutputTokens) || 0),
      supportsImages,
      supportsReasoning: row.supportsReasoning === true,
      onlyReasoning: row.onlyReasoning === true,
      reasoningEfforts: efforts,
      defaultEffort,
      canDisableThinking: row?.reasoning?.canDisableThinking === true,
      credits: typeof row.credits === 'string' ? row.credits : undefined,
    })
  }
  return models
}

/**
 * 打开一条上游聊天流。
 * @param variantId - 变体。
 * @param settings - 插件设置。
 * @param state - 进程内缓存。
 * @param bodyText - 已修正的 OpenAI 请求体。
 * @param signal - 取消。
 * @returns `{ response, credential }`。
 * @throws {UpstreamFailure}
 */
export async function openChatStream(variantId, settings, state, bodyText, signal) {
  const credential = await usableCredential(variantId, settings, state)
  const { chatBase } = endpointsFor(variantId)
  const response = await fetch(`${chatBase}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      ...identityHeaders(credential, variantId),
      Authorization: `Bearer ${credential.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      // 国际版网关自 2026-10-16 起强制要求这三件套，缺一即 400 / 11128。
      'X-Conversation-ID': randomUUID(),
      'X-Conversation-Request-ID': randomUUID(),
      'X-Conversation-Message-ID': randomUUID(),
    },
    body: bodyText,
    signal,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new UpstreamFailure(REASON.upstreamError, `WorkBuddy 聊天返回 HTTP ${String(response.status)}：${describeError(text)}`, response.status)
  }
  return response
}

/**
 * 一个变体的「状态快照」：登录情况 + 目录来源。
 * @param variantId - 变体。
 * @param settings - 插件设置。
 * @param state - 进程内缓存。
 * @param signal - 取消。
 * @returns 状态。
 */
export async function describeVariant(variantId, settings, state, signal) {
  try {
    const models = await fetchCatalog(variantId, settings, state, signal)
    state.models = models
    state.catalogSource = 'live'
    state.catalogFetchedAt = Date.now()
    return { status: 'signed-in', catalogSource: 'live', fetchedAt: state.catalogFetchedAt, models }
  } catch (error) {
    if (state.models !== undefined && state.models.length > 0) {
      return {
        status: 'degraded',
        catalogSource: 'saved',
        fetchedAt: state.catalogFetchedAt,
        models: state.models,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    return {
      status: 'signed-out',
      reason: error instanceof UpstreamFailure ? error.code : REASON.upstreamError,
      message: error instanceof Error ? error.message : String(error),
      models: [],
    }
  }
}

export { CLIENT_UA_BASE }
