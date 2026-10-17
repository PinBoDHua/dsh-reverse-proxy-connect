import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Runtime } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'

/** 一条最小 SSE 响应。 */
function sseResponse(text) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`))
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** 构造两个浏览器登录账号。 */
function settingsWithAccounts() {
  const settings = defaults()
  settings.workbuddy.workbuddy.authFile = 'Z:\\definitely-missing\\workbuddy-desktop.info'
  const token = (uid, accessToken) => ({
    accessToken,
    refreshToken: '',
    expiresAtMs: Date.now() + 3600_000,
    refreshExpiresAtMs: 0,
    domain: 'codebuddy.cn',
    uid,
    enterpriseId: '',
  })
  settings.accounts.workbuddy = [
    { id: 'a', label: '账号 A', enabled: true, token: token('uid-a', 'token-a') },
    { id: 'b', label: '账号 B', enabled: true, token: token('uid-b', 'token-b') },
  ]
  settings.activeAccount.workbuddy = 'a'
  return settings
}

test('429 限流：还没吐内容时自动换到下一个账号，而不是直接失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-failover-'))
  const originalFetch = globalThis.fetch
  const calls = []
  const switches = []
  globalThis.fetch = async (url, init) => {
    const auth = init?.headers?.Authorization ?? ''
    calls.push(auth)
    if (String(auth).includes('token-a')) {
      return new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })
    }
    return sseResponse('from-b')
  }
  try {
    const settings = settingsWithAccounts()
    const runtime = new Runtime({
      settings: () => settings,
      dataDir: dir,
      logger: {},
      onAccountSwitch: (provider, accountId) => switches.push({ provider, accountId }),
    })
    try {
      const opened = await runtime.openStream('workbuddy', {
        model: 'hy3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: AbortSignal.timeout(5000),
      })
      const events = []
      for await (const event of opened.events) events.push(event)
      assert.equal(events.filter((event) => event.type === 'text').map((event) => event.text).join(''), 'from-b')
      assert.equal(events.find((event) => event.type === 'finish').kind, 'stop')
      assert.equal(calls.length, 2, '应该只重开一次')
      assert.ok(calls[0].includes('token-a'))
      assert.ok(calls[1].includes('token-b'))
      assert.deepEqual(switches, [{ provider: 'workbuddy', accountId: 'b' }])
      // 失败账号进入冷却，下一次请求不会再先撞它。
      assert.ok(runtime.cooldownUntil('workbuddy', 'a') > Date.now())
    } finally {
      runtime.flushCaches()
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('账号测试：读到运行时 finish.kind 才算成功，不能因为字段形状不同误报 INCOMPLETE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-test-account-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => sseResponse('ok')
  try {
    const settings = settingsWithAccounts()
    settings.accounts.workbuddy = [settings.accounts.workbuddy[0]]
    settings.activeAccount.workbuddy = 'a'
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    try {
      // 没有目录也能测：runtime 会退到 active catalog；这里手动塞一份最小目录。
      runtime.catalogs.set('workbuddy::a', { models: [{ id: 'auto', name: 'Auto', contextWindow: 128000, maxTokens: 32000, reasoningEfforts: [] }], fetchedAt: Date.now(), source: 'live' })
      const result = await runtime.testAccount('workbuddy', 'a')
      assert.equal(result.ok, true)
      assert.ok(result.latencyMs >= 0)
      assert.equal(runtime.lastTestFor('workbuddy', 'a').ok, true)
    } finally {
      runtime.flushCaches()
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('429 限流：只有一个账号时保留上游错误，不伪造成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-failover-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('rate limited', { status: 429 })
  try {
    const settings = settingsWithAccounts()
    settings.accounts.workbuddy = [settings.accounts.workbuddy[0]]
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    try {
      const opened = await runtime.openStream('workbuddy', {
        model: 'hy3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: AbortSignal.timeout(5000),
      })
      await assert.rejects(
        async () => {
          for await (const _event of opened.events) {
            /* 不应该有任何内容 */
          }
        },
        (error) => error.status === 429,
      )
    } finally {
      runtime.flushCaches()
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})
