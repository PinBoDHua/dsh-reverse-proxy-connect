#!/usr/bin/env node
/**
 * 命令行排障：不经过 GUI 也能看清「凭证读到了没 / 目录拉到没 / 模型能不能真出字」。
 *
 *   node lib/bin.js status            # 四个 provider 的登录与目录状态
 *   node lib/bin.js models [provider] # 列目录里的模型
 *   node lib/bin.js ask <provider> <model> <prompt...>   # 真发一次请求，打印流
 *
 * 这几个命令都只读本地凭证、不做任何落盘改动（除 Qoder 的机器标识种子）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { Runtime } from './runtime.js'
import { SettingsStore } from './settings.js'
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
  return { dir, store, runtime: new Runtime({ settings: () => store.get(), dataDir: dir, logger: console }) }
}

/** 状态。 */
async function cmdStatus() {
  const { dir, runtime } = makeRuntime()
  console.log(`数据目录: ${dir}`)
  const results = await runtime.refreshAll()
  await runtime.refreshAllCredits()
  for (const result of results) {
    const models = runtime.modelsFor(result.provider)
    const credits = runtime.creditsFor(result.provider)
    console.log(`\n[${result.provider}]  ${result.status}`)
    if (result.message !== undefined) console.log(`  说明: ${result.message}`)
    if (result.reason !== undefined) console.log(`  原因: ${result.reason}`)
    console.log(`  模型: ${models.length}`)
    for (const model of models.slice(0, 6)) {
      console.log(`    - ${model.id}  ${model.name}  ctx=${String(model.contextWindow)} out=${String(model.maxTokens)}${model.credits === undefined ? '' : ` ${model.credits}`}`)
    }
    if (models.length > 6) console.log(`    …还有 ${String(models.length - 6)} 个`)
    console.log(`  积分: ${describeCredits(credits)}`)
  }
}

/**
 * 一段人话的额度描述。
 * @param credits - `runtime.creditsFor()` 的返回值。
 * @returns 描述。
 */
function describeCredits(credits) {
  if (credits === undefined || credits.state === 'none') return '未读取'
  if (credits.state === 'error') return `读取失败（${credits.message ?? '未知原因'}）`
  if (credits.unlimited === true) return '不限量'
  const number = (value) => (typeof value === 'number' ? String(Math.round(value * 10) / 10) : '—')
  let text = `${number(credits.remain)}${credits.total > 0 ? ` / ${number(credits.total)}` : ''} ${credits.unit ?? 'credits'}`
  if (credits.planName !== undefined) text += `  套餐 ${credits.planName}`
  if (credits.exceeded === true) text += '  [额度已用尽]'
  if (credits.resetAtMs > 0) text += `  最近到期 ${new Date(credits.resetAtMs).toLocaleString()}`
  return text
}

/** 单独列额度。 */
async function cmdCredits(provider) {
  const { runtime } = makeRuntime()
  await runtime.refreshAll()
  const targets = provider === undefined ? PROVIDER_IDS : [provider]
  for (const target of targets) {
    const credits = await runtime.refreshCredits(target, { force: true })
    console.log(`\n[${target}] ${describeCredits(credits)}`)
    for (const item of credits.items ?? []) {
      const remain = typeof item.remain === 'number' ? Math.round(item.remain * 10) / 10 : '—'
      const total = typeof item.total === 'number' ? Math.round(item.total * 10) / 10 : '—'
      const end = item.endAtMs === undefined ? '' : `  至 ${new Date(item.endAtMs).toLocaleDateString()}`
      const expired = item.expired === true ? '  [已耗尽]' : ''
      console.log(`    - ${item.name}  ${remain} / ${total}${expired}${end}`)
    }
  }
}

/** 列模型。 */
async function cmdModels(provider) {
  const { runtime } = makeRuntime()
  await runtime.refreshAll()
  const targets = provider === undefined ? PROVIDER_IDS : [provider]
  for (const target of targets) {
    for (const model of runtime.modelsFor(target)) {
      console.log(`${target}\t${model.id}\t${model.name}\tctx=${String(model.contextWindow)}\tout=${String(model.maxTokens)}\t${(model.reasoningEfforts ?? []).join('|')}`)
    }
  }
}

/** 真发一次请求。 */
async function cmdAsk(provider, modelId, prompt) {
  const { runtime } = makeRuntime()
  await runtime.refreshAll()
  const model = await runtime.resolveModel(provider, modelId)
  if (model === undefined) {
    console.error(`provider ${provider} 下没有模型 ${modelId}；可用：${runtime.modelsFor(provider).map((entry) => entry.id).join(', ')}`)
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
}

const [command, ...rest] = process.argv.slice(2)
try {
  if (command === 'status' || command === undefined) await cmdStatus()
  else if (command === 'models') await cmdModels(rest[0])
  else if (command === 'credits') await cmdCredits(rest[0])
  else if (command === 'ask') {
    const [provider, modelId, ...words] = rest
    if (provider === undefined || modelId === undefined || words.length === 0) {
      console.error('用法: node lib/bin.js ask <provider> <model> <prompt...>')
      process.exit(2)
    }
    await cmdAsk(provider, modelId, words.join(' '))
  } else {
    console.error(`未知命令 ${String(command)}；可用：status / models / credits / ask`)
    process.exit(2)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
