// Qoder 传输层：这些场景以前都会把「上游暂时不可用」说成「PAT 失效」，
// 或者让整份目录因为一个重复 id 被宿主拒绝。

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseCatalog, parseStream, resolveIdentity } from '../lib/qoder/transport.js'

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
