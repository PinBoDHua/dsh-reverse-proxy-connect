#!/usr/bin/env node
/**
 * 命令行排障：不经过 GUI 也能看清「凭证读到了没 / 目录拉到没 / 模型能不能真出字」。
 *
 *   node lib/bin.js status                  # 六个 provider 的登录、目录、额度与健康状态
 *   node lib/bin.js doctor                  # 逐项体检（退出码 0 = 没有致命问题）
 *   node lib/bin.js models [provider]       # 列目录里的模型
 *   node lib/bin.js credits [provider]      # 列积分与套餐包明细
 *   node lib/bin.js usage [provider]        # 今日/累计/当前会话/每日历史与最近请求
 *   node lib/bin.js probe [provider]        # 重跑能力探测
 *   node lib/bin.js test [provider] [accountId] # 真发一次 1-token 请求验证账号
 *   node lib/bin.js checkin [provider]      # 立即签到
 *   node lib/bin.js login <provider>        # 浏览器登录并写入账号池
 *   node lib/bin.js ask <provider> <model> "提示词"   # 真发一次请求，打印流
 *
 * 这些命令只读本地凭证；除 `login` / `checkin` 外不修改设置，也不会上报任何东西。
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { accountsFor, activeAccountFor, newAccountId } from './accounts.js'
import { formatDurationZh } from './format.js'
import { isQoderFreePlan } from './quota.js'
import { Runtime } from './runtime.js'
import { SettingsStore, advancedOptions, providerOptions } from './settings.js'
import { Stats, statsPathOf } from './stats.js'
import { startBrowserLogin } from './workbuddy/browser-login.js'
import { DATA_DIR_ENV, DATA_DIR_NAME, PROVIDER_IDS } from './protocol.js'

/** 解析数据目录，与宿主半边保持同一套规则。 */
function dataDir() {
  const override = process.env[DATA_DIR_ENV]
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const profile = process.env.DSH_PROFILE_DIR
  if (typeof profile === 'string' && profile !== '') return join(profile, DATA_DIR_NAME)
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  return join(home, DATA_DIR_NAME)
}

/** 造一个与宿主同构的 runtime。 */
function makeRuntime() {
  const dir = dataDir()
  const store = new SettingsStore(join(dir, 'settings.json'))
  const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => advancedOptions(store.get()).stats })
  return {
    dir,
    store,
    stats,
    runtime: new Runtime({
      settings: () => store.get(),
      dataDir: dir,
      logger: console,
      stats,
      // CLI 里也把换号结果写回设置：下一次命令才会用同一个账号，而不是
      // 每次重跑都先撞一次已经失效的那一个。
      onAccountSwitch: (provider, accountId) => store.patch({ activeAccount: { [provider]: accountId } }),
    }),
  }
}

/**
 * 一段人话的额度描述。
 * @param credits - `runtime.creditsFor()` 的返回值。
 * @param provider - provider id（用于识别 Qoder Free）。
 * @returns 描述。
 */
function describeCredits(credits, provider) {
  if (credits === undefined) return '未读取'
  // 读不到时**必须带原因**：`none` 是「这个账号根本没有可读的额度端点 / 还没配
  // 凭证」，`error` 是「有端点但这次失败」。只写「未读取」会让用户以为插件没去读。
  // 注意原因字段在状态里是 `error`（`credits.message` 只有上游原始响应会带）。
  const reason = credits.error ?? credits.message
  if (credits.state === 'none') return reason === undefined ? '未读取' : `未读取（${reason}）`
  if (credits.state === 'error') return `读取失败（${reason ?? '未知原因'}）`
  const number = (value) => (typeof value === 'number' ? String(Math.round(value * 10) / 10) : '—')
  let text = ''
  if (credits.unlimited === true) text = '不限量'
  else text = `${number(credits.remain)}${credits.total > 0 ? ` / ${number(credits.total)}` : ''} ${credits.unit ?? 'credits'}`
  if (credits.planName !== undefined) text += `  套餐 ${credits.planName}`
  if (credits.exceeded === true) {
    text += isQoderFreePlan(provider, credits)
      ? '  [Free 套餐：付费额度为 0，免费模型仍可用]'
      : '  [额度已用尽]'
  }
  if (credits.resetAtMs > 0) text += `  最近到期 ${new Date(credits.resetAtMs).toLocaleString()}`
  // 「读不到，显示上次结果」与「真的是这个数」必须能区分。
  if (credits.stale === true) text += '  [上次结果，读取失败时保留]'
  if (typeof credits.error === 'string' && credits.error !== '') text += `  [${credits.error}]`
  if (credits.trend !== undefined && credits.trend.sampleCount > 0) {
    const trend = credits.trend
    const eta = formatDurationZh(trend.etaMs)
    text += `  今日消耗 ${String(trend.spentToday)} / 近7天 ${String(trend.spent7d)} / 约 ${String(trend.burnPerHour ?? '—')}/h / 预计可用 ${eta}`
  }
  return text
}

/**
 * 解析命令要处理的 provider，并跳过设置里已关闭的那些。
 *
 * CLI 与 GUI 必须共用同一套「关闭」语义：否则用户关了 provider，命令行还会
 * 去读额度、签到、发 1-token 测试请求。
 */
function enabledTargets(store, provider) {
  const requested = provider === undefined ? [...PROVIDER_IDS] : [provider]
  const targets = []
  for (const target of requested) {
    if (!PROVIDER_IDS.includes(target)) {
      console.log(`[${String(target)}] 未知 provider，跳过`)
      continue
    }
    if (!providerOptions(store.get(), target).enabled) {
      console.log(`[${target}] 已在设置里关闭，跳过`)
      continue
    }
    targets.push(target)
  }
  return targets
}

/** 健康状态的中文名。 */
function healthLabel(health) {
  switch (health?.state) {
    case 'ok':
      return '正常'
    case 'degraded':
      return '降级'
    case 'down':
      return '不可用'
    default:
      return '无记录'
  }
}

/** 额度/用量数字。 */
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : '0'
}

/** 状态。 */
async function cmdStatus() {
  const { dir, runtime, stats } = makeRuntime()
  console.log(`数据目录: ${dir}`)
  const results = await runtime.refreshAll({ force: true })
  await runtime.refreshAllCredits({ force: true })
  for (const result of results) {
    const models = runtime.modelsFor(result.provider)
    const credits = runtime.creditsFor(result.provider)
    const usage = stats.providerSnapshot(result.provider)
    console.log(`\n[${result.provider}]  ${result.status}  健康 ${healthLabel(usage.health)}`)
    if (result.message !== undefined) console.log(`  说明: ${result.message}`)
    if (result.reason !== undefined) console.log(`  原因: ${result.reason}`)
    console.log(`  模型: ${String(models.length)}  (${runtime.statusFor(result.provider).catalogSource})`)
    for (const model of models.slice(0, 6)) {
      console.log(`    - ${model.id}  ${model.name}  ctx=${String(model.contextWindow)} out=${String(model.maxTokens)}${model.credits === undefined ? '' : ` ${model.credits}`}`)
    }
    if (models.length > 6) console.log(`    …还有 ${String(models.length - 6)} 个`)
    console.log(`  积分: ${describeCredits(credits, result.provider)}`)
    console.log(`  今日: ${number(usage.today.requests)} 次请求 / ${number(usage.today.totalTokens)} tokens`)
  }
  stats.stop()
}

/** 单独列额度。 */
async function cmdCredits(provider) {
  const { runtime, stats, store } = makeRuntime()
  await runtime.refreshAll()
  const targets = enabledTargets(store, provider)
  for (const target of targets) {
    const credits = await runtime.refreshCredits(target, { force: true })
    console.log(`\n[${target}] ${describeCredits(credits, target)}`)
    for (const item of credits.items ?? []) {
      const remain = typeof item.remain === 'number' ? Math.round(item.remain * 10) / 10 : '—'
      const total = typeof item.total === 'number' ? Math.round(item.total * 10) / 10 : '—'
      const end = item.endAtMs === undefined ? '' : `  至 ${new Date(item.endAtMs).toLocaleDateString()}`
      const expired = item.expired === true ? '  [已耗尽]' : ''
      console.log(`    - ${item.name}  ${remain} / ${total}${expired}${end}`)
    }
  }
  stats.stop()
}

/** 列模型。 */
async function cmdModels(provider) {
  const { runtime, stats } = makeRuntime()
  await runtime.refreshAll()
  const targets = provider === undefined ? PROVIDER_IDS : [provider]
  for (const target of targets) {
    for (const model of runtime.modelsFor(target)) {
      console.log(`${target}\t${model.id}\t${model.name}\tctx=${String(model.contextWindow)}\tout=${String(model.maxTokens)}\t${(model.reasoningEfforts ?? []).join('|')}`)
    }
  }
  stats.stop()
}

/** 用量。 */
async function cmdUsage(provider) {
  const { stats } = makeRuntime()
  const snapshot = stats.snapshot()
  const targets = provider === undefined ? PROVIDER_IDS : [provider]
  console.log(`统计起点: ${new Date(snapshot.since).toLocaleString()}`)
  for (const target of targets) {
    const totals = snapshot.providers[target] ?? {}
    const today = snapshot.providerToday[target] ?? {}
    console.log(
      `\n[${target}] 健康 ${healthLabel(snapshot.health[target])}  累计 ${number(totals.requests)} 次（成功 ${number(totals.ok)} / 失败 ${number(totals.failed)}）  ${number(totals.totalTokens)} tokens  平均 ${number(totals.avgDurationMs)}ms`,
    )
    console.log(`  今日 ${number(today.requests)} 次 / ${number(today.totalTokens)} tokens`)
    const providerSession = snapshot.providerCurrentSession !== undefined
      ? snapshot.providerCurrentSession[target]
      : snapshot.currentSession
    if (providerSession !== undefined) {
      console.log(`  当前会话 ${number(providerSession.requests)} 次 / ${number(providerSession.totalTokens)} tokens`)
    }
    const daily = Array.isArray(snapshot.providerDaily?.[target])
      ? snapshot.providerDaily[target].slice(-7)
      : Array.isArray(snapshot.daily) ? snapshot.daily.slice(-7) : []
    if (daily.length > 0) {
      console.log(`  最近 ${String(daily.length)} 天：${daily.map((day) => `${day.date.slice(5)}=${number(day.requests)}次/${number(day.totalTokens)}tok`).join('  ')}`)
    }
    const recent = snapshot.recent.filter((entry) => entry.provider === target).slice(0, 5)
    for (const entry of recent) {
      const at = new Date(entry.at).toLocaleString()
      console.log(`    ${at}  ${entry.model}  ${entry.kind}${entry.code === undefined ? '' : ` (${entry.code})`}  ${number(entry.durationMs)}ms  ${number(entry.totalTokens)} tokens`)
    }
  }
  stats.stop()
}

/** 能力探测。 */
async function cmdProbe(provider) {
  const { runtime, stats, store } = makeRuntime()
  await runtime.refreshAll({ force: true })
  const targets = enabledTargets(store, provider)
  for (const target of targets) {
    const outcome = await runtime.probeProvider(target)
    console.log(`[${target}] 探测 ${String(outcome.probed)} 个，账号不支持 ${String(outcome.unavailable.length)} 个`)
    if (outcome.unavailable.length > 0) console.log(`  ${outcome.unavailable.join(', ')}`)
  }
  stats.stop()
}

/** 真发一次 1-token 请求，验证账号能否使用。 */
async function cmdTest(provider, accountId) {
  const { runtime, stats, store } = makeRuntime()
  const targets = enabledTargets(store, provider)
  let failed = false
  await runtime.refreshAll({ force: true })
  for (const target of targets) {
    const accounts = accountsFor(target, store.get())
    const wanted = accountId === undefined
      ? [activeAccountFor(target, store.get())]
      : accounts.filter((account) => account.id === accountId)
    if (wanted.length === 0 || wanted[0] === undefined) {
      console.log(`[${target}] 账号 ${String(accountId ?? '')} 不存在`)
      failed = true
      continue
    }
    for (const account of wanted) {
      if (account === undefined) {
        console.log(`[${target}] 账号不存在`)
        failed = true
        continue
      }
      const result = await runtime.testAccount(target, account.id)
      console.log(`[${target}] ${account.label}  ${result.ok ? '✓ 正常' : `✗ ${result.code ?? 'FAILED'}`}  ${String(result.latencyMs)}ms  ${result.error ?? ''}`)
      if (!result.ok) failed = true
    }
  }
  stats.stop()
  if (failed) process.exitCode = 1
}

/** 签到。 */
async function cmdCheckin(provider) {
  const { runtime, stats, store } = makeRuntime()
  await runtime.refreshAll()
  const targets = enabledTargets(store, provider)
  for (const target of targets) {
    const outcome = await runtime.runCheckin(target)
    console.log(`[${target}] 领取 ${String(outcome.claimed)} 个账号，共 ${String(outcome.credit)} 分`)
    for (const item of outcome.outcomes) {
      console.log(`    - ${item.label}: ${item.kind}${item.message === undefined ? '' : `  ${item.message}`}`)
    }
  }
  stats.stop()
}

/** 浏览器登录并写入账号池。 */
async function cmdLogin(provider) {
  if (provider === 'trae' || provider === 'trae-global') {
    console.error('Trae 不需要单独登录：先在 Trae 客户端里登录一次，插件会直接读取本机登录态。')
    process.exit(2)
  }
  if (provider !== 'workbuddy' && provider !== 'workbuddy-ai') {
    console.error('login 只支持 workbuddy / workbuddy-ai；Qoder 请把 PAT 写进设置，Trae 请先在客户端登录。')
    process.exit(2)
  }
  const { store, stats } = makeRuntime()
  const variantId = provider === 'workbuddy' ? 'workbuddy' : 'workbuddy-ai'
  const controller = startBrowserLogin({
    variantId,
    spawn,
    onUpdate: (patch) => {
      if (patch.message !== undefined) console.log(patch.message)
      if (patch.authUrl !== undefined && patch.opened === false) console.log(`登录地址：${patch.authUrl}`)
    },
  })
  const { token, account, label } = await controller.result
  const list = accountsFor(provider, store.get()).map((item) => ({
    id: item.id,
    label: item.label,
    enabled: item.enabled !== false,
    ...(item.authFile === undefined || item.authFile === '' ? {} : { authFile: item.authFile }),
    ...(item.token === undefined ? {} : { token: item.token }),
  }))
  const existing = list.find((item) => item.token !== undefined && account.uid !== '' && item.token.uid === account.uid)
  const merged = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAtMs: token.expiresAtMs,
    refreshExpiresAtMs: token.refreshExpiresAtMs,
    domain: token.domain,
    uid: account.uid,
    enterpriseId: account.enterpriseId,
  }
  if (existing !== undefined) {
    existing.token = merged
    existing.label = label
    store.patch({ accounts: { [provider]: list }, activeAccount: { [provider]: existing.id } })
  } else {
    const target = { id: newAccountId(list), label, enabled: true, token: merged }
    store.patch({ accounts: { [provider]: [...list, target] }, activeAccount: { [provider]: target.id } })
  }
  console.log(`已写入账号「${label}」（${provider}）。`)
  stats.stop()
}

/** 重置统计。 */
async function cmdResetStats() {
  const { stats } = makeRuntime()
  stats.reset()
  console.log('用量统计已清空。')
}

/** 体检。 */
async function cmdDoctor(strict) {
  const { dir, runtime, stats, store } = makeRuntime()
  const problems = []
  const check = (ok, label, detail) => {
    console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : `  ${detail}`}`)
    if (!ok) problems.push(label)
  }

  const [major, minor] = process.versions.node.split('.').map((part) => Number(part))
  check(major > 22 || (major === 22 && minor >= 19), 'Node 版本', `${process.versions.node}（需要 ^22.19 或 >=24）`)
  check(store.get().version === 2, '设置格式', `v${String(store.get().version)}（期望 v2，旧版本会由 normalize 自动升级）`)
  check(typeof dir === 'string' && dir !== '', '数据目录', dir)

  const settings = store.get()
  const advanced = advancedOptions(settings)
  console.log(`· 刷新间隔：目录 ${String(Math.round(advanced.catalogRefreshMs / 1000))}s / 额度 ${String(Math.round(advanced.creditsRefreshMs / 1000))}s`)
  console.log(`· 流空闲超时：${String(Math.round(advanced.idleTimeoutMs / 1000))}s`)

  const results = await runtime.refreshAll({ force: true })
  await runtime.refreshAllCredits({ force: true })
  for (const result of results) {
    if (!providerOptions(settings, result.provider).enabled) {
      console.log(`· ${result.provider} 已关闭，跳过检查`)
      continue
    }
    const account = activeAccountFor(result.provider, settings)
    const credential = await runtime.describeCredential(result.provider, account, settings)
    const health = stats.healthFor(result.provider)
    const models = runtime.modelsFor(result.provider)
    check(credential.status === 'signed-in', `${result.provider} 登录`, credential.status === 'signed-in' ? `${credential.source}${credential.email === undefined ? '' : ` / ${credential.email}`}` : `${credential.reason ?? ''} ${credential.message ?? ''}`)
    check(models.length > 0, `${result.provider} 模型目录`, `${String(models.length)} 个，来源 ${runtime.statusFor(result.provider).catalogSource}`)
    check(health.state !== 'down', `${result.provider} 健康`, healthLabel(health))
    console.log(`· ${result.provider} 额度：${describeCredits(runtime.creditsFor(result.provider), result.provider)}`)
  }

  console.log('')
  if (problems.length === 0) {
    console.log('体检通过：没有发现需要处理的问题。')
    stats.stop()
    return
  }
  console.log(`发现 ${String(problems.length)} 个问题：${problems.join('，')}`)
  stats.stop()
  if (strict === true) process.exit(1)
}

/** 真发一次请求。 */
async function cmdAsk(provider, modelId, prompt) {
  const { runtime, stats } = makeRuntime()
  await runtime.refreshAll({ force: true })
  const model = await runtime.resolveModel(provider, modelId)
  if (model === undefined) {
    console.error(`provider ${provider} 下没有模型 ${modelId}；可用：${runtime.modelsFor(provider).map((entry) => entry.id).join(', ')}`)
    stats.stop()
    process.exit(2)
  }
  console.log(`→ ${provider}/${modelId}  ${model.name}`)
  // 思考流默认不往终端写：它和数据流交错时会毁掉可读性（尤其被 2>&1 合并时）。
  // 需要看就设 ASK_SHOW_REASONING=1。
  const showReasoning = process.env.ASK_SHOW_REASONING === '1'
  const opened = await runtime.openStream(provider, {
    model: modelId,
    // 单档位模型（如 glm-5.1）必须显式带 effort，否则上游 400；这里复刻运行时的判定。
    reasoningEffort: Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length === 1 ? model.reasoningEfforts[0] : undefined,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    signal: AbortSignal.timeout(180_000),
  })
  let text = ''
  let reasoningChars = 0
  for await (const event of opened.events) {
    if (event.type === 'text') {
      text += event.text
      process.stdout.write(event.text)
    } else if (event.type === 'reasoning') {
      reasoningChars += event.text.length
      if (showReasoning) process.stderr.write(event.text)
    } else if (event.type === 'tool') {
      process.stdout.write(`\n[tool ${event.name}] ${event.argumentsDelta}\n`)
    } else if (event.type === 'usage') {
      console.log(`\n[usage] ${JSON.stringify(event.usage)}`)
    } else if (event.type === 'finish') {
      console.log(`[finish] ${event.kind}`)
    }
  }
  if (reasoningChars > 0) console.log(`[think] ${String(reasoningChars)} 字（设 ASK_SHOW_REASONING=1 可查看）`)
  if (text === '') console.error('(没有产出文本)')
  stats.stop()
}

const [command, ...rest] = process.argv.slice(2)
try {
  if (command === 'status' || command === undefined) await cmdStatus()
  else if (command === 'doctor') await cmdDoctor(rest.includes('--strict'))
  else if (command === 'models') await cmdModels(rest[0])
  else if (command === 'credits') await cmdCredits(rest[0])
  else if (command === 'usage') await cmdUsage(rest[0])
  else if (command === 'probe') await cmdProbe(rest[0])
  else if (command === 'test') await cmdTest(rest[0], rest[1])
  else if (command === 'checkin') await cmdCheckin(rest[0])
  else if (command === 'login') await cmdLogin(rest[0])
  else if (command === 'stats-reset') await cmdResetStats()
  else if (command === 'ask') {
    const [provider, modelId, ...words] = rest
    if (provider === undefined || modelId === undefined || words.length === 0) {
      console.error('用法: node lib/bin.js ask <provider> <model> <prompt...>')
      process.exit(2)
    }
    await cmdAsk(provider, modelId, words.join(' '))
  } else {
    console.error(`未知命令 ${String(command)}；可用：status / doctor / models / credits / usage / probe / test / checkin / login / stats-reset / ask`)
    process.exit(2)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
