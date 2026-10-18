/**
 * Qoder 传输层：PAT → job token、COSY 签名、WAF body 编码、目录、聊天流。
 *
 * Qoder **没有**任何 OpenAI 兼容端点：请求要重新封装成它自己的 envelope，
 * 响应是「外层 SSE 包着内层 SSE」两层结构。所以这一层做的是真正的翻译，
 * 而不是转发。
 *
 * 三条最容易写错的约定（已对上游实测确认）：
 * 1. 签名 `sigInput` 是五段用 `\n` 连接、**结尾不带换行**；且签的是
 *    WAF 编码**之后**的字节，不是 JSON 明文。
 * 2. `Cosy-Sigpath` 是 pathname 去掉开头的 `/algo` —— 与 URL 里加 `/algo`
 *    正好相反。
 * 3. AES-128-CBC 的 key 和 IV 是**同一个** 16 字节字符串；RSA 用的是 PKCS#1 v1.5。
 *
 * @module dsh-reverse-proxy-connect/qoder/transport
 */

import crypto, { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { REASON } from '../protocol.js'
import { CancelledError, withTimeout } from '../timeout.js'
import { attributionHeaders } from '../attribution.js'

/** Qoder 自己客户端上报的版本；COSY 与 openApi 两族用的值不同。 */
const COSY_IDE_VERSION = '1.1.47'

/** openApi 族请求头里的 cosy-version（历史遗留的 1.0.1，不能统一）。 */
const OPENAPI_COSY_VERSION = '1.0.1'

/** Qoder 网关验签用的 RSA 公钥（从上游客户端里取到的常量）。 */
const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

/** WAF 的自定义 base64 字母表。 */
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 字节翻译表：标准 base64 字母 → 自定义字母，`=` → `$`。 */
const ENCODE_TABLE = (() => {
  const table = new Uint8Array(256)
  for (let index = 0; index < 256; index++) table[index] = index
  for (let index = 0; index < 64; index++) table[STD_ALPHABET.charCodeAt(index)] = CUSTOM_ALPHABET.charCodeAt(index)
  table['='.charCodeAt(0)] = '$'.charCodeAt(0)
  return table
})()

/** 两个区域的三个主机。 */
const ENDPOINTS = {
  global: { baseUrl: 'https://api3.qoder.sh/', openApiUrl: 'https://openapi.qoder.sh' },
  china: { baseUrl: 'https://gateway.qoder.com.cn/', openApiUrl: 'https://openapi.qoder.com.cn' },
}

/** Qoder 传输错误：带一个稳定的 failure 种类，反代据此映射 HTTP 状态。 */
export class QoderFailure extends Error {
  /**
   * @param code - REASON 码或 qoder 内部的语义种类。
   * @param message - 说明。
   * @param status - 建议回给客户端的 HTTP 状态。
   * @param kind - `soft-rate` / `quota` / `auth` / `server` / `malformed`，用于映射 LlmError。
   * @param retryAfterMs - 上游建议的重试等待。
   */
  constructor(code, message, status = 502, cause, kind = 'server', retryAfterMs) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'QoderFailure'
    this.code = code
    this.status = status
    this.kind = kind
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * 解析 `Retry-After` 头（秒数或 HTTP 日期），与 WorkBuddy 那边同一口径。
 *
 * Qoder 的排队提示通常写在响应体里（`retryAfterSeconds`），但网关/WAF 层
 * 限流时只有标准头。两处都要认，否则「上游让你 30 秒后再试」会被丢掉，
 * 本地只能退到默认等待。
 *
 * @param value - 响应头值。
 * @param now - 当前时间（测试可注入）。
 * @returns 毫秒，或 undefined。
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim()
  if (/^\d+$/.test(text)) {
    const seconds = Number(text)
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 10 * 60_000) : undefined
  }
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(Math.max(0, parsed - now), 10 * 60_000)
}

/**
 * 从上游错误体里认出「排队中 / 额度用尽」这两种**用 401/403 伪装**的软失败。
 *
 * 这是必须做的一步：Qoder 把排队饱和回成 HTTP 401/403 + `code:10605` +
 * `isQueued:true`，把额度耗尽回成 `code:110`。若照状态码直译，DSH 会把
 * 它们当成认证失败而不再重试。同时要把文案里的字面 `401`/`403` 洗掉，
 * 因为下游的分类器是先按文本匹配状态码数字的。
 *
 * @param raw - 上游原始错误体。
 * @param status - HTTP 状态。
 * @param retryAfterHeader - 响应头里的 `Retry-After`（可选；体现在没有 `retryAfterSeconds` 时兜底）。
 * @returns QoderFailure。
 */
export function classifyUpstreamBody(raw, status, retryAfterHeader) {
  const text = String(raw ?? '')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    /* 不是 JSON，按状态码处理 */
  }
  // 逐层剥开 code/message 里塞 JSON 的情况（上游就是这么干的）。
  let depth = 0
  let node = parsed
  let retryAfterSeconds
  let isQueued = false
  let code
  while (node !== undefined && node !== null && depth < 4) {
    if (typeof node.retryAfterSeconds === 'number') retryAfterSeconds = node.retryAfterSeconds
    if (node.isQueued === true) isQueued = true
    if (typeof node.code === 'string' || typeof node.code === 'number') {
      if (code === undefined) code = String(node.code)
    }
    const next = typeof node.message === 'string' ? node.message : undefined
    if (next === undefined) break
    try {
      node = JSON.parse(next)
    } catch {
      break
    }
    depth++
  }
  const retryAfterMs = typeof retryAfterSeconds === 'number'
    ? retryAfterSeconds * 1000
    : parseRetryAfter(typeof retryAfterHeader === 'string' ? retryAfterHeader : undefined)

  if (isQueued || code === '10605') {
    return new QoderFailure(
      'soft-rate',
      `Qoder 正在排队（${retryAfterSeconds === undefined ? '稍后' : `${String(retryAfterSeconds)} 秒后`}重试）。`,
      429,
      undefined,
      'soft-rate',
      retryAfterMs,
    )
  }
  if (code === '110') {
    return new QoderFailure('quota', 'Qoder 额度已用尽，请等待额度重置或升级套餐。', 402, undefined, 'quota')
  }
  if (status === 401 || status === 403) {
    return new QoderFailure('auth', `Qoder 拒绝了这个请求（HTTP ${String(status)}）：${text.slice(0, 160)}`, 401, undefined, 'auth')
  }
  // 普通 429 / 402 不一定带 isQueued 或 code 110：WAF/网关常只给一句
  // "Too Many Requests" 或空 body。不按状态码兜底就会落到 malformed，
  // 既不换号也不按限流/额度退避。
  if (status === 429) {
    return new QoderFailure(
      'soft-rate',
      `Qoder 限流（HTTP 429）：${text.slice(0, 160) || '稍后重试'}`,
      429,
      undefined,
      'soft-rate',
      retryAfterMs,
    )
  }
  if (status === 402) {
    return new QoderFailure('quota', `Qoder 额度已用尽（HTTP 402）：${text.slice(0, 160)}`, 402, undefined, 'quota')
  }
  if (status >= 500 || status === 0 || status === 408 || status === 504) {
    return new QoderFailure('server', `Qoder 服务暂时不可用（HTTP ${String(status)}）：${text.slice(0, 160)}`, 502, undefined, 'server', retryAfterMs)
  }
  return new QoderFailure('malformed', `Qoder 返回了无法处理的响应（HTTP ${String(status)}）：${text.slice(0, 160)}`, 502, undefined, 'malformed')
}

/**
 * 该区域的端点。
 * @param region - `global` 或 `china`。
 * @returns 端点对象。
 */
export function endpointsFor(region) {
  return ENDPOINTS[region] ?? ENDPOINTS.global
}

/**
 * 判断 PAT 属于哪个区域（只看前缀没有意义，这里仅做措辞）。
 * @param region - 区域。
 * @returns 一句中文说明。
 */
export function regionLabel(region) {
  return region === 'china' ? 'Qoder（国内版）' : 'Qoder Global（国际版）'
}

/**
 * WAF body 编码：base64 → 三分重排 → 自定义字母表。
 * @param plain - 明文字符串。
 * @returns 编码后的 latin1 字符串。
 */
export function encodeBody(plain) {
  const standard = Buffer.from(plain).toString('base64')
  const length = standard.length
  const third = Math.floor(length / 3)
  const rearranged = standard.slice(length - third) + standard.slice(third, length - third) + standard.slice(0, third)
  const source = Buffer.from(rearranged, 'latin1')
  const target = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index++) target[index] = ENCODE_TABLE[source[index] ?? 0] ?? 0
  return target.toString('latin1')
}

/**
 * 取签名用的 pathname：去掉 `/algo` 前缀。
 * @param url - 完整 URL。
 * @returns 签名路径。
 */
function signaturePath(url) {
  let path = new URL(url).pathname
  if (path.startsWith('/algo')) path = path.substring(5)
  return path
}

/**
 * 构造 COSY 认证头。
 * @param body - 已编码的请求体（GET 用 null）。
 * @param url - 请求 URL。
 * @param credentials - `{ userID, authToken, name, email, machineID }`。
 * @returns 头字典。
 */
export function buildAuthHeaders(body, url, credentials) {
  if (credentials.userID === '' || credentials.authToken === '') {
    throw new QoderFailure(REASON.patInvalid, 'Qoder 请求身份缺失。', 401, undefined, 'auth')
  }
  const aesKey = randomUUID().replace(/-/g, '').slice(0, 16)
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(aesKey), Buffer.from(aesKey))
  const userInfo = JSON.stringify({
    uid: credentials.userID,
    security_oauth_token: credentials.authToken,
    name: credentials.name || '',
    aid: '',
    email: credentials.email || '',
  })
  const infoB64 = cipher.update(userInfo, 'utf8', 'base64') + cipher.final('base64')
  const cosyKey = crypto
    .publicEncrypt({ key: RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(aesKey))
    .toString('base64')

  const timestamp = Math.floor(Date.now() / 1000).toString()
  const payloadB64 = Buffer.from(
    JSON.stringify({ version: 'v1', requestId: randomUUID(), info: infoB64, cosyVersion: COSY_IDE_VERSION, ideVersion: '' }),
  ).toString('base64')
  const sigPath = signaturePath(url)
  const bodyText = body === null || body === undefined ? '' : String(body)
  const signature = createHash('md5')
    .update(`${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyText}\n${sigPath}`)
    .digest('hex')

  return {
    Authorization: `Bearer COSY.${payloadB64}.${signature}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': credentials.userID,
    'Cosy-Date': timestamp,
    'Cosy-Version': COSY_IDE_VERSION,
    'Cosy-Machineid': credentials.machineID,
    'Cosy-Machinetoken': credentials.machineID,
    'Cosy-Machinetype': '5',
    'Cosy-Machineos': machineOs(),
    'Cosy-Clienttype': '5',
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': createHash('md5').update(bodyText).digest('hex'),
    'Cosy-Bodylength': bodyText === '' ? '0' : String(Buffer.byteLength(bodyText)),
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': 'disagree',
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': 'v2',
    'X-Request-Id': randomUUID(),
    ...attributionHeaders(),
  }
}

/** 计算 cosy 的机器操作系统标识。 */
function machineOs() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  return `${arch}_${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'}`
}

/**
 * 读或创建机器标识。优先复用官方 CLI 的那一个，让同一台设备身份稳定。
 * @param seedPath - 本插件自己的落盘位置（链尾，创建点）。
 * @returns 机器 id（UUID）。
 */
export function readMachineId(seedPath) {
  const chain = [join(homedir(), '.qoder', '.auth', 'machine_id'), seedPath].filter((path) => typeof path === 'string')
  for (const path of chain) {
    try {
      if (!existsSync(path)) continue
      const value = readFileSync(path, 'utf8').trim()
      if (value !== '') return value
    } catch {
      /* 读不到就试下一个 */
    }
  }
  const generated = randomUUID()
  try {
    mkdirSync(dirname(seedPath), { recursive: true })
    writeFileSync(seedPath, generated, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch {
    /* 落盘失败不影响本次进程使用 */
  }
  return generated
}

/**
 * PAT → job token → 用户身份。
 *
 * @param personalToken - PAT。
 * @param region - 区域。
 * @param cached - 进程内缓存（`{userID, authToken, name, email, machineID, expiresAtMs}`）。
 * @param machineId - 机器标识。
 * @param signal - 取消。
 * @returns 身份。
 */
export async function resolveIdentity(personalToken, region, cached, machineId, signal) {
  if (cached !== undefined && cached.expiresAtMs > Date.now() + 300_000 && cached.pat === personalToken) return cached
  const { openApiUrl } = endpointsFor(region)
  const common = {
    accept: 'application/json',
    'accept-encoding': 'identity',
    'user-agent': `qoder/${COSY_IDE_VERSION}`,
    'cosy-version': OPENAPI_COSY_VERSION,
    'cosy-clienttype': '5',
    ...attributionHeaders(),
  }
  const exchange = await fetch(`${openApiUrl}/api/v1/jobToken/exchange`, {
    method: 'POST',
    headers: { ...common, 'content-type': 'application/json' },
    body: JSON.stringify({ personal_token: personalToken }),
    signal: withTimeout(signal, 20_000),
  })
  const exchangeText = await exchange.text()
  if (!exchange.ok) {
    const retryAfterMs = parseRetryAfter(exchange.headers.get('retry-after'))
    // 只有 401/403 才是「这个 PAT 真的不能用」。5xx / 429 / 408 是上游暂时
    // 不可用或限流，告诉用户「请重新生成 PAT」既误导，又会把账号打进 AUTH 冷却。
    if (exchange.status === 401 || exchange.status === 403) {
      throw new QoderFailure(
        REASON.patInvalid,
        `${regionLabel(region)} 拒绝了该个人访问令牌（HTTP ${String(exchange.status)}）；请到账号设置里重新生成 PAT。`,
        401,
        undefined,
        'auth',
      )
    }
    if (exchange.status === 429) {
      throw new QoderFailure(
        'soft-rate',
        `${regionLabel(region)} 令牌交换被限流（HTTP 429），这不是 PAT 失效；请稍后重试。`,
        429,
        undefined,
        'soft-rate',
        retryAfterMs,
      )
    }
    throw new QoderFailure(
      'server',
      `${regionLabel(region)} 令牌交换服务暂时不可用（HTTP ${String(exchange.status)}），这不是 PAT 失效；请稍后重试。`,
      exchange.status >= 500 ? 502 : exchange.status,
      undefined,
      'server',
      retryAfterMs,
    )
  }
  let job
  try {
    job = JSON.parse(exchangeText)
  } catch (cause) {
    throw new QoderFailure(REASON.upstreamError, 'Qoder 令牌交换返回了非 JSON。', 502, cause)
  }
  if (typeof job?.token !== 'string' || job.token === '') {
    throw new QoderFailure(REASON.patInvalid, 'Qoder 令牌交换没有返回 job token。', 401, undefined, 'auth')
  }
  const infoResponse = await fetch(`${openApiUrl}/api/v1/userinfo`, {
    headers: { ...common, authorization: `Bearer ${job.token}` },
    signal: withTimeout(signal, 20_000),
  })
  if (!infoResponse.ok) {
    throw new QoderFailure(REASON.upstreamError, `Qoder 用户信息返回 HTTP ${String(infoResponse.status)}。`, 502)
  }
  const info = await infoResponse.json()
  if (typeof info?.id !== 'string' || info.id === '') {
    throw new QoderFailure(REASON.upstreamError, 'Qoder 用户信息里没有 id。', 502)
  }
  const expiresAt = typeof job.expires_at === 'string' ? Date.parse(job.expires_at) : Number.NaN
  return {
    pat: personalToken,
    region,
    userID: info.id,
    authToken: job.token,
    name: typeof info.name === 'string' ? info.name : '',
    email: typeof info.email === 'string' ? info.email : '',
    machineID: machineId,
    expiresAtMs: Number.isNaN(expiresAt) ? Date.now() + 3_600_000 : expiresAt,
  }
}

/**
 * 列该区域的模型目录。
 * @param identity - 身份。
 * @param signal - 取消。
 * @returns 模型行。
 */
export async function fetchCatalog(identity, signal) {
  const { baseUrl } = endpointsFor(identity.region)
  const url = `${baseUrl}algo/api/v2/model/list?Encode=1`
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'accept-encoding': 'identity',
      'user-agent': `qoder/${COSY_IDE_VERSION}`,
      'cosy-version': OPENAPI_COSY_VERSION,
      'cosy-clienttype': '5',
      ...buildAuthHeaders(null, url, identity),
    },
    signal: withTimeout(signal, 20_000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new QoderFailure(REASON.upstreamError, `Qoder 模型目录返回 HTTP ${String(response.status)}：${text.slice(0, 160)}`, response.status)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch (cause) {
    throw new QoderFailure(REASON.upstreamError, 'Qoder 模型目录不是合法 JSON。', 502, cause)
  }
  return parseCatalog(payload)
}

/**
 * 解析 Qoder 目录：只看 `chat` 组里 `enable === true` 的模型。
 * @param payload - 目录文档。
 * @returns 模型行。
 */
export function parseCatalog(payload) {
  const rows = Array.isArray(payload?.chat) ? payload.chat : []
  const models = []
  const seen = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (row.enable !== true) continue
    if (typeof row.key !== 'string' || row.key === '') continue
    // 宿主遇到重复 id 会拒绝整份目录；重复时保留第一份。
    if (seen.has(row.key)) continue
    seen.add(row.key)
    const contextOptions = parseContextOptions(row.context_config)
    const defaults = Object.values(contextOptions).filter((option) => option.isDefault === true && option.tokenCount > 0)
    const contextWindow = defaults.length === 1
      ? defaults[0].tokenCount
      : Math.max(1, Number(row.max_input_tokens) || 180_000)
    const efforts = parseEfforts(row.thinking_config)
    const isReasoning = row.is_reasoning === true || efforts.length > 0
    models.push({
      id: row.key,
      name: typeof row.display_name === 'string' && row.display_name !== '' ? row.display_name : row.key,
      contextWindow,
      maxTokens: Math.max(1, Number(row.max_output_tokens) || 32_768),
      supportsImages: row.is_vl === true,
      supportsReasoning: isReasoning,
      reasoningEfforts: efforts,
      defaultEffort: defaultEffortOf(row.thinking_config),
      // Qoder 侧思考不可关；卡片与选择器据此不提供 off 档。
      canDisableThinking: false,
      credits: typeof row.price_factor === 'number' ? (row.price_factor === 0 ? 'x0' : `x${String(row.price_factor)}`) : undefined,
      contextOptions,
      source: typeof row.source === 'string' ? row.source : 'system',
    })
  }
  return models
}

/** 把 `context_config` 解析成 `{ 名称: {tokenCount, isDefault} }`。 */
function parseContextOptions(value) {
  const out = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || typeof raw !== 'object') continue
    const tokenCount = typeof raw.token_count === 'number' && raw.token_count > 0 ? raw.token_count : 0
    if (tokenCount === 0) continue
    out[key] = { tokenCount, isDefault: raw.is_default === true }
  }
  return out
}

/** 取 `thinking_config` 里声明的档位，按由弱到强排序。 */
function parseEfforts(thinkingConfig) {
  const order = ['low', 'medium', 'high', 'xhigh', 'max']
  const declared = thinkingConfig?.enabled?.efforts
  if (declared === null || typeof declared !== 'object') return []
  return Object.keys(declared).filter((effort) => order.includes(effort)).sort((a, b) => order.indexOf(a) - order.indexOf(b))
}

/** 取默认思考档。 */
function defaultEffortOf(thinkingConfig) {
  const declared = thinkingConfig?.enabled?.efforts
  if (declared === null || typeof declared !== 'object') return undefined
  for (const [effort, value] of Object.entries(declared)) {
    if (value !== null && typeof value === 'object' && value.is_default === true) return effort
  }
  return undefined
}

/**
 * 把一份 OpenAI 形状的请求编译成 Qoder 的 envelope（**未编码**）。
 *
 * @param options - `{ model, body, sessionId, modelRow }`。
 * @returns envelope 对象。
 */
export function buildChatEnvelope(options) {
  const { model, body, modelRow } = options
  const modelKey = model || 'cmodel'
  const messages = Array.isArray(body.messages) ? body.messages : []
  const tools = Array.isArray(body.tools) ? body.tools : []
  const maxTokens = Math.min(
    typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : 32_768,
    Math.max(1, Number(modelRow?.maxTokens) || 32_768),
  )
  const reasoningEffort = typeof body.reasoning_effort === 'string' && body.reasoning_effort !== 'off' ? body.reasoning_effort : undefined
  const isReasoning = reasoningEffort !== undefined || modelRow?.supportsReasoning === true

  const contexts = modelRow?.contextOptions ?? {}
  const defaultContexts = Object.values(contexts).filter((option) => option.isDefault === true && option.tokenCount > 0)
  const contextConfig = defaultContexts.length === 1
    ? Object.fromEntries(
        Object.entries(contexts).map(([key, value]) => [
          key,
          { token_count: value.tokenCount, is_default: value.isDefault === true },
        ]),
      )
    : undefined

  const translated = translateMessages(messages)
  let lastUserText = ''
  for (let index = translated.length - 1; index >= 0; index--) {
    const message = translated[index]
    if (message?.role !== 'user') continue
    lastUserText = typeof message.content === 'string' ? message.content : ''
    break
  }

  const recordId = stableChatRecordId(modelKey, translated, tools, maxTokens)
  const sessionPrefix = stableHash('qoder-session', options.sessionUser ?? '', modelKey)
  return {
    request_id: randomUUID(),
    request_set_id: recordId,
    chat_record_id: recordId,
    session_id: options.sessionId === undefined ? `${sessionPrefix}-${randomUUID()}` : `${sessionPrefix}-${String(options.sessionId)}`,
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    system: '',
    messages: translated,
    tools: translateTools(tools),
    parameters: {
      max_tokens: maxTokens,
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    },
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: { context: [], modelConfig: { key: modelKey, is_reasoning: isReasoning }, originalContent: lastUserText },
      features: [],
      text: lastUserText,
    },
    model_config: {
      key: modelKey,
      is_reasoning: isReasoning,
      max_output_tokens: maxTokens,
      source: modelRow?.source || 'system',
      ...(contextConfig === undefined ? {} : { context_config: contextConfig }),
    },
    business: {
      product: 'cli',
      version: '1.0.0',
      type: 'agent',
      stage: 'start',
      id: randomUUID(),
      name: lastUserText.substring(0, 30),
      begin_at: Date.now(),
    },
  }
}

/** sha256 前 16 字节十六进制。 */
function stableHash(prefix, ...inputs) {
  const hash = crypto.createHash('sha256')
  hash.update(prefix)
  for (const input of inputs) {
    hash.update('\0')
    hash.update(String(input))
  }
  return hash.digest('hex').slice(0, 16)
}

/** 与上游一致的 chat record id：同模型同上下文同上限 ⇒ 同 id（重试不重复计费记录）。 */
function stableChatRecordId(model, messages, tools, maxTokens) {
  const hash = crypto.createHash('sha256')
  hash.update('qoder-record')
  hash.update('\0')
  hash.update(model)
  hash.update('\0')
  hash.update(JSON.stringify(messages))
  hash.update('\0')
  hash.update(JSON.stringify(tools))
  hash.update('\0')
  hash.update(`mt=${maxTokens}`)
  return hash.digest('hex').slice(0, 16)
}

/**
 * OpenAI 消息 → Qoder 消息。
 *
 * 差异点：assistant 的空文本要改成 `" "`（上游拒空）；`tool` 角色要带
 * `tool_call_id`；`developer` 角色 Qoder 直接拒绝，折算成 system。
 *
 * @param messages - OpenAI 消息数组。
 * @returns Qoder 消息数组。
 */
export function translateMessages(messages) {
  const out = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role
    if (role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
        content: flattenContent(message.content),
      })
      continue
    }
    if (role === 'assistant') {
      const text = flattenContent(message.content)
      const row = { role: 'assistant', content: text === '' ? ' ' : text }
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        row.tool_calls = message.tool_calls.map((call) => ({
          id: call?.id ?? '',
          type: 'function',
          function: {
            name: call?.function?.name ?? '',
            arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call?.function?.arguments ?? {}),
          },
        }))
      }
      out.push(row)
      continue
    }
    const normalizedRole = role === 'developer' ? 'system' : role === 'system' ? 'system' : 'user'
    const content = message.content
    if (Array.isArray(content)) {
      const parts = []
      for (const part of content) {
        if (part === null || typeof part !== 'object') continue
        if (part.type === 'text' && typeof part.text === 'string') parts.push({ type: 'text', text: part.text })
        else if (part.type === 'image_url' && typeof part.image_url?.url === 'string') parts.push({ type: 'image_url', image_url: { url: part.image_url.url } })
      }
      out.push({ role: normalizedRole, content: parts.length === 0 ? '' : parts })
      continue
    }
    out.push({ role: normalizedRole, content: typeof content === 'string' ? content : flattenContent(content) })
  }
  return out
}

/** 把 content（字符串或分片数组）压成纯文本。 */
function flattenContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

/** OpenAI tools → Qoder tools。 */
export function translateTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools
    .filter((tool) => tool !== null && typeof tool === 'object' && typeof tool.function?.name === 'string')
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: typeof tool.function.description === 'string' ? tool.function.description : '',
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      },
    }))
}

/**
 * 打开一条 Qoder 聊天流。
 *
 * @param identity - 身份。
 * @param envelope - 未编码的 envelope。
 * @param signal - 取消。
 * @returns `{ response }`。
 */
export async function openChat(identity, envelope, signal) {
  const { baseUrl } = endpointsFor(identity.region)
  const encoded = encodeBody(JSON.stringify(envelope))
  const url = `${baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
      'accept-encoding': 'identity',
      'x-model-key': envelope.model_config?.key ?? 'cmodel',
      'x-model-source': envelope.model_config?.source ?? 'system',
      ...buildAuthHeaders(encoded, url, identity),
    },
    body: encoded,
    signal,
  })
  if (!response.ok) {
    const text = await response.text()
    throw classifyUpstreamBody(text, response.status, response.headers.get('retry-after'))
  }
  const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    throw new QoderFailure(
      REASON.upstreamError,
      `Qoder 聊天返回了非流式内容（Content-Type: ${contentType}），通常意味着登录失效或被网关拦截。`,
      502,
      undefined,
      'malformed',
    )
  }
  return response
}

/**
 * 解析 Qoder 的两层 SSE，产出归一化事件。
 *
 * 外层：`data: {"statusCodeValue":200,"body":"<内层 JSON 字符串>"}`
 * 内层：标准 `chat.completion.chunk`
 * `[DONE]` 两层都认。
 *
 * **终态要等 `[DONE]` / EOF 再发**：与 WorkBuddy 的 OpenAI SSE 一样，Qoder 也
 * 可能先给 `finish_reason`、再单独给一个只带 usage 的 chunk。1.2.0 在这里
 * 立即 yield finish，调用方收到 finish 就收流，后面的 usage 永远到不了统计。
 *
 * @param stream - `response.body`。
 * @param signal - 取消。
 * @yields `{type:'text'|'reasoning', text}` / `{type:'tool', index, id, name, argumentsDelta}` / `{type:'usage', usage}` / `{type:'finish', kind}`。
 */
export async function* parseStream(stream, signal) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const toolCalls = new Map()
  let finishKindValue

  /** 只产出一次终态，且永远排在最后。 */
  const finishEvent = () => ({
    type: 'finish',
    kind: finishKindValue ?? (toolCalls.size > 0 ? 'tool-calls' : 'stop'),
  })

  try {
    while (true) {
      if (signal?.aborted === true) throw new CancelledError()
      const { done, value } = await reader.read()
      // 与 OpenAI SSE 一致：这一批字节没有产出内容事件时发心跳。Qoder 排队/
      // 思考阶段会持续发外层空帧，字节还在流动就说明连接是活的，空闲看门狗
      // 必须据此重新计时，否则第 3 分钟会把一条正常的排队请求切断。
      let emitted = false
      if (done) {
        // 与 OpenAI SSE 一样：flush decoder，并把缺末尾换行的最后一行当完整事件。
        buffer += decoder.decode()
        if (buffer !== '' && !buffer.endsWith('\n')) buffer += '\n'
      } else {
        buffer += decoder.decode(value, { stream: true })
      }
      let newlineIndex
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '') continue
        if (payload === '[DONE]') {
          yield finishEvent()
          return
        }
        let outer
        try {
          outer = JSON.parse(payload)
        } catch {
          if (payload.startsWith('{') || payload.startsWith('[')) {
            const failure = new QoderFailure('malformed', `Qoder 外层 SSE 返回了损坏的 JSON 帧：${payload.slice(0, 120)}`, 502, undefined, 'malformed')
            throw failure
          }
          continue
        }
        if (outer === null || typeof outer !== 'object') continue
        const rawStatus = outer.statusCodeValue
        const status = typeof rawStatus === 'number'
          ? rawStatus
          : typeof rawStatus === 'string' && rawStatus.trim() !== ''
            ? Number(rawStatus)
            : undefined
        if (typeof status === 'number' && Number.isFinite(status) && status !== 200) {
          // body 不一定是字符串：对象时先序列化，否则 classifyUpstreamBody 会
          // 只看到 `[object Object]`，认不出 10605 这种排队码。
          const bodyText = typeof outer.body === 'string' ? outer.body : JSON.stringify(outer.body ?? '')
          throw classifyUpstreamBody(bodyText, status)
        }
        let inner = outer
        if (typeof outer.body === 'string') {
          if (outer.body.trim() === '[DONE]') {
            yield finishEvent()
            return
          }
          try {
            inner = JSON.parse(outer.body)
          } catch {
            if (outer.body.trim().startsWith('{') || outer.body.trim().startsWith('[')) {
              const failure = new QoderFailure('malformed', `Qoder 内层 SSE 返回了损坏的 JSON：${outer.body.slice(0, 120)}`, 502, undefined, 'malformed')
              throw failure
            }
            continue
          }
        }
        if (inner === null || typeof inner !== 'object') continue
        // Qoder 也会在 200 的流里塞 `{error:{code,message,isQueued}}`；
        // 以前这里完全忽略，用户只看到一条空白回答。
        if (inner.error !== undefined && inner.error !== null) {
          const detail = typeof inner.error === 'object' ? inner.error : { message: String(inner.error) }
          throw classifyUpstreamBody(JSON.stringify(detail), 500)
        }
        const choice = Array.isArray(inner.choices) ? inner.choices[0] : undefined
        const delta = choice?.delta
        if (delta !== null && typeof delta === 'object') {
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
            emitted = true
            yield { type: 'reasoning', text: delta.reasoning_content }
          }
          if (typeof delta.content === 'string' && delta.content !== '') {
            emitted = true
            yield { type: 'text', text: delta.content }
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              if (call === null || typeof call !== 'object') continue
              const index = typeof call.index === 'number' ? call.index : 0
              const previous = toolCalls.get(index) ?? { id: '', name: '', arguments: '' }
              if (typeof call.id === 'string' && call.id !== '') previous.id = call.id
              if (typeof call.function?.name === 'string' && call.function.name !== '') previous.name = call.function.name
              const deltaText = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
              previous.arguments += deltaText
              toolCalls.set(index, previous)
              emitted = true
              yield { type: 'tool', index, id: previous.id, name: previous.name, argumentsDelta: deltaText }
            }
          }
        }
        if (inner.usage !== undefined && inner.usage !== null) {
          emitted = true
          yield { type: 'usage', usage: normalizeUsage(inner.usage) }
        }
        const finishReason = choice?.finish_reason
        if (typeof finishReason === 'string' && finishReason !== '') {
          // 只记终态；等 [DONE]/EOF。后面还可能跟一个纯 usage 的 chunk。
          finishKindValue = finishKind(finishReason, toolCalls.size > 0)
          emitted = true
        }
      }
      if (done) break
      if (!emitted) yield { type: 'heartbeat' }
    }
    yield finishEvent()
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* 取消失败无所谓 */
    }
  }
}

/** 上游 usage → DSH 的 TokenUsage。 */
export function normalizeUsage(usage) {
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const cacheRead = typeof usage.prompt_tokens_details?.cached_tokens === 'number' ? usage.prompt_tokens_details.cached_tokens : 0
  const cacheWrite = typeof usage.prompt_tokens_details?.cache_write_tokens === 'number' ? usage.prompt_tokens_details.cache_write_tokens : 0
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  const reasoningTokens = typeof usage.completion_tokens_details?.reasoning_tokens === 'number' ? usage.completion_tokens_details.reasoning_tokens : undefined
  return {
    inputTokens: Math.max(0, promptTokens - cacheRead - cacheWrite),
    outputTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

/**
 * 上游 finish_reason → DSH 的 FinishReason.kind。
 * @param value - 上游值。
 * @param sawToolCalls - 是否见过 tool_calls（见过就以 tool-calls 为准）。
 * @returns kind。
 */
export function finishKind(value, sawToolCalls) {
  if (sawToolCalls) return 'tool-calls'
  if (value === 'length') return 'max-tokens'
  if (value === 'tool_calls' || value === 'toolUse') return 'tool-calls'
  if (value === 'content_filter') return 'error'
  return 'stop'
}
