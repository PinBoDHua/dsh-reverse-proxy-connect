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
 * @param source - 上游解析器产出的异步可迭代事件流。
 * @param options - `{ idleMs, signal?, onIdle? }`。
 * @yields 原样转发事件。
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
 * 可取消的 sleep。
 * @param ms - 毫秒。
 * @param signal - 取消信号。
 * @returns 等待完成的 Promise。
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new CancelledError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new CancelledError())
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
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
