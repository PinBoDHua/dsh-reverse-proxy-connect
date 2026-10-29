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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { formatClock, formatDateOnly, formatDateTime, formatCompactDuration, formatDurationZh } from '../lib/format.js'
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

test('时长格式与浏览器半边逐字一致：同一份数据两边不能显示成两个数', () => {
  // 浏览器 bundle 不能 import 本模块，所以两边的规则是手抄的。这里把 client.js
  // 里的 formatCompactDuration 原样抠出来跑一遍，确保两边对所有输入一致 ——
  // 否则卡片说「3h 20m」、侧栏说「200m」那种对不上很难查。
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('function formatCompactDuration(ms) {')
  assert.ok(start > 0, 'client.js 里找不到 formatCompactDuration')
  let depth = 0
  let end = start
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}') {
      depth--
      if (depth === 0) {
        end = index + 1
        break
      }
    }
  }
  const clientFormat = new Function(`${source.slice(start, end)}; return formatCompactDuration`)()
  const samples = [
    1_000,
    59_000,
    60_000,
    45 * 60_000,
    59 * 60_000,
    60 * 60_000,
    3 * 3_600_000,
    3 * 3_600_000 + 20 * 60_000,
    23 * 3_600_000 + 59 * 60_000,
    24 * 3_600_000,
    252 * 86_400_000,
    400 * 86_400_000,
  ]
  for (const ms of samples) {
    assert.equal(formatCompactDuration(ms), clientFormat(ms), `${String(ms)}ms 两边不一致`)
  }
  // 非法值也一致。
  for (const value of [undefined, Number.NaN, 0, -1]) {
    assert.equal(formatCompactDuration(value), clientFormat(value), `${String(value)} 两边不一致`)
  }
})

test('日期时间：定宽零填充，无效/超范围一律 —，绝不产出 Invalid Date/NaN', () => {
  const ts = 1_792_296_284_000
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  const expected = `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  assert.equal(formatDateTime(ts), expected)
  assert.match(formatDateTime(ts), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.match(formatClock(ts), /^\d{2}:\d{2}:\d{2}$/)
  assert.match(formatDateOnly(ts), /^\d{4}-\d{2}-\d{2}$/)
  // 无效输入绝不能漏出英文 "Invalid Date" 或 "NaN"（这是本轮修的坑）。
  for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1, '2026-10-18 12:04:44', {}, true]) {
    for (const fn of [formatDateTime, formatClock, formatDateOnly]) {
      const out = fn(bad)
      assert.equal(typeof out, 'string')
      assert.ok(!/Invalid|NaN/.test(out), `${fn.name}(${String(bad)}) = ${out}`)
    }
  }
  assert.equal(formatDateTime(Number.NaN), '—')
  assert.equal(formatClock('x'), '—')
  assert.equal(formatDateOnly(8.64e15 + 1), '—')
})

test('日期时间与浏览器半边逐字一致：卡片与 CLI 不能把同一时间戳显示成两个样', () => {
  // 浏览器 bundle 不能 import 本模块，两边的规则是手抄的。把 client.js 里的
  // formatTime 原样抠出来跟 lib 的 formatDateTime 比一遍，防止「卡片一套、
  // CLI 一套」那种难查的口径漂移（尤其无效值必须都回 —）。
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const header = 'function formatTime(ms) {'
  const start = source.indexOf(header)
  assert.ok(start > 0, 'client.js 里找不到 formatTime')
  let depth = 0
  let end = start
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}') {
      depth--
      if (depth === 0) {
        end = index + 1
        break
      }
    }
  }
  const clientFormatTime = new Function(`${source.slice(start, end)}; return formatTime`)()
  for (const ms of [1, 0, -1, Number.NaN, undefined, 8.64e15 + 1, 1_792_296_284_000, Date.now(), 1_000]) {
    assert.equal(formatDateTime(ms), clientFormatTime(ms), `${String(ms)} 两边不一致`)
  }
  for (const bad of ['x', null, {}, true]) {
    assert.equal(formatDateTime(bad), clientFormatTime(bad), `${String(bad)} 两边不一致`)
  }
})

// ---------- creditsFor ----------

test('额度新鲜窗口跟随高级设置：把刷新间隔调到 30 秒必须真的提前刷新', async () => {
  // 真实缺陷：内部写死 120 秒新鲜窗口，用户把 creditsRefreshMs 改成 30 秒后，
  // 调度器每 30 秒仍被这一层判成「还新鲜」而跳过 —— 设置看起来保存成功、
  // 实际 2 分钟内一次请求都没发。
  const settings = settingsFor('qoder')
  settings.advanced.creditsRefreshMs = 30_000
  settings.accounts.qoder = [{ id: 'default', label: '默认令牌', enabled: true, pat: 'pt-test' }]
  settings.activeAccount.qoder = 'default'
  const originalFetch = globalThis.fetch
  let quotaCalls = 0
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/api/v2/quota/usage')) {
      quotaCalls += 1
      return Response.json({ userQuota: { total: 100, used: 10, remaining: 90 } })
    }
    if (href.includes('/api/v2/user/plan')) return Response.json({ plan_tier_name: 'Pro', is_paid_plan: true })
    if (href.includes('/api/v3/user/status')) return Response.json({ nextResetAt: Date.now() + 86_400_000 })
    throw new Error(`unexpected fetch ${href}`)
  }
  try {
    await withRuntime(settings, async (runtime) => {
      runtime.identities.set('qoder::default', {
        pat: 'pt-test',
        region: 'china',
        userID: 'u1',
        authToken: 'job',
        name: 'tester',
        email: 'a@b.c',
        machineID: 'm',
        expiresAtMs: Date.now() + 3_600_000,
      })
      // 40 秒前刚读过一次：按 120 秒窗口算「新鲜」，按 30 秒算「过期」。
      runtime.creditCache.set('qoder::default', {
        data: { state: 'ok', remain: 90, total: 100, unit: 'credits', items: [], fetchedAt: Date.now() - 40_000 },
        fetchedAt: Date.now() - 40_000,
        stale: false,
      })
      await runtime.refreshCredits('qoder')
      assert.equal(quotaCalls, 1, '40 秒前的缓存必须被视为过期并重新读取')
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

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
