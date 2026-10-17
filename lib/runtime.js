/**
 * 运行时：在适配器与两个上游之间做 DSH 消息 → 上游 body 的翻译，
 * 并持有每个 provider 的目录、凭证缓存与健康状态。
 *
 * 这里刻意不依赖 pi-ai：OpenAI chat-completions 的 body 由我们自己拼，
 * 上游的流由各自的解析器归一化成同一组事件。
 *
 * @module dsh-reverse-proxy-connect/runtime
 */

import { accountsFor, activeAccountFor, isExhausted, pickSwitchTarget } from './accounts.js'
import { qoderClaimCampaigns, workbuddyCheckinStatus, workbuddyClaimCheckin } from './checkin.js'
import { emptyCredits, fetchQoderCredits, fetchWorkBuddyCredits } from './credits.js'
import { loadCreditsCache, saveCreditsCache } from './credits-cache.js'
import { fallbackModelsFor } from './fallback-models.js'
import { PROVIDERS, STREAM_IDLE_TIMEOUT_MS } from './protocol.js'
import { providerOptions } from './settings.js'
import { needsRefresh, readDesktopCredential, refreshDesktopCredential } from './workbuddy/credentials.js'
import { fetchCatalog as fetchWorkBuddyCatalog, openChatStream, prepareChatBody } from './workbuddy/upstream.js'
import {
  buildChatEnvelope,
  fetchCatalog as fetchQoderCatalog,
  openChat as openQoderChat,
  parseStream as parseQoderStream,
  readMachineId,
  resolveIdentity,
} from './qoder/transport.js'

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
 * 把 DSH 的历史消息翻成 OpenAI chat 的 `messages`。
 *
 * DSH 的角色有 user / assistant / tool / system / developer，内容块有
 * text / reasoning / image / tool-call / tool-addition / tool-removal。
 * 上游只认 OpenAI 的那套，所以这里做一次彻底展开：
 * - developer 的 tool-addition / tool-removal 块丢掉（工具清单走 `tools` 字段）；
 * - assistant 的 tool-call 块合成 `tool_calls`；
 * - tool 角色带上 `tool_call_id`；
 * - image 块转成 data URL（仅在模型声明支持图片时才有图进来）。
 *
 * @param messages - DSH 的 RequestMessage 数组。
 * @param images - 可选的 `(attachmentId) => dataUrl`，用于把图片引用换成内联 data URL。
 * @returns OpenAI 形状的消息数组。
 */
export function toOpenAiMessages(messages, images) {
  const out = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role
    const content = Array.isArray(message.content) ? message.content : []
    if (role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: typeof message.toolCallId === 'string' ? message.toolCallId : '',
        content: textOf(content) || '(no output)',
      })
      continue
    }
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
    const parts = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push({ type: 'text', text: block.text })
      else if (block?.type === 'image' && images !== undefined) {
        const url = images(block)
        if (url !== undefined) parts.push({ type: 'image_url', image_url: { url } })
      }
    }
    const normalizedRole = role === 'system' || role === 'developer' ? 'system' : 'user'
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
 * 每个 provider 的状态与缓存。
 *
 * 目录缓存的键是 provider，值是 `{models, fetchedAt, source}`；`source` 为
 * `live` 表示刚从上游拉到，`saved` 表示上游暂时不可达时的上次结果（避免一断网
 * 模型就从选择器里消失）。
 */
export class Runtime {
  /**
   * @param options - `{ settings, dataDir, logger, onCatalogChange }`。
   */
  constructor(options) {
    this.settings = options.settings
    this.dataDir = options.dataDir
    this.logger = options.logger
    this.onCatalogChange = options.onCatalogChange
    /** @type {Map<string, {models: any[], fetchedAt: number, source: string, message?: string}>} */
    this.catalogs = new Map()
    /** @type {Map<string, any>} */
    this.credentials = new Map()
    /** @type {Map<string, any>} */
    this.identities = new Map()
    /** @type {Map<string, {data: any, fetchedAt: number, inflight?: Promise<any>, stale?: boolean, error?: string}>} */
    this.creditCache = loadCreditsCache(options.dataDir)
    /** 写盘去抖句柄。 */
    this.persistTimer = undefined
    this.machineId = readMachineId(`${options.dataDir}/.qoder-machine-id`)
    this.stopped = false
    this.refreshing = undefined
  }

  /** 该 provider 当前的模型行。 */
  modelsFor(provider) {
    return this.catalogs.get(provider)?.models ?? []
  }

  /** 该 provider 当前的状态摘要（给设置卡片用）。 */
  statusFor(provider) {
    const entry = this.catalogs.get(provider)
    return {
      provider,
      catalogSource: entry?.source ?? 'none',
      fetchedAt: entry?.fetchedAt ?? 0,
      modelCount: entry?.models.length ?? 0,
      message: entry?.message,
    }
  }

  /**
   * 该 provider 的额度快照。
   *
   * 读不到时返回上一次成功的结果并附 `error`，而不是把数字清成 0 ——
   * 「0 分」和「读不到」在界面上必须是两种样子。
   *
   * @param provider - provider id。
   * @returns 额度（含 `error` / `stale`）。
   */
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
    const entry = this.creditCache.get(this.#creditsKey(provider, id))
    if (entry === undefined) return emptyCredits()
    return {
      ...entry.data,
      ...(entry.error === undefined ? {} : { error: entry.error }),
      ...(entry.error === undefined && entry.stale !== true ? {} : { stale: true }),
      fetchedAt: entry.fetchedAt,
    }
  }

  /** 当前账号的 id。 */
  #activeId(provider) {
    return activeAccountFor(provider, this.settings())?.id ?? 'default'
  }

  /** 额度缓存的键：provider + 账号。 */
  #creditsKey(provider, accountId) {
    return `${provider}::${accountId}`
  }

  /**
   * 刷新一个 provider 下**所有账号**的额度。
   *
   * 只刷当前账号的话，就没法判断「还有没有别的账号可以切」；
   * 账号数量通常个位数，逐个刷的成本可以接受。
   *
   * 默认 2 分钟内不重复请求。
   *
   * @param provider - provider id。
   * @param options - `{ force?, maxAgeMs?, signal? }`。
   * @returns 当前账号的额度快照。
   */
  async refreshCredits(provider, options = {}) {
    const settings = this.settings()
    const accounts = accountsFor(provider, settings)
    const maxAgeMs = options.maxAgeMs ?? 120_000

    for (const account of accounts) {
      const key = this.#creditsKey(provider, account.id)
      const cached = this.creditCache.get(key)
      const fresh =
        !options.force &&
        cached !== undefined &&
        cached.error === undefined &&
        cached.stale !== true &&
        Date.now() - cached.fetchedAt < maxAgeMs
      if (fresh) continue
      if (cached?.inflight !== undefined) {
        await cached.inflight
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
      if (data.state === 'ok') this.#persistCredits()
    }

    await this.#maybeSwitchAccount(provider, settings)
    return this.creditsFor(provider)
  }

  /**
   * 当前账号额度耗尽时，自动切到下一个还有余额的账号。
   *
   * 只在「自动切换」开启、且当前账号确实耗尽时才动。切换结果直接写回设置，
   * 所以重启后仍然生效，用户也能在卡片里看到是谁被选中。
   *
   * @param provider - provider id。
   * @param settings - 当前设置。
   */
  async #maybeSwitchAccount(provider, settings) {
    if (settings.autoSwitch?.enabled === false) return
    const current = this.#activeId(provider)
    if (!isExhausted(this.creditsFor(provider, current))) return
    const target = pickSwitchTarget(provider, settings, current, (accountId) => this.creditsFor(provider, accountId))
    if (target === undefined) return
    this.logger?.info?.(`dsh-reverse-proxy-connect: ${provider} 当前账号额度已用尽，自动切换到「${target.label}」`)
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
        const credential = await this.credentialForAccount(provider, account, settings)
        return await fetchWorkBuddyCredits(variantId, credential, signal)
      }
      const region = provider === PROVIDERS.qoder ? 'china' : 'global'
      const token = this.tokenFor(provider, account)
      if (typeof token !== 'string' || token === '') {
        return { ...emptyCredits(), state: 'none', message: '尚未保存个人访问令牌（PAT）' }
      }
      const identity = await resolveIdentity(token, region, this.identities.get(`${provider}::${account.id}`), this.machineId, signal)
      this.identities.set(`${provider}::${account.id}`, identity)
      return await fetchQoderCredits(identity, region, signal)
    } catch (error) {
      return { ...emptyCredits(), state: 'error', message: error instanceof Error ? error.message : String(error), fetchedAt: Date.now() }
    }
  }

  /**
   * 取某个账号的 WorkBuddy 凭证（按账号的 authFile 走）。
   *
   * @param provider - provider id。
   * @param account - 账号。
   * @param settings - 设置。
   * @returns 凭证。
   */
  async credentialForAccount(provider, account, settings) {
    const variantId = provider === PROVIDERS.workbuddy ? 'workbuddy' : 'workbuddy-ai'
    const options = settings.workbuddy?.[variantId] ?? {}

    // 浏览器登录拿到的令牌：直接用它，不再依赖本机安装的 App。
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
      const refreshed = await refreshDesktopCredential(credential)
      // 续期后把新令牌写回账号，否则下次还得再刷一遍。
      this.onCredentialRefreshed?.(provider, account.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? '',
        expiresAtMs: refreshed.expiresAtMs,
        refreshExpiresAtMs: refreshed.refreshExpiresAtMs,
        domain: refreshed.domain,
        uid: refreshed.uid,
        enterpriseId: refreshed.enterpriseId,
      })
      return refreshed
    }

    const credential = await readDesktopCredential(variantId, {
      electronPath: options.electronPath,
      authFile: account.authFile ?? options.authFile ?? '',
    })
    if (!needsRefresh(credential)) return credential
    return await refreshDesktopCredential(credential)
  }

  /**
   * 把当前额度快照写盘（供下次启动秒显）。
   *
   * 合并短延迟：一轮 `refreshAllCredits` 会连着成功四家，没必要写四次文件。
   */
  #persistCredits() {
    if (this.persistTimer !== undefined) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      saveCreditsCache(this.dataDir, this.creditCache)
    }, 800)
    this.persistTimer.unref?.()
  }

  /**
   * 刷新单个 provider 的目录。
   * @param provider - provider id。
   * @returns 刷新结果。
   */
  async refresh(provider) {
    const settings = this.settings()
    const account = activeAccountFor(provider, settings)
    const stateKey = `${provider}::${account.id}`
    try {
      if (provider === PROVIDERS.workbuddy || provider === PROVIDERS.workbuddyAi) {
        const variantId = provider === PROVIDERS.workbuddy ? 'workbuddy' : 'workbuddy-ai'
        const state = this.credentials.get(stateKey) ?? {}
        if (account.authFile !== undefined) state.authFile = account.authFile
        this.credentials.set(stateKey, state)
        const models = await fetchWorkBuddyCatalog(variantId, settings, state)
        this.catalogs.set(provider, { models, fetchedAt: Date.now(), source: 'live' })
        return { provider, status: 'signed-in', models: models.length }
      }
      const region = provider === PROVIDERS.qoder ? 'china' : 'global'
      const token = this.tokenFor(provider, account)
      if (typeof token !== 'string' || token === '') {
        this.catalogs.set(provider, { models: [], fetchedAt: Date.now(), source: 'none', message: '尚未保存个人访问令牌（PAT）' })
        return { provider, status: 'signed-out', reason: 'no-credential', models: 0 }
      }
      const identity = await resolveIdentity(token, region, this.identities.get(stateKey), this.machineId)
      this.identities.set(stateKey, identity)
      const models = await fetchQoderCatalog(identity)
      this.catalogs.set(provider, { models, fetchedAt: Date.now(), source: 'live' })
      return { provider, status: 'signed-in', models: models.length }
    } catch (error) {
      const previous = this.catalogs.get(provider)
      const message = error instanceof Error ? error.message : String(error)
      // 三级降级：live → saved → builtin。前两者都没有时用内置兜底，
      // 免得首次启动就断网时整个模型组直接消失（用户会以为插件坏了）。
      const saved = previous !== undefined && previous.models.length > 0 ? previous.models : undefined
      const builtin = saved === undefined ? fallbackModelsFor(provider) : undefined
      this.catalogs.set(provider, {
        models: saved ?? builtin ?? [],
        fetchedAt: previous?.fetchedAt ?? 0,
        source: saved !== undefined ? 'saved' : builtin !== undefined && builtin.length > 0 ? 'builtin' : 'none',
        message,
      })
      return { provider, status: 'signed-out', reason: error?.code ?? 'upstream-error', message, models: 0 }
    }
  }

  /**
   * 能力探测：逐个模型真发一次极短请求，把账号用不了的标出来。
   *
   * 为什么需要这一步：`/v3/config` 的花名册是**产品级**的（这个客户端能提供什么），
   * 而不是**账号级**的（你这个账号买了什么）。实测国际版免费账号能列出 27 个模型，
   * 其中 13 个（GPT / Grok / Gemini 全家）一聊就回
   * 「当前账号类型暂不支持该模型」。把这些人列在选择器里只会让人白点，所以探测一遍、
   * 记下来、从选择器里隐藏（卡片上仍可见并可手动开启）。
   *
   * 探测本身很便宜：`max_tokens: 1` + 首条 user 消息，命中即取消。但模型多时仍需
   * 十几秒，所以并发跑、且只在后台进行，不阻塞首屏。
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
        const reason = await this.#probeOne(provider, model)
        if (reason !== undefined) unavailable.push(model.id)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    return { provider, probed: models.length, unavailable }
  }

  /**
   * 探测单个模型：返回不可用原因，可用则 undefined。
   *
   * 判据必须**只认确凿证据**：探测错了会把一个能用的模型藏起来，用户会觉得
   * 「插件把我的模型弄丢了」，比多显示几个不能用的模型糟得多。所以这里：
   *
   * - 429（单模型频率限制，例如「使用量已超出频率限制，将在 … 重置」）→ 视为可用。
   *   这是**配额**问题，不是能力问题；而且它有重置时间，明天就能用。
   * - 401 / 403 / 5xx / 网络超时 → 视为可用（临时故障，与账号档位无关）。
   * - 只有 400 且文案明确指向「账号/套餐不支持这个模型」才记不可用。
   *
   * @param provider - provider id。
   * @param model - 模型行。
   * @returns 原因字符串或 undefined。
   */
  async #probeOne(provider, model) {
    const effort = Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length === 1 ? model.reasoningEfforts[0] : undefined
    try {
      const opened = await this.openStream(provider, {
        model: model.id,
        reasoningEffort: effort,
        maxTokens: 1,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }],
        signal: AbortSignal.timeout(45_000),
      })
      let finish
      for await (const event of opened.events) {
        if (event.type === 'finish') {
          finish = event
          break
        }
      }
      await opened.close?.()
      if (finish?.reason?.kind === 'error') {
        // 流内错误拿不到 HTTP 状态，按「不确凿」处理 —— 宁可留着让人试。
        return undefined
      }
      return undefined
    } catch (error) {
      // 限流/排队/认证/服务端故障都不代表「这个账号不能用这个模型」。
      if (error?.kind === 'soft-rate' || error?.kind === 'quota' || error?.kind === 'auth') return undefined
      const status = typeof error?.status === 'number' ? error.status : undefined
      const message = error instanceof Error ? error.message : String(error)
      return accountLimitation(message, status) ? message : undefined
    }
  }

  /**
   * 刷新全部 provider。并发，任何一个失败不影响其他。
   * @returns 结果数组。
   */
  async refreshAll() {
    if (this.refreshing !== undefined) return this.refreshing
    this.refreshing = (async () => {
      const results = await Promise.all(Object.values(PROVIDERS).map((provider) => this.refresh(provider)))
      this.onCatalogChange?.()
      return results
    })()
    try {
      return await this.refreshing
    } finally {
      this.refreshing = undefined
    }
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
   * 规则：
   * - 先查状态；只有「活动进行中且今天没签」才真的领取，避免无谓的写请求；
   * - 一个账号失败不影响其他账号；
   * - 结果写进 `settings.checkin.results[provider]`，界面直接读。
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
          : await this.#checkinQoder(provider, account, options.signal)
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
    const credential = await this.credentialForAccount(provider, account, settings)
    const status = await workbuddyCheckinStatus(variantId, credential, signal)
    if (status.kind !== 'active') return status
    const claimed = await workbuddyClaimCheckin(variantId, credential, signal)
    return { ...claimed, streakDays: claimed.streakDays ?? status.streakDays }
  }

  /** Qoder 的签到：活动列表里能领的都领一次。 */
  async #checkinQoder(provider, account, signal) {
    const region = provider === PROVIDERS.qoder ? 'china' : 'global'
    const token = this.tokenFor(provider, account)
    if (typeof token !== 'string' || token === '') return { kind: 'failed', message: '尚未保存个人访问令牌（PAT）' }
    const key = `${provider}::${account.id}`
    const identity = await resolveIdentity(token, region, this.identities.get(key), this.machineId, signal)
    this.identities.set(key, identity)
    return await qoderClaimCampaigns(identity, region, signal)
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
   * 打开一条归一化事件流。
   * @param provider - provider id。
   * @param request - DSH 的请求摘要。
   * @returns `{ events, close }`。
   */
  async openStream(provider, request) {
    const settings = this.settings()
    const modelRow = await this.resolveModel(provider, request.model)
    const account = activeAccountFor(provider, settings)
    const stateKey = `${provider}::${account.id}`
    const timeoutSignal = AbortSignal.timeout(STREAM_IDLE_TIMEOUT_MS)
    const signal = request.signal === undefined ? timeoutSignal : AbortSignal.any([request.signal, timeoutSignal])

    if (provider === PROVIDERS.workbuddy || provider === PROVIDERS.workbuddyAi) {
      const variantId = provider === PROVIDERS.workbuddy ? 'workbuddy' : 'workbuddy-ai'
      const state = this.credentials.get(stateKey) ?? {}
      if (account.authFile !== undefined) state.authFile = account.authFile
      this.credentials.set(stateKey, state)
      const body = JSON.stringify({
        model: request.model,
        stream: true,
        messages: toOpenAiMessages(buildMessages(request), (block) => this.imageUrl(block)),
        ...(toOpenAiTools(request.tools) === undefined ? {} : { tools: toOpenAiTools(request.tools) }),
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: String(request.reasoningEffort) }),
      })
      const response = await openChatStream(variantId, settings, state, prepareChatBody(body, impliedEffortOf(modelRow)), signal)
      return { events: parseOpenAiSse(response.body, signal), close: async () => { try { await response.body?.cancel() } catch { /* ignore */ } } }
    }

    const region = provider === PROVIDERS.qoder ? 'china' : 'global'
    const token = this.tokenFor(provider, account)
    if (typeof token !== 'string' || token === '') {
      const failure = new Error('尚未保存 Qoder 个人访问令牌（PAT）')
      failure.kind = 'auth'
      throw failure
    }
    const identity = await resolveIdentity(token, region, this.identities.get(stateKey), this.machineId)
    this.identities.set(stateKey, identity)
    const envelope = buildChatEnvelope({
      model: request.model,
      modelRow,
      sessionUser: identity.userID,
      sessionId: request.sessionId,
      body: {
        messages: toOpenAiMessages(buildMessages(request), (block) => this.imageUrl(block)),
        tools: toOpenAiTools(request.tools) ?? [],
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: String(request.reasoningEffort) }),
      },
    })
    const response = await openQoderChat(identity, envelope, signal)
    return { events: retryQueued(() => openQoderChat(identity, buildChatEnvelope({
      model: request.model,
      modelRow,
      sessionUser: identity.userID,
      sessionId: request.sessionId,
      body: {
        messages: toOpenAiMessages(buildMessages(request), (block) => this.imageUrl(block)),
        tools: toOpenAiTools(request.tools) ?? [],
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: String(request.reasoningEffort) }),
      },
    }), signal), response.body, signal), close: async () => { try { await response.body?.cancel() } catch { /* ignore */ } } }
  }

  /** 图片引用 → data URL；拿不到就返回 undefined（该图会被跳过）。 */
  imageUrl(block) {
    const access = this.resolveImageAccess?.(block)
    if (access === undefined) return undefined
    return `data:${access.mediaType};base64,${access.base64}`
  }
}

/**
 * 该模型是否必须显式带上 `reasoning_effort`。
 *
 * `glm-5.1` 这类模型只有隐含档位（`reasoning.effort`，没有 `supportedEfforts`），
 * 省略该字段会被上游判成「不支持的思考强度」并 400。目录解析时已经把隐含档位
 * 收敛成唯一可选档位，所以这里「只有一个档位」就是判据 —— 只有一个可用档位时，
 * 不指定就等于让它用默认值，而上游恰恰不接受「不指定」。
 *
 * @param modelRow - 模型行。
 * @returns 需要补上的档位，或 undefined。
 */
function impliedEffortOf(modelRow) {
  const efforts = modelRow?.reasoningEfforts
  if (!Array.isArray(efforts) || efforts.length !== 1) return undefined
  // 有多个档位的模型省略 = 用默认，上游接受；只有单档位的必须点明。
  return efforts[0]
}

/**
 * 这条错误是否**确凿地**说明「这个账号的档位用不了这个模型」。
 *
 * 必须同时满足两个条件才算，缺一不可：
 * 1. HTTP 状态**明确是 400**（状态未知、429、401/403、5xx 一律不算）；
 * 2. 文案明确指向账号/套餐档位。
 *
 * 这个严格度是踩出来的：最初放过「状态未知的 finish 错误」与「任意 400」，
 * 结果把单个模型的每日频率限制（429）和一个临时失败判成了能力缺失，
 * 于是能用的模型被藏起来了。
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
 * 与 Qoder 的区别只在有无外层信封；这里同样把 `[DONE]` 与 `finish_reason`
 * 收敛成统一的 finish 事件。
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
  let finished = false
  try {
    while (true) {
      if (signal?.aborted === true) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '') continue
        if (payload === '[DONE]') {
          if (!finished) yield { type: 'finish', kind: toolCalls.size > 0 ? 'tool-calls' : 'stop' }
          return
        }
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
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
          finished = true
          yield { type: 'finish', kind: openAiFinishKind(finishReason, toolCalls.size > 0) }
        }
      }
    }
    if (!finished) yield { type: 'finish', kind: toolCalls.size > 0 ? 'tool-calls' : 'stop' }
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
 * @yields 归一化事件。
 */
async function* retryQueued(reopen, firstBody, signal) {
  let body = firstBody
  let attempt = 0
  const maxAttempts = 4
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
      if (emitted || error?.kind !== 'soft-rate' || attempt >= maxAttempts) throw error
      attempt++
      const waitMs = Math.min(error.retryAfterMs ?? 20_000, 45_000)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, waitMs)
        signal?.addEventListener?.('abort', () => {
          clearTimeout(timer)
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }, { once: true })
      })
      if (signal?.aborted === true) return
      const response = await reopen()
      body = response.body
    }
  }
}

export { readDesktopCredential }
