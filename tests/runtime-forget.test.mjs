// 回归：删除账号（forgetAccount）与在途额度刷新的竞态。
//
// 真实时序：后台每 2 分钟刷一次额度，单次请求最长 20 秒；用户在这段时间里删掉
// 账号。旧实现让在途请求返回后**无条件**把 creditCache / creditHistory 写回去，
// 删除动作被静默撤销；隐式默认账号（id 固定 `default`）删掉后又会被合成回来，
// 于是「删除 → 重新配置」的新账号直接继承旧账号的余额与消耗历史。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { accountsFor } from '../lib/accounts.js'
import { Runtime } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'

/** 一份只启用 qoder、且额度端点会挂住的设置。 */
function hangingSettings() {
  const settings = defaults()
  for (const provider of ['workbuddy', 'workbuddy-ai', 'qoder-global', 'trae', 'trae-global']) {
    settings.providers[provider].enabled = false
  }
  settings.qoder.qoder.pat = 'pat-old'
  settings.activeAccount.qoder = 'default'
  return settings
}

test('删除账号后，在途额度刷新不得把它的额度与消耗历史写回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-forget-race-'))
  const originalFetch = globalThis.fetch
  let release
  const gate = new Promise((resolve) => { release = resolve })
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/api/v2/quota/usage')) {
      await gate
      return Response.json({ userQuota: { total: 5000, used: 760, remaining: 4242 } })
    }
    if (href.includes('/api/v2/user/plan')) return Response.json({ plan_tier_name: 'Pro', is_paid_plan: true })
    if (href.includes('/api/v3/user/status')) return Response.json({ nextResetAt: Date.now() + 86_400_000 })
    throw new Error(`unexpected fetch: ${href}`)
  }
  try {
    const settings = hangingSettings()
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    runtime.identities.set('qoder::default', {
      pat: 'pat-old', region: 'china', userID: 'u-old', authToken: 'job', name: 'old', email: 'e',
      machineID: 'm', expiresAtMs: Date.now() + 3_600_000,
    })
    // 后台刷新卡在上游。
    const pending = runtime.refreshCredits('qoder', { force: true })
    await new Promise((resolve) => setTimeout(resolve, 60))

    // 用户删掉默认账号（客户端发 removedAccounts + forgotDefault）。
    settings.qoder.qoder.pat = ''
    settings.accounts.qoder = []
    settings.activeAccount.qoder = undefined
    runtime.forgetAccount('qoder', 'default')
    assert.equal(runtime.creditsFor('qoder', 'default').state, 'none', '删除后立刻不应再读到额度')

    // 上游返回：这次结果必须被丢弃。
    release()
    await pending.catch(() => undefined)
    runtime.flushCaches()
    assert.equal(runtime.creditCache.has('qoder::default'), false, '在途刷新不能把缓存写回')
    assert.equal(
      runtime.creditHistory.snapshot().entries['qoder::default'],
      undefined,
      '在途刷新不能把消耗历史写回',
    )

    // 用户重新配置（隐式默认账号又是同一个 id）：新账号不能继承旧数字。
    settings.qoder.qoder.pat = 'pat-new'
    assert.deepEqual(accountsFor('qoder', settings).map((row) => row.id), ['default'])
    const inherited = runtime.creditsFor('qoder', 'default')
    assert.equal(inherited.state, 'none', '新账号不该显示已删账号的余额')
    assert.equal(inherited.remain, 0)
    assert.equal(inherited.trend?.sampleCount ?? 0, 0, '新账号不该继承旧的消耗历史')
    const cacheText = existsSync(join(dir, 'credits-cache.json'))
      ? readFileSync(join(dir, 'credits-cache.json'), 'utf8')
      : ''
    assert.equal(cacheText.includes('qoder::default'), false, '磁盘缓存里也不能留下被删账号')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})
