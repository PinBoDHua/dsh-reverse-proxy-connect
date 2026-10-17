/**
 * WorkBuddy 的浏览器登录（插件授权流程）。
 *
 * 三步，全部走官方「插件登录」端点，不需要启动桌面 App：
 *
 * 1. `POST /v2/plugin/auth/state?platform=...` → `{state, authUrl}`
 * 2. 把 `authUrl` 丢给系统浏览器，用户在那里登录
 * 3. 轮询 `GET /v2/plugin/auth/token?state=...` 拿到 `{accessToken, refreshToken, ...}`
 *    再 `GET /v2/plugin/login/account?state=...` 拿到 `{uid, nickname, enterpriseId}`
 *
 * 这套端点是 WorkBuddy 自己的 IDE 插件在用的，请求头里那几个 `X-No-*` 就是
 * 「这次调用还没登录、不要带鉴权」的意思。
 *
 * @module dsh-reverse-proxy-connect/workbuddy/browser-login
 */

// @ts-check
import { spawn as nodeSpawn } from 'node:child_process'

import { attributionHeaders } from '../attribution.js'

/** 轮询间隔。 */
const POLL_MS = 1200

/** 整体超时：5 分钟足够走完扫码/账号密码 + 可能的二次验证。 */
const TIMEOUT_MS = 5 * 60_000

/** 单次请求超时。 */
const REQUEST_TIMEOUT_MS = 20_000

/** 上游「还没好」的信号码。 */
const CODE_TOKEN_NOT_READY = 11217
const CODE_ACCOUNT_NOT_READY = 12151

/**
 * 每个变体的登录参数。
 *
 * `platform` 是 authUrl 里的平台标识 —— 国内版是 `ide`，国际版是 `workbuddy-ai`，
 * 这是实测出来的：填错会拿到一个登录后不回跳的地址。
 *
 * @param variantId - `workbuddy` / `workbuddy-ai`。
 * @returns 参数。
 */
export function loginTarget(variantId) {
  return variantId === 'workbuddy'
    ? {
        endpoint: 'https://www.codebuddy.cn',
        apiDomain: 'copilot.tencent.com',
        userAgent: 'CodeBuddyIDE/1.106.1',
        platform: 'ide',
      }
    : {
        endpoint: 'https://www.workbuddy.ai',
        apiDomain: 'www.workbuddy.ai',
        userAgent: 'WorkBuddy/5.5.2',
        platform: 'workbuddy-ai',
      }
}

/** 未登录时的公共请求头。 */
function anonymousHeaders(target) {
  return {
    'X-Domain': target.apiDomain,
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'User-Agent': target.userAgent,
    Accept: 'application/json',
    ...attributionHeaders(),
  }
}

/** 读响应体里的 data（容忍 code/envelope 形态）。 */
function dataOf(body) {
  if (body === null || typeof body !== 'object') return undefined
  return body.data !== null && typeof body.data === 'object' ? body.data : undefined
}

/** 读错误码。 */
function codeOf(body) {
  const code = body !== null && typeof body === 'object' ? body.code : undefined
  if (typeof code === 'number') return code
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code)
  return undefined
}

/**
 * 申请一次登录态。
 *
 * @param variantId - 变体。
 * @param signal - 取消。
 * @returns `{state, authUrl}`。
 */
export async function requestAuthState(variantId, signal) {
  const target = loginTarget(variantId)
  const response = await fetch(
    `${target.endpoint}/v2/plugin/auth/state?platform=${encodeURIComponent(target.platform)}`,
    { method: 'POST', headers: anonymousHeaders(target), signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  )
  const text = await response.text()
  if (!response.ok) throw new Error(`申请登录失败（HTTP ${String(response.status)}）：${text.slice(0, 120)}`)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('申请登录失败：响应不是 JSON')
  }
  const data = dataOf(body)
  const state = typeof data?.state === 'string' ? data.state : ''
  const authUrl = typeof data?.authUrl === 'string' ? data.authUrl : ''
  if (state === '' || authUrl === '') throw new Error('申请登录失败：响应里缺少 state 或 authUrl')
  return { state, authUrl }
}

/**
 * 自动打开浏览器时允许的 URL。
 *
 * 只接受 https，且拒绝引号与换行：这个字符串会进入 Windows 命令行，
 * 不能让上游返回值有机会改变命令结构。
 *
 * @param url - 登录地址。
 * @returns 安全 URL，或 undefined。
 */
export function safeBrowserUrl(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return undefined
  if (/["\r\n]/.test(url)) return undefined
  return url
}

/**
 * 构造打开浏览器的命令。
 *
 * Windows 上**必须**把 URL 用双引号包起来并启用 `windowsVerbatimArguments`：
 * `cmd` 在解析 `&` 时不会因为 `start ""` 就把 URL 当成一个整体，未加引号时
 * 会把 `https://…/login?platform=ide&state=…` 截成两段，浏览器只收到
 * `?platform=ide`。登录页拿不到 state，就显示「登录链接不完整」。
 *
 * 这一条是 1.1.0 登录失败的实际原因：登录地址本身是对的，坏在打开方式。
 *
 * @param url - 登录地址。
 * @returns `{command, args, options}`，或 undefined（URL 不合法）。
 */
export function browserOpenCommand(url) {
  const safe = safeBrowserUrl(url)
  if (safe === undefined) return undefined
  if (process.platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/d', '/s', '/c', 'start', '""', `"${safe}"`],
      options: { windowsVerbatimArguments: true },
    }
  }
  if (process.platform === 'darwin') return { command: 'open', args: [safe], options: {} }
  return { command: 'xdg-open', args: [safe], options: {} }
}

/**
 * 把登录地址交给系统浏览器。
 *
 * @param url - 登录地址。
 * @param spawn - 注入的 spawn（测试用）。
 * @returns 是否成功发起。
 */
export function openInBrowser(url, spawn) {
  const spec = browserOpenCommand(url)
  if (spec === undefined) return false
  try {
    const child = spawn(spec.command, spec.args, {
      ...spec.options,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref?.()
    return true
  } catch {
    return false
  }
}

/**
 * 轮询换取 token。
 *
 * @param variantId - 变体。
 * @param state - 登录态。
 * @param options - `{ signal?, timeoutMs?, pollMs?, now? }`。
 * @returns 归一化 token。
 */
export async function pollAuthToken(variantId, state, options = {}) {
  const target = loginTarget(variantId)
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMs ?? TIMEOUT_MS)
  const pollMs = options.pollMs ?? POLL_MS
  const url = `${target.endpoint}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`

  for (;;) {
    if (options.signal?.aborted === true) throw new Error('登录已取消')
    if (now() >= deadline) throw new Error('等待登录超时（5 分钟）')
    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'X-No-Authorization': 'true', 'User-Agent': target.userAgent, Accept: 'application/json', ...attributionHeaders() },
        signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      await sleep(pollMs)
      continue
    }
    const text = await response.text().catch(() => '')
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    if (response.ok) {
      const data = dataOf(body)
      const accessToken = typeof data?.accessToken === 'string' ? data.accessToken : ''
      if (accessToken !== '') return normalizeToken(data)
      await sleep(pollMs)
      continue
    }
    if (codeOf(body) === CODE_TOKEN_NOT_READY) {
      await sleep(pollMs)
      continue
    }
    throw new Error(`换取登录令牌失败（HTTP ${String(response.status)}）：${text.slice(0, 120)}`)
  }
}

/**
 * 把上游 token 响应归一化。
 * @param data - 响应里的 data。
 * @returns 归一化 token。
 */
export function normalizeToken(data) {
  const numberOr = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  const absoluteMs = (absolute, relativeSeconds, token) => {
    if (typeof absolute === 'number' && Number.isFinite(absolute)) return absolute > 1e12 ? absolute : absolute * 1000
    if (typeof absolute === 'string' && absolute !== '') {
      const asNumber = /^\d+$/.test(absolute) ? Number(absolute) : Date.parse(absolute)
      if (Number.isFinite(asNumber)) return asNumber > 1e12 ? asNumber : asNumber * 1000
    }
    const seconds = numberOr(relativeSeconds, 0)
    if (seconds > 0) return Date.now() + seconds * 1000
    return jwtExpMs(token) ?? 0
  }
  const accessToken = typeof data?.accessToken === 'string' ? data.accessToken : ''
  return {
    accessToken,
    refreshToken: typeof data?.refreshToken === 'string' ? data.refreshToken : '',
    expiresAtMs: absoluteMs(data?.expiresAt, data?.expiresIn, accessToken),
    refreshExpiresAtMs: absoluteMs(data?.refreshExpiresAt, data?.refreshExpiresIn, accessToken),
    domain: typeof data?.domain === 'string' ? data.domain : '',
  }
}

/** 从 JWT 里读 exp（拿不到就 undefined）。 */
function jwtExpMs(token) {
  if (typeof token !== 'string' || token === '') return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/** 从 JWT 里读昵称/sub（账号接口没给时的兜底）。 */
function jwtField(token, keys) {
  if (typeof token !== 'string' || token === '') return ''
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    for (const key of keys) if (typeof payload[key] === 'string' && payload[key] !== '') return payload[key]
    return ''
  } catch {
    return ''
  }
}

/**
 * 轮询账号信息（uid / nickname / enterpriseId）。
 *
 * @param variantId - 变体。
 * @param state - 登录态。
 * @param token - 上一步拿到的 token。
 * @param options - `{ signal?, timeoutMs?, pollMs?, now? }`。
 * @returns 归一化账号信息。
 */
export async function pollLoginAccount(variantId, state, token, options = {}) {
  const target = loginTarget(variantId)
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMs ?? TIMEOUT_MS)
  const pollMs = options.pollMs ?? POLL_MS
  const url = `${target.endpoint}/v2/plugin/login/account?state=${encodeURIComponent(state)}`
  const headers = {
    'X-Domain': token.domain !== '' ? token.domain : target.apiDomain,
    Authorization: `Bearer ${token.accessToken}`,
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'User-Agent': target.userAgent,
    Accept: 'application/json',
    ...attributionHeaders(),
  }

  for (;;) {
    if (options.signal?.aborted === true) throw new Error('登录已取消')
    if (now() >= deadline) throw new Error('等待账号信息超时（5 分钟）')
    let response
    try {
      response = await fetch(url, { method: 'GET', headers, signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch {
      await sleep(pollMs)
      continue
    }
    const text = await response.text().catch(() => '')
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    if (response.ok) {
      const data = dataOf(body)
      if (data !== undefined && typeof data === 'object') {
        const uid = typeof data.uid === 'string' ? data.uid : jwtField(token.accessToken, ['sub'])
        const nickname = typeof data.nickname === 'string' && data.nickname !== ''
          ? data.nickname
          : jwtField(token.accessToken, ['nickname', 'preferred_username', 'name'])
        return {
          uid,
          nickname,
          enterpriseId: typeof data.enterpriseId === 'string' ? data.enterpriseId : '',
        }
      }
      await sleep(pollMs)
      continue
    }
    if (codeOf(body) === CODE_ACCOUNT_NOT_READY) {
      await sleep(pollMs)
      continue
    }
    throw new Error(`读取账号信息失败（HTTP ${String(response.status)}）：${text.slice(0, 120)}`)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 走完一整套浏览器登录。
 *
 * @param options - `{ variantId, openBrowser?, spawn?, signal?, pollMs?, timeoutMs?, onUpdate? }`。
 * @returns `{loginUrl, result, close}`。
 */
export function startBrowserLogin(options) {
  const { variantId, spawn, onUpdate } = options
  const controller = new AbortController()
  const signal = options.signal === undefined
    ? controller.signal
    : AbortSignal.any([options.signal, controller.signal])
  const notify = (patch) => { if (typeof onUpdate === 'function') onUpdate(patch) }

  const result = (async () => {
    notify({ phase: 'starting', message: '正在申请登录地址…' })
    const { state, authUrl } = await requestAuthState(variantId, signal)
    const opened = options.openBrowser === false ? false : openInBrowser(authUrl, spawn ?? defaultSpawn())
    notify({
      phase: 'waiting',
      message: opened ? '已在浏览器打开登录页，登录后会自动完成' : '请手动在浏览器打开下面的地址完成登录',
      authUrl,
      opened,
    })
    const token = await pollAuthToken(variantId, state, { ...options, signal })
    notify({ phase: 'waiting', message: '登录成功，正在读取账号信息…', authUrl, opened })
    const account = await pollLoginAccount(variantId, state, token, { ...options, signal })
    const label = account.nickname !== '' ? account.nickname : (account.uid !== '' ? account.uid.slice(0, 8) : 'WorkBuddy 账号')
    notify({ phase: 'done', message: `登录成功：${label}`, authUrl, opened })
    return { token, account, label }
  })()

  return {
    result,
    get loginUrl() { return undefined },
    close() { controller.abort() },
  }
}

/** 默认 spawn（延迟取，避免测试环境真的去开浏览器）。 */
function defaultSpawn() {
  return nodeSpawn
}
