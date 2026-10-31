/**
 * 「Qoder 首包排队预算用完了」。
 *
 * 只在 `#openQoderQueued` 的内部看门狗里用：它让一次挂住不返回的尝试在预算
 * 到点时立刻结束，好让外层给出「正在排队」的明确结论，而不是等 60 秒的
 * 通用死线说一句「没有给出响应头」。
 */
class QoderQueueBudgetError extends Error {
  constructor(budgetMs) {
    super(`Qoder 首包等待超过 ${String(Math.round(budgetMs / 1000))} 秒。`)
    this.name = 'QoderQueueBudgetError'
    this.kind = 'soft-rate'
    this.code = 'soft-rate'
  }
}

/**
 * 运行时：在适配器与三个上游（WorkBuddy / Qoder / Trae）之间做 DSH 消息 →
 * 上游 body 的翻译，并持有每个 provider 的目录、凭证、额度缓存与健康状态。
 *
 * 1.0.0 的四处结构性改动（都是踩过坑才改的）：
 *
 * 1. **凭证只解析一次**。旧版目录/聊天走 `readDesktopCredential()`，额度与签到
 *    走 `credentialForAccount()` —— 于是浏览器登录导入的账号只有额度能读，
 *    聊天还在找本机登录文件。现在四个入口共用同一份解析结果。
 * 2. **目录按账号缓存**。同一个 provider 的多个账号可能有不同套餐、不同模型；
 *    目录落盘缓存也按 `provider::account` 存，切号后立刻能恢复对应清单。
 * 3. **真正的空闲超时**。旧版用 `AbortSignal.timeout(300_000)` 当整条流总超时，
 *    会把持续 5 分钟以上的正常长回答切断。现在只有「连续一段时间没有事件」
 *    才 abort。
 * 4. **请求级自动换号**。额度刷新时的自动切换只能防患于未然；如果请求已经
 *    因为 401/额度耗尽失败、且还没吐出任何内容，这里会就地换一个账号重开，
 *    用户看不到一次白等。
 *
 * @module dsh-reverse-proxy-connect/runtime
 */

import {
  accountKey,
  accountsFor,
  activeAccountFor,
  isBelowThreshold,
  isExhausted,
  isUnconfiguredCredential,
  pickFailoverCandidates,
  pickSwitchTarget,
} from './accounts.js'
import { sweepTempFiles } from './atomic.js'
import { loadCatalogCache, saveCatalogCache } from './catalog-cache.js'
import { qoderClaimCampaigns, workbuddyCheckinStatus, workbuddyClaimCheckin } from './checkin.js'
import { CreditHistory, creditsHistoryPathOf } from './credit-history.js'
import { emptyCredits, fetchQoderCredits, fetchWorkBuddyCredits } from './credits.js'
import { loadCreditsCache, saveCreditsCache } from './credits-cache.js'
import { fallbackModelsFor } from './fallback-models.js'
import { collectImageRefs, imageDataUrl, imageHandleText, imageRequestTargetOf, ImageReadError } from './images.js'
import {
  DEFAULT_QODER_QUEUE_WAIT_MS,
  OPEN_TIMEOUT_MS,
  PROVIDERS,
  PROVIDER_IDS,
  REASON,
} from './protocol.js'
import { advancedOptions, providerOptions } from './settings.js'
import { isQoderFreePlan } from './quota.js'
import { abortReasonOf, CancelledError, DeadlineError, IdleTimeoutError, maxSilentMsOf, openDeadline, sleep, withIdleTimeout } from './timeout.js'
import {
  needsRefresh,
  readDesktopCredential,
  refreshDesktopCredential,
} from './workbuddy/credentials.js'
import { fetchCatalog as fetchWorkBuddyCatalog, openChatStream, prepareChatBody } from './workbuddy/upstream.js'
import {
  buildChatEnvelope,
  describeQueue,
  fetchCatalog as fetchQoderCatalog,
  fetchQueueStatus as fetchQoderQueueStatus,
  openChat as openQoderChat,
  parseStream as parseQoderStream,
  readMachineId,
  resolveIdentity,
} from './qoder/transport.js'
import {
  describeStoredAuth,
  resolveTraeCredential,
} from './trae/credential.js'
import {
  buildChatBody as buildTraeChatBody,
  checkinStatus as traeCheckinStatus,
  claimCheckin as traeClaimCheckin,
  fetchCatalog as fetchTraeCatalog,
  fetchCredits as fetchTraeCredits,
  openChat as openTraeChat,
  parseStream as parseTraeStream,
} from './trae/transport.js'

/** Trae 的两个 provider（凭证、目录、聊天都走同一套）。 */
const TRAE_PROVIDERS = new Set([PROVIDERS.trae, PROVIDERS.traeGlobal])

/**
 * 这个 provider 是不是 Trae。
 * @param provider - provider id。
 * @returns 是否 Trae。
 */
function isTrae(provider) {
  return TRAE_PROVIDERS.has(provider)
}

/**
 * provider → Trae 变体 id（`trae` / `trae-global`）。
 * @param provider - provider id。
 * @returns 变体 id。
 */
function traeVariantOf(provider) {
  return provider === PROVIDERS.traeGlobal ? 'trae-global' : 'trae'
}

/** 目录请求的超时。 */
const CATALOG_TIMEOUT_MS = 30_000

/** 请求级换号的冷却时间：认证/额度问题冷却久一点，服务端故障短一点。 */
const FAILOVER_COOLDOWN_MS = Object.freeze({
  AUTH: 120_000,
  QUOTA: 120_000,
  RATE_LIMIT: 30_000,
  SERVER: 15_000,
  TIMEOUT: 15_000,
  default: 10_000,
})

/**
 * Qoder 免费模型排队时，本地最多帮用户等多久。
 *
 * 上游的排队常常是 30 秒一轮。旧实现会等 4 轮（约 2 分钟）才报错，
 * 用户看到的是「卡了两分钟然后失败」。超过这个预算就直接给出明确的
 * RATE_LIMIT，让 DSH 的错误提示与重试按钮接管。
 */
const QODER_QUEUE_BUDGET_MS = DEFAULT_QODER_QUEUE_WAIT_MS

/** 首包（还没建立流）阶段的排队预算：比流中更短，避免打开阶段就卡两分钟。 */
const QODER_OPEN_QUEUE_BUDGET_MS = 45_000

/**
 * 「测试账号」与「能力探测」各自的一次性死线。
 *
 * 必须**大于** Qoder 的首包排队预算：两者相等时，排队失败那句明确解释
 * （「免费模型正在排队，已等待 N 秒」）会和看门狗的 abort 同时到期，
 * 谁先谁后取决于计时器顺序。实测先到的是 abort，于是卡片上只剩
 * `ABORTED` + `aborted` —— 一句什么都不说明的话。
 *
 * 留 15 秒余量：排队预算用完 → 抛出排队失败 → 测试拿到 `RATE_LIMIT` 与
 * 真正的原因。死线只在「上游连响应头都不给」时兜底。
 */
const TEST_DEADLINE_MS = 60_000

/**
 * 「深度测试」的请求形状。
 *
 * 普通测试只发 `ping` + `max_tokens:1`：它能证明凭证/额度/路由可用，却证明
 * 不了**对话链路**可用 —— 2026-10-21 那次 `HTTP 400 请求被拦截` 就是典型：
 * 1-token 测试 200，真实 agent 请求（系统提示词 + 工具表）被网关拦。
 * 深度测试按真实请求的骨架发一次：带系统提示词、工具 schema 与正常输出上限，
 * 只要它通过，基本可以排除「请求形状/体积」这一类问题。
 */
const DEEP_TEST_SYSTEM = 'You are a coding agent. Answer exactly as the user asks, with no extra commentary.'
const DEEP_TEST_PROMPT = '回复两个字：可用'
const DEEP_TEST_MAX_TOKENS = 512
const DEEP_TEST_TOOL_SCHEMAS = Object.freeze([
  Object.freeze({
    name: 'read',
    description: 'Read a UTF-8 text file from the workspace and return its contents.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({ path: Object.freeze({ type: 'string', description: 'Absolute path.' }) }),
      required: Object.freeze(['path']),
    }),
  }),
  Object.freeze({
    name: 'pwsh',
    description: 'Run a PowerShell command and return its stdout/stderr.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({ command: Object.freeze({ type: 'string', description: 'Command line.' }) }),
      required: Object.freeze(['command']),
    }),
  }),
])

/** 底层网络错误码：这些属于“连接断了”，DSH 的 TRANSPORT 重试策略能处理。 */
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/** 全文展开一条 DSH 消息里的文本块。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * 把 DSH 历史消息里的一次图片引用换成「说明文本 + data URL」。
 *
 * `images` 有两种形态：
 * - `Map<attachmentId, {dataUrl, width, height, ...}>`（运行时解析好的）；
 * - `(block) => dataUrl | undefined`（老调用方式，保持向后兼容）。
 *
 * @param images - 图片映射或解析函数。
 * @returns `(block) => ({url, entry?}) | undefined`。
 */
function imageResolver(images) {
  if (typeof images === 'function') {
    return (block) => {
      const url = images(block)
      return typeof url === 'string' && url !== '' ? { url } : undefined
    }
  }
  if (images instanceof Map) {
    return (block) => {
      const id = block?.attachment?.attachmentId
      if (typeof id !== 'string') return undefined
      const entry = images.get(id)
      return entry === undefined ? undefined : { url: entry.dataUrl, entry }
    }
  }
  return () => undefined
}

/**
 * 被宿主标记为 offload 的图片占位文本。
 *
 * DSH 在请求图片预算超限时会把最老的图片标成 `offloaded`，由适配器换成占位符；
 * 如果这里再走「读不到」的分支，模型会以为图片坏了。
 *
 * @param block - 图片块。
 * @returns 占位文本。
 */
function offloadedImageText(block) {
  const id = typeof block?.attachment?.attachmentId === 'string' ? block.attachment.attachmentId : 'unknown'
  return `[image omitted to fit request image limits; ${id}]`
}

/**
 * 把一条消息的内容块展开成 OpenAI 的 content parts。
 *
 * @param content - DSH 内容块数组。
 * @param resolve - 图片解析器。
 * @param role - 所属角色（决定图片缺失时的占位文案）。
 * @returns parts 数组。
 */
function contentParts(content, resolve, role) {
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type !== 'image') continue
    if (block.offloaded === true) {
      parts.push({ type: 'text', text: offloadedImageText(block) })
      continue
    }
    if (role === 'system') {
      // OpenAI 形状的 system 消息只接受文本；把图塞进去会被上游 400。
      const id = typeof block.attachment?.attachmentId === 'string' ? block.attachment.attachmentId : 'unknown'
      parts.push({ type: 'text', text: `[image omitted from system message; ${id}]` })
      continue
    }
    const resolved = resolve(block)
    if (resolved === undefined) {
      // 不能静默丢图：模型与用户都需要知道这里本来有一张图。
      parts.push({
        type: 'text',
        text: role === 'tool'
          ? '[an image was attached to this tool result but could not be read]'
          : '[an image was attached but could not be read]',
      })
      continue
    }
    if (resolved.entry !== undefined) parts.push({ type: 'text', text: imageHandleText(resolved.entry) })
    parts.push({ type: 'image_url', image_url: { url: resolved.url } })
  }
  return parts
}

/**
 * 把 DSH 的历史消息翻成 OpenAI chat 的 `messages`。
 *
 * DSH 的角色有 user / assistant / tool / system / developer，内容块有
 * text / reasoning / image / tool-call / tool-addition / tool-removal。
 *
 * 图片处理的两条规则：
 * - user / system 里的图片 → 说明文本 + `image_url`（data URL）；
 * - **tool 结果里的图片 → 工具消息保持纯文本，另起一条 user 消息携带图片**。
 *   OpenAI 形状的 tool 消息只接受文本，把图片塞进去会被上游 400；而视觉模型
 *   仍然需要看到这张图，所以用一条紧跟其后的 user 消息补齐。
 *
 * @param messages - DSH 的 RequestMessage 数组。
 * @param images - 可选的图片映射/解析函数。
 * @returns OpenAI 形状的消息数组。
 */
export function toOpenAiMessages(messages, images) {
  const out = []
  const resolve = imageResolver(images)
  /** 同一条 assistant 之后、连续多条 tool 结果里收集到的图片。 */
  let pendingToolPictures = []

  /** 把工具结果里的图片统一放到「最后一条连续 tool 消息」之后。 */
  const flushToolPictures = () => {
    if (pendingToolPictures.length === 0) return
    out.push({
      role: 'user',
      content: [{ type: 'text', text: 'Images attached to the tool results above:' }, ...pendingToolPictures],
    })
    pendingToolPictures = []
  }

  for (let index = 0; index < (messages ?? []).length; index++) {
    const message = messages[index]
    if (message === null || typeof message !== 'object') continue
    const role = message.role
    const content = Array.isArray(message.content) ? message.content : []
    if (role === 'tool') {
      // OpenAI 的 tool 消息只接受文本：图片要另起一条 user 消息携带，
      // 否则上游会 400；说明文本也跟着图片走，不混进工具输出里。
      // 但**必须等这一轮所有 tool 消息都发完**再插 user：assistant 的每个
      // tool_call 都要求后面连续跟着对应的 tool 响应，中间插一条 user 会
      // 破坏配对（并行工具里第一个结果带图时必现）。
      let text = textOf(content)
      const pictures = []
      for (const block of content) {
        if (block === null || typeof block !== 'object' || block.type !== 'image') continue
        if (block.offloaded === true) {
          text += `${text === '' ? '' : '\n'}${offloadedImageText(block)}`
          continue
        }
        const resolved = resolve(block)
        if (resolved === undefined) {
          text += `${text === '' ? '' : '\n'}[an image was attached to this tool result but could not be read]`
          continue
        }
        if (resolved.entry !== undefined) pictures.push({ type: 'text', text: imageHandleText(resolved.entry) })
        pictures.push({ type: 'image_url', image_url: { url: resolved.url } })
      }
      out.push({
        role: 'tool',
        tool_call_id: typeof message.toolCallId === 'string' ? message.toolCallId : '',
        content: text || '(no output)',
      })
      pendingToolPictures.push(...pictures)
      const next = messages[index + 1]
      if (next === null || typeof next !== 'object' || next.role !== 'tool') flushToolPictures()
      continue
    }
    // 非 tool 消息开始前，先把上一轮工具图片收尾（正常情况下上一条 tool 已经 flush）。
    flushToolPictures()
    if (role === 'assistant') {
      const text = textOf(content)
      const calls = content.filter((block) => block?.type === 'tool-call')
      if (text === '' && calls.length === 0) continue
      const row = { role: 'assistant', content: text }
      if (calls.length > 0) {
        row.tool_calls = calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) },
        }))
        if (text === '') row.content = null
      }
      out.push(row)
      continue
    }
    // system / developer / user 都走这里。
    const normalizedRole = role === 'system' || role === 'developer' ? 'system' : 'user'
    const parts = contentParts(content, resolve, normalizedRole)
    if (parts.length === 0) continue
    out.push({
      role: normalizedRole,
      content: parts.every((part) => part.type === 'text') ? parts.map((part) => part.text).join('') : parts,
    })
  }
  return out
}

/** 把 DSH 的 tools 翻成 OpenAI tools。 */
export function toOpenAiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools
    .filter((tool) => tool !== null && typeof tool === 'object' && typeof tool.name === 'string')
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    }))
}

/**
 * 错误 → DSH 的稳定 failure code。
 *
 * 与 `adapter.js` 的 `failureCode()` 分工不同：这里处理**抛出来的原始错误**
 * （含 HTTP 状态），那边处理归一化事件里的 kind。
 *
 * @param error - 任意错误。
 * @returns 稳定 code。
 */
export function failureCodeOf(error) {
  if (error?.name === 'AbortError') return 'ABORTED'
  // `AbortSignal.timeout()` 触发的 fetch 拒绝是 DOMException{name:'TimeoutError',
  // code:23}：既没有字符串 code 也没有 kind。旧分类一路落到 upstream-error，
  // 宿主的重试表里没有它 —— Qoder 换 token 或 userinfo 卡满 20 秒时，一次
  // 本来可重试的超时会被当成不可重试的上游错误，界面里还是句英文原文。
  if (error?.name === 'TimeoutError') return 'TIMEOUT'
  if (error instanceof IdleTimeoutError || error instanceof CancelledError) return error.code === 'ABORTED' ? 'ABORTED' : 'TIMEOUT'
  // 凭证类内部码优先于 `kind`：Qoder 的 QoderFailure 历史上默认 kind='server'，
  // 于是 PAT 失效明明带 pat-invalid，却被归成 SERVER，多账号换号不会触发。
  if (typeof error?.code === 'string') {
    switch (error.code) {
      case 'ABORTED':
        return 'ABORTED'
      case 'timeout':
        return 'TIMEOUT'
      case 'auth':
      case 'pat-invalid':
      case 'no-credential':
      case 'credential-unreadable':
      case 'credential-expired':
      case 'app-not-found':
      case 'app-ambiguous':
      case 'app-path-invalid':
      case 'region-mismatch':
        return 'AUTH'
      case 'quota':
        return 'QUOTA'
      case 'soft-rate':
        return 'RATE_LIMIT'
      case 'server':
        return 'SERVER'
      case 'TRANSPORT':
        return 'TRANSPORT'
      case 'EMPTY_RESPONSE':
        return 'EMPTY_RESPONSE'
      case 'CONTENT_FILTER':
        return 'CONTENT_FILTER'
      case REASON.imageUnavailable:
        return 'IMAGE_UNAVAILABLE'
      default:
        break
    }
  }
  if (typeof error?.kind === 'string') {
    switch (error.kind) {
      case 'soft-rate':
        return 'RATE_LIMIT'
      case 'quota':
        return 'QUOTA'
      case 'auth':
        return 'AUTH'
      case 'timeout':
        return 'TIMEOUT'
      case 'server':
        return 'SERVER'
      case 'malformed':
        return 'MALFORMED_RESPONSE'
      default:
        break
    }
  }
  if (typeof error?.code === 'string') {
    switch (error.code) {
      case 'ABORTED':
        return 'ABORTED'
      case 'timeout':
        return 'TIMEOUT'
      case 'auth':
      case 'pat-invalid':
      case 'no-credential':
      case 'credential-unreadable':
      case 'credential-expired':
      case 'app-not-found':
      case 'app-ambiguous':
      case 'app-path-invalid':
      case 'region-mismatch':
        return 'AUTH'
      case 'quota':
        return 'QUOTA'
      case 'soft-rate':
        return 'RATE_LIMIT'
      case 'server':
        return 'SERVER'
      case REASON.imageUnavailable:
        return 'IMAGE_UNAVAILABLE'
      default:
        break
    }
  }
  const status = typeof error?.status === 'number' ? error.status : undefined
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'QUOTA'
  if (status === 429) return 'RATE_LIMIT'
  // 408 / 504 是**网关侧超时**，与 5xx 同类（可重试），不是「请求本身有问题」。
  // 适配器的 `finishError()` 已经把这两个算进 SERVER，这里必须一致 —— 否则
  // CLI / 诊断说的分类与宿主看到的不一样。
  if (status === 408 || status === 504) return 'SERVER'
  if (typeof status === 'number' && status >= 500) return 'SERVER'
  // 最后一层：undici 的 fetch 失败通常只抛 `TypeError: fetch failed`，
  // 真正的错误码在 `cause.code`。以前这里落到 `upstream-error`，而 DSH 的
  // 默认重试表里没有它 —— 一次瞬时断连就把整轮回答结束掉。
  const causeCode = error?.cause?.code ?? error?.code
  if (typeof causeCode === 'string' && TRANSPORT_ERROR_CODES.has(causeCode)) return 'TRANSPORT'
  const message = typeof error?.message === 'string' ? error.message : ''
  if (/fetch failed|other side closed|premature close|socket hang up|ECONNRESET|UND_ERR_/i.test(message)) return 'TRANSPORT'
  return 'upstream-error'
}

/** 这个失败是不是 provider 级（换账号解决不了，例如 Qoder 免费池排队）。 */
export function isProviderScopedFailure(error) {
  return error?.noFailover === true || error?.scope === 'provider'
}

/**
 * 凭证探测里可以缓存 60 秒的失败。
 *
 * 只有「凭证本身的状态」才会稳定重复：没登录、文件损坏、PAT 无效、路径填错。
 * 超时、取消、上游 5xx、TLS/网络错误都是瞬时的 —— 缓存它们会让卡片在凭证
 * 恢复后仍显示「未登录」整整一分钟，期间也不再重新探测。
 */
const CACHEABLE_CREDENTIAL_FAILURES = new Set([
  REASON.noCredential,
  REASON.credentialUnreadable,
  REASON.credentialExpired,
  REASON.appNotFound,
  REASON.appAmbiguous,
  REASON.appPathInvalid,
  REASON.regionMismatch,
  REASON.patInvalid,
])

/**
 * 把凭证探测的异常归一成稳定 reason。
 *
 * 前端与 CLI 都按字符串比较 reason；`AbortSignal.timeout()` 抛的
 * DOMException 只有数字 `code`（23 = TimeoutError，20 = AbortError），
 * 直接透出会让 `reason === 'timeout'` 之类的判断全部失效。
 *
 * @param error - 任意异常。
 * @returns 稳定 reason。
 */
function credentialFailureReasonOf(error) {
  if (typeof error?.code === 'string' && error.code !== '') return error.code
  if (error?.name === 'TimeoutError' || error?.code === 23) return REASON.timeout
  if (error?.name === 'AbortError' || error?.code === 20) return 'ABORTED'
  if (error?.name === 'IdleTimeoutError' || error?.name === 'DeadlineError') return REASON.timeout
  return REASON.credentialUnreadable
}

/**
 * 这个失败值不值得换一个账号重试。
 *
 * 只认「这个账号自己的问题」：认证失效、额度耗尽。服务端 5xx、超时、
 * 模型不支持都不换 —— 换号解决不了，还会让一次请求发两遍。
 *
 * @param code - failure code。
 * @returns 是否换号。
 */
export function isFailoverCode(code) {
  return code === 'AUTH' || code === 'QUOTA' || code === 'RATE_LIMIT'
}

/**
 * 合并「错误体里的队列信息」与「等位接口返回的状态」。
 *
 * 两份数据的字段名不同（`queueType`/`type`、`queueCount`/`count`、
 * `serviceAvailable`/`available`），以等位接口为准：它才是上游实时状态。
 *
 * @param base - 错误体里的 `failure.queue`。
 * @param status - `fetchQueueStatus()` 的返回值。
 * @returns 合并后的队列信息，或 undefined。
 */
function mergeQueueInfo(base, status) {
  if (status === undefined) return base
  return {
    ...(base ?? {}),
    ...(status.queueType === undefined ? {} : { type: status.queueType }),
    ...(status.count === undefined ? {} : { count: status.count }),
    ...(status.available === undefined ? {} : { available: status.available }),
    ...(status.subCode === undefined ? {} : { subCode: status.subCode }),
  }
}

/**
 * Qoder 排队超过本地等待预算时的错误。
 *
 * 仍然是 `soft-rate`（DSH 侧会映射成 `RATE_LIMIT`），但文案必须分清两件事：
 *
 * - **真的在排队**（`queueCount > 0`）：明确说「前面还有 N 个请求」；
 * - **上游没有容量**（`serviceAvailable:false` + `queueCount:0`，
 *   `subCode:RESOURCE_LIMIT`）：不能说成「你在排队」。Qoder 对这两种情况都回
 *   `isQueued:true`，旧实现一律写「免费模型正在排队」，用户拿官方客户端一对比
 *   就会认为插件在骗人——而真实原因是免费池当前不接客，等下去也不会轮到你。
 *
 * @param error - 上游最后一次排队错误（`error.queue` 里带队列详情）。
 * @param elapsedMs - 已经等待的时间。
 * @param budgetMs - 本地等待预算。
 * @param options - `{ attemptsExhausted?, queue?, planHint? }`。
 * @returns 带稳定 code 的错误。
 */
export function qoderQueueFailure(error, elapsedMs, budgetMs, options = {}) {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  const budget = Math.max(1, Math.round(budgetMs / 1000))
  const queue = options?.queue ?? error?.queue
  const verdict = describeQueue({
    queueCount: queue?.count,
    serviceAvailable: queue?.available,
    queueType: queue?.type,
    subCode: queue?.subCode,
  })
  const reason = options?.attemptsExhausted === true
    ? '本地重开次数已用尽'
    : `超过本地 ${String(budget)} 秒上限`
  const ahead = typeof queue?.count === 'number' && queue.count > 0 ? `，前面还有 ${String(queue.count)} 个请求` : ''
  const planHint = typeof options?.planHint === 'string' && options.planHint !== '' ? options.planHint : ''
  const message = verdict.verdict === 'capacity'
    ? `Qoder 免费模型当前没有可用容量（上游 RESOURCE_LIMIT，排队人数 ${String(queue?.count ?? 0)}，不是你排在别人后面；已在 ${String(seconds)} 秒内确认）。`
      + `这不是令牌失效、也不是模型下线；${planHint}免费池的容量由上游控制，继续等不会轮到你：请稍后重试，或换一个有额度的账号 / 其它 provider。`
    : `Qoder 免费模型正在排队（已等待 ${String(seconds)} 秒，${reason}${ahead}）。这不是令牌失效或模型下线；请稍后重试，避开高峰期。`
  const failure = new Error(message)
  failure.name = verdict.verdict === 'capacity' ? 'QoderCapacityExhausted' : 'QoderQueueTimeout'
  failure.kind = 'soft-rate'
  failure.code = 'soft-rate'
  failure.status = 429
  if (Object.keys(verdict.info).length > 0) failure.queue = verdict.info
  // 排队/容量都是**整个 Qoder 免费池**的问题，不是某个账号坏了。换账号只会
  // 重新排一次队（每个候选还会各拿一份预算），所以标记成 provider 级失败，
  // openStream 见到它不再换号。
  failure.scope = 'provider'
  failure.noFailover = true
  if (typeof error?.retryAfterMs === 'number') failure.retryAfterMs = error.retryAfterMs
  return failure
}

/**
 * 归一化上游「流中报错」帧。
 *
 * 三家上游都会在 200 的流里塞错误对象，但字段名与语义各不相同；以前
 * WorkBuddy 一律当 server、Qoder 直接忽略（变成空白回答）。这里按
 * code/message/isQueued/isQuotaExceeded 统一分类。
 *
 * @param message - 上游文案。
 * @param rawCode - 上游 code（数字或字符串）。
 * @param options - `{ isQueued?, isQuota? }`。
 * @returns 带 kind/code 的 Error。
 */
function inBandFailure(message, rawCode, options = {}) {
  const text = typeof message === 'string' && message !== '' ? message : '上游在流中返回了错误'
  const failure = new Error(text)
  failure.name = 'InBandFailure'
  const printed = rawCode === undefined || rawCode === null ? '' : String(rawCode)
  const lower = text.toLowerCase()
  if (options.isQueued === true || printed === '10605' || /排队|queued|too many requests|rate limit/.test(lower)) {
    failure.kind = 'soft-rate'
    failure.code = 'soft-rate'
    failure.status = 429
    // 排队是 provider 级容量问题，不该换账号重排。
    failure.scope = 'provider'
    failure.noFailover = true
  } else if (options.isQuota === true || printed === '110' || printed === '1005' || /quota|额度|余额不足|insufficient|exhausted/.test(lower)) {
    failure.kind = 'quota'
    failure.code = 'quota'
    failure.status = 402
  } else if (printed === '1001' || printed === '401' || printed === '403' || /认证|unauthor|invalid token|登录失效/.test(lower)) {
    failure.kind = 'auth'
    failure.code = 'auth'
    failure.status = 401
  } else {
    failure.kind = 'server'
    failure.code = 'server'
    failure.status = 502
  }
  return failure
}

/**
 * 从上游「限额」文案里提取重置时间。
 *
 * WorkBuddy 429 的正文形如：
 * `您的使用量已超出频率限制，将在 2026-10-19 15:33:04 UTC+8 重置…`
 * 卡片只需要把这段时间原样显示给用户；不猜时区，避免把 UTC+8 当成本地时间。
 *
 * 必须**先确认这次失败确实是限额/额度类**（code 或文案语境），否则账号降级、
 * 模型下线、风控解除的文案里的日期会被当成「限额重置时间」显示到卡片上。
 *
 * @param message - 上游文案。
 * @param code - 稳定 failure code（可选；`RATE_LIMIT` / `QUOTA` 一定属于限额）。
 * @returns 形如 `2026-10-19 15:33:04 UTC+8`，或 undefined。
 */
export function resetHintOf(message, code) {
  if (typeof message !== 'string' || message === '') return undefined
  const byCode = code === 'RATE_LIMIT' || code === 'QUOTA'
  const byMessage = /限额|限流|频率|额度|重置|rate.?limit|too many requests|quota|reset/i.test(message)
  if (!byCode && !byMessage) return undefined
  const match = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})(?:\s*((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?))?/i.exec(message)
  if (match === null) return undefined
  return match[2] === undefined ? match[1] : `${match[1]} ${match[2].replace(/\s+/g, '')}`
}

/**
 * 每个 provider 的目录、额度、凭证与请求健康状态。
 */
export class Runtime {
  /**
   * @param options - `{ settings, dataDir, logger, onCatalogChange, onCredentialRefreshed, onAccountSwitch, stats, events }`。
   */
  constructor(options) {
    this.settings = options.settings
    this.dataDir = options.dataDir
    this.logger = options.logger
    this.onCatalogChange = options.onCatalogChange
    this.onCredentialRefreshed = options.onCredentialRefreshed
    this.onAccountSwitch = options.onAccountSwitch
    this.stats = options.stats
    /** 事件账本（可选）：只记元数据，写失败不影响主流程。 */
    this.events = options.events
    /** @type {Map<string, {models: any[], fetchedAt: number, source: string, message?: string}>} */
    this.catalogs = new Map()
    /** @type {Map<string, any>} */
    this.identities = new Map()
    /** @type {Map<string, {data: any, fetchedAt: number, stale?: boolean, error?: string, inflight?: Promise<any>}>} */
    this.creditCache = loadCreditsCache(options.dataDir)
    // 老缓存 / 内存里手动构造的 Map 可能没有墓碑集合：统一补一个。
    if (!(this.creditCache.forgotten instanceof Set)) this.creditCache.forgotten = new Set()
    if (!(this.creditCache.revived instanceof Set)) this.creditCache.revived = new Set()
    /** 目录缓存（provider::account → {models, fetchedAt}）。用户关掉缓存时不读也不写。 */
    this.catalogCache = advancedOptions(this.settings()).catalogCache ? loadCatalogCache(options.dataDir) : new Map()
    // 与额度缓存同构：删除账号时写墓碑，账号重新出现并成功拉到目录后要能撤销它。
    // 只在内存里删墓碑不够 —— 落盘前会与磁盘上的旧墓碑合并，下一次启动又把
    // 新账号的目录过滤掉（默认账号删除后重新配置就是这条路径）。
    if (!(this.catalogCache.forgotten instanceof Set)) this.catalogCache.forgotten = new Set()
    if (!(this.catalogCache.revived instanceof Set)) this.catalogCache.revived = new Set()
    /** 额度历史：消耗速度、今日/7 天花费与耗尽预测。 */
    this.creditHistory = new CreditHistory({ filePath: creditsHistoryPathOf(options.dataDir) })
    /** 每个 provider 当前正在跑的额度刷新，避免卡片轮询与定时器重复打上游。 */
    this.creditRefreshing = new Map()
    /**
     * 每个 provider 正在补跑的 force 刷新。
     *
     * 与 `creditRefreshing` 分开：那个是「当前这一轮」，这个是「等完当前这一轮
     * 之后补跑的那一轮」。并发的 force 调用者必须共用同一个补跑 promise，
     * 否则 3 次「刷新」点击会打出 3 轮上游请求。
     */
    this.forceRefresh = new Map()
    /** 每个 provider 当前正在跑的目录刷新；force 请求会等这一轮结束后补跑。 */
    this.catalogRefreshing = new Map()
    /** 目录刷新的补跑链（与 `forceRefresh` 同一套理由）。 */
    this.catalogForceRefresh = new Map()
    /** 每个账号当前正在跑的凭证续期：并发请求必须共用同一次 refresh。 */
    this.credentialRefreshing = new Map()
    /**
     * 每个账号正在跑的 Qoder 身份交换（PAT → job token → userinfo）。
     *
     * 启动时目录、额度与首次 /status 会同时解析同一个账号的身份；没有单飞时
     * 三方各自打一轮 exchange + userinfo，既慢又容易撞上 PAT 的频率限制。
     * 值里带 `token`：PAT 刚被替换时不能把旧交换的结果复用到新凭证上。
     */
    this.identityRefreshing = new Map()
    /** 手动「测试账号」的最近结果（内存即可，重启后重新测）。 */
    this.accountTests = new Map()
    /** 手动「测试账号 × 模型」的最近结果：`provider::account::model`。 */
    this.modelTests = new Map()
    /** 写盘去抖句柄。 */
    this.persistTimer = undefined
    this.catalogPersistTimer = undefined
    /** 附件服务与宿主路径映射（图片输入用）。 */
    this.attachments = undefined
    this.mapHostPath = undefined
    /** 请求级失败记录：用于换号冷却。 */
    this.accountFailures = new Map()
    /**
     * 每个账号的「代数」：`forgetAccount()` 会 +1。
     *
     * 在途请求在开始时记下代数，返回后若发现代数变了，说明这个账号在等待期间
     * 被删除过 —— 结果必须丢弃，否则会把刚清掉的额度/历史写回去。
     */
    this.forgetEpoch = new Map()
    /** 凭证探测失败缓存：坏 PAT 不该被设置卡片每 20 秒重新打一次上游。 */
    this.credentialFailures = new Map()
    this.machineId = readMachineId(`${options.dataDir}/.qoder-machine-id`)
    this.stopped = false
    /** 启动时清掉的中断写入临时文件；给 doctor / 启动事件做可见性。 */
    this.sweptTempFiles = typeof options.dataDir === 'string' && options.dataDir !== ''
      ? sweepTempFiles(options.dataDir)
      : { removed: 0, bytes: 0 }

    // 启动时恢复磁盘目录。来源标成 disk，卡片上能看出来「这是缓存，正在刷新」。
    for (const [key, entry] of this.catalogCache) {
      this.catalogs.set(key, { models: entry.models, fetchedAt: entry.fetchedAt, source: 'disk' })
    }
  }

  /** 接上宿主的附件服务（图片输入）。 */
  setAttachments(service, mapHostPath) {
    this.attachments = service
    this.mapHostPath = typeof mapHostPath === 'function' ? mapHostPath : undefined
  }

  /** 宿主是否提供了附件服务（决定模型是否声明视觉输入）。 */
  canAcceptImages() {
    return this.attachments !== undefined && this.attachments !== null
  }

  /** 某个 provider 当前生效的目录条目。 */
  #entryFor(provider) {
    const active = activeAccountFor(provider, this.settings())
    const exact = this.catalogs.get(accountKey(provider, active.id))
    if (exact !== undefined) return { entry: exact, accountId: active.id }
    // 账号刚切换、新账号还没有目录时，显示同一 provider 最近的一份，
    // 好过让整组模型突然消失。
    let best
    let bestId
    for (const [key, value] of this.catalogs) {
      if (!key.startsWith(`${provider}::`)) continue
      if (value.models.length === 0) continue
      if (best === undefined || value.fetchedAt > best.fetchedAt) {
        best = value
        bestId = key.slice(provider.length + 2)
      }
    }
    return { entry: best, accountId: bestId ?? active.id }
  }

  /** 该 provider 当前的模型行。 */
  modelsFor(provider) {
    return this.#entryFor(provider).entry?.models ?? []
  }

  /** 该 provider 当前的状态摘要（给设置卡片用）。 */
  statusFor(provider) {
    const { entry, accountId } = this.#entryFor(provider)
    return {
      provider,
      accountId,
      catalogSource: entry?.source ?? 'none',
      fetchedAt: entry?.fetchedAt ?? 0,
      modelCount: entry?.models.length ?? 0,
      message: entry?.message,
    }
  }

  /**
   * 某个账号的额度快照。
   *
   * 读不到时返回上一次成功的结果并附 `error`，而不是把数字清成 0 ——
   * 「0 分」和「读不到」在界面上必须是两种样子。
   *
   * @param provider - provider id。
   * @param accountId - 账号 id；省略 = 当前账号。
   * @returns 额度（含 `error` / `stale`）。
   */
  creditsFor(provider, accountId) {
    const id = accountId ?? this.#activeId(provider)
    const trend = this.creditHistory.trendFor(provider, id)
    const entry = this.creditCache.get(accountKey(provider, id))
    if (entry === undefined) return { ...emptyCredits(), trend }
    // 「缓存」的前提是**手里真有一个旧数字**。读失败的 provider（没有额度端点、
    // 没配 PAT、上游 5xx）会存成 `state:'none'` + `error`，这时再标 `stale`
    // 会让诊断写成「0 / 0 credits · 缓存」—— 一个看起来像真实余额的 0。
    // 所以 stale 只跟随「有 ok 快照」的条目。
    const hasValue = entry.data?.state === 'ok'
    const stale = hasValue && (entry.error !== undefined || entry.stale === true)
    return {
      ...entry.data,
      ...(entry.error === undefined ? {} : { error: entry.error }),
      ...(stale ? { stale: true } : {}),
      fetchedAt: entry.fetchedAt,
      trend,
    }
  }

  /** 当前账号的 id。 */
  #activeId(provider) {
    return activeAccountFor(provider, this.settings())?.id ?? 'default'
  }

  /**
   * 刷新一个 provider 下**所有账号**的额度。
   *
   * 只刷当前账号的话，就没法判断「还有没有别的账号可以切」；
   * 账号数量通常个位数，逐个刷的成本可以接受。
   *
   * @param provider - provider id。
   * @param options - `{ force?, maxAgeMs?, signal? }`。
   * @returns 当前账号的额度快照。
   */
  async refreshCredits(provider, options = {}) {
    const force = options.force === true
    const existing = this.creditRefreshing.get(provider)
    if (existing !== undefined) {
      // 卡片 20 秒轮询、侧栏 60 秒轮询与定时器很容易同时打进来。等当前这轮
      // 结束即可；带 force 的手动刷新如果在等一轮非 force，结束后再补跑一次。
      await existing.catch(() => undefined)
      if (!force || existing.force === true) return this.creditsFor(provider)
      // 补跑要**串行化**：并发的 N 个 force 调用者会在同一微任务队列里依次恢复，
      // 旧实现让每个调用者各自 `new` 一轮 —— 3 个「刷新」点击 = 3 轮上游请求
      // （实测 3x 放大，容易被上游限流），而代码注释承诺的是「结束后再补跑一次」。
      // 这里把补跑挂到 provider 的 force 链上，后到的调用者共用同一个 promise。
      const pending = this.forceRefresh.get(provider)
      if (pending !== undefined) {
        await pending.catch(() => undefined)
        return this.creditsFor(provider)
      }
      const followUp = this.#runRefreshCredits(provider, { ...options, force: true })
      this.forceRefresh.set(provider, followUp)
      try {
        return await followUp
      } finally {
        if (this.forceRefresh.get(provider) === followUp) this.forceRefresh.delete(provider)
      }
    }
    return await this.#runRefreshCredits(provider, options)
  }

  /**
   * 真正跑一轮额度刷新（含「同一 provider 只跑一轮」的去重登记）。
   *
   * @param provider - provider id。
   * @param options - `{ force?, maxAgeMs?, signal? }`。
   * @returns 当前账号的额度快照。
   */
  async #runRefreshCredits(provider, options) {
    const task = this.#refreshCreditsOnce(provider, options)
    task.force = options.force === true
    this.creditRefreshing.set(provider, task)
    try {
      return await task
    } finally {
      // 只清自己那一轮：补跑可能已经把 map 换成新任务。
      if (this.creditRefreshing.get(provider) === task) this.creditRefreshing.delete(provider)
    }
  }

  /**
   * 真正跑一轮额度刷新（调用方已经做过并发去重）。
   *
   * @param provider - provider id。
   * @param options - `{ force?, maxAgeMs?, signal? }`。
   * @returns 当前账号的额度快照。
   */
  async #refreshCreditsOnce(provider, options) {
    const settings = this.settings()
    const accounts = accountsFor(provider, settings)
    // 默认的新鲜窗口必须跟「高级设置里的额度刷新间隔」一致。写死 120 秒时，
    // 用户把间隔调到 30 秒，调度器每 30 秒仍然会被这里判成「还新鲜」而跳过，
    // 设置等于没生效（实测 60 秒内 0 次请求）。显式传入的 maxAgeMs 优先。
    const maxAgeMs = options.maxAgeMs ?? advancedOptions(settings).creditsRefreshMs

    for (const account of accounts) {
      if (account.enabled === false) continue
      const key = accountKey(provider, account.id)
      const cached = this.creditCache.get(key)
      const fresh =
        !options.force &&
        cached !== undefined &&
        cached.error === undefined &&
        cached.stale !== true &&
        Date.now() - cached.fetchedAt < maxAgeMs
      if (fresh) continue
      if (cached?.inflight !== undefined) {
        // 上一次刷新还在跑：等它，但不要让它的一次失败中断其余账号。
        await cached.inflight.catch(() => undefined)
        // 等完之后**必须**把这个标记摘掉再往下走。以前是直接 `continue`，
        // 于是 `inflight` 永远留在缓存条目里：只要有一次刷新异常退出（进程内
        // 抛错、账号被删、宿主取消），这个账号此后**每一次**刷新都会命中这里
        // 被跳过 —— 用户点「刷新」永远不更新，只能重启插件。
        //
        // 只删自己等到的那个 promise：等待期间可能已经有新一轮写入了。
        const entry = this.creditCache.get(key)
        if (entry !== undefined && entry.inflight === cached.inflight) {
          const { inflight: _finished, ...rest } = entry
          this.creditCache.set(key, rest)
        }
        // 等完就**继续走本轮的刷新**，不要 `continue` 跳过这个账号：
        // 上一轮要么失败（缓存里仍然是旧值/错误）、要么写的是它自己的结果，
        // 而调用方（尤其是用户手动点「刷新」）期望的是「这一轮真的去取一次」。
        // 直接跳过会让一次点击变成空操作 —— 界面闪一下「读取中」又回到旧数字。
        // 上一轮成功且仍新鲜时，下面的 `fresh` 判断已经在前面拦掉了。
      }

      // 记下「发起这次请求时」这个账号的代数：等待期间若被删除，forgetAccount
      // 会把代数 +1，返回后据此丢弃结果。
      const epochAtStart = this.forgetEpoch.get(key) ?? 0
      const inflight = this.#loadCredits(provider, account, options.signal)
      this.creditCache.set(key, { ...(cached ?? { data: emptyCredits(), fetchedAt: 0 }), inflight })
      const data = await inflight
      // 等 HTTP 这段时间里账号可能已经被删掉了（用户在设置卡片里点删除，或另一
      // 个窗口删的）。`forgetAccount()` 会清掉缓存与历史，但它在途的这次刷新一
      // 返回就会把 key 与消耗历史一起重建 —— 用户的删除动作被静默撤销。
      //
      // 判据用「代数」而不是「设置里还有没有这个账号」：隐式默认账号的 id 固定
      // 是 `default`，删掉之后 `accountsFor()` 又会合成一个同 id 的账号，用存在性
      // 判断会漏掉「删除 → 重新配置」这条路径。
      if ((this.forgetEpoch.get(key) ?? 0) !== epochAtStart) continue
      if (!accountsFor(provider, this.settings()).some((entry) => entry.id === account.id)) continue
      const previous = this.creditCache.get(key)
      // 这个账号又读到了额度：说明它（或同 id 的新账号）确实存在，撤掉墓碑，
      // 否则重新登录的账号会永远写不进额度缓存。只删内存不够 —— 保存时会与
      // 磁盘上的旧墓碑合并，所以同时记进「复活」集合，落盘时从墓碑里摘掉。
      this.creditCache.forgotten?.delete(key)
      if (this.creditCache.revived instanceof Set) this.creditCache.revived.add(key)
      this.creditCache.set(key, data.state === 'ok'
        ? { data, fetchedAt: data.fetchedAt, stale: false }
        : {
            // 从没读到过数字时，必须把「这次是读失败（error）」与「这个账号
            // 本来就没有额度端点（none）」分开：旧实现两种都落成 emptyCredits()
            // 的 state:'none'，界面/CLI 的「读取失败」分支成了死代码，用户看到
            // 的是「未读取」——像是插件根本没去读。
            data: previous?.data?.state === 'ok'
              ? previous.data
              : { ...emptyCredits(), ...(data.state === 'error' ? { state: 'error' } : {}) },
            fetchedAt: previous?.fetchedAt ?? 0,
            error: data.message ?? '额度读取失败',
          })
      // 只有真正的「读取失败」才进账本。`state === 'none'` 是「这个账号没有
      // 额度端点 / 还没配 PAT」的已知状态，每 2 分钟刷一次 warn 只会把账本刷满。
      if (data.state === 'error') {
        // 同一个失败原因只留一条，避免后台轮询把账本刷爆。
        this.#note({
          type: 'credits',
          level: 'warn',
          provider,
          accountId: account.id,
          message: `额度读取失败（${account.label}）：${data.message ?? '未知原因'}`,
          messageKey: {
            key: 'eventCreditsFailed',
            params: {
              account: account.label,
              ...(account.labelKey === undefined ? {} : { accountLabelKey: account.labelKey }),
              reason: data.message ?? '未知原因',
            },
          },
          data: { account: account.label },
        }, { dedupeMs: 10 * 60_000 })
      } else if (data.state === 'ok' && previous?.error !== undefined) {
        this.#note({
          type: 'credits',
          provider,
          accountId: account.id,
          message: `额度读取已恢复（${account.label}）`,
          messageKey: {
            key: 'eventCreditsRecovered',
            params: {
              account: account.label,
              ...(account.labelKey === undefined ? {} : { accountLabelKey: account.labelKey }),
            },
          },
          data: { account: account.label, remain: data.remain, total: data.total },
        })
      }
      if (data.state === 'ok') {
        this.creditHistory.record(provider, account.id, data)
        this.#persistCredits()
      }
    }

    await this.#maybeSwitchAccount(provider, settings)
    return this.creditsFor(provider)
  }

  /**
   * 当前账号额度耗尽时，自动切到下一个还有余额的账号。
   *
   * @param provider - provider id。
   * @param settings - 当前设置。
   */
  async #maybeSwitchAccount(provider, settings) {
    if (this.stopped) return
    if (settings.autoSwitch?.enabled === false) return
    const current = this.#activeId(provider)
    const credits = this.creditsFor(provider, current)
    const ratio = typeof settings.autoSwitch?.thresholdRatio === 'number' ? settings.autoSwitch.thresholdRatio : 0
    // 0 = 只在耗尽时切（旧行为）；>0 = 低于比例也提前切。
    // Qoder Free 的 0 付费额度不算耗尽，否则会为了「额度 0」切到付费账号。
    if (!isExhausted(credits, provider) && !isBelowThreshold(credits, ratio)) return
    const target = pickSwitchTarget(provider, settings, current, (accountId) => this.creditsFor(provider, accountId), { minRatio: ratio })
    if (target === undefined) return
    this.logger?.info?.(
      `dsh-reverse-proxy-connect: ${provider} 当前账号额度${isExhausted(credits, provider) ? '已用尽' : '低于阈值'}，自动切换到「${target.label}」`,
    )
    this.#note({
      type: 'account-switch',
      provider,
      message: `额度${isExhausted(credits, provider) ? '已用尽' : '低于阈值'}，自动切换到「${target.label}」`,
      messageKey: {
        key: 'eventSwitchByCredits',
        params: {
          reason: isExhausted(credits, provider) ? 'exhausted' : 'low',
          to: target.label,
          ...(target.labelKey === undefined ? {} : { toLabelKey: target.labelKey }),
        },
      },
      data: { from: current, to: target.id, reason: 'credits' },
    })
    this.#applyAccountSwitch(provider, target.id)
  }

  /**
   * 把「已换成这个账号」写回调用方。
   *
   * 回调通常是写设置文件（宿主 / CLI 都会借此让下一次请求直接用新账号）。
   * 写盘可能因为并发写锁、只读文件或降级安装失败 —— **这不该终结一次已经
   * 成功的请求**：上游正文都拿到了，用户却只看到一条 SETTINGS_LOCKED。
   * 换号本身已经发生在内存里，写回失败最多影响下一次进程启动时的选择。
   *
   * @param provider - provider id。
   * @param accountId - 新账号 id。
   */
  #applyAccountSwitch(provider, accountId) {
    try {
      this.onAccountSwitch?.(provider, accountId)
    } catch (error) {
      this.logger?.warn?.(
        `dsh-reverse-proxy-connect: ${provider} 换号结果写回设置失败（本次请求继续）`,
        error,
      )
    }
  }

  /**
   * 真正读一次某个账号的额度。
   * @param provider - provider id。
   * @param account - 账号。
   * @param signal - 取消。
   * @returns 额度（失败时 `state:'error'`）。
   */
  async #loadCredits(provider, account, signal) {
    const settings = this.settings()
    try {
      if (provider === PROVIDERS.workbuddy || provider === PROVIDERS.workbuddyAi) {
        const variantId = provider === PROVIDERS.workbuddy ? 'workbuddy' : 'workbuddy-ai'
        const credential = await this.credentialForAccount(provider, account, settings, signal)
        return await fetchWorkBuddyCredits(variantId, credential, signal)
      }
      if (isTrae(provider)) {
        const credential = await this.traeCredentialFor(provider, account, settings, signal)
        return await fetchTraeCredits(traeVariantOf(provider), credential, signal)
      }
      const region = provider === PROVIDERS.qoder ? 'china' : 'global'
      const token = this.tokenFor(provider, account)
      if (typeof token !== 'string' || token === '') {
        return { ...emptyCredits(), state: 'none', message: '尚未保存个人访问令牌（PAT）' }
      }
      const identity = await this.identityFor(provider, account, settings, signal)
      return await fetchQoderCredits(identity, region, signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 「没登录 / 没装 App / 路径填错」是**已知的未配置状态**，不是一次读取
      // 失败：与目录刷新、签到用同一套分类（isUnconfiguredCredential）。
      // 当成 error 会让卡片写「读取失败」、账本每 10 分钟一条 warn，
      // CLI 的 credits 也会 exit 1 —— 用户只是还没在这台机器上登录而已。
      if (isUnconfiguredCredential(error?.code)) {
        return { ...emptyCredits(), state: 'none', message }
      }
      return { ...emptyCredits(), state: 'error', message, fetchedAt: Date.now() }
    }
  }

  /**
   * 取某个账号的 WorkBuddy 凭证。
   *
   * 浏览器登录写入账号的 `token` 优先；没有才去读本机登录文件。
   * 目录、聊天、额度、签到**全部**走这一个入口 —— 旧版只有额度走它，
   * 于是浏览器登录的账号能显示余额却聊不了天。
   *
   * @param provider - provider id。
   * @param account - 账号。
   * @param settings - 设置。
   * @param signal - 取消。
   * @returns 凭证。
   */
  async credentialForAccount(provider, account, settings, signal) {
    const variantId = provider === PROVIDERS.workbuddy ? 'workbuddy' : 'workbuddy-ai'
    const options = settings.workbuddy?.[variantId] ?? {}

    if (account.token !== undefined) {
      const credential = {
        variant: variantId,
        region: variantId === 'workbuddy' ? 'cn' : 'global',
        uid: account.token.uid,
        enterpriseId: account.token.enterpriseId,
        domain: account.token.domain,
        accessToken: account.token.accessToken,
        refreshToken: account.token.refreshToken === '' ? undefined : account.token.refreshToken,
        expiresAtMs: account.token.expiresAtMs,
        refreshExpiresAtMs: account.token.refreshExpiresAtMs,
        file: '',
      }
      if (!needsRefresh(credential)) return credential
      // 续期是一次可能长达 30 秒的请求；期间用户完全可能删掉这个账号。
      // 记下发起时的删除代数，回来时若变了就只把令牌还给调用方，
      // 不再写回设置（否则 `applyCredentialRefresh` 会把已删除的默认账号
      // 连同令牌一起重新造出来）。
      const epochAtStart = this.#forgetEpochOf(provider, account.id)
      const refreshed = await this.#refreshCredentialShared(provider, account, credential, signal)
      if (this.#forgetEpochOf(provider, account.id) !== epochAtStart) return refreshed
      // 只有真的换到了新令牌才写回。续期失败时 refreshDesktopCredential 会
      // 回退旧凭证（只要旧 token 还没过期），把旧值再写一遍会覆盖另一个并发
      // 请求刚拿到的新令牌 —— 典型 lost update。
      if (refreshed.accessToken !== credential.accessToken
        || refreshed.refreshToken !== credential.refreshToken
        || refreshed.expiresAtMs !== credential.expiresAtMs) {
        this.onCredentialRefreshed?.(provider, account.id, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? '',
          expiresAtMs: refreshed.expiresAtMs,
          refreshExpiresAtMs: refreshed.refreshExpiresAtMs,
          domain: refreshed.domain,
          uid: refreshed.uid,
          enterpriseId: refreshed.enterpriseId,
        })
        this.#note({
          type: 'credential-refresh',
          provider,
          accountId: account.id,
          message: `登录令牌已自动续期（${account.label}）`,
          messageKey: {
            key: 'eventCredentialRefreshed',
            params: {
              account: account.label,
              ...(account.labelKey === undefined ? {} : { accountLabelKey: account.labelKey }),
            },
          },
          data: { expiresAtMs: refreshed.expiresAtMs },
        }, { dedupeMs: 60_000 })
      }
      return refreshed
    }

    const credential = await readDesktopCredential(variantId, {
      electronPath: options.electronPath,
      authFile: account.authFile ?? options.authFile ?? '',
    })
    if (!needsRefresh(credential)) return credential
    return await this.#refreshCredentialShared(provider, account, credential, signal)
  }

  /**
   * 某个账号的「删除代数」。
   *
   * 在途的续期 / 目录刷新返回后用它判断账号是否已被删除：id 会被重新合成
   * （隐式 `default`），所以「设置里还有没有这个 id」不是可靠判据。
   *
   * @param provider - provider id。
   * @param accountId - 账号 id。
   * @returns 代数（从未删除过为 0）。
   */
  #forgetEpochOf(provider, accountId) {
    return this.forgetEpoch.get(accountKey(provider, accountId)) ?? 0
  }

  /**
   * 统一一次凭证续期：同一账号并发命中续期余量时只打一次 refresh 端点。
   *
   * @param provider - provider id。
   * @param account - 账号。
   * @param credential - 当前凭证。
   * @param signal - 取消。
   * @returns 续期后的凭证（失败且旧 token 仍有效时返回旧凭证）。
   */
  async #refreshCredentialShared(provider, account, credential, signal) {
    const key = accountKey(provider, account.id)
    const existing = this.credentialRefreshing.get(key)
    if (existing !== undefined) return await existing
    const task = refreshDesktopCredential(credential, signal)
    this.credentialRefreshing.set(key, task)
    try {
      return await task
    } finally {
      if (this.credentialRefreshing.get(key) === task) this.credentialRefreshing.delete(key)
    }
  }

  /**
   * 取某个账号的 Trae 凭证（登录文件里的 cloudide 令牌 → `Cloud-IDE-JWT`）。
   *
   * 与 WorkBuddy 的两点不同：
   * - 账号里存的令牌**可能是** cloudide 令牌（老版本）**也可能是**已经换好的 JWT，
   *   所以统一交给 `resolveTraeCredential()` 判断，不在这里猜；
   * - 换到的 JWT 只有 7 天，必须写回账号，否则每个请求都会重新换一次。
   *
   * @param provider - provider id。
   * @param account - 账号。
   * @param settings - 设置。
   * @param signal - 取消。
   * @returns 凭证。
   */
  async traeCredentialFor(provider, account, settings, signal) {
    const variantId = traeVariantOf(provider)
    const options = settings.trae?.[provider] ?? {}
    const key = accountKey(provider, account.id)
    const existing = this.credentialRefreshing.get(key)
    if (existing !== undefined) return await existing
    const epochAtStart = this.#forgetEpochOf(provider, account.id)
    const task = resolveTraeCredential({
      variantId,
      stored: account.token,
      authFile: account.authFile ?? options.storageFile ?? '',
      signal,
      onRefreshed: (token) => {
        // 换 JWT 期间账号被删：不要把令牌写回设置（会复活已删除的账号）。
        if (this.#forgetEpochOf(provider, account.id) !== epochAtStart) return
        this.onCredentialRefreshed?.(provider, account.id, token)
        this.#note({
          type: 'credential-refresh',
          provider,
          accountId: account.id,
          message: `Trae 登录令牌已自动续期（${account.label}）`,
          messageKey: {
            key: 'eventCredentialRefreshed',
            params: {
              account: account.label,
              ...(account.labelKey === undefined ? {} : { accountLabelKey: account.labelKey }),
            },
          },
        }, { dedupeMs: 60_000 })
      },
    })
    this.credentialRefreshing.set(key, task)
    try {
      return await task
    } finally {
      if (this.credentialRefreshing.get(key) === task) this.credentialRefreshing.delete(key)
    }
  }

  /**
   * 取某个账号的 Qoder 身份（PAT → job token）。
   * @param provider - provider id。
   * @param account - 账号。
   * @param settings - 设置。
   * @param signal - 取消。
   * @returns 身份。
   */
  async identityFor(provider, account, settings, signal) {
    const region = provider === PROVIDERS.qoder ? 'china' : 'global'
    const token = this.tokenFor(provider, account)
    if (typeof token !== 'string' || token === '') {
      const error = new Error('尚未保存 Qoder 个人访问令牌（PAT）')
      error.code = REASON.noCredential
      error.kind = 'auth'
      throw error
    }
    const key = accountKey(provider, account.id)
    // 同一个 PAT 的并发调用共用一个交换任务。PAT 已经换了就不能复用旧任务：
    // 那会把旧身份的 authToken 返回给新凭证的调用方。
    const pending = this.identityRefreshing.get(key)
    if (pending !== undefined && pending.token === token) return await pending.task
    const task = (async () => {
      const identity = await resolveIdentity(token, region, this.identities.get(key), this.machineId, signal)
      // 等待期间 PAT 可能被改掉/账号被删：只有这条令牌仍是设置里的那一条时
      // 才允许写缓存，否则旧身份会覆盖新身份（下一次调用又要重新交换）。
      const latest = accountsFor(provider, this.settings()).find((candidate) => candidate.id === account.id)
      if (latest !== undefined && this.tokenFor(provider, latest) === token) this.identities.set(key, identity)
      return identity
    })()
    this.identityRefreshing.set(key, { token, task })
    try {
      return await task
    } finally {
      if (this.identityRefreshing.get(key)?.task === task) this.identityRefreshing.delete(key)
    }
  }

  /**
   * 登录状态探测（不消耗模型额度）。
   *
   * @param provider - provider id。
   * @param account - 账号。
   * @param settings - 设置。
   * @param signal - 取消。
   * @returns `{status, reason?, message?, ...}`。
   */
  async describeCredential(provider, account, settings, signal) {
    const kind = isTrae(provider)
      ? 'desktop-auth'
      : provider === PROVIDERS.workbuddy || provider === PROVIDERS.workbuddyAi ? 'desktop' : 'pat'
    const key = accountKey(provider, account.id)
    const cached = this.credentialFailures.get(key)
    if (cached !== undefined && Date.now() - cached.at < 60_000) return { ...cached.result }
    try {
      if (kind === 'desktop-auth') {
        // Trae：读登录文件即可，不需要换令牌（换令牌要打上游，卡片每 20 秒
        // 轮询一次不该消耗这个成本）。令牌是否还能用由请求本身发现。
        const options = settings.trae?.[provider] ?? {}
        const status = describeStoredAuth(traeVariantOf(provider), account.authFile ?? options.storageFile ?? '')
        if (status.status !== 'signed-in') {
          // 只缓存「文件不存在 / 损坏 / 没登录」这类稳定结论；上游抖动、
          // 超时、取消下一次必须重新探测。
          if (CACHEABLE_CREDENTIAL_FAILURES.has(status.reason)) {
            this.credentialFailures.set(key, { at: Date.now(), result: status })
          }
          return status
        }
        this.credentialFailures.delete(key)
        return status
      }
      if (kind === 'desktop') {
        const credential = await this.credentialForAccount(provider, account, settings, signal)
        this.credentialFailures.delete(key)
        return {
          status: 'signed-in',
          source: credential.file === '' ? 'browser-login' : 'desktop',
          uid: credential.uid,
          domain: credential.domain,
          enterpriseId: credential.enterpriseId,
          expiresAtMs: credential.expiresAtMs,
          refreshable: credential.refreshToken !== undefined,
          ...(credential.file === '' ? {} : { file: credential.file }),
        }
      }
      const identity = await this.identityFor(provider, account, settings, signal)
      const token = this.tokenFor(provider, account)
      this.credentialFailures.delete(key)
      return {
        status: 'signed-in',
        source: 'pat',
        email: identity.email,
        name: identity.name,
        userId: identity.userID,
        expiresAtMs: identity.expiresAtMs,
        ...(typeof token === 'string' ? { patTail: token.slice(-4) } : {}),
      }
    } catch (error) {
      const reason = credentialFailureReasonOf(error)
      const result = {
        status: 'signed-out',
        reason,
        message: error instanceof Error ? error.message : String(error),
      }
      // 超时 / 取消 / 上游暂时不可用都是可重试的瞬时失败：缓存 60 秒会让
      // 卡片在凭证恢复后仍显示「未登录」，期间也不会再探测。只有「凭证本身
      // 的状态」值得缓存，避免每 20 秒一次的无意义重复读盘/请求。
      if (CACHEABLE_CREDENTIAL_FAILURES.has(reason)) {
        this.credentialFailures.set(key, { at: Date.now(), result })
      }
      return result
    }
  }

  /**
   * 凭证字段变化后作废受影响账号的旁路状态。
   *
   * 用户把坏 PAT 换成好 PAT、或把登录文件路径指对之后，`describeCredential()`
   * 里缓存的失败结论（60 秒）与旧的测试结果必须立刻失效；否则保存成功后的
   * 第一帧仍然是「未登录」，账号行还会挂着「凭证失效」的旧徽章，用户会以为
   * 保存没生效。冷却也一样：旧凭证导致的 AUTH/限流冷却不该继续拦住新凭证。
   *
   * 额度快照与消耗历史同样属于「上一个账号的旁路状态」：同一个账号行换 PAT
   * 之后，旧余额与旧曲线还会在 `/status` 的非 force 刷新里被当成新鲜数据
   * （2 分钟窗口），卡片继续显示上一个账号的数字，甚至据此自动换号。
   *
   * @param targets - 受影响的 provider（字符串）或 `{provider, accountId?}`；
   *   省略 accountId 表示整家 provider。Set / 数组 / 单个均可。
   */
  forgetCredentialState(targets) {
    const list = targets instanceof Set || Array.isArray(targets) ? targets : [targets]
    for (const target of list) {
      const provider = typeof target === 'string' ? target : target?.provider
      if (!PROVIDER_IDS.includes(provider)) continue
      const accountId = typeof target === 'object' && target !== null
        && typeof target.accountId === 'string' && target.accountId !== ''
        ? target.accountId
        : undefined
      const prefix = `${provider}::`
      /** 这个缓存键是否属于本次受影响的账号。 */
      const matches = (key) => {
        if (typeof key !== 'string') return false
        if (accountId === undefined) return key.startsWith(prefix)
        // 账号 id 之间可能是前缀关系（acc-1 / acc-10）：必须带分隔符精确匹配。
        return key === `${prefix}${accountId}` || key.startsWith(`${prefix}${accountId}::`)
      }
      for (const map of [
        this.credentialFailures,
        this.identities,
        this.accountFailures,
        this.accountTests,
        this.modelTests,
      ]) {
        for (const key of [...map.keys()]) {
          if (matches(key)) map.delete(key)
        }
      }
      // 在途的身份交换不能登记给新凭证复用：删掉登记，后到的调用会重新解析；
      // 旧任务自己会因「令牌已不是当前那条」而拒绝写缓存。
      for (const key of [...this.identityRefreshing.keys()]) {
        if (matches(key)) this.identityRefreshing.delete(key)
      }
      // 删除代数必须**无条件**推进：账号可能连一条额度缓存都没有（刚添加、
      // 因停用被 `#refreshCreditsOnce` 跳过、或额度端点根本不存在）。旧实现把
      // 自增写在额度缓存循环里，这种账号的代数不会变 —— 在途的令牌续期回来时
      // 守卫仍然成立，会把旧令牌写回刚换过登录文件 / PAT 的账号，用户看到的
      // 是「换了路径但登录的还是上一个账号」。provider 级目标没有具体 id，
      // 就按当前账号表（以及已经记过代数的键）逐个推进。
      const epochKeys = accountId === undefined
        ? new Set([
            ...[...this.forgetEpoch.keys()].filter((key) => key.startsWith(prefix)),
            ...accountsFor(provider, this.settings()).map((account) => accountKey(provider, account.id)),
          ])
        : new Set([accountKey(provider, accountId)])
      for (const key of epochKeys) {
        this.forgetEpoch.set(key, (this.forgetEpoch.get(key) ?? 0) + 1)
      }
      // 额度缓存：删掉条目并写墓碑，旧凭证在途的那次刷新返回后会因代数
      // 变化被丢弃，不会把上一个账号的余额写回来。
      //
      // 光删内存条目不够：落盘时 `saveCreditsCache()` 会与磁盘上已有的快照按
      // key 合并，旧凭证的余额又会被并回来。重启后第一帧显示上一个账号的
      // 数字（标着「上次结果」），用户以为新 PAT 没有保存成功。删除账号走的是
      // `forgetAccount()`（它写墓碑），换凭证也必须是同一套墓碑语义。
      let forgotten = false
      for (const key of [...this.creditCache.keys()]) {
        if (!matches(key)) continue
        this.creditCache.delete(key)
        if (!(this.creditCache.forgotten instanceof Set)) this.creditCache.forgotten = new Set()
        this.creditCache.forgotten.add(key)
        this.creditCache.revived?.delete(key)
        forgotten = true
      }
      if (forgotten) this.#persistCredits()
      // 消耗曲线按账号一条：删除它（并留墓碑挡住旧凭证在途样本），下一次成功
      // 读到的样本时间晚于墓碑，会自动撤销墓碑重新开始累积。
      const historyKeys = Object.keys(this.creditHistory.snapshot().entries)
      for (const key of historyKeys) {
        if (!matches(key)) continue
        const at = key.indexOf('::')
        this.creditHistory.forget(key.slice(0, at), key.slice(at + 2))
      }
    }
  }

  /** 把额度快照写盘（供下次启动秒显）。 */
  #persistCredits() {
    // 卸载后仍在飞的刷新可能走到这里；不要再创建新的落盘定时器。
    if (this.stopped) return
    if (this.persistTimer !== undefined) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      saveCreditsCache(this.dataDir, this.creditCache)
    }, 800)
    this.persistTimer.unref?.()
  }

  /** 把目录缓存写盘（去抖：一轮刷新会连着成功六家）。 */
  #persistCatalog(immediate = false) {
    if (this.stopped) return
    const advanced = advancedOptions(this.settings())
    if (!advanced.catalogCache) return
    for (const [key, entry] of this.catalogs) {
      if (entry.models.length === 0) continue
      // 内置兜底清单不能当成「真实目录」缓存：否则下次启动会把 4 个兜底模型
      // 当成磁盘缓存展示，用户再也分不清「缓存」与「兜底」。
      if (entry.source === 'builtin' || entry.source === 'none') continue
      this.catalogCache.set(key, { models: entry.models, fetchedAt: entry.fetchedAt })
    }
    if (this.catalogPersistTimer !== undefined) {
      // 删号等需要「立刻落盘」的路径不能被 1.5 秒去抖推迟：进程在这期间被
      // 强杀，墓碑还没写进磁盘，重启后已删账号的目录又会出现在选择器里。
      if (immediate !== true) return
      clearTimeout(this.catalogPersistTimer)
      this.catalogPersistTimer = undefined
    }
    if (immediate === true) {
      saveCatalogCache(this.dataDir, this.catalogCache)
      return
    }
    this.catalogPersistTimer = setTimeout(() => {
      this.catalogPersistTimer = undefined
      saveCatalogCache(this.dataDir, this.catalogCache)
    }, 1500)
    this.catalogPersistTimer.unref?.()
  }

  /** 立即把两份缓存落盘（进程退出 / 测试用）。 */
  flushCaches() {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    if (this.catalogPersistTimer !== undefined) {
      clearTimeout(this.catalogPersistTimer)
      this.catalogPersistTimer = undefined
    }
    saveCreditsCache(this.dataDir, this.creditCache)
    this.creditHistory?.stop()
    // 目录缓存被用户关掉时既不读也不写：否则「关闭缓存」只是少写几次，
    // 重启后仍然会加载旧目录。
    if (!advancedOptions(this.settings()).catalogCache) {
      this.catalogCache = new Map()
      return
    }
    for (const [key, entry] of this.catalogs) {
      if (entry.models.length === 0) continue
      if (entry.source === 'builtin' || entry.source === 'none') continue
      this.catalogCache.set(key, { models: entry.models, fetchedAt: entry.fetchedAt })
    }
    saveCatalogCache(this.dataDir, this.catalogCache)
  }

  /**
   * 刷新单个 provider 的目录。
   *
   * 同一 provider 同时只跑一轮：卡片轮询、启动刷新、换号后的补刷很容易撞在一起。
   * 带 `force` 的请求如果遇到正在跑的非 force 轮次，会等它结束后再补跑一次 ——
   * 与额度刷新同一套语义，避免手动「刷新」被后台轮询吞掉。
   *
   * @param provider - provider id。
   * @param options - `{ force? }`：手动刷新时跳过「健康冷却」。
   * @returns 刷新结果。
   */
  async refresh(provider, options = {}) {
    const force = options.force === true
    const existing = this.catalogRefreshing.get(provider)
    if (existing !== undefined) {
      const previous = await existing.catch(() => undefined)
      if (!force || existing.force === true) {
        return previous ?? {
          provider,
          status: 'failed',
          reason: 'refresh-failed',
          models: this.modelsFor(provider).length,
        }
      }
      // 见 refreshCredits()：补跑必须串行化，否则并发的 force 会各自打一轮上游。
      const pending = this.catalogForceRefresh.get(provider)
      if (pending !== undefined) {
        const shared = await pending.catch(() => undefined)
        return shared ?? {
          provider,
          status: 'failed',
          reason: 'refresh-failed',
          models: this.modelsFor(provider).length,
        }
      }
      const followUp = this.#runRefresh(provider, { ...options, force: true })
      this.catalogForceRefresh.set(provider, followUp)
      try {
        return await followUp
      } finally {
        if (this.catalogForceRefresh.get(provider) === followUp) this.catalogForceRefresh.delete(provider)
      }
    }
    return await this.#runRefresh(provider, options)
  }

  /**
   * 真正跑一轮目录刷新（含「同一 provider 只跑一轮」的去重登记）。
   *
   * @param provider - provider id。
   * @param options - `{ force? }`。
   * @returns 刷新结果。
   */
  async #runRefresh(provider, options) {
    const task = this.#refreshOnce(provider, options)
    task.force = options.force === true
    this.catalogRefreshing.set(provider, task)
    try {
      return await task
    } finally {
      if (this.catalogRefreshing.get(provider) === task) this.catalogRefreshing.delete(provider)
    }
  }

  /**
   * 真正跑一轮目录刷新（调用方已经做过并发去重）。
   *
   * @param provider - provider id。
   * @param options - `{ force? }`。
   * @returns 刷新结果。
   */
  async #refreshOnce(provider, options = {}) {
    const settings = this.settings()
    const { enabled } = providerOptions(settings, provider)
    const account = activeAccountFor(provider, settings)
    const key = accountKey(provider, account.id)
    const previousEntry = this.catalogs.get(key)
    // 记下发起时的「删除代数」：一轮目录刷新可能要 30 秒，期间用户完全可能
    // 删掉这个账号。after await 的写入必须确认代数没变，否则会把已删除账号的
    // 目录（成功分支）或旧目录（catch 分支）重新写回内存并落盘。
    const epochAtStart = this.forgetEpoch.get(key) ?? 0
    const forgot = () => (this.forgetEpoch.get(key) ?? 0) !== epochAtStart

    if (!enabled) {
      return { provider, status: 'disabled', reason: 'disabled', models: this.modelsFor(provider).length }
    }

    // 连续失败三次后短暂「熔断」自动刷新（手动刷新不受影响）：
    // 上游维护时每 10 分钟撞一次墙没有意义。统计关闭时不再用旧健康记录做判断。
    const health = advancedOptions(settings).stats ? this.stats?.healthFor?.(provider) : undefined
    if (options.force !== true && health?.state === 'down' && health.lastErrorAt > 0 && Date.now() - health.lastErrorAt < 120_000) {
      return { provider, status: 'degraded', reason: 'cooling-down', models: this.modelsFor(provider).length }
    }

    const signal = AbortSignal.timeout(CATALOG_TIMEOUT_MS)
    try {
      let models
      if (provider === PROVIDERS.workbuddy || provider === PROVIDERS.workbuddyAi) {
        const variantId = provider === PROVIDERS.workbuddy ? 'workbuddy' : 'workbuddy-ai'
        const credential = await this.credentialForAccount(provider, account, settings, signal)
        models = await fetchWorkBuddyCatalog(variantId, credential, signal)
      } else if (isTrae(provider)) {
        const credential = await this.traeCredentialFor(provider, account, settings, signal)
        models = await fetchTraeCatalog(traeVariantOf(provider), credential, signal)
      } else {
        const identity = await this.identityFor(provider, account, settings, signal)
        models = await fetchQoderCatalog(identity, signal)
      }
      // 在途期间账号被删：结果属于一个已经不存在的账号，丢弃。
      if (forgot()) return { provider, status: 'failed', reason: 'account-forgotten', models: this.modelsFor(provider).length }
      // 这个 key 以前被删过（墓碑仍在）：现在真的拉到了目录，说明账号回来了。
      // 撤销内存墓碑并记进 revived，落盘时才能把磁盘上的旧墓碑一起摘掉；
      // 否则目录只活到本次进程结束，重启后又被过滤成「没有缓存」。
      if (this.catalogCache.forgotten instanceof Set && this.catalogCache.forgotten.has(key)) {
        this.catalogCache.forgotten.delete(key)
        if (!(this.catalogCache.revived instanceof Set)) this.catalogCache.revived = new Set()
        this.catalogCache.revived.add(key)
      }
      this.catalogs.set(key, { models, fetchedAt: Date.now(), source: 'live' })
      this.#persistCatalog()
      // 首次拉取或从降级来源恢复时记一条；例行刷新（live → live）不刷屏。
      if (previousEntry === undefined || previousEntry.source !== 'live') {
        this.#note({
          type: 'catalog',
          provider,
          message: `模型目录已更新（${models.length} 个模型）`,
          messageKey: { key: 'eventCatalogUpdated', params: { count: models.length } },
          data: { count: models.length, source: 'live' },
        })
      }
      return { provider, status: 'signed-in', models: models.length }
    } catch (error) {
      // 删除发生在请求期间：不要把 previousEntry（删除前抓的快照）写回去。
      if (forgot()) {
        return { provider, status: 'failed', reason: 'account-forgotten', models: this.modelsFor(provider).length }
      }
      const previous = this.catalogs.get(key)
      const message = error instanceof Error ? error.message : String(error)
      // 三级降级：live → 内存/磁盘 → 内置兜底。前两者都没有时用内置兜底，
      // 免得首次启动就断网时整个模型组直接消失（用户会以为插件坏了）。
      let models = previous !== undefined && previous.models.length > 0 ? previous.models : undefined
      let source = models === undefined ? undefined : previous?.source === 'builtin' ? 'builtin' : 'saved'
      let fetchedAt = previous?.fetchedAt ?? 0
      if (models === undefined) {
        const cached = this.catalogCache.get(key)
        if (cached !== undefined && cached.models.length > 0) {
          models = cached.models
          source = 'disk'
          fetchedAt = cached.fetchedAt
        }
      }
      if (models === undefined) {
        const builtin = fallbackModelsFor(provider)
        if (builtin.length > 0) {
          models = builtin
          source = 'builtin'
          fetchedAt = 0
        }
      }
      this.catalogs.set(key, { models: models ?? [], fetchedAt, source: source ?? 'none', message })
      // 「没登录 / 没装 App / 路径填错」是已知的未配置状态，不是这次刷新才出现的
      // 故障：卡片与 doctor 已经明确显示「未配置」，账本再每 10 分钟记一条 warn
      // 只会把真正的失败挤出最近 50 条（实测 15 小时 12 条）。真正的上游失败、
      // 超时、凭证过期仍然记 warn。
      if (!isUnconfiguredCredential(error?.code)) {
        this.#note({
          type: 'catalog',
          level: 'warn',
          provider,
          message: `模型目录拉取失败，回退到 ${source ?? 'none'}（${message}）`,
          messageKey: {
            key: 'eventCatalogFallback',
            params: { source: source ?? 'none', reason: message },
          },
          data: { source: source ?? 'none', count: models?.length ?? 0, reason: error?.code ?? 'upstream-error' },
        }, { dedupeMs: 10 * 60_000 })
      }
      return {
        provider,
        status: (models?.length ?? 0) > 0 ? 'degraded' : 'signed-out',
        reason: error?.code ?? REASON.upstreamError,
        message,
        models: models?.length ?? 0,
      }
    }
  }

  /**
   * 能力探测：逐个模型真发一次极短请求，把账号用不了的标出来。
   *
   * 判据与旧版一致（只认 400 + 明确文案），但 1.0.0 把探测请求标成
   * `probe: true`，因此不会写进用量统计，也不会触发自动换号。
   *
   * @param provider - provider id。
   * @param options - `{ concurrency, signal, accountId }`。
   *   `accountId` 固定整轮探测使用哪个账号：探测可能跑几十秒，期间
   *   「当前账号」会变，不钉住的话后半轮会打到另一个账号上。
   * @returns `{provider, probed, unavailable}`。
   */
  async probeProvider(provider, options = {}) {
    const models = this.modelsFor(provider)
    if (models.length === 0) return { provider, probed: 0, unavailable: [] }
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8))
    const accountId = typeof options.accountId === 'string' && options.accountId !== '' ? options.accountId : undefined
    const unavailable = []
    let index = 0

    const worker = async () => {
      while (index < models.length) {
        if (this.stopped || options.signal?.aborted === true) return
        const model = models[index++]
        const reason = await this.#probeOne(provider, model, options.signal, accountId)
        if (reason !== undefined) unavailable.push(model.id)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    this.#note({
      type: 'probe',
      level: unavailable.length > 0 ? 'warn' : 'info',
      provider,
      message: `能力探测完成：${models.length} 个模型，${unavailable.length} 个账号不支持`,
      messageKey: { key: 'eventProbeDone', params: { models: models.length, unavailable: unavailable.length } },
      data: { probed: models.length, unavailable: unavailable.length },
    })
    return { provider, probed: models.length, unavailable }
  }

  /**
   * 探测单个模型：返回不可用原因，可用则 undefined。
   *
   * @param provider - provider id。
   * @param model - 模型行。
   * @param outerSignal - 整轮探测的取消信号（插件卸载/重探时生效）。
   * @param accountId - 本轮固定使用的账号（可省略 = 当前账号）。
   * @returns 原因字符串或 undefined。
   */
  async #probeOne(provider, model, outerSignal, accountId) {
    const effort = Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length === 1 ? model.reasoningEfforts[0] : undefined
    // 与「测试账号」同一条理由：死线只该管「等响应头」那一段。拿到 opened 之后
    // 立刻 dispose，排队预算交给 retryQueued —— 否则「排队中」会被这条死线
    // 说成「没有给出响应头」，探测也就得不出结论。
    const deadline = openDeadline(TEST_DEADLINE_MS)
    // 每个探测自己的死线 + 整轮探测的取消信号；只取后者的话，插件卸载后
    // 已经发出的探测请求仍会白跑整整一分钟。
    const signal = outerSignal === undefined ? deadline.signal : AbortSignal.any([deadline.signal, outerSignal])
    try {
      const opened = await this.openStream(provider, {
        model: model.id,
        reasoningEffort: effort,
        maxTokens: 1,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }],
        signal,
        probe: true,
        noFailover: true,
        ...(accountId === undefined ? {} : { accountId }),
      })
      deadline.dispose()
      let finish
      for await (const event of opened.events) {
        if (event.type === 'finish') {
          finish = event
          break
        }
      }
      await opened.close?.()
      if (finish?.reason?.kind === 'error' || finish?.kind === 'error') return undefined
      return undefined
    } catch (error) {
      if (error?.kind === 'soft-rate' || error?.kind === 'quota' || error?.kind === 'auth') return undefined
      const status = typeof error?.status === 'number' ? error.status : undefined
      const message = error instanceof Error ? error.message : String(error)
      return accountLimitation(message, status) ? message : undefined
    } finally {
      deadline.dispose()
    }
  }

  /**
   * 刷新全部 provider。并发，任何一个失败不影响其他。
   *
   * 并发去重在 `refresh()` 里按 provider 做：这样 `refreshAll({force:true})`
   * 不会因为另一次后台刷新正在进行就整个被吞掉。
   *
   * @param options - `{ force? }`。
   * @returns 结果数组。
   */
  async refreshAll(options = {}) {
    const results = await Promise.all(Object.values(PROVIDERS).map((provider) => this.refresh(provider, options)))
    this.onCatalogChange?.()
    return results
  }

  /**
   * 取某个账号的 Qoder PAT。
   *
   * 只有「隐式默认账号」才允许环境变量兜底 —— 老版本靠
   * `QODER_PERSONAL_ACCESS_TOKEN` 就能用，升级后不该突然失效；
   * 用户手动添加的账号则只认它自己的令牌，不去猜。
   *
   * @param provider - provider id。
   * @param account - 账号。
   * @returns PAT，或 undefined。
   */
  tokenFor(provider, account) {
    if (typeof account?.pat === 'string' && account.pat !== '') return account.pat
    if (account?.id !== 'default') return undefined
    const envName = provider === PROVIDERS.qoder ? 'QODER_CN_PERSONAL_ACCESS_TOKEN' : 'QODER_PERSONAL_ACCESS_TOKEN'
    const fromEnv = process.env[envName]
    return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : undefined
  }

  /**
   * 对某个 provider 跑一次签到（所有可用账号都跑一遍）。
   *
   * @param provider - provider id。
   * @param options - `{ signal? }`。
   * @returns 本次汇总。
   */
  async runCheckin(provider, options = {}) {
    const settings = this.settings()
    const accounts = accountsFor(provider, settings)
    const outcomes = []
    let claimed = 0
    let credit = 0

    for (const account of accounts) {
      if (account.enabled === false) continue
      try {
        // 没登录 / 没配 PAT 的账号不该每天在账本里报「签到失败」：先探测凭证。
        // 只有**静态未配置**（no-credential / app-not-found / 路径填错…）才记
        // unconfigured 跳过；临时读取失败/网络错误必须走 failed，保留 10 分钟重试，
        // 否则一次抖动就会漏掉当天签到（第二轮审计 #2 的回归）。
        const credential = await this.describeCredential(provider, account, settings, options.signal)
        if (credential.status !== 'signed-in') {
          if (isUnconfiguredCredential(credential.reason)) {
            outcomes.push({
              accountId: account.id,
              label: account.label,
              kind: 'unconfigured',
              message: credential.message ?? '未登录，已跳过签到',
            })
          } else {
            outcomes.push({
              accountId: account.id,
              label: account.label,
              kind: 'failed',
              message: credential.message ?? `凭证暂时不可用（${String(credential.reason ?? 'unknown')}）`,
            })
          }
          continue
        }
        const outcome = isTrae(provider)
          ? await this.#checkinTrae(provider, account, settings, options.signal)
          : provider === PROVIDERS.workbuddy || provider === PROVIDERS.workbuddyAi
            ? await this.#checkinWorkbuddy(provider, account, settings, options.signal)
            : await this.#checkinQoder(provider, account, settings, options.signal)
        outcomes.push({ accountId: account.id, label: account.label, ...outcome })
        if (outcome.kind === 'claimed') {
          claimed += 1
          credit += typeof outcome.credit === 'number' ? outcome.credit : 0
        }
      } catch (error) {
        outcomes.push({
          accountId: account.id,
          label: account.label,
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const failed = outcomes.filter((item) => item.kind === 'failed').length
    const skipped = outcomes.filter((item) => item.kind === 'unconfigured').length
    const parts = [`${outcomes.length} 个账号`]
    if (skipped > 0) parts.push(`${skipped} 个账号未登录，已跳过`)
    if (failed > 0) parts.push(`${failed} 个失败`)
    parts.push(`本次领到 ${credit} 分`)
    this.#note({
      type: 'checkin',
      // 未登录是已知状态：info、不算失败、不触发 10 分钟重试。
      level: failed > 0 ? 'warn' : 'info',
      provider,
      message: `签到：${parts.join('，')}`,
      messageKey: {
        key: 'eventCheckinSummary',
        params: { accounts: outcomes.length, skipped, failed, credit },
      },
      data: { claimed, credit, accounts: outcomes.length, failed, skipped },
    }, {
      // 失败后调度器每 10 分钟重试一次，同一句「1 个失败」会连续记 6 条/小时；
      // 上游繁忙时（「当前参与用户太多」）能持续一整天。账本只保留每小时第一条，
      // 既保留「仍在失败」的信号，又不会把换号/凭证等真正的异常挤出去。
      dedupeMs: failed > 0 ? 60 * 60_000 : 0,
    })
    return { provider, claimed, credit, outcomes, at: Date.now() }
  }

  /** WorkBuddy 的签到：先查状态，需要时再领取。 */
  async #checkinWorkbuddy(provider, account, settings, signal) {
    const variantId = provider === PROVIDERS.workbuddy ? 'workbuddy' : 'workbuddy-ai'
    const credential = await this.credentialForAccount(provider, account, settings, signal)
    const status = await workbuddyCheckinStatus(variantId, credential, signal)
    if (status.kind !== 'active') return status
    const claimed = await workbuddyClaimCheckin(variantId, credential, signal)
    return { ...claimed, streakDays: claimed.streakDays ?? status.streakDays }
  }

  /** Qoder 的签到：活动列表里能领的都领一次。 */
  async #checkinQoder(provider, account, settings, signal) {
    const identity = await this.identityFor(provider, account, settings, signal)
    return await qoderClaimCampaigns(identity, provider === PROVIDERS.qoder ? 'china' : 'global', signal)
  }

  /** Trae 的签到：先查状态，需要时再领取（每天 100 + 额外奖励）。 */
  async #checkinTrae(provider, account, settings, signal) {
    const credential = await this.traeCredentialFor(provider, account, settings, signal)
    const variantId = traeVariantOf(provider)
    const status = await traeCheckinStatus(variantId, credential, signal)
    if (status.kind !== 'active') return status
    const claimed = await traeClaimCheckin(variantId, credential, signal)
    return { ...claimed, credit: claimed.credit ?? status.credit }
  }

  /** 适配器用的模型清单。 */
  async listModels(provider) {
    return this.modelsFor(provider)
  }

  /** 适配器用的精确模型查找。 */
  async resolveModel(provider, model) {
    return this.modelsFor(provider).find((entry) => entry.id === model)
  }

  /**
   * 刷新全部 provider 的额度（卡片打开或手动刷新时用）。
   * @param options - `{ force? }`。
   * @returns 结果列表。
   */
  async refreshAllCredits(options = {}) {
    return await Promise.all(
      Object.values(PROVIDERS).map(async (provider) => {
        const { enabled } = providerOptions(this.settings(), provider)
        if (!enabled) return { provider, skipped: true }
        return await this.refreshCredits(provider, options)
      }),
    )
  }

  /**
   * 真发一次极短请求，验证某个账号当前能不能用。
   *
   * 走完整适配器路径（凭证、目录、上游、流解析），只把输出限制到 1 token，
   * 因此结果比「读登录文件成功」可信得多。探测请求不计入用量统计，也不会换号。
   *
   * 第三个参数给定时测的是「这个账号 + 这个模型」：WorkBuddy 的限额有时是
   * **按模型**的，账号还有额度不代表某个模型没被限流。
   *
   * @param provider - provider id。
   * @param accountId - 账号 id。
   * @param modelId - 可选：精确测试的模型 id。
   * @param options - `{ deep?: boolean }`：深度测试用真实 agent 请求的形状。
   * @returns `{ok, latencyMs, model?, error?, code?, resetHint?, deep?, at}`。
   */
  async testAccount(provider, accountId, modelId, options = {}) {
    const deep = options?.deep === true
    const settings = this.settings()
    // 测试最长要跑 60 秒；期间账号完全可能被删掉（或删掉后用同 id 重建）。
    // 结果必须只对「发起时那个账号」有效，否则新账号会继承上一个人的
    // 「刚测可用 / 已被限额」徽章 —— 与 delete 时清理 accountTests 的意图相反。
    const epochAtStart = this.#forgetEpochOf(provider, accountId)
    const account = accountsFor(provider, settings).find((entry) => entry.id === accountId)
    // 优先用这个账号自己的目录：不同套餐的模型清单可能不同。
    const accountModels = this.catalogs.get(accountKey(provider, accountId))?.models
    const models = Array.isArray(accountModels) && accountModels.length > 0 ? accountModels : this.modelsFor(provider)
    const explicit = typeof modelId === 'string' && modelId !== '' ? modelId : undefined
    const model = explicit !== undefined
      ? models.find((entry) => entry.id === explicit)
      : models.find((entry) => entry.id === 'auto') ?? models[0]
    const started = Date.now()
    const result = { at: started, ok: false, latencyMs: 0, model: model?.id ?? explicit, ...(deep ? { deep: true } : {}) }
    if (account === undefined) {
      result.error = '账号不存在'
      result.code = 'NO_ACCOUNT'
      // 不为「不存在的账号」写结论：删掉之后用同 id 重建的新账号会继承这条
      // 失败徽章（与 forgetAccount 清理 accountTests 的意图相反）。
      return result
    }
    if (model === undefined) {
      result.error = explicit === undefined
        ? '这个 provider 还没有可用模型，请先刷新目录'
        : `模型目录里找不到 ${explicit}，请先刷新目录`
      result.code = 'NO_MODEL'
      if (explicit === undefined) this.accountTests.set(accountKey(provider, accountId), result)
      else this.#setModelTest(provider, accountId, explicit, result)
      return result
    }

    const controller = new AbortController()
    // 这个死线只该管「等响应头」那一段。Qoder 的排队发生在**读流**阶段
    // （`retryQueued` 有自己的 qoderQueueWaitMs 预算），如果这条死线一路套着
    // 事件流，排队解释就永远轮不到 —— 用户看到的还是「60 秒内没有给出响应头」。
    // 所以拿到 opened 之后立刻 dispose。
    const deadline = openDeadline(TEST_DEADLINE_MS)
    const signal = AbortSignal.any([controller.signal, deadline.signal])
    let finish
    /** 正文 + 思考的字数：深度测试用它排除「200 但空响应」。 */
    let contentChars = 0
    try {
      const opened = await this.openStream(provider, {
        model: model.id,
        messages: [{ role: 'user', content: [{ type: 'text', text: deep ? DEEP_TEST_PROMPT : 'ping' }] }],
        // 深度测试：把真实对话请求的骨架也发出去（系统提示词 + 工具表 + 正常输出上限）。
        ...(deep ? { system: DEEP_TEST_SYSTEM, tools: DEEP_TEST_TOOL_SCHEMAS } : {}),
        maxTokens: deep ? DEEP_TEST_MAX_TOKENS : 1,
        reasoningEffort: Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length === 1 ? model.reasoningEfforts[0] : undefined,
        signal,
        probe: true,
        noFailover: true,
        accountId: account.id,
      })
      // 响应头已经拿到：排队的预算交给 retryQueued，这条死线不再作数。
      deadline.dispose()
      for await (const event of opened.events) {
        if (event.type === 'text' || event.type === 'reasoning') contentChars += event.text.length
        if (event.type === 'finish') {
          finish = event
          break
        }
      }
      await opened.close?.()
      result.latencyMs = Date.now() - started
      // 运行时事件用 `kind`，适配器才把它包装成 `reason.kind`；两种都接受。
      const kind = finish?.reason?.kind ?? finish?.kind
      const failure = finish?.reason?.failure ?? finish?.failure
      result.ok = kind !== undefined && kind !== 'error' && kind !== 'aborted'
      if (result.ok && deep && contentChars === 0) {
        // 深度测试要看的是「真的能对话」：200 + 空流说明网关给了个空壳，
        // 普通测试不检查这一点（1 token 的 `ping` 本来就可能只有一个 token）。
        result.ok = false
        result.error = '上游返回了空响应（深度测试没有收到正文或思考）。'
        result.code = 'EMPTY_RESPONSE'
      } else if (!result.ok && failure !== undefined) {
        result.error = failure.message
        result.code = failure.code
      } else if (!result.ok) {
        result.error = '没有收到终态事件'
        result.code = 'INCOMPLETE'
      }
    } catch (error) {
      result.latencyMs = Date.now() - started
      result.error = error instanceof Error ? error.message : String(error)
      result.code = failureCodeOf(error)
    } finally {
      deadline.dispose()
      result.latencyMs = result.latencyMs || Date.now() - started
      if (!result.ok && typeof result.error === 'string') {
        const hint = resetHintOf(result.error, result.code)
        if (hint !== undefined) result.resetHint = hint
      }
      if (this.#forgetEpochOf(provider, accountId) === epochAtStart) {
        // 测试已经证明这个账号现在能用：立刻解除失败冷却。`probe: true` 让
        // `#record()` 提前返回，那里的「成功清冷却」永远不会执行 —— 用户点了
        // 测试通过，卡片却还挂着「冷却至 …」，像是按钮没生效。
        if (result.ok) this.accountFailures.delete(accountKey(provider, accountId))
        if (explicit === undefined) this.accountTests.set(accountKey(provider, accountId), result)
        else this.#setModelTest(provider, accountId, model.id, result)
        this.#note({
          type: 'test',
          level: result.ok ? 'info' : 'warn',
          provider,
          accountId,
          message: result.ok
            ? `${deep ? '深度测试' : '账号测试'}通过（${result.model ?? '?'}，${result.latencyMs}ms）`
            : `${deep ? '深度测试' : '账号测试'}失败：${result.model ?? '?'} ${result.code ?? 'FAILED'}${result.resetHint === undefined ? '' : `，${result.resetHint} 重置`}`,
          data: { ok: result.ok, latencyMs: result.latencyMs, model: result.model, code: result.code, ...(deep ? { deep: true } : {}) },
        }, { dedupeMs: 5_000 })
      }
    }
    return result
  }

  /** 记下一个「账号 × 模型」测试结果；按时间淘汰，避免无限长。 */
  #setModelTest(provider, accountId, modelId, result) {
    this.modelTests.set(`${accountKey(provider, accountId)}::${modelId}`, result)
    if (this.modelTests.size <= 200) return
    const entries = [...this.modelTests.entries()].sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0))
    for (const [key] of entries.slice(0, this.modelTests.size - 200)) this.modelTests.delete(key)
  }

  /** 某个账号最近测试过的模型结果（给卡片渲染徽章）。 */
  modelTestsFor(provider, accountId) {
    const prefix = `${accountKey(provider, accountId)}::`
    const out = {}
    for (const [key, result] of this.modelTests) {
      if (!key.startsWith(prefix)) continue
      out[key.slice(prefix.length)] = result
    }
    return out
  }

  /** 最近一次「账号 × 模型」测试结果。 */
  lastModelTestFor(provider, accountId, modelId) {
    return this.modelTests.get(`${accountKey(provider, accountId)}::${modelId}`)
  }

  /**
   * 打开一条归一化事件流。
   *
   * 失败（401 / 403 / 402 / 429）且**一个事件都还没产出**时，会自动换一个
   * 账号重开；已经吐过内容之后失败就交给 DSH 的重试执行器，避免重复输出。
   *
   * @param provider - provider id。
   * @param request - DSH 的请求摘要；`accountId` 可强制指定账号（测试/诊断用）。
   * @returns `{ events, close, accountId }`。
   */
  async openStream(provider, request) {
    const settings = this.settings()
    // 测试账号时显式指定 accountId：不能因为当前账号不是它而测错人。
    const requestedId = typeof request.accountId === 'string' && request.accountId !== '' ? request.accountId : undefined
    const requested = requestedId === undefined
      ? undefined
      : accountsFor(provider, settings).find((account) => account.id === requestedId)
    if (requestedId !== undefined && requested === undefined) {
      // 显式指定了账号却找不到它时，**不能**退回当前账号：测试/探测会因此
      // 测到另一个账号，并把结论记到被删账号的 id 上。这与「没有候选账号」
      // 同属用户需要处理的登录问题，直接按 AUTH 报错。
      const missing = new Error(
        `${provider} 没有账号「${requestedId}」：它可能已被删除或停用。请在设置里重新登录或添加账号后重试。`,
      )
      missing.name = 'NoAccountError'
      missing.kind = 'auth'
      missing.code = 'NO_ACCOUNT'
      throw missing
    }
    const primary = requested ?? activeAccountFor(provider, settings)
    const candidates = [primary]
    if (settings.autoSwitch?.enabled !== false && request.noFailover !== true) {
      candidates.push(...pickFailoverCandidates(provider, settings, primary.id, (accountId) => this.creditsFor(provider, accountId), {
        isCoolingDown: (accountId) => this.#isCoolingDown(provider, accountId),
      }))
    }
    const images = await this.#resolveImagesForRequest(request, settings)
    const advanced = advancedOptions(settings)
    const idleMs = advanced.idleTimeoutMs

    const self = this
    let current
    let recorded = false
    let usage
    let startedAt = Date.now()
    // 整次请求（含换号前的候选尝试）的起点：用量里的「平均耗时」是用户
    // 真正等的时间。`startedAt` 每次换候选都会重置，只用于「在途请求
    // 遇删号」的墓碑判定，不能拿来算 duration。
    const requestStartedAt = startedAt
    let lastAccount = primary
    /**
     * 候选账号在**本次请求开始时**的删除代数。
     *
     * `candidates` 在这里就定下了（上面那几行），但生成器体要等宿主开始消费
     * 才跑 —— 中间用户完全可能删掉某个候选。只靠 `credentialForAccount()`
     * 里的代数守卫不够：那个守卫是在**删除之后**才取值的（续期发生在换号那一
     * 刻），于是守卫永远成立，已删除的账号照样被换号命中，续期结果还会被
     * `onCredentialRefreshed` 写回设置（账号「复活」）。
     *
     * 所以在入口与 `candidates` 一起快照，换号前逐个比对：代数变了就跳过这个
     * 候选。`credentialForAccount()` 里的守卫保留作纵深防御。
     */
    const epochAtStart = new Map()
    for (const candidate of candidates) {
      epochAtStart.set(accountKey(provider, candidate.id), this.#forgetEpochOf(provider, candidate.id))
    }
    // Qoder 排队预算是「整次请求」的，不按候选账号各发一份：否则两个账号
    // 会把用户设置的 60 秒放大成 120 秒。跨候选复用同一个起点。
    const attemptState = { queueStartedAt: undefined }

    const closeCurrent = async () => {
      const handle = current
      current = undefined
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch {
          /* 关闭失败不影响已经产出的内容 */
        }
      }
    }

    const events = (async function* () {
      /**
       * 这个候选还是不是「发起本次请求时的那一个账号」。
       *
       * 账号在 `openStream()` 返回后、生成器真正开始消费前（宿主可能隔几毫秒
       * 才 pull 第一帧）被删除，或在前一个候选等待期间被删除，都会让代数变化。
       * 命中就跳过：既不能拿已删账号的凭据打上游，更不能让它的续期结果写回
       * 设置（那等于把用户删掉的账号复活）。
       */
      const stillSameAccount = (account) => (
        self.#forgetEpochOf(provider, account.id) === epochAtStart.get(accountKey(provider, account.id))
      )
      /** 真的发出过上游请求的次数（跳过的不算）。 */
      let attempted = 0
      /**
       * 换到候选账号后待写回的目标。
       *
       * 不能一拿到响应头就写 `activeAccount`：换成 B 只说明 B 的网关收下了
       * 请求，B 完全可能在正文之前抛出额度/登录错误。那样设置里会钉住一个
       * 同样坏掉的账号，之后每次请求都先白撞一次 B 才换回 A（稳定地多一个
       * 上游往返）。只有本次尝试真的产出内容（或探测请求正常完成）才算
       * 「B 可用」，这时才写回。
       */
      let pendingSwitch
      const commitSwitch = () => {
        if (pendingSwitch === undefined) return
        const target = pendingSwitch
        pendingSwitch = undefined
        self.#applyAccountSwitch(provider, target.id)
        self.logger?.info?.(`dsh-reverse-proxy-connect: ${provider} 已切换到账号「${target.label}」继续本次请求`)
      }
      try {
        for (let index = 0; index < candidates.length; index++) {
          const account = candidates[index]
          if (!stillSameAccount(account)) {
            self.logger?.info?.(
              `dsh-reverse-proxy-connect: ${provider} 候选账号「${account.label}」在请求期间已被删除，跳过`,
            )
            continue
          }
          attempted += 1
          lastAccount = account
          startedAt = Date.now()
          usage = undefined
          let sawContent = false
          try {
            current = await self.#openUpstream(provider, request, account, settings, images, idleMs, attemptState)
          } catch (error) {
            const code = failureCodeOf(error)
            // Qoder 排队是 provider 级失败：既不该给账号记冷却，也不该换号。
            const providerScoped = isProviderScopedFailure(error)
            if (!providerScoped) self.#noteRejected(provider, account, error)
            if (!providerScoped) self.#noteFailure(provider, account, code, error?.retryAfterMs)
            if (!providerScoped && index < candidates.length - 1 && isFailoverCode(code)) {
              self.#logFailover(provider, account, candidates[index + 1], code)
              continue
            }
            self.#record(provider, account, request, {
              kind: code === 'ABORTED' ? 'aborted' : 'error',
              code,
              message: error instanceof Error ? error.message : String(error),
              usage,
              durationMs: Date.now() - requestStartedAt,
              startedAt,
            })
            recorded = true
            throw error
          }

          if (index > 0) {
            // 先记下、暂不落盘：见 pendingSwitch 的注释。
            pendingSwitch = account
          }

          try {
            for await (const event of current.events) {
              if (event.type === 'usage') usage = event.usage
              if (event.type === 'text' || event.type === 'reasoning') {
                if (event.text !== '') {
                  sawContent = true
                  commitSwitch()
                }
              }
              if (event.type === 'tool') {
                sawContent = true
                commitSwitch()
              }
              // 必须先记统计再 `yield`：宿主拿到 finish 就停止消费，生成器在
              // `yield` 处被 `return()`，写在 yield 之后的记录不会执行，finally
              // 就会把一次正常完成误记成 `incomplete`（设置卡片显示「中断」）。
              if (event.type === 'finish') {
                const kind = event.kind ?? event.reason?.kind ?? 'stop'
                // 探测请求的 `max_tokens` 只有 1，允许没有正文：能走到终态就
                // 说明账号确实可用，此时再写回换号结果。
                if (request.probe === true) commitSwitch()
                // 200 + 空流（HTML 登录页、网关错误、被代理截断）以前会被记成
                // 正常 stop：用户看到一条空白回答，统计还是成功。现在明确报
                // EMPTY_RESPONSE，交给 DSH 的重试策略。
                if (!sawContent && kind === 'stop' && request.probe !== true) {
                  const empty = new Error('上游返回了空响应（没有正文、思考或工具调用）。')
                  empty.kind = 'malformed'
                  empty.code = 'EMPTY_RESPONSE'
                  self.#record(provider, account, request, {
                    kind: 'error',
                    code: 'EMPTY_RESPONSE',
                    message: empty.message,
                    usage,
                    durationMs: Date.now() - requestStartedAt,
                    startedAt,
                  })
                  recorded = true
                  throw empty
                }
                const failure = event.reason?.failure ?? event.failure
                self.#record(provider, account, request, {
                  // 解析器给的是 `kind`（stop / tool-calls / max-tokens / error）；
                  // 1.2.0 只看 `reason.kind`，于是所有 WorkBuddy 完成都被记成 stop。
                  kind,
                  code: failure?.code,
                  message: failure?.message,
                  usage,
                  durationMs: Date.now() - requestStartedAt,
                  startedAt,
                })
                recorded = true
              }
              yield event
            }
            if (!recorded) {
              const aborted = request.signal?.aborted === true
              self.#record(provider, account, request, {
                kind: aborted ? 'aborted' : 'stop',
                ...(aborted ? { code: 'ABORTED' } : {}),
                usage,
                durationMs: Date.now() - requestStartedAt,
                startedAt,
              })
              recorded = true
            }
            return
          } catch (error) {
            // 这次尝试在正文之前失败：它不是可用的候选，不写回设置。
            pendingSwitch = undefined
            const code = failureCodeOf(error)
            const providerScoped = isProviderScopedFailure(error)
            if (!providerScoped) self.#noteRejected(provider, account, error)
            if (!providerScoped) self.#noteFailure(provider, account, code, error?.retryAfterMs)
            if (!providerScoped && !sawContent && index < candidates.length - 1 && isFailoverCode(code)) {
              self.#logFailover(provider, account, candidates[index + 1], code)
              await closeCurrent()
              continue
            }
            // 已经为终态记过（例如 EMPTY_RESPONSE）就不再记第二次。
            if (!recorded) {
              self.#record(provider, account, request, {
                kind: code === 'ABORTED' ? 'aborted' : 'error',
                code,
                message: error instanceof Error ? error.message : String(error),
                usage,
                durationMs: Date.now() - requestStartedAt,
                startedAt,
              })
              recorded = true
            }
            throw error
          } finally {
            await closeCurrent()
          }
        }
        // 所有候选都在请求期间被删了：一次上游请求都没发出去。
        //
        // 这不能静默收场 —— 宿主会看到一个「零事件、没有 finish」的流，把它当成
        // 一次成功的空回答（用户看到一片空白），而 `finally` 还会以
        // `lastAccount`（可能正是那个被删的账号）记一条 `incomplete` 统计。
        // 这里给一条明确的 AUTH 失败：用户删了账号，就该看到「请重新登录 / 添加
        // 账号」，而不是「上游返回了空响应」。
        if (attempted === 0) {
          // 这次请求一次上游都没发出去：只跳过账号维度还不够，整条记录都不该
          // 存在 —— 否则「今日请求数 / 失败率」会把一次根本没发生的请求算进去，
          // 并把它挂到可能已经被删掉的账号上。标成已记录，让 finally 不再补记。
          recorded = true
          const gone = new Error(
            `${provider} 没有可用的账号：请求开始后账号被删除或停用了。请在设置里重新登录或添加账号后重试。`,
          )
          gone.kind = 'auth'
          gone.code = 'NO_ACCOUNT'
          throw gone
        }
      } finally {
        if (!recorded) {
          self.#record(provider, lastAccount, request, {
            kind: request.signal?.aborted === true ? 'aborted' : 'incomplete',
            ...(request.signal?.aborted === true ? { code: 'ABORTED' } : {}),
            usage,
            durationMs: Date.now() - requestStartedAt,
            startedAt,
          })
        }
        await closeCurrent()
      }
    })()

    return { events, close: closeCurrent, accountId: primary.id }
  }

  /** 候选账号失败后的冷却判定。 */
  #isCoolingDown(provider, accountId) {
    const record = this.accountFailures.get(accountKey(provider, accountId))
    if (record === undefined) return false
    if (typeof record.until === 'number') return Date.now() < record.until
    const cooldown = FAILOVER_COOLDOWN_MS[record.code] ?? FAILOVER_COOLDOWN_MS.default
    return Date.now() - record.at < cooldown
  }

  /** 这个账号的冷却截止时间（0 = 不在冷却）。 */
  cooldownUntil(provider, accountId) {
    const record = this.accountFailures.get(accountKey(provider, accountId))
    if (record === undefined) return 0
    const until = typeof record.until === 'number'
      ? record.until
      : record.at + (FAILOVER_COOLDOWN_MS[record.code] ?? FAILOVER_COOLDOWN_MS.default)
    return until > Date.now() ? until : 0
  }

  /**
   * 手动清除一个账号的失败冷却。
   *
   * 「解除」的含义是「现在就允许再试一次」，所以同时丢掉最近一次失败的测试
   * 结论：否则卡片会从「冷却至 …」立刻变成「被限流 / 限额」，看起来像按钮
   * 没有生效。真实请求再失败时仍会重新写入冷却与测试结果。
   */
  clearAccountFailure(provider, accountId) {
    const cleared = this.accountFailures.delete(accountKey(provider, accountId))
    this.accountTests.delete(accountKey(provider, accountId))
    return cleared
  }

  /**
   * 删除一个账号后清理它留下的所有旁路状态。
   *
   * 账号 id 虽然已经不再复用，但旧设置里仍可能有同名 id 的数据；主动清掉
   * 额度缓存、消耗历史、统计与目录，避免「新账号继承旧账号余额」。
   *
   * @param provider - provider id。
   * @param accountId - 账号 id。
   */
  forgetAccount(provider, accountId) {
    const key = accountKey(provider, accountId)
    // 记一代「已删除」：在途的额度刷新返回后据此丢弃结果。
    //
    // 只判断「设置里还有没有这个账号」不够 —— 隐式默认账号的 id 固定是
    // `default`，用户删掉它之后账号池为空，`accountsFor()` 又会合成一个同 id
    // 的默认账号（只是还没填凭证）。于是「删除」与「重新配置」之间那条在途
    // 刷新会认为账号还在、把刚清掉的余额与消耗历史原样写回；用户重新粘贴 PAT
    // 后，新账号直接显示旧账号的数字。这里用单调递增的代数做判据。
    this.forgetEpoch.set(key, (this.forgetEpoch.get(key) ?? 0) + 1)
    this.creditCache.delete(key)
    // 只删内存里的 key 不够：saveCreditsCache 会先读磁盘再合并，磁盘上那条
    // 会被原样写回。墓碑随缓存持久化，合并时据此把同 key 的旧条目删掉。
    if (!(this.creditCache.forgotten instanceof Set)) this.creditCache.forgotten = new Set()
    this.creditCache.forgotten.add(key)
    // 同一个 id 又被删除：之前的「复活」意图必须撤销，否则这次墓碑会被摘掉。
    this.creditCache.revived?.delete(key)
    this.catalogCache.delete(key)
    // 目录缓存现在也有跨进程合并（saveCatalogCache 先读磁盘再并），只删内存
    // 不够：墓碑要记下并随文件落盘，否则删账号后重启，已删账号的模型又从
    // catalog-cache.json 回到模型选择器里。
    if (!(this.catalogCache.forgotten instanceof Set)) this.catalogCache.forgotten = new Set()
    this.catalogCache.forgotten.add(key)
    // 同一个 id 又被删除：上一次「复活」的意图必须撤销，否则这次墓碑会被摘掉。
    this.catalogCache.revived?.delete(key)
    this.catalogs.delete(key)
    this.credentialFailures.delete(key)
    this.credentialRefreshing.delete(key)
    this.identityRefreshing.delete(key)
    this.identities.delete(key)
    this.accountFailures.delete(key)
    this.accountTests.delete(key)
    // 「账号 × 模型」的测试结论同样是这个账号的旁路状态：清理遗漏会让 id 被
    // 复用（或手改重名）的新账号直接继承上一个人的「刚测可用 / 限额」徽章。
    const modelTestPrefix = `${key}::`
    for (const testKey of [...this.modelTests.keys()]) {
      if (testKey.startsWith(modelTestPrefix)) this.modelTests.delete(testKey)
    }
    this.creditHistory.forget(provider, accountId)
    this.stats?.forgetAccount?.(provider, accountId)
    this.#persistCredits()
    this.#persistCatalog(true)
    this.#note({
      type: 'credential',
      provider,
      accountId,
      message: '账号已删除，相关缓存与历史已清理',
      messageKey: { key: 'eventAccountForgotten' },
    })
  }

  /** 最近一次「测试账号」的结果。 */
  lastTestFor(provider, accountId) {
    return this.accountTests.get(accountKey(provider, accountId))
  }

  /** 记一条事件；账本本身是旁路，任何异常都不影响请求。 */
  #note(input, options) {
    try {
      this.events?.record?.(input, options)
    } catch (error) {
      this.logger?.warn?.('dsh-reverse-proxy-connect: 事件账本记录失败', error)
    }
  }

  /**
   * 上游 4xx 带回了原始响应体时，把它记进事件账本。
   *
   * `describeError()` 只挑一句给人看的话，真正排障要的 `code` / `requestId` /
   * `traceId` 都在原文里。以前这些信息随响应体一起丢掉，用户只能看到
   * 「upstream-error」和一句被截断的文案，无法判断是风控、参数还是模型问题。
   *
   * 只记一条 warn、并按 60 秒去重：上游抖动时不会把账本刷满。
   *
   * @param provider - provider id。
   * @param account - 失败账号。
   * @param error - 上游错误（带 `responseBody` 时才记录）。
   */
  #noteRejected(provider, account, error) {
    const body = typeof error?.responseBody === 'string' ? error.responseBody.trim() : ''
    if (body === '') return
    const status = typeof error?.status === 'number' && Number.isInteger(error.status) ? error.status : 0
    // 401/403/429 的语义已经确定（换号 / 冷却 / 重置时间），界面上另有明确文案，
    // 再记一条只会在限流高峰期刷屏；这里只收「说不清为什么被拒」的那一类。
    if (status === 401 || status === 403 || status === 429) return
    // 账本本身会把每个字符串截到 160 字，这里先收敛，避免把一整个 HTML 页面塞进去。
    const detail = body.slice(0, 160).replace(/\s+/g, ' ')
    this.#note({
      type: 'upstream',
      level: 'warn',
      provider,
      accountId: account?.id,
      message: `上游拒绝了请求（HTTP ${String(status)}）：${detail}`,
      messageKey: { key: 'eventUpstreamRejected', params: { status, detail } },
      data: { status, body },
    }, { dedupeMs: 60_000 })
  }

  /** 记一次账号失败（用于换号冷却）。 */
  #noteFailure(provider, account, code, retryAfterMs) {
    if (code === 'ABORTED') return
    const base = FAILOVER_COOLDOWN_MS[code] ?? FAILOVER_COOLDOWN_MS.default
    const fromUpstream = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(retryAfterMs, 10 * 60_000)
      : 0
    this.accountFailures.set(accountKey(provider, account.id), {
      at: Date.now(),
      code,
      until: Date.now() + Math.max(base, fromUpstream),
    })
  }

  /** 记一次请求统计。 */
  #record(provider, account, request, result) {
    if (request?.probe === true) return
    if (this.stats === undefined || this.stats === null) return
    const kind = result.kind === 'error' && result.code === 'ABORTED' ? 'aborted' : result.kind
    this.stats.record({
      provider,
      accountId: account?.id ?? 'default',
      ...(typeof request?.sessionId === 'string' && request.sessionId !== '' ? { sessionId: request.sessionId } : {}),
      model: typeof request?.model === 'string' ? request.model : '',
      kind,
      ...(result.code === undefined || result.code === '' ? {} : { code: result.code }),
      ...(typeof result.message === 'string' && result.message !== '' ? { message: result.message } : {}),
      // `startedAt` 是请求**发起**的时刻，只用于 Stats 的删除墓碑判定：
      // 请求在途时账号被删掉，这条返回的记录就不该把它的统计重建起来。
      //
      // 注意**不能**把它当成 `at`：`at` 决定 `daily` / `providerDaily` 分桶，
      // 而「今日」KPI 按进程时钟换桶。用开始时刻顶替 `at` 会让跨午夜的请求
      // 出现「KPI 记今天、柱状图记昨天」的两套口径。
      ...(typeof result.startedAt === 'number' && Number.isFinite(result.startedAt) ? { startedAt: result.startedAt } : {}),
      durationMs: result.durationMs,
      usage: result.usage,
    })
    if (kind === 'stop' || kind === 'tool-calls' || kind === 'max-tokens') {
      this.accountFailures.delete(accountKey(provider, account?.id ?? 'default'))
    }
  }

  /** 换号日志。 */
  #logFailover(provider, from, to, code) {
    this.logger?.info?.(
      `dsh-reverse-proxy-connect: ${provider} 账号「${from.label}」请求失败（${code}），尝试切换到「${to.label}」`,
    )
    this.#note({
      type: 'account-switch',
      level: 'warn',
      provider,
      message: `账号「${from.label}」请求失败（${code}），切换到「${to.label}」`,
      messageKey: {
        key: 'eventFailover',
        params: {
          from: from.label,
          to: to.label,
          code: code ?? '',
          ...(from.labelKey === undefined ? {} : { fromLabelKey: from.labelKey }),
          ...(to.labelKey === undefined ? {} : { toLabelKey: to.labelKey }),
        },
      },
      data: { from: from.id, to: to.id, reason: code },
    }, { dedupeMs: 5_000 })
  }

  /**
   * 打开一次上游流（不含换号逻辑）。
   *
   * @param provider - provider id。
   * @param request - DSH 请求。
   * @param account - 使用哪个账号。
   * @param settings - 设置。
   * @param images - 已解析的图片映射。
   * @param idleMs - 空闲超时。
   * @param attemptState - 跨候选账号共享的尝试状态（Qoder 排队预算）。
   * @returns `{events, close}`。
   */
  async #openUpstream(provider, request, account, settings, images, idleMs, attemptState = {}) {
    const modelRow = await this.resolveModel(provider, request.model)
    // 「连续无内容」上限：只防「只发保活、永远没有正文」的挂死，不是整条流总
    // 时长 —— 正文/思考/工具/usage 每来一个都会重置它，正常长回答不会被杀。
    const maxSilentMs = maxSilentMsOf(idleMs)
    const controller = new AbortController()
    const deadline = openDeadline(OPEN_TIMEOUT_MS)
    const signals = [controller.signal, deadline.signal]
    if (request.signal !== undefined) signals.push(request.signal)
    const signal = AbortSignal.any(signals)

    const closeIdle = () => {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }

    try {
      if (provider === PROVIDERS.workbuddy || provider === PROVIDERS.workbuddyAi) {
        const variantId = provider === PROVIDERS.workbuddy ? 'workbuddy' : 'workbuddy-ai'
        const credential = await this.credentialForAccount(provider, account, settings, signal)
        const tools = toOpenAiTools(request.tools)
        const body = JSON.stringify({
          model: request.model,
          stream: true,
          messages: toOpenAiMessages(buildMessages(request), images),
          ...(tools === undefined ? {} : { tools }),
          ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: String(request.reasoningEffort) }),
        })
        const response = await openChatStream(variantId, credential, prepareChatBody(body, impliedEffortOf(modelRow)), signal)
        deadline.dispose()
        // 拦截被就地重发自愈时也要留痕：用户看到的「这次回答慢了半秒」背后是
        // 一次网关拦截 + 重发，账本里应该有这一条（与三次都失败的 warn 同一
        // 事件类型，靠 level 与 recovered 区分），否则只有失败才可见。
        const recovered = response.interceptionRetries
        if (typeof recovered === 'number' && recovered > 0) {
          this.#note({
            type: 'upstream',
            level: 'info',
            provider,
            accountId: account.id,
            message: `上游拦截了请求，自动重发后成功（重发 ${String(recovered)} 次）`,
            messageKey: { key: 'eventUpstreamRecovered', params: { attempts: recovered } },
            data: { recovered: true, attempts: recovered },
          }, { dedupeMs: 60_000 })
        }
        return {
          events: withIdleTimeout(parseOpenAiSse(response.body, signal), { idleMs, maxSilentMs, signal, onIdle: closeIdle }),
          close: async () => {
            closeIdle()
            try {
              await response.body?.cancel()
            } catch {
              /* ignore */
            }
          },
        }
      }

      if (isTrae(provider)) {
        const credential = await this.traeCredentialFor(provider, account, settings, signal)
        const body = buildTraeChatBody({
          messages: toOpenAiMessages(buildMessages(request), images),
          model: request.model,
          tools: request.tools,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          sessionId: request.sessionId,
          reasoningEffort: request.reasoningEffort,
        })
        const response = await openTraeChat(traeVariantOf(provider), credential, body, signal)
        deadline.dispose()
        return {
          events: withIdleTimeout(parseTraeStream(response.body, signal), { idleMs, maxSilentMs, signal, onIdle: closeIdle }),
          close: async () => {
            closeIdle()
            try {
              await response.body?.cancel()
            } catch {
              /* ignore */
            }
          },
        }
      }

      const identity = await this.identityFor(provider, account, settings, signal)
      // 每次重开都要重新生成 envelope（`request_id` 必须唯一），但
      // `request_set_id` 是稳定的：Qoder 的等位接口靠它查「轮到我没有」。
      // 因此这里留住最后一次的 envelope，供排队状态查询使用。
      let lastEnvelope
      const buildEnvelope = () => {
        lastEnvelope = buildChatEnvelope({
          model: request.model,
          modelRow,
          sessionUser: identity.userID,
          sessionId: request.sessionId,
          body: {
            messages: toOpenAiMessages(buildMessages(request), images),
            tools: toOpenAiTools(request.tools) ?? [],
            ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
            ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: String(request.reasoningEffort) }),
          },
        })
        return lastEnvelope
      }
      // 免费套餐的「没有容量」和「在排队」要给不同的解释：前者等下去不会轮到，
      // 后者等下去有意义。额度缓存里已有套餐信息，顺手带进错误文案。
      const credits = this.creditsFor(provider, account.id)
      const planHint = isQoderFreePlan(provider, credits)
        ? `当前 Qoder 账号是 Free 套餐（付费额度为 ${String(credits.total ?? 0)}），只能用免费模型；`
        : ''
      const queueStartedAt = attemptState.queueStartedAt ?? Date.now()
      attemptState.queueStartedAt = queueStartedAt
      const queueBudgetMs = advancedOptions(settings).qoderQueueWaitMs
      // 已经等过的时长要从本候选的预算里扣掉：否则换号后每个候选都会重新
      // 拿一份完整的 qoderQueueWaitMs，总等待时间按候选数翻倍。
      const queueElapsedMs = Date.now() - queueStartedAt
      const remainingBudgetMs = Math.max(500, queueBudgetMs - queueElapsedMs)
      // 首包阶段的排队预算取「用户设置」与「首包上限」的较小值，**不要**再往下
      // 夹到「连接死线的剩余时间」：那会让预算永远等于死线本身（60 秒），于是
      // 用户把排队等待调到 30 秒也不生效，最后报告「超过本地 60 秒上限」——
      // 而 60 秒其实是测试死线，不是排队预算。
      //
      // 连接死线仍然兜底（上游连响应头都不给），只是它的值必须大于排队预算
      // 才轮得到排队解释先说话（见 TEST_DEADLINE_MS / OPEN_TIMEOUT_MS 的关系）。
      const openQueueBudgetMs = Math.max(500, Math.min(remainingBudgetMs, QODER_OPEN_QUEUE_BUDGET_MS))
      // 契约：第 4 个参数是「从现在起还能等多久」，文案用的原始预算与起点另传。
      const response = await this.#openQoderQueued(identity, buildEnvelope, signal, openQueueBudgetMs, {
        startedAt: queueStartedAt,
        totalBudgetMs: queueBudgetMs,
        planHint,
      })
      deadline.dispose()
      return {
        events: withIdleTimeout(
          retryQueued(
            // 流阶段没有 60 秒「等响应头」死线，重开可以按用户设置的
            // qoderQueueWaitMs（最多 180 秒）继续排队，而不是复用小得多的
            // 首包预算 —— 否则高级里调到 60/180 秒对流中排队不生效。
            // 重开拿到的 `budget` 是 retryQueued 算好的「从现在起还剩多少」，
            // 直接交给 #openQoderQueued（它的第 4 个参数就是这个语义）。
            (budget) => this.#openQoderQueued(identity, buildEnvelope, signal, budget, {
              startedAt: queueStartedAt,
              totalBudgetMs: queueBudgetMs,
              planHint,
            }),
            response.body,
            signal,
            // 传**总**预算与排队起点：剩余量由 retryQueued 自己按这两个值算，
            // 避免「传剩余量 + 再减一次已等待」的双重扣减。
            {
              startedAt: queueStartedAt,
              budgetMs: queueBudgetMs,
              planHint,
              // 流中排队也要先问等位接口：`serviceAvailable:false` + 空队列
              // 说明上游没有容量，重开多少次都不会成功。
              pollQueue: (error) => this.#qoderQueueStatus(identity, lastEnvelope, error, signal),
            },
          ),
          { idleMs, maxSilentMs, signal, onIdle: closeIdle },
        ),
        close: async () => {
          closeIdle()
          try {
            await response.body?.cancel()
          } catch {
            /* ignore */
          }
        },
      }
    } catch (error) {
      deadline.dispose()
      // 打开阶段的 abort 是哪一种？三条线索按优先级看：
      //
      // 1. `deadline.signal.reason` 是 IdleTimeoutError → **我们自己的死线**到了，
      //    与用户取消无关（1.8.1 之前只看 `AbortError` + `aborted`，用户按 Esc
      //    也会被写成「超时」）；
      // 2. 调用方的 signal 是自己带 reason 中止的（测试/探测的看门狗，或宿主
      //    取消）→ 把那个 reason 原样上抛，让上层能区分「测试超时」与「用户取消」；
      // 3. 兜底才是用户取消。
      if (deadline.signal.aborted === true) {
        const timeout = new Error('上游在限定时间内没有返回响应头。')
        timeout.kind = 'timeout'
        timeout.code = REASON.timeout
        throw timeout
      }
      if (request.signal?.aborted === true) {
        // 宿主取消通常不带 reason（`signal.reason` 是 AbortError），只有我们
        // 自己的看门狗会塞一个带 kind/code 的错误进来。调用方用
        // `AbortSignal.timeout()` 兜底时 reason 是 TimeoutError（`code` 是数字
        // 23），旧判定认不出它，会把「超时」说成「用户取消」。统一交给
        // `abortReasonOf()` 归一。
        throw abortReasonOf(request.signal)
      }
      throw error
    }
  }

  /**
   * 打开 Qoder 流，并就地处理「排队中」的软失败。
   *
   * 上游把排队回成 403/429 + `isQueued`。旧实现只在流已经建立后才重试，
   * 首包就排队时直接把错误抛给用户。这里按上游建议的秒数等一次再重开。
   *
   * **预算必须同时约束「还没拿到响应头」的那一刻**：只检查重试之间的话，
   * 一次挂住不返回的尝试会让整轮一直等到外层的 60 秒死线 —— 用户把
   * 「排队等待」调到 30 秒也没用，最后看到的还是「60 秒内没有给出响应头」。
   * 所以每次尝试都用 `AbortSignal.any([signal, deadline])` 兜住预算。
   *
   * @param identity - 身份。
   * @param buildEnvelope - 每次重开都重新生成 envelope（request_id 不能复用）。
   * @param signal - 取消。
   * @param startedAt - 本轮排队开始时间（跨多次重开累计）。
   * @param budgetMs - **从现在起**还能等多久（调用方已扣掉准备与排队时间）。
   * @param options - `{ startedAt?, totalBudgetMs? }`：`startedAt` 是整轮排队的起点
   *   （只用于「已等待 N 秒」的文案），`totalBudgetMs` 是用户设置的原始预算
   *   （只用于「超过本地 N 秒上限」的文案）。
   * @returns 响应。
   */
  async #openQoderQueued(identity, buildEnvelope, signal, budgetMs = QODER_OPEN_QUEUE_BUDGET_MS, options = {}) {
    // 旧实现把 `startedAt`（整轮排队的起点）和 `budgetMs`（已经扣过准备时间的
    // 剩余预算）一起传进来，函数里又按 `budgetMs - (now - startedAt)` 算一次 ——
    // 准备时间被扣了两次。实测：用户配 15 秒、准备花 6 秒，第一轮只剩 9 秒，
    // 函数里再减 6 秒只剩 3 秒，于是 8 秒就报「超过本地 7 秒上限」，
    // 另一个账号一次请求都没来得及发。
    //
    // 现在的契约是「budgetMs 从现在起算」：函数内部只按自己的死线递减，
    // 报告文案用调用方给的原始预算与起点。
    const now = Date.now()
    const startedAt = typeof options.startedAt === 'number' ? options.startedAt : now
    const totalBudgetMs = typeof options.totalBudgetMs === 'number' && options.totalBudgetMs > 0
      ? options.totalBudgetMs
      : budgetMs
    const planHint = typeof options.planHint === 'string' ? options.planHint : ''
    const deadlineAt = now + Math.max(500, budgetMs)
    let attempt = 0
    // 「上游说容量回来了」时的立即重开次数上限：状态接口偶尔会先于聊天接口
    // 放行，紧接着又变回无容量；不设上限会变成打上游的忙等循环。
    let immediateRetries = 0
    // 没有容量（RESOURCE_LIMIT）时最多确认几次就下结论。不直接 0 次：容量
    // 是按秒级释放的，实测出现过三连成功紧接着又全被拒的窗口。
    let capacityChecks = 0
    for (;;) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) {
        // 预算已经用完：给一句明确的结论，而不是让外层死线说「没有响应头」。
        throw qoderQueueFailure(undefined, Date.now() - startedAt, totalBudgetMs, { planHint })
      }
      // 本次尝试的预算看门狗：到点就 abort，让 openQoderChat 的 fetch 立刻结束。
      const budget = new AbortController()
      const timer = setTimeout(() => budget.abort(new QoderQueueBudgetError(totalBudgetMs)), remaining)
      timer.unref?.()
      let envelope
      try {
        envelope = buildEnvelope()
        return await openQoderChat(identity, envelope, AbortSignal.any([signal, budget.signal]))
      } catch (error) {
        // 预算到点：这次尝试没在预算内拿到响应头，按排队处理。
        if (budget.signal.aborted === true && signal?.aborted !== true) {
          throw qoderQueueFailure(error, Date.now() - startedAt, totalBudgetMs, { queue: error?.queue, planHint })
        }
        if (error?.kind !== 'soft-rate' || signal?.aborted === true) throw error
        // 问一次官方等位接口：`isQueued` 只说明「没进去」，`queueCount` /
        // `serviceAvailable` 才说明是「在排队」还是「根本没有容量」。
        const status = await this.#qoderQueueStatus(identity, envelope, error, signal)
        const queue = mergeQueueInfo(error?.queue, status)
        const verdict = describeQueue({
          queueCount: queue?.count,
          serviceAvailable: queue?.available,
          queueType: queue?.type,
          subCode: queue?.subCode,
        })
        const elapsed = Date.now() - startedAt
        const left = deadlineAt - Date.now()
        if (verdict.verdict === 'capacity') {
          // 没有容量 ≠ 在排队：上游队列里一个人都没有，等 30 秒也不会轮到。
          // 只做一次短确认（1.5 秒后重试一次），随后立刻把真实原因交给用户，
          // 不再让他对着「正在排队」空等一分钟。
          if (capacityChecks < 1 && left > 4_000) {
            capacityChecks += 1
            await sleep(1_500, signal)
            continue
          }
          throw qoderQueueFailure(error, elapsed, totalBudgetMs, { queue, planHint })
        }
        // 状态接口说容量回来了：立刻重开，别把 30 秒白白睡掉。
        if ((status?.available === true || status?.queued === false) && immediateRetries < 3 && left > 1_000) {
          immediateRetries += 1
          await sleep(400, signal)
          continue
        }
        // 首包阶段最多重开两次；次数用完与时间用完要给出不同文案。
        if (attempt >= 2) throw qoderQueueFailure(error, elapsed, totalBudgetMs, { queue, attemptsExhausted: true, planHint })
        if (left <= 0) throw qoderQueueFailure(error, elapsed, totalBudgetMs, { queue, planHint })
        const suggested = typeof status?.retryAfterMs === 'number' && Number.isFinite(status.retryAfterMs) && status.retryAfterMs > 0
          ? status.retryAfterMs
          : typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
            ? error.retryAfterMs
            : 20_000
        const waitMs = Math.max(500, Math.min(suggested, 30_000, left))
        attempt += 1
        this.logger?.info?.(
          `dsh-reverse-proxy-connect: Qoder 正在排队，${String(Math.round(waitMs / 1000))} 秒后重试（第 ${String(attempt)} 次）`,
        )
        await sleep(waitMs, signal)
      } finally {
        clearTimeout(timer)
      }
    }
  }

  /**
   * 查一次 Qoder 的等位状态（失败无副作用）。
   *
   * @param identity - 身份。
   * @param envelope - 本次尝试的 envelope（`request_set_id` 跨重试稳定）。
   * @param error - 上游的排队错误（`queue.type` 用作 `queueType`）。
   * @param signal - 取消。
   * @returns 状态，或 undefined。
   */
  async #qoderQueueStatus(identity, envelope, error, signal) {
    const requestSetId = typeof envelope?.request_set_id === 'string' ? envelope.request_set_id : ''
    if (requestSetId === '') return undefined
    // 错误体里没有任何队列字段时（例如 E2E/假上游只回了 `isQueued`），
    // 去查等位接口既问不出东西又白打一次上游；沿用错误体里的信息即可。
    const queue = error?.queue
    if (queue === null || typeof queue !== 'object' || Object.keys(queue).length === 0) return undefined
    try {
      return await fetchQoderQueueStatus(identity, {
        requestSetId,
        modelKey: typeof envelope?.model_config?.key === 'string' ? envelope.model_config.key : '',
        queueType: typeof error?.queue?.type === 'string' ? error.queue.type : undefined,
      }, signal)
    } catch {
      return undefined
    }
  }

  /**
   * 读一张图（供 `toOpenAiMessages` 使用）。
   * @param ref - 图片引用。
   * @param signal - 取消。
   * @returns 归一化后的图片信息。
   */
  async readImage(ref, signal) {
    if (!this.canAcceptImages()) {
      throw new ImageReadError('宿主没有挂载附件服务，无法读取图片输入。')
    }
    const target = imageRequestTargetOf(ref)
    let version
    try {
      version = await this.attachments.readImageRequest(ref, target, signal)
    } catch (error) {
      throw new ImageReadError(`读取图片附件失败（${String(ref?.attachmentId ?? 'unknown')}）：${error instanceof Error ? error.message : String(error)}`, error)
    }
    let readonlyPath
    try {
      const hostPath = this.attachments.imageHostPath(ref)
      if (typeof hostPath === 'string' && hostPath !== '' && typeof this.mapHostPath === 'function') {
        readonlyPath = this.mapHostPath(hostPath)
      }
    } catch {
      /* 路径映射只是锦上添花 */
    }
    return {
      attachmentId: typeof ref?.attachmentId === 'string' ? ref.attachmentId : '',
      name: typeof ref?.name === 'string' ? ref.name : undefined,
      dataUrl: imageDataUrl(version),
      mediaType: version?.mediaType,
      // 说明文本写**实际请求版本**的尺寸；target 只是上限，编码器可能给出更小的图。
      width: typeof version?.width === 'number' ? version.width : target.width,
      height: typeof version?.height === 'number' ? version.height : target.height,
      bytes: typeof version?.bytes === 'number' ? version.bytes : undefined,
      ...(readonlyPath === undefined ? {} : { readonlyPath }),
    }
  }

  /**
   * 把请求里所有图片读成 data URL。
   *
   * @param request - DSH 请求。
   * @param _settings - 保留参数位。
   * @returns Map 或 undefined。
   */
  /**
   * 把请求里引用到的图片读成「附件 id → 图片」映射。
   *
   * **历史里的坏图不能毁掉整轮请求。** `collectImageRefs()` 扫的是**整段历史**，
   * 不只是最后一条消息：用户三天前发过的一张图，只要附件存储被清理过/损坏过，
   * 之后**每一次**对话都会在 `#openUpstream` 之前就抛 `ImageReadError`
   * （`image-unavailable`），用户只能手动删掉那条消息才能继续。
   *
   * 读不到的图不进 Map，让 `toOpenAiMessages()` 走它本来准备好的
   * `[an image was attached but could not be read]` 占位文案 —— 那段降级逻辑
   * 以前是死代码（请求在读图阶段就已经被抛掉了）。
   *
   * **例外**：最后一条消息里（也就是用户这一轮刚贴的）图片全都读不到时仍然抛错。
   * 那是「用户刚给了图、插件却一张都没拿到」，静默降级会让模型对着占位文本
   * 胡答，用户完全不知道发生了什么 —— 这种要明确报 `image-unavailable`。
   *
   * @param request - DSH 请求。
   * @param _settings - 设置（保留参数位）。
   * @returns 图片映射，或 undefined（没有图片）。
   */
  async #resolveImagesForRequest(request, _settings) {
    if (!this.canAcceptImages()) return undefined
    const messages = buildMessages(request)
    const refs = collectImageRefs(messages)
    if (refs.length === 0) return undefined
    // 最后一条消息（以及它里面的图）单独记：它代表「用户这一轮真正要我看的」。
    const lastMessage = messages.length === 0 ? undefined : messages[messages.length - 1]
    const lastIds = new Set(
      collectImageRefs(lastMessage === undefined ? [] : [lastMessage])
        .map((ref) => (typeof ref.attachmentId === 'string' ? ref.attachmentId : ''))
        .filter((id) => id !== ''),
    )
    const map = new Map()
    const failures = []
    for (const ref of refs) {
      try {
        const image = await this.readImage(ref, request.signal)
        if (image.attachmentId !== '') map.set(image.attachmentId, image)
      } catch (error) {
        // 取消要原样上抛：用户按了 Esc 不该变成「读不到图片」。
        if (request.signal?.aborted === true || error?.name === 'AbortError') throw error
        failures.push({ error, ref })
        this.logger?.warn?.(
          `dsh-reverse-proxy-connect: 读取图片附件失败，改用占位文案（${ref?.attachmentId ?? '?'}）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    // 本轮新贴的图**全部**没读到 → 明确失败（不是历史坏图的锅）。
    //
    // 判据必须只看「最后一条消息里的那些图是否全部失败」，不能看整张 map 是否
    // 为空：历史里只要有一张能读的图，map.size 就大于 0，旧实现会因此把本轮
    // 新贴的坏图静默降级成占位文案 —— 模型答非所问，用户却收不到任何提示。
    if (lastIds.size > 0) {
      let resolvedCurrentTurn = false
      for (const id of lastIds) {
        if (map.has(id)) {
          resolvedCurrentTurn = true
          break
        }
      }
      if (!resolvedCurrentTurn) {
        const fromCurrentTurn = failures.find((item) => lastIds.has(item.ref?.attachmentId))
        if (fromCurrentTurn !== undefined) throw fromCurrentTurn.error
      }
    }
    return map.size === 0 ? undefined : map
  }
}

/**
 * 该模型是否必须显式带上 `reasoning_effort`。
 *
 * `glm-5.1` 这类模型只有隐含档位（`reasoning.effort`，没有 `supportedEfforts`），
 * 省略该字段会被上游判成「不支持的思考强度」并 400。目录解析时已经把隐含档位
 * 收敛成唯一可选档位，所以这里「只有一个档位」就是判据。
 *
 * @param modelRow - 模型行。
 * @returns 需要补上的档位，或 undefined。
 */
function impliedEffortOf(modelRow) {
  // 目录明确说「这个模型可以关闭思考」时，`off` 是合法取值，不能拿唯一档位
  // 顶回去：那会让用户关掉的思考照常发生（多花 token、变慢，个别上游还会
  // 因为「high + disabled」直接 400）。
  if (modelRow?.canDisableThinking === true) return undefined
  const efforts = modelRow?.reasoningEfforts
  if (!Array.isArray(efforts) || efforts.length !== 1) return undefined
  return efforts[0]
}

/**
 * 这条错误是否**确凿地**说明「这个账号的档位用不了这个模型」。
 *
 * 必须同时满足两个条件才算，缺一不可：
 * 1. HTTP 状态**明确是 400**；
 * 2. 文案明确指向账号/套餐档位。
 *
 * @param message - 上游错误文案。
 * @param status - HTTP 状态（未知则 undefined）。
 * @returns 是否属于账号档位限制。
 */
export function accountLimitation(message, status) {
  if (status !== 400) return false
  const text = String(message ?? '')
  return /当前账号类型暂不支持|账号类型.*不支持|套餐.*不支持|not supported for (?:your|this) account|not available (?:on|in) your (?:plan|account)/i.test(text)
}

/**
 * 把 DSH 的请求拼成完整消息数组（system 前缀 + 历史）。
 * @param request - DSH 的请求摘要。
 * @returns 消息数组。
 */
function buildMessages(request) {
  const out = []
  if (typeof request.system === 'string' && request.system !== '') out.push({ role: 'system', content: [{ type: 'text', text: request.system }] })
  for (const message of request.messages ?? []) out.push(message)
  return out
}

/**
 * 解析 WorkBuddy 那种「就是标准 OpenAI SSE」的流。
 *
 * @param stream - `response.body`。
 * @param signal - 取消。
 * @yields 归一化事件。
 */
export async function* parseOpenAiSse(stream, signal) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const toolCalls = new Map()
  let finishKind
  /** 终态事件：content_filter 必须带可路由的 failure，不能只给一个空 error。 */
  const finishEvent = () => {
    const kind = finishKind ?? (toolCalls.size > 0 ? 'tool-calls' : 'stop')
    return {
      type: 'finish',
      kind,
      ...(kind === 'error'
        ? { failure: { message: '上游内容安全策略拦截了这次回复（content_filter）。', code: 'CONTENT_FILTER' } }
        : {}),
    }
  }
  try {
    while (true) {
      // 取消不能以「流正常结束」收场：否则 adapter 会补一个 stop finish，
      // DSH 与统计都会把用户主动取消记成成功。
      if (signal?.aborted === true) throw abortReasonOf(signal)
      const { done, value } = await reader.read()
      // 这一批字节里有没有产出过内容事件。没有就发一个心跳：
      // 上游在长思考时会周期发 SSE 注释/空帧，字节还在流动说明连接是活的，
      // 空闲看门狗必须据此重新计时（否则第 3 分钟会把正常请求切断）。
      let emitted = false
      if (done) {
        // 补一次 decoder flush，并把「最后一行没有换行」的尾包当成完整 data 行处理，
        // 否则上游/代理省略末尾 \n 时，最后一段正文或 finish_reason 会被静默丢掉。
        buffer += decoder.decode()
        if (buffer !== '' && !buffer.endsWith('\n')) buffer += '\n'
      } else {
        buffer += decoder.decode(value, { stream: true })
      }
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '') continue
        if (payload === '[DONE]') {
          yield finishEvent()
          return
        }
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          // 截断/写坏的 JSON 帧不能静默丢：否则回答会中间缺一段，最后还报 stop。
          // 只对看起来像 JSON 的 payload 报错，放过上游的注释/心跳行。
          if (payload.startsWith('{') || payload.startsWith('[')) {
            const failure = new Error(`WorkBuddy 流返回了损坏的 JSON 帧：${payload.slice(0, 120)}`)
            failure.kind = 'malformed'
            failure.code = 'malformed'
            throw failure
          }
          continue
        }
        // `null` 是「没有错误」：有些 OpenAI 兼容网关在每一帧里都带 `"error": null`。
        // 只看 `!== undefined` 会把正常回答整条判成 SERVER 失败（Qoder 那一侧
        // 的同名判断一直是 `!== undefined && !== null`）。
        if (chunk?.error !== undefined && chunk.error !== null) {
          throw inBandFailure(chunk.error?.message, chunk.error?.code, {
            isQueued: chunk.error?.isQueued === true,
            isQuota: chunk.error?.isQuotaExceeded === true,
          })
        }
        const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined
        const delta = choice?.delta
        if (delta !== null && typeof delta === 'object') {
          const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text
          if (typeof reasoning === 'string' && reasoning !== '') {
            emitted = true
            yield { type: 'reasoning', text: reasoning }
          }
          if (typeof delta.content === 'string' && delta.content !== '') {
            emitted = true
            yield { type: 'text', text: delta.content }
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              if (call === null || typeof call !== 'object') continue
              const at = typeof call.index === 'number' ? call.index : 0
              const previous = toolCalls.get(at) ?? { id: '', name: '', arguments: '' }
              if (typeof call.id === 'string' && call.id !== '') previous.id = call.id
              if (typeof call.function?.name === 'string' && call.function.name !== '') previous.name = call.function.name
              const deltaText = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
              previous.arguments += deltaText
              toolCalls.set(at, previous)
              emitted = true
              yield { type: 'tool', index: at, id: previous.id, name: previous.name, argumentsDelta: deltaText }
            }
          }
        }
        if (chunk?.usage !== undefined && chunk.usage !== null) {
          emitted = true
          yield { type: 'usage', usage: normalizeOpenAiUsage(chunk.usage) }
        }
        const finishReason = choice?.finish_reason
        if (typeof finishReason === 'string' && finishReason !== '') {
          // 关键：finish_reason 可能出现在 usage 之前（OpenAI 的 include_usage
          // 会先发 finish_reason、再发一个只带 usage 的 chunk）。1.0.x 在这里
          // 立刻 yield finish，后面的 usage 就被 DSH 丢掉了，统计里 token 恒为 0。
          // 现在只记下终态，等 [DONE] 或流结束再发 finish。
          finishKind = openAiFinishKind(finishReason, toolCalls.size > 0)
          emitted = true
        }
      }
      if (done) break
      if (!emitted) yield { type: 'heartbeat' }
    }
    yield finishEvent()
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
  }
}

/** OpenAI usage → DSH TokenUsage。 */
export function normalizeOpenAiUsage(usage) {
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const cached = typeof usage.prompt_tokens_details?.cached_tokens === 'number'
    ? usage.prompt_tokens_details.cached_tokens
    : typeof usage.prompt_cache_hit_tokens === 'number'
      ? usage.prompt_cache_hit_tokens
      : 0
  const reasoning = typeof usage.completion_tokens_details?.reasoning_tokens === 'number'
    ? usage.completion_tokens_details.reasoning_tokens
    : typeof usage.completion_thinking_tokens === 'number'
      ? usage.completion_thinking_tokens
      : undefined
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/**
 * OpenAI finish_reason → 内部 kind。
 *
 * **`length` 优先于「见过 tool_calls」**：被 max_tokens 截断的工具调用，参数
 * 一定是不完整的（JSON 少一半）。旧实现先判 `sawToolCalls`，于是这种截断被
 * 报成 `tool-calls`，宿主会拿半截参数去执行 —— 轻则工具报错，重则按不完整的
 * 路径/命令真的动了用户的文件。截断必须以 `max-tokens` 收场，宿主才会提示
 * 「答案被截断」而不是执行工具。
 *
 * @param value - 上游 finish_reason。
 * @param sawToolCalls - 这条流里是否出现过 tool_calls 分片。
 * @returns 内部终态 kind。
 */
export function openAiFinishKind(value, sawToolCalls) {
  // 截断优先：参数不完整的工具调用绝不能当成功。
  if (value === 'length') return 'max-tokens'
  if (value === 'content_filter') return 'error'
  if (sawToolCalls) return 'tool-calls'
  if (value === 'tool_calls' || value === 'function_call') return 'tool-calls'
  return 'stop'
}

/**
 * 排队自愈：Qoder 的免费额度高峰会把请求以 403 + `isQueued` 拒掉，同时给出
 * 「N 秒后重试」。这种失败在语义上是限流而不是错误，DSH 的重试执行器会把它
 * 当成一步失败去重跑整个请求 —— 代价大且会打断已经流出的内容。所以在这里就
 * 地按上游建议等一次再重开：只要还没吐过一个字节，重试就是完全无损的。
 *
 * `isQueued` 有两种完全不同的原因（真的在排队 / 上游没有容量）。传了
 * `options.pollQueue` 时先问一次官方等位接口：没有容量就立刻给出准确结论，
 * 不再重开十几次假装在排队。
 *
 * @param reopen - 重新打开上游流的函数。
 * @param firstBody - 第一次尝试的流（可能一开头就报排队）。
 * @param signal - 取消。
 * @param options - `{ startedAt?, budgetMs?, planHint?, pollQueue? }`：整轮排队的总预算与等位查询。
 * @yields 归一化事件。
 */
export async function* retryQueued(reopen, firstBody, signal, options = {}) {
  let body = firstBody
  let attempt = 0
  const maxAttempts = 12
  const budgetMs = typeof options.budgetMs === 'number' ? options.budgetMs : QODER_QUEUE_BUDGET_MS
  const startedAt = typeof options.startedAt === 'number' ? options.startedAt : Date.now()
  const planHint = typeof options.planHint === 'string' ? options.planHint : ''
  const pollQueue = typeof options.pollQueue === 'function' ? options.pollQueue : undefined
  // 等位接口说容量回来了时的立即重开次数上限（防止忙等）。
  let immediateRetries = 0
  // 没有容量（RESOURCE_LIMIT）时的短确认次数（见下方 capacity 分支）。
  let capacityChecks = 0
  while (true) {
    // 只有在「还没有任何内容交给下游」时重开才是无损的；一旦吐过正文/思考/工具，
    // 重开就会重复输出，宁可把失败交给 DSH 的重试执行器处理。
    //
    // 判据必须排除 `heartbeat`：它只是「上游还活着」的内部信号，既不是内容、
    // 也不会转给调用方。1.5.0 引入心跳后这里曾把 `emitted = true` 对每个事件置位，
    // 于是「首轮只发了几帧保活、随后被排队拒绝」会直接失败、不再重开。
    let emitted = false
    try {
      for await (const event of parseQoderStream(body, signal)) {
        if (event.type !== 'heartbeat') emitted = true
        yield event
      }
      return
    } catch (error) {
      if (emitted || error?.kind !== 'soft-rate') throw error
      const elapsed = Date.now() - startedAt
      const remaining = budgetMs - elapsed
      const status = pollQueue === undefined ? undefined : await pollQueue(error)
      const queue = mergeQueueInfo(error?.queue, status)
      const verdict = describeQueue({
        queueCount: queue?.count,
        serviceAvailable: queue?.available,
        queueType: queue?.type,
        subCode: queue?.subCode,
      })
      // 上游没有容量：这不是排队，重开再多次也不会轮到。先做一次 1.5 秒后的
      // 短确认（容量是按秒级释放的，实测出现过三连成功紧接又全被拒的窗口），
      // 还是不行就立刻给出真实原因，不装成「正在排队」空等预算。
      if (verdict.verdict === 'capacity') {
        if (capacityChecks < 1 && budgetMs - elapsed > 4_000) {
          capacityChecks += 1
          let waited = 0
          while (waited < 1_500) {
            const step = Math.min(500, 1_500 - waited)
            await sleep(step, signal)
            waited += step
            if (signal?.aborted === true) throw abortReasonOf(signal)
            yield { type: 'heartbeat' }
          }
          const response = await reopen(Math.max(500, budgetMs - (Date.now() - startedAt)))
          body = response.body
          continue
        }
        throw qoderQueueFailure(error, elapsed, budgetMs, { queue, planHint })
      }
      if ((status?.available === true || status?.queued === false) && immediateRetries < 3) {
        // 容量刚回来：立刻重开，不睡满 30 秒。
        immediateRetries += 1
        const response = await reopen(Math.max(500, budgetMs - (Date.now() - startedAt)))
        body = response.body
        continue
      }
      if (attempt >= maxAttempts) throw qoderQueueFailure(error, elapsed, budgetMs, { queue, attemptsExhausted: true, planHint })
      if (remaining <= 0) throw qoderQueueFailure(error, elapsed, budgetMs, { queue, planHint })
      attempt++
      const suggested = typeof status?.retryAfterMs === 'number' && Number.isFinite(status.retryAfterMs) && status.retryAfterMs > 0
        ? status.retryAfterMs
        : typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
          ? error.retryAfterMs
          : 20_000
      const waitMs = Math.max(500, Math.min(suggested, 45_000, remaining))
      // 等待期间要持续发心跳。
      //
      // 这段 sleep 里没有任何上游事件，而外面套着 `withIdleTimeout()` —— 空闲
      // 看门狗会把「我们在按上游要求等待」当成「上游卡死」，到点 abort，于是
      // 排队重试一次都发不出去，用户看到的是「上游已经 N 秒没有返回任何数据」。
      // 上游常见的 retryAfterSeconds 是 20–30 秒，而空闲超时允许调到 15 秒，
      // 两者重叠时排队自愈 100% 失效。
      //
      // 心跳只用于重置空闲计时器，不会转发给调用方（withIdleTimeout 会过滤掉），
      // 也不影响 `emitted` 判定（重开仍然是无损的）。
      let waited = 0
      while (waited < waitMs) {
        const step = Math.min(1000, waitMs - waited)
        await sleep(step, signal)
        waited += step
        if (signal?.aborted === true) throw abortReasonOf(signal)
        yield { type: 'heartbeat' }
      }
      // `budgetMs` 是**整次请求**的排队总预算，`startedAt` 是排队起点。`reopen`
      // 的契约是「从现在起还能等多久」，所以必须**在 sleep 之后**重新算剩余：
      //
      // 上面那行 `remaining` 是 sleep **之前**算的，那时本次 waitMs 还没花掉。
      // 直接把它交给 reopen，等于把 sleep 的时长又额外发放了一份预算 ——
      // 实测 qoderQueueWaitMs=2000 + retryAfterSeconds=3 时总墙钟 4024ms
      // （2.01 倍），而错误文案仍写「超过本地 2 秒上限」。传 `budgetMs` 同样
      // 会让每次重开都重新拿到一份完整预算；也不要在算出的剩余上再减一次
      // `now - startedAt` —— 那是把已等待时间扣两遍，换号后的候选会提前放弃
      // （0.5.0 踩过这个坑）。
      //
      // 预算已经被这次 sleep 花光时不再重开：`reopen` 至少要能发出一次请求，
      // 给它一个最小窗口就会让实际等待超出用户设置（文案却写「超过本地 N 秒
      // 上限」）。这里直接收口，结论与文案才对得上。
      const left = budgetMs - (Date.now() - startedAt)
      if (left <= 0) throw qoderQueueFailure(error, Date.now() - startedAt, budgetMs, { queue, planHint })
      const response = await reopen(left)
      body = response.body
    }
  }
}

export { readDesktopCredential }
