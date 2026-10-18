/**
 * 事件账本：把「刚刚发生了什么」留下来，而不是只留在进程日志里。
 *
 * ## 为什么需要它
 * 这个插件会在后台做很多用户看不见的事：令牌快到期自动续期、额度耗尽自动换号、
 * 目录拉取失败退回磁盘缓存、签到失败 10 分钟后重试…… 出问题时用户只能看到
 * 一个结果（「怎么换账号了」「额度怎么又读不到了」），而原因已经随着日志轮转消失。
 *
 * 事件账本是一份**有上限、可持久化、带脱敏边界**的时间线：
 *
 * - 只记**元数据**（类型 / 级别 / provider / 账号 / 一句人话 / 少量数字），
 *   不记请求内容、不记令牌、不记完整上游响应；
 * - 内存里最多留 {@link EVENT_LIMIT} 条，落盘只留最近 {@link PERSIST_LIMIT} 条，
 *   所以文件不会跟着插件跑几年越长越大；
 * - 写盘失败绝不影响主流程（与统计同一原则）；
 * - 相同事件在一个时间窗内会去重，避免后台轮询把账本刷满。
 *
 * @module dsh-reverse-proxy-connect/events
 */

import { join } from 'node:path'

import { readJsonFile, writeJsonAtomic } from './atomic.js'
import { PROVIDER_IDS } from './protocol.js'

/** 事件文件格式版本。 */
export const EVENT_VERSION = 1

/** 事件文件名。 */
export const EVENTS_FILE = 'events.json'

/** 内存里保留的事件条数。 */
export const EVENT_LIMIT = 200

/** 落盘保留的事件条数（比内存更少：文件只用于「重启后还能看最近发生了什么」）。 */
export const PERSIST_LIMIT = 100

/** 单条消息的最大长度（字符）。 */
const MESSAGE_LIMIT = 300

/** 单条附加数据的最大 JSON 长度（字符）。 */
const DATA_LIMIT = 1_200

/** 合法的事件级别。 */
export const EVENT_LEVELS = Object.freeze(['info', 'warn', 'error'])

/**
 * 已知事件类型（仅用于文档与筛选；未知类型会原样保留）。
 *
 * - `startup`            插件启动
 * - `account-switch`     自动/手动换号（含请求级失败切换）
 * - `credential-refresh` 令牌续期
 * - `credential`         凭证读取失败或恢复
 * - `catalog`            模型目录回退/恢复
 * - `credits`            额度读取失败或恢复
 * - `checkin`            签到结果
 * - `probe`              账号能力探测
 * - `login`              浏览器登录
 * - `settings`           设置写入
 * - `stats`              统计重置/关闭
 * - `test`               账号测试
 */
export const EVENT_TYPES = Object.freeze([
  'startup',
  'account-switch',
  'credential-refresh',
  'credential',
  'catalog',
  'credits',
  'checkin',
  'probe',
  'login',
  'settings',
  'stats',
  'events',
  'test',
])

/** 事件类型 → 文案键（客户端据此本地化；未知类型回落到消息本身）。 */
export function eventLabelKey(type) {
  switch (type) {
    case 'startup':
      return 'eventStartup'
    case 'account-switch':
      return 'eventSwitch'
    case 'credential-refresh':
      return 'eventRefresh'
    case 'credential':
      return 'eventCredential'
    case 'catalog':
      return 'eventCatalog'
    case 'credits':
      return 'eventCredits'
    case 'checkin':
      return 'eventCheckin'
    case 'probe':
      return 'eventProbe'
    case 'login':
      return 'eventLogin'
    case 'settings':
      return 'eventSettings'
    case 'stats':
      return 'eventStats'
    case 'events':
      return 'eventEvents'
    case 'test':
      return 'eventTest'
    default:
      return undefined
  }
}

/** 只保留可安全 JSON 化的简单值。 */
function plainValue(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') {
    const text = scrubSecretText(value)
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const list = value
      .map((item) => (typeof item === 'string' ? scrubSecretText(item).slice(0, 160) : typeof item === 'number' || typeof item === 'boolean' ? item : undefined))
      .filter((item) => item !== undefined)
      .slice(0, 12)
    return list.length === 0 ? undefined : list
  }
  return undefined
}

/**
 * 把消息里最像令牌的片段替换掉。
 *
 * 账本会进「复制诊断」，而错误消息可能来自上游、可能原样回显 URL 或请求头。
 * 这不是脱敏的替代品（真正的令牌根本不该进消息），只是一层兜底：
 * - `Bearer xxx` / `Authorization: xxx`
 * - JWT 形状的三段 base64url
 * - Qoder 的 `pt-…` 个人访问令牌
 *
 * @param value - 任意文本。
 * @returns 替换后的文本。
 */
export function scrubSecretText(value) {
  if (typeof value !== 'string' || value === '') return value
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '[redacted-jwt]')
    .replace(/\bpt-[A-Za-z0-9_-]{8,}\b/g, 'pt-[redacted]')
    .replace(/([?&](?:access_token|refresh_token|token|pat)=)[^&\s]+/gi, '$1[redacted]')
}

/**
 * 把附加数据收敛成「只含简单值、长度有上限」的对象。
 *
 * @param raw - 调用方给的任意值。
 * @returns 可安全落盘的对象，或 undefined。
 */
export function normalizeEventData(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || key === '' || key.length > 40) continue
    const normalized = plainValue(value)
    if (normalized !== undefined) out[key] = normalized
  }
  if (Object.keys(out).length === 0) return undefined
  try {
    return JSON.stringify(out).length <= DATA_LIMIT ? out : undefined
  } catch {
    return undefined
  }
}

/** 把消息裁短并去掉换行，保证一行能显示。 */
function normalizeMessage(raw, type) {
  const text = typeof raw === 'string' ? scrubSecretText(raw).replace(/\s+/g, ' ').trim() : ''
  if (text === '') return type
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text
}

/**
 * 归一一件事。
 *
 * @param input - `{type, level?, provider?, accountId?, message?, data?, at?}`。
 * @param options - `{ now? }`。
 * @returns 事件对象，或 undefined（输入完全不可用时）。
 */
export function normalizeEvent(input, options = {}) {
  if (input === null || typeof input !== 'object') return undefined
  const type = typeof input.type === 'string' && input.type.trim() !== '' && input.type.length <= 40
    ? input.type.trim()
    : 'event'
  const level = typeof input.level === 'string' && EVENT_LEVELS.includes(input.level) ? input.level : 'info'
  const provider = typeof input.provider === 'string' && PROVIDER_IDS.includes(input.provider) ? input.provider : undefined
  const accountId = typeof input.accountId === 'string' && input.accountId !== '' && input.accountId.length <= 64
    ? input.accountId
    : undefined
  const at = typeof input.at === 'number' && Number.isFinite(input.at) && input.at > 0
    ? input.at
    : typeof options.now === 'number' && Number.isFinite(options.now)
      ? options.now
      : Date.now()
  const data = normalizeEventData(input.data)
  return {
    at,
    type,
    level,
    ...(provider === undefined ? {} : { provider }),
    ...(accountId === undefined ? {} : { accountId }),
    message: normalizeMessage(input.message, type),
    ...(data === undefined ? {} : { data }),
  }
}

/**
 * 有上限的事件账本。
 *
 * 设计成「同步记录、异步落盘」：记录发生在请求/刷新的关键路径上，不能因为磁盘
 * 慢而阻塞聊天；写盘用去抖 + 原子替换，崩溃最多丢最后 1.5 秒的事件，不会留下
 * 半个 JSON 文件。
 */
export class EventLog {
  /**
   * @param options - `{ filePath?, limit?, persistLimit?, persistDelayMs?, now?, logger? }`。
   */
  constructor(options = {}) {
    this.filePath = typeof options.filePath === 'string' && options.filePath !== ''
      ? options.filePath
      : undefined
    this.limit = typeof options.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : EVENT_LIMIT
    this.persistLimit = typeof options.persistLimit === 'number' && options.persistLimit > 0
      ? Math.min(Math.floor(options.persistLimit), this.limit)
      : Math.min(PERSIST_LIMIT, this.limit)
    this.persistDelayMs = typeof options.persistDelayMs === 'number' && options.persistDelayMs >= 0
      ? options.persistDelayMs
      : 1_500
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.logger = options.logger
    this.timer = undefined
    this.stopped = false
    this.seq = 0
    this.events = this.#load()
  }

  /** 从磁盘恢复；坏文件安静退化成空账本。 */
  #load() {
    if (this.filePath === undefined) return []
    const raw = readJsonFile(this.filePath)
    let list
    if (Array.isArray(raw)) list = raw
    else if (raw !== null && typeof raw === 'object' && raw.version === EVENT_VERSION && Array.isArray(raw.events)) list = raw.events
    else return []
    const restored = []
    for (const candidate of list) {
      const event = normalizeEvent(candidate, { now: this.now() })
      if (event === undefined) continue
      event.id = typeof candidate.id === 'string' && candidate.id !== '' ? candidate.id : this.#nextId(event.at)
      restored.push(event)
    }
    return restored.slice(-this.limit)
  }

  /** 事件 id：只用于界面 key，不参与业务判断。 */
  #nextId(at) {
    this.seq += 1
    return `${String(at)}-${String(this.seq)}`
  }

  /** 记一件事；返回归一化后的事件（被去重时返回 false）。 */
  record(input, options = {}) {
    if (this.stopped) return false
    const event = normalizeEvent(input, { now: this.now() })
    if (event === undefined) return false
    const dedupeMs = typeof options.dedupeMs === 'number' && options.dedupeMs > 0 ? options.dedupeMs : 0
    if (dedupeMs > 0) {
      // 只和最近一小段比：后台轮询会把不同类型混在一起，如果只看最后一条，
      // 「额度读取失败」每 2 分钟仍会重复记一次。
      const from = Math.max(0, this.events.length - 20)
      for (let index = this.events.length - 1; index >= from; index--) {
        const previous = this.events[index]
        if (previous.type !== event.type || previous.provider !== event.provider || previous.level !== event.level || previous.message !== event.message) continue
        if (event.at - previous.at >= 0 && event.at - previous.at < dedupeMs) return false
        break
      }
    }
    event.id = this.#nextId(event.at)
    this.events.push(event)
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit)
    this.#schedule()
    return event
  }

  /** 最近的若干条，按时间**倒序**（最新在前），供 UI/CLI 直接使用。 */
  list(options = {}) {
    const limit = typeof options.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : this.limit
    const types = typeof options.type === 'string'
      ? new Set([options.type])
      : Array.isArray(options.type) ? new Set(options.type) : undefined
    const provider = typeof options.provider === 'string' ? options.provider : undefined
    const level = typeof options.level === 'string' ? options.level : undefined
    const since = typeof options.since === 'number' && Number.isFinite(options.since) ? options.since : 0
    const out = []
    for (let index = this.events.length - 1; index >= 0 && out.length < limit; index--) {
      const event = this.events[index]
      if (types !== undefined && !types.has(event.type)) continue
      if (provider !== undefined && event.provider !== provider) continue
      if (level !== undefined && event.level !== level) continue
      if (since > 0 && event.at < since) continue
      out.push({ ...event, ...(event.data === undefined ? {} : { data: { ...event.data } }) })
    }
    return out
  }

  /** 给状态文档用的摘要。 */
  summary() {
    return { count: this.events.length, latestAt: this.events.at(-1)?.at ?? 0 }
  }

  /** 清空账本（内存 + 磁盘），返回是否写盘成功。 */
  clear() {
    this.events = []
    return this.flush()
  }

  /** 立即落盘；返回是否成功（没有文件路径时视为成功）。 */
  flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.filePath === undefined) return true
    const payload = { version: EVENT_VERSION, events: this.events.slice(-this.persistLimit) }
    const ok = writeJsonAtomic(this.filePath, payload, { pretty: false })
    if (!ok) this.logger?.warn?.('dsh-reverse-proxy-connect: 事件账本写入失败（不影响主流程）')
    return ok
  }

  /** 停止：清定时器并把最后一批写盘。 */
  stop() {
    this.stopped = true
    this.flush()
  }

  /** 去抖落盘。 */
  #schedule() {
    if (this.stopped || this.filePath === undefined || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.stopped) return
      const payload = { version: EVENT_VERSION, events: this.events.slice(-this.persistLimit) }
      writeJsonAtomic(this.filePath, payload, { pretty: false })
    }, this.persistDelayMs)
    this.timer.unref?.()
  }
}

/**
 * 数据目录里的事件文件路径。
 * @param dataDir - 数据目录。
 * @returns 路径。
 */
export function eventsPathOf(dataDir) {
  return join(dataDir, EVENTS_FILE)
}
