/**
 * 超时与等待。
 *
 * 上游两类超时必须分开：
 *
 * - **打开超时**：连上、拿到响应头之前。60 秒足够任何一个正常网关。
 * - **空闲超时**：流已经建立，但一段时间没有任何事件。长思考会安静几十秒，
 *   所以默认给 3 分钟；只要还在出字就永远不该触发。
 *
 * 旧实现用 `AbortSignal.timeout(300_000)` 当整条流的总超时，会把持续 5 分钟
 * 以上的正常长回答直接切断 —— 这个模块就是为修那件事而存在的。
 *
 * @module dsh-reverse-proxy-connect/timeout
 */

import { REASON } from './protocol.js'

/** 流空闲超时。 */
export class IdleTimeoutError extends Error {
  /**
   * @param idleMs - 空闲阈值。
   */
  constructor(idleMs) {
    super(`上游已经 ${String(Math.round(idleMs / 1000))} 秒没有返回任何数据，连接被判定为空闲超时。`)
    this.name = 'IdleTimeoutError'
    this.code = REASON.timeout
    this.kind = 'timeout'
  }
}

/** 主动取消。 */
export class CancelledError extends Error {
  /**
   * @param message - 说明。
   */
  constructor(message = 'aborted') {
    super(message)
    this.name = 'AbortError'
    this.code = 'ABORTED'
    this.kind = 'timeout'
  }
}

/**
 * 给一条异步事件流加空闲看门狗。
 *
 * 计时器只在**等待下一个事件**时计时；一旦事件到达就重新计时。所以：
 * 持续输出的流不会被误杀，真正卡死的流会在 `idleMs` 后被 abort。
 *
 * 解析器在「上游还有字节、但这一帧没有内容」时会 yield `{type:'heartbeat'}`
 * （SSE 注释行、只带 usage 的帧、空 delta……）。心跳**同样重置计时器**：
 * 长思考时上游会周期性发保活，这类字节说明连接是活的，把它当成「没有事件」
 * 会在思考第 3 分钟把一条完全正常的请求切断。心跳不会转给调用方。
 *
 * @param source - 上游解析器产出的异步可迭代事件流。
 * @param options - `{ idleMs, signal?, onIdle? }`。
 * @yields 原样转发事件（`heartbeat` 除外）。
 * @throws {IdleTimeoutError} 空闲超时。
 * @throws {Error} 上游或消费者抛出的错误。
 */
export async function* withIdleTimeout(source, options) {
  const idleMs = typeof options?.idleMs === 'number' && options.idleMs > 0 ? options.idleMs : 0
  const signal = options?.signal
  const iterator = source[Symbol.asyncIterator]()
  let timer
  let fired = false

  const disarm = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  const arm = () => {
    if (idleMs <= 0) return
    timer = setTimeout(() => {
      fired = true
      try {
        options?.onIdle?.()
      } catch {
        /* 看门狗自己的回调失败不该掩盖超时 */
      }
    }, idleMs)
    timer.unref?.()
  }

  try {
    while (true) {
      if (signal?.aborted === true) throw new CancelledError()
      arm()
      let next
      try {
        next = await iterator.next()
      } catch (error) {
        if (fired === true) throw new IdleTimeoutError(idleMs)
        throw error
      } finally {
        disarm()
      }
      if (fired === true) throw new IdleTimeoutError(idleMs)
      if (next.done === true) return
      // 上游还活着（保活/无内容帧）：不转给调用方，但确实重置过计时器。
      if (next.value !== null && typeof next.value === 'object' && next.value.type === 'heartbeat') continue
      yield next.value
    }
  } finally {
    disarm()
    try {
      await iterator.return?.()
    } catch {
      /* 关闭失败不影响已经产出的内容 */
    }
  }
}

/**
 * 中止信号 → 该抛出去的错误。
 *
 * `AbortController.abort(reason)` 的 reason 只有调用方自己在意：宿主取消不带
 * reason，而「测试账号 / 能力探测」这类内部看门狗会塞一个 `DeadlineError`。
 * 一律包成 `CancelledError` 会把这些区别抹掉 —— 卡片上就只剩一句「aborted」，
 * 既不像超时也不说明做了什么。
 *
 * @param signal - 已中止的信号。
 * @returns 要抛出的错误。
 */
export function abortReasonOf(signal) {
  const reason = signal?.reason
  // 我们自己塞进去的（带 kind/code 的对象）原样上抛：上层靠它们判超时。
  if (reason !== undefined && reason !== null && typeof reason === 'object'
    && (typeof reason.kind === 'string' || typeof reason.code === 'string')) return reason
  return new CancelledError()
}

/**
 * 可取消的 sleep。
 * @param ms - 毫秒。
 * @param signal - 取消信号。
 * @returns 等待完成的 Promise。
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReasonOf(signal))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(abortReasonOf(signal))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * 「这里是死线，不是用户取消」。
 *
 * `AbortController.abort()` 不带参数时，`signal.reason` 是一个 `AbortError`，
 * 与用户按 Esc / 关页面产生的取消**完全无法区分**。于是「测试账号等了 60 秒
 * 没等到响应头」会被上报成 `ABORTED`，卡片上写「aborted」，既不像超时也不
 * 说明做了什么。
 *
 * 需要区分的调用方用 `controller.abort(new DeadlineError(...))`，运行时会在
 * 「调用方 signal 已中止」那条分支里先认这个 reason，把它当超时处理。
 *
 * 继承 `IdleTimeoutError`：两者对上层（`failureCodeOf`、重试判据）语义一致，
 * 都是「这次没等到，可以重试」，只是文案与 cause 不同。
 */
export class DeadlineError extends IdleTimeoutError {
  /**
   * @param ms - 死线时长。
   * @param what - 等的是什么（「响应头」「整条流」）。
   */
  constructor(ms, what = '响应') {
    super(ms)
    this.message = `上游在 ${String(Math.round(ms / 1000))} 秒内没有给出${what}，已放弃本次请求。`
    this.name = 'DeadlineError'
  }
}

/**
 * 打开阶段的死线：在 `ms` 内必须拿到响应，否则 abort。
 *
 * 返回一个 `dispose()`，拿到响应后立刻调用它，避免这个计时器继续套在
 * 之后的数据流上（那正是旧实现的 bug）。
 *
 * @param ms - 毫秒。
 * @returns `{ signal, dispose }`。
 */
export function openDeadline(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new IdleTimeoutError(ms)), ms)
  timer.unref?.()
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
    },
    abort(reason) {
      controller.abort(reason)
    },
  }
}

/**
 * 「外部取消 + 本次请求超时」两个信号的合并。
 *
 * 旧写法是 `signal ?? AbortSignal.timeout(ms)` —— 看起来在给默认值，其实
 * **只要调用方传了 signal，单请求超时就永远不会生效**。runtime / index 几乎
 * 每条路径都会传入一个（签到、额度、目录、换 token……），于是上游挂死时
 * 那次请求可以一直挂着：签到会把 `checkinRunning` 占住，让 30 秒调度器
 * 一直空转；额度刷新会让卡片永远停在「读取中」。
 *
 * 现在两者取并集：外部取消仍然立即生效，同时兜住单请求超时。
 *
 * @param signal - 外部取消信号（可省略）。
 * @param ms - 本次请求的超时。
 * @returns 合并后的 AbortSignal。
 */
export function withTimeout(signal, ms) {
  const timeoutMs = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 1
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined || signal === null) return timeout
  // AbortSignal.any 在老环境里可能没有：退化成「只用外部信号」比直接抛错好。
  if (typeof AbortSignal.any !== 'function') return signal
  return AbortSignal.any([signal, timeout])
}
