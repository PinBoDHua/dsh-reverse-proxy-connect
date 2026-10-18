/**
 * 安全安装 / 卸载：把插件复制进 profile 并登记到两处清单。
 *
 * 与 dsh-balance-pill 的做法一致：默认 dry-run，`--apply` 才落盘，落盘前先备份。
 *
 *   node scripts/install.mjs                       # 预览
 *   node scripts/install.mjs --apply               # 安装
 *   node scripts/install.mjs --apply --uninstall   # 卸载
 *
 * 备份写到 <DSH_HOME>/dsh-reverse-proxy-connect-backup-<时间戳>/，并留一份 restore.ps1。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveProfileDir } from '../lib/profile.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_NAME = 'dsh-reverse-proxy-connect'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const uninstall = argv.includes('--uninstall')
const profileAt = argv.indexOf('--profile')
if (profileAt !== -1 && typeof argv[profileAt + 1] === 'string' && argv[profileAt + 1] !== '') {
  process.env.DSH_PROFILE_DIR = argv[profileAt + 1]
}

/** 解析 profile 目录：与 CLI 共用一套规则（DSH_PROFILE_DIR / $DSH_HOME）。 */
function resolveProfile() {
  try {
    return resolveProfileDir(process.env)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}（可用 --profile <dir> 指定）`)
  }
}

const profileDir = resolveProfile()
const manifestPath = join(profileDir, 'package.json')
const targetDir = join(profileDir, 'node_modules', PLUGIN_NAME)
const dshHome = process.env.DSH_HOME ?? dirname(dirname(profileDir))
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backupDir = join(dshHome, `${PLUGIN_NAME}-backup-${stamp}`)

/** 不进 profile 的东西：测试、临时脚本、点文件与下划线开头的本地草稿。 */
const COPY_EXCLUDE = new Set(['node_modules', '.git', 'tests', 'scripts', '_probe'])

/** 复制过滤：不把 `.env` / 日志 / `_*.mjs` 之类的本地文件带进 profile。 */
function copyFilter(source) {
  const name = basename(source)
  if (COPY_EXCLUDE.has(name)) return false
  if (name.startsWith('.')) return false
  if (name.startsWith('_')) return false
  if (name.endsWith('.log') || name.endsWith('.tmp')) return false
  return true
}

const log = (message) => console.log(message)
const change = (message) => console.log(`  · ${message}`)

if (!existsSync(manifestPath)) {
  console.error(`${manifestPath} 不存在 —— 这看起来不是一个 dsh profile 目录。`)
  process.exit(2)
}

const original = readFileSync(manifestPath, 'utf8')
const next = JSON.parse(original)
next.dependencies ??= {}
const bundles = next.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.error(`${manifestPath} 里没有 dsh.profile.bundles 数组 —— profile 结构不符合预期，已中止。`)
  process.exit(2)
}

if (uninstall) {
  delete next.dependencies[PLUGIN_NAME]
  next.dsh.profile.bundles = bundles.filter((name) => name !== PLUGIN_NAME)
} else {
  next.dependencies[PLUGIN_NAME] = `file:${ROOT.replace(/\\/g, '/')}`
  if (!bundles.includes(PLUGIN_NAME)) next.dsh.profile.bundles = [...bundles, PLUGIN_NAME]
}

const nextText = `${JSON.stringify(next, null, 2)}\n`
const willWriteManifest = nextText !== original
const willCopy = !uninstall

log(`${uninstall ? '卸载' : '安装'}计划（${apply ? '执行' : '预览，不写盘'}）：`)
log(`  profile    ${profileDir}`)
log(`  插件源     ${ROOT}`)
log('')
if (willCopy) change(`复制插件目录 -> ${targetDir}（复制前先移除旧副本）`)
change(willWriteManifest ? `改写 ${manifestPath}` : 'package.json 无需改动（已是目标状态）')
change(`备份 -> ${backupDir}`)
log('')

if (!apply) {
  log('这是预览。确认无误后加 --apply 执行。')
  log(`  node scripts/install.mjs --apply${uninstall ? ' --uninstall' : ''}`)
  log('')
  log('提示：桌面端正在运行时，profile 清单的改动会被 dsh-hmr 重新组合层栈；')
  log('      浏览器端 bundle 由 dsh-client-hmr 轮询，改完前端通常刷新一次页面即可。')
  process.exit(0)
}

mkdirSync(backupDir, { recursive: true })

/** 备份一个文件（若存在）。 */
function backup(relative) {
  const from = join(profileDir, relative)
  if (!existsSync(from)) return false
  cpSync(from, join(backupDir, relative.replace(/[\\/]/g, '__')))
  return true
}

const backedUp = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].filter(backup)

// 旧版本插件目录也整份备份：升级失败时 restore.ps1 才能真的回到上一版，
// 而不是只剩一个「已经装了一半」的空目录。
const hadPlugin = existsSync(targetDir)
if (hadPlugin) {
  cpSync(targetDir, join(backupDir, 'plugin'), { recursive: true })
}

writeFileSync(
  join(backupDir, 'restore.ps1'),
  `# 一键回滚到安装前的 profile 状态。
# 用法：先在 DeepSeek Harness 里完全退出，然后：
#   pwsh -File "${join(backupDir, 'restore.ps1')}"
$ErrorActionPreference = 'Stop'
$profile = '${profileDir.replace(/'/g, "''")}'
$backup = '${backupDir.replace(/'/g, "''")}'
foreach ($pair in @(
${backedUp.map((f) => `  @('${f}', '${f.replace(/[\\/]/g, '__')}')`).join(',\n')}
)) {
  $src = Join-Path $backup $pair[1]
  if (Test-Path $src) { Copy-Item $src (Join-Path $profile $pair[0]) -Force; Write-Host "restored $($pair[0])" }
}
$plugin = Join-Path $profile 'node_modules\\${PLUGIN_NAME}'
$pluginBackup = Join-Path $backup 'plugin'
if (Test-Path $pluginBackup) {
  if (Test-Path $plugin) { Remove-Item $plugin -Recurse -Force }
  Copy-Item $pluginBackup $plugin -Recurse -Force
  Write-Host 'restored plugin copy'
} elseif (Test-Path $plugin) {
  Remove-Item $plugin -Recurse -Force; Write-Host 'removed plugin copy'
}
Write-Host '回滚完成。请重新打开 DeepSeek Harness。'
`,
)

/** 把当前插件目录挪走，失败时能拿回来。 */
function swapPluginDirectory() {
  mkdirSync(dirname(targetDir), { recursive: true })
  const stage = `${targetDir}.new-${String(process.pid)}`
  const old = `${targetDir}.old-${String(process.pid)}`
  rmSync(stage, { recursive: true, force: true })
  rmSync(old, { recursive: true, force: true })
  cpSync(ROOT, stage, { recursive: true, filter: copyFilter })
  if (existsSync(targetDir)) renameSync(targetDir, old)
  try {
    renameSync(stage, targetDir)
  } catch (error) {
    // 换名失败：把旧目录放回去，不能留下「清单还在、目录已空」的状态。
    if (existsSync(old) && !existsSync(targetDir)) renameSync(old, targetDir)
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
  rmSync(old, { recursive: true, force: true })
}

try {
  if (uninstall) {
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
      log(`已删除 ${targetDir}`)
    }
  } else {
    swapPluginDirectory()
    log(`已复制插件 -> ${targetDir}`)
  }

  if (willWriteManifest) {
    writeFileSync(manifestPath, nextText)
    log(`已改写 ${manifestPath}`)
  }
} catch (error) {
  // 目录/清单任意一步失败：用刚做的备份恢复旧插件，避免 profile 停在半截。
  if (hadPlugin) {
    try {
      rmSync(targetDir, { recursive: true, force: true })
      cpSync(join(backupDir, 'plugin'), targetDir, { recursive: true })
      log('安装失败，已恢复上一版插件目录')
    } catch (restoreError) {
      log(`安装失败，且自动恢复失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
    }
  }
  throw error
}

log('')
log('安装结果：')
for (const [path, label] of [
  [join(targetDir, 'lib', 'index.js'), '宿主入口'],
  [join(targetDir, 'client', 'client.js'), '客户端 bundle'],
  [join(targetDir, 'cordis.patch.yml'), 'bundle patch'],
  [join(targetDir, 'package.json'), '包清单'],
]) {
  log(`  ${existsSync(path) ? '✓' : '✗'} ${label}  ${path.replace(profileDir, '<profile>')}`)
}
log(`  插件目录条目数：${existsSync(targetDir) ? readdirSync(targetDir).length : 0}`)
log('')
log(`备份：${backupDir}`)
log(`回滚：pwsh -File "${join(backupDir, 'restore.ps1')}"`)
log('')
log('下一步：')
log('  1. 完全退出并重启 DeepSeek Harness（宿主半边需要重新加载）；')
log('  2. 打开 设置 → 插件设置 → 反代连接器，检查六个 provider 的登录状态；')
log('  3. 在模型选择器里应出现 WorkBuddy / WorkBuddy AI / Qoder / Qoder Global / Trae / Trae Global 六组。')
