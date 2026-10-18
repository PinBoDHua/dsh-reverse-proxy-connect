/**
 * 流看门狗：空闲超时 vs「只保活不出内容」上限。
 *
 * 用户可见行为：
 * - 上游连上后彻底没动静 → 原来的空闲超时（不误报成「没有正文」）；
 * - 上游一直发保活帧、却没有任何正文/思考/工具内容 → 到 maxSilentMs 必须放弃，
 *   不能靠心跳无限续命（否则请求永远挂起）；
 * - 正常长回答一直在出内容 → 内容事件重置上限，总时长超过 maxSilentMs 也不杀。
 *
 * 全部用小毫秒值，整组用例 < 1s。
 *
 * @module dsh-reverse-proxy-connect/tests/timeout
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MAX_SILENT_MS,
  DeadlineError,
  IdleTimeoutError,
  maxSilentMsOf,
  withIdleTimeout,
} from '../lib/timeout.js'

/**
 * 可被 abort 打断的 sleep：runtime 里 onIdle 会 abort 上游 fetch，
 * 这里用同样的方式让生成器在 abort 时结束。
 *
 * @param ms - 毫秒。
 * @param controller - 看门狗会 abort 的控制器。
 * @returns Promise。
 */
function abortableSleep(ms, controller) {
  return new Promise((resolve, reject) => {
    const abortError = () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      return error
    }
    if (controller?.signal.aborted === true) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }
    const cleanup = () => {
      clearTimeout(timer)
      controller?.signal.removeEventListener?.('abort', onAbort)
    }
    controller?.signal.addEventListener?.('abort', onAbort, { once: true })
  })
}

test('流超时：只发心跳没有正文时，到 maxSilentMs 必须放弃（心跳不能无限续命）', async () => {
  const controller = new AbortController()
  let heartbeats = 0
  async function* keepAliveOnly() {
    for (;;) {
      await abortableSleep(10, controller)
      heartbeats += 1
      yield { type: 'heartbeat' }
    }
  }

  const started = Date.now()
  await assert.rejects(async () => {
    for await (const _event of withIdleTimeout(keepAliveOnly(), {
      // idleMs 故意远大于心跳间隔：本用例只验证「静默上限」，避免并行跑测试时
      // CPU 抖动把空闲计时器也弄响、把断言带偏。
      idleMs: 1_000,
      maxSilentMs: 200,
      onIdle: () => controller.abort(),
    })) {
      /* 心跳按设计不会转给调用方 */
    }
  }, (error) => {
    assert.ok(error instanceof DeadlineError, `应抛 DeadlineError，实际 ${error?.name}`)
    assert.equal(error.code, 'timeout', '上层按超时处理，code 必须还是 timeout')
    assert.match(error.message, /正文/, '文案要说明是「没有正文」，而不是完全没数据')
    return true
  })

  const elapsed = Date.now() - started
  assert.ok(heartbeats > 0, '必须真的收到过心跳（证明是「只保活」而不是完全安静）')
  assert.ok(elapsed >= 120, `应在 maxSilentMs 附近放弃（实际 ${elapsed}ms）`)
  assert.ok(elapsed < 2_000, `测试用小值，不应拖太久（实际 ${elapsed}ms）`)
})

test('流超时：内容事件会重置连续无内容上限，总时长超过 maxSilentMs 也不能杀', async () => {
  const controller = new AbortController()
  async function* contentEvery(intervalMs, count) {
    for (let index = 0; index < count; index++) {
      await abortableSleep(intervalMs, controller)
      yield { type: 'text', text: String(index) }
    }
  }

  const events = []
  const started = Date.now()
  for await (const event of withIdleTimeout(contentEvery(40, 6), {
    // 空闲计时器设大，确保本用例只会被「连续无内容」上限影响。
    idleMs: 500,
    maxSilentMs: 120,
    onIdle: () => controller.abort(),
  })) {
    events.push(event)
  }

  const elapsed = Date.now() - started
  assert.equal(events.length, 6, '正常内容必须全部转发')
  assert.ok(elapsed > 120, `总时长应超过 maxSilentMs=120（实际 ${elapsed}ms）`)
})

test('流超时：完全没有任何事件（连心跳都没有）仍抛原来的 IdleTimeoutError', async () => {
  const controller = new AbortController()
  async function* silent() {
    await abortableSleep(5_000, controller)
    yield { type: 'text', text: 'late' }
  }

  const started = Date.now()
  await assert.rejects(async () => {
    for await (const _event of withIdleTimeout(silent(), {
      idleMs: 40,
      maxSilentMs: 5_000,
      onIdle: () => controller.abort(),
    })) {
      /* 不该有事件 */
    }
  }, (error) => {
    assert.ok(error instanceof IdleTimeoutError)
    assert.equal(error.name, 'IdleTimeoutError', '完全没数据仍是空闲超时，不能报成「没有正文」')
    assert.match(error.message, /没有返回任何数据/)
    return true
  })
  assert.ok(Date.now() - started < 2_000)
})

test('maxSilentMsOf：默认 10 分钟，空闲超时调大时按 3 倍放宽，非法输入回落默认', () => {
  assert.equal(DEFAULT_MAX_SILENT_MS, 10 * 60_000)
  // 默认 idle=3min → max(10min, 9min) = 10min
  assert.equal(maxSilentMsOf(180_000), DEFAULT_MAX_SILENT_MS)
  // 用户把空闲超时调到 15min → 无内容上限放宽到 45min（不能被固定 10min 抵消）
  assert.equal(maxSilentMsOf(900_000), 2_700_000)
  // 省略 / 非法输入一律回落默认值，绝不算出 0 或 NaN（否则会立刻误杀所有请求）。
  assert.equal(maxSilentMsOf(), DEFAULT_MAX_SILENT_MS)
  assert.equal(maxSilentMsOf(0), DEFAULT_MAX_SILENT_MS)
  assert.equal(maxSilentMsOf(-1), DEFAULT_MAX_SILENT_MS)
  assert.equal(maxSilentMsOf(Number.NaN), DEFAULT_MAX_SILENT_MS)
  assert.equal(maxSilentMsOf('600000'), DEFAULT_MAX_SILENT_MS)
})
