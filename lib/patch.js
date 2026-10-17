/**
 * 浏览器提交的补丁 → 可落盘的设置补丁。
 *
 * 为什么单独成模块：这是**唯一**接受外部输入的写入口，安全边界必须一眼看全。
 * 旧版本把这段逻辑埋在 789 行的 `index.js` 里，新增一个设置项很容易忘记同步
 * 白名单 —— 表现是「界面上能点，但重启后又变回去了」，非常难查。
 *
 * 规则：只认字段名与类型都明确已知的值，其余一律丢弃；字符串截断，数组限量。
 *
 * @module dsh-reverse-proxy-connect/patch
 */

import { normalizeAccount } from './accounts.js'
import { ADVANCED_LIMITS } from './settings.js'
import { PROVIDER_IDS, PROVIDERS } from './protocol.js'

/** 字符串截断。 */
function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

/** 字符串数组（去空、限量）。 */
function ids(value, max = 2000) {
  if (!Array.isArray(value)) return undefined
  return value.filter((item) => typeof item === 'string' && item !== '').slice(0, max)
}

/** 对象判定。 */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 数字夹取。 */
function clamped(value, [min, max]) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(min, Math.min(max, Math.round(value)))
}

/**
 * 把浏览器补丁收敛成已知字段。
 *
 * @param patch - 解析后的 JSON。
 * @returns 可安全交给 `store.patch()` 的补丁。
 */
export function sanitizePatch(patch) {
  const out = {}
  if (!record(patch)) return out

  if (record(patch.providers)) {
    const providers = {}
    for (const provider of PROVIDER_IDS) {
      const entry = patch.providers[provider]
      if (!record(entry)) continue
      const row = {}
      if (typeof entry.enabled === 'boolean') row.enabled = entry.enabled
      const disabled = ids(entry.disabledModels)
      if (disabled !== undefined) row.disabledModels = disabled
      if (Object.keys(row).length > 0) providers[provider] = row
    }
    if (Object.keys(providers).length > 0) out.providers = providers
  }

  if (record(patch.workbuddy)) {
    const workbuddy = {}
    for (const variant of ['workbuddy', 'workbuddy-ai']) {
      const entry = patch.workbuddy[variant]
      if (!record(entry)) continue
      const row = {}
      const authFile = text(entry.authFile, 1024)
      const electronPath = text(entry.electronPath, 1024)
      if (authFile !== undefined) row.authFile = authFile
      if (electronPath !== undefined) row.electronPath = electronPath
      if (typeof entry.useMaximumContext === 'boolean') row.useMaximumContext = entry.useMaximumContext
      if (Object.keys(row).length > 0) workbuddy[variant] = row
    }
    if (Object.keys(workbuddy).length > 0) out.workbuddy = workbuddy
  }

  if (record(patch.qoder)) {
    const qoder = {}
    for (const provider of [PROVIDERS.qoder, PROVIDERS.qoderGlobal]) {
      const entry = patch.qoder[provider]
      if (!record(entry) || typeof entry.pat !== 'string') continue
      qoder[provider] = { pat: entry.pat.trim().slice(0, 4096) }
    }
    if (Object.keys(qoder).length > 0) out.qoder = qoder
  }

  // 账号池：客户端发增量修改（upsert），删除必须显式列 id。
  if (record(patch.accounts)) {
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

  if (record(patch.removedAccounts)) {
    const removed = {}
    for (const provider of PROVIDER_IDS) {
      const list = ids(patch.removedAccounts[provider], 20)
      if (list !== undefined) removed[provider] = list
    }
    if (Object.keys(removed).length > 0) out.removedAccounts = removed
  }

  if (record(patch.activeAccount)) {
    const active = {}
    for (const provider of PROVIDER_IDS) {
      const id = patch.activeAccount[provider]
      if (typeof id === 'string' && id !== '') active[provider] = id.slice(0, 64)
    }
    if (Object.keys(active).length > 0) out.activeAccount = active
  }

  if (record(patch.autoSwitch) && typeof patch.autoSwitch.enabled === 'boolean') {
    out.autoSwitch = { enabled: patch.autoSwitch.enabled }
  }

  // 手动覆盖「探测说不可用」的模型：卡片上用得到，是唯一允许客户端写的探测字段。
  if (record(patch.forcedModels)) {
    const forced = {}
    for (const provider of PROVIDER_IDS) {
      const list = ids(patch.forcedModels[provider])
      if (list !== undefined) forced[provider] = list
    }
    if (Object.keys(forced).length > 0) out.forcedModels = forced
  }

  // 探测开关（允许用户关掉自动探测，省额度）。
  if (record(patch.probe) && typeof patch.probe.enabled === 'boolean') {
    out.probe = { enabled: patch.probe.enabled }
  }

  // 签到开关。
  if (record(patch.checkin) && typeof patch.checkin.enabled === 'boolean') {
    out.checkin = { enabled: patch.checkin.enabled }
  }

  // 展示偏好。
  if (record(patch.display)) {
    const display = {}
    if (typeof patch.display.showRateInModelName === 'boolean') display.showRateInModelName = patch.display.showRateInModelName
    if (typeof patch.display.showUsageInSidebar === 'boolean') display.showUsageInSidebar = patch.display.showUsageInSidebar
    if (Object.keys(display).length > 0) out.display = display
  }

  // 高级参数：数值一律夹进区间，布尔只认 true/false。
  if (record(patch.advanced)) {
    const advanced = {}
    for (const key of ['idleTimeoutMs', 'catalogRefreshMs', 'creditsRefreshMs']) {
      const value = clamped(patch.advanced[key], ADVANCED_LIMITS[key])
      if (value !== undefined) advanced[key] = value
    }
    for (const key of ['stats', 'catalogCache']) {
      if (typeof patch.advanced[key] === 'boolean') advanced[key] = patch.advanced[key]
    }
    if (Object.keys(advanced).length > 0) out.advanced = advanced
  }

  return out
}

/**
 * 这个补丁是否可能改变凭证或目录（决定要不要立刻重新拉上游）。
 *
 * 只是切一个模型开关时不必打一轮网络；但换 PAT、加账号、切当前账号、
 * 开关 provider 都必须尽快让选择器与新凭证对齐。
 *
 * @param patch - 已 sanitize 的补丁。
 * @returns 是否需要刷新。
 */
export function patchNeedsRefresh(patch) {
  if (patch === null || typeof patch !== 'object') return false
  if (patch.qoder !== undefined || patch.workbuddy !== undefined) return true
  if (patch.accounts !== undefined || patch.removedAccounts !== undefined) return true
  if (patch.activeAccount !== undefined) return true
  if (patch.providers !== undefined) {
    for (const entry of Object.values(patch.providers)) {
      if (entry !== null && typeof entry === 'object' && typeof entry.enabled === 'boolean') return true
    }
  }
  if (patch.autoSwitch !== undefined) return true
  return false
}
