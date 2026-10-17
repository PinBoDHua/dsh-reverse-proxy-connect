/**
 * 设置：持久化到 profile 目录下的 `settings.json`，结构极小且可手改。
 *
 * 刻意不用 `@deepseek-ai/schemastery` 的 Config，也不碰 `settings.configure`：
 * 0.2.1-rc.1 的 settings 服务只提供 `SettingsForms`，而插件配置里已经带了
 * 全部默认值，直接读写一个 JSON 文件更稳、也更容易排障。
 *
 * @module dsh-reverse-proxy-connect/settings
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { normalizeAccount } from './accounts.js'
import { PROVIDERS, PROVIDER_IDS, PROVIDER_META } from './protocol.js'

/** 设置文件的默认结构。 */
export function defaults() {
  return {
    version: 1,
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
    autoSwitch: { enabled: true },
    /** 展示偏好。 */
    display: {
      /**
       * 在模型名后拼上倍率（如 `GLM-5.3 · x0.79`）。
       *
       * DSH 的模型选择器只渲染 `name`，倍率只有拼在这里才看得见。
       * 默认开：选模型时最需要知道的就是「这个贵不贵」。
       */
      showRateInModelName: true,
    },
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
  }
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
    const dir = dirname(this.filePath)
    mkdirSync(dir, { recursive: true })
    const temp = join(dir, `.settings.${process.pid}.${Date.now()}.tmp`)
    writeFileSync(temp, `${JSON.stringify(this.value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.filePath)
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
