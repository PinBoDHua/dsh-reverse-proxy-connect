/**
 * 运行时：在适配器与两个上游之间做 DSH 消息 → 上游 body 的翻译，
 * 并持有每个 provider 的目录、凭证、额度缓存与健康状态。
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
  pickFailoverCandidates,
  pickSwitchTarget,
} from './accounts.js'
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
import { CancelledError, IdleTimeoutError, openDeadline, sleep, withIdleTimeout } from './timeout.js'
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
  return 'upstream-error'
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
  if (typeof error?.retryAfterMs === 'number') failure.retryAfterMs = error.retryAfterMs
  return failure
}

/**
 * 每个 provider 的目录、额度、凭证与请求健康状态。
 */
export class Runtime {
  /**
   * @param options - `{ settings, dataDir, logger, onCatalogChange, onCredentialRefreshed, onAccountSwitch, stats }`。
   */
  constructor(options) {
    this.settings = options.settings
    this.dataDir = options.dataDir
    this.logger = options.logger
    this.onCatalogChange = options.onCatalogChange
    this.onCredentialRefreshed = options.onCredentialRefreshed
    this.onAccountSwitch = options.onAccountSwitch
    this.stats = options.stats
    /** @type {Map<string, {models: any[], fetchedAt: number, source: string, message?: string}>} */
    this.catalogs = new Map()
    /** @type {Map<string, any>} */
    this.identities = new Map()
    /** @type {Map<string, {data: any, fetchedAt: number, stale?: boolean, error?: string, inflight?: Promise<any>}>} */
    this.creditCache = loadCreditsCache(options.dataDir)
    /** 目录缓存（provider::account → {models, fetchedAt}）。 */
    this.catalogCache = loadCatalogCache(options.dataDir)
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
    /** 写盘去抖句柄。 */
    this.persistTimer = undefined
    this.catalogPersistTimer = undefined
    /** 附件服务与宿主路径映射（图片输入用）。 */
    this.attachments = undefined
    this.mapHostPath = undefined
    /** 请求级失败记录：用于换号冷却。 */
    this.accountFailures = new Map()
    /** 凭证探测失败缓存：坏 PAT 不该被设置卡片每 20 秒重新打一次上游。 */
    this.credentialFailures = new Map()
    this.machineId = readMachineId(`${options.dataDir}/.qoder-machine-id`)
    this.stopped = false

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
    return {
      ...entry.data,
      ...(entry.error === undefined ? {} : { error: entry.error }),
      ...(entry.error === undefined && entry.stale !== true ? {} : { stale: true }),
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

      const inflight = this.#loadCredits(provider, account, options.signal)
      this.creditCache.set(key, { ...(cached ?? { data: emptyCredits(), fetchedAt: 0 }), inflight })
      const data = await inflight
      const previous = this.creditCache.get(key)
      this.creditCache.set(key, data.state === 'ok'
        ? { data, fetchedAt: data.fetchedAt, stale: false }
        : {
            data: previous?.data?.state === 'ok' ? previous.data : emptyCredits(),
            fetchedAt: previous?.fetchedAt ?? 0,
            error: data.message ?? '额度读取失败',
          })
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
      const refreshed = await this.#refreshCredentialShared(provider, account, credential, signal)
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
    const kind = provider === PROVIDERS.workbuddy || provider === PROVIDERS.workbuddyAi ? 'desktop' : 'pat'
    const key = accountKey(provider, account.id)
    const cached = this.credentialFailures.get(key)
    if (cached !== undefined && Date.now() - cached.at < 60_000) return { ...cached.result }
    try {
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
    if (this.persistTimer !== undefined) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      saveCreditsCache(this.dataDir, this.creditCache)
    }, 800)
    this.persistTimer.unref?.()
  }

  /** 把目录缓存写盘（去抖：一轮刷新会连着成功四家）。 */
  #persistCatalog() {
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
      } else {
        const identity = await this.identityFor(provider, account, settings, signal)
        models = await fetchQoderCatalog(identity, signal)
      }
      this.catalogs.set(key, { models, fetchedAt: Date.now(), source: 'live' })
      this.#persistCatalog()
      return { provider, status: 'signed-in', models: models.length }
    } catch (error) {
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
   * @param options - `{ concurrency, signal }`。
   * @returns `{provider, probed, unavailable}`。
   */
  async probeProvider(provider, options = {}) {
    const models = this.modelsFor(provider)
    if (models.length === 0) return { provider, probed: 0, unavailable: [] }
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8))
    const unavailable = []
    let index = 0

    const worker = async () => {
      while (index < models.length) {
        if (this.stopped || options.signal?.aborted === true) return
        const model = models[index++]
        const reason = await this.#probeOne(provider, model, options.signal)
        if (reason !== undefined) unavailable.push(model.id)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    return { provider, probed: models.length, unavailable }
  }

  /**
   * 探测单个模型：返回不可用原因，可用则 undefined。
   *
   * @param provider - provider id。
   * @param model - 模型行。
   * @param outerSignal - 整轮探测的取消信号（插件卸载/重探时生效）。
   * @returns 原因字符串或 undefined。
   */
  async #probeOne(provider, model, outerSignal) {
    const effort = Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length === 1 ? model.reasoningEfforts[0] : undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45_000)
    timer.unref?.()
    // 每个探测自己的 45 秒死线 + 整轮探测的取消信号；只取后者的话，插件卸载后
    // 已经发出的探测请求仍会白跑 45 秒。
    const signal = outerSignal === undefined ? controller.signal : AbortSignal.any([controller.signal, outerSignal])
    try {
      const opened = await this.openStream(provider, {
        model: model.id,
        reasoningEffort: effort,
        maxTokens: 1,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }],
        signal,
        probe: true,
        noFailover: true,
      })
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
      clearTimeout(timer)
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
        const outcome = provider === PROVIDERS.workbuddy || provider === PROVIDERS.workbuddyAi
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
   * @param provider - provider id。
   * @param accountId - 账号 id。
   * @returns `{ok, latencyMs, model?, error?, code?, at}`。
   */
  async testAccount(provider, accountId) {
    const settings = this.settings()
    const account = accountsFor(provider, settings).find((entry) => entry.id === accountId)
    // 优先用这个账号自己的目录：不同套餐的模型清单可能不同。
    const accountModels = this.catalogs.get(accountKey(provider, accountId))?.models
    const models = Array.isArray(accountModels) && accountModels.length > 0 ? accountModels : this.modelsFor(provider)
    const model = models.find((entry) => entry.id === 'auto') ?? models[0]
    const started = Date.now()
    const result = { at: started, ok: false, latencyMs: 0, model: model?.id }
    if (account === undefined) {
      result.error = '账号不存在'
      result.code = 'NO_ACCOUNT'
      this.accountTests.set(accountKey(provider, accountId), result)
      return result
    }
    if (model === undefined) {
      result.error = '这个 provider 还没有可用模型，请先刷新目录'
      result.code = 'NO_MODEL'
      this.accountTests.set(accountKey(provider, accountId), result)
      return result
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45_000)
    timer.unref?.()
    try {
      const opened = await this.openStream(provider, {
        model: model.id,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 1,
        reasoningEffort: Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length === 1 ? model.reasoningEfforts[0] : undefined,
        signal: controller.signal,
        probe: true,
        noFailover: true,
        accountId: account.id,
      })
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
      clearTimeout(timer)
      this.accountTests.set(accountKey(provider, accountId), result)
    }
    return result
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
            current = await self.#openUpstream(provider, request, account, settings, images, idleMs)
          } catch (error) {
            const code = failureCodeOf(error)
            self.#noteFailure(provider, account, code, error?.retryAfterMs)
            if (index < candidates.length - 1 && isFailoverCode(code)) {
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
              if (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool' || event.type === 'finish') sawContent = true
              // 必须先记统计再 `yield`：宿主拿到 finish 就停止消费，生成器在
              // `yield` 处被 `return()`，写在 yield 之后的记录不会执行，finally
              // 就会把一次正常完成误记成 `incomplete`（设置卡片显示「中断」）。
              if (event.type === 'finish') {
                const failure = event.reason?.failure ?? event.failure
                self.#record(provider, account, request, {
                  // 解析器给的是 `kind`（stop / tool-calls / max-tokens / error）；
                  // 1.2.0 只看 `reason.kind`，于是所有 WorkBuddy 完成都被记成 stop。
                  kind: event.kind ?? event.reason?.kind ?? 'stop',
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
            self.#noteFailure(provider, account, code, error?.retryAfterMs)
            if (!sawContent && index < candidates.length - 1 && isFailoverCode(code)) {
              self.#logFailover(provider, account, candidates[index + 1], code)
              await closeCurrent()
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

  /** 手动清除一个账号的失败冷却。 */
  clearAccountFailure(provider, accountId) {
    return this.accountFailures.delete(accountKey(provider, accountId))
  }

  /** 最近一次「测试账号」的结果。 */
  lastTestFor(provider, accountId) {
    return this.accountTests.get(accountKey(provider, accountId))
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
   * @returns `{events, close}`。
   */
  async #openUpstream(provider, request, account, settings, images, idleMs) {
    const modelRow = await this.resolveModel(provider, request.model)
    const openStartedAt = Date.now()
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
          events: withIdleTimeout(parseOpenAiSse(response.body, signal), { idleMs, signal, onIdle: closeIdle }),
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
      const queueStartedAt = Date.now()
      const queueBudgetMs = advancedOptions(settings).qoderQueueWaitMs
      // 打开阶段还要受 60 秒连接死线约束：先把取身份/换 token 已经花掉的时间扣掉，
      // 否则「身份交换 20 秒 + 排队 45 秒」会先撞上连接死线，用户看到的是
      // 模糊的「上游没有返回响应头」，而不是明确的排队提示。
      const elapsedOpenMs = Date.now() - openStartedAt
      const openRemainingMs = Math.max(0, OPEN_TIMEOUT_MS - elapsedOpenMs - 2_000)
      const openQueueBudgetMs = Math.max(500, Math.min(queueBudgetMs, QODER_OPEN_QUEUE_BUDGET_MS, openRemainingMs))
      const response = await this.#openQoderQueued(identity, buildEnvelope, signal, queueStartedAt, openQueueBudgetMs)
      deadline.dispose()
      return {
        events: withIdleTimeout(
          retryQueued(
            // 流阶段没有 60 秒「等响应头」死线，重开可以按用户设置的
            // qoderQueueWaitMs（最多 180 秒）继续排队，而不是复用小得多的
            // 首包预算 —— 否则高级里调到 60/180 秒对流中排队不生效。
            (budget) => this.#openQoderQueued(identity, buildEnvelope, signal, queueStartedAt, budget ?? queueBudgetMs),
            response.body,
            signal,
            { startedAt: queueStartedAt, budgetMs: queueBudgetMs },
          ),
          { idleMs, signal, onIdle: closeIdle },
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
      // 打开阶段的 abort 是哪一种：死线到了就是超时，否则是用户取消。
      if (error?.name === 'AbortError' && deadline.signal.aborted === true) {
        const timeout = new Error('上游在限定时间内没有返回响应头。')
        timeout.kind = 'timeout'
        timeout.code = REASON.timeout
        throw timeout
      }
      if (request.signal?.aborted === true) throw new CancelledError()
      throw error
    }
  }

  /**
   * 打开 Qoder 流，并就地处理「排队中」的软失败。
   *
   * 上游把排队回成 403/429 + `isQueued`。旧实现只在流已经建立后才重试，
   * 首包就排队时直接把错误抛给用户。这里按上游建议的秒数等一次再重开。
   *
   * @param identity - 身份。
   * @param buildEnvelope - 每次重开都重新生成 envelope（request_id 不能复用）。
   * @param signal - 取消。
   * @param startedAt - 本轮排队开始时间（跨多次重开累计）。
   * @param budgetMs - 首包阶段最多等多久。
   * @returns 响应。
   */
  async #openQoderQueued(identity, buildEnvelope, signal, startedAt = Date.now(), budgetMs = QODER_OPEN_QUEUE_BUDGET_MS) {
    let attempt = 0
    for (;;) {
      try {
        return await openQoderChat(identity, buildEnvelope(), signal)
      } catch (error) {
        if (error?.kind !== 'soft-rate' || signal?.aborted === true) throw error
        const elapsed = Date.now() - startedAt
        const remaining = budgetMs - elapsed
        // 首包阶段最多重开两次；次数用完与时间用完要给出不同文案。
        if (attempt >= 2) throw qoderQueueFailure(error, elapsed, budgetMs, { attemptsExhausted: true })
        if (remaining <= 0) throw qoderQueueFailure(error, elapsed, budgetMs)
        const suggested = typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
          ? error.retryAfterMs
          : 20_000
        const waitMs = Math.max(500, Math.min(suggested, 30_000, remaining))
        attempt += 1
        this.logger?.info?.(
          `dsh-reverse-proxy-connect: Qoder 正在排队，${String(Math.round(waitMs / 1000))} 秒后重试（第 ${String(attempt)} 次）`,
        )
        await sleep(waitMs, signal)
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
  try {
    while (true) {
      // 取消不能以「流正常结束」收场：否则 adapter 会补一个 stop finish，
      // DSH 与统计都会把用户主动取消记成成功。
      if (signal?.aborted === true) throw new CancelledError()
      const { done, value } = await reader.read()
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
          yield { type: 'finish', kind: finishKind ?? (toolCalls.size > 0 ? 'tool-calls' : 'stop') }
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
          const failure = new Error(chunk.error?.message ?? 'WorkBuddy 流中报错')
          failure.kind = 'server'
          throw failure
        }
        const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined
        const delta = choice?.delta
        if (delta !== null && typeof delta === 'object') {
          const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text
          if (typeof reasoning === 'string' && reasoning !== '') yield { type: 'reasoning', text: reasoning }
          if (typeof delta.content === 'string' && delta.content !== '') yield { type: 'text', text: delta.content }
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
              yield { type: 'tool', index: at, id: previous.id, name: previous.name, argumentsDelta: deltaText }
            }
          }
        }
        if (chunk?.usage !== undefined && chunk.usage !== null) {
          yield { type: 'usage', usage: normalizeOpenAiUsage(chunk.usage) }
        }
        const finishReason = choice?.finish_reason
        if (typeof finishReason === 'string' && finishReason !== '') {
          // 关键：finish_reason 可能出现在 usage 之前（OpenAI 的 include_usage
          // 会先发 finish_reason、再发一个只带 usage 的 chunk）。1.0.x 在这里
          // 立刻 yield finish，后面的 usage 就被 DSH 丢掉了，统计里 token 恒为 0。
          // 现在只记下终态，等 [DONE] 或流结束再发 finish。
          finishKind = openAiFinishKind(finishReason, toolCalls.size > 0)
        }
      }
      if (done) break
    }
    yield { type: 'finish', kind: finishKind ?? (toolCalls.size > 0 ? 'tool-calls' : 'stop') }
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

/** OpenAI finish_reason → 内部 kind。 */
export function openAiFinishKind(value, sawToolCalls) {
  if (sawToolCalls) return 'tool-calls'
  if (value === 'length') return 'max-tokens'
  if (value === 'tool_calls' || value === 'function_call') return 'tool-calls'
  if (value === 'content_filter') return 'error'
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
    // 只有在「一个字节都还没交给下游」时重开才是无损的；一旦吐过内容，
    // 重开就会重复输出，宁可把失败交给 DSH 的重试执行器处理。
    let emitted = false
    try {
      for await (const event of parseQoderStream(body, signal)) {
        emitted = true
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
      await sleep(waitMs, signal)
      if (signal?.aborted === true) throw new CancelledError()
      const response = await reopen(budgetMs)
      body = response.body
    }
  }
}

export { readDesktopCredential }
