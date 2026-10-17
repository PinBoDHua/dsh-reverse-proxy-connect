import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loginTarget,
  normalizeToken,
  openInBrowser,
  pollAuthToken,
  startBrowserLogin,
} from '../lib/workbuddy/browser-login.js'

test('登录目标：国内版 platform=ide，国际版 workbuddy-ai', () => {
  assert.equal(loginTarget('workbuddy').endpoint, 'https://www.codebuddy.cn')
  assert.equal(loginTarget('workbuddy').platform, 'ide')
  assert.equal(loginTarget('workbuddy-ai').endpoint, 'https://www.workbuddy.ai')
  assert.equal(loginTarget('workbuddy-ai').platform, 'workbuddy-ai')
})

test('token 归一化：优先绝对时间，其次相对秒数', () => {
  const absolute = normalizeToken({ accessToken: 'a', expiresAt: 1_800_000_000_000 })
  assert.equal(absolute.expiresAtMs, 1_800_000_000_000)

  const seconds = normalizeToken({ accessToken: 'a', expiresAt: 1_800_000_000 })
  assert.equal(seconds.expiresAtMs, 1_800_000_000_000)

  const relative = normalizeToken({ accessToken: 'a', expiresIn: 3600 })
  assert.ok(relative.expiresAtMs > Date.now() + 3_500_000)

  // 都没有时从 JWT 的 exp 兜底
  const payload = Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString('base64url')
  const jwt = normalizeToken({ accessToken: `h.${payload}.s` })
  assert.equal(jwt.expiresAtMs, 1_900_000_000_000)
})

test('token 归一化：refreshToken 缺失时给空串而不是 undefined', () => {
  const value = normalizeToken({ accessToken: 'a' })
  assert.equal(value.refreshToken, '')
  assert.equal(value.domain, '')
})

test('openInBrowser 把 URL 交给 start（带 & 也不会被 cmd 拆开）', () => {
  const calls = []
  const ok = openInBrowser('https://x/login?platform=ide&state=abc', (command, args, options) => {
    calls.push({ command, args, options })
    return { unref() {} }
  })
  assert.equal(ok, true)
  assert.equal(calls.length, 1)
  const [call] = calls
  if (process.platform === 'win32') {
    assert.equal(call.command, 'cmd')
    assert.deepEqual(call.args.slice(0, 3), ['/c', 'start', ''])
    assert.equal(call.args[3], 'https://x/login?platform=ide&state=abc')
  }
  assert.equal(call.options.detached, true)
})

test('轮询 token：11217 未就绪会继续等，成功后返回令牌', async () => {
  const responses = [
    { status: 403, body: { code: 11217, msg: 'not ready' } },
    { status: 200, body: { code: 0, data: { accessToken: 'tok', refreshToken: 'r', domain: 'copilot.tencent.com' } } },
  ]
  let index = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    const item = responses[Math.min(index, responses.length - 1)]
    index += 1
    return {
      ok: item.status === 200,
      status: item.status,
      text: async () => JSON.stringify(item.body),
    }
  }
  try {
    const token = await pollAuthToken('workbuddy', 'state-1', { pollMs: 5, timeoutMs: 2000 })
    assert.equal(token.accessToken, 'tok')
    assert.equal(token.refreshToken, 'r')
    assert.equal(token.domain, 'copilot.tencent.com')
  } finally {
    globalThis.fetch = original
  }
})

test('完整流程：申请地址 → 打开浏览器 → 换 token → 读账号', async () => {
  const original = globalThis.fetch
  const opened = []
  let tokenCalls = 0
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/v2/plugin/auth/state')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { state: 'st-1', authUrl: 'https://x/login?state=st-1' } }),
      }
    }
    if (href.includes('/v2/plugin/auth/token')) {
      tokenCalls += 1
      if (tokenCalls < 2) {
        return { ok: false, status: 403, text: async () => JSON.stringify({ code: 11217 }) }
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { accessToken: 'token-1', refreshToken: 'r1', expiresIn: 7200 } }),
      }
    }
    if (href.includes('/v2/plugin/login/account')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { uid: 'uid-1', nickname: '小号', enterpriseId: '' } }),
      }
    }
    throw new Error(`unexpected url ${href}`)
  }

  try {
    const updates = []
    const session = startBrowserLogin({
      variantId: 'workbuddy',
      pollMs: 5,
      timeoutMs: 3000,
      spawn: (command, args, options) => {
        opened.push({ command, args, options })
        return { unref() {} }
      },
      onUpdate: (patch) => updates.push(patch),
    })
    const result = await session.result
    assert.equal(result.token.accessToken, 'token-1')
    assert.equal(result.account.uid, 'uid-1')
    assert.equal(result.label, '小号')
    assert.equal(opened.length, 1, '应该只打开一次浏览器')
    assert.ok(updates.some((item) => item.phase === 'done'))
    assert.ok(updates.some((item) => typeof item.authUrl === 'string'))
  } finally {
    globalThis.fetch = original
  }
})
