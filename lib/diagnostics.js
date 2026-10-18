/**
 * 诊断导出：把「能排障」与「能贴给别人」分开。
 *
 * 1.0.x 的「复制诊断」直接复制整份 `/status`，里面既有控制密钥，也有
 * `C:\Users\<用户名>\...` 的登录文件路径。用户把这段 JSON 发到 issue 里，
 * 等于把本机写接口的密钥一起交出去。这一版提供一个只读的诊断路由：
 *
 * - **绝不包含控制密钥**；
 * - 路径缩成 `%LOCALAPPDATA%` / `%APPDATA%` / `~`；
 * - 令牌类字段一律替换成 `[redacted]`（即使当前状态里没有，也防以后加字段时泄露）；
 * - 只导出排障需要的摘要，不把整份模型清单塞进去。
 *
 * 所有函数都是纯函数，便于单测。
 *
 * @module dsh-reverse-proxy-connect/diagnostics
 */

import { homedir } from 'node:os'

import { formatClock, formatDateTime, formatDurationZh } from './format.js'
import { isQoderFreePlan } from './quota.js'

/** 敏感字段名（出现即脱敏）。 */
const SECRET_KEYS = new Set(['key', 'pat', 'token', 'accesstoken', 'refreshtoken', 'authorization', 'cookie', 'secret'])

/**
 * 把绝对路径缩成环境变量形式。
 *
 * @param value - 任意字符串。
 * @returns 缩写后的字符串。
 */
export function redactPath(value) {
  if (typeof value !== 'string' || value === '') return value
  let text = value
  const pairs = []
  if (typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA !== '') pairs.push([process.env.LOCALAPPDATA, '%LOCALAPPDATA%'])
  if (typeof process.env.APPDATA === 'string' && process.env.APPDATA !== '') pairs.push([process.env.APPDATA, '%APPDATA%'])
  try {
    pairs.push([homedir(), '~'])
  } catch {
    /* 取不到 home 时只做通用替换 */
  }
  for (const [prefix, label] of pairs) {
    if (typeof prefix !== 'string' || prefix === '') continue
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(escaped, 'gi'), label)
  }
  // 兜底：即使是别的用户目录，也只保留环境变量名，不带出用户名。
  text = text.replace(/[A-Za-z]:\\Users\\[^\\\s]+\\AppData\\Local/gi, '%LOCALAPPDATA%')
  text = text.replace(/[A-Za-z]:\\Users\\[^\\\s]+\\AppData\\Roaming/gi, '%APPDATA%')
  text = text.replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '%USERPROFILE%')
  text = text.replace(/\/Users\/[^/\s]+/g, '~')
  text = text.replace(/\/home\/[^/\s]+/g, '~')
  return text
}

/**
 * 深拷贝并脱敏一份状态文档。
 *
 * @param status - `/status` 的返回值。
 * @returns 可安全分享的副本。
 */
export function redactStatus(status) {
  if (status === null || typeof status !== 'object') return status
  /**
   * 只记录**当前路径上的祖先**，进入时加入、返回时删除。
   *
   * 之前用全局 WeakSet：`status.stats` 与 `providers[].health` 共享对象引用，
   * 第二次出现就被写成 `[circular]` —— 但那是合法共享，不是环。真正的环只
   * 会出现在祖先链上，所以按路径判断即可。
   *
   * @type {WeakSet<object>}
   */
  const ancestors = new WeakSet()
  const walk = (value, key) => {
    if (typeof value === 'string') return redactPath(value)
    if (Array.isArray(value)) {
      if (ancestors.has(value)) return '[circular]'
      ancestors.add(value)
      const out = value.map((item) => walk(item, key))
      ancestors.delete(value)
      return out
    }
    if (value !== null && typeof value === 'object') {
      if (ancestors.has(value)) return '[circular]'
      ancestors.add(value)
      const out = {}
      for (const [childKey, childValue] of Object.entries(value)) {
        if (SECRET_KEYS.has(childKey.toLowerCase())) {
          out[childKey] = '[redacted]'
          continue
        }
        out[childKey] = walk(childValue, childKey)
      }
      ancestors.delete(value)
      return out
    }
    return value
  }
  return walk(status, '')
}

/**
 * 构建诊断文档。
 *
 * @param status - `/status` 的完整返回值。
 * @param options - `{ now? }`。
 * @returns `{document, text}`。
 */
export function buildDiagnostics(status, options = {}) {
  const safe = redactStatus(status)
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now()
  const providers = Array.isArray(safe?.providers) ? safe.providers.map((entry) => ({
    provider: entry.provider,
    displayName: entry.displayName,
    enabled: entry.enabled !== false,
    catalogSource: entry.catalogSource,
    modelCount: entry.modelCount,
    credential: entry.credential?.status,
    credentialReason: entry.credential?.reason,
    credentialMessage: entry.credential?.message,
    health: entry.health?.state,
    credits: entry.credits === undefined ? undefined : {
      state: entry.credits.state,
      remain: entry.credits.remain,
      total: entry.credits.total,
      unit: entry.credits.unit,
      unlimited: entry.credits.unlimited === true,
      planName: entry.credits.planName,
      paid: entry.credits.paid,
      freePlan: entry.credits.freePlan,
      exceeded: entry.credits.exceeded,
      resetAtMs: entry.credits.resetAtMs,
      stale: entry.credits.stale,
      error: entry.credits.error,
      trend: entry.credits.trend,
    },
    accounts: Array.isArray(entry.accounts) ? entry.accounts.map((account) => ({
      id: account.id,
      label: account.label,
      active: account.active === true,
      enabled: account.enabled !== false,
      source: account.source,
      cooldownUntil: account.cooldownUntil,
      lastTest: account.lastTest,
    })) : undefined,
    checkin: entry.checkin === undefined ? undefined : {
      enabled: entry.checkin.enabled,
      completedToday: entry.checkin.completedToday,
      lastRunAt: entry.checkin.lastRunAt,
      result: entry.checkin.result,
    },
  })) : []

  const document = {
    generatedAt: new Date(now).toISOString(),
    plugin: safe?.plugin,
    host: safe?.host,
    providers,
    usage: safe?.stats === undefined ? undefined : {
      enabled: safe.stats.enabled,
      since: safe.stats.since,
      today: safe.stats.today,
      totals: safe.stats.totals,
      currentSession: safe.stats.currentSession,
      providerCurrentSession: safe.stats.providerCurrentSession,
      health: safe.stats.health,
    },
    storage: safe?.storage,
    events: safe?.events === undefined ? undefined : {
      count: safe.events.count,
      latestAt: safe.events.latestAt,
      items: Array.isArray(safe.events.items) ? safe.events.items.slice(0, 30) : undefined,
    },
    settings: safe?.settings === undefined ? undefined : {
      showRateInModelName: safe.settings.showRateInModelName,
      showUsageInSidebar: safe.settings.showUsageInSidebar,
      autoSwitch: safe.settings.autoSwitch,
      alerts: safe.settings.alerts,
      checkin: safe.settings.checkin,
      probe: safe.settings.probe,
      advanced: safe.settings.advanced,
    },
    checks: [
      { id: 'node', ok: typeof process.versions.node === 'string', detail: process.versions.node },
      { id: 'images', ok: safe?.host?.images === true, detail: safe?.host?.images === true ? 'attachments available' : 'attachments unavailable' },
      { id: 'stats', ok: safe?.host?.stats !== false, detail: safe?.host?.stats === false ? 'disabled' : 'enabled' },
      { id: 'catalogCache', ok: safe?.host?.catalogCache !== false, detail: safe?.host?.catalogCache === false ? 'disabled' : 'enabled' },
      {
        id: 'settingsFile',
        ok: safe?.storage?.settingsError === undefined,
        detail: safe?.storage?.settingsError === undefined
          ? 'readable'
          : `unreadable: ${String(safe.storage.settingsError).slice(0, 160)}${safe.storage.settingsBackup === undefined ? '' : ` (backup: ${safe.storage.settingsBackup})`}`,
      },
    ],
  }
  return { document, text: renderDiagnosticsText(document) }
}

/**
 * 把诊断文档渲染成可读文本（复制到剪贴板的就是这一份）。
 *
 * @param document - `buildDiagnostics().document`。
 * @returns 文本。
 */
export function renderDiagnosticsText(document) {
  const lines = []
  lines.push(`dsh-reverse-proxy-connect ${document?.plugin?.version ?? '?'}`)
  lines.push(`生成时间: ${document?.generatedAt ?? '?'}`)
  lines.push(`Node: ${document?.plugin?.node ?? '?'}  host: ${document?.plugin?.host ?? '?'}`)
  if (document?.checks !== undefined) {
    lines.push('')
    lines.push('检查:')
    for (const check of document.checks) lines.push(`  ${check.ok ? '✓' : '✗'} ${check.id}: ${check.detail}`)
  }
  lines.push('')
  for (const provider of document?.providers ?? []) {
    const credits = provider.credits
    // 三种「没有数字」必须分开写：读失败（error）、还没读过（none）、有旧数字但
    // 这一轮读不到（ok + stale）。旧版把 none 也渲染成「0 / 0 credits」，
    // 那看起来像真的余额为 0。原因字段是 `error`（`message` 只在上游原始响应时出现）。
    const creditReason = credits?.error ?? credits?.message
    const creditText = credits === undefined
      ? '未读取'
      : credits.state === 'error'
        ? `读取失败（${creditReason ?? '未知'}）`
        : credits.state === 'none'
          ? `未读取（${creditReason ?? '尚未读取'}）`
          : `${credits.unlimited === true ? '不限量' : `${credits.remain ?? '?'} / ${credits.total ?? '?'} ${credits.unit ?? 'credits'}`}${credits.planName === undefined ? '' : ` · ${credits.planName}`}${credits.exceeded === true ? (isQoderFreePlan(provider.provider, credits) ? ' · Free 付费额度为 0' : ' · 已用尽') : ''}${credits.stale === true ? ' · 上次结果' : ''}`
    lines.push(`[${provider.provider}] ${provider.enabled === false ? '已关闭' : '已启用'}  ${provider.credential ?? '?'} / ${provider.health ?? 'unknown'}`)
    lines.push(`  目录: ${provider.catalogSource ?? 'none'} (${provider.modelCount ?? 0} 个模型)`)
    lines.push(`  额度: ${creditText}`)
    // 趋势只在「真的读到过数字」的两档里打印：读失败的 provider 拿 emptyTrend()
    // 打印一行 0 / 0 的「今日消耗」纯属噪音。
    if (credits?.trend !== undefined && (credits.state === 'ok' || credits.state === undefined)) {
      const trend = credits.trend
      lines.push(`  今日消耗: ${trend.spentToday ?? 0}  近 7 天: ${trend.spent7d ?? 0}  速度: ${trend.burnPerHour ?? '—'}/h  预计可用: ${formatDurationZh(trend.etaMs)}`)
    }
    for (const account of provider.accounts ?? []) {
      lines.push(`    - ${account.label}${account.active ? ' [当前]' : ''}${account.enabled === false ? ' [停用]' : ''}${account.cooldownUntil > 0 ? ` [冷却至 ${formatClock(account.cooldownUntil)}]` : ''}${account.lastTest === undefined ? '' : ` 测试 ${account.lastTest.ok ? '✓' : '✗'} ${account.lastTest.latencyMs}ms`}`)
    }
    if (provider.credentialMessage !== undefined) lines.push(`  原因: ${provider.credentialMessage}`)
  }
  if (document?.usage !== undefined) {
    lines.push('')
    lines.push(`用量: 今日 ${document.usage.today?.requests ?? 0} 次 / ${document.usage.today?.totalTokens ?? 0} tokens；累计 ${document.usage.totals?.requests ?? 0} 次 / ${document.usage.totals?.totalTokens ?? 0} tokens`)
    if (document.usage.currentSession !== undefined) {
      lines.push(`当前会话: ${document.usage.currentSession.requests ?? 0} 次 / ${document.usage.currentSession.totalTokens ?? 0} tokens`)
    }
  }
  const eventItems = Array.isArray(document?.events?.items) ? document.events.items : []
  if (eventItems.length > 0) {
    lines.push('')
    lines.push(`最近事件（共 ${document.events.count ?? eventItems.length} 条）：`)
    for (const event of eventItems.slice(0, 12)) {
      const at = typeof event.at === 'number' ? formatDateTime(event.at) : '?'
      const scope = typeof event.provider === 'string' ? `${event.provider} ` : ''
      lines.push(`  ${at}  [${event.level ?? 'info'}] ${scope}${event.message ?? ''}`)
    }
  }
  return `${lines.join('\n')}\n`
}
