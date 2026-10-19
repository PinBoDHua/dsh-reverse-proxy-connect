// 回归：删除账号后，**在途**的凭证续期与目录刷新都不能把账号「复活」。
//
// 两类请求都可能跑十几秒（续期最长 30 秒、目录 30 秒），用户在这段时间里删掉
// 账号是正常操作。旧实现在 await 返回后无条件写回：
// - 续期 → onCredentialRefreshed → applyCredentialRefresh 造出带 token 的账号行；
// - 目录 → catalogs.set(...) + 落盘，重启后仍能看到「已删除账号」的模型。
// 判据不能用「设置里还有没有这个 id」：隐式默认账号的 id 固定是 `default`，
// 删掉后 accountsFor() 又会合成一个同 id 的空账号，所以用 forgetAccount 的代数。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Runtime } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'

/** 只有 workbuddy 启用、默认账号带一个即将过期的令牌。 */
function settingsWithExpiringToken() {
  const settings = defaults()
  for (const provider of ['workbuddy-ai', 'qoder', 'qoder-global', 'trae', 'trae-global']) {
    settings.providers[provider].enabled = false
  }
  settings.qoder.qoder.pat = ''
  settings.accounts.workbuddy = [{
    id: 'default',
    label: '本机登录',
    enabled: true,
    token: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAtMs: Date.now() + 1000,
      refreshExpiresAtMs: Date.now() + 86_400_000,
      domain: 'codebuddy.cn',
      uid: 'uid-1',
      enterpriseId: '',
    },
  }]
  settings.activeAccount.workbuddy = 'default'
  return settings
}

test('在途续期返回时账号已被删除：不写回令牌、不记续期事件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-inflight-refresh-'))
  const originalFetch = globalThis.fetch
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const written = []
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/v2/plugin/auth/token/refresh')) {
      await gate
      return Response.json({ data: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 } })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }
  try {
    const settings = settingsWithExpiringToken()
    const runtime = new Runtime({
      settings: () => settings,
      dataDir: dir,
      logger: {},
      onCredentialRefreshed: (provider, accountId, token) => written.push({ provider, accountId, token }),
    })
    const account = settings.accounts.workbuddy[0]
    const pending = runtime.describeCredential('workbuddy', account, settings)
    // 等请求真正发出去。
    await new Promise((resolve) => setTimeout(resolve, 30))
    // 用户删掉默认账号。
    settings.accounts.workbuddy = []
    settings.activeAccount.workbuddy = undefined
    runtime.forgetAccount('workbuddy', 'default')
    release()
    await pending.catch(() => undefined)
    assert.deepEqual(written, [], '删除后不该再把续期结果写回设置')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('在途目录刷新返回时账号已被删除：不写回目录，也不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-inflight-catalog-'))
  const originalFetch = globalThis.fetch
  let release
  const gate = new Promise((resolve) => { release = resolve })
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/v3/config')) {
      await gate
      return Response.json({
        code: 0,
        data: {
          agents: [{ name: 'cli', models: ['m'] }],
          models: [{ id: 'm', name: 'M', maxInputTokens: 1000, maxOutputTokens: 100 }],
        },
      })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }
  try {
    const settings = settingsWithExpiringToken()
    // 目录刷新只需要一个还有效的令牌，不要触发续期。
    settings.accounts.workbuddy[0].token.expiresAtMs = Date.now() + 86_400_000
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    const pending = runtime.refresh('workbuddy')
    await new Promise((resolve) => setTimeout(resolve, 30))
    settings.accounts.workbuddy = []
    settings.activeAccount.workbuddy = undefined
    runtime.forgetAccount('workbuddy', 'default')
    release()
    const result = await pending.catch(() => undefined)
    assert.equal(runtime.catalogs.has('workbuddy::default'), false, '已删除账号的目录不能留在内存')
    assert.equal(runtime.modelsFor('workbuddy').length, 0, '已删除账号的模型不能继续被列出')
    assert.equal(result?.reason, 'account-forgotten')
    runtime.flushCaches()
    const cacheText = readFileSync(join(dir, 'catalog-cache.json'), 'utf8')
    assert.equal(cacheText.includes('workbuddy::default'), false, '已删除账号的目录不能落盘')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})
