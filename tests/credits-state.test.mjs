/**
 * 额度状态语义与时长格式。
 *
 * 这两块都是「数字看起来没变、意思变了」的高危区，所以单独成一份用例：
 *
 * - **读不到 ≠ 缓存**。1.7.x 里 `creditsFor()` 只要条目带 `error` 就标 `stale`，
 *   于是没有额度端点（Trae 国际版 404）或还没配 PAT 的 provider 会显示
 *   「0 / 0 credits · 缓存」。那个 0 是 `emptyCredits()` 的占位值，不是余额。
 * - **读不到 ≠ 0**。浏览器半边以前对 `state:'error'` 也走数字分支，显示成
 *   「0 积分」；CLI/诊断则把 `state:'none'` 拼成「0 / 0 credits」。
 * - **252 天不该说成 363476 分钟**。耗尽预估的毫秒数以前直接除以 60000 打印，
 *   六位数分钟既难读又容易被当成「马上要用完了」。
 *
 * @module dsh-reverse-proxy-connect/tests/credits-state
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { formatCompactDuration, formatDurationZh } from '../lib/format.js'
import { Runtime } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'

/** 造一个只启用了指定 provider 的设置。 */
function settingsFor(provider) {
  const settings = defaults()
  for (const id of Object.keys(settings.providers)) {
    if (id !== provider) settings.providers[id].enabled = false
  }
  return settings
}

/** 在临时目录里跑一段用例。 */
async function withRuntime(settings, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-credits-state-'))
  const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
  try {
    await fn(runtime, dir)
  } finally {
    runtime.flushCaches()
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- format ----------

test('时长格式：分钟/小时/天三档，且 252 天不再摊成六位数分钟', () => {
  assert.equal(formatCompactDuration(45 * 60_000), '45m')
  assert.equal(formatCompactDuration(3 * 3_600_000 + 20 * 60_000), '3h 20m')
  assert.equal(formatCompactDuration(3 * 3_600_000), '3h')
  assert.equal(formatCompactDuration(252 * 86_400_000), '252d')
  assert.equal(formatCompactDuration(2 * 86_400_000 + 4 * 3_600_000), '2d 4h')
  // 非法输入不产出 NaN / Infinity。
  assert.equal(formatCompactDuration(undefined), '—')
  assert.equal(formatCompactDuration(Number.NaN), '—')
  assert.equal(formatCompactDuration(-1), '—')
  // 不足一分钟按 1 分钟算：0m 会被读成「没有时间」。
  assert.equal(formatCompactDuration(1_000), '1m')

  assert.equal(formatDurationZh(45 * 60_000), '45 分钟')
  assert.equal(formatDurationZh(3 * 3_600_000 + 20 * 60_000), '3 小时 20 分')
  assert.equal(formatDurationZh(252 * 86_400_000), '252 天')
  assert.equal(formatDurationZh(undefined), '—')
})

// ---------- creditsFor ----------

test('额度状态：读失败且没有旧数字时不标 stale（否则 0 会被当成真实余额）', async () => {
  const settings = settingsFor('workbuddy')
  settings.accounts.workbuddy = [{
    id: 'default',
    label: '本机登录',
    enabled: true,
    token: {
      accessToken: 'tok',
      refreshToken: '',
      expiresAtMs: Date.now() + 3_600_000,
      refreshExpiresAtMs: 0,
      domain: 'codebuddy.cn',
      uid: 'uid-1',
      enterpriseId: '',
    },
  }]
  settings.activeAccount.workbuddy = 'default'
  const originalFetch = globalThis.fetch
  // 让额度端点直接 503：这是「这一轮读不到」的最小复现。
  globalThis.fetch = async () => new Response('upstream down', { status: 503 })
  try {
    await withRuntime(settings, async (runtime) => {
      await runtime.refreshCredits('workbuddy', { force: true })
      const credits = runtime.creditsFor('workbuddy')
      // 从没读到过数字 → 不能显示成「0 / 0 · 缓存」。
      assert.equal(credits.state, 'none')
      assert.equal(credits.stale, undefined, '没有旧数字时不该标 stale')
      assert.equal(credits.remain, 0)
      assert.match(credits.error, /503/)
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('额度状态：真有旧数字、这一轮读失败时才标 stale 并保留数字', async () => {
  const settings = settingsFor('workbuddy')
  settings.accounts.workbuddy = [{ id: 'default', label: '本机登录', enabled: true }]
  await withRuntime(settings, async (runtime) => {
    // 直接写缓存条目，模拟「上次读到 675 / 1200，这次读失败」。
    runtime.creditCache.set('workbuddy::default', {
      data: { state: 'ok', remain: 675, total: 1200, unit: 'credits', items: [], fetchedAt: 1 },
      fetchedAt: 1,
      error: 'WorkBuddy 额度接口返回 HTTP 503',
    })
    const credits = runtime.creditsFor('workbuddy')
    assert.equal(credits.state, 'ok', '有旧快照时仍然展示状态 ok')
    assert.equal(credits.remain, 675, '旧数字要留着，不能清成 0')
    assert.equal(credits.stale, true)
    assert.match(credits.error, /HTTP 503/)
  })
})

test('额度状态：没有额度端点（state none + error）时既不 stale 也不冒充数字', async () => {
  const settings = settingsFor('trae-global')
  await withRuntime(settings, async (runtime) => {
    runtime.creditCache.set('trae-global::default', {
      data: { state: 'none', remain: 0, total: 0, unit: 'credits', items: [], fetchedAt: 0 },
      fetchedAt: 0,
      error: 'Trae 国际版没有提供额度查询接口，额度请在 Trae 客户端里查看。',
    })
    const credits = runtime.creditsFor('trae-global')
    assert.equal(credits.state, 'none')
    assert.equal(credits.stale, undefined)
    assert.match(credits.error, /没有提供额度查询接口/)
  })
})
