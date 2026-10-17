/**
 * WorkBuddy「打开 App 登录 → 自动导入账号」。
 *
 * ## 为什么是这条路
 *
 * WorkBuddy 没有面向第三方的 OAuth 回调，我们也没有自己的网关可以中转登录，
 * 所以没法像某些插件那样「打开网页 → 轮询网关拿 token」。但它的桌面端在登录
 * 成功后会把令牌写进本机的一个 JSON（`workbuddy-desktop.info`）——
 * 只要盯着这个文件的 `account.uid` 变化，就能知道「用户刚登录了一个新账号」。
 *
 * ## 为什么要快照
 *
 * 那个文件里只有**当前登录账号**的 token（`accounts` 数组只是账号列表的元信息，
 * 没有各自的令牌）。所以每次登录成功后必须立刻把文件复制一份到插件数据目录，
 * 之后这个账号就一直用那份快照，不会被下一次登录覆盖。
 *
 * @module dsh-reverse-proxy-connect/workbuddy/login-flow
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { authFileCandidates, resolveAppBinary, VARIANTS } from './credentials.js'

/** 轮询间隔。 */
const POLL_MS = 1500

/** 默认等待时长：登录 + 可能的二次验证，5 分钟足够。 */
const TIMEOUT_MS = 5 * 60_000

/**
 * 从登录文件里读出明文身份信息。
 *
 * 只读 `account` 字段 —— 它是明文的（只有 `accessToken` / `refreshToken` 加密），
 * 所以轮询期间完全不需要启动 Electron 去解密，开销可以忽略。
 *
 * @param file - 登录文件路径。
 * @returns `{uid, uin, domain, mtimeMs}` 或 undefined。
 */
export function peekAuthIdentity(file) {
  try {
    const stat = statSync(file)
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    const uid = doc?.account?.uid
    if (typeof uid !== 'string' || uid === '') return undefined
    return {
      uid,
      uin: typeof doc?.account?.uin === 'string' ? doc.account.uin : '',
      domain: typeof doc?.auth?.domain === 'string' ? doc.auth.domain : '',
      mtimeMs: stat.mtimeMs,
    }
  } catch {
    return undefined
  }
}

/**
 * 找出该变体的登录文件路径（优先显式设置，否则默认候选里存在的那个）。
 * @param variantId - 变体。
 * @param explicit - 设置里手填的路径。
 * @returns 路径，或 undefined。
 */
export function findAuthFile(variantId, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '' && existsSync(explicit.trim())) return explicit.trim()
  return authFileCandidates(VARIANTS[variantId]).find((candidate) => existsSync(candidate))
}

/**
 * 把登录文件快照到插件数据目录。
 *
 * 命名带 uid，重复登录同一账号会覆盖同一份 —— 这正好等价于「刷新该账号的令牌」。
 *
 * @param dataDir - 插件数据目录。
 * @param variantId - 变体。
 * @param uid - 账号 uid。
 * @param source - 源文件。
 * @returns 快照路径。
 */
export function snapshotAuthFile(dataDir, variantId, uid, source) {
  const dir = join(dataDir, 'accounts')
  mkdirSync(dir, { recursive: true })
  const safe = uid.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)
  const target = join(dir, `${variantId}-${safe}.info`)
  copyFileSync(source, target)
  return target
}

/**
 * 启动一次「登录并导入」。
 *
 * @param options - 见下方字段。
 * @returns 控制器：`{state, cancel}`。
 */
export function startLoginWatch(options) {
  const {
    variantId,
    dataDir,
    explicitAuthFile,
    electronPath,
    spawn,
    now = Date.now,
    pollMs = POLL_MS,
    timeoutMs = TIMEOUT_MS,
    onDone,
  } = options

  const state = {
    phase: 'starting',
    message: '正在打开 WorkBuddy…',
    startedAt: now(),
    uid: '',
    baselineUid: '',
    file: '',
    account: undefined,
  }
  let timer
  let cancelled = false

  const finish = (phase, message, extra = {}) => {
    state.phase = phase
    state.message = message
    Object.assign(state, extra)
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (phase === 'done' && typeof onDone === 'function') {
      try {
        onDone(state)
      } catch {
        /* 上层回调出错不该影响流程状态 */
      }
    }
  }

  const tick = async () => {
    if (cancelled) return
    if (now() - state.startedAt > timeoutMs) {
      finish('failed', '等待登录超时（5 分钟），可以再点一次')
      return
    }
    if (state.file === '') {
      const file = findAuthFile(variantId, explicitAuthFile)
      if (file === undefined) {
        finish('failed', '找不到 WorkBuddy 的登录文件；请先打开一次 WorkBuddy 并登录')
        return
      }
      state.file = file
      const identity = peekAuthIdentity(file)
      state.baselineUid = identity?.uid ?? ''
      state.uid = state.baselineUid
      state.phase = 'waiting'
      state.message = '请在弹出的 WorkBuddy 窗口里登录要添加的账号（也可以切换账号）'
    } else {
      const identity = peekAuthIdentity(state.file)
      if (identity !== undefined && identity.uid !== state.baselineUid) {
        // 等文件写完：登录过程会连续写几次，等 mtime 稳定 1.5 秒再抓。
        if (now() - identity.mtimeMs < 1000) {
          timer = setTimeout(tick, pollMs)
          return
        }
        try {
          const snapshot = snapshotAuthFile(dataDir, variantId, identity.uid, state.file)
          finish('done', '登录成功，账号已添加', { uid: identity.uid, account: { snapshot, identity } })
        } catch (error) {
          finish('failed', `保存账号失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return
      }
    }
    timer = setTimeout(tick, pollMs)
  }

  // 先把 App 拉起来（GUI 模式，不是 ELECTRON_RUN_AS_NODE）。
  void (async () => {
    try {
      const exe = await resolveAppBinary(VARIANTS[variantId], electronPath)
      const child = spawn(exe, [], { detached: true, stdio: 'ignore' })
      child.unref?.()
      state.message = '已打开 WorkBuddy，请在其中登录要添加的账号'
    } catch (error) {
      finish('failed', `打不开 WorkBuddy：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    timer = setTimeout(tick, pollMs)
  })()

  return {
    state,
    cancel() {
      cancelled = true
      finish('cancelled', '已取消')
    },
  }
}
