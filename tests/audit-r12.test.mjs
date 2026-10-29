/**
 * 第十二轮审计回归。
 *
 * 覆盖本轮用最小脚本复现并修掉的 7 条后端缺陷：
 * - 换 PAT / 登录文件后旧的额度快照与消耗曲线必须立刻作废（且只作废该账号）；
 * - 换号写回设置失败不能终结一次已经成功的回答；
 * - 模型明确允许关闭思考时，用户选 off 不能再被补回唯一档位；
 * - 老 stats.json 升级后平均耗时不显示 0ms；
 * - 删除账号要同时清理「最近请求」；
 * - 运行中删掉 settings.json 不能被内存旧快照写回；
 * - 显式 test/probe 一个已关闭的 provider 必须非零退出。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { credentialTargetsOf, sanitizePatch } from '../lib/patch.js'
import { Runtime } from '../lib/runtime.js'
import { SettingsStore, defaults } from '../lib/settings.js'
import { Stats, dayKey, statsPathOf } from '../lib/stats.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 只启用某个 provider 的设置。 */
function onlyProvider(provider) {
  const settings = defaults()
  for (const id of ['workbuddy', 'workbuddy-ai', 'qoder', 'qoder-global', 'trae', 'trae-global']) {
    settings.providers[id].enabled = id === provider
  }
  return settings
}

/** 一个可用的 WorkBuddy 浏览器登录令牌。 */
function workbuddyToken(uid, accessToken) {
  return {
    accessToken,
    refreshToken: '',
    expiresAtMs: Date.now() + 3_600_000,
    refreshExpiresAtMs: 0,
    domain: 'codebuddy.cn',
    uid,
    enterpriseId: '',
  }
}

/** 一条最小 SSE 响应。 */
function sseResponse(text) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${text}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

// ---------- 凭证变化 ----------

test('账号池里换 PAT：只作废这个账号的额度缓存与消耗历史', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-r12-credits-'))
  const originalFetch = globalThis.fetch
  const calls = { 'pat-a': 0, 'pat-b': 0, 'pat-c': 0 }
  const remains = { 'pat-a': 99, 'pat-b': 42, 'pat-c': 77 }
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    const patOfToken = (value) => String(value).replace('job-', '')
    if (href.includes('/jobToken/exchange')) {
      const body = JSON.parse(init?.body ?? '{}')
      return Response.json({ token: `job-${String(body.personal_token)}` })
    }
    if (href.includes('/api/v1/userinfo')) {
      const token = patOfToken(String(init?.headers?.authorization ?? '').replace('Bearer ', ''))
      return Response.json({ id: `user-${token}`, name: 'N', email: 'n@example.com' })
    }
    if (href.includes('/api/v2/quota/usage')) {
      const token = patOfToken(String(init?.headers?.authorization ?? '').replace('Bearer ', ''))
      calls[token] += 1
      return Response.json({ userQuota: { total: 100, used: 100 - remains[token], remaining: remains[token] } })
    }
    if (href.includes('/api/v2/user/plan')) return Response.json({ plan_tier_name: 'Pro', is_paid_plan: true })
    if (href.includes('/api/v3/user/status')) return Response.json({ nextResetAt: Date.now() + 86_400_000 })
    return new Response('unexpected ' + href, { status: 500 })
  }
  try {
    const settings = onlyProvider('qoder')
    settings.accounts.qoder = [
      { id: 'acc-x', label: 'X', enabled: true, pat: 'pat-a' },
      { id: 'acc-y', label: 'Y', enabled: true, pat: 'pat-c' },
    ]
    settings.activeAccount.qoder = 'acc-x'
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    try {
      await runtime.refreshCredits('qoder', { force: true })
      assert.equal(runtime.creditsFor('qoder', 'acc-x').remain, 99)
      assert.equal(runtime.creditsFor('qoder', 'acc-y').remain, 77)
      assert.ok(runtime.creditHistory.snapshot().entries['qoder::acc-x'], '第一个账号应有消耗历史')
      assert.ok(runtime.creditHistory.snapshot().entries['qoder::acc-y'], '第二个账号应有消耗历史')

      assert.deepEqual(calls, { 'pat-a': 1, 'pat-b': 0, 'pat-c': 1 })
      // 用户在 acc-x 这一行换成另一个 Qoder 账号的 PAT。
      settings.accounts.qoder[0].pat = 'pat-b'
      runtime.forgetCredentialState([{ provider: 'qoder', accountId: 'acc-x' }])

      assert.equal(runtime.creditCache.has('qoder::acc-x'), false, '旧余额必须立刻作废')
      assert.ok(runtime.creditCache.get('qoder::acc-y'), '另一个账号的缓存不能被误删')
      assert.equal(runtime.creditHistory.snapshot().entries['qoder::acc-x'], undefined)
      assert.ok(runtime.creditHistory.snapshot().entries['qoder::acc-y'], '另一个账号的历史不能被误删')

      // /status 的非 force 刷新：必须真的去读新凭证，而不是命中原有的 2 分钟新鲜窗口。
      await runtime.refreshCredits('qoder')
      assert.equal(runtime.creditsFor('qoder', 'acc-x').remain, 42)
      assert.equal(calls['pat-b'], 1, '换 PAT 后应重新请求一次上游')
      assert.equal(calls['pat-c'], 1, '未换凭证的账号不应被重新请求')
      assert.equal(runtime.creditsFor('qoder', 'acc-y').remain, 77, '未换凭证的账号沿用缓存')
    } finally {
      runtime.flushCaches()
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('credentialTargetsOf 区分账号级与 provider 级凭证', () => {
  const account = sanitizePatch({ accounts: { qoder: [{ id: 'acc-x', label: 'X', pat: 'p' }] } })
  assert.deepEqual(credentialTargetsOf(account), [{ provider: 'qoder', accountId: 'acc-x' }])
  const legacy = sanitizePatch({ qoder: { qoder: { pat: 'p' } } })
  assert.deepEqual(credentialTargetsOf(legacy), [{ provider: 'qoder' }])
  const unrelated = sanitizePatch({ accounts: { workbuddy: [{ id: 'a', label: 'A' }] } })
  assert.deepEqual(credentialTargetsOf(unrelated), [])
})

// ---------- 换号写回 ----------

test('换号写回设置失败时，已经成功的回答仍完整返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-r12-switch-'))
  const originalFetch = globalThis.fetch
  const warnings = []
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (!href.includes('/v2/chat/completions')) return new Response('unexpected ' + href, { status: 500 })
    const auth = String(init?.headers?.Authorization ?? '')
    if (auth.includes('token-a')) {
      return new Response('{"displayMsg":{"zh":"令牌失效"}}', { status: 401 })
    }
    return sseResponse('OK')
  }
  try {
    const settings = onlyProvider('workbuddy')
    settings.accounts.workbuddy = [
      { id: 'a', label: 'A', enabled: true, token: workbuddyToken('u1', 'token-a') },
      { id: 'b', label: 'B', enabled: true, token: workbuddyToken('u2', 'token-b') },
    ]
    settings.activeAccount.workbuddy = 'a'
    const runtime = new Runtime({
      settings: () => settings,
      dataDir: dir,
      logger: { warn: (...args) => warnings.push(args.join(' ')) },
      // 与 CLI 的 onAccountSwitch 同形：写锁被占时 store.patch() 抛错。
      onAccountSwitch: () => {
        const error = new Error('settings.json 正被另一个进程写入')
        error.code = 'SETTINGS_LOCKED'
        throw error
      },
    })
    runtime.catalogs.set('workbuddy::a', {
      models: [{ id: 'glm-x', name: 'GLM X', contextWindow: 128_000, maxTokens: 32_000, reasoningEfforts: [], canDisableThinking: false }],
      fetchedAt: Date.now(),
      source: 'live',
    })
    try {
      const opened = await runtime.openStream('workbuddy', {
        model: 'glm-x',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: AbortSignal.timeout(5000),
      })
      let text = ''
      let finish
      for await (const event of opened.events) {
        if (event.type === 'text') text += event.text
        if (event.type === 'finish') finish = event
      }
      assert.equal(text, 'OK', '换号后的正文不能因为写盘失败而丢失')
      assert.equal(finish.kind, 'stop')
      assert.match(warnings.join('\n'), /换号结果写回设置失败/, '写回失败应留一条 warn，而不是抛给请求')
    } finally {
      runtime.flushCaches()
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 思考档位 ----------

test('模型 canDisableThinking 时，用户选 off 不再被补回唯一档位', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-r12-off-'))
  const originalFetch = globalThis.fetch
  let sent
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (!href.includes('/v2/chat/completions')) return new Response('unexpected ' + href, { status: 500 })
    sent = JSON.parse(init.body)
    return sseResponse('hi')
  }
  try {
    const settings = onlyProvider('workbuddy')
    settings.accounts.workbuddy = [{
      id: 'a',
      label: 'A',
      enabled: true,
      token: workbuddyToken('u1', 'token-a'),
    }]
    settings.activeAccount.workbuddy = 'a'
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    runtime.catalogs.set('workbuddy::a', {
      models: [{
        id: 'glm-x',
        name: 'GLM X',
        contextWindow: 128_000,
        maxTokens: 32_000,
        supportsReasoning: true,
        reasoningEfforts: ['high'],
        defaultEffort: 'high',
        canDisableThinking: true,
      }],
      fetchedAt: Date.now(),
      source: 'live',
    })
    try {
      const opened = await runtime.openStream('workbuddy', {
        model: 'glm-x',
        reasoningEffort: 'off',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: AbortSignal.timeout(5000),
      })
      for await (const _event of opened.events) { /* 只为拿到发出去的 body */ }
      assert.equal(sent.reasoning_effort, undefined, '关闭思考不能被改回 high')
    } finally {
      runtime.flushCaches()
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 统计 ----------

test('老 stats.json（没有 okDurationMs）升级后平均耗时沿用旧口径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-r12-stats-'))
  try {
    writeFileSync(statsPathOf(dir), JSON.stringify({
      version: 4,
      since: 1,
      totals: { requests: 4, ok: 4, failed: 0, durationMs: 4000 },
      today: { date: dayKey(), requests: 4, ok: 4, durationMs: 4000 },
    }))
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true })
    const totals = stats.snapshot().totals
    assert.equal(totals.ok, 4)
    assert.equal(totals.avgDurationMs, 1000, '0.6.5 之前写出的统计不能显示成 0ms')
    stats.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('删除账号会同时清掉它的「最近请求」并落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-r12-recent-'))
  try {
    const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => true })
    stats.record({ provider: 'workbuddy', accountId: 'acc-old', model: 'm', kind: 'stop', durationMs: 100 })
    stats.record({ provider: 'workbuddy', accountId: 'acc-keep', model: 'm', kind: 'stop', durationMs: 100 })
    assert.deepEqual(stats.snapshot().recent.map((entry) => entry.accountId), ['acc-keep', 'acc-old'])
    stats.forgetAccount('workbuddy', 'acc-old')
    assert.deepEqual(stats.snapshot().recent.map((entry) => entry.accountId), ['acc-keep'])
    stats.stop()
    const saved = JSON.parse(readFileSync(statsPathOf(dir), 'utf8'))
    assert.deepEqual(saved.recent.map((entry) => entry.accountId), ['acc-keep'], '删除结果必须落盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 设置文件被删 ----------

test('运行中删掉 settings.json：下一次 patch 不会把旧 PAT 与账号池写回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-r12-settings-'))
  try {
    const file = join(dir, 'settings.json')
    const store = new SettingsStore(file)
    const settings = defaults()
    settings.qoder.qoder.pat = 'secret-pat'
    settings.providers.qoder.enabled = true
    store.patch(settings)
    assert.equal(store.get().qoder.qoder.pat, 'secret-pat')

    unlinkSync(file)
    store.patch({ checkin: { enabled: false } })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.qoder.qoder.pat, '', '删掉的 PAT 不能被内存旧快照复活')
    assert.equal(store.get().qoder.qoder.pat, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- CLI ----------

test('CLI：显式 test/probe 一个已关闭的 provider 时 exit 2', () => {
  const profile = mkdtempSync(join(tmpdir(), 'rpc-r12-cli-'))
  try {
    const dataDir = join(profile, '.dsh-reverse-proxy-connect')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      version: 2,
      providers: {
        workbuddy: { enabled: false },
        'workbuddy-ai': { enabled: false },
        qoder: { enabled: false },
        'qoder-global': { enabled: false },
        trae: { enabled: false },
        'trae-global': { enabled: false },
      },
    }), { flag: 'w' })
    for (const command of ['test', 'probe']) {
      const child = spawnSync(process.execPath, [join(ROOT, 'lib', 'bin.js'), command, 'workbuddy', '--profile', profile], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env },
      })
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
      assert.equal(child.status, 2, `${command} 对已关闭 provider 应 exit 2；输出：${output}`)
      assert.match(output, /已在设置里关闭/, `${command} 应说明为什么什么都没做`)
    }
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})
