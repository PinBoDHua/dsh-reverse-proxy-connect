import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collectImageRefs, imageHandleText, imageRequestTargetOf } from '../lib/images.js'
import { Runtime, failureCodeOf, isFailoverCode, toOpenAiMessages } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'
import { IdleTimeoutError, withIdleTimeout } from '../lib/timeout.js'

const REF = {
  attachmentId: 'sha256:abcdef123456',
  name: 'shot.png',
  width: 800,
  height: 400,
  mediaType: 'image/png',
}

const IMAGE = {
  ...REF,
  dataUrl: 'data:image/png;base64,AAAA',
  width: 400,
  height: 200,
}

test('图片预算：保持宽高比并压到像素/单边上限内', () => {
  const large = imageRequestTargetOf({ width: 8000, height: 4000 })
  assert.ok(large.width * large.height <= 4_194_304)
  assert.ok(Math.max(large.width, large.height) <= 4096)
  assert.ok(Math.abs(large.width / large.height - 2) < 0.01)
  assert.equal(large.maxBytes, 4_000_000)

  const small = imageRequestTargetOf({ width: 100, height: 50 })
  assert.deepEqual(small, { width: 100, height: 50, maxBytes: 4_000_000 }, '小图不放大')
  assert.equal(imageRequestTargetOf({ width: 0, height: 0 }).width, 1)
})

test('收集图片引用：去重、跳过 offload、忽略坏块', () => {
  const refs = collectImageRefs([
    { role: 'user', content: [{ type: 'image', attachment: REF }, { type: 'image', attachment: REF }] },
    { role: 'user', content: [{ type: 'image', attachment: { ...REF, attachmentId: 'other' }, offloaded: true }] },
    { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'x' }] },
  ])
  assert.equal(refs.length, 1)
  assert.equal(refs[0].attachmentId, REF.attachmentId)
})

test('图片说明文本包含附件 id、请求尺寸与只读路径', () => {
  const text = imageHandleText({ ...IMAGE, readonlyPath: 'C:\\tmp\\shot.png' })
  assert.ok(text.includes('"shot.png"'))
  assert.ok(text.includes('sha256:abcdef123456'))
  assert.ok(text.includes('400x200'))
  assert.ok(text.includes('C:\\\\tmp\\\\shot.png'))
  assert.ok(text.includes('.png'))
})

test('DSH 用户消息里的图片 → 说明文本 + image_url', () => {
  const messages = toOpenAiMessages([
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: REF }] },
  ], new Map([[REF.attachmentId, IMAGE]]))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.ok(Array.isArray(messages[0].content))
  assert.equal(messages[0].content[0].type, 'text')
  assert.equal(messages[0].content[0].text, '看图')
  assert.equal(messages[0].content[1].type, 'text')
  assert.ok(messages[0].content[1].text.includes('sha256:abcdef123456'))
  assert.equal(messages[0].content[2].type, 'image_url')
  assert.equal(messages[0].content[2].image_url.url, 'data:image/png;base64,AAAA')
})

test('tool 结果里的图片提升成紧随其后的 user 消息', () => {
  const messages = toOpenAiMessages([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'shot', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }, { type: 'image', attachment: REF }] },
  ], new Map([[REF.attachmentId, IMAGE]]))
  assert.equal(messages.length, 3)
  assert.equal(messages[1].role, 'tool')
  assert.equal(messages[1].content, 'done')
  assert.equal(messages[2].role, 'user')
  assert.equal(messages[2].content.at(-1).type, 'image_url')
})

test('没有附件服务时图片变成明确占位符，不静默丢失', () => {
  const messages = toOpenAiMessages([
    { role: 'user', content: [{ type: 'image', attachment: REF }] },
  ])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, '[an image was attached but could not be read]')
})

test('宿主 offload 的图片给出「因限额省略」而不是「读不到」', () => {
  const messages = toOpenAiMessages([
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', attachment: REF, offloaded: true }] },
  ], new Map())
  assert.equal(messages.length, 1)
  assert.ok(String(messages[0].content).includes('omitted to fit request image limits'))
  assert.ok(!String(messages[0].content).includes('could not be read'))
})

test('失败分类：HTTP 状态、凭证码、超时与取消', () => {
  assert.equal(failureCodeOf(Object.assign(new Error('x'), { status: 401 })), 'AUTH')
  assert.equal(failureCodeOf(Object.assign(new Error('x'), { status: 403 })), 'AUTH')
  assert.equal(failureCodeOf(Object.assign(new Error('x'), { status: 402 })), 'QUOTA')
  assert.equal(failureCodeOf(Object.assign(new Error('x'), { status: 429 })), 'RATE_LIMIT')
  assert.equal(failureCodeOf(Object.assign(new Error('x'), { status: 503 })), 'SERVER')
  assert.equal(failureCodeOf(Object.assign(new Error('x'), { code: 'pat-invalid' })), 'AUTH')
  assert.equal(failureCodeOf(Object.assign(new Error('x'), { code: 'timeout' })), 'TIMEOUT')
  assert.equal(failureCodeOf(Object.assign(new Error('x'), { name: 'AbortError' })), 'ABORTED')
  assert.equal(failureCodeOf(new IdleTimeoutError(1000)), 'TIMEOUT')
  assert.equal(failureCodeOf(new Error('weird')), 'upstream-error')

  assert.equal(isFailoverCode('AUTH'), true)
  assert.equal(isFailoverCode('QUOTA'), true)
  assert.equal(isFailoverCode('RATE_LIMIT'), true)
  assert.equal(isFailoverCode('SERVER'), false)
})

/** 造一条按给定间隔产出事件的流。 */
async function* paced(delays) {
  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay))
    yield { type: 'text', text: 'x' }
  }
}

test('空闲超时：长时间没有事件才失败，持续输出不受影响', async () => {
  const started = Date.now()
  await assert.rejects(
    (async () => {
      for await (const _event of withIdleTimeout(paced([100]), { idleMs: 20 })) {
        /* 等不到事件 */
      }
    })(),
    (error) => error instanceof IdleTimeoutError && error.code === 'timeout',
  )
  assert.ok(Date.now() - started < 500)

  const events = []
  for await (const event of withIdleTimeout(paced([5, 5, 5, 5]), { idleMs: 50 })) events.push(event)
  assert.equal(events.length, 4)
})

test('空闲超时：取消信号优先给出 CancelledError', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    (async () => {
      for await (const _event of withIdleTimeout(paced([1]), { idleMs: 1000, signal: controller.signal })) {
        /* 不会执行 */
      }
    })(),
    (error) => error?.code === 'ABORTED',
  )
})

test('Runtime 读图：用真实请求版本尺寸、映射只读路径、产出 data URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-image-'))
  try {
    const settings = defaults()
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    let seenTarget
    runtime.setAttachments({
      async readImageRequest(_ref, target) {
        seenTarget = target
        return { data: Buffer.from('png-bytes'), mediaType: 'image/png', width: 64, height: 32, bytes: 9 }
      },
      imageHostPath() {
        return 'C:\\tmp\\normalized.png'
      },
    }, (hostPath) => `mapped:${hostPath}`)

    assert.equal(runtime.canAcceptImages(), true)
    const image = await runtime.readImage({ attachmentId: 'sha256:abc', name: 'shot.png', width: 100, height: 50 })
    assert.equal(seenTarget.width, 100)
    assert.equal(seenTarget.height, 50)
    assert.equal(seenTarget.maxBytes, 4_000_000)
    assert.equal(image.width, 64, '使用编码器实际给出的请求版本尺寸')
    assert.equal(image.height, 32)
    assert.ok(image.dataUrl.startsWith('data:image/png;base64,'))
    assert.equal(image.readonlyPath, 'mapped:C:\\tmp\\normalized.png')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Runtime 没有附件服务时读图给出明确错误', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-image-'))
  try {
    const runtime = new Runtime({ settings: () => defaults(), dataDir: dir, logger: {} })
    assert.equal(runtime.canAcceptImages(), false)
    await assert.rejects(runtime.readImage({ attachmentId: 'x', width: 1, height: 1 }), /没有挂载附件服务/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
