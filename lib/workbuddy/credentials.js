/**
 * WorkBuddy 凭证：本地发现 + 5.6.x 加密信封解密。
 *
 * ## 为什么是自己实现而不是复用一个包
 * 上游 `dsh-workbuddy-connect@0.7.6` 把 `@earendil-works/pi-ai` 钉成 **0.87.1**
 * 的普通依赖，而 DSH 0.2.1-rc.1 内建的是 **1.1.0**；两个大版本同时存在于
 * 进程里时，它的 pi-ai 描述符要交给 1.1.0 的 Models 集合去 stream，属于
 * 跨大版本的词表错配。本插件不导入 pi-ai，只借宿主已有的
 * `@deepseek-ai/dsh-llm-pi-ai`（由 DSH 自己解析），因此不会出现双版本。
 *
 * ## 加密信封（WorkBuddy 5.6+）
 * 桌面端把 `auth.accessToken` / `auth.refreshToken` 写成
 * `{$wbEncrypted:1, envelope:<base64(JSON)>}`，内层是
 * `{suite:1, keyId, nonce, authTag, ciphertext}`，AES-256-GCM。
 * 密钥来自应用自身：用它的 Electron 二进制以 `ELECTRON_RUN_AS_NODE=1` 跑一句
 * `process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()`，
 * 拿到 `{version:1, atRestSecretKey}`，再 `sha256(那个 base64 字符串)` 得到
 * 保护密钥。AAD 必须逐字节照抄应用自己的 `buildAuthenticatedContextAad`。
 *
 * 这条链路已在本机用两个版本 App 的真实凭证文件验证通过。
 *
 * @module dsh-reverse-proxy-connect/workbuddy/credentials
 */

import { execFile } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { REFRESH_MARGIN_MS, REASON } from '../protocol.js'

/** 应用二进制里取保护密钥的那一句；与 WorkBuddy 桌面端自己的实现一致。 */
const HELPER_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'

/** 单个 App 变体的静态描述。 */
const VARIANTS = {
  workbuddy: {
    id: 'workbuddy',
    region: 'cn',
    desktopFile: 'workbuddy-desktop.info',
    exeBasename: 'workbuddy.exe',
    // 注册表里的产品名：`WorkBuddy 5.8.2`，且**不能**是 `WorkBuddy AI …`。
    displayNamePattern: /^WorkBuddy(?!\s*AI\b)(?:\s+\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)?$/u,
    chatBase: 'https://copilot.tencent.com',
    webBase: 'https://www.codebuddy.cn',
    envElectron: 'WORKBUDDY_ELECTRON_BIN',
    envAuthFile: 'WORKBUDDY_AUTH_FILE',
  },
  'workbuddy-ai': {
    id: 'workbuddy-ai',
    region: 'global',
    desktopFile: 'workbuddy-desktop-ai.info',
    exeBasename: 'workbuddyai.exe',
    displayNamePattern: /^WorkBuddy AI(?:\s+\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)?$/u,
    chatBase: 'https://www.workbuddy.ai',
    webBase: 'https://www.workbuddy.ai',
    envElectron: 'WORKBUDDY_AI_ELECTRON_BIN',
    envAuthFile: 'WORKBUDDY_AI_AUTH_FILE',
  },
}

/** 一个凭证读取失败时抛的错误：带 reason 码，卡片据此分支。 */
export class CredentialError extends Error {
  /**
   * @param code - REASON 里的码。
   * @param message - 给人看的中文说明。
   * @param cause - 底层错误。
   */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'CredentialError'
    this.code = code
  }
}

/**
 * 桌面端共享的授权目录候选（Windows / macOS / Linux）。
 * WorkBuddy 与 WorkBuddy AI 写的是**同一个**目录，只差文件名。
 * @returns 绝对路径列表，按可信度排序。
 */
function authDirCandidates() {
  const home = homedir()
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      join(home, 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ]
  }
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  const config = process.env.XDG_CONFIG_HOME || join(home, '.config')
  const data = process.env.XDG_DATA_HOME || join(home, '.local', 'share')
  return [
    join(config, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    join(data, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  ]
}

/**
 * 该变体的凭证文件候选，环境变量优先。
 * @param variant - VARIANTS 里的条目。
 * @returns 绝对路径列表。
 */
export function authFileCandidates(variant) {
  const explicit = process.env[variant.envAuthFile]
  if (typeof explicit === 'string' && explicit.trim() !== '') return [explicit.trim()]
  return authDirCandidates().map((dir) => join(dir, variant.desktopFile))
}

/**
 * 从一行 `DisplayIcon` 里抠出 exe 路径。
 * @param value - 注册表里的 DisplayIcon 值，形如 `D:\WorkBuddy\WorkBuddy.exe,0`。
 * @returns exe 路径，或 undefined。
 */
function exeFromDisplayIcon(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/^"|"$/g, '')
  const comma = trimmed.lastIndexOf(',')
  const path = comma > 2 && /^\d+$/.test(trimmed.slice(comma + 1).trim()) ? trimmed.slice(0, comma) : trimmed
  const clean = path.trim().replace(/^"|"$/g, '')
  return clean.toLowerCase().endsWith('.exe') ? clean : undefined
}

/**
 * 进程内记住每个变体解析出的 App 路径。
 *
 * 注册表扫描要 spawn `reg.exe`，并发时偶发超时；缓存让第一次成功后不再受抖动影响。
 * 每次命中都会重新校验文件还在，所以卸载 App 后不会一直指向幽灵路径。
 */
const resolvedBinaries = new Map()

/**
 * 已知的 App 安装目录（从任何一次成功解析里学到）。
 *
 * 用途：注册表并不总是有记录。实测这台机器上 `D:\workbuddy\WorkBuddyAI.exe` 存在、
 * 布局完好，但「添加/删除程序」里只剩 `WorkBuddy 5.8.2` 一条 —— 国际版那条没了
 * （可能被更新器删掉了）。此时只靠注册表就会报「找不到桌面端」，而文件明明在。
 *
 * 所以：任何变体成功解析后，把它的目录记下来；另一个变体找自己时先来这些目录里
 * 按文件名找一遍。国内版与国际版经常装在同一个目录下，这个启发式正好命中。
 */
const knownAppDirs = new Set()

/**
 * 在给定目录里按文件名（大小写不敏感）找可执行文件。
 * @param dirs - 候选目录。
 * @param exeBasename - 目标文件名（小写，含 .exe）。
 * @param exeBasenameList - 允许的同义文件名。
 * @returns 找到的第一个可信路径，或 undefined。
 */
function scanDirsForExecutable(dirs, exeBasename, exeBasenameList) {
  for (const dir of dirs) {
    try {
      if (!existsSync(dir)) continue
      for (const name of exeBasenameList) {
        const candidate = join(dir, name)
        if (looksLikeApp(candidate, exeBasename)) return candidate
      }
    } catch {
      /* 目录不可读就跳过 */
    }
  }
  return undefined
}

/**
 * 判断一个 exe 是否像目标 App：同名 exe、旁边有 `version`、旁边有 `resources\app.asar`。
 * @param exePath - 候选可执行文件。
 * @param exeBasename - 期望的文件名（小写）。
 * @returns 是否可信。
 */
function looksLikeApp(exePath, exeBasename) {
  try {
    if (!existsSync(exePath)) return false
    if (!statSync(exePath).isFile()) return false
    const dir = dirname(exePath)
    // 国内版与国际版常常是同一套 Electron 布局、甚至同一份二进制内容
    // （D:\WorkBuddy\WorkBuddy.exe 与 WorkBuddyAI.exe 在 5.8.x 上就是两个不同
    // 的构建，但目录里会同时存在两个 exe），所以这里只校验「布局像 Electron
    // 应用」，具体是哪一个交给下面的显示名/文件名判定。
    const name = exePath.split(/[\\/]/).pop()?.toLowerCase() ?? ''
    if (!name.endsWith('.exe')) return false
    if (exeBasename === 'workbuddy.exe' && name === 'workbuddyai.exe') return false
    if (exeBasename === 'workbuddyai.exe' && name !== 'workbuddyai.exe') return false
    if (!existsSync(join(dir, 'resources', 'app.asar'))) return false
    return existsSync(join(dir, 'version'))
  } catch {
    return false
  }
}

/**
 * Windows 下从「添加/删除程序」的 Uninstall 键里找 App 安装位置。
 *
 * 关键是**同时读 `DisplayName`**：同一台机器上可能同时装着国内版和国际版，
 * 两个 App 的 exe 布局完全一样，只有注册表里的产品名能区分它们。
 *
 * @param exeBasename - 目标 exe 文件名（小写）。
 * @param displayNamePattern - 该产品在注册表里的显示名正则。
 * @returns 候选 exe 路径（去重）。
 */
async function discoverWindows(exeBasename, displayNamePattern) {
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  const found = new Set()
  for (const root of roots) {
    const text = await queryRegistry(root)
    if (text === undefined) continue
    // 按「一个子键一个块」解析：`reg query /s` 的输出是
    //   HKEY_...\{GUID}
    //       ValueName    REG_SZ    Value
    // 值之间的顺序并不保证（有的键 DisplayIcon 在 DisplayName 之前），所以先收集
    // 整块再判定，而不是边扫边配对。
    let block = { name: undefined, icon: undefined }
    const flush = () => {
      if (block.icon !== undefined && block.name !== undefined && displayNamePattern.test(block.name)) {
        found.add(block.icon)
      }
      block = { name: undefined, icon: undefined }
    }
    for (const line of text.split(/\r?\n/)) {
      if (/^HKEY_/i.test(line)) {
        flush()
        continue
      }
      const nameMatch = /^\s+DisplayName\s+REG_\w+\s+(.+)$/i.exec(line)
      if (nameMatch !== null) {
        block.name = nameMatch[1].trim()
        continue
      }
      const iconMatch = /^\s+DisplayIcon\s+REG_\w+\s+(.+)$/i.exec(line)
      if (iconMatch !== null) {
        const exe = exeFromDisplayIcon(iconMatch[1])
        if (exe !== undefined) block.icon = exe
      }
    }
    flush()
  }
  return [...found].filter((exe) => looksLikeApp(exe, exeBasename))
}

/**
 * 查询一个注册表根，失败重试一次。
 *
 * `reg.exe` 在并发 spawn 下偶发超时（这里三个根的输出合计约 250KB），而 HKCU 往往
 * 是唯一装着 WorkBuddy 的那个根 —— 一次超时就会让用户看到「找不到桌面端」。
 *
 * @param root - 注册表根路径。
 * @returns 输出文本，或 undefined（两次都失败）。
 */
async function queryRegistry(root) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 300))
    const output = await new Promise((resolve) => {
      execFile(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
        ['query', root, '/s'],
        { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
        (error, stdout) => resolve(error ? undefined : stdout),
      )
    })
    if (output !== undefined) return output.toString('utf8')
  }
  return undefined
}

/**
 * 解析该变体要用的 App 可执行文件。
 *
 * 顺序：显式配置 → 环境变量 → 本次进程已解析过的路径 → 平台默认路径 → 系统索引。
 * 显式配置与环境变量**不回落**：填错时立刻报 app-path-invalid，而不是偷偷换一个。
 *
 * 为什么要缓存：注册表查询要 spawn `reg.exe` 扫三个 Uninstall 根（实测 HKCU 19KB、
 * HKLM 89KB、WOW6432Node 143KB），在并发探测期间偶发超时。一旦某次超时，
 * 用户看到的就是「找不到桌面端」——而 App 明明装在那里。缓存 + 重试把这个抖动
 * 挡在用户视野之外。
 *
 * @param variant - VARIANTS 里的条目。
 * @param explicit - 设置里手填的路径。
 * @returns exe 绝对路径。
 * @throws {CredentialError} 找不到 / 有歧义 / 显式路径无效。
 */
export async function resolveAppBinary(variant, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    if (!looksLikeApp(explicit.trim(), variant.exeBasename)) {
      throw new CredentialError(
        REASON.appPathInvalid,
        `配置的 ${variant.id} 可执行文件不可用：${explicit.trim()}（需要同名 exe，且同目录下有 version 与 resources\\app.asar）`,
      )
    }
    return explicit.trim()
  }
  const fromEnv = process.env[variant.envElectron]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    if (!looksLikeApp(fromEnv.trim(), variant.exeBasename)) {
      throw new CredentialError(
        REASON.appPathInvalid,
        `环境变量 ${variant.envElectron} 指向的 ${variant.id} 可执行文件不可用：${fromEnv.trim()}`,
      )
    }
    return fromEnv.trim()
  }

  // 之前解析成功过、文件还在 → 直接用，不再扫注册表。
  const cached = resolvedBinaries.get(variant.id)
  if (cached !== undefined && looksLikeApp(cached, variant.exeBasename)) return cached

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    const defaults = [
      join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
      join(local, 'Programs', 'WorkBuddy AI', 'WorkBuddyAI.exe'),
    ]
    for (const candidate of defaults) {
      if (looksLikeApp(candidate, variant.exeBasename)) {
        resolvedBinaries.set(variant.id, candidate)
        knownAppDirs.add(dirname(candidate))
        return candidate
      }
    }

    // 已知安装目录兜底（注册表条目可能缺失或被更新器删掉）。
    const alias = variant.exeBasename === 'workbuddy.exe' ? ['WorkBuddy.exe', 'workbuddy.exe'] : ['WorkBuddyAI.exe', 'workbuddyai.exe']
    const siblings = []
    for (const dir of knownAppDirs) {
      siblings.push(dir)
      // 国际版与国内版常常并排装在同一层（D:\workbuddy 与 D:\WorkBuddy），
      // 所以也看看同级的同名目录。
      siblings.push(join(dirname(dir), basename(dir)))
    }
    const fromKnown = scanDirsForExecutable(siblings, variant.exeBasename, alias)
    if (fromKnown !== undefined) {
      resolvedBinaries.set(variant.id, fromKnown)
      knownAppDirs.add(dirname(fromKnown))
      return fromKnown
    }

    // 注册表扫描偶发超时（并发 spawn 时尤甚）——空结果重试一次再下结论。
    let discovered = await discoverWindows(variant.exeBasename, variant.displayNamePattern)
    if (discovered.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      discovered = await discoverWindows(variant.exeBasename, variant.displayNamePattern)
    }
    if (discovered.length === 1) {
      resolvedBinaries.set(variant.id, discovered[0])
      knownAppDirs.add(dirname(discovered[0]))
      return discovered[0]
    }
    if (discovered.length > 1) {
      throw new CredentialError(
        REASON.appAmbiguous,
        `找到多个 ${variant.id} 安装：\n${discovered.join('\n')}\n请在插件设置里指定要用的那一个。`,
      )
    }
    throw new CredentialError(
      REASON.appNotFound,
      `没有找到 ${variant.id} 桌面端。请在插件设置里填它的可执行文件路径，或设置环境变量 ${variant.envElectron}。`,
    )
  }

  if (process.platform === 'darwin') {
    const mac = variant.id === 'workbuddy' ? '/Applications/WorkBuddy.app/Contents/MacOS/Electron' : '/Applications/WorkBuddy AI.app/Contents/MacOS/Electron'
    if (existsSync(mac)) return mac
    throw new CredentialError(REASON.appNotFound, `没有找到 ${variant.id} 桌面端，请设置环境变量 ${variant.envElectron}。`)
  }

  throw new CredentialError(REASON.appNotFound, `当前平台不支持自动发现 ${variant.id} 桌面端，请设置环境变量 ${variant.envElectron}。`)
}

/**
 * 跑 App 自己的 Electron 取保护密钥载荷。
 * @param exePath - App 可执行文件。
 * @returns `{ version:1, atRestSecretKey }`。
 * @throws {CredentialError} 子进程失败或载荷不合规。
 */
function readAtRestPayload(exePath) {
  return new Promise((resolve, reject) => {
    execFile(
      exePath,
      ['-e', HELPER_SCRIPT],
      {
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        // 关键：让 Electron 以纯 Node 模式启动，不进 GUI。
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
      (error, stdout) => {
        if (error !== null && error !== undefined) {
          reject(
            new CredentialError(
              REASON.credentialUnreadable,
              `密钥助手（${exePath}）${
                error.killed === true ? '超时或被终止' : error.code !== undefined ? `退出码 ${String(error.code)}` : '无法启动'
              }；请确认 WorkBuddy 未以管理员身份独占运行，或打开一次 App 后重试。`,
              error,
            ),
          )
          return
        }
        const text = String(stdout ?? '').trim()
        if (text === '') {
          reject(new CredentialError(REASON.credentialUnreadable, `密钥助手（${exePath}）没有输出。`))
          return
        }
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch (cause) {
          reject(new CredentialError(REASON.credentialUnreadable, '密钥助手输出不是合法 JSON。', cause))
          return
        }
        const secret = parsed?.atRestSecretKey
        if (parsed?.version !== 1 || typeof secret !== 'string' || secret === '') {
          reject(
            new CredentialError(
              REASON.credentialUnreadable,
              '密钥助手返回的载荷不可用（期望 {version:1, atRestSecretKey}）；App 可能升级后改了私有绑定。',
            ),
          )
          return
        }
        resolve({ atRestSecretKey: secret })
      },
    )
  })
}

/**
 * 进程内缓存 at-rest 保护密钥，按 exe 路径。
 *
 * 为什么必须缓存：取密钥要 spawn 一次 App 的 Electron，实测单次约 260ms。
 * 设置卡片每 20 秒轮询一次状态，而状态里要显示登录情况 —— 不缓存就是
 * 「每 20 秒起两个 WorkBuddy 进程」，既费 CPU 又可能和真正的聊天请求抢资源。
 *
 * 密钥只在 App 重装/重新登录时才会变；真变了的话解密会失败，那时清掉缓存重取一次。
 */
const atRestKeys = new Map()

/**
 * 进程内缓存已解析的凭证，按「文件 + mtime + size」失效。
 *
 * App 只在登录/续期时重写这个文件，所以 mtime 变了就重读，没变就直接复用。
 */
const credentialCache = new Map()

/**
 * 取某个 App 的保护密钥（带缓存）。
 * @param exePath - App 可执行文件。
 * @returns 32 字节密钥。
 */
async function protectorKeyFor(exePath) {
  const cached = atRestKeys.get(exePath)
  if (cached !== undefined) return cached
  const payload = await readAtRestPayload(exePath)
  const key = createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest()
  atRestKeys.set(exePath, key)
  return key
}

/**
 * 清掉密钥缓存（密钥轮换后由解密失败路径调用）。
 * @param exePath - App 可执行文件。
 */
export function forgetAtRestKey(exePath) {
  atRestKeys.delete(exePath)
}

/**
 * 构造一个信封字段的 AAD，逐字节对应 App 的 `buildAuthenticatedContextAad`。
 * @param keyId - 信封里的 16 位十六进制 key id。
 * @param suite - 信封里的 suite（凭证字段恒为 1）。
 * @returns AAD 字节。
 */
function authenticatedContextAad(keyId, suite) {
  const prefix = Buffer.from('WB-AAD\0', 'ascii')
  const lengthPrefixed = (value) => {
    const bytes = Buffer.from(value, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  return Buffer.concat([
    prefix,
    Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/**
 * 用保护密钥解一个信封字段。
 * @param key - 32 字节保护密钥。
 * @param envelope - 内层信封。
 * @returns 明文字符串，或 undefined（解不开）。
 */
function openField(key, envelope) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(authenticatedContextAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * 解析一个字段：可能是明文，也可能是 `{$wbEncrypted:1, envelope}`。
 * @param value - 原始值。
 * @param key - 保护密钥（惰性求值：只有真遇到加密值才去 spawn App）。
 * @returns 明文，或 undefined。
 */
async function readField(value, key) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object' || value.$wbEncrypted !== 1 || typeof value.envelope !== 'string') {
    return undefined
  }
  const inner = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'))
  const protector = await key()
  const envelope = {
    suite: inner.suite,
    keyId: inner.keyId,
    nonce: Buffer.from(inner.nonce, 'base64'),
    authTag: Buffer.from(inner.authTag, 'base64'),
    ciphertext: Buffer.from(inner.ciphertext, 'base64'),
  }
  const plain = openField(protector, envelope)
  if (plain === undefined) {
    throw new CredentialError(
      REASON.credentialUnreadable,
      `WorkBuddy 凭证字段无法解密（信封 keyId ${String(inner.keyId)}）；App 可能换了一份 at-rest 密钥，打开一次 WorkBuddy 重新登录即可重封。`,
    )
  }
  return plain
}

/**
 * 把一个 `expiresAt` 归一成毫秒。上游两种单位都出现过。
 * @param value - 秒或毫秒。
 * @returns 毫秒时间戳，或 0。
 */
function expiryToMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value > 0xe8d4a51000 ? value : value * 1000
}

/**
 * 读取一个变体的桌面端凭证。
 *
 * @param variantId - `workbuddy` 或 `workbuddy-ai`。
 * @param options - `{ authFile?, electronPath? }`，均来自插件设置。
 * @returns 凭证对象。
 * @throws {CredentialError}
 */
export async function readDesktopCredential(variantId, options = {}) {
  const variant = VARIANTS[variantId]
  if (variant === undefined) throw new CredentialError(REASON.noCredential, `未知的 WorkBuddy 变体 ${variantId}`)

  const candidates = typeof options.authFile === 'string' && options.authFile.trim() !== ''
    ? [options.authFile.trim()]
    : authFileCandidates(variant)
  const file = candidates.find((candidate) => existsSync(candidate))
  if (file === undefined) {
    throw new CredentialError(
      REASON.noCredential,
      `没有找到 ${variant.id} 的登录文件（已找：${candidates.join(' / ')}）。请先打开 ${variant.id === 'workbuddy' ? 'WorkBuddy' : 'WorkBuddy AI'} 并登录。`,
    )
  }

  // 文件没变就直接复用上次解析结果：卡片轮询、目录刷新、额度读取会反复触发这里，
  // 每次都重新读盘+解密没有意义。用 mtime+size 判断变化，登录一次就自然失效。
  let stat
  try {
    stat = statSync(file)
  } catch {
    stat = undefined
  }
  if (stat !== undefined) {
    const cached = credentialCache.get(variant.id)
    if (
      cached !== undefined &&
      cached.file === file &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.credential
    }
  }

  let document
  try {
    document = JSON.parse(readFileSync(file, 'utf8'))
  } catch (cause) {
    throw new CredentialError(REASON.credentialUnreadable, `${file} 不是合法 JSON。`, cause)
  }

  // 惰性：只有遇到加密字段才去 spawn App，纯明文的老版本完全不触发子进程。
  let resolvedKey
  let resolvedExe
  const key = async () => {
    if (resolvedKey !== undefined) return resolvedKey
    resolvedExe = await resolveAppBinary(variant, options.electronPath)
    resolvedKey = await protectorKeyFor(resolvedExe)
    return resolvedKey
  }

  const auth = document?.auth !== null && typeof document?.auth === 'object' ? document.auth : document
  const account = document?.account !== null && typeof document?.account === 'object' ? document.account : {}

  let accessToken
  let refreshToken
  try {
    accessToken = await readField(auth?.accessToken, key)
    refreshToken = await readField(auth?.refreshToken, key)
  } catch (error) {
    // 缓存的密码可能是上一次安装的（App 重装/重新登录后 keyId 会变）：
    // 清掉再试一次，失败才当成真的读不到。
    if (error instanceof CredentialError && resolvedExe !== undefined) {
      forgetAtRestKey(resolvedExe)
      resolvedKey = undefined
      try {
        accessToken = await readField(auth?.accessToken, key)
        refreshToken = await readField(auth?.refreshToken, key)
      } catch (retryError) {
        if (retryError instanceof CredentialError) throw retryError
        throw new CredentialError(REASON.credentialUnreadable, `${file} 的凭证字段无法解析。`, retryError)
      }
    } else if (error instanceof CredentialError) {
      throw error
    } else {
      throw new CredentialError(REASON.credentialUnreadable, `${file} 的凭证字段无法解析。`, error)
    }
  }
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new CredentialError(REASON.noCredential, `${file} 里没有 accessToken。`)
  }

  const domain = typeof auth?.domain === 'string' ? auth.domain : ''
  const region = domain.includes('workbuddy.ai') ? 'global' : 'cn'
  if (region !== variant.region) {
    throw new CredentialError(
      REASON.regionMismatch,
      `${file} 是${region === 'global' ? '国际版' : '国内版'}的登录（domain=${domain || '(空)'}），不能用于 ${variant.id}。`,
    )
  }

  const credential = {
    variant: variant.id,
    region,
    uid: typeof account?.uid === 'string' ? account.uid : '',
    enterpriseId: typeof account?.enterpriseId === 'string' ? account.enterpriseId : '',
    domain,
    accessToken,
    refreshToken: typeof refreshToken === 'string' && refreshToken !== '' ? refreshToken : undefined,
    expiresAtMs: expiryToMs(auth?.expiresAt),
    refreshExpiresAtMs: expiryToMs(auth?.refreshExpiresAt),
    file,
  }

  if (stat !== undefined) {
    credentialCache.set(variant.id, { file, mtimeMs: stat.mtimeMs, size: stat.size, credential })
  }
  return credential
}

/**
 * 判断凭证是否该刷新。
 * @param credential - 凭证。
 * @param marginMs - 提前量。
 * @returns 是否需要刷新。
 */
export function needsRefresh(credential, marginMs = REFRESH_MARGIN_MS) {
  if (credential.refreshToken === undefined) return false
  if (credential.expiresAtMs <= 0) return false
  return Date.now() + marginMs >= credential.expiresAtMs
}

/**
 * 用 refresh token 换新 access token。
 *
 * 端点只认 `X-Refresh-Token`，**没有 body**；失败时只要旧 token 还没过期就继续用
 * 旧的（一个临时不可达的刷新端点不该把还能用的会话打死）。
 *
 * @param credential - 旧凭证。
 * @param signal - 取消。
 * @returns 合并后的凭证。
 */
export async function refreshDesktopCredential(credential, signal) {
  const variant = VARIANTS[credential.variant]
  if (credential.refreshToken === undefined) return credential
  try {
    const response = await fetch(`${variant.chatBase}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: variant.webBase,
        Referer: `${variant.webBase}/`,
        'User-Agent': `WorkBuddy/${readAppVersion(variant)}`,
        'X-Refresh-Token': credential.refreshToken,
        'X-Auth-Refresh-Source': 'workbuddy',
        ...(credential.enterpriseId === '' ? {} : { 'X-Enterprise-Id': credential.enterpriseId }),
      },
      signal: signal ?? AbortSignal.timeout(30_000),
    })
    const envelope = await response.json().catch(() => undefined)
    const data = envelope?.data
    const accessToken = typeof data?.accessToken === 'string' ? data.accessToken : ''
    if (!response.ok || accessToken === '') throw new Error(`refresh rejected (http ${String(response.status)})`)
    return {
      ...credential,
      accessToken,
      refreshToken: typeof data?.refreshToken === 'string' && data.refreshToken !== '' ? data.refreshToken : credential.refreshToken,
      expiresAtMs: typeof data?.expiresIn === 'number' && data.expiresIn > 0 ? Date.now() + data.expiresIn * 1000 : credential.expiresAtMs,
    }
  } catch (error) {
    if (credential.expiresAtMs > Date.now() + 30_000) return credential
    throw new CredentialError(REASON.credentialExpired, 'WorkBuddy 会话已过期且刷新失败，请在 App 里重新登录。', error)
  }
}

/** 缓存一次 App 版本号，只用于 User-Agent。 */
let cachedVersion
/**
 * 读 App 的 `version` 文件（形如 `37.10.3-24` 的 Electron 版本，不是产品版本）。
 * @param variant - 变体。
 * @returns 版本字符串。
 */
function readAppVersion(variant) {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    const exe = process.env[variant.envElectron]
    const dir = exe === undefined ? undefined : dirname(exe)
    if (dir !== undefined) {
      const raw = readFileSync(join(dir, 'version'), 'utf8').trim()
      if (/^\d+\.\d+\.\d+/.test(raw)) {
        cachedVersion = raw
        return raw
      }
    }
  } catch {
    /* 版本号只影响 UA，读不到就用兜底值 */
  }
  cachedVersion = variant.region === 'global' ? '5.5.2' : '5.5.6'
  return cachedVersion
}

/**
 * 该变体的上游基址与 web 基址。
 * @param variantId - 变体。
 * @returns `{ chatBase, webBase }`。
 */
export function endpointsFor(variantId) {
  const variant = VARIANTS[variantId]
  return { chatBase: variant.chatBase, webBase: variant.webBase }
}

/**
 * 探测一个变体的登录状态（不消耗模型额度）。
 * @param variantId - 变体。
 * @param options - 设置。
 * @returns `{ status, credential?, reason?, message? }`。
 */
export async function probeDesktopLogin(variantId, options = {}) {
  try {
    const credential = await readDesktopCredential(variantId, options)
    return {
      status: 'signed-in',
      credential: {
        uid: credential.uid,
        domain: credential.domain,
        expiresAtMs: credential.expiresAtMs,
        file: credential.file,
      },
    }
  } catch (error) {
    if (error instanceof CredentialError) {
      return { status: 'signed-out', reason: error.code, message: error.message }
    }
    return { status: 'signed-out', reason: REASON.credentialUnreadable, message: String(error) }
  }
}
