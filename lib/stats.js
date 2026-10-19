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

import { statSync } from 'node:fs'
import { join } from 'node:path'

import { readJsonFile, writeJsonAtomic } from './atomic.js'
import { PROVIDER_IDS } from './protocol.js'

/** 统计文件名。 */
const FILE = 'stats.json'

/** 文件格式版本。1 → 2 新增每日历史与会话维度；2 → 3 新增按 provider 的每日/会话维度；
 * 3 → 4 新增「账号 × 模型」交叉维度。 */
const VERSION = 4

/** 最近请求保留条数。 */
const RECENT_LIMIT = 40

/** 模型维度保留条数。 */
const MODEL_LIMIT = 120

/** 账号维度保留条数。 */
const ACCOUNT_LIMIT = 40

/**
 * 「账号 × 模型」交叉维度保留条数。
 *
 * 这是用户真正会问的那一维：「这个账号的钱花在哪个模型上了」。键是
 * `provider::accountId::model`，比单独的账号/模型两份都细，所以上限要给得
 * 更宽松一些 —— 6 家 × 几个账号 × 十几模型，200 条足够覆盖真实用法，
 * 又不会让 stats.json 无限长大。淘汰按最近使用时间，常用的永远留着。
 */
const ACCOUNT_MODEL_LIMIT = 200

/** 每日历史保留天数。 */
const DAILY_LIMIT = 30

/** 会话维度保留条数。 */
const SESSION_LIMIT = 20

/** 按 provider 拆开的会话维度保留条数（20 个会话 × 4 个 provider）。 */
const PROVIDER_SESSION_LIMIT = 80

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

/** `${provider}::${YYYY-MM-DD}` 是否是合法的按 provider 每日键。 */
function isProviderDayKey(key) {
  if (typeof key !== 'string') return false
  const at = key.lastIndexOf('::')
  if (at <= 0) return false
  const provider = key.slice(0, at)
  const date = key.slice(at + 2)
  return PROVIDER_IDS.includes(provider) && /^\d{4}-\d{2}-\d{2}$/.test(date)
}

/** `${sessionId}::${provider}` 是否是合法的按 provider 会话键。 */
function isProviderSessionKey(key) {
  if (typeof key !== 'string') return false
  const at = key.lastIndexOf('::')
  if (at <= 0) return false
  return PROVIDER_IDS.includes(key.slice(at + 2))
}

/**
 * `${provider}::${accountId}::${model}` 是否是合法的「账号 × 模型」键。
 *
 * 注意 `model` 自己可能含有 `::`（上游 id 不保证），所以只按**前两个**分隔符
 * 切：provider 是白名单，accountId 不含 `::`（`newAccountId` 生成的 `acc-N`
 * 与默认的 `default` 都不含），剩下整段都算模型 id。
 *
 * @param key - 缓存键。
 * @returns 是否合法。
 */
function isAccountModelKey(key) {
  if (typeof key !== 'string') return false
  const first = key.indexOf('::')
  if (first <= 0) return false
  if (!PROVIDER_IDS.includes(key.slice(0, first))) return false
  const second = key.indexOf('::', first + 2)
  if (second <= first + 2) return false
  return key.slice(second + 2) !== ''
}

/**
 * 从「账号 × 模型」键里拆出三段。
 *
 * @param key - `${provider}::${accountId}::${model}`。
 * @returns `{provider, accountId, model}`，非法时 undefined。
 */
export function parseAccountModelKey(key) {
  if (!isAccountModelKey(key)) return undefined
  const first = key.indexOf('::')
  const second = key.indexOf('::', first + 2)
  return {
    provider: key.slice(0, first),
    accountId: key.slice(first + 2, second),
    model: key.slice(second + 2),
  }
}

/** 拼一个「账号 × 模型」键。 */
export function accountModelKey(provider, accountId, model) {
  return `${provider}::${accountId}::${model}`
}

/**
 * 健康证据的有效期。
 *
 * 连续失败是「当时那一刻」的证据，不是永久结论：用户可能只是几天没用这一家。
 * 超过这个时长还没有新请求，就不该再断言「不可用」，而应显示「待验证」。
 * 客户端的 `displayHealthState()` 使用同一数值（见 `HEALTH_EVIDENCE_TTL_MS`
 * 在两边的注释与 `tests/stats.test.mjs` 的对齐用例）。
 */
export const HEALTH_EVIDENCE_TTL_MS = 30 * 60_000

/**
 * 由计数器算出健康状态。
 *
 * 阈值刻意保守：连续 2 次失败只是「降级」，连续 3 次才叫「不可用」。
 * 单次失败太常见（限流、网络抖动），把它显示成红色只会制造噪音。
 *
 * 失败证据超过 {@link HEALTH_EVIDENCE_TTL_MS} 后降级成 `stale`：CLI 的
 * `doctor`、诊断导出与设置卡片都以这个字段为准，三者必须同源 —— 否则
 * 卡片显示「待验证」、`doctor --strict` 却因为同一份数据退出 1。
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
  // 证据太旧就不再断言。没有失败时间戳的历史数据（lastErrorAt === 0）保持原判，
  // 避免把旧文件一律判成「待验证」。
  if ((state === 'down' || state === 'degraded')
    && lastErrorAt > 0
    && now - lastErrorAt > HEALTH_EVIDENCE_TTL_MS) {
    state = 'stale'
  }
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
 * 按 provider 分组、每组只保留最新 `perProvider` 天的每日桶。
 *
 * 键形如 `${provider}::${YYYY-MM-DD}`。日期是定宽字符串，字典序即时间序，
 * 所以直接按日期倒排取前 N 条 —— 与 `#prune()` 的淘汰口径一致。
 *
 * @param map - 原始 `providerDaily`。
 * @param perProvider - 每个 provider 保留多少天。
 * @returns `[provider, [[date, counters], …]]`。
 */
function newestProviderDays(map, perProvider) {
  const grouped = new Map()
  for (const [key, value] of Object.entries(map)) {
    if (!isProviderDayKey(key)) continue
    const at = key.lastIndexOf('::')
    const provider = key.slice(0, at)
    const date = key.slice(at + 2)
    const list = grouped.get(provider)
    if (list === undefined) grouped.set(provider, [[date, value]])
    else list.push([date, value])
  }
  const out = []
  for (const [provider, list] of grouped) {
    list.sort((a, b) => a[0].localeCompare(b[0]))
    out.push([provider, list.slice(-perProvider)])
  }
  return out
}

/**
 * 两个计数器合并。
 *
 * 绝大多数字段是**单调累计量**（请求次数、token、耗时），取 max 既不会凭空
 * 多算，又能保住「另一边已经写到磁盘的更大进度」。
 *
 * 但 `consecutiveFailures` 不是累计量：一次成功会把它清零，而 `healthOf()`
 * 只凭 ≥3 判 `down`。对它们取 max 会让**已恢复**的 provider 在合并后继续
 * 显示「不可用」—— 另一个窗口成功过一次、清零了连败，本进程仍拿旧值覆盖。
 * 所以这一项按「谁的最后一次结果更新」来定：`lastAt` 大的一侧为准。
 *
 * @param left - 本地计数器。
 * @param right - 另一侧计数器。
 * @returns 合并后的计数器。
 */
export function mergeCountersMax(left, right) {
  const out = { ...left }
  for (const key of Object.keys(out)) {
    if (key === 'consecutiveFailures') continue
    out[key] = Math.max(num(left[key]), num(right[key]))
  }
  // 连败跟着「最后一次请求」走。`lastAt` 相同时取较小值：宁可显示已恢复，
  // 也不要让一次陈旧证据把 provider 长期钉在「不可用」。
  const leftLast = num(left.lastAt)
  const rightLast = num(right.lastAt)
  if (rightLast > leftLast) out.consecutiveFailures = num(right.consecutiveFailures)
  else if (leftLast > rightLast) out.consecutiveFailures = num(left.consecutiveFailures)
  else out.consecutiveFailures = Math.min(num(left.consecutiveFailures), num(right.consecutiveFailures))
  return out
}

/**
 * 从一份「键 → 计数」映射里挑出**最近活跃**的前 `limit` 条。
 *
 * 读盘时不能直接 `Object.entries(...).slice(0, limit)`：那样保留的是**文件里
 * 最先写入**的键，也就是最旧的数据。超过上限后，重启一次就会把最近的记录丢掉，
 * 只留下几个月前的 —— 用户看到的是「统计怎么突然退回到上个月」。
 *
 * 排序键取 `lastAt`（每次记录都会更新），缺失时视为 0。
 *
 * @param map - 原始映射。
 * @param limit - 最多保留几条。
 * @returns 按最近活跃排序后的条目。
 */
function freshestEntries(map, limit) {
  const entries = Object.entries(map)
  if (entries.length <= limit) return entries
  return entries
    .map(([key, value]) => ({ key, value, lastAt: num(value?.lastAt) }))
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit)
    .map((entry) => [entry.key, entry.value])
}

/** 合并两个计数器映射：键取并集，值取 max。`skip` 命中的键不参与合并。 */
function mergeCounterMap(left, right, skip) {
  const out = { ...left }
  for (const [key, value] of Object.entries(right)) {
    if (typeof skip === 'function' && skip(key)) continue
    out[key] = out[key] === undefined ? value : mergeCountersMax(out[key], value)
  }
  return out
}

/** 复制一份映射，并丢掉 `skip` 命中的键（用于「只采纳另一侧」的分支）。 */
function filterKeyed(map, skip) {
  const out = {}
  for (const [key, value] of Object.entries(map ?? {})) {
    if (typeof skip === 'function' && skip(key)) continue
    out[key] = value
  }
  return out
}

/**
 * 合并两个统计文档（宿主与 CLI/第二个窗口同时写入时用）。
 *
 * 两边通常是从同一份基线各自累加；按字段取 max 是一个**保守**合并：不会
 * 把计数凭空翻倍，但能保住「另一边已经写到磁盘的更大进度」，比整份覆盖好。
 * `recent` 按事件去重后合并。
 *
 * @param left - 本地文档。
 * @param right - 磁盘文档。
 * @param options - `{ skipKey? }`：命中的键不参与合并（本进程已删除的账号）。
 * @returns 合并后的文档。
 */
export function mergeStatsData(left, right, options = {}) {
  if (right === null || typeof right !== 'object') return left
  const skipKey = typeof options.skipKey === 'function' ? options.skipKey : undefined
  const out = { ...left }
  out.since = Math.min(num(left.since) || Number.MAX_SAFE_INTEGER, num(right.since) || Number.MAX_SAFE_INTEGER)
  if (!Number.isFinite(out.since) || out.since === Number.MAX_SAFE_INTEGER) out.since = num(left.since) || num(right.since)
  out.totals = mergeCountersMax(normalizeCounters(left.totals), normalizeCounters(right.totals))

  // 本进程的「今日」是哪一天？两边都以它为唯一口径。
  const leftDate = left.today?.date ?? ''
  const rightDate = right.today?.date ?? ''
  const todayDate = rightDate > leftDate ? rightDate : leftDate
  out.today = { ...normalizeCounters(leftDate === todayDate ? left.today : undefined), date: todayDate }
  if (rightDate === todayDate) {
    out.today = { ...mergeCountersMax(out.today, normalizeCounters(right.today)), date: todayDate }
  }

  out.providers = mergeCounterMap(left.providers ?? {}, right.providers ?? {})
  // 「今日」的三个维度必须和 `today` 用**同一个日期门**。
  //
  // 它们只有在「两边都还是同一天」时才能取 max 合并。跨过午夜之后，磁盘那侧
  // 的 providerToday / accountModelToday 装的是**昨天**的计数：无条件 max 会把
  // 它们原样搬进今天，卡片就出现「今日 3 次，WorkBuddy 今日 10 次」，而
  // providerDaily / daily 里昨天那一条又是 10 —— 三个数字互相矛盾。
  //
  // 旧实现只给 `today` 加了日期门（而且只在 rightNote 更大时才用右侧），
  // 其余三个维度完全没有门槛。
  const sameDay = leftDate === rightDate
  out.providerToday = sameDay
    ? mergeCounterMap(left.providerToday ?? {}, right.providerToday ?? {})
    : (rightDate > leftDate ? { ...right.providerToday } : { ...left.providerToday })
  out.accounts = mergeCounterMap(left.accounts ?? {}, right.accounts ?? {}, skipKey)
  out.models = mergeCounterMap(left.models ?? {}, right.models ?? {})
  out.accountModels = mergeCounterMap(left.accountModels ?? {}, right.accountModels ?? {}, skipKey)
  out.accountModelToday = sameDay
    ? mergeCounterMap(left.accountModelToday ?? {}, right.accountModelToday ?? {}, skipKey)
    : (rightDate > leftDate ? filterKeyed(right.accountModelToday, skipKey) : { ...left.accountModelToday })
  out.daily = mergeCounterMap(left.daily ?? {}, right.daily ?? {})
  out.providerDaily = mergeCounterMap(left.providerDaily ?? {}, right.providerDaily ?? {})
  out.sessions = mergeCounterMap(left.sessions ?? {}, right.sessions ?? {})
  out.providerSessions = mergeCounterMap(left.providerSessions ?? {}, right.providerSessions ?? {})
  const seen = new Set()
  const recent = []
  for (const entry of [...(right.recent ?? []), ...(left.recent ?? [])]) {
    if (entry === null || typeof entry !== 'object') continue
    // 已删除账号的历史请求也不该被合并回「最近请求」列表。
    if (skipKey !== undefined && typeof entry.accountId === 'string'
      && skipKey(`${String(entry.provider)}::${entry.accountId}`)) continue
    const key = `${String(entry.at)}|${String(entry.provider)}|${String(entry.accountId)}|${String(entry.model)}|${String(entry.kind)}|${String(entry.durationMs)}`
    if (seen.has(key)) continue
    seen.add(key)
    recent.push(entry)
  }
  recent.sort((a, b) => (num(b.at) || 0) - (num(a.at) || 0))
  out.recent = recent.slice(0, RECENT_LIMIT)
  return out
}

/**
 * 一次请求的统计记录。
 * @typedef {object} StatsEntry
 * @property {string} provider
 * @property {string} accountId
 * @property {string} [sessionId] - DSH 会话 id（有就记，用于「本轮会话」）。
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
    /** 有没有真正改动过：只读命令（status/usage）stop 时不应该重写文件。 */
    this.dirty = false
    /** 磁盘上是本插件不认识的版本：只读展示，拒绝写回（避免降级清空）。 */
    this.writeBlocked = false
    this.unsupportedVersion = undefined
    /** 本地刚执行过 reset：落盘时不能被另一个进程的旧文档合并回来。 */
    this.resetPending = false
    /**
     * 本地已删除的账号（键与键前缀）：落盘前合并外部快照时不能把它们复活。
     * 账号被删后，另一个窗口只要写过一次统计，`mergeCounterMap()` 的键并集
     * 就会把旧条目带回来 —— 用户看到「删了账号，它的用量又出现了」。
     */
    this.forgotten = new Set()
    this.forgottenPrefixes = new Set()
    this.data = this.#load()
    // 记下读盘时的 mtime + size：flush 前据此判断「另一个进程是不是刚重置过」。
    this.diskStamp = this.#stamp()
  }

  /** 读盘；坏文件安静退化成空统计。 */
  #load() {
    const fallback = this.#blank()
    const raw = readJsonFile(this.filePath)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fallback
    // 只接受本插件写过的版本：v1/v2/v3 升级时保留已有维度，新维度从下一次
    // 请求开始累积。**不要**把 v3 排除在外 —— 现有用户的累计/今日/每日历史
    // 会整份归零，而 v3 与 v4 只差一个「账号 × 模型」块。
    // 更新/未知版本则只读加载：否则一条 `bin.js usage` 就会把降级后的文件清零。
    if (raw.version !== undefined && raw.version !== 1 && raw.version !== 2 && raw.version !== 3 && raw.version !== VERSION) {
      this.writeBlocked = true
      this.unsupportedVersion = raw.version
      return fallback
    }
    const data = fallback
    data.since = num(raw.since) > 0 ? num(raw.since) : this.now()
    data.totals = normalizeCounters(raw.totals)
    const todayKey = dayKey(this.now())
    // 判据看**文件里**写的日期（`raw.today.date`），不是内存里归一化后的值 ——
    // 后者在 `today` 缺失/损坏时会被填成「今天」，从而把昨天的今日桶复活。
    const fileTodayKey = raw.today !== null && typeof raw.today === 'object' && !Array.isArray(raw.today)
      ? raw.today.date
      : undefined
    if (raw.today !== null && typeof raw.today === 'object' && !Array.isArray(raw.today)) {
      data.today = { ...normalizeCounters(raw.today), date: typeof raw.today.date === 'string' ? raw.today.date : todayKey }
      if (data.today.date !== todayKey) {
        data.today = { ...emptyCounters(), date: todayKey }
        data.providerToday = Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, emptyCounters()]))
      }
    }
    if (raw.providers !== null && typeof raw.providers === 'object' && !Array.isArray(raw.providers)) {
      for (const provider of PROVIDER_IDS) {
        if (raw.providers[provider] !== undefined) data.providers[provider] = normalizeCounters(raw.providers[provider])
      }
    }
    // providerToday 与 accountModelToday 用同一道门：文件里的「今日」不是今天
    // （或根本没有今日块）就整份丢，否则卡片上方的「今日」与标签页会互相矛盾。
    if (fileTodayKey === todayKey && raw.providerToday !== null && typeof raw.providerToday === 'object' && !Array.isArray(raw.providerToday)) {
      for (const provider of PROVIDER_IDS) {
        if (raw.providerToday[provider] !== undefined) data.providerToday[provider] = normalizeCounters(raw.providerToday[provider])
      }
    }
    if (raw.accounts !== null && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)) {
      for (const [key, value] of freshestEntries(raw.accounts, ACCOUNT_LIMIT)) {
        if (key === '') continue
        data.accounts[key] = normalizeCounters(value)
      }
    }
    if (raw.models !== null && typeof raw.models === 'object' && !Array.isArray(raw.models)) {
      for (const [key, value] of freshestEntries(raw.models, MODEL_LIMIT)) {
        if (key === '') continue
        data.models[key] = normalizeCounters(value)
      }
    }
    // v4：「账号 × 模型」交叉维度。老文件没有这一块，升级后从下一次请求开始
    // 累积 —— 无法从两份独立的计数里反推出交叉值，所以不做回填。
    if (raw.accountModels !== null && typeof raw.accountModels === 'object' && !Array.isArray(raw.accountModels)) {
      for (const [key, value] of freshestEntries(raw.accountModels, ACCOUNT_MODEL_LIMIT)) {
        if (!isAccountModelKey(key)) continue
        data.accountModels[key] = normalizeCounters(value)
      }
    }
    // 「今日」那一份：跨天时整份丢掉，不然会和上方「今日 1,159 次」打架。
    // 判据同样是文件里的日期（与上面的 fileTodayKey 一致）。
    if (fileTodayKey === todayKey
      && raw.accountModelToday !== null && typeof raw.accountModelToday === 'object' && !Array.isArray(raw.accountModelToday)) {
      for (const [key, value] of freshestEntries(raw.accountModelToday, ACCOUNT_MODEL_LIMIT)) {
        if (!isAccountModelKey(key)) continue
        data.accountModelToday[key] = normalizeCounters(value)
      }
    }
    if (raw.daily !== null && typeof raw.daily === 'object' && !Array.isArray(raw.daily)) {
      const entries = Object.entries(raw.daily)
        .filter(([key]) => /^\d{4}-\d{2}-\d{2}$/.test(key))
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-DAILY_LIMIT)
      for (const [key, value] of entries) data.daily[key] = normalizeCounters(value)
    }
    // v1 没有每日历史：把今天的累计值补成一条，至少热力图第一天不空。
    if (Object.keys(data.daily).length === 0 && data.today.requests > 0) {
      data.daily[data.today.date] = { ...data.today }
      delete data.daily[data.today.date].date
    }
    if (raw.providerDaily !== null && typeof raw.providerDaily === 'object' && !Array.isArray(raw.providerDaily)) {
      // 同上：按**日期**保留最新，而不是按文件里的写入顺序。旧实现用
      // `.slice(0, 6×30)` 取前 N 条，超过上限后重启一次就把最近的每日桶丢掉，
      // 各 provider 标签页的热力图会突然退回到一个多月前。
      for (const [provider, entries] of newestProviderDays(raw.providerDaily, DAILY_LIMIT)) {
        for (const [date, value] of entries) data.providerDaily[`${provider}::${date}`] = normalizeCounters(value)
      }
    }
    // v2 没有按 provider 的每日历史：把今天的 providerToday 补成第一条，
    // 至少升级当天的标签页热力图不是空的（更早的日期无法反推）。
    for (const provider of PROVIDER_IDS) {
      const key = `${provider}::${data.today.date}`
      if (data.providerDaily[key] !== undefined) continue
      const today = data.providerToday[provider]
      if (today !== undefined && today.requests > 0) data.providerDaily[key] = { ...today }
    }
    if (raw.sessions !== null && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)) {
      for (const [key, value] of freshestEntries(raw.sessions, SESSION_LIMIT)) {
        if (key === '' || key === 'undefined') continue
        data.sessions[key] = normalizeCounters(value)
      }
    }
    if (raw.providerSessions !== null && typeof raw.providerSessions === 'object' && !Array.isArray(raw.providerSessions)) {
      for (const [key, value] of freshestEntries(raw.providerSessions, PROVIDER_SESSION_LIMIT)) {
        if (!isProviderSessionKey(key)) continue
        data.providerSessions[key] = normalizeCounters(value)
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
      /** `${provider}::${accountId}::${model}` → 计数器：「哪个账号用了哪个模型、多少 token」。 */
      accountModels: {},
      /** 同一维度但只算今天：卡片上方的「今日」与它并排，口径必须一致。 */
      accountModelToday: {},
      daily: {},
      /** `${provider}::${YYYY-MM-DD}` → 计数器，给各 provider 标签页画自己的热力图。 */
      providerDaily: {},
      sessions: {},
      /** `${sessionId}::${provider}` → 计数器，避免 Qoder 标签页显示 WorkBuddy 的会话。 */
      providerSessions: {},
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

  /** 日切：跨过本机午夜时只清「今日」那几个维度，累计一律不动。 */
  #rollDay(at) {
    const key = dayKey(at)
    if (this.data.today.date === key) return false
    // 允许**双向**切换。
    //
    // 旧实现只允许向前翻（`if (key < today.date) return false`），理由是
    // 「调用方传入更早的 at 不能把当前今日桶清掉」。但那让一次向前跳的时钟
    // （NTP 校正、虚拟机快照恢复、用户手动改日期）把今日桶永久打上未来日期：
    // 时钟回到今天后，桶既不回退也不清空，两天数据继续累加进那个未来日期，
    // `daily` 还会多出一条幽灵日期。
    //
    // 现在的判据是「这个 `at` 属于哪一天」：跨天就换桶，与方向无关。
    // 时钟回拨只是让今天重新从 0 开始计数 —— 比把今天的数据记到两天后正确。
    // 已经落进 `daily` 的历史不受影响（那是按 date 分桶的累计）。
    this.data.today = { ...emptyCounters(), date: key }
    this.data.providerToday = Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, emptyCounters()]))
    // 交叉维度的「今日」也要清，否则它会跨天累加，和上方「今日」对不上。
    this.data.accountModelToday = {}
    this.dirty = true
    return true
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
    // 换桶按**进程自己的时钟**判，而不是按这条记录的时间戳。
    //
    // 两者不是一回事：补记/回放一条更早的请求（`entry.at` 是昨天）不该把今天
    // 的今日桶清空 —— 那条记录仍然属于「今天这次运行看到的今日」。而系统时钟
    // 本身跨天（含向前跳后又被 NTP 校正回来）必须换桶，否则今日桶会被永久
    // 钉在一个未来日期上。
    if (this.#rollDay(this.now())) this.#schedule()
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
    const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId.slice(0, 100) : ''
    const code = typeof entry.code === 'string' ? entry.code.slice(0, 80) : ''
    const message = typeof entry.message === 'string' ? entry.message.slice(0, 500) : ''
    // 这个账号重新产生了新数据：先前「删除后不要再复活」的记忆到此失效，
    // 否则新账号（id 不复用，但极端情况下旧文件可能重名）会永远看不到统计。
    if (this.forgotten.size > 0) {
      this.forgotten.delete(`${provider}::${accountId}`)
      this.forgottenPrefixes.delete(`${provider}::${accountId}::`)
    }

    const buckets = [
      this.data.totals,
      this.data.today,
      this.data.providers[provider] ?? (this.data.providers[provider] = emptyCounters()),
      this.data.providerToday[provider] ?? (this.data.providerToday[provider] = emptyCounters()),
      this.data.accounts[`${provider}::${accountId}`] ?? (this.data.accounts[`${provider}::${accountId}`] = emptyCounters()),
    ]
    if (model !== '') {
      buckets.push(this.data.models[`${provider}::${model}`] ?? (this.data.models[`${provider}::${model}`] = emptyCounters()))
      // 「哪个账号、用了哪个模型、花了多少 token」是用户唯一真正问的那一维。
      // 只在有模型 id 时记：空模型行的交叉项没有意义，还会占满上限。
      const pairKey = accountModelKey(provider, accountId, model)
      buckets.push(this.data.accountModels[pairKey] ?? (this.data.accountModels[pairKey] = emptyCounters()))
      // 今日口径必须单独记一份：卡片上方写的是「今日 1,159 次」，如果交叉表
      // 只给累计，两处数字永远对不上（交叉维度从升级后才开始累积，累计值
      // 天然比历史总量小）。用户要的是「今天谁在烧」，不是「有史以来」。
      buckets.push(this.data.accountModelToday[pairKey] ?? (this.data.accountModelToday[pairKey] = emptyCounters()))
    }
    // 每日历史按本机日期分桶；会话历史按 DSH 传入的 sessionId 分桶。
    // 另外各记一份按 provider 拆开的维度：卡片是按 provider 分标签页展示的，
    // 拿全局 daily/currentSession 会显示成「WorkBuddy 的会话挂在 Qoder 标签页上」。
    const date = dayKey(at)
    buckets.push(this.data.daily[date] ?? (this.data.daily[date] = emptyCounters()))
    buckets.push(this.data.providerDaily[`${provider}::${date}`] ?? (this.data.providerDaily[`${provider}::${date}`] = emptyCounters()))
    if (sessionId !== '') {
      buckets.push(this.data.sessions[sessionId] ?? (this.data.sessions[sessionId] = emptyCounters()))
      buckets.push(this.data.providerSessions[`${sessionId}::${provider}`] ?? (this.data.providerSessions[`${sessionId}::${provider}`] = emptyCounters()))
    }

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
      ...(sessionId === '' ? {} : { sessionId }),
      model,
      kind,
      ...(code === '' ? {} : { code }),
      ...(message === '' ? {} : { message }),
      durationMs: Math.round(duration),
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output + cacheRead + cacheWrite,
    })
    if (this.data.recent.length > RECENT_LIMIT) this.data.recent.length = RECENT_LIMIT

    this.#prune()
    this.dirty = true
    this.#schedule()
    return true
  }

  /**
   * 删除某个账号在所有维度里的统计（账号被删掉时调用）。
   *
   * 账号 id 现在不再复用，但旧数据仍可能把「新账号」和「已删账号」混在一起；
   * 主动清掉比让新账号继承旧余额/用量更安全。
   *
   * 关键：删完立刻 `flush()` 会先走 `#adoptExternalReset()`，而普通外部写入
   * 是用 `mergeCounterMap()` 做**键并集**的 —— 只要另一个窗口在这之前写过一次
   * 统计（磁盘 mtime 变了），刚删掉的 `accounts` / `accountModels` /
   * `accountModelToday` 条目就会被原样合并回来，界面表现为「删了账号，
   * 过一会儿它的用量又出现了」。
   *
   * 所以这里把被删的键记进 `forgotten`，合并时跳过它们（与
   * `credit-history.js` 的 `this.forgotten` 同一套做法）。只有该账号重新产生
   * 统计数据时才撤销记忆 —— 那时它已经是「新数据」了。
   *
   * @param provider - provider id。
   * @param accountId - 账号 id。
   * @returns 是否删掉了东西。
   */
  forgetAccount(provider, accountId) {
    if (typeof provider !== 'string' || typeof accountId !== 'string' || accountId === '') return false
    const accountKey = `${provider}::${accountId}`
    const pairPrefix = `${accountKey}::`
    let changed = false
    if (this.data.accounts[accountKey] !== undefined) {
      delete this.data.accounts[accountKey]
      changed = true
    }
    for (const map of [this.data.accountModels, this.data.accountModelToday]) {
      for (const key of Object.keys(map)) {
        if (!key.startsWith(pairPrefix)) continue
        delete map[key]
        changed = true
      }
    }
    if (changed) {
      this.forgotten.add(accountKey)
      this.forgottenPrefixes.add(pairPrefix)
      this.dirty = true
      this.flush()
    }
    return changed
  }

  /** 这个键是否属于「本地已删除、合并时不能再复活」的账号。 */
  #isForgotten(key) {
    if (this.forgotten.size === 0) return false
    if (this.forgotten.has(key)) return true
    for (const prefix of this.forgottenPrefixes) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }

  /** 控制各维度的体积：模型/账号/会话/账号×模型按最近使用时间淘汰，每日按日期淘汰。 */
  #prune() {
    for (const [key, map, limit] of [
      ['models', this.data.models, MODEL_LIMIT],
      ['accounts', this.data.accounts, ACCOUNT_LIMIT],
      ['accountModels', this.data.accountModels, ACCOUNT_MODEL_LIMIT],
      ['accountModelToday', this.data.accountModelToday, ACCOUNT_MODEL_LIMIT],
      ['sessions', this.data.sessions, SESSION_LIMIT],
      ['providerSessions', this.data.providerSessions, PROVIDER_SESSION_LIMIT],
    ]) {
      const entries = Object.entries(map)
      if (entries.length <= limit) continue
      entries.sort((a, b) => (b[1].lastAt ?? 0) - (a[1].lastAt ?? 0))
      this.data[key] = Object.fromEntries(entries.slice(0, limit))
    }
    const days = Object.keys(this.data.daily)
    if (days.length > DAILY_LIMIT) {
      days.sort()
      for (const day of days.slice(0, days.length - DAILY_LIMIT)) delete this.data.daily[day]
    }
    // 按 provider 的每日桶与全局每日桶同步淘汰，避免只涨不删。
    for (const provider of PROVIDER_IDS) {
      const prefix = `${provider}::`
      const keys = Object.keys(this.data.providerDaily).filter((key) => key.startsWith(prefix))
      if (keys.length <= DAILY_LIMIT) continue
      keys.sort((a, b) => a.slice(prefix.length).localeCompare(b.slice(prefix.length)))
      for (const key of keys.slice(0, keys.length - DAILY_LIMIT)) delete this.data.providerDaily[key]
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

  /** 当前磁盘文件的 mtime + size（读不到返回 undefined）。 */
  #stamp() {
    try {
      const stat = statSync(this.filePath)
      return { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      return undefined
    }
  }

  /**
   * 落盘前看磁盘有没有被另一个进程改过。
   *
   * - 另一个进程做了 `stats-reset`（`since` 更新）→ 采纳空文档；
   * - 普通写入 → 按字段 max 合并，避免宿主与 CLI（或两个窗口）互相覆盖。
   *
   * @returns `'reset' | 'merged' | false`。
   */
  #adoptExternalReset() {
    const stamp = this.#stamp()
    if (stamp === undefined) return false
    const previous = this.diskStamp
    this.diskStamp = stamp
    if (previous !== undefined && stamp.mtimeMs === previous.mtimeMs && stamp.size === previous.size) return false
    const raw = readJsonFile(this.filePath)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
    if (raw.version !== undefined && raw.version !== VERSION) {
      // 磁盘被更新版本的插件写过：不要用旧格式覆盖它。
      if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) {
        this.writeBlocked = true
        this.unsupportedVersion = raw.version
        return false
      }
      return false
    }
    const since = num(raw.since)
    if (since > this.data.since) {
      this.data = this.#blank()
      this.data.since = since
      return 'reset'
    }
    // 普通外部写入：构造一个只读实例把磁盘文档归一化，再合并进来。
    try {
      const external = new Stats({
        filePath: this.filePath,
        enabled: () => false,
        now: this.now,
        persistDelayMs: 0,
      })
      this.data = mergeStatsData(this.data, external.data, { skipKey: (key) => this.#isForgotten(key) })
      return 'merged'
    } catch {
      return false
    }
  }

  /** 立即写盘。 */
  flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.writeBlocked) return false
    // 本地刚 reset 过：这是一次**主动清空**，不是普通写入。若仍然走
    // #adoptExternalReset()，另一个进程在这之前写的旧文档 since 更小，会被
    // mergeStatsData 按 max 合并回来 —— 用户点了「重置统计」，旧数字原样复活。
    // 所以 reset 后的第一次成功落盘直接写空白文档，让其它进程下次采纳。
    if (this.resetPending !== true) {
      // 外部已经重置过：先采纳，避免把旧快照写回去。
      const external = this.#adoptExternalReset()
      if (external === 'reset') this.dirty = false
      if (external === 'merged') this.dirty = true
    }
    // 只读命令没改过任何东西时不要重写文件 —— 一次 `bin.js usage` 不该刷新
    // mtime，更不该把另一个进程刚写的计数覆盖回去。
    if (!this.dirty) return true
    const ok = writeJsonAtomic(this.filePath, this.data)
    if (ok) {
      this.dirty = false
      this.resetPending = false
    }
    this.diskStamp = this.#stamp()
    return ok
  }

  /** 清空统计（用户点「重置统计」时调用）。 */
  reset() {
    this.data = this.#blank()
    this.dirty = true
    // 写盘失败时 resetPending 会保留，下一次 flush 仍按「主动清空」处理，
    // 不能因为一次失败就让旧数字在后续合并里复活。
    this.resetPending = true
    if (this.flush() !== true) throw new Error(`统计数据写入失败：${this.filePath}`)
    return this.snapshot()
  }

  /** 停止定时器并落盘。 */
  stop() {
    return this.flush()
  }

  /** 该 provider 的健康状态。 */
  healthFor(provider) {
    return healthOf(this.data.providers[provider], this.now())
  }

  /** 该 provider 的用量快照。 */
  providerSnapshot(provider) {
    if (this.#rollDay(this.now())) this.#schedule()
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
    // 午夜后即使没有任何新请求，卡片轮询也要看到「今日」归零，而不是昨天的数字。
    if (this.#rollDay(this.now())) this.#schedule()
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
    // 「账号 × 模型」：保留三段字段，卡片才能直接渲染成
    // 「账号 A · 模型 X · 12 次 · 3.2M tok」而不必自己拆键。
    const accountModels = {}
    for (const [key, value] of Object.entries(this.data.accountModels)) {
      const parsed = parseAccountModelKey(key)
      if (parsed === undefined) continue
      accountModels[key] = { ...parsed, ...derived(value) }
    }
    // 「今日」那一份同样拆好三段。卡片默认显示这一份 —— 它和上方的
    // 「今日 1,159 次 / 366M tokens」是同一个口径，能直接对上。
    const accountModelToday = {}
    for (const [key, value] of Object.entries(this.data.accountModelToday)) {
      const parsed = parseAccountModelKey(key)
      if (parsed === undefined) continue
      accountModelToday[key] = { ...parsed, ...derived(value) }
    }
    const daily = Object.keys(this.data.daily).sort().map((date) => ({ date, ...derived(this.data.daily[date]) }))
    const sessions = {}
    let currentSession
    for (const [id, value] of Object.entries(this.data.sessions)) {
      const row = derived(value)
      sessions[id] = row
      if (currentSession === undefined || row.lastAt > currentSession.lastAt) currentSession = { id, ...row }
    }
    // 按 provider 拆开的每日/会话视图。卡片是按 provider 分标签页的，
    // 直接把全局 daily/sessions 塞进每个标签页会串台。
    const providerDaily = {}
    const providerCurrentSession = {}
    for (const provider of PROVIDER_IDS) {
      const prefix = `${provider}::`
      const rows = []
      for (const [key, value] of Object.entries(this.data.providerDaily)) {
        if (!key.startsWith(prefix)) continue
        rows.push({ date: key.slice(prefix.length), ...derived(value) })
      }
      rows.sort((a, b) => a.date.localeCompare(b.date))
      providerDaily[provider] = rows

      let latest
      for (const [key, value] of Object.entries(this.data.providerSessions)) {
        const separator = key.lastIndexOf('::')
        if (separator <= 0 || key.slice(separator + 2) !== provider) continue
        const row = derived(value)
        const id = key.slice(0, separator)
        if (latest === undefined || row.lastAt > latest.lastAt) latest = { id, ...row }
      }
      if (latest !== undefined) providerCurrentSession[provider] = latest
    }
    return {
      enabled: this.#on(),
      since: this.data.since,
      totals: derived(this.data.totals),
      today: { ...derived(this.data.today), date: this.data.today.date },
      providers,
      providerToday,
      accounts,
      models,
      accountModels,
      accountModelToday,
      daily,
      providerDaily,
      sessions,
      providerSessions: Object.fromEntries(Object.entries(this.data.providerSessions).map(([key, value]) => [key, derived(value)])),
      currentSession,
      providerCurrentSession,
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
