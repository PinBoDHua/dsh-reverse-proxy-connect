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

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_NAME = 'dsh-reverse-proxy-connect'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const uninstall = argv.includes('--uninstall')

/** 解析 profile 目录：环境变量优先，其次 $DSH_HOME/profiles/desktop。 */
function resolveProfileDir() {
  if (process.env.DSH_PROFILE_DIR && existsSync(process.env.DSH_PROFILE_DIR)) return process.env.DSH_PROFILE_DIR
  const home = process.env.DSH_HOME
  if (home && existsSync(join(home, 'profiles', 'desktop'))) return join(home, 'profiles', 'desktop')
  throw new Error('找不到 DSH profile 目录。请设置 DSH_PROFILE_DIR，或在 DSH 桌面端进程里运行本脚本。')
}

const profileDir = resolveProfileDir()
const manifestPath = join(profileDir, 'package.json')
const targetDir = join(profileDir, 'node_modules', PLUGIN_NAME)
const dshHome = process.env.DSH_HOME ?? dirname(dirname(profileDir))
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backupDir = join(dshHome, `${PLUGIN_NAME}-backup-${stamp}`)

/** 不进 profile 的东西：测试与临时脚本。 */
const COPY_EXCLUDE = new Set(['node_modules', '.git', 'tests', 'scripts', '_probe'])

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

writeFileSync(
  join(backupDir, 'restore.ps1'),
  `# 一键回滚到安装前的 profile 状态。
# 用法：先在 DeepSeek Harness 里完全退出，然后：
#   pwsh -File "${join(backupDir, 'restore.ps1')}"
$ErrorActionPreference = 'Stop'
$profile = '${profileDir.replace(/'/g, "''")}'
foreach ($pair in @(
${backedUp.map((f) => `  @('${f}', '${f.replace(/[\\/]/g, '__')}')`).join(',\n')}
)) {
  $src = Join-Path '${backupDir.replace(/'/g, "''")}' $pair[1]
  if (Test-Path $src) { Copy-Item $src (Join-Path $profile $pair[0]) -Force; Write-Host "restored $($pair[0])" }
}
$plugin = Join-Path $profile 'node_modules\\${PLUGIN_NAME}'
if (Test-Path $plugin) { Remove-Item $plugin -Recurse -Force; Write-Host 'removed plugin copy' }
Write-Host '回滚完成。请重新打开 DeepSeek Harness。'
`,
)

if (uninstall) {
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true })
    log(`已删除 ${targetDir}`)
  }
} else {
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(dirname(targetDir), { recursive: true })
  cpSync(ROOT, targetDir, {
    recursive: true,
    filter: (source) => !COPY_EXCLUDE.has(source.split(/[\\/]/).pop()),
  })
  log(`已复制插件 -> ${targetDir}`)
}

if (willWriteManifest) {
  writeFileSync(manifestPath, nextText)
  log(`已改写 ${manifestPath}`)
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
log('  2. 打开 设置 → 插件设置 → 反代连接器，检查四个 provider 的登录状态；')
log('  3. 在模型选择器里应出现 WorkBuddy / WorkBuddy AI / Qoder / Qoder Global 四组。')
