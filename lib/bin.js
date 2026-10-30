#!/usr/bin/env node
/**
 * 命令行排障：不经过 GUI 也能看清「凭证读到了没 / 目录拉到没 / 模型能不能真出字」。
 *
 *   node lib/bin.js status                  # 六个 provider 的登录、目录、额度与健康状态
 *   node lib/bin.js doctor [--strict] [--quiet]  # 逐项体检；--quiet 只输出问题项
 *   node lib/bin.js models [provider]       # 列目录里的模型
 *   node lib/bin.js credits [provider]      # 列积分与套餐包明细
 *   node lib/bin.js usage [provider]        # 今日/累计/当前会话/每日历史与最近请求
 *   node lib/bin.js events [--limit N] [--type T] [--json]  # 最近事件（换号/续期/降级/签到）
 *   node lib/bin.js probe [provider]        # 重跑能力探测
 *   node lib/bin.js test [provider] [accountId] [model] [--deep]  # 真发一次请求验证账号/模型限额
 *                                                          # --deep：按真实对话请求的形状发（带系统提示词与工具表）
 *   node lib/bin.js checkin [provider]      # 立即签到
 *   node lib/bin.js login <provider>        # 浏览器登录并写入账号池
 *   node lib/bin.js ask <provider> <model> "提示词"   # 真发一次请求，打印流
 *
 * 这些命令只读本地凭证；除 `login` / `checkin` 外不修改设置，也不会上报任何东西。
 */

import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { accountsFor, activeAccountFor, applyCredentialRefresh, applyLoginAccount, isUnconfiguredCredential } from './accounts.js'
import { EventLog, eventsPathOf } from './events.js'
import { formatDateOnly, formatDateTime, formatDurationZh } from './format.js'
import { isQoderFreePlan } from './quota.js'
import { resolveDataDir, resolveProfileDir } from './profile.js'
import { Runtime } from './runtime.js'
import { SettingsStore, advancedOptions, providerOptions } from './settings.js'
import { Stats, statsPathOf } from './stats.js'
import { startBrowserLogin } from './workbuddy/browser-login.js'
import { PROVIDER_IDS } from './protocol.js'

/** 解析数据目录，与宿主半边共用同一套 profile 规则。 */
function dataDir() {
  return resolveDataDir(process.env)
}

/** 当前 profile（找不到时给出可操作的错误）。 */
function profileDir() {
  try {
    return resolveProfileDir(process.env)
  } catch {
    return undefined
  }
}

/** 造一个与宿主同构的 runtime。 */
function makeRuntime() {
  const dir = dataDir()
  const store = new SettingsStore(join(dir, 'settings.json'))
  const stats = new Stats({ filePath: statsPathOf(dir), enabled: () => advancedOptions(store.get()).stats })
  const runtime = new Runtime({
    settings: () => store.get(),
    dataDir: dir,
    logger: console,
    stats,
    // CLI 里也把换号结果写回设置：下一次命令才会用同一个账号，而不是
    // 每次重跑都先撞一次已经失效的那一个。
    onAccountSwitch: (provider, accountId) => store.patch({ activeAccount: { [provider]: accountId } }),
    // 续期结果同样必须写回：否则轮换后的 refresh token 随进程退出丢失，
    // 宿主之后用旧 token 续期会被拒（第二轮审计 #1）。只按 id upsert。
    onCredentialRefreshed: (provider, accountId, token) => {
      try {
        applyCredentialRefresh(store, provider, accountId, token)
      } catch {
        /* 令牌写回失败不能影响命令本身的结果 */
      }
    },
  })
  // 额度历史（1.5 秒去抖）与目录/额度缓存（0.8 / 1.5 秒去抖）都靠定时器落盘，
  // 而 CLI 进程命令一结束就没有别的句柄了 —— 这些定时器都 `unref()` 过，
  // 事件循环一空进程就退出，缓存从此永远不会写进磁盘（实测：刷新成功、
  // catalog-cache.json 一个字节都没落）。所以退出时补一次落盘。
  //
  // 只在**确实有待写的缓存**时才整份落盘：`bin.js events` 这类只读命令
  // 不该把 credits-cache.json 的 mtime 刷一遍（与 stats 的「只读不写」一致）。
  process.once('exit', () => {
    try {
      // 命令中途抛错时不会走到各自的 stats.stop()：把还没落盘的用量补写一次。
      // 只读命令没有 dirty 记录，stop() 不会重写文件。
      stats.stop()
    } catch {
      /* 统计写失败不影响命令结果 */
    }
    try {
      const pending = runtime.persistTimer !== undefined || runtime.catalogPersistTimer !== undefined
      if (pending) runtime.flushCaches()
      else runtime.creditHistory.stop()
    } catch {
      /* 旁路数据，退出失败不影响命令结果 */
    }
  })
  return { dir, store, stats, runtime }
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
  if (credits.resetAtMs > 0) text += `  最近到期 ${formatDateTime(credits.resetAtMs)}`
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

/**
 * 校验可选的 provider 参数。
 *
 * 所有带 provider 参数的命令都必须在**打印任何数据之前**调用：未知 provider 是
 * 用法错误（退出码 2），不能静默输出一段空数据然后 exit 0。
 *
 * @param provider - 命令行的 provider 参数（可省略）。
 * @returns 是否合法。
 */
function ensureProviderArg(provider) {
  if (provider === undefined || PROVIDER_IDS.includes(provider)) return true
  console.error(`未知 provider：${provider}；可用：${PROVIDER_IDS.join(' / ')}`)
  process.exitCode = 2
  return false
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
    // 失败证据已经过期（超过 30 分钟没有新请求）：不能再断言「不可用」，
    // 与设置卡片上的「待验证」同一口径。
    case 'stale':
      return health.lastErrorAt > 0
        ? `待验证（最后一次失败在 ${formatDateTime(health.lastErrorAt)}）`
        : '待验证'
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
  const profile = profileDir()
  if (profile !== undefined) console.log(`Profile: ${profile}`)
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
  if (!ensureProviderArg(provider)) return
  const { runtime, stats, store } = makeRuntime()
  await runtime.refreshAll()
  const targets = enabledTargets(store, provider)
  if (targets.length === 0) {
    stats.stop()
    process.exitCode = 2
    return
  }
  let failed = false
  for (const target of targets) {
    const credits = await runtime.refreshCredits(target, { force: true })
    // 读失败必须让退出码说话：终端写着「读取失败」却 exit 0，脚本会以为
    // 余额可读（test / probe / checkin 都已经这样处理）。
    if (credits?.state === 'error') failed = true
    console.log(`\n[${target}] ${describeCredits(credits, target)}`)
    for (const item of credits.items ?? []) {
      const remain = typeof item.remain === 'number' ? Math.round(item.remain * 10) / 10 : '—'
      const total = typeof item.total === 'number' ? Math.round(item.total * 10) / 10 : '—'
      // `0` / 负数表示「没有到期时间」（Go 零值经解析会得到年份 1 的负毫秒），
      // 直接格式化会打印「至 0001-01-01」，而前端明确只显示 > 0 的值。
      const end = typeof item.endAtMs === 'number' && item.endAtMs > 0 ? `  至 ${formatDateOnly(item.endAtMs)}` : ''
      const expired = item.expired === true ? '  [已耗尽]' : ''
      console.log(`    - ${item.name}  ${remain} / ${total}${expired}${end}`)
    }
  }
  stats.stop()
  if (failed) process.exitCode = 1
}

/** 列模型。 */
async function cmdModels(provider) {
  if (!ensureProviderArg(provider)) return
  const { runtime, stats, store } = makeRuntime()
  await runtime.refreshAll()
  const targets = provider === undefined ? PROVIDER_IDS : [provider]
  for (const target of targets) {
    if (!providerOptions(store.get(), target).enabled) {
      console.log(`[${target}] 已在设置里关闭，跳过（仍列出目录缓存）`)
    }
    const source = runtime.statusFor(target).catalogSource
    // 内置兜底清单不是真实目录：照原样打印会让用户以为这 4 个模型真的
    // 可用（选中即 400）。脚本解析 stdout，所以提示走 stderr。
    if (source === 'builtin' || source === 'none') {
      console.error(`[${target}] 上游目录不可用且没有磁盘缓存，以下为内置兜底清单（可能不可用）`)
    }
    for (const model of runtime.modelsFor(target)) {
      console.log(`${target}\t${model.id}\t${model.name}\tctx=${String(model.contextWindow)}\tout=${String(model.maxTokens)}\t${(model.reasoningEfforts ?? []).join('|')}`)
    }
  }
  stats.stop()
}

/** 用量。 */
async function cmdUsage(provider) {
  if (!ensureProviderArg(provider)) return
  const { stats, store } = makeRuntime()
  const snapshot = stats.snapshot()
  const targets = provider === undefined ? PROVIDER_IDS : [provider]
  console.log(`统计起点: ${formatDateTime(snapshot.since)}`)
  for (const target of targets) {
    const totals = snapshot.providers[target] ?? {}
    const today = snapshot.providerToday[target] ?? {}
    console.log(
      `\n[${target}] 健康 ${healthLabel(snapshot.health[target])}  累计 ${number(totals.requests)} 次（成功 ${number(totals.ok)} / 失败 ${number(totals.failed)}）  ${number(totals.totalTokens)} tokens  平均 ${totals.ok > 0 ? `${number(totals.avgDurationMs)}ms` : '—'}`,
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
      const at = formatDateTime(entry.at)
      console.log(`    ${at}  ${entry.model}  ${entry.kind}${entry.code === undefined ? '' : ` (${entry.code})`}  ${number(entry.durationMs)}ms  ${number(entry.totalTokens)} tokens`)
    }
    // 「哪个账号用了哪个模型、多少 token」：只有交叉维度才答得了。
    // 存的键是账号 id，显示时换成设置里的 label（用户认的是名字）。
    // 今日与累计分开列：交叉维度是升级后才开始累积的，累计值天然小于
    // provider 总量，混在一起会让人以为漏记 —— 所以每段都标出覆盖率。
    const labels = new Map(accountsFor(target, store.get()).map((account) => [account.id, account.label]))
    const pairLines = (source, prefix, total) => {
      const all = Object.values(source ?? {})
        .filter((entry) => entry !== null && typeof entry === 'object' && entry.provider === target && entry.requests > 0)
      if (all.length === 0) return
      const covered = all.reduce((sum, entry) => sum + entry.requests, 0)
      const coverage = total > 0 && covered < total
        ? `（已记录 ${String(covered)} / ${String(total)} 次，${String(Math.max(1, Math.round((covered / total) * 100)))}%；历史请求拆不出账号）`
        : ''
      console.log(`  账号 × 模型（${prefix}）${coverage}：`)
      const pairs = all.sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10)
      for (const pair of pairs) {
        const label = labels.get(pair.accountId) ?? pair.accountId
        console.log(`    - ${label}  ${pair.model}  ${number(pair.requests)} 次  ${number(pair.totalTokens)} tokens`)
      }
    }
    pairLines(snapshot.accountModelToday, '今日', today.requests)
    pairLines(snapshot.accountModels, '累计', totals.requests)
  }
  stats.stop()
}

/** 事件类型的中文名（CLI 不依赖浏览器 locale）。 */
function eventLabel(type) {
  switch (type) {
    case 'startup':
      return '启动'
    case 'account-switch':
      return '换号'
    case 'credential-refresh':
      return '令牌续期'
    case 'credential':
      return '凭证'
    case 'catalog':
      return '目录'
    case 'credits':
      return '额度'
    case 'checkin':
      return '签到'
    case 'probe':
      return '探测'
    case 'login':
      return '登录'
    case 'settings':
      return '设置'
    case 'stats':
      return '统计'
    case 'events':
      return '账本'
    case 'test':
      return '账号测试'
    case 'upstream':
      return '上游拦截'
    default:
      return type
  }
}

/** 最近事件账本（只读：不启动 runtime，不触发任何上游请求）。 */
async function cmdEvents(args = []) {
  const option = (name) => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args[at + 1]
  }
  const limitValue = Number(option('--limit'))
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(Math.floor(limitValue), 200) : 20
  const type = option('--type')
  const log = new EventLog({ filePath: eventsPathOf(dataDir()) })
  const items = log.list({ limit, ...(typeof type === 'string' && type !== '' ? { type } : {}) })
  if (args.includes('--json')) {
    console.log(JSON.stringify(items, null, 2))
    return
  }
  const summary = log.summary()
  if (items.length === 0) {
    console.log('事件账本为空。插件运行后会自动记录换号、令牌续期、目录/额度降级、签到与探测。')
    return
  }
  console.log(`最近 ${String(items.length)} 条事件（账本共 ${String(summary.count)} 条，最近 ${summary.latestAt > 0 ? formatDateTime(summary.latestAt) : '—'}）：`)
  for (const event of items) {
    const at = formatDateTime(event.at)
    const scope = event.provider === undefined ? '' : `[${event.provider}] `
    const level = event.level === 'info' ? '' : ` ${event.level.toUpperCase()}`
    console.log(`  ${at}  ${eventLabel(event.type)}${level}  ${scope}${event.message}`)
  }
}

/** 能力探测。 */
async function cmdProbe(provider) {
  if (!ensureProviderArg(provider)) return
  const { runtime, stats, store } = makeRuntime()
  let failed = false
  let succeeded = 0
  // 与 GUI 的「检测账号可用模型」同一套落盘语义：只提交这次真正探测过的
  // provider；探测失败/零模型的 provider 保留旧结论。以前 CLI 只打印不落盘，
  // 用户跑完 `bin.js probe` 后选择器里被隐藏的模型毫无变化。
  const patch = { unavailableModels: {}, probe: { results: {} } }
  const targets = enabledTargets(store, provider)
  // 所有 provider 都关闭时，probe 一个请求都不会发出。以前只在「显式点名」
  // 时 exit 2，不带参数的全量调用会静默 exit 0 —— cron / 开机自检会把
  // 「什么都没做」当成「探测通过」。
  if (targets.length === 0) {
    stats.stop()
    process.exitCode = 2
    return
  }
  await runtime.refreshAll({ force: true })
  for (const target of targets) {
    try {
      const accountId = activeAccountFor(target, store.get()).id
      const outcome = await runtime.probeProvider(target, { accountId })
      console.log(`[${target}] 探测 ${String(outcome.probed)} 个，账号不支持 ${String(outcome.unavailable.length)} 个`)
      if (outcome.unavailable.length > 0) console.log(`  ${outcome.unavailable.join(', ')}`)
      // 一个模型都没探成（凭证失效 / 上游不可达）与「全都可用」的打印完全一样，
      // 脚本据此判成功会静默放过一次坏探测。
      if (outcome.probed === 0) {
        failed = true
        continue
      }
      patch.unavailableModels[target] = outcome.unavailable
      patch.probe.results[target] = {
        probed: outcome.probed,
        unavailable: outcome.unavailable.length,
        accountId,
        at: Date.now(),
      }
      succeeded += 1
    } catch (error) {
      console.log(`[${target}] 探测失败：${error instanceof Error ? error.message : String(error)}`)
      failed = true
    }
  }
  if (succeeded > 0) {
    patch.probe.lastRunAt = Date.now()
    try {
      store.patch(patch)
    } catch (error) {
      console.log(`探测结果写入设置失败：${error instanceof Error ? error.message : String(error)}`)
      failed = true
    }
  }
  stats.stop()
  // 探测本身失败必须让退出码说话：以前 `probe` 恒 exit 0，与 `test` 不一致。
  if (failed) process.exitCode = 1
}

/** 真发一次 1-token 请求，验证账号能否使用。`deep` 时按真实对话请求的形状发。 */
async function cmdTest(provider, accountId, modelId, deep = false) {
  if (!ensureProviderArg(provider)) return
  const { runtime, stats, store } = makeRuntime()
  const targets = enabledTargets(store, provider)
  // 同 probe：一个 provider 都没启用时，一个请求都不会发。不带参数的
  // `test` 也必须非零退出，否则脚本会把「全部关闭」判成「测试通过」。
  if (targets.length === 0) {
    stats.stop()
    process.exitCode = 2
    return
  }
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
      const result = await runtime.testAccount(target, account.id, modelId, { deep })
      const reset = result.resetHint === undefined ? '' : `  限额至 ${result.resetHint}`
      const label = deep ? '深度测试' : '账号测试'
      console.log(`[${target}] ${account.label}  ${result.ok ? '✓ 正常' : `✗ ${result.code ?? 'FAILED'}`}  ${String(result.latencyMs)}ms  ${result.model ?? ''}${reset}${result.error === undefined ? '' : `  ${result.error}`}  (${label})`)
      if (!result.ok) failed = true
    }
  }
  stats.stop()
  if (failed) process.exitCode = 1
}

/** 签到。 */
async function cmdCheckin(provider) {
  if (!ensureProviderArg(provider)) return
  const { runtime, stats, store } = makeRuntime()
  let failed = false
  await runtime.refreshAll()
  const targets = enabledTargets(store, provider)
  if (targets.length === 0) {
    stats.stop()
    process.exitCode = 2
    return
  }
  for (const target of targets) {
    try {
      const outcome = await runtime.runCheckin(target)
      console.log(`[${target}] 领取 ${String(outcome.claimed)} 个账号，共 ${String(outcome.credit)} 分`)
      for (const item of outcome.outcomes) {
        console.log(`    - ${item.label}: ${item.kind}${item.message === undefined ? '' : `  ${item.message}`}`)
      }
      // 运行时把失败收敛成 `outcome.kind='failed'`（不抛错），所以只看异常
      // 不够：以前命令输出里明写 failed、退出码却是 0，脚本会当成签到成功。
      // `unconfigured` 是「没登录的已知状态」，不算失败（与调度器同一口径）。
      if (outcome.outcomes.some((item) => item.kind === 'failed')) failed = true
    } catch (error) {
      console.log(`[${target}] 签到失败：${error instanceof Error ? error.message : String(error)}`)
      failed = true
    }
  }
  stats.stop()
  if (failed) process.exitCode = 1
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
  const merged = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAtMs: token.expiresAtMs,
    refreshExpiresAtMs: token.refreshExpiresAtMs,
    domain: token.domain,
    uid: account.uid,
    enterpriseId: account.enterpriseId,
  }
  // 浏览器登录最长等 5 分钟：这期间宿主可能新增账号或续期令牌。
  // applyLoginAccount 会先取最新快照、再只 upsert 本次登录的账号 —— 拿命令
  // 启动时的旧快照整表覆盖会把这些并发写入静默抹掉（REPORT #1）。
  applyLoginAccount(store, provider, { uid: account.uid, label, token: merged })
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
async function cmdDoctor(options = {}) {
  const strict = options.strict === true
  // `--quiet` 只输出问题项：成功项与提示行全部静默。脚本/开机自检里跑
  // `doctor --quiet` 时，没有输出就代表一切正常（也便于 `--strict` 配合使用）。
  const quiet = options.quiet === true
  const { dir, runtime, stats, store } = makeRuntime()
  const problems = []
  const say = (text) => {
    if (!quiet) console.log(text)
  }
  const check = (ok, label, detail) => {
    if (ok) {
      say(`✓ ${label}${detail === undefined ? '' : `  ${detail}`}`)
      return
    }
    console.log(`✗ ${label}${detail === undefined ? '' : `  ${detail}`}`)
    problems.push(label)
  }

  const [major, minor] = process.versions.node.split('.').map((part) => Number(part))
  check(major > 22 || (major === 22 && minor >= 19), 'Node 版本', `${process.versions.node}（需要 ^22.19 或 >=24）`)
  check(
    store.loadError === undefined && store.writeBlocked !== true,
    '设置文件',
    store.loadError ?? (store.writeBlocked === true ? '只读/被更高版本占用，自动写盘已禁用' : `v${String(store.get().version)}，可读写`),
  )
  const probe = join(dir, `.doctor-${String(process.pid)}.tmp`)
  let writable = false
  try {
    writeFileSync(probe, 'ok', { mode: 0o600 })
    rmSync(probe, { force: true })
    writable = true
  } catch {
    writable = false
  }
  check(writable, '数据目录可写', dir)
  // 上一轮宿主被强杀时可能留下半截临时文件；runtime 启动时已经清掉，这里把它
  // 显式说出来，否则用户只会看到数据目录里「少了几个文件」而不知道为什么。
  const swept = runtime.sweptTempFiles
  if (typeof swept?.removed === 'number' && swept.removed > 0) {
    const size = typeof swept.bytes === 'number' && swept.bytes > 0
      ? `，${String(Math.ceil(swept.bytes / 1024))} KB`
      : ''
    say(`· 已清理 ${String(swept.removed)} 个中断写入的临时文件${size}`)
  }

  const settings = store.get()
  const enabledProviders = PROVIDER_IDS.filter((provider) => providerOptions(settings, provider).enabled)
  check(enabledProviders.length > 0, '启用的 provider', enabledProviders.length === 0 ? '全部关闭：插件不会出现在模型选择器里' : enabledProviders.join(' / '))
  const advanced = advancedOptions(settings)
  say(`· 刷新间隔：目录 ${String(Math.round(advanced.catalogRefreshMs / 1000))}s / 额度 ${String(Math.round(advanced.creditsRefreshMs / 1000))}s`)
  say(`· 流空闲超时：${String(Math.round(advanced.idleTimeoutMs / 1000))}s`)

  const results = await runtime.refreshAll({ force: true })
  await runtime.refreshAllCredits({ force: true })
  for (const result of results) {
    if (!providerOptions(settings, result.provider).enabled) {
      say(`· ${result.provider} 已关闭，跳过检查`)
      continue
    }
    const account = activeAccountFor(result.provider, settings)
    const credential = await runtime.describeCredential(result.provider, account, settings)
    // 可选 provider 只是「还没配置」（没登录/没装 App/路径没填）不是故障：
    // 只提示，不计入 problems，`--strict` 也不会因为它退出 1。
    if (credential.status !== 'signed-in' && isUnconfiguredCredential(credential.reason)) {
      say(`· ${result.provider} 未配置（可选）：${credential.message ?? credential.reason ?? '未登录'}`)
      continue
    }
    const health = stats.healthFor(result.provider)
    const models = runtime.modelsFor(result.provider)
    const catalogSource = runtime.statusFor(result.provider).catalogSource
    check(credential.status === 'signed-in', `${result.provider} 登录`, credential.status === 'signed-in' ? `${credential.source}${credential.email === undefined ? '' : ` / ${credential.email}`}` : `${credential.reason ?? ''} ${credential.message ?? ''}`)
    // 兜底清单只有 4 个内置模型，不代表上游目录真的可用：`models.length > 0`
    // 永远成立，doctor --strict 会在「一次都没拉到目录」时静默通过。
    check(
      models.length > 0 && catalogSource !== 'builtin' && catalogSource !== 'none',
      `${result.provider} 模型目录`,
      `${String(models.length)} 个，来源 ${catalogSource}${catalogSource === 'builtin' || catalogSource === 'none' ? '（内置兜底，可能不可用）' : ''}`,
    )
    check(health.state !== 'down', `${result.provider} 健康`, healthLabel(health))
    say(`· ${result.provider} 额度：${describeCredits(runtime.creditsFor(result.provider), result.provider)}`)
  }

  say('')
  if (problems.length === 0) {
    say('体检通过：没有发现需要处理的问题。')
    stats.stop()
    return
  }
  console.log(`发现 ${String(problems.length)} 个问题：${problems.join('，')}`)
  stats.stop()
  if (strict === true) process.exit(1)
}

/** 真发一次请求。 */
async function cmdAsk(provider, modelId, prompt) {
  if (!ensureProviderArg(provider)) return
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

const rawArgs = process.argv.slice(2)
// `--profile <dir>` 对所有命令生效：等价于设置 DSH_PROFILE_DIR，但更短。
const profileAt = rawArgs.indexOf('--profile')
if (profileAt !== -1 && typeof rawArgs[profileAt + 1] === 'string' && rawArgs[profileAt + 1] !== '') {
  process.env.DSH_PROFILE_DIR = rawArgs[profileAt + 1]
  rawArgs.splice(profileAt, 2)
}
const [command, ...rest] = rawArgs
try {
  if (command === 'status' || command === undefined) await cmdStatus()
  else if (command === 'doctor') await cmdDoctor({ strict: rest.includes('--strict'), quiet: rest.includes('--quiet') })
  else if (command === 'models') await cmdModels(rest[0])
  else if (command === 'credits') await cmdCredits(rest[0])
  else if (command === 'usage') await cmdUsage(rest[0])
  else if (command === 'events') await cmdEvents(rest)
  else if (command === 'probe') await cmdProbe(rest[0])
  else if (command === 'test') {
    // `--deep` 可以放在任意位置：深度测试按真实对话请求的形状（系统提示词 +
    // 工具表 + 正常输出上限）发一次，用来排查「1-token 测试通过但对话 400」。
    const deep = rest.includes('--deep')
    const args = rest.filter((value) => value !== '--deep')
    await cmdTest(args[0], args[1], args[2], deep)
  }
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
    console.error(`未知命令 ${String(command)}；可用：status / doctor / models / credits / usage / events / probe / test / checkin / login / stats-reset / ask`)
    process.exit(2)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
