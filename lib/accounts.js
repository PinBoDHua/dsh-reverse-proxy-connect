/**
 * 账号池。
 *
 * 一个 provider 底下可以有多个账号。默认只有一个（WorkBuddy 读本机登录、
 * Qoder 用设置里的那个 PAT），所以老用户的体验完全不变；额外账号是可选的。
 *
 * 设计要点：
 *
 * - **账号是 provider 的属性，不是新的 provider**。DSH 的模型选择器按 provider
 *   分组，多开 provider 会让同一批模型出现好几组。所以账号只在内部切换，
 *   对外仍然是 4 个 provider。
 * - **凭证明文只存在本机 settings.json**（和原来的 PAT 一样），不往别处发。
 * - **自动切换的判据是「额度」而不是「报错」**：等请求失败再切，用户已经白等了
 *   一次；额度归零时提前切更顺。
 *
 * @module dsh-reverse-proxy-connect/accounts
 */

import { PROVIDERS } from './protocol.js'

/** provider 是桌面登录还是 PAT。 */
const KIND = {
  [PROVIDERS.workbuddy]: 'desktop',
  [PROVIDERS.workbuddyAi]: 'desktop',
  [PROVIDERS.qoder]: 'pat',
  [PROVIDERS.qoderGlobal]: 'pat',
}

/** 每个 provider 的默认账号文案。 */
const DEFAULT_LABEL = {
  [PROVIDERS.workbuddy]: '本机登录',
  [PROVIDERS.workbuddyAi]: '本机登录',
  [PROVIDERS.qoder]: '默认令牌',
  [PROVIDERS.qoderGlobal]: '默认令牌',
}

/**
 * 该 provider 的凭证类型。
 * @param provider - provider id。
 * @returns `'desktop'` 或 `'pat'`。
 */
export function kindOf(provider) {
  return KIND[provider] ?? 'pat'
}

/**
 * 把一个账号条目归一化。
 *
 * 去掉多余字段、补默认值；`id` 缺失或重复的条目直接丢弃（宁缺勿错）。
 *
 * @param provider - 所属 provider。
 * @param raw - 原始条目。
 * @param index - 在第几个（用于兜底 label）。
 * @returns 归一化后的账号，或 undefined（无效）。
 */
export function normalizeAccount(provider, raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const kind = kindOf(provider)
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : `acc-${String(index + 1)}`
  const label = typeof raw.label === 'string' && raw.label.trim() !== ''
    ? raw.label.trim().slice(0, 40)
    : `账号 ${String(index + 1)}`
  const account = { id, label, enabled: raw.enabled !== false }
  if (kind === 'desktop') {
    const authFile = typeof raw.authFile === 'string' ? raw.authFile.trim() : ''
    // 空 authFile = 用自动发现的本机登录，这是默认账号的形态。
    if (authFile !== '') account.authFile = authFile
    // 浏览器登录拿到的令牌：直接存在账号里，不必再伪造一份登录文件。
    const token = normalizeToken(raw.token)
    if (token !== undefined) account.token = token
  } else {
    const pat = typeof raw.pat === 'string' ? raw.pat.trim() : ''
    if (pat !== '') account.pat = pat
  }
  return account
}

/**
 * 归一化账号内嵌的令牌（浏览器登录的产物）。
 *
 * 只保留用得到的字段，并给长度设上限 —— 这些值会进 `settings.json`。
 *
 * @param raw - 原始 token 对象。
 * @returns 归一化结果，或 undefined。
 */
function normalizeToken(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const accessToken = typeof raw.accessToken === 'string' ? raw.accessToken.trim() : ''
  if (accessToken === '') return undefined
  return {
    accessToken: accessToken.slice(0, 8192),
    refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken.trim().slice(0, 8192) : '',
    expiresAtMs: typeof raw.expiresAtMs === 'number' && Number.isFinite(raw.expiresAtMs) ? raw.expiresAtMs : 0,
    refreshExpiresAtMs: typeof raw.refreshExpiresAtMs === 'number' && Number.isFinite(raw.refreshExpiresAtMs) ? raw.refreshExpiresAtMs : 0,
    domain: typeof raw.domain === 'string' ? raw.domain.slice(0, 200) : '',
    uid: typeof raw.uid === 'string' ? raw.uid.slice(0, 100) : '',
    enterpriseId: typeof raw.enterpriseId === 'string' ? raw.enterpriseId.slice(0, 100) : '',
  }
}

/**
 * 列出该 provider 的账号（含隐式默认账号）。
 *
 * 老版本设置里没有 `accounts` 字段，这里会合成一个默认账号，
 * 其凭证取自原来的 `workbuddy[variant].authFile` / `qoder[provider].pat`。
 *
 * @param provider - provider id。
 * @param settings - 归一化后的设置。
 * @returns 账号数组（至少一个）。
 */
export function accountsFor(provider, settings) {
  const raw = settings?.accounts?.[provider]
  const list = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const out = []
  for (let index = 0; index < list.length; index++) {
    // 用「已收录数量」而不是原始下标：中间有条目被丢弃时，兜底名不会跳号。
    const account = normalizeAccount(provider, list[index], out.length)
    if (account === undefined) continue
    if (seen.has(account.id)) continue
    seen.add(account.id)
    out.push(account)
  }
  if (out.length > 0) return out

  // 隐式默认账号：沿用老设置的凭证位置，保证升级后行为不变。
  const kind = kindOf(provider)
  if (kind === 'desktop') {
    const variant = provider === PROVIDERS.workbuddy ? 'workbuddy' : 'workbuddy-ai'
    const authFile = settings?.workbuddy?.[variant]?.authFile
    return [{
      id: 'default',
      label: DEFAULT_LABEL[provider] ?? '默认账号',
      enabled: true,
      ...(typeof authFile === 'string' && authFile.trim() !== '' ? { authFile: authFile.trim() } : {}),
    }]
  }
  const pat = settings?.qoder?.[provider]?.pat
  return [{
    id: 'default',
    label: DEFAULT_LABEL[provider] ?? '默认账号',
    enabled: true,
    ...(typeof pat === 'string' && pat.trim() !== '' ? { pat: pat.trim() } : {}),
  }]
}

/**
 * 当前应该用哪个账号。
 *
 * 规则：用户钉住的那个（如果仍在且启用）→ 否则第一个启用的。
 * 都不启用时返回第一个（宁可发请求失败，也不要静默什么都不做）。
 *
 * @param provider - provider id。
 * @param settings - 设置。
 * @returns 账号。
 */
export function activeAccountFor(provider, settings) {
  const list = accountsFor(provider, settings)
  const pinnedId = settings?.activeAccount?.[provider]
  if (typeof pinnedId === 'string' && pinnedId !== '') {
    const pinned = list.find((account) => account.id === pinnedId)
    if (pinned !== undefined) return pinned
  }
  const enabled = list.filter((account) => account.enabled !== false)
  return enabled[0] ?? list[0]
}

/** 账号是否配置完整（能真的用）。 */
export function isAccountUsable(account) {
  if (account === undefined || account === null) return false
  if (account.enabled === false) return false
  // 浏览器登录拿到的令牌
  if (account.token !== undefined) return true
  // 桌面账号没填 authFile 也算可用：那是「读本机登录」。
  if (account.pat === undefined) return account.authFile === undefined || account.authFile !== ''
  return account.pat !== ''
}

/**
 * 这个账号的额度是不是已经用完了。
 *
 * 三个条件任一：已用尽、上游标记超额、或剩余 <= 0。
 * 不限量账号永远不算用完。
 *
 * @param credits - 额度快照。
 * @returns 是否耗尽。
 */
export function isExhausted(credits) {
  if (credits === undefined || credits === null) return false
  if (credits.unlimited === true) return false
  if (credits.state !== 'ok') return false
  if (credits.exceeded === true) return true
  return typeof credits.remain === 'number' && credits.remain <= 0
}

/**
 * 在额度耗尽时挑一个还有余额的替代账号。
 *
 * @param provider - provider id。
 * @param settings - 设置。
 * @param current - 当前账号 id。
 * @param creditsOf - `(accountId) => 额度快照`。
 * @returns 可切换到的账号，或 undefined（没有可换的）。
 */
export function pickSwitchTarget(provider, settings, current, creditsOf) {
  const list = accountsFor(provider, settings)
  for (const account of list) {
    if (account.id === current) continue
    if (account.enabled === false) continue
    if (!isAccountUsable(account)) continue
    const credits = creditsOf(account.id)
    if (credits === undefined || credits.state !== 'ok') continue
    if (isExhausted(credits)) continue
    return account
  }
  return undefined
}

/** 生成一个不重复的账号 id。 */
export function newAccountId(existing) {
  const used = new Set((existing ?? []).map((account) => account.id))
  for (let index = 1; index < 1000; index++) {
    const id = `acc-${String(index)}`
    if (!used.has(id)) return id
  }
  return `acc-${String(Date.now())}`
}

/**
 * 把「客户端提交的账号列表」与「现有设置」合并，保住没被重发的密钥。
 *
 * 为什么要这一步：浏览器拿不到 PAT（状态文档里从不回传），所以卡片保存
 * 账号列表时不带密钥。如果直接覆盖，用户点一次「设为当前」就会把其他账号的
 * PAT 抹掉。规则很简单 —— 同一个 id 的记录，客户端没给 `pat` 就沿用旧值。
 *
 * @param patch - 已 sanitize 的补丁。
 * @param current - 当前设置。
 * @returns 合并后的补丁。
 */
export function mergeAccountSecrets(patch, current) {
  if (patch?.accounts === undefined) return patch
  const merged = {}
  for (const [provider, rows] of Object.entries(patch.accounts)) {
    const previous = new Map(accountsFor(provider, current).map((account) => [account.id, account]))
    merged[provider] = rows.map((row) => {
      const old = previous.get(row.id)
      if (old === undefined) return row
      const next = { ...row }
      // 客户端拿不到密钥，所以「没给」就沿用旧值。
      if (next.pat === undefined && old.pat !== undefined) next.pat = old.pat
      if (next.token === undefined && old.token !== undefined) next.token = old.token
      return next
    })
  }
  return { ...patch, accounts: merged }
}

