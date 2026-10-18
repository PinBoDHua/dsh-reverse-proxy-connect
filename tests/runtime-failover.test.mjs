import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Runtime } from '../lib/runtime.js'
import { Stats } from '../lib/stats.js'
import { defaults } from '../lib/settings.js'
import { DeadlineError, openDeadline, sleep } from '../lib/timeout.js'

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

test('测试/探测的死线只覆盖「等响应头」，且长于 Qoder 首包排队预算', async () => {
  // 实测事故（1.8.0）：`node lib/bin.js test` 里 qoder-global 跑了 45013ms
  // 后报 `ABORTED` + `aborted` —— 什么都说明不了。两个计时器都设成 45 秒，
  // 看门狗先到，把「免费模型正在排队」那句解释抢走了。
  //
  // 修这条时又发现第二层：死线原来一路套着事件流，而 Qoder 的排队发生在
  // **读流阶段**（retryQueued 有自己的 qoderQueueWaitMs 预算）。死线不 dispose
  // 的话，排队解释永远轮不到，用户看到的还是「60 秒内没有给出响应头」。
  //
  // 这里验的是源码里的两条硬约束（纯文本断言，不需要真等一分钟）：
  const runtimeSource = readFileSync(new URL('../lib/runtime.js', import.meta.url), 'utf8')
  const deadline = Number(/const TEST_DEADLINE_MS = (\d[\d_]*)/.exec(runtimeSource)?.[1]?.replaceAll('_', ''))
  const queueBudget = Number(/const QODER_OPEN_QUEUE_BUDGET_MS = (\d[\d_]*)/.exec(runtimeSource)?.[1]?.replaceAll('_', ''))
  assert.ok(Number.isFinite(deadline) && deadline > 0, 'TEST_DEADLINE_MS 必须是数字')
  assert.ok(Number.isFinite(queueBudget) && queueBudget > 0, 'QODER_OPEN_QUEUE_BUDGET_MS 必须是数字')
  assert.ok(
    deadline > queueBudget,
    `测试/探测死线（${String(deadline)}ms）必须大于 Qoder 首包排队预算（${String(queueBudget)}ms），否则排队解释会被 abort 覆盖`,
  )
  assert.ok(deadline - queueBudget >= 10_000, `两者至少留 10 秒余量，实际只差 ${String(deadline - queueBudget)}ms`)

  // 测试账号与能力探测都必须：用 openDeadline(TEST_DEADLINE_MS) 建死线，
  // 并在拿到 opened 之后立刻 dispose —— 否则排队预算形同虚设。
  assert.equal(
    (runtimeSource.match(/const deadline = openDeadline\(TEST_DEADLINE_MS\)/g) ?? []).length,
    2,
    '测试账号与能力探测都必须用 openDeadline(TEST_DEADLINE_MS)',
  )
  assert.equal(
    (runtimeSource.match(/deadline\.dispose\(\)\n(?:.|\n){0,80}?for await \(const event of opened\.events\)/g) ?? []).length,
    2,
    '拿到 opened 之后必须立刻 dispose：死线不能一路套着事件流',
  )
  // 两处的 finally 都要 dispose，避免中途抛错时把计时器留着。
  assert.equal(
    (runtimeSource.match(/deadline\.dispose\(\)/g) ?? []).length >= 4,
    true,
    'testAccount / #probeOne 的 try 与 finally 都要 dispose',
  )
  // 不该再有「用 setTimeout 直接 abort 一个裸 controller」的死线：那种 reason
  // 会退化成 AbortError，与用户取消同形。（排队预算看门狗是唯一允许的例外，
  // 它 abort 的是自己的 budget controller，且带 QoderQueueBudgetError。）
  assert.ok(
    !/const timer = setTimeout\(\(\) => controller\.abort\(\)/.test(runtimeSource),
    '不该再有裸 abort() 的死线（reason 会退化成 AbortError）',
  )
})

test('DeadlineError 带 timeout 语义，且与用户取消（AbortError）可区分', () => {
  const deadline = openDeadline(5_000)
  deadline.abort(new DeadlineError(5_000, '响应头'))
  const reason = deadline.signal.reason
  assert.equal(reason.name, 'DeadlineError')
  // 上层靠 kind/code 判超时；用户取消走 CancelledError，它带 code ABORTED。
  assert.equal(reason.kind, 'timeout')
  assert.equal(reason.code, 'timeout')
  assert.match(reason.message, /5 秒/)
  assert.match(reason.message, /响应头/)
  deadline.dispose()
  // 与普通取消不是同一个形状。
  const cancelled = new AbortController()
  cancelled.abort()
  assert.equal(cancelled.signal.reason.name, 'AbortError', '默认 abort() 的 reason 就是 AbortError —— 这正是要避开的那一种')
})

test('sleep() 保留 signal 的 reason，不把「测试超时」抹成「用户取消」', async () => {
  // 第二层根因：看门狗 abort 之后，`await sleep(...)` 抛的是 CancelledError，
  // 于是外层 catch 只看到「取消」，60 秒的 DeadlineError 反而被吞掉。
  const controller = new AbortController()
  const pending = sleep(30_000, controller.signal)
  controller.abort(new DeadlineError(1_000, '响应头'))
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'DeadlineError', 'sleep 必须上抛 signal.reason，而不是包成 CancelledError')
    assert.equal(error.code, 'timeout')
    return true
  })

  // 宿主取消（不带 reason）仍然是 CancelledError。
  const cancelled = new AbortController()
  const pending2 = sleep(30_000, cancelled.signal)
  cancelled.abort()
  await assert.rejects(pending2, (error) => {
    assert.equal(error.name, 'AbortError')
    assert.equal(error.code, 'ABORTED')
    return true
  })
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

test('Qoder 排队：首轮只发过保活帧（heartbeat）时仍然允许重开', async () => {
  // 1.5.0 引入 heartbeat 后，retryQueued 曾把「任意事件」都当成已输出内容，
  // 于是「上游先发了几帧保活、随后以排队拒绝」直接失败、不再重开。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-requeue-'))
  const originalFetch = globalThis.fetch
  const encoder = new TextEncoder()
  let attempt = 0
  globalThis.fetch = async () => {
    attempt += 1
    const frames = attempt === 1
      ? [
          `data: ${JSON.stringify({ statusCodeValue: 200, body: '{}' })}\n\n`,
          `data: ${JSON.stringify({ statusCodeValue: 403, body: JSON.stringify({ code: 10605, retryAfterSeconds: 1, isQueued: true }) })}\n\n`,
        ]
      : [
          `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: 'ok-from-retry' }, finish_reason: 'stop' }] }) })}\n\n`,
        ]
    const body = new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const settings = defaults()
    settings.accounts['qoder-global'] = [{ id: 'a', label: 'PAT', enabled: true, pat: 'pt-test' }]
    settings.activeAccount['qoder-global'] = 'a'
    settings.advanced.qoderQueueWaitMs = 30_000
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    runtime.catalogs.set('qoder-global::a', {
      models: [{ id: 'qfmodel', name: 'Qwen3-Flash', contextWindow: 200_000, maxTokens: 32_768, reasoningEfforts: [], source: 'system' }],
      fetchedAt: Date.now(),
      source: 'live',
    })
    runtime.identities.set('qoder-global::a', {
      pat: 'pt-test', region: 'global', userID: 'u1', authToken: 'job-token', name: 'tester',
      email: 'a@b.c', machineID: 'm', expiresAtMs: Date.now() + 3600_000,
    })
    try {
      const opened = await runtime.openStream('qoder-global', {
        model: 'qfmodel',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: AbortSignal.timeout(20_000),
      })
      const events = []
      for await (const event of opened.events) events.push(event)
      assert.equal(attempt, 2, '只发过保活帧时必须重开一次')
      assert.equal(events.filter((event) => event.type === 'text').map((event) => event.text).join(''), 'ok-from-retry')
      assert.equal(events.at(-1).kind, 'stop')
    } finally {
      runtime.flushCaches()
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('正常完成：宿主收到 finish 后立即停止消费，统计仍记 stop 而不是中断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-finish-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => sseResponse('done')
  try {
    const settings = settingsWithAccounts()
    settings.accounts.workbuddy = [settings.accounts.workbuddy[0]]
    settings.activeAccount.workbuddy = 'a'
    const stats = new Stats({ filePath: join(dir, 'stats.json'), enabled: true })
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {}, stats })
    try {
      const opened = await runtime.openStream('workbuddy', {
        model: 'hy3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: AbortSignal.timeout(5000),
      })
      let kind
      for await (const event of opened.events) {
        // 模拟宿主：拿到终态就立刻结束迭代，不再向生成器要下一个事件。
        if (event.type === 'finish') {
          kind = event.kind
          break
        }
      }
      assert.equal(kind, 'stop')
      const recent = stats.snapshot().recent[0]
      assert.equal(recent.provider, 'workbuddy')
      assert.equal(recent.kind, 'stop', '正常结束不能被记成 incomplete')
      assert.ok(recent.totalTokens > 0)
    } finally {
      runtime.flushCaches()
      stats.stop()
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})
