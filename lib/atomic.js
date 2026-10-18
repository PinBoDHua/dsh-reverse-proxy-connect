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

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** Windows 上杀毒/索引器短暂占用目标文件时，rename 会回 EPERM/EBUSY；值得重试。 */
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE'])

/** 同步小睡：原子写是同步 API，重试窗口只有几十毫秒，不值得为此改成异步。 */
function pause(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 没有 SharedArrayBuffer 的极端环境就立即重试 */
  }
}

/**
 * 读一个文本文件，兼容 UTF-8 BOM 与 PowerShell 写出的 UTF-16LE/BE。
 *
 * 这不是吹毛求疵：Windows 用户手改 `settings.json` 时很常见 `Out-File` 默认
 * UTF-16LE，或者编辑器保留 UTF-8 BOM。`JSON.parse` 遇到 BOM 会直接失败，
 * 而设置加载失败会退回默认值 —— 下一次写盘就把 PAT 与账号池整份覆盖。
 *
 * @param file - 绝对路径。
 * @returns 文本。
 */
export function readTextFile(file) {
  const buffer = readFileSync(file)
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2)
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1]
      swapped[index - 1] = buffer[index]
    }
    return swapped.toString('utf16le')
  }
  const source = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    ? buffer.subarray(3)
    : buffer
  const text = source.toString('utf8')
  // 非 UTF-8（GBK / ANSI / 无 BOM 的 UTF-16）会被解成 U+FFFD，但 JSON 往往
  // 仍能 parse —— 然后下一次写盘就把中文标签与路径永久写成乱码。这里做一次
  // 往返校验，解码不回去就按坏文件处理（备份 + loadError），不静默接受。
  if (!Buffer.from(text, 'utf8').equals(source)) {
    const error = new Error('文件不是有效的 UTF-8（可能是 ANSI/GBK 或无 BOM 的 UTF-16）')
    error.code = 'EENCODING'
    throw error
  }
  return text
}

/**
 * 原子写一个文本文件。
 *
 * @param file - 目标绝对路径。
 * @param text - 文件内容。
 * @param options - `{ mode?, throwOnError? }`，默认 0600（这些文件里可能有 PAT）。
 * @returns 是否写成功（默认失败返回 false，不抛；`throwOnError` 时抛）。
 */
export function writeTextAtomic(file, text, options = {}) {
  const mode = typeof options.mode === 'number' ? options.mode : 0o600
  const dir = dirname(file)
  let lastError

  for (let attempt = 0; attempt < 3; attempt++) {
    const temp = join(dir, `.${basename(file)}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(temp, text, { encoding: 'utf8', mode })
      // 先 fsync 再 rename：否则断电时 rename 已经生效、内容却还在页缓存里，
      // 文件会变成 0 字节或旧内容（settings.json 会被当成「坏文件」）。
      let fd
      try {
        fd = openSync(temp, 'r')
        fsyncSync(fd)
      } catch {
        /* 某些文件系统不支持 fsync，继续 rename */
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd)
          } catch {
            /* ignore */
          }
        }
      }
      // Windows 上按已有文件设置权限没有意义，但 chmod 对 POSIX 有用：
      // rename 保留的是临时文件的权限，所以这里必须显式补一次。
      try {
        chmodSync(temp, mode)
      } catch {
        /* 某些文件系统不支持 chmod，忽略 */
      }
      renameSync(temp, file)
      return true
    } catch (error) {
      lastError = error
      try {
        rmSync(temp, { force: true })
      } catch {
        /* 清理失败也无所谓 */
      }
      if (!RETRYABLE_CODES.has(error?.code)) break
      if (attempt < 2) pause(40)
    }
  }

  if (options.throwOnError === true) {
    const error = lastError instanceof Error ? lastError : new Error(`写入 ${file} 失败`)
    if (typeof error.code !== 'string') error.code = 'EWRITE'
    error.path ??= file
    throw error
  }
  return false
}

/**
 * 原子写一个 JSON 文件（带换行，方便人肉 diff）。
 *
 * @param file - 目标绝对路径。
 * @param value - 可 JSON 序列化的值。
 * @param options - `{ mode?, pretty?, throwOnError? }`。
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
    return JSON.parse(readTextFile(file))
  } catch {
    return undefined
  }
}
