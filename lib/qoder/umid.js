/**
 * Qoder 桌面端的 umid 机器身份。
 *
 * 国际版的 `GET /sash/api/v1/me/campaigns` 把每日 `CLAIM_BENEFIT` 轮次按
 * **机器身份**下发：只带 Bearer 的请求只会拿到常驻的 `VIEW_DETAILS` 横幅，
 * 签到行按 `active:false` 隐藏。官方桌面端发的是 umid 服务生成的三件套
 * `Cosy-MachineToken` / `Cosy-MachineCode` / `Cosy-MachineType`，由安装目录里的
 * `resources\umid\runtime-info.exe` 无参运行得到：
 *
 * ```json
 * { "machineToken": "…", "machineType": "…", "machineCode": "…" }
 * ```
 *
 * 这里只读本机已安装客户端的 umid：
 *
 * - 找不到二进制 / 非 Windows / 输出不完整 → `{}`，请求退回只带 Bearer 的
 *   身份。国内版不需要 umid；国际版会因此只拿到横幅，调用方必须把这种
 *   「列表被裁掉」解释成「需要机器身份」，而不是「没有活动」。
 * - 三件套是**全有或全无**：缺一个字段就整组不发，绝不把半份身份递上去。
 * - 结果按进程缓存：二进制正常 < 1s，签到一天只跑几次，没有必要反复启动。
 *
 * 安装布局（Windows）：
 *
 * - 桌面端：`%LOCALAPPDATA%\Programs\Qoder`（国际版）、`Qoder CN`（国内版，
 *   实际目录带空格）以及 `QoderCN`（历史/大小写变体）。0.4.x 起每个版本在
 *   `.qoder-versions\<v>\resources\umid\runtime-info.exe`，外层
 *   `resources\umid\runtime-info.exe` 也可能存在，两者都试。
 * - CLI：`%USERPROFILE%\.qoder\.bin\umid-*\runtime-info.exe`（国际版）与
 *   `%USERPROFILE%\.qoder-cn\.bin\umid-*\runtime-info.exe`（国内版）。同一台
 *   机器上 CLI 与桌面端给出的身份相同，桌面端没装时可作为兜底。
 *
 * 参考实现（同一协议的独立插件）已确认：把应用自己的 `auth.machine-id`
 * 填进这三个头**不行**，必须用 umid 二进制生成的值；发派生/伪造身份反而会
 * 让每日活动被整条过滤掉。
 *
 * @module dsh-reverse-proxy-connect/qoder/umid
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** umid 二进制的等待上限；正常机器远小于 1s。 */
const UMID_TIMEOUT_MS = 5_000

/** 单个二进制的输出上限，防止坏掉的程序把宿主内存打满。 */
const UMID_MAX_BUFFER = 64 * 1024

/**
 * 进程内缓存：
 * - `cachedBlock === undefined` 还没读过；
 * - 成功结果（对象）永久缓存；
 * - 失败结果（null）只缓存一小段时间：用户可能刚装好/打开桌面端，不能
 *   让一次「找不到二进制」把整个进程钉死到重启才恢复。
 * `cachedPromise` 让并发调用只启动一次二进制。
 */
let cachedBlock
let cachedPromise
let cachedAt = 0

/** 失败结论的缓存时长：足够挡住一次签到里的并发，又允许装好客户端后重试。 */
const FAILURE_TTL_MS = 60_000

/**
 * 测试/诊断接缝：返回 `{ machineToken, machineType, machineCode }` 或 null。
 * 生产环境永远不会设置它；单测用它覆盖二进制读取的每个分支。
 */
const PROBE_KEY = '__dshReverseProxyQoderUmidProbe'

/**
 * 官方客户端的 umid 请求头。
 *
 * @returns {Promise<Record<string, string>>} 读不到时是空对象。
 */
export async function umidHeadersFor() {
  try {
    const block = await readUmidBlock()
    if (block === null) return {}
    return {
      'Cosy-MachineToken': block.machineToken,
      'Cosy-MachineCode': block.machineCode,
      'Cosy-MachineType': block.machineType,
    }
  } catch {
    // umid 只是「让国际版列表恢复完整」的增强，读失败绝不能把签到本身打挂。
    return {}
  }
}

/**
 * 读一次 umid 身份（带进程缓存）。
 *
 * @returns {Promise<{machineToken: string, machineType: string, machineCode: string} | null>} 身份或 null。
 */
export async function readUmidBlock() {
  if (cachedBlock !== undefined) {
    if (cachedBlock !== null) return cachedBlock
    if (Date.now() - cachedAt < FAILURE_TTL_MS) return null
    cachedBlock = undefined
  }
  if (cachedPromise === undefined) {
    cachedPromise = resolveUmidBlock()
      .then((block) => {
        cachedBlock = block
        cachedAt = Date.now()
        return block
      })
      .finally(() => {
        cachedPromise = undefined
      })
  }
  return await cachedPromise
}

/**
 * 测试接缝：清掉进程缓存，让下一次调用重新读取。
 */
export function __resetUmidCache() {
  cachedBlock = undefined
  cachedPromise = undefined
  cachedAt = 0
}

/**
 * 实际解析：测试探针优先，其次按安装布局逐个尝试二进制。
 *
 * @returns {Promise<object | null>} 身份或 null。
 */
async function resolveUmidBlock() {
  const probe = globalThis[PROBE_KEY]
  if (typeof probe === 'function') {
    try {
      return parseUmidBlock(await probe())
    } catch {
      return null
    }
  }
  if (process.platform !== 'win32') return null
  for (const binary of umidBinaries()) {
    if (!existsSync(binary)) continue
    const output = await runUmidBinary(binary)
    if (output === undefined) continue
    const block = parseUmidBlock(output)
    if (block !== null) return block
  }
  return null
}

/**
 * 本机所有候选的 `runtime-info.exe` 路径，桌面端在前、CLI 在后。
 *
 * @param {object} [options] - 测试可注入的 `{ platform, env, home }`。
 * @returns {string[]} 候选路径（可能包含不存在的项，调用方会 `existsSync`）。
 */
export function umidBinaries(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  if (platform !== 'win32') return []
  const roots = []
  const localAppData = env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData !== '') {
    const programs = join(localAppData, 'Programs')
    // 目录名是实测出来的：国内版安装包实际落在 `Qoder CN`（带空格），
    // 而文档/旧版本里也见过 `QoderCN`；国际版是 `Qoder`。
    for (const name of ['Qoder', 'Qoder CN', 'QoderCN']) {
      const tree = join(programs, name)
      roots.push(...versionedRoots(tree), tree)
    }
  }
  // CLI 安装器把同一枚 umid 放在用户目录的 .bin/umid-<platform>-<hash> 下。
  for (const name of ['.qoder', '.qoder-cn']) {
    roots.push(...umidCliRoots(join(home, name, '.bin')))
  }
  const binaries = []
  for (const root of roots) {
    binaries.push(join(root, 'resources', 'umid', 'runtime-info.exe'))
    binaries.push(join(root, 'runtime-info.exe'))
  }
  return [...new Set(binaries)]
}

/**
 * `.qoder-versions\<v>` 下的版本根，新版本在前。
 *
 * @param {string} tree - 启动器目录。
 * @returns {string[]} 版本根。
 */
function versionedRoots(tree) {
  let entries
  try {
    entries = readdirSync(join(tree, '.qoder-versions'), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => compareVersion(b, a))
    .map((name) => join(tree, '.qoder-versions', name))
}

/**
 * `%USERPROFILE%\.qoder\.bin` 下的 umid-* 目录，新目录在前。
 *
 * @param {string} binRoot - `.bin` 目录。
 * @returns {string[]} 候选根。
 */
function umidCliRoots(binRoot) {
  let entries
  try {
    entries = readdirSync(binRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('umid-'))
    .map((entry) => entry.name)
    .sort((a, b) => compareVersion(b, a))
    .map((name) => join(binRoot, name))
}

/**
 * 按点分版本号逐段数值比较；`0.4.10` 必须赢 `0.4.9`。
 *
 * @param {string} a - 版本 a。
 * @param {string} b - 版本 b。
 * @returns {number} 比较结果。
 */
function compareVersion(a, b) {
  const partsA = a.split('.')
  const partsB = b.split('.')
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index++) {
    const na = Number(partsA[index] ?? 0)
    const nb = Number(partsB[index] ?? 0)
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb
      continue
    }
    const ca = String(partsA[index] ?? '')
    const cb = String(partsB[index] ?? '')
    if (ca !== cb) return ca < cb ? -1 : 1
  }
  return 0
}

/**
 * 解析并校验 umid 的 JSON。缺字段/空串 → null（全有或全无）。
 *
 * @param {unknown} answer - 二进制输出（字符串）或已解析对象。
 * @returns {{machineToken: string, machineType: string, machineCode: string} | null} 校验后的身份。
 */
export function parseUmidBlock(answer) {
  let value = answer
  if (typeof value === 'string') {
    try {
      // 有的运行时会给 stdout 加 BOM；JSON.parse 不认它。
      value = JSON.parse(value.replace(/^\uFEFF/u, '').trim())
    } catch {
      return null
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const machineToken = value.machineToken
  const machineType = value.machineType
  const machineCode = value.machineCode
  if (typeof machineToken !== 'string' || machineToken === '') return null
  if (typeof machineType !== 'string' || machineType === '') return null
  if (typeof machineCode !== 'string' || machineCode === '') return null
  return { machineToken, machineType, machineCode }
}

/**
 * 无参运行 umid 二进制，返回 stdout；失败/超时返回 undefined。
 *
 * 用异步 `execFile` 而不是 `execFileSync`：这段代码跑在 DSH 宿主进程里，
 * 一个卡住的二进制不能把整个事件循环冻住 5 秒。
 *
 * @param {string} binary - 二进制路径。
 * @returns {Promise<string | undefined>} 输出。
 */
function runUmidBinary(binary) {
  return new Promise((resolve) => {
    execFile(
      binary,
      [],
      {
        timeout: UMID_TIMEOUT_MS,
        maxBuffer: UMID_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
      (error, stdout) => {
        if (error) resolve(undefined)
        else resolve(stdout)
      },
    )
  })
}
