// 回归：删除账号（forgetAccount）与在途额度刷新的竞态。
//
// 真实时序：后台每 2 分钟刷一次额度，单次请求最长 20 秒；用户在这段时间里删掉
// 账号。旧实现让在途请求返回后**无条件**把 creditCache / creditHistory 写回去，
// 删除动作被静默撤销；隐式默认账号（id 固定 `default`）删掉后又会被合成回来，
// 于是「删除 → 重新配置」的新账号直接继承旧账号的余额与消耗历史。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
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
    // 墓碑（forgotten）里出现这个 key 是**对的**：它正是「别再把这条写回来」的
    // 判据。要保证的是快照本身不在了 —— 否则下次启动又会读出一个已删账号的余额。
    const cacheDoc = cacheText === '' ? { entries: {}, forgotten: [] } : JSON.parse(cacheText)
    assert.equal(cacheDoc.entries['qoder::default'], undefined, '磁盘缓存里不能留下被删账号的快照')
    assert.equal(cacheDoc.forgotten.includes('qoder::default'), true, '删除必须落一条墓碑')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('换凭证也要写额度墓碑：重启后不能先显示上一个账号的余额', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-cred-replace-'))
  const settings = hangingSettings()
  try {
    // 旧凭证读到过的 500 分已经落盘。
    writeFileSync(join(dir, 'credits-cache.json'), JSON.stringify({
      version: 1,
      entries: {
        'qoder::default': {
          data: { state: 'ok', remain: 500, total: 1000, unit: 'credits', items: [], fetchedAt: Date.now() - 1000 },
          fetchedAt: Date.now() - 1000,
        },
      },
    }))
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    assert.equal(runtime.creditsFor('qoder', 'default').remain, 500, '启动先恢复到旧快照')

    // 用户在卡片里把 PAT 换成另一个账号的令牌：内存条目清空，但磁盘上没有墓碑
    // 时，下一次落盘按 key 合并会把旧条目并回来。
    runtime.forgetCredentialState([{ provider: 'qoder', accountId: 'default' }])
    assert.equal(runtime.creditsFor('qoder', 'default').state, 'none', '换凭证后内存里不能还留着旧余额')
    runtime.flushCaches()

    const doc = JSON.parse(readFileSync(join(dir, 'credits-cache.json'), 'utf8'))
    assert.equal(doc.entries['qoder::default'], undefined, '磁盘缓存里不能留下旧凭证的余额')
    assert.equal(doc.forgotten.includes('qoder::default'), true, '换凭证必须落一条墓碑')

    const restarted = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    assert.equal(restarted.creditsFor('qoder', 'default').state, 'none', '重启后又读出了上一个账号的余额')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('删除账号的墓碑要挡住「保存时与磁盘合并」，重启后不能再读出它的余额', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-forget-disk-'))
  const settings = hangingSettings()
  try {
    // 先造一份「上次运行留下的」磁盘快照（模拟删账号之前已经落过盘）。
    writeFileSync(join(dir, 'credits-cache.json'), JSON.stringify({
      version: 1,
      entries: {
        'qoder::default': {
          data: { state: 'ok', remain: 4242, total: 5000, unit: 'credits', items: [] },
          fetchedAt: Date.now() - 1000,
        },
      },
    }))
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    // 启动时读到了这份快照。
    assert.equal(runtime.creditsFor('qoder', 'default').remain, 4242)
    settings.qoder.qoder.pat = ''
    settings.accounts.qoder = []
    runtime.forgetAccount('qoder', 'default')
    runtime.flushCaches()

    // 合并写盘读的是磁盘上的旧条目：墓碑必须在 saveCreditsCache 里生效。
    const doc = JSON.parse(readFileSync(join(dir, 'credits-cache.json'), 'utf8'))
    assert.equal(doc.entries['qoder::default'], undefined, '墓碑没能删掉磁盘上的旧快照')

    // 重启（重新 loadCreditsCache）后不能再读到已删除账号的余额。
    const restarted = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    assert.equal(restarted.creditsFor('qoder', 'default').state, 'none', '重启后又读出了已删除账号的余额')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
