// Qoder 传输层：这些场景以前都会把「上游暂时不可用」说成「PAT 失效」，
// 或者让整份目录因为一个重复 id 被宿主拒绝。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyUpstreamBody,
  describeQueue,
  fetchQueueStatus,
  parseCatalog,
  parseStream,
  resolveIdentity,
} from '../lib/qoder/transport.js'
import { accountLimitation } from '../lib/runtime.js'

/**
 * 用一次性的假 fetch 跑 fn，结束后恢复。
 * @param handler - `(url, init) => Response`。
 * @param fn - 测试体。
 */
async function withFetch(handler, fn) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('Qoder 令牌交换：只有 401/403 才提示重新生成 PAT', async () => {
  for (const [status, kind, mustMention] of [
    [401, 'auth', true],
    [403, 'auth', true],
    [429, 'soft-rate', false],
    [500, 'server', false],
    [503, 'server', false],
  ]) {
    await withFetch(async () => new Response('nope', { status, headers: { 'retry-after': '3' } }), async () => {
      await assert.rejects(
        resolveIdentity('pt-test', 'global', undefined, 'machine-1'),
        (error) => {
          assert.equal(error.kind, kind, `HTTP ${status} 应归类为 ${kind}`)
          const mentionsRegenerate = /重新生成 PAT|regenerate/i.test(error.message)
          assert.equal(mentionsRegenerate, mustMention, `HTTP ${status} 的文案是否提示重新生成 PAT`)
          return true
        },
      )
    })
  }
})

test('Qoder 目录：重复 model id 只保留第一份（宿主会拒绝整份重复目录）', () => {
  const models = parseCatalog({
    chat: [
      { key: 'same', enable: true, display_name: 'First', max_input_tokens: 1000, max_output_tokens: 100 },
      { key: 'same', enable: true, display_name: 'Second', max_input_tokens: 2000, max_output_tokens: 200 },
      { key: 'other', enable: true, display_name: 'Other', max_input_tokens: 3000, max_output_tokens: 300 },
    ],
  })
  assert.deepEqual(models.map((model) => model.id), ['same', 'other'])
  assert.equal(models[0].name, 'First')
})

/** 把一段 SSE 文本包成 `response.body` 那种流。 */
function bodyOf(text) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

test('Qoder 流内 code:400 保留状态：档位限制能被探测识别', async () => {
  // 上游在 200 的流里回 `{error:{code:400,message:'当前账号类型暂不支持该模型'}}`。
  // 旧实现把所有流内错误都按 HTTP 200 分类，最终 status=502；而探测侧的
  // accountLimitation() 要求 status===400 —— 这类模型永远标不出「账号不支持」。
  const limitation = '当前账号类型暂不支持该模型'
  const inner = JSON.stringify({ error: { code: 400, message: limitation } })
  const outer = JSON.stringify({ statusCodeValue: 200, body: inner })
  let thrown
  try {
    for await (const _ of parseStream(bodyOf(`data: ${outer}\n\n`), undefined)) { /* drain */ }
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== undefined, '流内错误必须抛出')
  assert.equal(thrown.status, 400, 'body 里明确的 400 不能被改写成 502')
  assert.equal(accountLimitation(String(thrown.message), thrown.status), true, '探测必须能识别档位限制')

  // 普通流内错误（没有 400 证据）仍按 502：不能让「说不清」变成「账号不支持」。
  const generic = JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ error: { message: 'boom' } }) })
  let other
  try {
    for await (const _ of parseStream(bodyOf(`data: ${generic}\n\n`), undefined)) { /* drain */ }
  } catch (error) {
    other = error
  }
  assert.equal(other.status, 502)
  assert.equal(accountLimitation(String(other.message), other.status), false)
})

test('Qoder 外层 body 是对象时，正文不能整段丢失', async () => {
  // 同一个 body 字段在错误/排队响应里已经是对象形态；上游若把正常帧也改成
  // 对象，旧实现直接拿 outer 当内层，`choices` 读不到，只剩心跳与空 stop，
  // 运行时最终报 EMPTY_RESPONSE —— 用户看到一条完全空白的回答。
  const outer = JSON.stringify({
    statusCodeValue: 200,
    body: { choices: [{ delta: { content: 'hello' } }] },
  })
  const events = []
  for await (const event of parseStream(bodyOf(`data: ${outer}\n\ndata: [DONE]\n\n`), undefined)) events.push(event)
  const text = events.filter((event) => event.type === 'text').map((event) => event.text).join('')
  assert.equal(text, 'hello', '对象 body 里的正文必须照常产出')
  const finish = events.find((event) => event.type === 'finish')
  assert.equal(finish.kind, 'stop')
})

test('Qoder 内容安全拦截：终态带 CONTENT_FILTER failure，而不是一个没有 code 的 error', async () => {
  // 用户可见行为：模型因内容安全被拦截时，界面/统计要能显示「内容过滤」，
  // 而不是一句没有 code、没有 message 的通用错误。
  const inner = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })
  const outer = JSON.stringify({ statusCodeValue: 200, body: inner })
  const events = []
  for await (const event of parseStream(bodyOf(`data: ${outer}\n\ndata: [DONE]\n\n`), undefined)) events.push(event)
  const finish = events.find((event) => event.type === 'finish')
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure?.code, 'CONTENT_FILTER', 'content_filter 终态必须带可路由的 failure code')
  assert.match(finish.failure?.message ?? '', /内容安全|content_filter/)
})

/**
 * 上游真实的排队/无容量响应体：三层嵌套 JSON，`isQueued` 在第三层。
 * @param extra - 覆盖最内层的字段。
 * @returns 序列化后的 body 文本。
 */
function nestedQueueBody(extra = {}) {
  const innermost = JSON.stringify({
    isQueued: true,
    modelKey: 'dfmodel',
    queueCount: 0,
    queueType: 'p3',
    retryAfterSeconds: 30,
    serviceAvailable: false,
    subCode: 'RESOURCE_LIMIT',
    waitTime: 30,
    ...extra,
  })
  return JSON.stringify({
    code: '403',
    message: JSON.stringify({ code: '10605', message: innermost, subCode: 'RESOURCE_LIMIT' }),
  })
}

test('Qoder 无容量（RESOURCE_LIMIT）不能写成「正在排队」：要解析出队列字段并说明真实原因', () => {
  const failure = classifyUpstreamBody(nestedQueueBody(), 403)
  assert.equal(failure.kind, 'soft-rate')
  assert.equal(failure.status, 429)
  assert.equal(failure.retryAfterMs, 30_000)
  assert.deepEqual(failure.queue, { type: 'p3', count: 0, available: false, subCode: 'RESOURCE_LIMIT' })
  assert.match(failure.message, /没有可用容量/)
  assert.match(failure.message, /RESOURCE_LIMIT/)
  assert.match(failure.message, /排队人数 0/)
  assert.doesNotMatch(failure.message, /正在排队/, '空队列不能写成「正在排队」')

  // 真的有人在前面排队时才可以说「排队」，并给出人数。
  const real = classifyUpstreamBody(nestedQueueBody({ queueCount: 5, serviceAvailable: true }), 403)
  assert.deepEqual(real.queue, { type: 'p3', count: 5, available: true, subCode: 'RESOURCE_LIMIT' })
  assert.match(real.message, /正在排队/)
  assert.match(real.message, /前面还有 5 个请求/)

  // 只带 isQueued、没有队列字段时保持旧文案（不能凭空断言「没有容量」）。
  const bare = classifyUpstreamBody('{"isQueued":true,"retryAfterSeconds":12}', 429)
  assert.equal(bare.queue, undefined)
  assert.match(bare.message, /正在排队/)
  assert.equal(bare.retryAfterMs, 12_000)
})

test('describeQueue：capacity / queue / unknown 三种判定', () => {
  assert.equal(describeQueue({ queueCount: 0, serviceAvailable: false }).verdict, 'capacity')
  assert.equal(describeQueue({ queueCount: 0 }).verdict, 'unknown')
  assert.equal(describeQueue({ serviceAvailable: false }).verdict, 'capacity')
  assert.equal(describeQueue({ queueCount: 3, serviceAvailable: false }).verdict, 'queue')
  assert.equal(describeQueue({ queueCount: 3 }).verdict, 'queue')
  assert.equal(describeQueue({}).verdict, 'unknown')
  // waitTime 在没有 retryAfterSeconds 时也要变成「N 秒后重试」。
  assert.match(describeQueue({ queueCount: 0, serviceAvailable: false, waitTimeSeconds: 18 }).message, /18 秒后重试/)
})

test('fetchQueueStatus：用 requestSetId + modelKey + queueType 查等位状态', async () => {
  const seen = []
  await withFetch(async (url) => {
    seen.push(String(url))
    return new Response(JSON.stringify({
      subCode: 'RESOURCE_LIMIT',
      isQueued: true,
      modelKey: 'dfmodel',
      queueType: 'p3',
      queueCount: 0,
      waitTime: 29,
      retryAfterSeconds: 29,
      serviceAvailable: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async () => {
    const status = await fetchQueueStatus(
      { region: 'global', userID: 'u1', authToken: 'job', machineID: 'm', name: '', email: '' },
      { requestSetId: 'rs-1', modelKey: 'dfmodel', queueType: 'p3' },
      undefined,
    )
    assert.deepEqual(status, {
      queued: true,
      available: false,
      count: 0,
      waitMs: 29_000,
      retryAfterMs: 29_000,
      queueType: 'p3',
      subCode: 'RESOURCE_LIMIT',
    })
  })
  assert.equal(seen.length, 1)
  assert.match(seen[0], /\/algo\/api\/v2\/service\/ask\/queue\/status\?/)
  assert.match(seen[0], /requestSetId=rs-1/)
  assert.match(seen[0], /modelKey=dfmodel/)
  assert.match(seen[0], /queueType=p3/)

  // 状态查询永远是「尽力而为」：非 200 / 坏 JSON / 缺 requestSetId 都返回 undefined，
  // 不能把一次聊天请求弄失败。
  await withFetch(async () => new Response('nope', { status: 500 }), async () => {
    assert.equal(await fetchQueueStatus({ region: 'global', userID: 'u', authToken: 't', machineID: 'm' }, { requestSetId: 'rs' }, undefined), undefined)
  })
  await withFetch(async () => new Response('<html>', { status: 200 }), async () => {
    assert.equal(await fetchQueueStatus({ region: 'global', userID: 'u', authToken: 't', machineID: 'm' }, { requestSetId: 'rs' }, undefined), undefined)
  })
  assert.equal(await fetchQueueStatus({ region: 'global', userID: 'u', authToken: 't', machineID: 'm' }, {}, undefined), undefined)
})
