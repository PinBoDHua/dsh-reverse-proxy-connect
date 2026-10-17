/**
 * 额度历史：把「还剩多少」变成「花得多快、还能撑多久」。
 *
 * 1.0.x 只保存当前额度快照，因此卡片只能回答「现在剩 675」，
 * 回答不了「今天用掉多少」「按这个速度还能用几小时」。这一版在每次成功读取
 * 额度后记一个样本，并做两件事：
 *
 * - **按本地自然日/最近 7 天累计下降量**。只看「窗口首尾差额」会在充值当天
 *   算出负数（余额涨了），所以这里逐段累加**下降量**，充值那一跳单独记为 topup。
 * - **按最近一段时间的消耗速度估算耗尽时间**。速度只用最近 6 小时内的下降量，
 *   并且要求跨度至少 10 分钟 —— 两个相邻样本的差值太容易被一次刷新抖动放大。
 *
 * 数据量刻意压得很小：每个账号最多 60 个原始点（约 2 小时）+ 168 个小时桶
 * （7 天），磁盘文件通常只有几 KB。额度读取每 2 分钟一次，但同一小时内只留
 * 一个桶，所以不会无限增长。
 *
 * @module dsh-reverse-proxy-connect/credit-history
 */

import { readJsonFile, writeJsonAtomic } from './atomic.js'
import { dayKey } from './stats.js'
import { join } from 'node:path'

/** 文件名。 */
const FILE = 'credits-history.json'

/** 文件格式版本。 */
const VERSION = 1

/** 每个账号保留的原始样本（约 2 小时）。 */
const RECENT_LIMIT = 60

/** 每个账号保留的小时桶（7 天）。 */
const HOUR_LIMIT = 168

/** 估算消耗速度时最多回看多久。 */
const BURN_WINDOW_MS = 6 * 3600_000

/** 估算消耗速度所需的最小时间跨度。 */
const BURN_MIN_SPAN_MS = 10 * 60_000

/** 两个样本间隔小于这个值视为同一次刷新。 */
const DUPLICATE_WINDOW_MS = 30_000

/** 写盘去抖。 */
const PERSIST_DELAY_MS = 1500

/** 小时桶长度。 */
const HOUR_MS = 3600_000

/** 数字：只接受有限非负数。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 空样本。 */
function emptySample() {
  return { at: 0, remain: 0, total: 0 }
}

/** 空趋势。 */
export function emptyTrend() {
  return {
    points: [],
    spentToday: 0,
    spent7d: 0,
    topupToday: 0,
    topup7d: 0,
    burnPerHour: undefined,
    etaMs: undefined,
    sampleCount: 0,
    lastAt: 0,
    firstAt: 0,
  }
}

/**
 * 归一化一份历史条目（容忍手改/旧版本）。
 *
 * @param raw - 原始条目。
 * @returns 归一化后的条目。
 */
export function normalizeHistoryEntry(raw) {
  const entry = { recent: [], hours: [] }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return entry
  if (Array.isArray(raw.recent)) {
    for (const point of raw.recent.slice(-RECENT_LIMIT)) {
      if (point === null || typeof point !== 'object') continue
      const at = num(point.at)
      const remain = num(point.remain)
      if (at === undefined || remain === undefined) continue
      entry.recent.push({ at, remain, total: num(point.total) ?? 0 })
    }
  }
  if (Array.isArray(raw.hours)) {
    for (const hour of raw.hours.slice(-HOUR_LIMIT)) {
      if (hour === null || typeof hour !== 'object') continue
      const at = num(hour.at)
      const first = num(hour.first)
      const last = num(hour.last)
      if (at === undefined || first === undefined || last === undefined) continue
      entry.hours.push({
        at,
        first,
        last,
        spent: num(hour.spent) ?? 0,
        topup: num(hour.topup) ?? 0,
        samples: num(hour.samples) ?? 0,
      })
    }
  }
  entry.recent.sort((a, b) => a.at - b.at)
  entry.hours.sort((a, b) => a.at - b.at)
  return entry
}

/**
 * 记一个额度样本。纯函数，返回**新的**条目。
 *
 * @param rawEntry - 现有条目（可为 undefined）。
 * @param sample - `{at, remain, total}`。
 * @returns 更新后的条目。
 */
export function recordSample(rawEntry, sample) {
  const at = num(sample?.at)
  const remain = num(sample?.remain)
  if (at === undefined || remain === undefined) return normalizeHistoryEntry(rawEntry)
  const total = num(sample?.total) ?? 0
  const entry = normalizeHistoryEntry(rawEntry)
  const previous = entry.recent[entry.recent.length - 1]
  // 时钟回拨时保持样本有序；否则后面所有按时间做的计算都会得到负跨度。
  // 加 1ms 而不是直接夹到上一个时间点：否则这次下降会被当成重复刷新丢掉。
  const rolledBack = previous !== undefined && at < previous.at
  const stamp = rolledBack ? previous.at + 1 : at

  if (!rolledBack && previous !== undefined && stamp - previous.at < DUPLICATE_WINDOW_MS) {
    // 同一次刷新（或极短时间内的重复调用）：只更新数值，不重复累计消耗。
    previous.remain = remain
    previous.total = total
    return entry
  }

  const previousRemain = previous?.remain
  entry.recent.push({ at: stamp, remain, total })
  if (entry.recent.length > RECENT_LIMIT) entry.recent.splice(0, entry.recent.length - RECENT_LIMIT)

  const hourStart = Math.floor(stamp / HOUR_MS) * HOUR_MS
  const lastHour = entry.hours[entry.hours.length - 1]
  if (lastHour !== undefined && lastHour.at === hourStart) {
    if (previousRemain !== undefined) {
      lastHour.spent += Math.max(0, previousRemain - remain)
      lastHour.topup += Math.max(0, remain - previousRemain)
    }
    lastHour.last = remain
    lastHour.samples += 1
  } else {
    // 跨小时时把「上一小时最后一个值 → 这一小时第一个值」的下降算进新桶，
    // 否则每小时边界都会漏掉一段消耗。间隔超过 2 小时视为断档，不猜。
    const gap = previous !== undefined ? stamp - previous.at : 0
    const first = previousRemain !== undefined && gap <= 2 * HOUR_MS ? previousRemain : remain
    entry.hours.push({
      at: hourStart,
      first,
      last: remain,
      spent: previousRemain !== undefined && gap <= 2 * HOUR_MS ? Math.max(0, previousRemain - remain) : 0,
      topup: previousRemain !== undefined && gap <= 2 * HOUR_MS ? Math.max(0, remain - previousRemain) : 0,
      samples: 1,
    })
  }
  if (entry.hours.length > HOUR_LIMIT) entry.hours.splice(0, entry.hours.length - HOUR_LIMIT)
  return entry
}

/**
 * 计算一份历史条目的趋势。
 *
 * @param rawEntry - 历史条目。
 * @param options - `{ now? }`。
 * @returns 趋势（可直接进 /status）。
 */
export function summarizeHistory(rawEntry, options = {}) {
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now()
  const entry = normalizeHistoryEntry(rawEntry)
  const trend = emptyTrend()
  if (entry.recent.length === 0 && entry.hours.length === 0) return trend

  const today = dayKey(now)
  const weekStart = now - 7 * 24 * 3600_000
  for (const hour of entry.hours) {
    if (dayKey(hour.at) === today) {
      trend.spentToday += hour.spent
      trend.topupToday += hour.topup
    }
    if (hour.at >= weekStart) {
      trend.spent7d += hour.spent
      trend.topup7d += hour.topup
    }
    trend.sampleCount += hour.samples
    if (trend.firstAt === 0 || hour.at < trend.firstAt) trend.firstAt = hour.at
    if (hour.at > trend.lastAt) trend.lastAt = hour.at
  }

  trend.points = entry.recent.map((point) => ({ at: point.at, remain: point.remain }))
  const lastPoint = entry.recent[entry.recent.length - 1]
  if (lastPoint !== undefined) {
    trend.lastAt = Math.max(trend.lastAt, lastPoint.at)
    if (trend.firstAt === 0) trend.firstAt = lastPoint.at
  }

  // 消耗速度：优先用最近 6 小时内的原始点。原始点只保留约 2 小时，所以
  // 大多数情况下时间跨度会不足；不足时退到小时桶。
  const recent = entry.recent.filter((point) => point.at >= now - BURN_WINDOW_MS)
  let spent = 0
  let firstAt = 0
  let lastAt = 0
  for (let index = 1; index < recent.length; index++) {
    const previous = recent[index - 1]
    const current = recent[index]
    spent += Math.max(0, previous.remain - current.remain)
    if (firstAt === 0) firstAt = previous.at
    lastAt = current.at
  }
  if (lastAt - firstAt >= BURN_MIN_SPAN_MS && spent > 0) {
    trend.burnPerHour = spent / ((lastAt - firstAt) / HOUR_MS)
  } else {
    const hours = entry.hours.filter((hour) => hour.at >= now - BURN_WINDOW_MS)
    spent = 0
    firstAt = 0
    lastAt = 0
    for (const hour of hours) {
      spent += hour.spent
      if (firstAt === 0) firstAt = hour.at
      lastAt = hour.at + HOUR_MS
    }
    if (lastAt - firstAt >= BURN_MIN_SPAN_MS && spent > 0) trend.burnPerHour = spent / ((lastAt - firstAt) / HOUR_MS)
  }

  const remain = lastPoint?.remain
  if (typeof remain === 'number' && remain > 0 && typeof trend.burnPerHour === 'number' && trend.burnPerHour > 0) {
    const eta = (remain / trend.burnPerHour) * HOUR_MS
    // 超过一年就不显示：那说明速度样本太小，给个数字反而误导。
    if (Number.isFinite(eta) && eta < 365 * 24 * HOUR_MS) trend.etaMs = Math.round(eta)
  }
  trend.spentToday = Math.round(trend.spentToday * 10) / 10
  trend.spent7d = Math.round(trend.spent7d * 10) / 10
  trend.topupToday = Math.round(trend.topupToday * 10) / 10
  trend.topup7d = Math.round(trend.topup7d * 10) / 10
  if (typeof trend.burnPerHour === 'number') trend.burnPerHour = Math.round(trend.burnPerHour * 100) / 100
  return trend
}

/** 凭证历史文件的绝对路径。 */
export function creditsHistoryPathOf(dataDir) {
  return join(dataDir, FILE)
}

/**
 * 额度历史存储。
 *
 * 旁路组件：任何读盘/写盘失败都不影响聊天与额度读取。
 */
export class CreditHistory {
  /**
   * @param options - `{filePath, now?, persistDelayMs?}`。
   */
  constructor(options) {
    this.filePath = options.filePath
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.persistDelayMs = typeof options.persistDelayMs === 'number' ? options.persistDelayMs : PERSIST_DELAY_MS
    this.timer = undefined
    this.dirty = false
    this.data = this.#load()
  }

  /** 读盘。 */
  #load() {
    const raw = readJsonFile(this.filePath)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { version: VERSION, entries: {} }
    if (raw.version !== undefined && raw.version !== VERSION) return { version: VERSION, entries: {} }
    const entries = {}
    if (raw.entries !== null && typeof raw.entries === 'object' && !Array.isArray(raw.entries)) {
      for (const [key, value] of Object.entries(raw.entries).slice(0, 32)) {
        if (typeof key !== 'string' || !key.includes('::')) continue
        const entry = normalizeHistoryEntry(value)
        if (entry.recent.length === 0 && entry.hours.length === 0) continue
        entries[key] = entry
      }
    }
    return { version: VERSION, entries }
  }

  /** 记一次成功读取的额度快照。 */
  record(provider, accountId, credits, at) {
    if (credits === undefined || credits === null || credits.state !== 'ok') return false
    if (credits.unlimited === true) return false
    const remain = num(credits.remain)
    if (remain === undefined) return false
    const key = `${provider}::${accountId}`
    const stamp = typeof at === 'number' && Number.isFinite(at) ? at : this.now()
    const previous = this.data.entries[key]
    const next = recordSample(previous, {
      at: stamp,
      remain,
      total: num(credits.total) ?? 0,
    })
    this.data.entries[key] = next
    this.dirty = true
    // 额度每 2 分钟才刷新一次，文件只有几 KB：直接落盘，避免 CLI 进程
    // 在去抖计时器触发前退出而丢掉刚记的样本。
    this.flush()
    return true
  }

  /** 某个账号的趋势。 */
  trendFor(provider, accountId) {
    return summarizeHistory(this.data.entries[`${provider}::${accountId}`], { now: this.now() })
  }

  /** 当前历史（给诊断/测试）。 */
  snapshot() {
    return { version: VERSION, entries: this.data.entries }
  }

  /** 立即落盘。 */
  flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.dirty) return false
    this.dirty = false
    return writeJsonAtomic(this.filePath, this.data, { pretty: false })
  }

  /** 停止并落盘。 */
  stop() {
    return this.flush()
  }
}
