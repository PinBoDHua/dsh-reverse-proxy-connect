/**
 * dsh-reverse-proxy-connect —— 把 WorkBuddy（国内版 / 国际版）、Qoder
 * （全球版 / 国内版）与 Trae（国内版 / 国际版）账号里的模型接进 DeepSeek Harness。
 *
 * ## 与上游两个插件的区别
 * `dsh-workbuddy-connect` 和 `dsh-qoder-connect` 各是一个插件、各起一个本地
 * 回环服务、各自 import `@earendil-works/pi-ai` 与 `@deepseek-ai/dsh-llm-pi-ai`。
 * 本插件把六家合成一个：
 *
 * - **不导入 pi-ai**，直接实现 DSH 公开的 `LlmAdapter`（见 lib/adapter.js）；
 * - **不起回环 HTTP 服务**，上游请求直接从宿主进程发出，少一层本地 socket；
 * - **六个 provider**（`workbuddy` / `workbuddy-ai` / `qoder` / `qoder-global` /
 *   `trae` / `trae-global`）共用一个适配器、一份目录缓存、一张设置卡片。
 *
 * ## 1.3.0 的新增面
 * - Qoder Free 的 0 在所有位置统一按 Free 处理（颜色 / 换号 / CLI）；
 * - 流式终态修复：usage 不再落在 finish 之后、取消不被记成成功；
 * - `stats.json` v3：按 provider 的每日与会话维度；
 * - 设置文件支持 BOM/UTF-16、坏文件备份、写失败回滚、跨进程先读后写。
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
import { accountsFor, activeAccountFor, applyCredentialRefresh, applyLoginAccount, mergeAccountSecrets } from './accounts.js'
import { checkinCompleted, checkinDue, checkinReopenPatch, checkinTerminal } from './checkin-schedule.js'
import { buildDiagnostics } from './diagnostics.js'
import { EventLog, eventsPathOf, scrubSecretText } from './events.js'
import { credentialProvidersOf, patchNeedsRefresh, sanitizePatch } from './patch.js'
import { creditsAlertOf } from './quota.js'
import { Runtime } from './runtime.js'
import { SettingsStore, advancedOptions, displayNameOf, isModelVisible, providerOptions } from './settings.js'
import { Stats, dayKey, statsPathOf } from './stats.js'
import {
  ACTION_PATH,
  DATA_DIR_ENV,
  DATA_DIR_NAME,
  DIAGNOSTICS_PATH,
  PROVIDERS,
  PROVIDER_IDS,
  PROVIDER_META,
  REQUEST_BODY_LIMIT,
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

/**
 * 轻量状态里每条趋势折线保留的原始点数。
 *
 * 侧栏小卡画的是 100×24 的迷你折线，60 个点里后 20 个的形状已经看不出区别；
 * 但 6 个 provider × 60 个点占了整份轻量响应将近一半（实测 25.7KB 里的 11KB）。
 * 只裁 `light` 那一份，卡片拿到的仍是完整历史。
 */
const LIGHT_TREND_POINTS = 20

/** 完整状态里下发的最近事件条数。 */
const EVENT_LIST_LIMIT = 50

/**
 * 同一份状态的最短复用时间。
 *
 * 卡片 20 秒轮询、侧栏 60 秒轮询、手动刷新与设置保存后的回读很容易在
 * 同一秒内撞在一起；每次都重新做一遍凭据探测没有意义。缓存只保留
 * 750ms，且所有写操作都会显式失效，所以不会让界面看到过期的写入结果。
 */
const STATUS_CACHE_MS = 750

/**
 * 只保留趋势折线的最后 `count` 个点（其余字段原样）。
 *
 * 纯函数：坏输入（undefined / 不是对象 / points 不是数组）原样返回，
 * 侧栏小卡自己会按 `safeArray` 兜底。
 *
 * @param trend - `credits.trend`。
 * @param count - 保留点数。
 * @returns 裁剪后的趋势。
 */
export function thinTrend(trend, count) {
  if (trend === null || typeof trend !== 'object' || !Array.isArray(trend.points)) return trend
  if (!Number.isFinite(count) || count <= 0) return { ...trend, points: [] }
  if (trend.points.length <= count) return trend
  return { ...trend, points: trend.points.slice(-count) }
}

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
  if (store.loadError !== undefined) {
    ctx.logger?.warn?.(
      `dsh-reverse-proxy-connect: settings.json 读取失败（${store.loadError}）；已使用默认值${
        store.corruptPath === undefined ? '' : `，原文件备份在 ${store.corruptPath}`
      }。请检查该文件，避免下一次保存覆盖原设置。`,
    )
  }
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

  /**
   * 事件账本：回答「刚才为什么换号了 / 额度什么时候开始读不到的」。
   *
   * 只记元数据，最多 200 条；磁盘上只留 100 条。写失败不影响聊天。
   */
  const events = new EventLog({ filePath: eventsPathOf(dataDir), logger: ctx.logger })

  const runtime = new Runtime({
    settings,
    dataDir,
    logger: ctx.logger,
    stats,
    events,
    onCatalogChange: bumpCatalog,
    // 浏览器登录拿到的令牌会过期，续期成功后写回账号，避免每次请求都重刷。
    onCredentialRefreshed: (provider, accountId, token) => {
      if (runtime.stopped === true) return
      try {
        // 只 upsert 这一个账号的 token：续期发生在请求路径上，拿内存里的账号表
        // 整份写回会把并发新增的账号 / 别的账号刚续期的令牌一起覆盖掉。
        applyCredentialRefresh(store, provider, accountId, token)
      } catch (error) {
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 写回续期令牌失败', error)
      }
    },
    // 换号结果写回设置，重启后仍然生效；目录也要跟着换一份。
    onAccountSwitch: (provider, accountId) => {
      if (runtime.stopped === true) return
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
    // 适配器用这个判断能不能声明 image 模态；漏掉它时所有模型都会退化成纯文本，
    // 宿主会在附件准入阶段直接拒绝图片（MODEL_DOES_NOT_SUPPORT_IMAGES）。
    canAcceptImages: () => runtime.canAcceptImages(),
    showRateInModelName: () => settings().display?.showRateInModelName !== false,
  })

  // 六个 provider 一次性注册；一个 adapter 实例拥有全部路由。
  const releaseAdapter = ctx.llm.registerAdapter(PROVIDER_IDS, adapter)
  try {
    ctx.effect(() => () => {
      releaseAdapter()
      runtime.stopped = true
      probeAbort?.abort()
      // 浏览器登录最长等 5 分钟；卸载后不能再让旧实例把账号写回设置。
      for (const job of loginJobs.values()) {
        job.cancelled = true
        try {
          job.close?.()
        } catch {
          /* 已经结束的任务 */
        }
      }
      loginJobs.clear()
      checkinAbort?.abort()
      clearInterval(timer)
      stats.stop()
      runtime.flushCaches()
      events.stop()
    })
  } catch (error) {
    releaseAdapter()
    throw error
  }

  const swept = runtime.sweptTempFiles?.removed ?? 0
  events.record({
    type: 'startup',
    message: `插件 v${VERSION} 已启动，${String(PROVIDER_IDS.length)} 个 provider${swept > 0 ? `，清理 ${String(swept)} 个中断写入的临时文件` : ''}`,
    messageKey: { key: 'eventStartup', params: { version: VERSION, providers: PROVIDER_IDS.length, swept } },
    data: { version: VERSION, node: process.versions.node, ...(swept > 0 ? { sweptTempFiles: swept } : {}) },
  })

  /** 能力探测的取消句柄；provider 集合重载时重建。 */
  let probeAbort

  /** 正在跑能力探测：启动与手动重探可能同时触发，绝不能让两轮交错写结果。 */
  let probeRunning = false

  /** 当前这一轮的 promise；force 请求要等它结束后补跑，而不是静默丢弃。 */
  let probeTask

  /**
   * 后台跑一轮能力探测，把账号用不了的模型写入 `unavailableModels`。
   *
   * 只做一次「每 provider 每 6 小时」，避免每次启动都烧一遍额度：探测用的是
   * `max_tokens: 1`，但仍然是真实计费请求。
   *
   * 并发语义与目录/额度刷新一致：
   * - 后台那一轮在跑时，普通的定时触发直接跳过（返回 false）；
   * - **手动「检测账号可用模型」带了 force**：等这一轮结束后补跑一轮，
   *   而不是静默什么都不做 —— 否则用户点了按钮、界面却毫无变化。
   *
   * @param options - `{ force? }`。
   * @returns 是否真的跑了一轮。
   */
  const runProbe = async (options = {}) => {
    if (runtime.stopped === true) return false
    if (probeRunning) {
      if (options.force !== true) return false
      // 等当前这一轮结束，再决定要不要补跑。
      await (probeTask ?? Promise.resolve()).catch(() => undefined)
      if (probeRunning) return false
    }
    const current = settings()
    if (current.probe?.enabled === false && options.force !== true) return false
    const lastRunAt = typeof current.probe?.lastRunAt === 'number' ? current.probe.lastRunAt : 0
    // force 不受 6 小时节流约束（调用方已经显式清过时间戳，这里再兜一层）。
    if (options.force !== true && Date.now() - lastRunAt < 6 * 3600_000) return false
    probeRunning = true
    probeTask = (async () => {
      probeAbort?.abort()
      probeAbort = new AbortController()
      const patch = { unavailableModels: {}, probe: { results: {} } }
      let attempted = 0
      let succeeded = 0
      for (const provider of PROVIDER_IDS) {
        const { enabled } = providerOptions(settings(), provider)
        if (!enabled) {
          // 没启用就保持原样，别把上一次的结论清空（用户可能只是临时关掉）。
          patch.unavailableModels[provider] = settings().unavailableModels?.[provider] ?? []
          continue
        }
        attempted++
        try {
          // 探测要跑几十秒；期间自动换号 / 用户手动切账号都可能改变「当前账号」。
          // 结论必须只对**发起时**那个账号成立，否则 B 的结论会被记成 A 的，
          // 而 providerOptions() 只在账号一致时才套用 unavailableModels。
          const probedAccountId = activeAccountFor(provider, settings()).id
          const outcome = await runtime.probeProvider(provider, {
            signal: probeAbort.signal,
            accountId: probedAccountId,
          })
          succeeded++
          patch.unavailableModels[provider] = outcome.unavailable
          // 结论只对探测时的那个账号成立：记下账号 id，切号后不再套用（见 providerOptions）。
          patch.probe.results[provider] = {
            probed: outcome.probed,
            unavailable: outcome.unavailable.length,
            accountId: probedAccountId,
            at: Date.now(),
          }
        } catch (error) {
          ctx.logger?.warn?.(`dsh-reverse-proxy-connect: ${provider} 能力探测失败`, error)
          // 探测本身失败时保留旧结论，不要退化成「全部不可用」或「全部可用」。
          patch.unavailableModels[provider] = settings().unavailableModels?.[provider] ?? []
        }
      }
      if (attempted === 0) return
      if (probeAbort.signal.aborted || runtime.stopped === true) return
      // 只有真的跑成至少一家才推后 6 小时；全失败时 10 分钟后允许重试，
      // 否则一次离线启动会把下次探测压到 6 小时后。
      patch.probe.lastRunAt = succeeded > 0
        ? Date.now()
        : Date.now() - 6 * 3600_000 + 10 * 60_000
      store.patch(patch)
      bumpCatalog()
      ctx.logger?.info?.(
        `dsh-reverse-proxy-connect: 能力探测完成，${PROVIDER_IDS.map((provider) => `${provider}=${String(patch.unavailableModels[provider]?.length ?? 0)} 不可用`).join('，')}`,
      )
    })()
    try {
      await probeTask
      return true
    } finally {
      probeRunning = false
      probeTask = undefined
    }
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
      // Trae 的登录是客户端自己的 OAuth（带设备指纹与签名），插件不重放它；
      // 用户只要在 Trae 里登录过，插件就能直接读那份登录态。
      return {
        phase: 'failed',
        message: provider === PROVIDERS.trae || provider === PROVIDERS.traeGlobal
          ? 'Trae 不需要单独登录：先在 Trae 客户端里登录一次，插件会直接读取本机登录态'
          : '只有 WorkBuddy 支持浏览器登录；Qoder 请直接粘贴 PAT',
      }
    }
    const existing = loginJobs.get(provider)
    if (existing !== undefined && existing.phase !== 'done' && existing.phase !== 'failed' && existing.phase !== 'cancelled') {
      return { ...existing }
    }

    const variantId = provider === PROVIDERS.workbuddy ? 'workbuddy' : 'workbuddy-ai'
    const job = { phase: 'starting', message: '正在申请登录地址…', startedAt: Date.now(), cancelled: false }

    const controller = startBrowserLogin({
      variantId,
      spawn,
      onUpdate: (patch) => {
        Object.assign(job, patch)
        if (patch.phase === 'waiting') bumpCatalog()
      },
    })
    loginJobs.set(provider, Object.assign(job, { close: () => controller.close() }))
    events.record({
      type: 'login',
      provider,
      message: '已开始浏览器登录',
      messageKey: { key: 'eventLoginStarted' },
    })

    controller.result.then(({ token, account, label }) => {
      // 用户已经取消：令牌即使刚好换到也不能再写账号池，否则「取消」会变成
      // 「过了一会儿账号自己出现了」。
      if (job.cancelled === true || runtime.stopped === true) return
      try {
        // 同一个 uid 再登录：更新令牌即可，不重复添加账号。
        const merged = {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAtMs: token.expiresAtMs,
          refreshExpiresAtMs: token.refreshExpiresAtMs,
          domain: token.domain,
          uid: account.uid,
          enterpriseId: account.enterpriseId,
        }
        // 必须走 accounts.js 的「写锁内先读最新、再 upsert 这一个账号」：
        // 旧实现是 `store.sync()` 出来的整份账号表 → `store.patch()` 整表替换，
        // 两步之间另一个进程（CLI 的 login / 令牌续期）写入的账号会被静默覆盖
        // —— 与 /settings 路由同一个坑（那里已经改成写锁内合并）。
        const targetAccountId = applyLoginAccount(store, provider, { uid: account.uid, label, token: merged })
        job.phase = 'done'
        job.message = `登录成功：${label}`
        job.uid = account.uid
        bumpCatalog()
        void runtime.refresh(provider, { force: true }).then(() => bumpCatalog()).catch(() => undefined)
        void runtime.refreshCredits(provider, { force: true }).catch(() => undefined)
        // 新账号当天也可能有签到奖励：账号集合变了，checkinDue 会判成「未完成」。
        void runCheckinAndCredits({ provider }).catch((error) => {
          ctx.logger?.warn?.('dsh-reverse-proxy-connect: 登录后签到失败', error)
        })
        ctx.logger?.info?.(`dsh-reverse-proxy-connect: 已通过浏览器登录导入 ${provider} 账号「${label}」`)
        events.record({
          type: 'login',
          provider,
          accountId: targetAccountId,
          message: `浏览器登录成功，已导入账号「${label}」`,
          messageKey: { key: 'eventLoginImported', params: { label } },
          data: { uid: account.uid },
        })
      } catch (error) {
        job.phase = 'failed'
        job.message = `保存账号失败：${error instanceof Error ? error.message : String(error)}`
        events.record({
          type: 'login',
          level: 'error',
          provider,
          message: job.message,
          messageKey: {
            key: 'eventLoginSaveFailed',
            params: { reason: error instanceof Error ? error.message : String(error) },
          },
        })
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 保存浏览器登录的账号失败', error)
      }
    }).catch((error) => {
      if (job.phase === 'done' || job.cancelled === true) return
      job.phase = 'failed'
      job.message = error instanceof Error ? error.message : String(error)
      events.record({
        type: 'login',
        level: 'error',
        provider,
        message: `浏览器登录失败：${job.message}`,
        messageKey: {
          key: 'eventLoginFailed',
          params: { reason: error instanceof Error ? error.message : String(error) },
        },
      })
    })

    return { ...job }
  }

  /** 取消登录任务。 */
  function cancelLogin(provider) {
    const job = loginJobs.get(provider)
    if (job === undefined) return
    job.cancelled = true
    try {
      job.close?.()
    } catch {
      /* 已经结束的任务没有 close 也无所谓 */
    }
    job.phase = 'cancelled'
    job.message = '已取消'
    loginJobs.delete(provider)
    events.record({
      type: 'login',
      level: 'warn',
      provider,
      message: '已取消浏览器登录',
      messageKey: { key: 'eventLoginCancelled' },
    })
  }

  /** 正在跑签到：调度器 30 秒一拍，绝不能重叠（上游是幂等的，但没必要打两遍）。 */
  let checkinRunning = false
  /** 当前这一轮的 promise；force 请求要等它结束后补跑，而不是静默返回空数组。 */
  let checkinTask
  /** 当前这一轮签到的取消句柄；插件卸载时 abort。 */
  let checkinAbort

  /**
   * 跑一轮签到（并发保护入口）。
   *
   * 并发语义与目录/额度/探测刷新一致：
   * - 自动调度撞上正在跑的一轮（或失败退避中）直接跳过；
   * - **手动「立即签到」带 force**：等这一轮结束后补跑，而不是静默返回空数组 ——
   *   否则用户点了按钮、界面照样刷新、却一次签到都没跑，完全没有提示。
   *
   * @param options - `{ force?, provider? }`。
   * @returns 结果列表。
   */
  async function runCheckin(options = {}) {
    if (checkinRunning) {
      if (options.force !== true) return []
      // 等当前这一轮结束，再决定要不要补跑。
      await (checkinTask ?? Promise.resolve()).catch(() => undefined)
      if (checkinRunning) return []
    }
    checkinRunning = true
    const controller = new AbortController()
    checkinAbort = controller
    checkinTask = runCheckinInner({ ...options, signal: controller.signal })
    try {
      return await checkinTask
    } finally {
      checkinRunning = false
      checkinTask = undefined
      if (checkinAbort === controller) checkinAbort = undefined
    }
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
  async function runCheckinInner(options = {}) {
    // 必须用 sync()：CLI 可能刚写入今天的签到日期，拿内存旧快照会把新值覆盖回去。
    const current = store.sync()
    const force = options.force === true
    if (!force && current.checkin?.enabled === false) return []
    const today = dayKey()
    const targets = options.provider === undefined ? PROVIDER_IDS : [options.provider]
    /**
     * 只提交这次真正碰过的 provider。
     *
     * 以前把 completedOn/accountIds/lastAttemptAt 整份复制进 patch：另一个进程
     * （CLI 或第二个窗口）刚写的日期会被内存里的旧值覆盖，同一天重复签到。
     */
    const checkinPatch = { results: {} }
    const summary = []
    const now = Date.now()
    let attempted = false

    for (const provider of targets) {
      const { enabled } = providerOptions(current, provider)
      if (!enabled) continue
      // 账号集合参与判据：当天新增/新启用的账号不能被「provider 今天已签」漏掉。
      const providerAccountIds = accountsFor(provider, current)
        .filter((account) => account.enabled !== false)
        .map((account) => account.id)
        .sort()
      // 今天已经签完 / 失败后退避中 → 跳过。逻辑在纯函数里，方便单测跨午夜。
      if (!force && !checkinDue(current.checkin, provider, now, providerAccountIds)) continue
      attempted = true

      try {
        const outcome = await runtime.runCheckin(provider, { signal: options.signal })
        checkinPatch.results[provider] = outcome
        checkinPatch.lastAttemptAt ??= {}
        checkinPatch.lastAttemptAt[provider] = now
        // 「已签 / 无活动 / 没有可签账号」都算今天结束；只有 failed 才重试。
        // `unconfigured`（账号没登录/没配 PAT）是已知状态而不是失败：把它排除后
        // 再判终态，否则一个没配置的账号会让调度器每 10 分钟重试一次、天天刷 warn。
        const settled = outcome.outcomes.filter((item) => item.kind !== 'unconfigured')
        if (checkinTerminal({ ...outcome, outcomes: settled })) {
          checkinPatch.completedOn ??= {}
          checkinPatch.completedOn[provider] = today
          checkinPatch.accountIds ??= {}
          checkinPatch.accountIds[provider] = providerAccountIds
        }
        summary.push(outcome)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 运行时内部一般会把失败收敛成 outcome；这里是兜底（例如读设置/凭证
        // 直接抛错）。必须写 lastAttemptAt，否则调度器每 30 秒就会重撞一次，
        // 既不是「10 分钟后重试」，也会把上游日志刷满。
        checkinPatch.results[provider] = {
          provider,
          claimed: 0,
          credit: 0,
          outcomes: [{ accountId: '*', label: '全部账号', kind: 'failed', message }],
          at: now,
        }
        checkinPatch.lastAttemptAt ??= {}
        checkinPatch.lastAttemptAt[provider] = now
        ctx.logger?.warn?.(`dsh-reverse-proxy-connect: ${provider} 签到失败`, error)
      }
    }

    if (attempted) {
      // 卸载/取消后可能还有一轮进行中的签到：不要再写设置。
      if (runtime.stopped || options.signal?.aborted === true) return summary
      checkinPatch.lastRunAt = now
      try {
        store.patch({ checkin: checkinPatch })
      } catch (error) {
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 签到结果写入设置失败', error)
      }
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
    if (summary.some((item) => item.claimed > 0) && runtime.stopped !== true) {
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
    // 能力探测每 6 小时最多一轮（runProbe 内部判时间戳）。以前只在启动时
    // 跑一次，README 写的「每 6 小时」实际上永远不会发生。
    void runProbe().catch(() => undefined)
  }

  const timer = setInterval(tick, 30_000)
  timer.unref?.()

  // 首轮刷新：目录与额度**并行**起步。
  //
  // 额度快照在启动时已从磁盘恢复（`loadCreditsCache`），目录也会从
  // `catalog-cache` 恢复，所以即便这两次请求都要几秒，界面第一帧就有东西可显示。
  void Promise.allSettled([runtime.refreshAll({ force: true }), runtime.refreshAllCredits()]).then(([catalog]) => {
    if (runtime.stopped === true) return
    lastCatalogAt = Date.now()
    lastCreditsAt = Date.now()
    const results = catalog.status === 'fulfilled' && Array.isArray(catalog.value) ? catalog.value : []
    // `refreshAll` 不 reject：它返回每家 provider 的结果对象。用「至少一家
    // 真的拿到可用目录」判断，而不是看 Promise 是否 fulfilled —— 六家全失败
    // 也是 fulfilled，随后探测只会对着内置兜底模型空跑。
    const usable = results.some((result) => result !== null && typeof result === 'object' && result.status === 'signed-in')
    if (catalog.status === 'fulfilled') {
      bumpCatalog()
      if (usable) {
        void runProbe().catch((error) => {
          ctx.logger?.warn?.('dsh-reverse-proxy-connect: 首轮能力探测失败', error)
        })
      } else {
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 首轮所有 provider 都没有可用目录，跳过能力探测')
      }
      // 签到与目录无关：凭证可能仍然有效，只是目录端点临时不可用。
      void runCheckinAndCredits().catch((error) => {
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 首轮签到失败', error)
      })
      return
    }
    ctx.logger?.warn?.('dsh-reverse-proxy-connect: 首次模型目录刷新失败', catalog.reason)
  })

  /** 把异步路由的异常收敛成 500，避免未处理的 rejection 让请求悬着。 */
  const safeRoute = (handler) => (req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 请求处理失败', error)
        if (res.headersSent === true) {
          try {
            res.end()
          } catch {
            /* 已经断开 */
          }
          return
        }
        try {
          // 不把异常原文回给浏览器：里面可能有本机路径 / 上游细节。详细原因
          // 只写宿主日志。
          writeJson(res, 500, { error: 'request-failed' })
        } catch {
          /* 响应已经不可写 */
        }
      })
  }

  // ── 设置卡片用的同源接口 ──────────────────────────────────────────
  const attachRoutes = (webCtx) => {
    const token = controlToken()
    const disposeStatus = webCtx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: safeRoute((req, res) => handleStatus(req, res)),
    })
    const disposeSettings = webCtx.webServer.register({
      kind: 'exact',
      path: SETTINGS_PATH,
      handler: safeRoute((req, res) => handleSettings(req, res, token)),
    })
    const disposeAction = webCtx.webServer.register({
      kind: 'exact',
      path: ACTION_PATH,
      handler: safeRoute((req, res) => handleAction(req, res, token)),
    })
    const disposeDiagnostics = webCtx.webServer.register({
      kind: 'exact',
      path: DIAGNOSTICS_PATH,
      handler: safeRoute((req, res) => handleDiagnostics(req, res)),
    })
    return () => {
      disposeStatus()
      disposeSettings()
      disposeAction()
      disposeDiagnostics()
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

  /** 状态文档的短缓存：并发请求合并成一次构建。 */
  const statusCache = new Map()
  const invalidateStatus = () => statusCache.clear()

  /**
   * 拿一份（可能复用的）状态文档。
   *
   * @param options - `{ light? }`。
   * @returns 状态文档 promise。
   */
  function statusDocument(options = {}) {
    const key = options.light === true ? 'light' : 'full'
    const hit = statusCache.get(key)
    const now = Date.now()
    if (hit !== undefined && now - hit.at < STATUS_CACHE_MS) return hit.promise
    const promise = buildStatus(options)
    const entry = { at: now, promise }
    statusCache.set(key, entry)
    // 构建失败不要把 rejection 缓存在 map 里（下一次请求应该重试）。
    promise.catch(() => {
      if (statusCache.get(key) === entry) statusCache.delete(key)
    })
    return promise
  }

  /** GET /status：只读，给卡片与侧栏小卡轮询。 */
  async function handleStatus(req, res) {
    if (!loopbackRequest(req)) {
      writeJson(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      writeJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    try {
      const document = await statusDocument({ light: queryOf(req).get('light') === '1' })
      writeJson(res, 200, document)
    } catch (error) {
      ctx.logger?.warn?.('dsh-reverse-proxy-connect: 组装状态失败', error)
      writeJson(res, 500, { error: 'status-failed' })
    }
  }

  /** GET /diagnostics：只读、脱敏，供「复制诊断」与 issue 使用。 */
  async function handleDiagnostics(req, res) {
    if (!loopbackRequest(req)) {
      writeJson(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      writeJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    try {
      const { document, text } = buildDiagnostics(await statusDocument())
      if (queryOf(req).get('format') === 'text') {
        writeText(res, 200, text)
        return
      }
      writeJson(res, 200, document)
    } catch (error) {
      ctx.logger?.warn?.('dsh-reverse-proxy-connect: 生成诊断失败', error)
      writeJson(res, 500, { error: 'diagnostics-failed' })
    }
  }

  /**
   * 组装状态文档。
   *
   * @param options - `{ light? }`。light 只给侧栏小卡用：不含模型清单、
   *   不含最近请求，趋势折线也只留最后几个点。
   * @returns 状态文档。
   */
  async function buildStatus(options = {}) {
    const light = options.light === true
    // 先合并磁盘上的外部修改：CLI 新登录的账号、手改的设置与损坏提示都能
    // 在下一次轮询里反映出来，而不是等进程重启。
    const current = store.sync()
    const advanced = advancedOptions(current)
    const usage = stats.snapshot()
    const providers = []
    /** 本轮已经探测过的凭证状态：设置区要复用它，不能再探一次。 */
    const credentials = {}
    // 六家的凭证探测互不依赖（读不同文件 / 不同账号），串行 await 会让
    // 冷启动的首个 /status 把六家的耗时相加：桌面端要解密登录文件、Qoder 要
    // 换一次 job token。先并发探测，再按 PROVIDER_IDS 原顺序组装，响应里的
    // 顺序与内容都不变，只是把「相加」变成「取最大」。
    const probeTargets = PROVIDER_IDS.map((provider) => {
      const optionsOf = providerOptions(current, provider)
      return {
        provider,
        enabled: optionsOf.enabled,
        account: activeAccountFor(provider, current),
      }
    })
    const probed = await Promise.all(probeTargets.map((target) => {
      // 关闭的 provider 不做凭证探测：桌面端探测可能起子进程、Qoder 探测要网络，
      // 一个已经关掉的 provider 没理由每 20 秒再花这些成本。
      if (!target.enabled) {
        return Promise.resolve({ status: 'disabled', reason: 'disabled', message: '该 provider 已在设置里关闭' })
      }
      return runtime.describeCredential(target.provider, target.account, current)
    }))
    probeTargets.forEach((target, index) => {
      credentials[target.provider] = probed[index]
    })
    for (const provider of PROVIDER_IDS) {
      const meta = PROVIDER_META[provider]
      const optionsOf = providerOptions(current, provider)
      const status = runtime.statusFor(provider)
      const activeAccount = activeAccountFor(provider, current)
      const credential = credentials[provider]
      const credits = runtime.creditsFor(provider)
      const alert = creditsAlertOf(credits, current.alerts, provider)
      const accounts = accountsFor(provider, current).map((account) => {
        // light 只给侧栏小卡用：它只读「哪个账号是当前账号」和 label，
        // 每个账号的额度/用量/冷却/最近测试全是卡片才用的。
        // 侧栏每 60 秒轮询一次，这些字段占整份轻量响应三分之一以上。
        if (light) {
          return {
            id: account.id,
            label: account.label,
            // 隐式默认账号的名字是插件生成的（「本机登录」/「默认令牌」）：
            // 带上文案键，英文界面才能显示英文。用户自己起的名字没有键。
            ...(account.labelKey === undefined ? {} : { labelKey: account.labelKey }),
            enabled: account.enabled !== false,
            kind: meta.credentialKind,
            active: account.id === activeAccount.id,
          }
        }
        const accountCredits = runtime.creditsFor(provider, account.id)
        return {
          id: account.id,
          label: account.label,
          ...(account.labelKey === undefined ? {} : { labelKey: account.labelKey }),
          enabled: account.enabled !== false,
          kind: meta.credentialKind,
          active: account.id === activeAccount.id,
          // 桌面账号的空路径表示「读本机登录」，所以类型上算已配置；
          // 真正是否登录成功看 credential.status。
          //
          // credential 只探测了**当前账号**：只有它才能用「已登录」兜底
          // （例如默认 PAT 来自环境变量）。其它账号必须自带 pat / token，
          // 否则卡片会把一个请求必然失败的账号显示成「已配置」。
          configured: meta.credentialKind === 'pat'
            ? account.pat !== undefined
              || (account.id === activeAccount.id && credential.status === 'signed-in')
            : meta.credentialKind === 'desktop-auth'
              // Trae 的每账号登录文件路径本身就是「已配置」的证据（凭证由客户端
              // 维护，账号行里本来就没有 token）。只看当前账号的探测结果会把
              // 其它账号显示成未配置，连测试按钮都被禁用。
              ? account.token !== undefined
                || (typeof account.authFile === 'string' && account.authFile !== '')
                || (account.id === activeAccount.id && credential.status === 'signed-in')
              : true,
          authFile: meta.credentialKind === 'pat' ? undefined : (account.authFile ?? ''),
          source: meta.credentialKind === 'pat'
            ? 'pat'
            : account.token !== undefined ? 'browser-login' : 'desktop',
          credits: { ...accountCredits, alert: creditsAlertOf(accountCredits, current.alerts, provider) },
          usage: usage.accounts[`${provider}::${account.id}`] ?? undefined,
          cooldownUntil: runtime.cooldownUntil(provider, account.id),
          lastTest: runtime.lastTestFor(provider, account.id),
          modelTests: light ? undefined : runtime.modelTestsFor(provider, account.id),
        }
      })
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
        //
        // light 只给侧栏小卡用：它画的是 100px 宽的迷你折线，60 个原始点里
        // 后 20 个已经够用了。整份轻量响应 25KB 里有 11KB 是这几条折线的
        // 原始点，砍到 20 个之后体积少了将近一半，而画出来的形状看不出区别。
        credits: { ...credits, trend: light ? thinTrend(credits.trend, LIGHT_TREND_POINTS) : credits.trend, alert },
        accounts,
        // 签到：最近一次结果 + 是否开启 + 今天是否已经完成。界面据此显示
        // 「今日已签 / 可领 / 无活动 / 10 分钟后重试」。
        checkin: {
          enabled: current.checkin?.enabled !== false,
          lastRunAt: current.checkin?.lastRunAt ?? 0,
          completedOn: current.checkin?.completedOn?.[provider] ?? '',
          completedToday: checkinCompleted(
            current.checkin,
            provider,
            Date.now(),
            accountsFor(provider, current)
              .filter((account) => account.enabled !== false)
              .map((account) => account.id)
              .sort(),
          ),
          lastAttemptAt: current.checkin?.lastAttemptAt?.[provider] ?? 0,
          result: current.checkin?.results?.[provider] ?? undefined,
        },
        // 「浏览器登录」任务的状态（只有桌面 provider 有）。
        login: loginJobs.get(provider) === undefined ? undefined : (({ close, cancelled, ...rest }) => rest)(loginJobs.get(provider)),
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
      // 设置文件读坏时不能静默重置：卡片要能提示，诊断要能看到备份路径。
      storage: {
        settingsError: typeof store.loadError === 'string'
          ? scrubSecretText(store.loadError).slice(0, 400)
          : store.loadError,
        settingsBackup: store.corruptPath,
      },
      providers,
      settings: {
        workbuddy: current.workbuddy,
        qoder: {
          [PROVIDERS.qoder]: {
            // 只看账号池：旧 `qoder[provider].pat` 也会被 accountsFor 合成到
            // 隐式默认账号里，但一旦用户清空/删除了默认账号，它就不能再算
            // 「已配置」—— 否则界面会一直显示已保存，掩盖鉴权失败。
            configured: activeAccountFor(PROVIDERS.qoder, current).pat !== undefined,
          },
          [PROVIDERS.qoderGlobal]: {
            configured: activeAccountFor(PROVIDERS.qoderGlobal, current).pat !== undefined,
          },
        },
        // Trae 没有 PAT：能填的只有「storage.json 在哪」。configured 由登录探测
        // 决定，这里只把路径回给卡片，让输入框能显示当前值。
        trae: {
          [PROVIDERS.trae]: {
            storageFile: current.trae?.[PROVIDERS.trae]?.storageFile ?? '',
            configured: credentials[PROVIDERS.trae]?.status === 'signed-in',
          },
          [PROVIDERS.traeGlobal]: {
            storageFile: current.trae?.[PROVIDERS.traeGlobal]?.storageFile ?? '',
            configured: credentials[PROVIDERS.traeGlobal]?.status === 'signed-in',
          },
        },
        showRateInModelName: current.display?.showRateInModelName !== false,
        showUsageInSidebar: current.display?.showUsageInSidebar !== false,
        autoSwitch: {
          enabled: current.autoSwitch?.enabled !== false,
          thresholdRatio: typeof current.autoSwitch?.thresholdRatio === 'number' ? current.autoSwitch.thresholdRatio : 0,
        },
        alerts: {
          enabled: current.alerts?.enabled !== false,
          lowRatio: typeof current.alerts?.lowRatio === 'number' ? current.alerts.lowRatio : 0.15,
        },
        checkin: current.checkin?.enabled !== false,
        probe: current.probe?.enabled !== false,
        advanced,
      },
      probe: {
        enabled: current.probe?.enabled !== false,
        lastRunAt: current.probe?.lastRunAt ?? 0,
        results: current.probe?.results ?? {},
      },
      // 事件账本：完整状态带最近 50 条（卡片展开「最近事件」用），轻量状态只给
      // 摘要 —— 侧栏小卡不展示时间线，没必要为它多传几 KB。
      events: light
        ? events.summary()
        : { ...events.summary(), limit: EVENT_LIST_LIMIT, items: events.list({ limit: EVENT_LIST_LIMIT }) },
      // 侧栏只拿「今天 + 最近 14 天 + 当前会话」，不把 30 天全量塞进轻量接口。
      stats: light
        ? {
            today: usage.today,
            enabled: usage.enabled,
            currentSession: usage.currentSession,
            providerCurrentSession: usage.providerCurrentSession,
            daily: usage.daily.slice(-14),
            providerDaily: Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, (usage.providerDaily?.[provider] ?? []).slice(-14)])),
          }
        : usage,
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
      res.setHeader('Allow', 'POST')
      writeJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    if (!keyMatches(req.headers['x-rpc-key'], token)) {
      writeJson(res, 403, { error: 'invalid-key' })
      return
    }
    if (contentLengthTooLarge(req)) {
      rejectTooLarge(req, res)
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      rejectTooLarge(req, res)
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
    // 账号合并必须在写锁**内**基于最新设置计算：先 sync 再 patch 时，另一个
    // 进程（CLI 登录 / 续期）在两步之间写入的账号会被整表覆盖掉。
    let sanitized
    try {
      store.update((current) => {
        sanitized = mergeAccountSecrets(sanitizePatch(patch), current)
        return sanitized
      })
    } catch (error) {
      writeJson(res, 500, { error: 'settings-write-failed' })
      return
    }
    // 写入后立即让状态缓存失效：回读必须看到这次修改，而不是 750ms 前的旧文档。
    invalidateStatus()
    // 新增/更换凭证后，这个 provider 今天可能已经被「未配置」判过终态：
    // 启动时没登录 → 签到记 unconfigured 并把当天标成完成；10:00 补上 PAT 后，
    // 调度器会一直认为「今天已签」，当天的奖励就丢了。清掉这个 provider 的
    // 完成标记（账号集合也清空），让下一轮 tick 重新检查。
    const credentialTouched = credentialProvidersOf(sanitized)
    if (credentialTouched.size > 0) {
      const reopen = checkinReopenPatch(store.get().checkin, credentialTouched)
      if (Object.keys(reopen.completedOn).length > 0) {
        try {
          store.patch({ checkin: reopen })
        } catch (error) {
          ctx.logger?.warn?.('dsh-reverse-proxy-connect: 凭证更新后重置签到完成标记失败', error)
        }
      }
    }
    // 被删除 / 明确清空密钥的账号：连它的额度缓存、消耗历史与统计一起清掉。
    const revoked = []
    for (const [provider, rows] of Object.entries(patch.accounts ?? {})) {
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        if (row !== null && typeof row === 'object' && row.forget === true && typeof row.id === 'string') {
          revoked.push({ provider, accountId: row.id })
        }
      }
    }
    for (const [provider, ids] of Object.entries(patch.removedAccounts ?? {})) {
      if (!Array.isArray(ids)) continue
      for (const id of ids) if (typeof id === 'string') revoked.push({ provider, accountId: id })
    }
    for (const { provider, accountId } of revoked) {
      try {
        runtime.forgetAccount(provider, accountId)
      } catch (error) {
        ctx.logger?.warn?.('dsh-reverse-proxy-connect: 清理已删除账号的缓存失败', error)
      }
    }
    // PAT 换了，旧的 job token / 用户身份必须作废，否则新令牌首轮仍用旧身份。
    if (sanitized.qoder !== undefined) runtime.forgetIdentities()
    // 只记顶层键名，不记值：PAT/令牌永远不进入事件账本。
    const changed = Object.keys(sanitized)
    events.record({
      type: 'settings',
      message: changed.length === 0 ? '设置已保存（无变更）' : `设置已保存：${changed.join('、')}`,
      data: { keys: changed },
    })
    bumpCatalog()
    if (patchNeedsRefresh(sanitized)) {
      await Promise.allSettled([runtime.refreshAll({ force: true }), runtime.refreshAllCredits({ force: true })])
      bumpCatalog()
    }
    writeJson(res, 200, await statusDocument())
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
    // 任何 action 都可能改变状态（换号/刷新/签到/测试），先失效再执行。
    invalidateStatus()
    if (contentLengthTooLarge(req)) {
      rejectTooLarge(req, res)
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      rejectTooLarge(req, res)
      return
    }
    let payload
    try {
      payload = JSON.parse(body === '' ? '{}' : body)
    } catch {
      writeJson(res, 400, { error: 'invalid-json' })
      return
    }
    if (payload?.action === 'login-start') {
      const started = startLogin(payload.provider)
      writeJson(res, 200, { login: started, status: await statusDocument() })
      return
    }
    if (payload?.action === 'login-cancel') {
      cancelLogin(payload.provider)
      writeJson(res, 200, await statusDocument())
      return
    }
    if (payload?.action === 'refresh') {
      await Promise.allSettled([runtime.refreshAll({ force: true }), runtime.refreshAllCredits({ force: true })])
      lastCatalogAt = Date.now()
      lastCreditsAt = Date.now()
      events.record({
      type: 'catalog',
      message: '已手动刷新模型目录与额度',
      messageKey: { key: 'eventManualRefresh' },
    })
      writeJson(res, 200, await statusDocument())
      return
    }
    if (payload?.action === 'credits') {
      await runtime.refreshAllCredits({ force: true })
      lastCreditsAt = Date.now()
      events.record({
      type: 'credits',
      message: '已手动刷新额度',
      messageKey: { key: 'eventManualCredits' },
    })
      writeJson(res, 200, await statusDocument())
      return
    }
    if (payload?.action === 'checkin') {
      await runCheckin({ force: true, provider: typeof payload.provider === 'string' ? payload.provider : undefined })
      // 签到通常直接改变积分，顺手把额度也刷一遍。
      await runtime.refreshAllCredits({ force: true })
      writeJson(res, 200, await statusDocument())
      return
    }
    if (payload?.action === 'probe') {
      // 手动重探：清掉时间戳强制重跑，供「我刚升级了账号套餐」这类场景使用。
      store.patch({ probe: { lastRunAt: 0 } })
      await runtime.refreshAll({ force: true })
      await runProbe({ force: true })
      writeJson(res, 200, await statusDocument())
      return
    }
    if (payload?.action === 'test-account') {
      const provider = typeof payload.provider === 'string' ? payload.provider : ''
      const accountId = typeof payload.accountId === 'string' ? payload.accountId : ''
      if (!PROVIDER_IDS.includes(provider) || accountId === '') {
        writeJson(res, 400, { error: 'invalid-account' })
        return
      }
      const test = await runtime.testAccount(provider, accountId)
      writeJson(res, 200, { test, status: await statusDocument() })
      return
    }
    if (payload?.action === 'test-model') {
      const provider = typeof payload.provider === 'string' ? payload.provider : ''
      const accountId = typeof payload.accountId === 'string' ? payload.accountId : ''
      const modelId = typeof payload.model === 'string' ? payload.model : ''
      if (!PROVIDER_IDS.includes(provider) || accountId === '' || modelId === '') {
        writeJson(res, 400, { error: 'invalid-model-test' })
        return
      }
      // `deep`：按真实对话请求的形状发起（系统提示词 + 工具表 + 正常输出上限）。
      // 1-token 的普通测试测不出「网关拦 agent 请求」这类问题。
      const test = await runtime.testAccount(provider, accountId, modelId, { deep: payload.deep === true })
      writeJson(res, 200, { test, status: await statusDocument() })
      return
    }
    if (payload?.action === 'reset-account') {
      const provider = typeof payload.provider === 'string' ? payload.provider : ''
      const accountId = typeof payload.accountId === 'string' ? payload.accountId : ''
      if (!PROVIDER_IDS.includes(provider) || accountId === '') {
        writeJson(res, 400, { error: 'invalid-account' })
        return
      }
      runtime.clearAccountFailure(provider, accountId)
      writeJson(res, 200, await statusDocument())
      return
    }
    if (payload?.action === 'stats-reset') {
      stats.reset()
      events.record({
      type: 'stats',
      message: '用量统计已重置',
      messageKey: { key: 'eventStatsReset' },
    })
      writeJson(res, 200, await statusDocument())
      return
    }
    if (payload?.action === 'events-clear') {
      // `clear()` 返回「是否真的落盘成功」。以前丢弃它、无条件回 200：设置文件
      // 来自更高版本（降级安装 → EventLog.writeBlocked）时 memory 清了、磁盘一
      // 字未改，界面却显示「已清空」，重启后旧事件全回来 —— 这是四条 action 里
      // 唯一把失败报成功的。清空失败就是失败，不记「已清空」那条事件。
      const cleared = events.clear()
      if (cleared === false) {
        writeJson(res, 500, { error: 'events-clear-failed' })
        return
      }
      events.record({
      type: 'events',
      message: '事件账本已清空',
      messageKey: { key: 'eventCleared' },
    })
      writeJson(res, 200, await statusDocument())
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


/** 只接受回环请求：socket 对端、Host 与 Origin（若有）都必须是回环。 */
function loopbackRequest(req) {
  // Host 头可以被客户端随便伪造，不能当唯一的安全边界。真正的对端地址来自
  // socket；DSH 只在本机监听时这仍然成立。
  const remote = req.socket?.remoteAddress ?? req.connection?.remoteAddress
  if (typeof remote !== 'string' || remote === '' || !isLoopbackAddress(remote)) return false
  // 反向代理 / SSH 隧道通常从 127.0.0.1 连进来并改写 Host。显式的代理头
  // 说明请求不是浏览器直连的，一律拒绝；UNIX socket 没有 remoteAddress 也拒绝。
  for (const header of ['via', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip']) {
    if (req.headers?.[header] !== undefined) return false
  }
  const host = String(req.headers.host ?? '')
  if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host)) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  return /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin))
}

/** socket 对端是否回环（兼容 IPv4-mapped IPv6）。 */
function isLoopbackAddress(value) {
  const text = String(value).trim().toLowerCase()
  if (text === '::1' || text === 'localhost') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text)) return true
  return /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text)
}

/** 常量时间比较控制密钥。 */
function keyMatches(given, expected) {
  if (typeof given !== 'string') return false
  const left = Buffer.from(given)
  const right = Buffer.from(expected)
  // `.length` 是 UTF-16 码元，timingSafeEqual 比的是 UTF-8 字节；多字节 header
  // 会让长度校验通过然后抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH（500）。
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * 读请求体，超限返回 undefined。
 *
 * 超限时**不能** `req.destroy()`：那会在 413 写出去之前把 socket 掐掉，
 * 客户端只看到 ECONNRESET。这里停止累积、把剩余字节排空，让调用方把
 * 413 正常写回去。
 */
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    let tooLarge = false
    let settled = false
    const chunks = []
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
      resolve(value)
    }
    const onData = (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        tooLarge = true
        chunks.length = 0
        // 继续排空（不保留），否则发送端会被背压卡住。
        req.resume?.()
        finish(undefined)
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => finish(tooLarge ? undefined : Buffer.concat(chunks).toString('utf8'))
    const onError = () => finish(undefined)
    const onAborted = () => finish(undefined)
    const timer = setTimeout(() => finish(undefined), 30_000)
    timer.unref?.()
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAborted)
  })
}

/** 413：带 Connection: close，并把还没读完的请求体排空。 */
function rejectTooLarge(req, res) {
  try {
    res.setHeader('Connection', 'close')
  } catch {
    /* 响应已经不可写 */
  }
  req.resume?.()
  writeJson(res, 413, { error: 'body-too-large' })
}

/** Content-Length 预检：明显超限就不必等 1MB 才开始读。 */
function contentLengthTooLarge(req) {
  const raw = req.headers?.['content-length']
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return false
  const length = Number(raw)
  return Number.isFinite(length) && length > REQUEST_BODY_LIMIT
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

/** 写纯文本响应（诊断的可读版本）。 */
function writeText(res, status, text) {
  const payload = String(text)
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

export { NAME, inject, PROVIDERS }
