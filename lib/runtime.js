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
  REASON,
} from './protocol.js'
import { advancedOptions, providerOptions } from './settings.js'
import { CancelledError, DeadlineError, IdleTimeoutError, maxSilentMsOf, openDeadline, sleep, withIdleTimeout } from './timeout.js'
import {
  needsRefresh,
  readDesktopCredential,
  refreshDesktopCredential,
} from './workbuddy/credentials.js'
import { fetchCatalog as fetchWorkBuddyCatalog, openChatStream, prepareChatBody } from './workbuddy/upstream.js'
import {
  buildChatEnvelope,
  fetchCatalog as fetchQoderCatalog,
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
 * Qoder 排队超过本地等待预算时的错误。
 *
 * 仍然是 `soft-rate`（DSH 侧会映射成 `RATE_LIMIT`），但文案明确说明：
 * 不是令牌失效、不是模型下线，而是免费模型在排队。这样用户不会误以为
 * 「免费模型坏了」，也不会再对着转圈等两分钟。
 *
 * @param error - 上游最后一次排队错误。
 * @param elapsedMs - 已经等待的时间。
 * @param budgetMs - 本地等待预算。
 * @returns 带稳定 code 的错误。
 */
export function qoderQueueFailure(error, elapsedMs, budgetMs, options = {}) {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  const budget = Math.max(1, Math.round(budgetMs / 1000))
  const reason = options?.attemptsExhausted === true
    ? '本地重开次数已用尽'
    : `超过本地 ${String(budget)} 秒上限`
  const failure = new Error(
    `Qoder 免费模型正在排队（已等待 ${String(seconds)} 秒，${reason}）。这不是令牌失效或模型下线；请稍后重试，避开高峰期。`,
  )
  failure.name = 'QoderQueueTimeout'
  failure.kind = 'soft-rate'
  failure.code = 'soft-rate'
  failure.status = 429
  // 排队是**整个 Qoder 免费池**的容量问题，不是某个账号坏了。换账号只会
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
    /** 额度历史：消耗速度、今日/7 天花费与耗尽预测。 */
    this.creditHistory = new CreditHistory({ filePath: creditsHistoryPathOf(options.dataDir) })
    /** 每个 provider 当前正在跑的额度刷新，避免卡片轮询与定时器重复打上游。 */
    this.creditRefreshing = new Map()
    /** 每个 provider 当前正在跑的目录刷新；force 请求会等这一轮结束后补跑。 */
    this.catalogRefreshing = new Map()
    /** 每个账号当前正在跑的凭证续期：并发请求必须共用同一次 refresh。 */
    this.credentialRefreshing = new Map()
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
    const existing = this.creditRefreshing.get(provider)
    if (existing !== undefined) {
      // 卡片 20 秒轮询、侧栏 60 秒轮询与定时器很容易同时打进来。等当前这轮
      // 结束即可；带 force 的手动刷新如果在等一轮非 force，结束后再补跑一次。
      await existing.catch(() => undefined)
      if (options.force !== true || existing.force === true) return this.creditsFor(provider)
    }
    const task = this.#refreshCreditsOnce(provider, options)
    task.force = options.force === true
    this.creditRefreshing.set(provider, task)
    try {
      return await task
    } finally {
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
    const maxAgeMs = options.maxAgeMs ?? 120_000

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
        continue
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
            data: previous?.data?.state === 'ok' ? previous.data : emptyCredits(),
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
    this.onAccountSwitch?.(provider, target.id)
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
      return { ...emptyCredits(), state: 'error', message: error instanceof Error ? error.message : String(error), fetchedAt: Date.now() }
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
    const identity = await resolveIdentity(token, region, this.identities.get(key), this.machineId, signal)
    this.identities.set(key, identity)
    return identity
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
          this.credentialFailures.set(key, { at: Date.now(), result: status })
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
      const result = {
        status: 'signed-out',
        reason: error?.code ?? REASON.credentialUnreadable,
        message: error instanceof Error ? error.message : String(error),
      }
      this.credentialFailures.set(key, { at: Date.now(), result })
      return result
    }
  }

  /** 清掉所有 Qoder 身份缓存（PAT 变化后调用）。 */
  forgetIdentities() {
    this.identities.clear()
    this.credentialFailures.clear()
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
  #persistCatalog() {
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
    if (this.catalogPersistTimer !== undefined) return
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
    const existing = this.catalogRefreshing.get(provider)
    if (existing !== undefined) {
      const previous = await existing.catch(() => undefined)
      if (options.force !== true || existing.force === true) {
        return previous ?? {
          provider,
          status: 'failed',
          reason: 'refresh-failed',
          models: this.modelsFor(provider).length,
        }
      }
    }
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
   * @returns `{ok, latencyMs, model?, error?, code?, resetHint?, at}`。
   */
  async testAccount(provider, accountId, modelId) {
    const settings = this.settings()
    const account = accountsFor(provider, settings).find((entry) => entry.id === accountId)
    // 优先用这个账号自己的目录：不同套餐的模型清单可能不同。
    const accountModels = this.catalogs.get(accountKey(provider, accountId))?.models
    const models = Array.isArray(accountModels) && accountModels.length > 0 ? accountModels : this.modelsFor(provider)
    const explicit = typeof modelId === 'string' && modelId !== '' ? modelId : undefined
    const model = explicit !== undefined
      ? models.find((entry) => entry.id === explicit)
      : models.find((entry) => entry.id === 'auto') ?? models[0]
    const started = Date.now()
    const result = { at: started, ok: false, latencyMs: 0, model: model?.id ?? explicit }
    if (account === undefined) {
      result.error = '账号不存在'
      result.code = 'NO_ACCOUNT'
      this.accountTests.set(accountKey(provider, accountId), result)
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
    try {
      const opened = await this.openStream(provider, {
        model: model.id,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 1,
        reasoningEffort: Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length === 1 ? model.reasoningEfforts[0] : undefined,
        signal,
        probe: true,
        noFailover: true,
        accountId: account.id,
      })
      // 响应头已经拿到：排队的预算交给 retryQueued，这条死线不再作数。
      deadline.dispose()
      let finish
      for await (const event of opened.events) {
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
      if (!result.ok && failure !== undefined) {
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
      if (explicit === undefined) this.accountTests.set(accountKey(provider, accountId), result)
      else this.#setModelTest(provider, accountId, model.id, result)
      this.#note({
        type: 'test',
        level: result.ok ? 'info' : 'warn',
        provider,
        accountId,
        message: result.ok
          ? `账号测试通过（${result.model ?? '?'}，${result.latencyMs}ms）`
          : `账号测试失败：${result.model ?? '?'} ${result.code ?? 'FAILED'}${result.resetHint === undefined ? '' : `，${result.resetHint} 重置`}`,
        data: { ok: result.ok, latencyMs: result.latencyMs, model: result.model, code: result.code },
      }, { dedupeMs: 5_000 })
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
    const requested = typeof request.accountId === 'string'
      ? accountsFor(provider, settings).find((account) => account.id === request.accountId)
      : undefined
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
    let lastAccount = primary
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
      try {
        for (let index = 0; index < candidates.length; index++) {
          const account = candidates[index]
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
              durationMs: Date.now() - startedAt,
            })
            recorded = true
            throw error
          }

          if (index > 0) {
            self.onAccountSwitch?.(provider, account.id)
            self.logger?.info?.(`dsh-reverse-proxy-connect: ${provider} 已切换到账号「${account.label}」继续本次请求`)
          }

          try {
            for await (const event of current.events) {
              if (event.type === 'usage') usage = event.usage
              if (event.type === 'text' || event.type === 'reasoning') {
                if (event.text !== '') sawContent = true
              }
              if (event.type === 'tool') sawContent = true
              // 必须先记统计再 `yield`：宿主拿到 finish 就停止消费，生成器在
              // `yield` 处被 `return()`，写在 yield 之后的记录不会执行，finally
              // 就会把一次正常完成误记成 `incomplete`（设置卡片显示「中断」）。
              if (event.type === 'finish') {
                const kind = event.kind ?? event.reason?.kind ?? 'stop'
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
                    durationMs: Date.now() - startedAt,
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
                  durationMs: Date.now() - startedAt,
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
                durationMs: Date.now() - startedAt,
              })
              recorded = true
            }
            return
          } catch (error) {
            const code = failureCodeOf(error)
            const providerScoped = isProviderScopedFailure(error)
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
                durationMs: Date.now() - startedAt,
              })
              recorded = true
            }
            throw error
          } finally {
            await closeCurrent()
          }
        }
      } finally {
        if (!recorded) {
          self.#record(provider, lastAccount, request, {
            kind: request.signal?.aborted === true ? 'aborted' : 'incomplete',
            ...(request.signal?.aborted === true ? { code: 'ABORTED' } : {}),
            usage,
            durationMs: Date.now() - startedAt,
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
    this.catalogs.delete(key)
    this.credentialFailures.delete(key)
    this.credentialRefreshing.delete(key)
    this.identities.delete(key)
    this.accountFailures.delete(key)
    this.accountTests.delete(key)
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
      const buildEnvelope = () => buildChatEnvelope({
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
      })
      deadline.dispose()
      return {
        events: withIdleTimeout(
          retryQueued(
            // 流阶段没有 60 秒「等响应头」死线，重开可以按用户设置的
            // qoderQueueWaitMs（最多 180 秒）继续排队，而不是复用小得多的
            // 首包预算 —— 否则高级里调到 60/180 秒对流中排队不生效。
            (budget) => this.#openQoderQueued(identity, buildEnvelope, signal, budget ?? Math.max(500, remainingBudgetMs - (Date.now() - queueStartedAt)), {
              startedAt: queueStartedAt,
              totalBudgetMs: queueBudgetMs,
            }),
            response.body,
            signal,
            { startedAt: queueStartedAt, budgetMs: remainingBudgetMs },
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
        const reason = request.signal.reason
        // 宿主取消通常不带 reason（`signal.reason` 是 AbortError），只有我们
        // 自己的看门狗会塞一个带 kind/code 的错误进来。
        if (reason !== undefined && reason !== null && (typeof reason.kind === 'string' || typeof reason.code === 'string')) throw reason
        throw new CancelledError()
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
    const deadlineAt = now + Math.max(500, budgetMs)
    let attempt = 0
    for (;;) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) {
        // 预算已经用完：给一句明确的排队结论，而不是让外层死线说「没有响应头」。
        throw qoderQueueFailure(undefined, Date.now() - startedAt, totalBudgetMs)
      }
      // 本次尝试的预算看门狗：到点就 abort，让 openQoderChat 的 fetch 立刻结束。
      const budget = new AbortController()
      const timer = setTimeout(() => budget.abort(new QoderQueueBudgetError(totalBudgetMs)), remaining)
      timer.unref?.()
      try {
        return await openQoderChat(identity, buildEnvelope(), AbortSignal.any([signal, budget.signal]))
      } catch (error) {
        // 预算到点：这次尝试没在预算内拿到响应头，按排队处理。
        if (budget.signal.aborted === true && signal?.aborted !== true) {
          throw qoderQueueFailure(error, Date.now() - startedAt, totalBudgetMs)
        }
        if (error?.kind !== 'soft-rate' || signal?.aborted === true) throw error
        const elapsed = Date.now() - startedAt
        const left = deadlineAt - Date.now()
        // 首包阶段最多重开两次；次数用完与时间用完要给出不同文案。
        if (attempt >= 2) throw qoderQueueFailure(error, elapsed, totalBudgetMs, { attemptsExhausted: true })
        if (left <= 0) throw qoderQueueFailure(error, elapsed, totalBudgetMs)
        const suggested = typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
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
  async #resolveImagesForRequest(request, _settings) {
    if (!this.canAcceptImages()) return undefined
    const refs = collectImageRefs(buildMessages(request))
    if (refs.length === 0) return undefined
    const map = new Map()
    for (const ref of refs) {
      const image = await this.readImage(ref, request.signal)
      if (image.attachmentId !== '') map.set(image.attachmentId, image)
    }
    return map
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
      if (signal?.aborted === true) throw new CancelledError()
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
        if (chunk?.error !== undefined) {
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
 * @param reopen - 重新打开上游流的函数。
 * @param firstBody - 第一次尝试的流（可能一开头就报排队）。
 * @param signal - 取消。
 * @param options - `{ startedAt?, budgetMs? }`：整轮排队的总预算。
 * @yields 归一化事件。
 */
async function* retryQueued(reopen, firstBody, signal, options = {}) {
  let body = firstBody
  let attempt = 0
  const maxAttempts = 12
  const budgetMs = typeof options.budgetMs === 'number' ? options.budgetMs : QODER_QUEUE_BUDGET_MS
  const startedAt = typeof options.startedAt === 'number' ? options.startedAt : Date.now()
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
      if (attempt >= maxAttempts) throw qoderQueueFailure(error, elapsed, budgetMs, { attemptsExhausted: true })
      if (remaining <= 0) throw qoderQueueFailure(error, elapsed, budgetMs)
      attempt++
      const suggested = typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
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
        if (signal?.aborted === true) throw new CancelledError()
        yield { type: 'heartbeat' }
      }
      // `budgetMs` 是「流阶段开始时还剩多少」，重开时直接按「从此刻起还能等
      // 这么久」传下去即可 —— 再减一次已经包含在里面的排队耗时就会双重扣减，
      // 换号后的候选会提前放弃。
      const response = await reopen(budgetMs)
      body = response.body    }
  }
}

export { readDesktopCredential }
