/**
 * Trae 凭证：从桌面端的 `storage.json` 里解出登录态，再把 `Cloud-IDE-JWT` 续上。
 *
 * Trae 的凭证和 WorkBuddy 完全是两套东西，踩过的坑按顺序记在这里：
 *
 * 1. **不是明文**。`%APPDATA%\Trae CN\User\globalStorage\storage.json` 里的
 *    `iCubeAuthInfo://icube.cloudide` 是 `tc` 信封：`[6B 头][32B 随机数][密文]`，
 *    密文解出来是 `[64B SHA-512 校验][明文 JSON]`。密钥由「随机数 + 固定盐」两次
 *    SHA-512 派生，盐来自客户端自己的前端包。国际版同一个格式，只有盐对应的
 *    加密类型可能不同（`tc` 与 `AES_PRIVATE` 两种头）。
 * 2. **明文里的 token 不是聊天用的那个**。`token` 字段是 `cloudide` 令牌，只能调
 *    `/cloudide/api/v3/trae/GetUserInfo`；聊天要的是 `Cloud-IDE-JWT`，得先拿它去
 *    `GenerateTempToken` 换。直接把 cloudide 令牌塞进 `Authorization` 会被判 401。
 * 3. **换出来的 JWT 只有 7 天**（`ExpireDuration: 10080` 分钟）。`refreshToken`
 *    能续，但走的是另一个端点（`/oauth/ExchangeToken`），并且要求 `ClientID`
 *    与 `ClientSecret` —— 少一个就 400「无效参数」。
 * 4. **`GenerateTempToken` 换出来的令牌不能聊天**。实测：登录文件里的 `token`
 *    （claims 带 `source: "refresh_token"`）直接发到 `llm_utils_chat` 就是 200；
 *    而 `GenerateTempToken` 换来的那枚（claims 带 `type: "user"`）会被 401
 *    `code 1001`。所以这里根本不做临时令牌交换 —— 见 `resolveTraeCredential`。
 * 5. **目录与聊天是两个不同的 host**。账号信息在 `api.trae.cn` /
 *    `api.trae.com.cn`，聊天与模型目录在 `trae-api-cn.mchost.guru`
 *    （国际版 `a0ai-api-sg.byteintlapi.com`）。
 *
 * @module dsh-reverse-proxy-connect/trae/credential
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { REASON } from '../protocol.js'
import { withTimeout } from '../timeout.js'

/** 单次凭证请求的超时。 */
const AUTH_TIMEOUT_MS = 20_000

/** 提前多久续期（JWT 有效期 7 天，提前 1 天换）。 */
const REFRESH_MARGIN_MS = 24 * 60 * 60_000

/**
 * 上游没给（或给成 0 = Go 零值）过期时间时，按 7 天估。
 *
 * 这个兜底必须存在：`needsRefresh(0)` 是 true，把 0 写回账号等于「刚拿到的令牌
 * 已经要续期」，每次凭证解析都会再打一次 ExchangeToken。
 */
const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 3600_000

/** Trae 客户端的 OAuth ClientID（国内版与国际版实测相同）。 */
export const TRAE_CLIENT_ID = 'ono9krqynydwx5'

/**
 * 两套固定盐（来自客户端前端包，各 64 字节）。
 *
 * `AES` 类型用 `A ^ B`，`AES_PRIVATE` 用 `C ^ D`。这两组值不能改：改一个字节
 * 派生出的 AES key 就完全不对，解密出来的第一个 64 字节校验也过不了。
 */
const SALT_A = Object.freeze([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
])

const SALT_B = Object.freeze([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
])

const SALT_C = Object.freeze([
  191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176,
  135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156,
  51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6,
  18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209,
])

const SALT_D = Object.freeze([
  246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145,
  50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106,
  175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154,
  86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170,
])

/**
 * 两个变体的端点表。
 *
 * `dataDirName` 是 `%APPDATA%` 下的目录名；`apiHost` 是账号/续期端点；
 * `chatHost` 是模型目录与聊天端点；`region` 会作为 `X-User-Region` 发出去。
 */
export const TRAE_ENDPOINTS = Object.freeze({
  trae: Object.freeze({
    dataDirName: 'Trae CN',
    apiHost: 'https://api.trae.cn',
    chatHost: 'https://trae-api-cn.mchost.guru',
    region: 'CN',
    ideVersion: '0.1.52',
    ideVersionCode: '20260811',
    osVersion: 'Windows 11 Pro',
  }),
  'trae-global': Object.freeze({
    dataDirName: 'Trae',
    apiHost: 'https://api.trae.ai',
    chatHost: 'https://a0ai-api-sg.byteintlapi.com',
    region: 'SG',
    ideVersion: '0.1.52',
    ideVersionCode: '20260811',
    osVersion: 'Windows 11 Pro',
  }),
})

/**
 * 取某个变体的端点表。
 * @param variantId - `trae` 或 `trae-global`。
 * @returns 端点表。
 */
export function endpointsFor(variantId) {
  return TRAE_ENDPOINTS[variantId] ?? TRAE_ENDPOINTS.trae
}

/** 凭证类错误（带稳定的 code，供换号判据使用）。 */
export class TraeCredentialError extends Error {
  /**
   * @param code - REASON 码。
   * @param message - 说明。
   * @param kind - 失败类别（`auth` 会让请求级换号生效）。
   */
  constructor(code, message, kind = 'auth') {
    super(message)
    this.name = 'TraeCredentialError'
    this.code = code
    this.kind = kind
  }
}

/** 把 `[a, b]` 逐字节异或成 64 字节盐。 */
function xorSalts(a, b) {
  const out = Buffer.alloc(64)
  for (let index = 0; index < 64; index++) out[index] = a[index] ^ b[index]
  return out
}

/**
 * 判断信封头属于哪种加密类型。
 *
 * 两种头都是实测值：`tc` 头是 5.x 起的默认，`AES_PRIVATE` 是另一条分支。
 * 认不出来就抛错 —— 用一个猜出来的盐去解密只会得到一段乱码，还会把
 * 「格式变了」误报成「登录过期」。
 *
 * @param header - 前 6 个字节。
 * @returns `'AES' | 'AES_PRIVATE' | 'UNKNOWN'`。
 */
export function detectEncType(header) {
  if (header.length < 6) return 'UNKNOWN'
  if (header[0] === 0x74 && header[1] === 0x63 && header[2] === 0x05
    && header[3] === 0x10 && header[4] === 0x00 && header[5] === 0x00) return 'AES'
  if (header[0] === 18 && header[1] === 57 && header[2] === 32
    && header[3] === 32 && header[4] === 2 && header[5] === 3) return 'AES_PRIVATE'
  return 'UNKNOWN'
}

/**
 * 解密一个 `tc` 信封（base64 字符串）。
 *
 * 结构：`[6B 头][32B 随机数][密文]` → `[64B SHA-512][明文 JSON]`。
 * 校验不过就抛错：宁可报「读不出来」，也不要拿乱码当账号名。
 *
 * @param base64Value - storage.json 里的字段值。
 * @returns 明文。
 * @throws {TraeCredentialError}
 */
export function decryptStorageValue(base64Value) {
  if (typeof base64Value !== 'string' || base64Value.trim() === '') {
    throw new TraeCredentialError(REASON.credentialUnreadable, 'Trae 登录信息是空的。')
  }
  const buffer = Buffer.from(base64Value.trim(), 'base64')
  if (buffer.length < 38 + 16) {
    throw new TraeCredentialError(REASON.credentialUnreadable, 'Trae 登录信息长度不足，可能被截断。')
  }
  const encType = detectEncType(buffer.subarray(0, 6))
  if (encType === 'UNKNOWN') {
    throw new TraeCredentialError(
      REASON.credentialUnreadable,
      'Trae 登录信息用了未知的加密格式（客户端可能已升级）。请更新插件。',
    )
  }
  const randomBytes = buffer.subarray(6, 38)
  const cipher = buffer.subarray(38)
  const salt = encType === 'AES_PRIVATE' ? xorSalts(SALT_C, SALT_D) : xorSalts(SALT_A, SALT_B)
  const first = createHash('sha512').update(randomBytes).digest()
  const second = createHash('sha512').update(Buffer.concat([first, salt])).digest()
  const key = second.subarray(0, 16)
  const iv = second.subarray(16, 32)
  let plain
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    plain = Buffer.concat([decipher.update(cipher), decipher.final()])
  } catch (cause) {
    throw new TraeCredentialError(REASON.credentialUnreadable, `Trae 登录信息解密失败：${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (plain.length < 64) {
    throw new TraeCredentialError(REASON.credentialUnreadable, 'Trae 登录信息解密后长度不足。')
  }
  const stored = plain.subarray(0, 64)
  const body = plain.subarray(64)
  const computed = createHash('sha512').update(body).digest()
  if (!stored.equals(computed)) {
    throw new TraeCredentialError(REASON.credentialUnreadable, 'Trae 登录信息校验失败（可能来自另一个账号或已损坏）。')
  }
  return body.toString('utf8')
}

/**
 * 候选的 storage.json 路径（按优先级）。
 *
 * 环境变量排在第一位：用户可能把 Trae 装在非默认位置，或者同一台机器上有
 * 多个便携版。与 WorkBuddy 的 `WORKBUDDY_AUTH_FILE` 是同一套思路。
 *
 * @param variantId - 变体。
 * @returns 路径数组（可能有多个）。
 */
export function storagePathsFor(variantId) {
  const envName = variantId === 'trae-global' ? 'TRAE_GLOBAL_STORAGE_FILE' : 'TRAE_CN_STORAGE_FILE'
  const fromEnv = process.env[envName]
  // 显式配置了路径就只认它：用户指定了位置还去猜默认目录，会在
  // 「便携版 + 机器上另有一个登录」时读到错的那份。
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return [fromEnv.trim()]
  const { dataDirName } = endpointsFor(variantId)
  const roaming = process.env.APPDATA
  // Windows 上 `%APPDATA%` 就是唯一权威位置。**不能**再并列一个
  // `homedir()/AppData/Roaming`：两者平时相等，但测试或便携环境里把
  // `APPDATA` 指到别处时，并列会让「找不到」变成「读到了另一份」。
  const bases = typeof roaming === 'string' && roaming.trim() !== ''
    ? [roaming.trim()]
    : [join(homedir(), 'AppData', 'Roaming'), join(homedir(), 'Library', 'Application Support'), join(homedir(), '.config')]
  return [...new Set(bases.map((base) => join(base, dataDirName, 'User', 'globalStorage', 'storage.json')))]
}

/**
 * 从 `storage.json` 读出并解出登录态。
 *
 * 国际版同一个 key 也可能是**明文 JSON**（老版本），所以先看是不是以 `{` 开头。
 *
 * @param variantId - 变体。
 * @param overridePath - 用户手填的路径（可选）。
 * @returns `{token, refreshToken, userId, host, expiredAt, account, file}`。
 * @throws {TraeCredentialError}
 */
export function readStoredAuth(variantId, overridePath) {
  // 显式配置了路径就**只认它**：与 WorkBuddy 侧同一口径。旧实现把用户路径
  // 前置但保留默认候选，第一个存在的就赢 —— 用户配了便携版路径、文件刚好
  // 不可用（卸载/改名/盘符变了）时，插件会静默拿本机另一个登录去聊天、读额度、
  // 签到：用错账号，而且没有任何提示。
  const explicitPath = typeof overridePath === 'string' && overridePath.trim() !== '' ? overridePath.trim() : ''
  const candidates = explicitPath === '' ? storagePathsFor(variantId) : [explicitPath]
  let file
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      file = candidate
      break
    }
  }
  if (file === undefined) {
    throw new TraeCredentialError(
      REASON.noCredential,
      explicitPath === ''
        ? `没有找到 Trae 的登录文件（已查找 ${String(candidates.length)} 个位置）。请先打开 Trae 并登录，或在连接设置里指定 storage.json 的路径。`
        : `没有找到 Trae 的登录文件：连接设置里指定的路径不存在（${explicitPath}）。请确认路径，或清空该设置让插件自动查找。`,
    )
  }
  let storage
  try {
    storage = JSON.parse(readFileSync(file, 'utf8'))
  } catch (cause) {
    throw new TraeCredentialError(REASON.credentialUnreadable, `Trae 登录文件不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const raw = storage?.['iCubeAuthInfo://icube.cloudide']
  if (raw === undefined || raw === null || raw === '') {
    throw new TraeCredentialError(REASON.noCredential, 'Trae 登录文件里没有账号信息，请先在 Trae 里登录。')
  }
  let parsed
  try {
    parsed = typeof raw === 'string' && raw.trim().startsWith('{')
      ? JSON.parse(raw)
      : JSON.parse(decryptStorageValue(raw))
  } catch (cause) {
    // 解密函数自己的错误原样上抛（已带稳定的 credential-unreadable 码）；
    // 解密成功但明文不是 JSON 时，JSON.parse 抛的是裸 SyntaxError —— 若不
    // 包起来，它会被上层归成 upstream-error（不可重试、不换号）。
    if (cause instanceof TraeCredentialError) throw cause
    throw new TraeCredentialError(
      REASON.credentialUnreadable,
      `Trae 登录信息不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new TraeCredentialError(REASON.credentialUnreadable, 'Trae 登录信息格式异常。')
  }
  const token = typeof parsed.token === 'string' ? parsed.token.trim() : ''
  if (token === '') {
    throw new TraeCredentialError(REASON.noCredential, 'Trae 登录信息里没有令牌，请重新登录 Trae。')
  }
  const expiredAtMs = typeof parsed.expiredAt === 'string' ? Date.parse(parsed.expiredAt) : 0
  const refreshExpiredAtMs = typeof parsed.refreshExpiredAt === 'string' ? Date.parse(parsed.refreshExpiredAt) : 0
  const account = parsed.account !== null && typeof parsed.account === 'object' ? parsed.account : {}
  return {
    variant: variantId,
    token,
    refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : '',
    userId: typeof parsed.userId === 'string' ? parsed.userId : '',
    host: typeof parsed.host === 'string' && parsed.host !== '' ? parsed.host : endpointsFor(variantId).apiHost,
    expiredAtMs: Number.isFinite(expiredAtMs) ? expiredAtMs : 0,
    refreshExpiresAtMs: Number.isFinite(refreshExpiredAtMs) ? refreshExpiredAtMs : 0,
    name: typeof account.username === 'string' ? account.username : '',
    email: typeof account.email === 'string' ? account.email : '',
    avatarUrl: typeof account.avatar_url === 'string' ? account.avatar_url : '',
    region: typeof parsed?.userRegion?.region === 'string' ? parsed.userRegion.region : '',
    file,
  }
}

/**
 * 用 cloudide 令牌换一枚 `Cloud-IDE-JWT`。
 *
 * 这一步是必须的：登录文件里的 `token` 只能读账号信息，不能聊天。
 *
 * @param variantId - 变体。
 * @param cloudideToken - 登录文件里的令牌。
 * @param signal - 取消。
 * @returns `{token, expiresAtMs}`。
 * @throws {TraeCredentialError}
 */
export async function generateTempToken(variantId, cloudideToken, signal) {
  const { apiHost, ideVersion } = endpointsFor(variantId)
  let response
  try {
    response = await fetch(`${apiHost}/cloudide/api/v3/trae/GenerateTempToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cloudide-token': cloudideToken },
      body: JSON.stringify({ IDEVersion: ideVersion }),
      signal: withTimeout(signal, AUTH_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new TraeCredentialError(REASON.upstreamError, `Trae 换取令牌失败：${cause instanceof Error ? cause.message : String(cause)}`, 'server')
  }
  const text = await response.text()
  if (!response.ok) {
    throw new TraeCredentialError(
      REASON.credentialExpired,
      `Trae 换取令牌返回 HTTP ${String(response.status)}，登录状态可能已失效，请重新登录 Trae。`,
    )
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new TraeCredentialError(REASON.credentialUnreadable, 'Trae 换取令牌返回了非 JSON。')
  }
  const token = body?.Result?.Token
  if (typeof token !== 'string' || token === '') {
    const code = body?.ResponseMetadata?.Error?.Code ?? body?.code ?? 'unknown'
    throw new TraeCredentialError(REASON.credentialExpired, `Trae 换取令牌失败（${String(code)}），请重新登录 Trae。`)
  }
  const expiredAt = typeof body?.Result?.ExpiredAt === 'number' ? body.Result.ExpiredAt : 0
  return { token, expiresAtMs: expiredAt > 0 ? expiredAt : Date.now() + DEFAULT_TOKEN_TTL_MS }
}

/**
 * 用 refreshToken 续期（`/cloudide/api/v3/trae/oauth/ExchangeToken`）。
 *
 * 注意 `ClientSecret` 必须存在（客户端发的是 `-`）：缺字段会被判「无效参数」。
 *
 * @param variantId - 变体。
 * @param refreshToken - 刷新令牌。
 * @param userId - 用户 id（可选，服务端用它绑定设备）。
 * @param signal - 取消。
 * @returns `{token, refreshToken, expiresAtMs, refreshExpiresAtMs}`。
 * @throws {TraeCredentialError}
 */
export async function exchangeRefreshToken(variantId, refreshToken, userId, signal) {
  const { apiHost } = endpointsFor(variantId)
  let response
  try {
    response = await fetch(`${apiHost}/cloudide/api/v3/trae/oauth/ExchangeToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ClientID: TRAE_CLIENT_ID,
        RefreshToken: refreshToken,
        ClientSecret: '-',
        ...(userId === undefined || userId === '' ? {} : { UserID: userId }),
      }),
      signal: withTimeout(signal, AUTH_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new TraeCredentialError(REASON.upstreamError, `Trae 续期失败：${cause instanceof Error ? cause.message : String(cause)}`, 'server')
  }
  const text = await response.text()
  if (!response.ok) {
    throw new TraeCredentialError(REASON.credentialExpired, `Trae 续期返回 HTTP ${String(response.status)}，请重新登录 Trae。`)
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new TraeCredentialError(REASON.credentialUnreadable, 'Trae 续期返回了非 JSON。')
  }
  const result = body?.Result
  if (result === undefined || typeof result?.Token !== 'string' || result.Token === '') {
    const code = body?.ResponseMetadata?.Error?.Code ?? body?.code ?? 'unknown'
    throw new TraeCredentialError(REASON.credentialExpired, `Trae 续期失败（${String(code)}），请重新登录 Trae。`)
  }
  return {
    token: result.Token,
    refreshToken: typeof result.RefreshToken === 'string' && result.RefreshToken !== '' ? result.RefreshToken : refreshToken,
    // `TokenExpireAt` 是上游 Go 结构体里的 int64：字段缺省时 JSON 里就是数字 0。
    // 只判 `typeof === 'number'` 会把刚换到的 7 天令牌记成 `expiresAtMs = 0`，而
    // `needsRefresh(0)` 恒为 true —— 之后每一次凭证解析都会再续期一次并把结果写回
    // 设置（每个请求一次 ExchangeToken）。与 `generateTempToken()` 用同一个兜底。
    expiresAtMs: typeof result.TokenExpireAt === 'number' && result.TokenExpireAt > 0
      ? result.TokenExpireAt
      : Date.now() + DEFAULT_TOKEN_TTL_MS,
    refreshExpiresAtMs: typeof result.RefreshExpireAt === 'number' && result.RefreshExpireAt > 0 ? result.RefreshExpireAt : 0,
  }
}

/**
 * 这枚 JWT 是否该续了。
 *
 * 续期余量取 1 天（JWT 一共 7 天）：余量太短会让每小时的卡片轮询都撞一次
 * 续期端点，太长则可能在一个长会话里过期。
 *
 * @param expiresAtMs - 过期时间。
 * @param now - 当前时间（测试可注入）。
 * @returns 是否需要续期。
 */
export function needsRefresh(expiresAtMs, now = Date.now()) {
  if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return true
  return now >= expiresAtMs - REFRESH_MARGIN_MS
}

/**
 * 把「账号里存的令牌」与「登录文件」统一成一份可用凭证。
 *
 * 顺序：账号自带的 `token.accessToken`（之前续期过的）→ 登录文件里的 `token`。
 *
 * **重要（实测）**：`storage.json` 里的 `token` 本身就是聊天要用的那枚
 * `Cloud-IDE-JWT`（claims 里 `source: "refresh_token"`，有效期 7 天）。
 * `/cloudide/api/v3/trae/GenerateTempToken` 换出来的**是另一枚**令牌
 * （claims 里带 `type: "user"`），把它发到 `llm_utils_chat` / `get_detail_param`
 * 会被回 401 `code 1001`。所以这里**不做**临时令牌交换 —— 那正是最容易
 * 踩进去的坑：看起来「换了新令牌」，实际把能用的令牌换成了不能用的。
 *
 * 过期时用 `refreshToken` 走 `ExchangeToken`，它返回的 `Token` 与登录文件里的
 * 同一形态（claims 带 `source: "refresh_token"`），可以直接用于聊天。
 *
 * @param options - `{ variantId, stored, authFile, signal, onRefreshed }`。
 * @returns `{jwt, userId, name, email, avatarUrl, expiresAtMs, file}`。
 * @throws {TraeCredentialError}
 */
export async function resolveTraeCredential(options) {
  const { variantId, stored, authFile, signal } = options
  const endpoints = endpointsFor(variantId)

  let jwt
  let expiresAtMs = 0
  let userId = ''
  let name = ''
  let email = ''
  let avatarUrl = ''
  let file = ''
  let refreshToken = ''

  if (stored !== undefined && stored !== null && typeof stored.accessToken === 'string' && stored.accessToken !== '') {
    jwt = stored.accessToken
    expiresAtMs = typeof stored.expiresAtMs === 'number' ? stored.expiresAtMs : 0
    userId = typeof stored.uid === 'string' ? stored.uid : ''
    refreshToken = typeof stored.refreshToken === 'string' ? stored.refreshToken : ''
  }

  const fromDisk = (() => {
    try {
      return readStoredAuth(variantId, authFile)
    } catch (error) {
      // 账号里已经有一枚还能用的令牌时，读不到登录文件不该让请求失败。
      if (jwt !== undefined && !needsRefresh(expiresAtMs)) return undefined
      throw error
    }
  })()

  if (fromDisk !== undefined) {
    file = fromDisk.file
    userId = fromDisk.userId || userId
    name = fromDisk.name
    email = fromDisk.email
    avatarUrl = fromDisk.avatarUrl
    refreshToken = fromDisk.refreshToken || refreshToken
    // 登录文件是最权威的来源：它写的令牌就是聊天要用的那枚。
    // 只有在「账号里没有令牌」或「登录文件那枚更新」时才覆盖。
    if (jwt === undefined || fromDisk.expiredAtMs === 0 || fromDisk.expiredAtMs > expiresAtMs) {
      jwt = fromDisk.token
      expiresAtMs = fromDisk.expiredAtMs
    }
  }

  if (jwt === undefined) {
    throw new TraeCredentialError(REASON.noCredential, '尚未取得 Trae 登录令牌，请先在 Trae 客户端里登录。')
  }

  // 快过期（或已经过期）时用 refreshToken 续一次；续不动就让上游回 401，
  // 由换号逻辑处理，而不是在这里把「可能还能用」的令牌丢掉。
  if (needsRefresh(expiresAtMs) && refreshToken !== '') {
    try {
      const refreshed = await exchangeRefreshToken(variantId, refreshToken, userId, signal)
      jwt = refreshed.token
      expiresAtMs = refreshed.expiresAtMs
      refreshToken = refreshed.refreshToken
      options.onRefreshed?.({
        accessToken: jwt,
        refreshToken,
        expiresAtMs,
        uid: userId,
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      // 续期失败但旧令牌还没过期：继续用它，让上游给出真实结论。
      if (Date.now() < expiresAtMs) {
        // 继续使用旧令牌
      } else {
        throw error
      }
    }
  }

  return {
    variant: variantId,
    jwt,
    userId,
    name,
    email,
    avatarUrl,
    refreshToken,
    expiresAtMs,
    file,
    region: endpoints.region,
  }
}

/**
 * 读登录状态（不换令牌、不消耗任何上游额度之外的资源）。
 *
 * 用来给设置卡片显示「已登录 / 未登录」，失败时把原因带回去。
 *
 * @param variantId - 变体。
 * @param authFile - 用户手填路径。
 * @returns 状态对象。
 */
export function describeStoredAuth(variantId, authFile) {
  try {
    const auth = readStoredAuth(variantId, authFile)
    const stat = (() => {
      try {
        return statSync(auth.file)
      } catch {
        return undefined
      }
    })()
    return {
      status: 'signed-in',
      source: 'desktop',
      name: auth.name,
      email: auth.email,
      userId: auth.userId,
      avatarUrl: auth.avatarUrl,
      expiresAtMs: auth.expiredAtMs,
      refreshable: auth.refreshToken !== '',
      file: auth.file,
      ...(stat === undefined ? {} : { fileModifiedAt: stat.mtimeMs }),
    }
  } catch (error) {
    return {
      status: 'signed-out',
      reason: error?.code ?? REASON.credentialUnreadable,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
