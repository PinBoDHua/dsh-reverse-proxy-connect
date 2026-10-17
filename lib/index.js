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
 * ## 1.0.0 的新增面
 * - `GET /status?light=1`：侧栏小卡只要额度，不需要整份模型清单；
 * - `POST /action {action:"stats-reset"}`：清空用量统计；
 * - 状态文档升到 v4，带 `health` / `usage` / `host` 三块；
 * - 图片输入走宿主的 `attachments` 服务（模型声明 `inputModalities` 时才有）。
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
import { accountsFor, activeAccountFor, mergeAccountSecrets, newAccountId } from './accounts.js'
import { checkinDue, checkinTerminal } from './checkin-schedule.js'
import { patchNeedsRefresh, sanitizePatch } from './patch.js'
import { Runtime } from './runtime.js'
import { SettingsStore, advancedOptions, displayNameOf, isModelVisible, providerOptions } from './settings.js'
import { Stats, dayKey, statsPathOf } from './stats.js'
import {
  ACTION_PATH,
  DATA_DIR_ENV,
  DATA_DIR_NAME,
  PROVIDERS,
  PROVIDER_IDS,
  PROVIDER_META,
  SETTINGS_PATH,
  STATUS_PATH,
  STATUS_VERSION,
} from './protocol.js'
import { startBrowserLogin } from './workbuddy/browser-login.js'

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
  const bumpCatalog = () => {
    try {
      ctx.emit?.('llm/adapters-updated')
    } catch (error) {
      ctx.logger?.warn?.('dsh-reverse-proxy-connect: 无法广播模型目录更新', error)
    }
  }

  const stats = new Stats({
    filePath: statsPathOf(dataDir),
    enabled: () => advancedOptions(settings()).stats,
  })

  const runtime = new Runtime({
    settings,
    dataDir,
    logger: ctx.logger,
    stats,
    onCatalogChange: bumpCatalog,
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
    // 换号结果写回设置，重启后仍然生效；目录也要跟着换一份。
    onAccountSwitch: (provider, accountId) => {
      try {
        store.patch({ activeAccount: { [provider]: accountId } })
        bumpCatalog()
        void runtime.refresh(provider, { force: true })
          .then(() => bumpCatalog())
          .catch(() => undefined)
      } catch (error) {
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 保存自动切换的账号失败', error)
      }
    },
  })

  // 图片输入：附件服务是可选的，没挂载时模型只声明文本能力（宿主会把图换成
  // 文本占位符），绝不静默丢图。
  try {
    ctx.inject(['attachments'], (attCtx) => {
      try {
        const service = attCtx.attachments ?? attCtx.get?.('attachments')
        let fs
        try {
          fs = attCtx.fs ?? attCtx.get?.('fs')
        } catch {
          // fs 只是用来把只读路径映射到执行环境；没有它不影响读图。
          fs = undefined
        }
        if (service === undefined || service === null) return
        runtime.setAttachments(service, (hostPath) => {
          try {
            return fs?.processPathFromHostPath?.(hostPath)
          } catch {
            return undefined
          }
        })
        bumpCatalog()
        ctx.logger?.info?.('dsh-reverse-proxy-connect: 已接上附件服务，模型可以接收图片输入')
      } catch (error) {
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 初始化图片输入失败', error)
      }
    })
  } catch (error) {
    ctx.logger?.warn?.('dsh-reverse-proxy-connect: 无法注入附件服务（图片输入不可用）', error)
  }

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
      clearInterval(timer)
      stats.stop()
      runtime.flushCaches()
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

  /** 正在进行的浏览器登录任务，按 provider 存。 */
  const loginJobs = new Map()

  /**
   * 开始一次浏览器登录（WorkBuddy 官方的「插件登录」流程）。
   *
   * 流程：申请 state + authUrl → 交给系统浏览器 → 轮询换 token →
   * 读回账号信息 → 把令牌写进账号池并设为当前。
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
          targetAccount = { id: newAccountId(list), label, enabled: true, token: merged }
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
        void runtime.refresh(provider, { force: true }).then(() => bumpCatalog()).catch(() => undefined)
        void runtime.refreshCredits(provider, { force: true }).catch(() => undefined)
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
   * 调度判据是「本机日期」而不是「距上次 20 小时」：
   * 旧实现用 20 小时节流，昨天 23:00 签过的话，今天要等到 19:00 才会再自动签，
   * 实际上整天都错过了。现在每个 provider 独立记录 `completedOn`（本地日期），
   * 跨过午夜就会重新尝试；失败的 provider 10 分钟后重试，成功后当天不再重复。
   *
   * 签到接口本身是幂等的（已签返回 `already`），用户手动点按钮仍会强制跑。
   *
   * @param options - `{ force?, provider? }`。
   * @returns 结果列表。
   */
  async function runCheckin(options = {}) {
    const current = settings()
    const force = options.force === true
    if (!force && current.checkin?.enabled === false) return []
    const today = dayKey()
    const targets = options.provider === undefined ? PROVIDER_IDS : [options.provider]
    const completedOn = { ...(current.checkin?.completedOn ?? {}) }
    const lastAttemptAt = { ...(current.checkin?.lastAttemptAt ?? {}) }
    const patch = { checkin: { results: {}, completedOn, lastAttemptAt } }
    const summary = []
    const now = Date.now()

    for (const provider of targets) {
      const { enabled } = providerOptions(current, provider)
      if (!enabled) continue
      // 今天已经签完 / 失败后退避中 → 跳过。逻辑在纯函数里，方便单测跨午夜。
      if (!force && !checkinDue(current.checkin, provider, now)) continue

      try {
        const outcome = await runtime.runCheckin(provider)
        patch.checkin.results[provider] = outcome
        lastAttemptAt[provider] = now
        // 「已签 / 无活动 / 没有可签账号」都算今天结束；只有 failed 才重试。
        if (checkinTerminal(outcome)) completedOn[provider] = today
        summary.push(outcome)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-reverse-proxy-connect: ${provider} 签到失败`, error)
      }
    }

    if (summary.length > 0) {
      patch.checkin.lastRunAt = now
      store.patch(patch)
      const total = summary.reduce((sum, item) => sum + item.credit, 0)
      ctx.logger?.info?.(
        `dsh-reverse-proxy-connect: 签到完成，${summary.map((item) => `${item.provider}=${String(item.claimed)}个账号/${String(item.credit)}分`).join('，')}（合计 ${String(total)} 分）`,
      )
    }
    return summary
  }

  /**
   * 签到并（真的领到积分时）立刻刷新额度。
   *
   * 签到接口返回后上游账目不会瞬时一致，所以这里不并发、等签到完成再刷；
   * 没领到任何积分就不多打一轮额度请求。
   *
   * @param options - 同 `runCheckin()`。
   * @returns 签到汇总。
   */
  async function runCheckinAndCredits(options = {}) {
    const summary = await runCheckin(options)
    if (summary.some((item) => item.claimed > 0)) {
      await runtime.refreshAllCredits({ force: true }).catch((error) => {
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 签到后刷新额度失败', error)
      })
    }
    return summary
  }

  // ── 刷新调度 ────────────────────────────────────────────────────
  //
  // 用户可以在「高级」里改两个刷新间隔，所以不能再写死 `setInterval(10min)`。
  // 用一个 30 秒的节拍器检查「到点没有」，设置改了立刻生效，不需要重启插件。
  let lastCatalogAt = Date.now()
  let lastCreditsAt = Date.now()

  const tick = () => {
    if (runtime.stopped) return
    const current = settings()
    const advanced = advancedOptions(current)
    const now = Date.now()
    if (now - lastCatalogAt >= advanced.catalogRefreshMs) {
      lastCatalogAt = now
      void runtime.refreshAll().catch(() => undefined)
    }
    if (now - lastCreditsAt >= advanced.creditsRefreshMs) {
      lastCreditsAt = now
      void runtime.refreshAllCredits().catch(() => undefined)
    }
    // 内部按「本地日期 + 失败退避」判断，所以这里每 30 秒问一遍是安全的。
    // 领到积分时顺手刷一轮额度，数字下一帧就跟上。
    void runCheckinAndCredits().catch(() => undefined)
  }

  const timer = setInterval(tick, 30_000)
  timer.unref?.()

  // 首轮刷新：目录与额度**并行**起步。
  //
  // 额度快照在启动时已从磁盘恢复（`loadCreditsCache`），目录也会从
  // `catalog-cache` 恢复，所以即便这两次请求都要几秒，界面第一帧就有东西可显示。
  void Promise.allSettled([runtime.refreshAll({ force: true }), runtime.refreshAllCredits()]).then(([catalog]) => {
    lastCatalogAt = Date.now()
    lastCreditsAt = Date.now()
    if (catalog.status === 'fulfilled') {
      bumpCatalog()
      void runProbe()
      // 签到排在额度之后：领到的积分要能立刻体现在数字上。
      void runCheckinAndCredits().catch((error) => {
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 首轮签到失败', error)
      })
      return
    }
    ctx.logger?.warn?.('dsh-reverse-proxy-connect: 首次模型目录刷新失败', catalog.reason)
  })

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

  /** 解析请求 URL 上的查询参数。 */
  function queryOf(req) {
    try {
      return new URL(String(req.url ?? '/'), 'http://127.0.0.1').searchParams
    } catch {
      return new URLSearchParams()
    }
  }

  /** GET /status：只读，给卡片与侧栏小卡轮询。 */
  async function handleStatus(req, res) {
    if (!loopbackRequest(req)) {
      writeJson(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'GET') {
      writeJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    try {
      const document = await buildStatus({ light: queryOf(req).get('light') === '1' })
      writeJson(res, 200, document)
    } catch (error) {
      writeJson(res, 500, { error: 'status-failed', message: String(error) })
    }
  }

  /**
   * 组装状态文档。
   *
   * @param options - `{ light? }`。light 只给侧栏小卡用：不含模型清单、
   *   不含最近请求，体量从几十 KB 降到几 KB。
   * @returns 状态文档。
   */
  async function buildStatus(options = {}) {
    const light = options.light === true
    const current = settings()
    const advanced = advancedOptions(current)
    const usage = stats.snapshot()
    const today = dayKey()
    const providers = []
    for (const provider of PROVIDER_IDS) {
      const meta = PROVIDER_META[provider]
      const optionsOf = providerOptions(current, provider)
      const status = runtime.statusFor(provider)
      const activeAccount = activeAccountFor(provider, current)
      // 关闭的 provider 不做凭证探测：桌面端探测可能起子进程、Qoder 探测要网络，
      // 一个已经关掉的 provider 没理由每 20 秒再花这些成本。
      const credential = optionsOf.enabled
        ? await runtime.describeCredential(provider, activeAccount, current)
        : { status: 'disabled', reason: 'disabled', message: '该 provider 已在设置里关闭' }
      const accounts = accountsFor(provider, current).map((account) => ({
        id: account.id,
        label: account.label,
        enabled: account.enabled !== false,
        kind: meta.credentialKind,
        active: account.id === activeAccount.id,
        // 桌面账号的空路径表示「读本机登录」，所以类型上算已配置；
        // 真正是否登录成功看 credential.status。PAT 账号还要考虑环境变量兜底。
        configured: meta.credentialKind === 'desktop' ? true : account.pat !== undefined || credential.status === 'signed-in',
        authFile: meta.credentialKind === 'desktop' ? (account.authFile ?? '') : undefined,
        source: meta.credentialKind === 'desktop'
          ? account.token !== undefined ? 'browser-login' : 'desktop'
          : 'pat',
        credits: runtime.creditsFor(provider, account.id),
        usage: usage.accounts[`${provider}::${account.id}`] ?? undefined,
      }))
      const providerUsage = usage.providers[provider]
      const providerToday = usage.providerToday[provider]
      providers.push({
        provider,
        displayName: displayNameOf(provider),
        kind: meta.credentialKind,
        enabled: optionsOf.enabled,
        catalogSource: status.catalogSource,
        fetchedAt: status.fetchedAt,
        message: status.message,
        accountId: status.accountId,
        models: light ? undefined : runtime.modelsFor(provider).map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          supportsImages: model.supportsImages === true,
          supportsReasoning: model.supportsReasoning === true,
          reasoningEfforts: model.reasoningEfforts ?? [],
          credits: model.credits,
          disabled: optionsOf.disabled.has(model.id),
          // 「账号用不了」与「用户关掉了」是两件事，卡片要分开显示。
          unavailable: optionsOf.unavailable.has(model.id),
          forced: optionsOf.forced.has(model.id),
          virtual: model.virtual === true,
          fallback: model.fallback === true,
        })),
        modelCount: runtime.modelsFor(provider).length,
        // 额度与模型目录分开取：目录失败不代表额度读不到，反之亦然。
        credits: runtime.creditsFor(provider),
        accounts,
        // 签到：最近一次结果 + 是否开启 + 今天是否已经完成。界面据此显示
        // 「今日已签 / 可领 / 无活动 / 10 分钟后重试」。
        checkin: {
          enabled: current.checkin?.enabled !== false,
          lastRunAt: current.checkin?.lastRunAt ?? 0,
          completedOn: current.checkin?.completedOn?.[provider] ?? '',
          completedToday: current.checkin?.completedOn?.[provider] === today,
          lastAttemptAt: current.checkin?.lastAttemptAt?.[provider] ?? 0,
          result: current.checkin?.results?.[provider] ?? undefined,
        },
        // 「浏览器登录」任务的状态（只有桌面 provider 有）。
        login: loginJobs.get(provider) === undefined ? undefined : (({ close, ...rest }) => rest)(loginJobs.get(provider)),
        autoSwitch: current.autoSwitch?.enabled !== false,
        credential,
        health: usage.health[provider] ?? { state: 'unknown' },
        usage: light ? { today: providerToday } : { ...providerUsage, today: providerToday, last: usage.recent.find((entry) => entry.provider === provider) },
        images: runtime.canAcceptImages(),
      })
    }
    return {
      version: STATUS_VERSION,
      plugin: {
        name: NAME,
        version: VERSION,
        host: 'in-process',
        api: STATUS_VERSION,
        node: process.versions.node,
      },
      key: controlToken(),
      host: {
        images: runtime.canAcceptImages(),
        stats: advanced.stats,
        catalogCache: advanced.catalogCache,
      },
      providers,
      settings: {
        workbuddy: current.workbuddy,
        qoder: {
          [PROVIDERS.qoder]: {
            configured: (current.qoder?.[PROVIDERS.qoder]?.pat ?? '') !== ''
              || activeAccountFor(PROVIDERS.qoder, current).pat !== undefined,
          },
          [PROVIDERS.qoderGlobal]: {
            configured: (current.qoder?.[PROVIDERS.qoderGlobal]?.pat ?? '') !== ''
              || activeAccountFor(PROVIDERS.qoderGlobal, current).pat !== undefined,
          },
        },
        showRateInModelName: current.display?.showRateInModelName !== false,
        showUsageInSidebar: current.display?.showUsageInSidebar !== false,
        autoSwitch: current.autoSwitch?.enabled !== false,
        checkin: current.checkin?.enabled !== false,
        probe: current.probe?.enabled !== false,
        advanced,
      },
      probe: {
        enabled: current.probe?.enabled !== false,
        lastRunAt: current.probe?.lastRunAt ?? 0,
        results: current.probe?.results ?? {},
      },
      stats: light ? { today: usage.today, enabled: usage.enabled } : usage,
      proxy: { mode: 'in-process', prefix: 'provider-adapter' },
    }
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
    const sanitized = mergeAccountSecrets(sanitizePatch(patch), store.get())
    store.patch(sanitized)
    // PAT 换了，旧的 job token / 用户身份必须作废，否则新令牌首轮仍用旧身份。
    if (sanitized.qoder !== undefined) runtime.forgetIdentities()
    bumpCatalog()
    if (patchNeedsRefresh(sanitized)) {
      await Promise.allSettled([runtime.refreshAll({ force: true }), runtime.refreshAllCredits({ force: true })])
      bumpCatalog()
    }
    writeJson(res, 200, await buildStatus())
  }

  /** POST /action：刷新目录、签到、探测、登录、重置统计。 */
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
      await Promise.allSettled([runtime.refreshAll({ force: true }), runtime.refreshAllCredits({ force: true })])
      lastCatalogAt = Date.now()
      lastCreditsAt = Date.now()
      writeJson(res, 200, await buildStatus())
      return
    }
    if (payload?.action === 'credits') {
      await runtime.refreshAllCredits({ force: true })
      lastCreditsAt = Date.now()
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
      await runtime.refreshAll({ force: true })
      await runProbe()
      writeJson(res, 200, await buildStatus())
      return
    }
    if (payload?.action === 'stats-reset') {
      stats.reset()
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

  ctx.logger?.info?.(
    `dsh-reverse-proxy-connect: v${VERSION} 已注册 ${String(PROVIDER_IDS.length)} 个 provider 路由，数据目录 ${dataDir}${runtime.canAcceptImages() ? '（图片输入已启用）' : ''}`,
  )
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
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // 状态里含控制密钥与实时额度，绝不能进浏览器缓存。
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

export { NAME, inject, PROVIDERS }
