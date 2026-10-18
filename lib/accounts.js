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
 *   对外仍然是六个 provider。
 * - **凭证明文只存在本机 settings.json**（和原来的 PAT 一样），不往别处发。
 * - **自动切换的判据是「额度」而不是「报错」**：等请求失败再切，用户已经白等了
 *   一次；额度归零时提前切更顺。
 *
 * @module dsh-reverse-proxy-connect/accounts
 */

import { randomBytes } from 'node:crypto'

import { PROVIDERS } from './protocol.js'
import { isExhaustedCredits } from './quota.js'

/** provider 是桌面登录、PAT，还是桌面端的加密登录态。 */
const KIND = {
  [PROVIDERS.workbuddy]: 'desktop',
  [PROVIDERS.workbuddyAi]: 'desktop',
  [PROVIDERS.qoder]: 'pat',
  [PROVIDERS.qoderGlobal]: 'pat',
  // Trae 的凭证来自桌面端的 `storage.json`（`tc` 加密信封），既不是 PAT，
  // 也不是 WorkBuddy 那种「路径可指向单个登录文件」的形态，所以单独一类：
  // 账号里存的是「可选的 storage.json 路径」+ 续期后的令牌。
  [PROVIDERS.trae]: 'desktop-auth',
  [PROVIDERS.traeGlobal]: 'desktop-auth',
}

/** 每个 provider 的默认账号文案。 */
const DEFAULT_LABEL = {
  [PROVIDERS.workbuddy]: '本机登录',
  [PROVIDERS.workbuddyAi]: '本机登录',
  [PROVIDERS.qoder]: '默认令牌',
  [PROVIDERS.qoderGlobal]: '默认令牌',
  [PROVIDERS.trae]: '本机登录',
  [PROVIDERS.traeGlobal]: '本机登录',
}

/**
 * 该 provider 的凭证类型。
 * @param provider - provider id。
 * @returns `'desktop' | 'pat' | 'desktop-auth'`。
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
  // 浏览器提交「清空这个账号的密钥」时用它：空字符串在归一化时会被丢掉，
  // 没有这个显式标记的话服务端会误以为「客户端没给密钥」而沿用旧值。
  if (raw.forget === true) account.forget = true
  if (kind === 'desktop') {
    const authFile = typeof raw.authFile === 'string' ? raw.authFile.trim() : ''
    // 空 authFile = 用自动发现的本机登录，这是默认账号的形态。
    if (authFile !== '') account.authFile = authFile
    // 浏览器登录拿到的令牌：直接存在账号里，不必再伪造一份登录文件。
    const token = normalizeToken(raw.token)
    if (token !== undefined) account.token = token
  } else if (kind === 'desktop-auth') {
    // Trae：可选的 storage.json 路径 + 续期后的令牌（用户不必自己找文件）。
    const authFile = typeof raw.authFile === 'string' ? raw.authFile.trim() : ''
    if (authFile !== '') account.authFile = authFile
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
  if (kind === 'desktop' || kind === 'desktop-auth') {
    // Trae 的路径覆盖放在 `trae[provider].storageFile`，WorkBuddy 的放在
    // `workbuddy[variant].authFile` —— 两者的上游完全不同，不能共用一个字段。
    const authFile = kind === 'desktop-auth'
      ? settings?.trae?.[provider]?.storageFile
      : settings?.workbuddy?.[provider === PROVIDERS.workbuddy ? 'workbuddy' : 'workbuddy-ai']?.authFile
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
    // 钉住的账号被用户关掉时继续用它，等于「关不掉」—— 不能这样。
    if (pinned !== undefined && pinned.enabled !== false) return pinned
  }
  const enabled = list.filter((account) => account.enabled !== false)
  return enabled[0] ?? list[0]
}

/** 账号在缓存里的键（provider + id）。 */
export function accountKey(provider, accountId) {
  return `${provider}::${accountId}`
}

/**
 * 这个 provider 是否有环境变量形式的兜底 PAT（只对隐式默认账号生效）。
 * @param provider - provider id。
 * @returns 环境变量里是否有令牌。
 */
function hasEnvPat(provider) {
  if (typeof process === 'undefined' || process.env === undefined) return false
  const name = provider === PROVIDERS.qoder ? 'QODER_CN_PERSONAL_ACCESS_TOKEN' : 'QODER_PERSONAL_ACCESS_TOKEN'
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * 账号是否配置完整（能真的用）。
 *
 * 必须区分桌面账号与 PAT 账号：桌面账号空 `authFile` 是「读本机登录」，算可用；
 * PAT 账号空 `pat` 则是「还没配置」，不能因为 `authFile` 恰好是 undefined 就
 * 被当成可用账号选进换号候选（1.2.0 的 `isAccountUsable` 就有这个漏洞）。
 * 隐式默认账号是例外：它可以靠环境变量里的 PAT 工作。
 *
 * @param account - 账号。
 * @param provider - provider id（省略时退回旧的宽松判定）。
 * @returns 是否可用。
 */
export function isAccountUsable(account, provider) {
  if (account === undefined || account === null) return false
  if (account.enabled === false) return false
  // 浏览器登录 / 续期拿到的令牌
  if (account.token !== undefined) return true
  if (typeof provider === 'string' && KIND[provider] !== undefined) {
    // 桌面端与 Trae 都允许空路径（= 自动发现本机登录）。
    if (KIND[provider] === 'desktop' || KIND[provider] === 'desktop-auth') {
      return account.authFile === undefined || account.authFile !== ''
    }
    if (typeof account.pat === 'string' && account.pat !== '') return true
    return account.id === 'default' && hasEnvPat(provider)
  }
  // 老调用方没有 provider：沿用旧语义（桌面账号的空 authFile = 本机登录）。
  if (account.pat === undefined) return account.authFile === undefined || account.authFile !== ''
  return account.pat !== ''
}

/**
 * 这个账号的额度是不是已经用完了。
 *
 * 三个条件任一：已用尽、上游标记超额、或剩余 <= 0。
 * 不限量账号永远不算用完；Qoder Free 的 0 付费额度也不算 —— 免费模型仍可用。
 *
 * @param credits - 额度快照。
 * @param provider - provider id（可选；用于识别 Qoder Free）。
 * @returns 是否耗尽。
 */
export function isExhausted(credits, provider) {
  return isExhaustedCredits(credits, provider)
}

/**
 * 剩余比例是否已经低到该提前换号。
 *
 * 与 `isExhausted()` 分开：0 是「已经用不了」，阈值是「快用完了，趁现在换」。
 * 阈值 0 表示保持旧行为（只在耗尽时切）。
 *
 * @param credits - 额度快照。
 * @param ratio - 0–1 的比例。
 * @returns 是否低于阈值。
 */
export function isBelowThreshold(credits, ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return false
  if (credits === undefined || credits === null) return false
  if (credits.unlimited === true) return false
  if (credits.state !== 'ok') return false
  if (credits.error !== undefined || credits.stale === true) return false
  const total = credits.total
  const remain = credits.remain
  if (typeof total !== 'number' || total <= 0 || typeof remain !== 'number') return false
  return remain / total <= ratio
}

/**
 * 在额度耗尽时挑一个还有余额的替代账号。
 *
 * @param provider - provider id。
 * @param settings - 设置。
 * @param current - 当前账号 id。
 * @param creditsOf - `(accountId) => 额度快照`。
 * @param options - `{ minRatio? }`：低于该比例的候选也不算「还有余额」。
 * @returns 可切换到的账号，或 undefined（没有可换的）。
 */
export function pickSwitchTarget(provider, settings, current, creditsOf, options = {}) {
  const minRatio = typeof options.minRatio === 'number' && Number.isFinite(options.minRatio) ? options.minRatio : 0
  const list = accountsFor(provider, settings)
  for (const account of list) {
    if (account.id === current) continue
    if (account.enabled === false) continue
    if (!isAccountUsable(account, provider)) continue
    const credits = creditsOf(account.id)
    if (credits === undefined || credits.state !== 'ok') continue
    // 读取失败时保留的是「上次结果」；拿它当切换依据会切到一个其实已经失效的账号。
    if (credits.error !== undefined || credits.stale === true) continue
    if (isExhausted(credits, provider)) continue
    if (isBelowThreshold(credits, minRatio)) continue
    return account
  }
  return undefined
}

/**
 * 请求失败时，按「最可能还能用」的顺序列出可切换的账号。
 *
 * 与 `pickSwitchTarget()` 的区别：那个是额度耗尽后的主动切换（只挑额度明确的），
 * 这个是**请求已经失败**之后的救援，所以允许额度未知的账号先试一次 —— 总比
 * 直接把错误抛给用户强。
 *
 * @param provider - provider id。
 * @param settings - 设置。
 * @param currentId - 刚刚失败的账号 id（排除）。
 * @param creditsOf - `(accountId) => 额度快照`。
 * @param options - `{ isCoolingDown?: (accountId) => boolean }`。
 * @returns 候选账号数组（最多 3 个）。
 */
export function pickFailoverCandidates(provider, settings, currentId, creditsOf, options = {}) {
  const ranked = []
  const list = accountsFor(provider, settings)
  for (let index = 0; index < list.length; index++) {
    const account = list[index]
    if (account.id === currentId) continue
    if (account.enabled === false) continue
    if (!isAccountUsable(account, provider)) continue
    if (typeof options.isCoolingDown === 'function' && options.isCoolingDown(account.id) === true) continue
    const credits = creditsOf(account.id)
    if (isExhausted(credits, provider)) continue
    let rank = 1
    if (credits !== undefined && credits.state === 'ok' && typeof credits.remain === 'number' && credits.remain > 0) rank = 0
    else if (credits !== undefined && credits.state === 'error') rank = 2
    ranked.push({ account, rank, index })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return ranked.slice(0, 3).map((entry) => entry.account)
}

/**
 * 生成一个不重复的账号 id。
 *
 * 旧实现从 `acc-1` 开始找第一个空位，删掉 `acc-1` 后新建账号会**复用**这个 id；
 * 于是新账号会继承已删账号的额度缓存、消耗历史与统计。现在用时间戳 + 随机后缀，
 * id 不再回收，重名只可能来自用户手改。
 *
 * @param existing - 现有账号（用于极端碰撞时兜底）。
 * @returns 新 id。
 */
export function newAccountId(existing) {
  const used = new Set((existing ?? []).map((account) => account.id))
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = `acc-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
    if (!used.has(id)) return id
  }
  return `acc-${String(Date.now())}-${randomBytes(3).toString('hex')}`
}

/**
 * 浏览器登录成功后的「单账号 upsert」补丁。
 *
 * 只描述本次登录的那一个账号；调用方必须把返回值交给
 * `mergeAccountSecrets(patch, store.sync())` 再落盘 —— 登录等待期最长 5 分钟，
 * 期间宿主可能新增账号或续期令牌，拿启动时的旧快照整表覆盖会把这些改动
 * 静默抹掉（REPORT #1 的 P1）。
 *
 * @param provider - provider id。
 * @param current - 最新设置（必须是 `store.sync()` 的返回值）。
 * @param login - `{ uid?, label?, token }`。
 * @returns `{ accounts: { [provider]: [row] }, activeAccount: { [provider]: id } }`。
 */
export function loginAccountPatch(provider, current, login) {
  const list = accountsFor(provider, current)
  const uid = typeof login?.uid === 'string' ? login.uid : ''
  const label = typeof login?.label === 'string' && login.label !== '' ? login.label : DEFAULT_LABEL[provider]
  const existing = uid === ''
    ? undefined
    : list.find((account) => account.token !== undefined && account.token.uid === uid)
  if (existing !== undefined) {
    // 只写 token 与 label：enabled / pat / authFile 由当前设置决定，不能在这里重置。
    return {
      accounts: { [provider]: [{ id: existing.id, label, token: login.token }] },
      activeAccount: { [provider]: existing.id },
    }
  }
  const id = newAccountId(list)
  return {
    accounts: { [provider]: [{ id, label, enabled: true, token: login.token }] },
    activeAccount: { [provider]: id },
  }
}

/**
 * 把一次浏览器登录的结果落进 SettingsStore。
 *
 * 关键顺序：**先 `store.sync()` 取最新快照，再只 upsert 本次登录的账号**。
 * 登录等待期最长 5 分钟，期间宿主可能新增账号或续期令牌；用命令启动时的
 * 旧快照整表覆盖会把这些改动静默抹掉（REPORT #1 的 P1）。
 *
 * @param store - `SettingsStore`（也可以是任何提供 `sync()` / `patch()` 的对象）。
 * @param provider - provider id。
 * @param login - `{ uid?, label?, token }`。
 * @returns 本次登录落到的账号 id。
 */
export function applyLoginAccount(store, provider, login) {
  const latest = store.sync()
  const patch = loginAccountPatch(provider, latest, login)
  store.patch(mergeAccountSecrets(patch, latest))
  return patch.activeAccount[provider]
}

/**
 * 把「客户端提交的账号修改」合并进现有账号池。
 *
 * 1.0.0 起 `accounts` 是**增量更新**而不是整表覆盖：
 *
 * - 客户端只发它真正改动的账号行；没提到的账号原样保留；
 * - 删除必须通过 `removedAccounts` 显式声明；
 * - 同一 id 的行没带 `pat` / `token` 时沿用旧密钥（浏览器拿不到密钥）；
 * - `forget: true` 表示明确清空该账号的密钥。
 *
 * 为什么改成这样：旧版是整表覆盖，而浏览器手里只有「上一次轮询到」的账号列表。
 * 如果用户在登录刚完成、卡片还没轮询到新账号的那 20 秒里点了「使用」或「删除」，
 * 就会用一个旧列表把刚导入的账号整条冲掉 —— 令牌也就永久丢了。
 *
 * @param patch - 已 sanitize 的补丁。
 * @param current - 当前设置。
 * @returns 合并后的补丁。
 */
export function mergeAccountSecrets(patch, current) {
  if (patch === null || typeof patch !== 'object') return patch
  if (patch.accounts === undefined && patch.removedAccounts === undefined) return patch
  const providers = new Set([
    ...Object.keys(patch.accounts ?? {}),
    ...Object.keys(patch.removedAccounts ?? {}),
  ])
  const merged = {}
  /** 需要一并清掉的旧位置凭证（隐式默认账号的 PAT / 登录路径）。 */
  const legacyCleanup = { qoder: {}, workbuddy: {}, trae: {} }
  for (const provider of providers) {
    const byId = new Map(accountsFor(provider, current).map((account) => [account.id, account]))
    for (const row of patch.accounts?.[provider] ?? []) {
      if (row === null || typeof row !== 'object') continue
      const old = byId.get(row.id)
      const next = { ...(old ?? {}), ...row }
      if (row.forget === true) {
        delete next.pat
        delete next.token
        // 桌面账号的登录文件路径也可能是指向凭据的配置，一并清掉。
        delete next.authFile
      }
      byId.set(row.id, stripForget(next))
    }
    const removed = patch.removedAccounts?.[provider] ?? []
    for (const id of removed) byId.delete(id)
    merged[provider] = [...byId.values()]

    // 隐式默认账号的凭证还存在旧字段里（qoder.pat / workbuddy.authFile /
    // trae.storageFile）。只删账号行的话，旧值会一直留在磁盘上，`/status`
    // 还会把它算成「已配置」，用户以为清掉的令牌其实没清。
    const forgotDefault = removed.includes('default')
      || (patch.accounts?.[provider] ?? []).some((row) => row !== null && typeof row === 'object' && row.id === 'default' && row.forget === true)
    if (!forgotDefault) continue
    const kind = kindOf(provider)
    if (kind === 'pat') {
      legacyCleanup.qoder[provider] = { pat: '' }
    } else if (kind === 'desktop') {
      const variant = provider === PROVIDERS.workbuddy ? 'workbuddy' : 'workbuddy-ai'
      legacyCleanup.workbuddy[variant] = { authFile: '' }
    } else {
      legacyCleanup.trae[provider] = { storageFile: '' }
    }
  }
  const next = { ...patch, accounts: merged }
  for (const section of ['qoder', 'workbuddy', 'trae']) {
    const entries = Object.entries(legacyCleanup[section])
    if (entries.length === 0) continue
    next[section] = { ...(patch[section] ?? {}) }
    for (const [key, value] of entries) {
      next[section][key] = { ...(next[section][key] ?? {}), ...value }
    }
  }
  return next
}

/** 去掉只用于传输的 `forget` 标记，避免它被写进 settings.json。 */
function stripForget(row) {
  if (row === null || typeof row !== 'object' || row.forget === undefined) return row
  const { forget: _forget, ...rest } = row
  return rest
}

