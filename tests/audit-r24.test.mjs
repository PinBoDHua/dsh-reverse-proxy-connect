/**
 * R24 审计回归用例。
 *
 * 这些用例覆盖的都是"现有 449 条测试没有覆盖到"的交叉路径：外部补丁与账号池
 * 合并的字段语义、插件生命周期回调的执行时机。
 *
 * @module dsh-reverse-proxy-connect/tests/audit-r24
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { mergeAccountSecrets } from '../lib/accounts.js'
import { apply, refreshTargetsOf } from '../lib/index.js'
import { sanitizePatch } from '../lib/patch.js'
import { PROVIDER_IDS } from '../lib/protocol.js'
import { classifyUpstreamBody, parseStream as parseQoderStream } from '../lib/qoder/transport.js'
import { failureCodeOf, parseOpenAiSse } from '../lib/runtime.js'
import { normalize } from '../lib/settings.js'
import { parseStream as parseTraeStream } from '../lib/trae/transport.js'
import { normalizeToken, pollAuthToken } from '../lib/workbuddy/browser-login.js'
import { authFileCandidates } from '../lib/workbuddy/credentials.js'

/** 一个已物化两条账号的设置快照。 */
function settingsWithAccounts() {
  return normalize({
    accounts: {
      qoder: [
        { id: 'acc-a', label: '我的生产账号', enabled: false, pat: 'pt-old' },
        { id: 'acc-b', label: '备用', enabled: true, pat: 'pt-b' },
      ],
    },
  })
}

// ── B-1：增量 upsert 只覆盖显式提交的字段 ──────────────────────────────

test('B-1：只提交 pat 的补丁保留旧的 label 与 enabled', () => {
  const current = settingsWithAccounts()
  const patch = sanitizePatch({ accounts: { qoder: [{ id: 'acc-a', pat: 'pt-new' }] } })
  // 补丁本身不能带默认值：否则合并时必然覆盖旧字段。
  assert.equal(patch.accounts.qoder[0].label, undefined)
  assert.equal(patch.accounts.qoder[0].enabled, undefined)

  const next = normalize(mergeAccountSecrets(patch, current))
  const row = next.accounts.qoder.find((account) => account.id === 'acc-a')
  assert.equal(row.label, '我的生产账号', '账号名不能被「账号 N」覆盖')
  assert.equal(row.enabled, false, '显式停用的账号不能被重新启用')
  assert.equal(row.pat, 'pt-new', '显式提交的密钥必须生效')
})

test('B-1：显式改名与显式启用仍然生效', () => {
  const current = settingsWithAccounts()
  const patch = sanitizePatch({ accounts: { qoder: [{ id: 'acc-a', label: '新名字', enabled: true }] } })
  const next = normalize(mergeAccountSecrets(patch, current))
  const row = next.accounts.qoder.find((account) => account.id === 'acc-a')
  assert.equal(row.label, '新名字')
  assert.equal(row.enabled, true)
  assert.equal(row.pat, 'pt-old', '没提到密钥时必须沿用旧密钥')
})

test('B-1：forget 只清密钥，不动 label / enabled', () => {
  const current = settingsWithAccounts()
  const patch = sanitizePatch({ accounts: { qoder: [{ id: 'acc-a', forget: true }] } })
  const next = normalize(mergeAccountSecrets(patch, current))
  const row = next.accounts.qoder.find((account) => account.id === 'acc-a')
  assert.equal(row.pat, undefined)
  assert.equal(row.label, '我的生产账号')
  assert.equal(row.enabled, false)
})

test('B-1：没有 id 的行是新增账号，仍会得到 id 与默认名', () => {
  const patch = sanitizePatch({ accounts: { qoder: [{ pat: 'pt-x' }] } })
  assert.match(patch.accounts.qoder[0].id, /^acc-[a-z0-9]+$/i)

  const next = normalize(mergeAccountSecrets(patch, normalize({})))
  const row = next.accounts.qoder.find((account) => account.id === patch.accounts.qoder[0].id)
  assert.ok(row !== undefined, '新账号必须落进账号池')
  assert.match(row.label, /^账号 \d+$/)
  assert.equal(row.enabled, true)
  assert.equal(row.pat, 'pt-x')
})

test('B-1：空字符串 label 视同未提交，不覆盖旧名字', () => {
  const current = settingsWithAccounts()
  const patch = sanitizePatch({ accounts: { qoder: [{ id: 'acc-a', label: '   ' }] } })
  const next = normalize(mergeAccountSecrets(patch, current))
  const row = next.accounts.qoder.find((account) => account.id === 'acc-a')
  assert.equal(row.label, '我的生产账号')
})

// ── B-3：保存只刷新受影响的 provider ────────────────────────────────

test('B-3：改一家 PAT 只刷新这一家的目录与额度', () => {
  assert.deepEqual(refreshTargetsOf({ qoder: { pat: 'x' } }, [{ provider: 'qoder' }], []), [
    { provider: 'qoder', credits: true },
  ])
})

test('B-3：切当前账号只刷目录；打开 provider 才顺带刷额度', () => {
  assert.deepEqual(refreshTargetsOf({ activeAccount: { trae: 'acc-1' } }, [], []), [
    { provider: 'trae', credits: false },
  ])
  assert.deepEqual(refreshTargetsOf({ providers: { 'qoder-global': { enabled: true } } }, [], []), [
    { provider: 'qoder-global', credits: true },
  ])
  assert.deepEqual(refreshTargetsOf({ providers: { 'qoder-global': { enabled: false } } }, [], []), [
    { provider: 'qoder-global', credits: false },
  ])
})

test('B-3：同一 provider 的多个原因合并成一条，凭证原因优先级更高', () => {
  assert.deepEqual(refreshTargetsOf(
    { activeAccount: { qoder: 'acc-1' }, providers: { qoder: { enabled: false } } },
    [{ provider: 'qoder' }],
    [],
  ), [{ provider: 'qoder', credits: true }])
})

test('B-3：与凭证无关的补丁（模型开关）不需要刷新', () => {
  assert.deepEqual(refreshTargetsOf({ providers: { qoder: { disabledModels: ['x'] } } }, [], []), [])
  assert.deepEqual(refreshTargetsOf({ display: { showRateInModelName: false } }, [], []), [])
})

// ── B-5 / C-5：/status 的瘦身档 ─────────────────────────────────────

test('B-5：/status?view=core 去掉只有用量/事件页才需要的重字段，默认档不变', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rpc-audit-r24-view-'))
  writeFileSync(join(root, 'settings.json'), JSON.stringify({
    version: 2,
    providers: Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, { enabled: false }])),
  }))

  const handlers = {}
  const disposers = []
  const ctx = {
    get: (name) => (name === 'profileContext' ? { dir: root } : undefined),
    inject(names, callback) {
      if (names.includes('webServer')) {
        callback({
          webServer: {
            register(route) {
              handlers[route.path] = route.handler
              return () => { delete handlers[route.path] }
            },
          },
          effect(fn) {
            const dispose = fn()
            disposers.push(dispose)
            return dispose
          },
        })
      }
    },
    llm: { registerAdapter: () => () => {} },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    emit: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }

  const request = async (url) => {
    const res = {
      status: 0,
      body: '',
      setHeader() {},
      writeHead(status) { res.status = status; return res },
      end(chunk) { res.body = chunk === undefined ? '' : String(chunk) },
    }
    handlers['/plugins/dsh-reverse-proxy-connect/status'](
      { method: 'GET', url, headers: { host: '127.0.0.1:65466' }, socket: { remoteAddress: '127.0.0.1' } },
      res,
    )
    // safeRoute 是异步的（不返回 promise）：轮询等响应写出来，最多 3 秒。
    for (let index = 0; index < 1500 && res.body === ''; index++) await new Promise((resolve) => setTimeout(resolve, 2))
    return { status: res.status, body: res.body === '' ? {} : JSON.parse(res.body) }
  }

  try {
    apply(ctx, {})
    const full = await request('/plugins/dsh-reverse-proxy-connect/status')
    const core = await request('/plugins/dsh-reverse-proxy-connect/status?view=core')
    assert.equal(full.status, 200)
    assert.equal(core.status, 200)
    // 默认档保持原样：事件时间线还在。
    assert.ok(Array.isArray(full.body.events.items), '默认档必须带事件时间线')
    // core 档：事件只给摘要，用量里的重字段被清空，但账号/模型/额度仍然完整。
    assert.equal(core.body.events.items, undefined)
    assert.deepEqual(core.body.stats.recent, [])
    assert.deepEqual(core.body.stats.providerSessions, {})
    assert.deepEqual(core.body.stats.accountModels, {})
    assert.equal(core.body.providers.length, PROVIDER_IDS.length)
    for (const provider of core.body.providers) {
      assert.ok(Array.isArray(provider.accounts), 'core 档不能丢掉账号清单')
      assert.ok(Array.isArray(provider.models), 'core 档不能丢掉模型清单')
    }
    assert.ok(JSON.stringify(core.body).length < JSON.stringify(full.body).length, 'core 档必须比默认档小')
  } finally {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* ignore */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
})


// ── 传输层：T-1 / T-2 / T-3 / T-6 / T-9 / T-13 / T-19 / T-21 ─────────

/** 把若干段文本做成一个 SSE 字节流。 */
function textStream(chunks) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** 收集一条归一化事件流（过滤内部心跳）。 */
async function collect(iterable) {
  const events = []
  for await (const event of iterable) {
    if (event.type !== 'heartbeat') events.push(event)
  }
  return events
}

test('T-1：工具参数残缺时终态是 error（MALFORMED_RESPONSE），不是 tool-calls', async () => {
  const openai = textStream([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write_file","arguments":"{\\"path\\":"}}]}}]}\n',
  ])
  const events = await collect(parseOpenAiSse(openai))
  const finish = events.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.code, 'MALFORMED_RESPONSE')

  const qoder = textStream([
    `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'write_file', arguments: '{"path":' } }] } }] }) })}\n`,
  ])
  const qoderFinish = (await collect(parseQoderStream(qoder))).at(-1)
  assert.equal(qoderFinish.kind, 'error')
  assert.equal(qoderFinish.failure.code, 'MALFORMED_RESPONSE')

  const trae = textStream([
    'event: output\n',
    'data: {"tool_calls":[{"index":0,"id":"c","function_call":{"name":"write_file","arguments":"{\\"path\\":"}}]}\n',
    '\n',
  ])
  const traeFinish = (await collect(parseTraeStream(trae))).at(-1)
  assert.equal(traeFinish.kind, 'error')
  assert.equal(traeFinish.failure.code, 'MALFORMED_RESPONSE')
})

test('T-2：Qoder 200 流里的未知错误归 SERVER（可重试），不再落到 MALFORMED_RESPONSE', () => {
  const failure = classifyUpstreamBody('{"error":{"message":"系统繁忙"}}', 200)
  assert.equal(failureCodeOf(failure), 'SERVER')
})

test('T-3：缺少 index 的工具分片沿用上一个 index，不新开 0 号槽', async () => {
  const openai = textStream([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":2,"id":"call_a","function":{"name":"read","arguments":"{\\"p\\":"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
    'data: [DONE]\n',
  ])
  const events = await collect(parseOpenAiSse(openai))
  const toolEvents = events.filter((event) => event.type === 'tool')
  assert.deepEqual([...new Set(toolEvents.map((event) => event.index))], [2])
  const finish = events.at(-1)
  assert.equal(finish.kind, 'tool-calls')
})

test('T-9：arguments 以对象形式到达时序列化，而不是丢掉', async () => {
  const openai = textStream([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f","arguments":{"path":"a.txt"}}}]}}]}\n',
    'data: [DONE]\n',
  ])
  const tool = (await collect(parseOpenAiSse(openai))).find((event) => event.type === 'tool')
  assert.equal(tool.argumentsDelta, '{"path":"a.txt"}')
})

test('T-6：Trae 的 abort 保留超时语义（TIMEOUT），不再一律 ABORTED', async () => {
  const timeoutSignal = AbortSignal.abort(new DOMException('timed out', 'TimeoutError'))
  await assert.rejects(async () => {
    for await (const event of parseTraeStream(textStream(['']), timeoutSignal)) void event
  }, (error) => failureCodeOf(error) === 'TIMEOUT')
})

test('T-19：Trae 流内 1001 归 AUTH（可换号），不是 SERVER', async () => {
  const stream = textStream(['event: error\n', 'data: {"code":1001,"message":"登录失效"}\n', '\n'])
  await assert.rejects(async () => {
    for await (const event of parseTraeStream(stream)) void event
  }, (error) => failureCodeOf(error) === 'AUTH')
})

test('T-13：refresh 令牌的过期时间不会回落到 access token 的 JWT exp', () => {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
  const accessToken = `eyJhbGciOiJub25lIn0.${payload}.sig`
  const token = normalizeToken({ accessToken, refreshToken: 'r' })
  assert.ok(token.expiresAtMs > Date.now(), 'access token 的过期时间应来自 JWT')
  assert.equal(token.refreshExpiresAtMs, 0, 'refresh 过期时间缺省时应为 0（未知）')
})

test('T-21：浏览器登录两个阶段共用同一个绝对死线', async () => {
  await assert.rejects(
    pollAuthToken('workbuddy', 'state', { deadline: Date.now() - 1 }),
    /超时/,
  )
})

test('T-7：Windows 上登录文件候选优先使用 LOCALAPPDATA / APPDATA', { skip: process.platform !== 'win32' }, () => {
  const previous = { local: process.env.LOCALAPPDATA, roaming: process.env.APPDATA }
  process.env.LOCALAPPDATA = 'C:\\Users\\audit\\Redirected\\Local'
  process.env.APPDATA = 'C:\\Users\\audit\\Redirected\\Roaming'
  try {
    const candidates = authFileCandidates({ envAuthFile: 'DSH_AUDIT_TEST_AUTH_FILE', desktopFile: 'auth.json' })
    assert.ok(candidates[0].startsWith('C:\\Users\\audit\\Redirected\\Local'), candidates[0])
    assert.ok(candidates[1].startsWith('C:\\Users\\audit\\Redirected\\Roaming'), candidates[1])
  } finally {
    if (previous.local === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous.local
    if (previous.roaming === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previous.roaming
  }
})

// ── B-2：卸载回调可以早于 apply() 返回执行 ────────────────────────────

test('B-2：effect 立即执行 disposer 时 apply() 不抛 TDZ，且资源被释放', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-audit-r24-'))
  const previous = process.env.DSH_REVERSE_PROXY_DATA_DIR
  process.env.DSH_REVERSE_PROXY_DATA_DIR = dir
  // 六家全关：首轮刷新不会打上游，测试只关心生命周期。
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    version: 2,
    providers: Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, { enabled: false }])),
  }))

  let released = 0
  let registeredDisposers = 0
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    llm: { registerAdapter: () => () => { released += 1 } },
    // 模拟「插件注册后宿主立刻销毁」：effect 注册时同步执行 disposer。
    effect: (callback) => {
      const dispose = callback()
      registeredDisposers += 1
      dispose()
      return () => {}
    },
    inject: () => {},
    emit: () => {},
    get: () => undefined,
  }

  try {
    assert.doesNotThrow(() => apply(ctx, {}))
    assert.equal(registeredDisposers, 1)
    assert.equal(released, 1, 'adapter 必须被释放')
  } finally {
    if (previous === undefined) delete process.env.DSH_REVERSE_PROXY_DATA_DIR
    else process.env.DSH_REVERSE_PROXY_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
