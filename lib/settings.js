/**
 * 设置：持久化到 profile 目录下的 `settings.json`，结构极小且可手改。
 *
 * 刻意不用 `@deepseek-ai/schemastery` 的 Config，也不碰 `settings.configure`：
 * 0.2.1-rc.1 的 settings 服务只提供 `SettingsForms`，而插件配置里已经带了
 * 全部默认值，直接读写一个 JSON 文件更稳、也更容易排障。
 *
 * @module dsh-reverse-proxy-connect/settings
 */

import { readFileSync } from 'node:fs'

import { writeJsonAtomic } from './atomic.js'
import { normalizeAccount } from './accounts.js'
import {
  DEFAULT_CATALOG_REFRESH_MS,
  DEFAULT_CREDITS_REFRESH_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_QODER_QUEUE_WAIT_MS,
  PROVIDERS,
  PROVIDER_IDS,
  PROVIDER_META,
} from './protocol.js'

/** 设置文件格式版本：2 起新增 `advanced` 与展示偏好。 */
export const SETTINGS_VERSION = 2

/** `advanced` 里时间字段的合法区间（毫秒）。 */
export const ADVANCED_LIMITS = Object.freeze({
  idleTimeoutMs: Object.freeze([15_000, 900_000]),
  catalogRefreshMs: Object.freeze([120_000, 86_400_000]),
  creditsRefreshMs: Object.freeze([30_000, 21_600_000]),
  qoderQueueWaitMs: Object.freeze([15_000, 180_000]),
})

/** 把数字夹到区间内；非数字返回默认值。 */
function clampNumber(value, fallback, [min, max]) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

/** 比例：接受 0–1 的小数（也接受 0–100 的百分数写法，统一收敛成小数）。 */
function clampRatio(value, fallback, [min, max]) {
  let number = value
  if (typeof number === 'string' && number.trim() !== '') number = Number(number)
  if (typeof number !== 'number' || !Number.isFinite(number)) return fallback
  if (number > 1 && number <= 100) number /= 100
  return Math.max(min, Math.min(max, Math.round(number * 1000) / 1000))
}

/** 设置文件的默认结构。 */
export function defaults() {
  return {
    version: SETTINGS_VERSION,
    /** 每个 provider 的开关与模型过滤。 */
    providers: {
      [PROVIDERS.workbuddy]: { enabled: true, disabledModels: [] },
      [PROVIDERS.workbuddyAi]: { enabled: true, disabledModels: [] },
      [PROVIDERS.qoder]: { enabled: true, disabledModels: [] },
      [PROVIDERS.qoderGlobal]: { enabled: true, disabledModels: [] },
    },
    /** WorkBuddy 变体的路径覆盖与偏好。 */
    workbuddy: {
      workbuddy: { authFile: '', electronPath: '', useMaximumContext: true },
      'workbuddy-ai': { authFile: '', electronPath: '', useMaximumContext: true },
    },
    /** Qoder 的 PAT。 */
    qoder: {
      [PROVIDERS.qoder]: { pat: '' },
      [PROVIDERS.qoderGlobal]: { pat: '' },
    },
    /**
     * 账号用不了的模型（由能力探测自动写入，键是 provider，值是模型 id 数组）。
     *
     * 与 `disabledModels` 分开存：那个是**用户的选择**，这个是**上游的事实**。
     * 混在一起的话，用户手动开启一个被上游拒绝的模型后会立刻又被探测关掉，
     * 卡片上看起来像「开关坏了」。
     */
    unavailableModels: {},
    /**
     * 用户明确要求「就算探测说不行也要显示」的模型。
     *
     * 存在的意义：探测是启发式的（可能一次网络抖动就误判），而用户可能刚升级了
     * 套餐。留一个手动覆盖的口子，比让人只能改 JSON 好。
     */
    forcedModels: {},
    /** 能力探测的开关与最近一次结果。 */
    probe: { enabled: true, lastRunAt: 0, results: {} },
    /**
     * 账号池：每个 provider 可以有多个账号。
     *
     * 默认为空数组 —— 空的意思不是「没有账号」，而是「用隐式默认账号」
     * （WorkBuddy 读本机登录、Qoder 用 `qoder[provider].pat`）。
     * 这样老设置升级上来行为完全不变，见 `accounts.js` 的 `accountsFor`。
     */
    accounts: {
      [PROVIDERS.workbuddy]: [],
      [PROVIDERS.workbuddyAi]: [],
      [PROVIDERS.qoder]: [],
      [PROVIDERS.qoderGlobal]: [],
    },
    /** 用户钉住的账号 id；空 = 用第一个可用账号。 */
    activeAccount: {},
    /**
     * 额度耗尽时自动切到下一个还有余额的账号。
     *
     * 默认开：多账号存在的意义就是「一个用完了换另一个」，还要手动切就没意义了。
     */
    autoSwitch: { enabled: true, thresholdRatio: 0 },
    /**
     * 额度预警：剩余比例低于 `lowRatio` 时卡片与侧栏亮警示色。
     *
     * 与 `autoSwitch.thresholdRatio` 分开：一个是「提醒」，一个是「真的换号」。
     * 用户可以只想被提醒，不想自动切到另一个账号。
     */
    alerts: { enabled: true, lowRatio: 0.15 },
    /** 展示偏好。 */
    display: {
      /**
       * 在模型名后拼上倍率（如 `GLM-5.3 · x0.79`）。
       *
       * DSH 的模型选择器只渲染 `name`，倍率只有拼在这里才看得见。
       * 默认开：选模型时最需要知道的就是「这个贵不贵」。
       */
      showRateInModelName: true,
      /** 侧栏面板里显示今日 token 用量。 */
      showUsageInSidebar: true,
    },
    /**
     * 高级参数。
     *
     * 这些值以前是写死在代码里的常量。用户遇到「长回答被切断」「刷新太频繁」
     * 时只能改代码，所以 1.0.0 把它们抬成设置项，并做区间夹取 —— 手改成 0
     * 或负数也不会把插件弄成不工作。
     */
    advanced: {
      /** 流空闲超时：多久没有新事件就判定卡死。 */
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      /** 目录自动刷新间隔。 */
      catalogRefreshMs: DEFAULT_CATALOG_REFRESH_MS,
      /** 额度自动刷新间隔。 */
      creditsRefreshMs: DEFAULT_CREDITS_REFRESH_MS,
      /** Qoder 免费模型排队时本地最多等多久；调大可以等更久，但会占用一次请求。 */
      qoderQueueWaitMs: DEFAULT_QODER_QUEUE_WAIT_MS,
      /** 是否记录用量统计。 */
      stats: true,
      /** 是否把成功目录缓存到磁盘（重启后立即有模型）。 */
      catalogCache: true,
    },
    /**
     * 每日签到。
     *
     * 默认开：WorkBuddy 国内版每天有 100 积分可领，不领就浪费了。
     * `lastRunAt` 记最近一次尝试，`completedOn` 记每个 provider 已经完成签到的
     * 本地日期（`YYYY-MM-DD`），`lastAttemptAt` 用于失败后的短暂退避。
     */
    checkin: { enabled: true, lastRunAt: 0, completedOn: {}, lastAttemptAt: {}, results: {} },
  }
}

/**
 * 把任意读入的对象补齐成完整结构（容忍旧版本缺字段与手改出错）。
 * @param raw - 读进来的对象。
 * @returns 归一化后的设置。
 */
export function normalize(raw) {
  const base = defaults()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
  const out = base
  if (raw.providers !== null && typeof raw.providers === 'object') {
    for (const provider of Object.values(PROVIDERS)) {
      const entry = raw.providers[provider]
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.enabled === 'boolean') out.providers[provider].enabled = entry.enabled
      if (Array.isArray(entry.disabledModels)) {
        out.providers[provider].disabledModels = entry.disabledModels.filter((id) => typeof id === 'string')
      }
    }
  }
  if (raw.workbuddy !== null && typeof raw.workbuddy === 'object') {
    for (const variant of ['workbuddy', 'workbuddy-ai']) {
      const entry = raw.workbuddy[variant]
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.authFile === 'string') out.workbuddy[variant].authFile = entry.authFile
      if (typeof entry.electronPath === 'string') out.workbuddy[variant].electronPath = entry.electronPath
      if (typeof entry.useMaximumContext === 'boolean') out.workbuddy[variant].useMaximumContext = entry.useMaximumContext
    }
  }
  if (raw.qoder !== null && typeof raw.qoder === 'object') {
    for (const provider of [PROVIDERS.qoder, PROVIDERS.qoderGlobal]) {
      const entry = raw.qoder[provider]
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.pat === 'string') out.qoder[provider].pat = entry.pat
    }
  }
  if (raw.unavailableModels !== null && typeof raw.unavailableModels === 'object' && !Array.isArray(raw.unavailableModels)) {
    for (const [provider, ids] of Object.entries(raw.unavailableModels)) {
      if (!PROVIDER_IDS.includes(provider) || !Array.isArray(ids)) continue
      out.unavailableModels[provider] = ids.filter((id) => typeof id === 'string')
    }
  }
  if (raw.forcedModels !== null && typeof raw.forcedModels === 'object' && !Array.isArray(raw.forcedModels)) {
    for (const [provider, ids] of Object.entries(raw.forcedModels)) {
      if (!PROVIDER_IDS.includes(provider) || !Array.isArray(ids)) continue
      out.forcedModels[provider] = ids.filter((id) => typeof id === 'string')
    }
  }
  if (raw.probe !== null && typeof raw.probe === 'object' && !Array.isArray(raw.probe)) {
    if (typeof raw.probe.enabled === 'boolean') out.probe.enabled = raw.probe.enabled
    if (typeof raw.probe.lastRunAt === 'number' && Number.isFinite(raw.probe.lastRunAt)) out.probe.lastRunAt = raw.probe.lastRunAt
    if (raw.probe.results !== null && typeof raw.probe.results === 'object' && !Array.isArray(raw.probe.results)) {
      out.probe.results = raw.probe.results
    }
  }
  if (raw.display !== null && typeof raw.display === 'object' && !Array.isArray(raw.display)) {
    if (typeof raw.display.showRateInModelName === 'boolean') out.display.showRateInModelName = raw.display.showRateInModelName
    if (typeof raw.display.showUsageInSidebar === 'boolean') out.display.showUsageInSidebar = raw.display.showUsageInSidebar
  }
  if (raw.advanced !== null && typeof raw.advanced === 'object' && !Array.isArray(raw.advanced)) {
    const advanced = raw.advanced
    for (const key of ['idleTimeoutMs', 'catalogRefreshMs', 'creditsRefreshMs', 'qoderQueueWaitMs']) {
      out.advanced[key] = clampNumber(advanced[key], out.advanced[key], ADVANCED_LIMITS[key])
    }
    if (typeof advanced.stats === 'boolean') out.advanced.stats = advanced.stats
    if (typeof advanced.catalogCache === 'boolean') out.advanced.catalogCache = advanced.catalogCache
  }
  out.version = SETTINGS_VERSION
  // 账号池：逐 provider 归一化；空数组等同于「没有额外账号」。
  if (raw.accounts !== null && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)) {
    for (const provider of PROVIDER_IDS) {
      const list = raw.accounts[provider]
      if (!Array.isArray(list)) continue
      const normalized = []
      const seen = new Set()
      for (let index = 0; index < list.length; index++) {
        const account = normalizeAccount(provider, list[index], normalized.length)
        if (account === undefined || seen.has(account.id)) continue
        seen.add(account.id)
        normalized.push(account)
      }
      out.accounts[provider] = normalized
    }
  }
  if (raw.activeAccount !== null && typeof raw.activeAccount === 'object' && !Array.isArray(raw.activeAccount)) {
    for (const provider of PROVIDER_IDS) {
      const id = raw.activeAccount[provider]
      if (typeof id === 'string' && id !== '') out.activeAccount[provider] = id
    }
  }
  if (raw.autoSwitch !== null && typeof raw.autoSwitch === 'object' && !Array.isArray(raw.autoSwitch)) {
    if (typeof raw.autoSwitch.enabled === 'boolean') out.autoSwitch.enabled = raw.autoSwitch.enabled
    out.autoSwitch.thresholdRatio = clampRatio(raw.autoSwitch.thresholdRatio, out.autoSwitch.thresholdRatio, [0, 0.5])
  }
  if (raw.alerts !== null && typeof raw.alerts === 'object' && !Array.isArray(raw.alerts)) {
    if (typeof raw.alerts.enabled === 'boolean') out.alerts.enabled = raw.alerts.enabled
    out.alerts.lowRatio = clampRatio(raw.alerts.lowRatio, out.alerts.lowRatio, [0.01, 0.95])
  }
  if (raw.checkin !== null && typeof raw.checkin === 'object' && !Array.isArray(raw.checkin)) {
    if (typeof raw.checkin.enabled === 'boolean') out.checkin.enabled = raw.checkin.enabled
    if (typeof raw.checkin.lastRunAt === 'number' && Number.isFinite(raw.checkin.lastRunAt)) out.checkin.lastRunAt = raw.checkin.lastRunAt
    // 每个 provider 的「今天已经签完」日期。旧设置没有这两个字段，补成空对象即可；
    // 第一次自动运行时上游的 checkin-status 会告诉我们今天是否已签（幂等）。
    if (raw.checkin.completedOn !== null && typeof raw.checkin.completedOn === 'object' && !Array.isArray(raw.checkin.completedOn)) {
      for (const provider of PROVIDER_IDS) {
        const value = raw.checkin.completedOn[provider]
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) out.checkin.completedOn[provider] = value
      }
    }
    if (raw.checkin.lastAttemptAt !== null && typeof raw.checkin.lastAttemptAt === 'object' && !Array.isArray(raw.checkin.lastAttemptAt)) {
      for (const provider of PROVIDER_IDS) {
        const value = raw.checkin.lastAttemptAt[provider]
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) out.checkin.lastAttemptAt[provider] = value
      }
    }
    if (raw.checkin.results !== null && typeof raw.checkin.results === 'object' && !Array.isArray(raw.checkin.results)) {
      const results = {}
      for (const provider of PROVIDER_IDS) {
        const entry = raw.checkin.results[provider]
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) results[provider] = entry
      }
      out.checkin.results = results
    }
  }
  return out
}

/** 一个可持久化的设置存储。 */
export class SettingsStore {
  /**
   * @param filePath - `settings.json` 的绝对路径。
   */
  constructor(filePath) {
    this.filePath = filePath
    this.value = this.#load()
  }

  /** 读盘；坏文件按默认值处理，不让插件因为一个手改错误起不来。 */
  #load() {
    try {
      return normalize(JSON.parse(readFileSync(this.filePath, 'utf8')))
    } catch {
      return defaults()
    }
  }

  /** 当前值（只读使用）。 */
  get() {
    return this.value
  }

  /**
   * 合并一个补丁并原子落盘。
   * @param patch - 部分设置。
   * @returns 合并后的完整设置。
   */
  patch(patch) {
    this.value = normalize(mergeDeep(this.value, patch))
    this.#persist()
    return this.value
  }

  /** 原子写：先写临时文件再 rename，避免半截文件。 */
  #persist() {
    writeJsonAtomic(this.filePath, this.value, { pretty: true, mode: 0o600 })
  }
}

/** 深合并（数组整体替换）。 */
function mergeDeep(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value) ? mergeDeep(out[key], value) : value
  }
  return out
}

/**
 * 该 provider 在设置里是否启用，以及被屏蔽的模型。
 *
 * 返回两套屏蔽原因，调用方的语义是「任一命中即隐藏」：
 * - `disabled`：用户自己关掉的；
 * - `unavailable`：探测证明这个账号用不了（上游回「当前账号类型暂不支持该模型」）。
 *
 * `forced` 是用户对 `unavailable` 的手动覆盖：命中即视为可用。
 *
 * @param settings - 设置。
 * @param provider - provider id。
 * @returns `{enabled, disabled, unavailable, forced}`。
 */
export function providerOptions(settings, provider) {
  const entry = settings.providers?.[provider]
  const list = (value) => new Set(Array.isArray(value) ? value : [])
  return {
    enabled: entry?.enabled !== false,
    disabled: list(entry?.disabledModels),
    unavailable: list(settings.unavailableModels?.[provider]),
    forced: list(settings.forcedModels?.[provider]),
  }
}

/**
 * 该模型是否应在模型选择器里出现。
 *
 * 单独成函数是因为宿主与卡片必须用**同一套**判定，否则会出现
 * 「卡片上开着、选择器里却没有」这种最难排查的不一致。
 *
 * @param options - `providerOptions()` 的返回值。
 * @param modelId - 模型 id。
 * @returns 是否可见。
 */
export function isModelVisible(options, modelId) {
  if (options.disabled.has(modelId)) return false
  if (options.unavailable.has(modelId) && !options.forced.has(modelId)) return false
  return true
}

/** 给状态接口用的 provider 展示名。 */
export function displayNameOf(provider) {
  return PROVIDER_META[provider]?.displayName ?? provider
}

/**
 * 归一化后的高级参数（运行时用）。
 *
 * `normalize()` 已经把值夹进合法区间；这里再兜一层默认值，是为了让直接读
 * 设置对象的调用方（比如 CLI 里手工构造的设置）也不会拿到 undefined。
 *
 * @param settings - 设置。
 * @returns `{idleTimeoutMs, catalogRefreshMs, creditsRefreshMs, qoderQueueWaitMs, stats, catalogCache}`。
 */
export function advancedOptions(settings) {
  const advanced = settings?.advanced ?? {}
  return {
    idleTimeoutMs: clampNumber(advanced.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, ADVANCED_LIMITS.idleTimeoutMs),
    catalogRefreshMs: clampNumber(advanced.catalogRefreshMs, DEFAULT_CATALOG_REFRESH_MS, ADVANCED_LIMITS.catalogRefreshMs),
    creditsRefreshMs: clampNumber(advanced.creditsRefreshMs, DEFAULT_CREDITS_REFRESH_MS, ADVANCED_LIMITS.creditsRefreshMs),
    qoderQueueWaitMs: clampNumber(advanced.qoderQueueWaitMs, DEFAULT_QODER_QUEUE_WAIT_MS, ADVANCED_LIMITS.qoderQueueWaitMs),
    stats: advanced.stats !== false,
    catalogCache: advanced.catalogCache !== false,
  }
}
