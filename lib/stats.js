/**
 * 用量统计：让「这个插件到底在干什么」变得可查。
 *
 * 之前插件只在设置卡片里显示余额与登录状态，但用户真正会问的是：
 * 「今天用掉多少 token」「刚才那次失败是因为什么」「哪个模型最慢」。
 * 这些问题都只能从**每一次请求的终态**回答，所以运行时在归一化事件流外面
 * 包一层观察器，把 usage / finish / 错误都记进这里。
 *
 * 设计约束：
 *
 * - **写盘失败绝不影响聊天**。统计是旁路，任何异常都吞掉。
 * - **不记请求内容**。只记 provider / 账号 / 模型 / 结果 / token / 延迟。
 * - **有上限**。最近的请求只留 40 条、模型维度只留 120 个 —— 这个文件要跟着
 *   插件跑几年，不能无限长。
 * - **日切按本机时区**。用户看的是「今天」，不是 UTC。
 *
 * @module dsh-reverse-proxy-connect/stats
 */

import { readJsonFile, writeJsonAtomic } from './atomic.js'
import { PROVIDER_IDS } from './protocol.js'
import { join } from 'node:path'

/** 统计文件名。 */
const FILE = 'stats.json'

/** 文件格式版本。 */
const VERSION = 1

/** 最近请求保留条数。 */
const RECENT_LIMIT = 40

/** 模型维度保留条数。 */
const MODEL_LIMIT = 120

/** 账号维度保留条数。 */
const ACCOUNT_LIMIT = 40

/** 写盘去抖。 */
const PERSIST_DELAY_MS = 1200

/**
 * 一个空的计数器组。
 * @returns 计数器。
 */
export function emptyCounters() {
  return {
    requests: 0,
    ok: 0,
    failed: 0,
    aborted: 0,
    incomplete: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    durationMs: 0,
    maxDurationMs: 0,
    lastAt: 0,
    lastOkAt: 0,
    lastErrorAt: 0,
    consecutiveFailures: 0,
  }
}

/** 数字字段：只接受有限数。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * 把任意读入的计数器补齐成完整结构。
 * @param raw - 原始值。
 * @returns 计数器。
 */
export function normalizeCounters(raw) {
  const base = emptyCounters()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
  for (const key of Object.keys(base)) base[key] = num(raw[key])
  return base
}

/** 当日键（本机时区）。 */
export function dayKey(at = Date.now()) {
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 由计数器算出健康状态。
 *
 * 阈值刻意保守：连续 2 次失败只是「降级」，连续 3 次才叫「不可用」。
 * 单次失败太常见（限流、网络抖动），把它显示成红色只会制造噪音。
 *
 * @param counters - 某个 provider 的计数器。
 * @param now - 当前时间（测试可注入）。
 * @returns `{state, consecutiveFailures, lastErrorAt, lastSuccessAt}`。
 */
export function healthOf(counters, now = Date.now()) {
  const value = counters ?? emptyCounters()
  const streak = num(value.consecutiveFailures)
  const lastErrorAt = num(value.lastErrorAt)
  const lastSuccessAt = num(value.lastOkAt)
  let state = 'unknown'
  if (streak >= 3) state = 'down'
  else if (streak >= 2) state = 'degraded'
  else if (lastErrorAt > 0 && lastErrorAt > lastSuccessAt && now - lastErrorAt < 120_000) state = 'degraded'
  else if (lastSuccessAt > 0) state = 'ok'
  return {
    state,
    consecutiveFailures: streak,
    lastErrorAt,
    lastSuccessAt,
  }
}

/** 把计数器加上派生字段（成功率、平均延迟、token 合计）。 */
function derived(counters) {
  const value = { ...counters }
  const settled = value.ok + value.failed
  value.successRate = settled === 0 ? undefined : value.ok / settled
  value.avgDurationMs = value.requests === 0 ? 0 : Math.round(value.durationMs / value.requests)
  value.totalTokens = value.inputTokens + value.outputTokens + value.cacheReadTokens + value.cacheWriteTokens
  return value
}

/**
 * 一次请求的统计记录。
 * @typedef {object} StatsEntry
 * @property {string} provider
 * @property {string} accountId
 * @property {string} model
 * @property {string} kind - `stop | tool-calls | max-tokens | error | aborted | incomplete`
 * @property {string} [code] - 失败时的稳定 code。
 * @property {number} durationMs
 * @property {object} [usage] - DSH 的 TokenUsage。
 * @property {number} [at]
 */

/** 进程内的用量统计。 */
export class Stats {
  /**
   * @param options - `{ filePath, enabled?, now?, persistDelayMs? }`。
   */
  constructor(options) {
    this.filePath = options.filePath
    this.enabled = typeof options.enabled === 'function' ? options.enabled : () => options.enabled !== false
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.persistDelayMs = typeof options.persistDelayMs === 'number' ? options.persistDelayMs : PERSIST_DELAY_MS
    this.timer = undefined
    this.data = this.#load()
  }

  /** 读盘；坏文件安静退化成空统计。 */
  #load() {
    const fallback = this.#blank()
    const raw = readJsonFile(this.filePath)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fallback
    if (raw.version !== undefined && raw.version !== VERSION) return fallback
    const data = fallback
    data.since = num(raw.since) > 0 ? num(raw.since) : this.now()
    data.totals = normalizeCounters(raw.totals)
    if (raw.today !== null && typeof raw.today === 'object' && !Array.isArray(raw.today)) {
      data.today = { ...normalizeCounters(raw.today), date: typeof raw.today.date === 'string' ? raw.today.date : dayKey(this.now()) }
      if (data.today.date !== dayKey(this.now())) {
        data.today = { ...emptyCounters(), date: dayKey(this.now()) }
        data.providerToday = Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, emptyCounters()]))
      }
    }
    if (raw.providers !== null && typeof raw.providers === 'object' && !Array.isArray(raw.providers)) {
      for (const provider of PROVIDER_IDS) {
        if (raw.providers[provider] !== undefined) data.providers[provider] = normalizeCounters(raw.providers[provider])
      }
    }
    if (raw.providerToday !== null && typeof raw.providerToday === 'object' && !Array.isArray(raw.providerToday)) {
      for (const provider of PROVIDER_IDS) {
        if (raw.providerToday[provider] !== undefined) data.providerToday[provider] = normalizeCounters(raw.providerToday[provider])
      }
    }
    if (raw.accounts !== null && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)) {
      for (const [key, value] of Object.entries(raw.accounts).slice(0, ACCOUNT_LIMIT)) {
        if (key === '') continue
        data.accounts[key] = normalizeCounters(value)
      }
    }
    if (raw.models !== null && typeof raw.models === 'object' && !Array.isArray(raw.models)) {
      for (const [key, value] of Object.entries(raw.models).slice(0, MODEL_LIMIT)) {
        if (key === '') continue
        data.models[key] = normalizeCounters(value)
      }
    }
    if (Array.isArray(raw.recent)) {
      data.recent = raw.recent
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.provider === 'string' && PROVIDER_IDS.includes(entry.provider))
        .slice(0, RECENT_LIMIT)
    }
    return data
  }

  /** 空统计文档。 */
  #blank() {
    const at = this.now()
    return {
      version: VERSION,
      since: at,
      totals: emptyCounters(),
      today: { ...emptyCounters(), date: dayKey(at) },
      providers: Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, emptyCounters()])),
      providerToday: Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, emptyCounters()])),
      accounts: {},
      models: {},
      recent: [],
    }
  }

  /** 是否开启（动态读取设置）。 */
  #on() {
    try {
      return this.enabled() !== false
    } catch {
      return true
    }
  }

  /** 日切：跨过本机午夜时只清 today。 */
  #rollDay(at) {
    const key = dayKey(at)
    if (this.data.today.date === key) return
    this.data.today = { ...emptyCounters(), date: key }
    this.data.providerToday = Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, emptyCounters()]))
  }

  /**
   * 记一次请求。
   * @param entry - 统计记录。
   * @returns 是否真的记了。
   */
  record(entry) {
    if (!this.#on()) return false
    if (entry === null || typeof entry !== 'object') return false
    const provider = typeof entry.provider === 'string' ? entry.provider : ''
    if (!PROVIDER_IDS.includes(provider)) return false
    const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : this.now()
    this.#rollDay(at)
    const kind = typeof entry.kind === 'string' ? entry.kind : 'stop'
    const failed = kind === 'error'
    const aborted = kind === 'aborted'
    const incomplete = kind === 'incomplete'
    const usage = entry.usage !== null && typeof entry.usage === 'object' ? entry.usage : {}
    const input = num(usage.inputTokens)
    const output = num(usage.outputTokens)
    const cacheRead = num(usage.cacheReadTokens)
    const cacheWrite = num(usage.cacheWriteTokens)
    const reasoning = num(usage.reasoningTokens)
    const duration = num(entry.durationMs)
    const model = typeof entry.model === 'string' ? entry.model.slice(0, 200) : ''
    const accountId = typeof entry.accountId === 'string' ? entry.accountId.slice(0, 100) : 'default'
    const code = typeof entry.code === 'string' ? entry.code.slice(0, 80) : ''

    const buckets = [
      this.data.totals,
      this.data.today,
      this.data.providers[provider] ?? (this.data.providers[provider] = emptyCounters()),
      this.data.providerToday[provider] ?? (this.data.providerToday[provider] = emptyCounters()),
      this.data.accounts[`${provider}::${accountId}`] ?? (this.data.accounts[`${provider}::${accountId}`] = emptyCounters()),
    ]
    if (model !== '') buckets.push(this.data.models[`${provider}::${model}`] ?? (this.data.models[`${provider}::${model}`] = emptyCounters()))

    for (const bucket of buckets) {
      bucket.requests += 1
      if (failed) bucket.failed += 1
      else if (aborted) bucket.aborted += 1
      else if (incomplete) bucket.incomplete += 1
      else bucket.ok += 1
      bucket.inputTokens += input
      bucket.outputTokens += output
      bucket.cacheReadTokens += cacheRead
      bucket.cacheWriteTokens += cacheWrite
      bucket.reasoningTokens += reasoning
      bucket.durationMs += duration
      if (duration > bucket.maxDurationMs) bucket.maxDurationMs = duration
      bucket.lastAt = at
      if (failed) {
        bucket.lastErrorAt = at
        bucket.consecutiveFailures += 1
      } else if (!aborted && !incomplete) {
        bucket.lastOkAt = at
        bucket.consecutiveFailures = 0
      }
    }

    this.data.recent.unshift({
      at,
      provider,
      accountId,
      model,
      kind,
      ...(code === '' ? {} : { code }),
      durationMs: Math.round(duration),
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output + cacheRead + cacheWrite,
    })
    if (this.data.recent.length > RECENT_LIMIT) this.data.recent.length = RECENT_LIMIT

    this.#prune()
    this.#schedule()
    return true
  }

  /** 控制模型/账号维度的体积：按最近使用时间淘汰。 */
  #prune() {
    for (const [key, map, limit] of [
      ['models', this.data.models, MODEL_LIMIT],
      ['accounts', this.data.accounts, ACCOUNT_LIMIT],
    ]) {
      const entries = Object.entries(map)
      if (entries.length <= limit) continue
      entries.sort((a, b) => (b[1].lastAt ?? 0) - (a[1].lastAt ?? 0))
      this.data[key] = Object.fromEntries(entries.slice(0, limit))
    }
  }

  /** 去抖写盘。 */
  #schedule() {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.persistDelayMs)
    this.timer.unref?.()
  }

  /** 立即写盘。 */
  flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    writeJsonAtomic(this.filePath, this.data)
    return true
  }

  /** 清空统计（用户点「重置统计」时调用）。 */
  reset() {
    this.data = this.#blank()
    this.flush()
    return this.snapshot()
  }

  /** 停止定时器并落盘。 */
  stop() {
    this.flush()
  }

  /** 该 provider 的健康状态。 */
  healthFor(provider) {
    return healthOf(this.data.providers[provider], this.now())
  }

  /** 该 provider 的用量快照。 */
  providerSnapshot(provider) {
    const counters = this.data.providers[provider] ?? emptyCounters()
    return {
      totals: derived(counters),
      today: derived(this.data.providerToday[provider] ?? emptyCounters()),
      health: this.healthFor(provider),
      last: this.data.recent.find((entry) => entry.provider === provider),
    }
  }

  /** 完整快照（给 /status）。 */
  snapshot() {
    const providers = {}
    const providerToday = {}
    const health = {}
    for (const provider of PROVIDER_IDS) {
      providers[provider] = derived(this.data.providers[provider] ?? emptyCounters())
      providerToday[provider] = derived(this.data.providerToday[provider] ?? emptyCounters())
      health[provider] = this.healthFor(provider)
    }
    const accounts = {}
    for (const [key, value] of Object.entries(this.data.accounts)) accounts[key] = derived(value)
    const models = {}
    for (const [key, value] of Object.entries(this.data.models)) models[key] = derived(value)
    return {
      enabled: this.#on(),
      since: this.data.since,
      totals: derived(this.data.totals),
      today: { ...derived(this.data.today), date: this.data.today.date },
      providers,
      providerToday,
      accounts,
      models,
      recent: this.data.recent.map((entry) => ({ ...entry })),
      health,
    }
  }
}

/**
 * 统计文件的绝对路径。
 * @param dataDir - 插件数据目录。
 * @returns 路径。
 */
export function statsPathOf(dataDir) {
  return join(dataDir, FILE)
}
