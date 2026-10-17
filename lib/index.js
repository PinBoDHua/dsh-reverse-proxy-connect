/**
 * dsh-reverse-proxy-connect —— 把 WorkBuddy（国内版 / 国际版）与 Qoder
 * （全球版 / 国内版）账号里的模型接进 DeepSeek Harness。
 *
 * ## 与上游两个插件的区别
 * `dsh-workbuddy-connect` 和 `dsh-qoder-connect` 各是一个插件、各起一个本地
 * 回环服务、各自 import `@earendil-works/pi-ai` 与 `@deepseek-ai/dsh-llm-pi-ai`。
 * 本插件把四家合成一个：
 *
 * - **不导入 pi-ai**，直接实现 DSH 公开的 `LlmAdapter`（见 lib/adapter.js）；
 * - **不起回环 HTTP 服务**，上游请求直接从宿主进程发出，少一层本地 socket；
 * - 四个 provider（`workbuddy` / `workbuddy-ai` / `qoder` / `qoder-global`）
 *   共用一个适配器、一份目录缓存、一张设置卡片。
 *
 * 这样在 DSH 0.2.1-rc.1 上不会出现「插件自带 pi-ai 0.87 与宿主 1.1 并存」
 * 的跨版本错配 —— 这也是上游 workbuddy-connect 目前最大的隐患。
 *
 * @module dsh-reverse-proxy-connect
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ReverseProxyAdapter } from './adapter.js'
import { accountsFor, activeAccountFor, mergeAccountSecrets, normalizeAccount } from './accounts.js'
import { Runtime } from './runtime.js'
import { SettingsStore, displayNameOf, isModelVisible, providerOptions } from './settings.js'
import {
  ACTION_PATH,
  DATA_DIR_ENV,
  DATA_DIR_NAME,
  PROVIDERS,
  PROVIDER_IDS,
  PROVIDER_META,
  REASON,
  SETTINGS_PATH,
  STATUS_PATH,
} from './protocol.js'
import { probeDesktopLogin } from './workbuddy/credentials.js'
import { startBrowserLogin } from './workbuddy/browser-login.js'
import { resolveIdentity } from './qoder/transport.js'

/** 插件在 profile 里的条目名：DSH 用它给 settings 命名空间与应用 id 取键。 */
const NAME = 'dsh-reverse-proxy-connect'

/**
 * 插件版本，从自己的 `package.json` 读。
 *
 * 不写死：发布时只改 package.json 一处，卡片与诊断里就跟着变。
 * 读不到时回落到 `0.0.0`，不让一个坏文件把整个插件搞挂。
 */
const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 当前插件版本（给测试与状态文档用）。 */
export const pluginVersion = VERSION

/** 需要注入的服务：llm 是必须的，webServer 只用于设置卡片接口。 */
const inject = ['llm']

/** 进程内的一次性控制密钥：写接口必须带上它，防止任意本地页面改设置。 */
let processToken
function controlToken() {
  processToken ??= randomBytes(24).toString('hex')
  return processToken
}

/** 数据目录：优先环境变量，其次 profile 目录，最后 DSH home。 */
function dataDirOf(ctx) {
  const override = process.env[DATA_DIR_ENV]
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  let profileDir
  try {
    profileDir = ctx.get?.('profileContext')?.dir
  } catch {
    profileDir = undefined
  }
  const base = typeof profileDir === 'string' && profileDir !== '' ? profileDir : dshHome()
  return join(base, DATA_DIR_NAME)
}

/** 解析 DSH home：与 dsh-home-paths 的规则一致（$DSH_HOME → ~/.dsh）。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * 插件主体。
 * @param ctx - Cordis 上下文。
 * @param config - 条目配置（本插件不读，全部走 settings.json）。
 */
export function apply(ctx, config) {
  const dataDir = dataDirOf(ctx)
  mkdirSync(dataDir, { recursive: true })
  const store = new SettingsStore(join(dataDir, 'settings.json'))
  const settings = () => store.get()

  /** 目录变化时通知 DSH 重读模型清单（选择器立即刷新）。 */
  let invalidated = false
  const bumpCatalog = () => {
    invalidated = true
    try {
      ctx.emit?.('llm/adapters-updated')
    } catch (error) {
      ctx.logger?.warn?.('dsh-reverse-proxy-connect: 无法广播模型目录更新', error)
    }
  }

  const runtime = new Runtime({
    settings,
    dataDir,
    logger: ctx.logger,
    onCatalogChange: bumpCatalog,
    // 自动切换账号：把结果写回设置，重启后仍然生效，卡片里也能看到是谁被选中。
    // 浏览器登录拿到的令牌会过期，续期成功后写回账号，避免每次请求都重刷。
    onCredentialRefreshed: (provider, accountId, token) => {
      try {
        const accounts = accountsFor(provider, settings())
        const list = accounts.map((item) => ({
          id: item.id,
          label: item.label,
          enabled: item.enabled !== false,
          ...(item.authFile === undefined || item.authFile === '' ? {} : { authFile: item.authFile }),
          ...(item.pat === undefined ? {} : { pat: item.pat }),
          ...(item.token === undefined ? {} : { token: item.token }),
        }))
        const target = list.find((item) => item.id === accountId)
        if (target === undefined) return
        target.token = token
        store.patch({ accounts: { [provider]: list } })
      } catch (error) {
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 写回续期令牌失败', error)
      }
    },
    onAccountSwitch: (provider, accountId) => {
      try {
        store.patch({ activeAccount: { [provider]: accountId } })
        bumpCatalog()
      } catch (error) {
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 保存自动切换的账号失败', error)
      }
    },
  })

  const adapter = new ReverseProxyAdapter({
    listModels: async (provider) => {
      const options = providerOptions(settings(), provider)
      if (!options.enabled) return []
      // 用户手动的屏蔽与「探测证明账号用不了」都隐藏；两者分开存，语义不同。
      return runtime.modelsFor(provider).filter((model) => isModelVisible(options, model.id))
    },
    resolveModel: async (provider, model) => runtime.resolveModel(provider, model),
    openStream: (provider, request) => runtime.openStream(provider, request),
    showRateInModelName: () => settings().display?.showRateInModelName !== false,
  })

  // 四个 provider 一次性注册；一个 adapter 实例拥有全部路由。
  const releaseAdapter = ctx.llm.registerAdapter(PROVIDER_IDS, adapter)
  try {
    ctx.effect(() => () => {
      releaseAdapter()
      runtime.stopped = true
      probeAbort?.abort()
    })
  } catch (error) {
    releaseAdapter()
    throw error
  }

  /** 能力探测的取消句柄；provider 集合重载时重建。 */
  let probeAbort

  /**
   * 后台跑一轮能力探测，把账号用不了的模型写入 `unavailableModels`。
   *
   * 只做一次「每 provider 每 6 小时」，避免每次启动都烧一遍额度：探测用的是
   * `max_tokens: 1`，但仍然是真实计费请求。
   */
  const runProbe = async () => {
    const current = settings()
    if (current.probe?.enabled === false) return
    const lastRunAt = typeof current.probe?.lastRunAt === 'number' ? current.probe.lastRunAt : 0
    if (Date.now() - lastRunAt < 6 * 3600_000) return
    probeAbort?.abort()
    probeAbort = new AbortController()
    const patch = { unavailableModels: {}, probe: { lastRunAt: Date.now(), results: {} } }
    for (const provider of PROVIDER_IDS) {
      const { enabled } = providerOptions(settings(), provider)
      if (!enabled) {
        // 没启用就保持原样，别把上一次的结论清空（用户可能只是临时关掉）。
        patch.unavailableModels[provider] = settings().unavailableModels?.[provider] ?? []
        continue
      }
      try {
        const outcome = await runtime.probeProvider(provider, { signal: probeAbort.signal })
        patch.unavailableModels[provider] = outcome.unavailable
        patch.probe.results[provider] = { probed: outcome.probed, unavailable: outcome.unavailable.length, at: Date.now() }
      } catch (error) {
        ctx.logger?.warn?.(`dsh-reverse-proxy-connect: ${provider} 能力探测失败`, error)
        // 探测本身失败时保留旧结论，不要退化成「全部不可用」或「全部可用」。
        patch.unavailableModels[provider] = settings().unavailableModels?.[provider] ?? []
      }
    }
    if (probeAbort.signal.aborted) return
    store.patch(patch)
    bumpCatalog()
    ctx.logger?.info?.(
      `dsh-reverse-proxy-connect: 能力探测完成，${PROVIDER_IDS.map((provider) => `${provider}=${String(patch.unavailableModels[provider]?.length ?? 0)} 不可用`).join('，')}`,
    )
  }

  // 首轮刷新：目录与额度**并行**起步。
  //
  // 早先是「目录拉完再拉额度」，等于把两段网络延迟串起来 —— 额度本来和目录
  // 毫无依赖，串行只会让侧栏小卡更晚出现数字。现在两者同时发车。
  //
  // 再叠加一层：额度快照在启动时已从磁盘恢复（`loadCreditsCache`），
  // 所以即便这两次请求都要几秒，界面第一帧就有上次的数字可显示。
  void Promise.allSettled([runtime.refreshAll(), runtime.refreshAllCredits()]).then(([catalog]) => {
    if (catalog.status === 'fulfilled') {
      // 目录到手后立刻通知一次，让选择器先显示全量；探测结果到了再收敛。
      bumpCatalog()
      void runProbe()
      // 签到排在额度之后：领到的积分要能立刻体现在数字上。
      void runCheckin().catch((error) => {
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 首轮签到失败', error)
      })
      return
    }
    ctx.logger?.warn?.('dsh-reverse-proxy-connect: 首次模型目录刷新失败', catalog.reason)
  })

  // 定期刷新：凭证过期、模型上下线、额度重置、每日签到都靠它。
  const timer = setInterval(() => {
    void runtime.refreshAll().catch(() => undefined)
    void runtime.refreshAllCredits().catch(() => undefined)
    // 内部按 `lastRunAt` 做 20 小时节流，所以这里每次问一遍是安全的。
    void runCheckin().catch(() => undefined)
  }, 10 * 60_000)
  timer.unref?.()
  try {
    ctx.effect(() => () => clearInterval(timer))
  } catch {
    /* 旧版没有 effect 时忽略 */
  }

  // ── 设置卡片用的同源接口 ──────────────────────────────────────────
  const attachRoutes = (webCtx) => {
    const token = controlToken()
    const disposeStatus = webCtx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (req, res) => handleStatus(req, res),
    })
    const disposeSettings = webCtx.webServer.register({
      kind: 'exact',
      path: SETTINGS_PATH,
      handler: (req, res) => handleSettings(req, res, token),
    })
    const disposeAction = webCtx.webServer.register({
      kind: 'exact',
      path: ACTION_PATH,
      handler: (req, res) => handleAction(req, res, token),
    })
    return () => {
      disposeStatus()
      disposeSettings()
      disposeAction()
    }
  }

  /** GET /status：只读，给卡片轮询。 */
  async function handleStatus(req, res) {
    if (!loopbackRequest(req)) {
      writeJson(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      const document = await buildStatus()
      writeJson(res, 200, document)
    } catch (error) {
      writeJson(res, 500, { error: 'status-failed', message: String(error) })
    }
  }

  /** 组装状态文档：provider 状态 + 模型清单 + 凭证来源。 */
  async function buildStatus() {
    const current = settings()
    const providers = []
    for (const provider of PROVIDER_IDS) {
      const meta = PROVIDER_META[provider]
      const options = providerOptions(current, provider)
      const models = runtime.modelsFor(provider).map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsImages: model.supportsImages === true,
        reasoningEfforts: model.reasoningEfforts ?? [],
        credits: model.credits,
        disabled: options.disabled.has(model.id),
        // 「账号用不了」与「用户关掉了」是两件事，卡片要分开显示。
        unavailable: options.unavailable.has(model.id),
        forced: options.forced.has(model.id),
        virtual: model.virtual === true,
      }))
      const status = runtime.statusFor(provider)
      const activeAccount = activeAccountFor(provider, current)
      // 账号列表：只给「有没有凭证」，绝不把 PAT 回传给浏览器。
      const accounts = accountsFor(provider, current).map((account) => ({
        id: account.id,
        label: account.label,
        enabled: account.enabled !== false,
        kind: meta.credentialKind,
        active: account.id === activeAccount.id,
        // 桌面账号为空路径 = 读本机登录，也算已配置。
        configured: meta.credentialKind === 'desktop' ? true : account.pat !== undefined,
        authFile: meta.credentialKind === 'desktop' ? (account.authFile ?? '') : undefined,
        credits: runtime.creditsFor(provider, account.id),
      }))
      providers.push({
        provider,
        displayName: displayNameOf(provider),
        kind: meta.credentialKind,
        enabled: options.enabled,
        catalogSource: status.catalogSource,
        fetchedAt: status.fetchedAt,
        message: status.message,
        models,
        // 额度与模型目录分开取：目录失败不代表额度读不到，反之亦然。
        credits: runtime.creditsFor(provider),
        accounts,
        // 签到：最近一次结果 + 是否开启。界面据此显示「今日已签 / 可领 / 无活动」。
        checkin: {
          enabled: current.checkin?.enabled !== false,
          lastRunAt: current.checkin?.lastRunAt ?? 0,
          result: current.checkin?.results?.[provider] ?? undefined,
        },
        // 「打开 App 登录」任务的状态（只有桌面 provider 有）。
        login: loginJobs.get(provider) === undefined ? undefined : (({ close, ...rest }) => rest)(loginJobs.get(provider)),
        autoSwitch: current.autoSwitch?.enabled !== false,
        credential:
          meta.credentialKind === 'desktop'
            ? await probeDesktopLogin(meta.variant, {
                ...(current.workbuddy?.[meta.variant] ?? {}),
                authFile: activeAccount.authFile ?? current.workbuddy?.[meta.variant]?.authFile ?? '',
              })
            : await probeQoder(provider, current),
      })
    }
    return {
      version: 3,
      plugin: { name: NAME, version: VERSION, host: 'in-process' },
      key: controlToken(),
      providers,
      settings: {
        workbuddy: current.workbuddy,
        qoder: {
          [PROVIDERS.qoder]: { configured: (current.qoder?.[PROVIDERS.qoder]?.pat ?? '') !== '' },
          [PROVIDERS.qoderGlobal]: { configured: (current.qoder?.[PROVIDERS.qoderGlobal]?.pat ?? '') !== '' },
        },
        showRateInModelName: current.display?.showRateInModelName !== false,
      },
      probe: {
        enabled: current.probe?.enabled !== false,
        lastRunAt: current.probe?.lastRunAt ?? 0,
        results: current.probe?.results ?? {},
      },
      proxy: { mode: 'in-process', prefix: 'provider-adapter' },
    }
  }

  /** Qoder 的登录探测：有 PAT 就换一次 job token 验证，不消耗模型额度。 */
  async function probeQoder(provider, current) {
    const account = activeAccountFor(provider, current)
    const pat = runtime.tokenFor(provider, account)
    if (pat === undefined) return { status: 'signed-out', reason: REASON.noCredential, message: '尚未保存个人访问令牌（PAT）' }
    const key = `${provider}::${account.id}`
    try {
      const identity = await resolveIdentity(
        pat,
        provider === PROVIDERS.qoder ? 'china' : 'global',
        runtime.identities.get(key),
        runtime.machineId,
      )
      runtime.identities.set(key, identity)
      return { status: 'signed-in', email: identity.email, expiresAtMs: identity.expiresAtMs, patTail: pat.slice(-4) }
    } catch (error) {
      return { status: 'signed-out', reason: error?.code ?? REASON.patInvalid, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 正在进行的「打开 App 登录」任务，按 provider 存。 */
  const loginJobs = new Map()

  /**
   * 开始一次浏览器登录（WorkBuddy 官方的「插件登录」流程）。
   *
   * 流程：申请 state + authUrl → 交给系统浏览器 → 轮询换 token →
   * 读回账号信息 → 把令牌写进账号池并设为当前。
   *
   * 全程不需要启动桌面 App，也不需要用户手填任何路径。
   *
   * @param provider - provider id。
   * @returns 任务状态快照。
   */
  function startLogin(provider) {
    if (provider !== PROVIDERS.workbuddy && provider !== PROVIDERS.workbuddyAi) {
      return { phase: 'failed', message: '只有 WorkBuddy 支持浏览器登录；Qoder 请直接粘贴 PAT' }
    }
    const existing = loginJobs.get(provider)
    if (existing !== undefined && existing.phase !== 'done' && existing.phase !== 'failed' && existing.phase !== 'cancelled') {
      return { ...existing }
    }

    const variantId = provider === PROVIDERS.workbuddy ? 'workbuddy' : 'workbuddy-ai'
    const job = { phase: 'starting', message: '正在申请登录地址…', startedAt: Date.now() }

    const controller = startBrowserLogin({
      variantId,
      spawn,
      onUpdate: (patch) => {
        Object.assign(job, patch)
        if (patch.phase === 'waiting') bumpCatalog()
      },
    })
    loginJobs.set(provider, Object.assign(job, { close: () => controller.close() }))

    controller.result.then(({ token, account, label }) => {
      try {
        const accounts = accountsFor(provider, settings())
        const list = accounts.map((item) => ({
          id: item.id,
          label: item.label,
          enabled: item.enabled !== false,
          ...(item.authFile === undefined || item.authFile === '' ? {} : { authFile: item.authFile }),
          ...(item.pat === undefined ? {} : { pat: item.pat }),
          ...(item.token === undefined ? {} : { token: item.token }),
        }))
        // 同一个 uid 再登录：更新令牌即可，不重复添加账号。
        const existingAccount = list.find((item) => item.token !== undefined && account.uid !== '' && item.token.uid === account.uid)
        const merged = {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAtMs: token.expiresAtMs,
          refreshExpiresAtMs: token.refreshExpiresAtMs,
          domain: token.domain,
          uid: account.uid,
          enterpriseId: account.enterpriseId,
        }
        let targetAccount = existingAccount
        if (targetAccount === undefined) {
          targetAccount = { id: `acc-${String(Date.now())}`, label, enabled: true, token: merged }
          list.push(targetAccount)
        } else {
          targetAccount.token = merged
          targetAccount.label = label
        }
        store.patch({ accounts: { [provider]: list }, activeAccount: { [provider]: targetAccount.id } })
        job.phase = 'done'
        job.message = `登录成功：${label}`
        job.uid = account.uid
        bumpCatalog()
        void runtime.refreshAll().catch(() => undefined)
        void runtime.refreshAllCredits({ force: true }).catch(() => undefined)
        ctx.logger?.info?.(`dsh-reverse-proxy-connect: 已通过浏览器登录导入 ${provider} 账号「${label}」`)
      } catch (error) {
        job.phase = 'failed'
        job.message = `保存账号失败：${error instanceof Error ? error.message : String(error)}`
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 保存浏览器登录的账号失败', error)
      }
    }).catch((error) => {
      if (job.phase === 'done') return
      job.phase = 'failed'
      job.message = error instanceof Error ? error.message : String(error)
    })

    return { ...job }
  }

  /** 取消登录任务。 */
  function cancelLogin(provider) {
    const job = loginJobs.get(provider)
    if (job === undefined) return
    try {
      job.close?.()
    } catch {
      /* 已经结束的任务没有 close 也无所谓 */
    }
    job.phase = 'cancelled'
    job.message = '已取消'
    loginJobs.delete(provider)
  }

  /**
   * 跑一轮签到，把结果写进设置。
   *
   * 「一天最多一次」的判据是 `lastRunAt`：自动触发时 20 小时内不重复；
   * 用户手动点按钮则强制跑（`force: true`），签到接口本身是幂等的
   * （已签返回 `already`），多点一次不会出问题。
   *
   * @param options - `{ force?, provider? }`。
   * @returns 结果列表。
   */
  async function runCheckin(options = {}) {
    const current = settings()
    if (options.force !== true && current.checkin?.enabled === false) return []
    const lastRunAt = typeof current.checkin?.lastRunAt === 'number' ? current.checkin.lastRunAt : 0
    if (options.force !== true && Date.now() - lastRunAt < 20 * 3600_000) return []

    const targets = options.provider === undefined ? PROVIDER_IDS : [options.provider]
    const patch = { checkin: { results: {} } }
    const summary = []
    for (const provider of targets) {
      const { enabled } = providerOptions(current, provider)
      if (!enabled) continue
      try {
        const outcome = await runtime.runCheckin(provider)
        patch.checkin.results[provider] = outcome
        summary.push(outcome)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-reverse-proxy-connect: ${provider} 签到失败`, error)
      }
    }
    if (summary.length > 0) {
      patch.checkin.lastRunAt = Date.now()
      store.patch(patch)
      const total = summary.reduce((sum, item) => sum + item.credit, 0)
      ctx.logger?.info?.(
        `dsh-reverse-proxy-connect: 签到完成，${summary.map((item) => `${item.provider}=${String(item.claimed)}个账号/${String(item.credit)}分`).join('，')}（合计 ${String(total)} 分）`,
      )
    }
    return summary
  }

  /** POST /settings：写设置。必须带控制密钥。 */
  async function handleSettings(req, res, token) {
    if (!loopbackRequest(req)) {
      writeJson(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    if (!keyMatches(req.headers['x-rpc-key'], token)) {
      writeJson(res, 403, { error: 'invalid-key' })
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      writeJson(res, 413, { error: 'body-too-large' })
      return
    }
    let patch
    try {
      patch = JSON.parse(body === '' ? '{}' : body)
    } catch {
      writeJson(res, 400, { error: 'invalid-json' })
      return
    }
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      writeJson(res, 400, { error: 'invalid-patch' })
      return
    }
    store.patch(mergeAccountSecrets(sanitizePatch(patch), store.get()))
    bumpCatalog()
    void runtime.refreshAll().catch(() => undefined)
    writeJson(res, 200, await buildStatus())
  }

  /** POST /action：刷新目录、立刻用某个 provider 试一次。 */
  async function handleAction(req, res, token) {
    if (!loopbackRequest(req)) {
      writeJson(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    if (!keyMatches(req.headers['x-rpc-key'], token)) {
      writeJson(res, 403, { error: 'invalid-key' })
      return
    }
    const body = await readBody(req)
    let payload
    try {
      payload = JSON.parse(body === undefined || body === '' ? '{}' : body)
    } catch {
      writeJson(res, 400, { error: 'invalid-json' })
      return
    }
    if (payload?.action === 'login-start') {
      const started = startLogin(payload.provider)
      writeJson(res, 200, { login: started, status: await buildStatus() })
      return
    }
    if (payload?.action === 'login-cancel') {
      cancelLogin(payload.provider)
      writeJson(res, 200, await buildStatus())
      return
    }
    if (payload?.action === 'refresh') {
      await runtime.refreshAll()
      // 手动刷新顺带把额度也拉一遍（否则要等 2 分钟缓存过期）。
      await runtime.refreshAllCredits({ force: true })
      writeJson(res, 200, await buildStatus())
      return
    }
    if (payload?.action === 'credits') {
      await runtime.refreshAllCredits({ force: true })
      writeJson(res, 200, await buildStatus())
      return
    }
    if (payload?.action === 'checkin') {
      await runCheckin({ force: true, provider: typeof payload.provider === 'string' ? payload.provider : undefined })
      // 签到通常直接改变积分，顺手把额度也刷一遍。
      await runtime.refreshAllCredits({ force: true })
      writeJson(res, 200, await buildStatus())
      return
    }
    if (payload?.action === 'probe') {
      // 手动重探：清掉时间戳强制重跑，供「我刚升级了账号套餐」这类场景使用。
      store.patch({ probe: { lastRunAt: 0 } })
      await runtime.refreshAll()
      await runProbe()
      writeJson(res, 200, await buildStatus())
      return
    }
    writeJson(res, 400, { error: 'unknown-action' })
  }

  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => attachRoutes(webCtx))
    })
  } catch (error) {
    ctx.logger?.warn?.('dsh-reverse-proxy-connect: 无法挂载设置接口（没有 webServer 服务）', error)
  }

  ctx.logger?.info?.(`dsh-reverse-proxy-connect: 已注册 ${String(PROVIDER_IDS.length)} 个 provider 路由，数据目录 ${dataDir}`)
}

/** 只接受回环请求：Host 必须是回环地址，Origin（若有）也必须是回环。 */
function loopbackRequest(req) {
  const host = String(req.headers.host ?? '')
  if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host)) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  return /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin))
}

/** 常量时间比较控制密钥。 */
function keyMatches(given, expected) {
  if (typeof given !== 'string' || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

/** 读请求体，超限返回 undefined。 */
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_000_000) {
        resolve(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(undefined))
  })
}

/** 写 JSON 响应。 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** 只接受已知字段与已知类型，其余一律丢弃。 */
function sanitizePatch(patch) {
  const out = {}
  if (patch.providers !== null && typeof patch.providers === 'object' && !Array.isArray(patch.providers)) {
    const providers = {}
    for (const provider of PROVIDER_IDS) {
      const entry = patch.providers[provider]
      if (entry === null || typeof entry !== 'object') continue
      const row = {}
      if (typeof entry.enabled === 'boolean') row.enabled = entry.enabled
      if (Array.isArray(entry.disabledModels)) row.disabledModels = entry.disabledModels.filter((id) => typeof id === 'string').slice(0, 2000)
      if (Object.keys(row).length > 0) providers[provider] = row
    }
    if (Object.keys(providers).length > 0) out.providers = providers
  }
  if (patch.workbuddy !== null && typeof patch.workbuddy === 'object' && !Array.isArray(patch.workbuddy)) {
    const workbuddy = {}
    for (const variant of ['workbuddy', 'workbuddy-ai']) {
      const entry = patch.workbuddy[variant]
      if (entry === null || typeof entry !== 'object') continue
      const row = {}
      if (typeof entry.authFile === 'string') row.authFile = entry.authFile.slice(0, 1024)
      if (typeof entry.electronPath === 'string') row.electronPath = entry.electronPath.slice(0, 1024)
      if (typeof entry.useMaximumContext === 'boolean') row.useMaximumContext = entry.useMaximumContext
      if (Object.keys(row).length > 0) workbuddy[variant] = row
    }
    if (Object.keys(workbuddy).length > 0) out.workbuddy = workbuddy
  }
  if (patch.qoder !== null && typeof patch.qoder === 'object' && !Array.isArray(patch.qoder)) {
    const qoder = {}
    for (const provider of [PROVIDERS.qoder, PROVIDERS.qoderGlobal]) {
      const entry = patch.qoder[provider]
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.pat !== 'string') continue
      qoder[provider] = { pat: entry.pat.trim().slice(0, 4096) }
    }
    if (Object.keys(qoder).length > 0) out.qoder = qoder
  }
  // 账号池：客户端只能整体覆盖某个 provider 的账号列表（含新增/删除/改名）。
  if (patch.accounts !== null && typeof patch.accounts === 'object' && !Array.isArray(patch.accounts)) {
    const accounts = {}
    for (const provider of PROVIDER_IDS) {
      const list = patch.accounts[provider]
      if (!Array.isArray(list)) continue
      const rows = []
      for (let index = 0; index < list.length && rows.length < 20; index++) {
        const normalized = normalizeAccount(provider, list[index], rows.length)
        if (normalized === undefined) continue
        if (normalized.pat !== undefined) normalized.pat = normalized.pat.slice(0, 4096)
        if (normalized.authFile !== undefined) normalized.authFile = normalized.authFile.slice(0, 1024)
        rows.push(normalized)
      }
      accounts[provider] = rows
    }
    if (Object.keys(accounts).length > 0) out.accounts = accounts
  }
  if (patch.activeAccount !== null && typeof patch.activeAccount === 'object' && !Array.isArray(patch.activeAccount)) {
    const active = {}
    for (const provider of PROVIDER_IDS) {
      const id = patch.activeAccount[provider]
      if (typeof id === 'string' && id !== '') active[provider] = id.slice(0, 64)
    }
    if (Object.keys(active).length > 0) out.activeAccount = active
  }
  if (patch.autoSwitch !== null && typeof patch.autoSwitch === 'object' && !Array.isArray(patch.autoSwitch)) {
    if (typeof patch.autoSwitch.enabled === 'boolean') out.autoSwitch = { enabled: patch.autoSwitch.enabled }
  }
  // 手动覆盖「探测说不可用」的模型：卡片上用得到，是唯一允许客户端写的探测字段。
  if (patch.forcedModels !== null && typeof patch.forcedModels === 'object' && !Array.isArray(patch.forcedModels)) {
    const forced = {}
    for (const provider of PROVIDER_IDS) {
      const ids = patch.forcedModels[provider]
      if (!Array.isArray(ids)) continue
      forced[provider] = ids.filter((id) => typeof id === 'string').slice(0, 2000)
    }
    if (Object.keys(forced).length > 0) out.forcedModels = forced
  }
  // 探测开关（允许用户关掉自动探测，省额度）。
  if (patch.probe !== null && typeof patch.probe === 'object' && !Array.isArray(patch.probe)) {
    if (typeof patch.probe.enabled === 'boolean') out.probe = { enabled: patch.probe.enabled }
  }
  // 展示偏好。
  if (patch.display !== null && typeof patch.display === 'object' && !Array.isArray(patch.display)) {
    if (typeof patch.display.showRateInModelName === 'boolean') {
      out.display = { showRateInModelName: patch.display.showRateInModelName }
    }
  }
  return out
}

export { NAME, inject, PROVIDERS }
