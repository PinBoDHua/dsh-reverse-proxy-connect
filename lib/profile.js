/**
 * profile / 数据目录解析：CLI、安装脚本共用一套规则。
 *
 * 宿主半边有 `profileContext.dir`，不需要这里；但 `node lib/bin.js status`
 * 这类命令必须和桌面端指向同一个 profile。旧实现各自判断：CLI 用
 * `DSH_PROFILE_DIR` 否则 `~/.dsh`，安装脚本硬编码 `profiles/desktop` ——
 * 于是最常敲的那条命令读的是另一份空设置，看起来像插件没装。
 *
 * 解析顺序（越明确越优先）：
 * 1. `DSH_PROFILE_DIR`（显式指定，必须存在）
 * 2. `--profile <dir>` 由调用方转成环境变量
 * 3. `$DSH_HOME/profiles/desktop`（本仓库桌面端默认）
 * 4. `$DSH_HOME/profiles/` 下只有一个目录时用它
 * 5. 都没有 → 抛出可操作的错误，而不是悄悄读错目录
 *
 * @module dsh-reverse-proxy-connect/profile
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { DATA_DIR_NAME } from './protocol.js'

/** 解析 DSH home：与宿主 dsh-home-paths 的规则一致。 */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/** 目录存在且确实是目录。 */
function isDirectory(value) {
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

/**
 * 找到要操作的 profile 目录。
 *
 * @param env - 环境变量（测试可注入）。
 * @param options - `{ dshHome? }` 覆盖 home。
 * @returns 绝对路径。
 * @throws {Error} 找不到或存在多个候选时。
 */
export function resolveProfileDir(env = process.env, options = {}) {
  const explicit = env.DSH_PROFILE_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const target = resolve(explicit.trim())
    if (!isDirectory(target)) {
      throw new Error(`DSH_PROFILE_DIR 指向的目录不存在：${target}`)
    }
    return target
  }
  const home = options.dshHome ?? resolveDshHome(env)
  const desktop = join(home, 'profiles', 'desktop')
  if (isDirectory(desktop)) return desktop
  const profiles = join(home, 'profiles')
  if (isDirectory(profiles)) {
    let entries = []
    try {
      entries = readdirSync(profiles).filter((name) => isDirectory(join(profiles, name)))
    } catch {
      entries = []
    }
    if (entries.length === 1) return join(profiles, entries[0])
    if (entries.length > 1) {
      throw new Error(`找到多个 profile（${entries.join('、')}），请用 DSH_PROFILE_DIR 指定要操作哪一个。`)
    }
  }
  throw new Error(
    `找不到 DSH profile 目录。已查找：${desktop}${existsSync(profiles) ? '' : '（profiles 目录不存在）'}。`
    + '请设置 DSH_PROFILE_DIR，或在 DSH 桌面端进程里运行本命令。',
  )
}

/**
 * 插件数据目录。
 *
 * @param env - 环境变量。
 * @param options - `{ profileDir? }` 已解析的 profile（可选）。
 * @returns 绝对路径。
 */
export function resolveDataDir(env = process.env, options = {}) {
  const override = env.DSH_REVERSE_PROXY_DATA_DIR
  if (typeof override === 'string' && override.trim() !== '') return resolve(override.trim())
  const profile = options.profileDir ?? resolveProfileDir(env)
  return join(profile, DATA_DIR_NAME)
}
