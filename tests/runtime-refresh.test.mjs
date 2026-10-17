import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Runtime } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'

/** 一个只有一个可用账号、其余 provider 关闭的设置。 */
function settingsForRefresh() {
  const settings = defaults()
  for (const provider of ['workbuddy-ai', 'qoder', 'qoder-global']) {
    settings.providers[provider].enabled = false
  }
  settings.accounts.workbuddy = [{
    id: 'a',
    label: 'A',
    enabled: true,
    token: {
      accessToken: 'token-a',
      refreshToken: '',
      expiresAtMs: Date.now() + 3600_000,
      refreshExpiresAtMs: 0,
      domain: 'codebuddy.cn',
      uid: 'uid-a',
      enterpriseId: '',
    },
  }]
  settings.activeAccount.workbuddy = 'a'
  return settings
}

/** WorkBuddy 目录接口的最小合法响应。 */
function catalogResponse() {
  return new Response(JSON.stringify({
    code: 0,
    data: {
      agents: [{ name: 'cli', models: ['m'] }],
      models: [{ id: 'm', name: 'M', maxInputTokens: 1000, maxOutputTokens: 100 }],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('目录刷新：同一 provider 的并发非 force 只打一次上游', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-refresh-'))
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 40))
    return catalogResponse()
  }
  try {
    const runtime = new Runtime({ settings: settingsForRefresh, dataDir: dir, logger: {} })
    const results = await Promise.all([runtime.refresh('workbuddy'), runtime.refresh('workbuddy')])
    assert.equal(calls, 1, '并发刷新应该共用同一轮上游请求')
    assert.equal(results[0].models, 1)
    assert.equal(results[1].models, 1)
    runtime.flushCaches()
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录刷新：force 请求不会被正在跑的后台刷新吞掉，结束后会补跑一轮', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-refresh-'))
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 50))
    return catalogResponse()
  }
  try {
    const runtime = new Runtime({ settings: settingsForRefresh, dataDir: dir, logger: {} })
    const background = runtime.refresh('workbuddy')
    const forced = runtime.refresh('workbuddy', { force: true })
    await Promise.all([background, forced])
    assert.equal(calls, 2, '后台轮次 + force 轮次各一次')
    runtime.flushCaches()
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})
