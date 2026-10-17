import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Runtime } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'

/** 一条最小 SSE 响应。 */
function sseResponse() {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'))
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('浏览器登录令牌：目录/聊天走账号令牌，不再去找本机登录文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-browser-'))
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} })
    return sseResponse()
  }
  try {
    const settings = defaults()
    settings.workbuddy.workbuddy.authFile = 'Z:\\definitely-missing\\workbuddy-desktop.info'
    settings.accounts.workbuddy = [{
      id: 'browser-account',
      label: '浏览器账号',
      enabled: true,
      token: {
        accessToken: 'tok-browser-login',
        refreshToken: '',
        expiresAtMs: Date.now() + 3600_000,
        refreshExpiresAtMs: 0,
        domain: 'codebuddy.cn',
        uid: 'uid-1',
        enterpriseId: '',
      },
    }]
    settings.activeAccount.workbuddy = 'browser-account'

    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    let captured
    try {
      const opened = await runtime.openStream('workbuddy', {
        model: 'hy3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: AbortSignal.timeout(5000),
      })
      const events = []
      for await (const event of opened.events) events.push(event)
      captured = calls.find((call) => call.url.includes('/v2/chat/completions'))
      assert.equal(events.filter((event) => event.type === 'text').map((event) => event.text).join(''), '你好')
      const finish = events.find((event) => event.type === 'finish')
      assert.equal(finish.kind, 'stop')
      assert.equal(captured.headers.Authorization, 'Bearer tok-browser-login')
      assert.equal(captured.headers['X-User-Id'], 'uid-1')
    } finally {
      runtime.flushCaches()
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})
