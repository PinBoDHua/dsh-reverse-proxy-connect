import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Runtime, failureCodeOf, isProviderScopedFailure, parseOpenAiSse, qoderQueueFailure, resetHintOf, retryQueued } from '../lib/runtime.js'
import { EventLog } from '../lib/events.js'
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

test('空响应不再被当成成功：没有正文/思考/工具时抛 EMPTY_RESPONSE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-empty-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
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
      await assert.rejects(async () => {
        for await (const _event of opened.events) { /* 消费到终态 */ }
      }, (error) => error?.code === 'EMPTY_RESPONSE')
    } finally {
      runtime.flushCaches()
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('content_filter 终态带可路由的 failure，而不是空 error', async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n'))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  const events = []
  for await (const event of parseOpenAiSse(body)) events.push(event)
  const finish = events.find((event) => event.type === 'finish')
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.code, 'CONTENT_FILTER')
})

test('限额重置时间只从限额语境里提取：账号降级/模型下线/风控日期不能显示成「限额至」', () => {
  // 用户可见行为：卡片上的「限额至 …」必须是真正的限额重置时间；把账号降级、
  // 模型下线、风控解除的日期显示成限额时间会让人按错误时间等待或换号。
  assert.equal(
    resetHintOf('您的使用量已超出频率限制，将在 2026-10-19 15:33:04 UTC+8 重置', 'RATE_LIMIT'),
    '2026-10-19 15:33:04 UTC+8',
  )
  assert.equal(resetHintOf('当前账号类型暂不支持该模型，账号于 2026-10-18 09:00:00 完成降级', 'AUTH'), undefined)
  assert.equal(resetHintOf('模型 deepseek-v4.1-flash 将于 2026-12-01 00:00:00 下线', 'upstream-error'), undefined)
  assert.equal(resetHintOf('请求触发风控，账号已限制至 2026-10-20 08:30:00', 'upstream-error'), undefined)
  // 文案本身没有限额语义词、但错误 code 明确是额度类：仍然提取（上游文案可能只有时间）。
  assert.equal(resetHintOf('将在 2026-10-19 15:33:04 恢复', 'QUOTA'), '2026-10-19 15:33:04')
})

test('网络错误归到 TRANSPORT（DSH 会重试），而不是不重试的 upstream-error', () => {
  const network = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
  assert.equal(failureCodeOf(network), 'TRANSPORT')
  assert.equal(failureCodeOf(Object.assign(new Error('x'), { cause: { code: 'UND_ERR_SOCKET' } })), 'TRANSPORT')
  // 普通业务错误不能被误判成网络重试。
  const ordinary = Object.assign(new Error('bad request'), { status: 400 })
  assert.equal(failureCodeOf(ordinary), 'upstream-error')
})

test('Qoder 排队是 provider 级失败：不换号、不记账号冷却', () => {
  const failure = qoderQueueFailure(undefined, 61_000, 60_000)
  assert.equal(isProviderScopedFailure(failure), true)
  assert.equal(failureCodeOf(failure), 'RATE_LIMIT')
  assert.equal(failure.noFailover, true)
  assert.equal(failure.scope, 'provider')
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

test('账号 × 模型测试：429 限额要带 resetHint，并记进 modelTests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-model-test-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    '您的使用量已超出频率限制，将在 2026-10-19 15:33:04 UTC+8 重置，您也可以切换其他模型继续使用。',
    { status: 429, headers: { 'content-type': 'text/plain' } },
  )
  try {
    const settings = settingsWithAccounts()
    settings.accounts.workbuddy = [settings.accounts.workbuddy[0]]
    const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {} })
    try {
      runtime.catalogs.set('workbuddy::a', {
        models: [{ id: 'deepseek-v4.1-flash', name: 'Flash', contextWindow: 1000000, maxTokens: 64000, reasoningEfforts: [] }],
        fetchedAt: Date.now(),
        source: 'live',
      })
      const result = await runtime.testAccount('workbuddy', 'a', 'deepseek-v4.1-flash')
      assert.equal(result.ok, false)
      assert.equal(result.model, 'deepseek-v4.1-flash')
      assert.equal(result.code, 'RATE_LIMIT')
      assert.equal(result.resetHint, '2026-10-19 15:33:04 UTC+8')
      assert.equal(runtime.lastModelTestFor('workbuddy', 'a', 'deepseek-v4.1-flash').code, 'RATE_LIMIT')
      assert.equal(runtime.modelTestsFor('workbuddy', 'a')['deepseek-v4.1-flash'].model, 'deepseek-v4.1-flash')
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

test('Qoder 流中排队：重开只能拿「从现在起还剩多少」的预算，不能整份重新计', async () => {
  // 用户可见行为：高级里配的 `qoderQueueWaitMs` 是**整次请求**的排队预算。
  // 旧实现把「流阶段开始时还剩多少」原样当成新预算交给 reopen，而 #openQoderQueued
  // 的契约是「从现在起算」—— 于是每重开一次就多出一份完整预算，实际等待可以
  // 超过用户设置（却仍报告「超过本地 60 秒上限」）。
  const encoder = new TextEncoder()
  const queued = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ statusCodeValue: 200, body: '{}' })}\n\n`))
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ statusCodeValue: 403, body: JSON.stringify({ code: 10605, retryAfterSeconds: 0.5, isQueued: true }) })}\n\n`))
      controller.close()
    },
  })
  const ok = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) })}\n\n`))
      controller.close()
    },
  })
  const budgets = []
  const startedAt = Date.now() - 20_000
  const events = []
  for await (const event of retryQueued(
    (budget) => {
      budgets.push(budget)
      return Promise.resolve({ body: ok })
    },
    queued,
    AbortSignal.timeout(10_000),
    { startedAt, budgetMs: 60_000 },
  )) events.push(event)
  assert.equal(budgets.length, 1, '应该重开一次')
  assert.ok(
    budgets[0] <= 41_000 && budgets[0] >= 39_000,
    `reopen 收到的预算应为「从现在起还剩约 40 秒」，实际 ${String(budgets[0])}`,
  )
  assert.equal(events.filter((event) => event.type === 'text').map((event) => event.text).join(''), 'ok')
})

test('Qoder 流中排队：整次请求的预算用尽后不再重开，结论是 RATE_LIMIT', async () => {
  const encoder = new TextEncoder()
  const queued = () => new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ statusCodeValue: 403, body: JSON.stringify({ code: 10605, isQueued: true, retryAfterSeconds: 0.5 }) })}\n\n`))
      controller.close()
    },
  })
  let reopened = 0
  await assert.rejects(async () => {
    for await (const _event of retryQueued(
      () => {
        reopened += 1
        return Promise.resolve({ body: queued() })
      },
      queued(),
      AbortSignal.timeout(10_000),
      { startedAt: Date.now() - 61_000, budgetMs: 60_000 },
    )) {
      /* 只关心抛错 */
    }
  }, (error) => failureCodeOf(error) === 'RATE_LIMIT')
  assert.equal(reopened, 0, '预算已用尽时不该再打上游')
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

test('额度降噪：未配置（none）不记事件，真失败才 warn，恢复只在成功时记', async () => {
  // 用户可见行为：事件账本里不再每天出现「额度读取失败：尚未保存 PAT」这种
  // 预期内 warn；真正的上游失败与恢复仍然要能看见。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-credits-noise-'))
  const originalFetch = globalThis.fetch
  const events = new EventLog({})
  const settings = defaults()
  settings.accounts.qoder = [{ id: 'a', label: 'PAT 账号', enabled: true, pat: '' }]
  settings.activeAccount.qoder = 'a'
  const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {}, events })
  try {
    // 1) 未配置 PAT：state none 属于已知状态，不应该进账本。
    globalThis.fetch = async () => {
      throw new Error('未配置账号不应该请求上游')
    }
    const none = await runtime.refreshCredits('qoder', { force: true })
    assert.equal(none.state, 'none')
    assert.equal(events.list({ type: 'credits' }).length, 0, '未配置（none）不该产生事件')

    // 2) 配置了 PAT 但上游 500：这是真失败，必须记 warn。
    settings.accounts.qoder[0].pat = 'pt-test'
    runtime.identities.set('qoder::a', {
      pat: 'pt-test',
      region: 'china',
      userID: 'u1',
      authToken: 'job-token',
      name: 'tester',
      email: 'a@b.c',
      machineID: 'm',
      expiresAtMs: Date.now() + 3600_000,
    })
    globalThis.fetch = async () => new Response('boom', { status: 500 })
    const failed = await runtime.refreshCredits('qoder', { force: true })
    // 失败时保留上一次成功值（这里没有），并把原因放进 `error`，而不是伪造数字。
    assert.ok(typeof failed.error === 'string' && failed.error !== '', '读取失败必须带原因')
    let creditEvents = events.list({ type: 'credits' })
    assert.equal(creditEvents.length, 1)
    assert.equal(creditEvents[0].level, 'warn')
    assert.match(creditEvents[0].message, /额度读取失败/)

    // 3) 上游恢复：state ok 且此前有 error，才记「已恢复」。
    globalThis.fetch = async (url) => {
      const href = String(url)
      if (href.includes('/api/v2/quota/usage')) return Response.json({ userQuota: { total: 100, used: 10, remaining: 90 } })
      if (href.includes('/api/v2/user/plan')) return Response.json({ plan_tier_name: 'Pro', is_paid_plan: true })
      return Response.json({ nextResetAt: Date.now() + 86_400_000 })
    }
    const recovered = await runtime.refreshCredits('qoder', { force: true })
    assert.equal(recovered.state, 'ok')
    creditEvents = events.list({ type: 'credits' })
    assert.equal(creditEvents.length, 2)
    assert.match(creditEvents[0].message, /额度读取已恢复/)
    assert.equal(creditEvents[0].level, 'info')
    assert.match(creditEvents[1].message, /额度读取失败/)
    assert.equal(creditEvents[1].level, 'warn')
  } finally {
    runtime.flushCaches()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})
