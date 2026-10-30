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

/** 比例夹取：接受 0–1 或 0–100，落盘统一成小数。 */
function ratio(value, [min, max]) {
  let number = value
  if (typeof number === 'string' && number.trim() !== '') number = Number(number)
  if (typeof number !== 'number' || !Number.isFinite(number)) return undefined
  if (number > 1 && number <= 100) number /= 100
  return Math.max(min, Math.min(max, Math.round(number * 1000) / 1000))
}

/**
 * 这个（已 sanitize 的）补丁改动了哪些凭证。
 *
 * 用途：今天已经按「未配置」判过签到的 provider，在补上 PAT / 登录文件后
 * 必须重新检查当天签到，否则奖励要等到明天。只认真正代表凭证的字段，
 * 改账号名、切模型、调整开关都不会触发。
 *
 * 与 `credentialProvidersOf()` 的区别是**账号粒度**：账号池里的某一项换了
 * PAT 时只返回这一项，不再把同一 provider 下其它账号的额度缓存/消耗历史
 * 一起作废。provider 级字段（旧的 `qoder[...].pat` 等）没有账号 id，返回
 * `{provider}`，表示整家都受影响。
 *
 * @param patch - `sanitizePatch()` 的输出。
 * @returns `{provider, accountId?}[]`。
 */
export function credentialTargetsOf(patch) {
  const out = []
  const seen = new Set()
  const push = (provider, accountId) => {
    const key = accountId === undefined ? provider : `${provider}::${accountId}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(accountId === undefined ? { provider } : { provider, accountId })
  }
  if (!record(patch)) return out
  // `forget: true` 是「显式清空这个账号的密钥」：它同样改变凭证，必须让
  // 旧的额度快照 / 消耗曲线 / 冷却与测试结论立刻失效。以前只认 pat/token/
  // authFile 三个字段，清空密钥反而被当成「什么都没改」。
  const hasCredential = (row) => record(row)
    && (row.forget === true || row.pat !== undefined || row.token !== undefined || row.authFile !== undefined)
  if (record(patch.accounts)) {
    for (const provider of PROVIDER_IDS) {
      const rows = patch.accounts[provider]
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        if (!hasCredential(row)) continue
        if (typeof row.id === 'string' && row.id !== '') push(provider, row.id)
        else push(provider)
      }
    }
  }
  if (record(patch.qoder)) {
    for (const provider of [PROVIDERS.qoder, PROVIDERS.qoderGlobal]) {
      const entry = patch.qoder[provider]
      if (record(entry) && entry.pat !== undefined) push(provider)
    }
  }
  if (record(patch.trae)) {
    for (const provider of [PROVIDERS.trae, PROVIDERS.traeGlobal]) {
      const entry = patch.trae[provider]
      if (record(entry) && entry.storageFile !== undefined) push(provider)
    }
  }
  // WorkBuddy 的「登录文件」路径也是凭证来源（accountsFor 会把
  // `workbuddy[variant].authFile` 当成隐式默认账号的凭证）。漏掉它时，
  // 当天已按「未配置」判过的签到不会再打开 —— 补上路径后奖励要等到明天。
  if (record(patch.workbuddy)) {
    for (const [variant, provider] of [
      ['workbuddy', PROVIDERS.workbuddy],
      ['workbuddy-ai', PROVIDERS.workbuddyAi],
    ]) {
      const entry = patch.workbuddy[variant]
      // electronPath 只是「去哪里找 App」，不是凭证；不触发签到重查。
      if (record(entry) && entry.authFile !== undefined) push(provider)
    }
  }
  return out
}

/**
 * 受影响 provider 的集合（`credentialTargetsOf()` 的粗粒度视图）。
 *
 * @param patch - `sanitizePatch()` 的输出。
 * @returns 受影响的 provider 集合。
 */
export function credentialProvidersOf(patch) {
  return new Set(credentialTargetsOf(patch).map((target) => target.provider))
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

  // Trae：只有「storage.json 在哪」可以填。凭证本身由客户端维护，插件不写。
  if (record(patch.trae)) {
    const trae = {}
    for (const provider of [PROVIDERS.trae, PROVIDERS.traeGlobal]) {
      const entry = patch.trae[provider]
      if (!record(entry)) continue
      const storageFile = text(entry.storageFile, 1024)
      if (storageFile !== undefined) trae[provider] = { storageFile }
    }
    if (Object.keys(trae).length > 0) out.trae = trae
  }

  // 账号池：客户端发增量修改（upsert），删除必须显式列 id。
  if (record(patch.accounts)) {
    const accounts = {}
    for (const provider of PROVIDER_IDS) {
      const list = patch.accounts[provider]
      if (!Array.isArray(list)) continue
      const rows = []
      for (let index = 0; index < list.length && rows.length < 100; index++) {
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
      const list = ids(patch.removedAccounts[provider], 100)
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

  if (record(patch.autoSwitch)) {
    const autoSwitch = {}
    if (typeof patch.autoSwitch.enabled === 'boolean') autoSwitch.enabled = patch.autoSwitch.enabled
    const threshold = ratio(patch.autoSwitch.thresholdRatio, [0, 0.5])
    if (threshold !== undefined) autoSwitch.thresholdRatio = threshold
    if (Object.keys(autoSwitch).length > 0) out.autoSwitch = autoSwitch
  }

  if (record(patch.alerts)) {
    const alerts = {}
    if (typeof patch.alerts.enabled === 'boolean') alerts.enabled = patch.alerts.enabled
    const low = ratio(patch.alerts.lowRatio, [0.01, 0.95])
    if (low !== undefined) alerts.lowRatio = low
    if (Object.keys(alerts).length > 0) out.alerts = alerts
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
    for (const key of ['idleTimeoutMs', 'catalogRefreshMs', 'creditsRefreshMs', 'qoderQueueWaitMs']) {
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
  if (patch.qoder !== undefined || patch.workbuddy !== undefined || patch.trae !== undefined) return true
  if (patch.accounts !== undefined || patch.removedAccounts !== undefined) return true
  if (patch.activeAccount !== undefined) return true
  if (patch.providers !== undefined) {
    for (const entry of Object.values(patch.providers)) {
      if (entry !== null && typeof entry === 'object' && typeof entry.enabled === 'boolean') return true
    }
  }
  return false
}
