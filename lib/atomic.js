/**
 * 极小的落盘工具：所有自有 JSON 文件都走同一条「先临时文件、再 rename」的路径。
 *
 * 为什么值得单独成模块：插件现在要维护 4 份自有状态（settings / credits /
 * catalog / stats）。之前每份各写一遍 `writeFileSync + rename`，权限、目录创建、
 * 临时文件命名、失败清理各有一点点差异 —— 这类差异在崩溃恢复时最容易变成
 * 「半个 JSON 文件」，而半个 JSON 会让整个插件退回默认值。
 *
 * @module dsh-reverse-proxy-connect/atomic
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/**
 * 原子写一个文本文件。
 *
 * @param file - 目标绝对路径。
 * @param text - 文件内容。
 * @param options - `{ mode? }`，默认 0600（这些文件里可能有 PAT）。
 * @returns 是否写成功（失败返回 false，不抛）。
 */
export function writeTextAtomic(file, text, options = {}) {
  const mode = typeof options.mode === 'number' ? options.mode : 0o600
  const dir = dirname(file)
  const temp = join(dir, `.${basename(file)}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(temp, text, { encoding: 'utf8', mode })
    // Windows 上按已有文件设置权限没有意义，但 chmod 对 POSIX 有用：
    // rename 保留的是临时文件的权限，所以这里必须显式补一次。
    try {
      chmodSync(temp, mode)
    } catch {
      /* 某些文件系统不支持 chmod，忽略 */
    }
    renameSync(temp, file)
    return true
  } catch {
    try {
      rmSync(temp, { force: true })
    } catch {
      /* 清理失败也无所谓 */
    }
    return false
  }
}

/**
 * 原子写一个 JSON 文件（带换行，方便人肉 diff）。
 *
 * @param file - 目标绝对路径。
 * @param value - 可 JSON 序列化的值。
 * @param options - `{ mode?, pretty? }`。
 * @returns 是否写成功。
 */
export function writeJsonAtomic(file, value, options = {}) {
  const pretty = options.pretty === true
  return writeTextAtomic(file, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, options)
}

/**
 * 读一个 JSON 文件；任何失败都返回 undefined。
 *
 * @param file - 绝对路径。
 * @returns 解析后的值，或 undefined。
 */
export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
