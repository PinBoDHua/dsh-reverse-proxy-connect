/**
 * 模型目录的磁盘缓存。
 *
 * 为什么需要：目录只存在内存时，每次重启都要重新向上游要一遍。上游不可达、
 * 或者用户只是断网打开 DSH 时，选择器就会退化到内置兜底清单（每边只有 4 个模型），
 * 看起来像「插件把我的模型弄丢了」。
 *
 * 把最后一份**成功**目录按「provider + 账号」落盘后，重启第一帧就有完整清单，
 * 卡片上的来源会标成「已缓存」；后台刷新成功后自然替换。
 *
 * 缓存是可选的：设置里 `advanced.catalogCache === false` 时不读也不写。
 *
 * @module dsh-reverse-proxy-connect/catalog-cache
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { readTextFile, writeJsonAtomic } from './atomic.js'
import { PROVIDER_IDS } from './protocol.js'

/** 文件名。 */
const FILE = 'catalog-cache.json'

/** 格式版本。 */
const VERSION = 1

/** 超过这个年龄的目录不再使用：模型上下线很快，一个月前的清单会误导人。 */
const MAX_AGE_MS = 30 * 24 * 3600_000

/** 单个 provider 最多缓存的模型数。 */
const MAX_MODELS = 300

/** 最多缓存的 provider::account 条目数。 */
const MAX_ENTRIES = 24

/** 允许的思考档位。 */
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** 安全字符串。 */
function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

/** 安全正整数。 */
function positive(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * 归一化一条缓存的模型行。
 *
 * 目录缓存是「外部数据」：文件可能被手改、被别的版本写过。这里只保留插件真的
 * 会用的字段，并把所有数字收敛到合法范围 —— 一条坏行不该让整个目录不可用。
 *
 * @param raw - 原始行。
 * @returns 模型行，或 undefined。
 */
export function normalizeCachedModel(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const id = str(raw.id, 200)
  if (id === undefined || id === '') return undefined
  const name = str(raw.name, 200)
  const contextWindow = positive(raw.contextWindow)
  const maxTokens = positive(raw.maxTokens)
  if (contextWindow === undefined || maxTokens === undefined) return undefined
  const efforts = Array.isArray(raw.reasoningEfforts)
    ? [...new Set(raw.reasoningEfforts.filter((effort) => typeof effort === 'string' && EFFORTS.has(effort)))]
    : []
  const defaultEffort = typeof raw.defaultEffort === 'string' && efforts.includes(raw.defaultEffort) ? raw.defaultEffort : undefined
  let contextOptions
  if (raw.contextOptions !== null && typeof raw.contextOptions === 'object' && !Array.isArray(raw.contextOptions)) {
    const entries = []
    for (const [key, value] of Object.entries(raw.contextOptions).slice(0, 20)) {
      if (value === null || typeof value !== 'object') continue
      const tokenCount = positive(value.tokenCount)
      if (tokenCount === undefined) continue
      entries.push([key.slice(0, 40), { tokenCount, isDefault: value.isDefault === true }])
    }
    if (entries.length > 0) contextOptions = Object.fromEntries(entries)
  }
  const credits = str(raw.credits, 40)
  return {
    id,
    name: name === undefined || name === '' ? id : name,
    contextWindow,
    maxTokens,
    supportsImages: raw.supportsImages === true,
    supportsReasoning: raw.supportsReasoning === true,
    onlyReasoning: raw.onlyReasoning === true,
    reasoningEfforts: efforts,
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    canDisableThinking: raw.canDisableThinking === true,
    ...(credits === undefined ? {} : { credits }),
    ...(contextOptions === undefined ? {} : { contextOptions }),
    ...(raw.virtual === true ? { virtual: true } : {}),
    ...(raw.fallback === true ? { fallback: true } : {}),
    ...(typeof raw.source === 'string' ? { source: raw.source.slice(0, 40) } : {}),
  }
}

/**
 * 读现有缓存文件的格式版本。
 *
 * 返回 `undefined` 有两种情况：文件不存在、或文件坏到无法解析。两者都允许
 * 后续写回修复；只有「能解析且 version 高于当前版本」才必须拒绝覆盖。
 *
 * @param file - 缓存文件绝对路径。
 * @returns 版本号，或 undefined。
 */
function existingVersion(file) {
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readTextFile(file))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    return typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : undefined
  } catch {
    // 坏文件：当前版本可以重写修复，不在这里拦截。
    return undefined
  }
}

/**
 * 读目录缓存。
 * @param dataDir - 插件数据目录。
 * @returns Map，键是 `provider::accountId`，值是 `{models, fetchedAt}`。
 *   未来版本写过的文件会带上 `writeBlocked = true`，调用方（saveCatalogCache）拒绝覆盖。
 */
export function loadCatalogCache(dataDir) {
  const out = new Map()
  if (typeof dataDir !== 'string' || dataDir === '') return out
  const file = join(dataDir, FILE)
  if (!existsSync(file)) return out
  let raw
  try {
    raw = JSON.parse(readTextFile(file))
  } catch {
    // 坏文件：允许下一次成功刷新用合法内容把它修复。
    return out
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : undefined
  if (version !== undefined && version > VERSION) {
    // 更新版本的插件写过的缓存：字段语义可能已经变了，绝不能降级覆盖它。
    out.writeBlocked = true
    out.unsupportedVersion = version
    return out
  }
  if (version !== undefined && version !== VERSION) return out
  const entries = raw.entries
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return out
  const now = Date.now()
  for (const [key, entry] of Object.entries(entries).slice(0, MAX_ENTRIES)) {
    if (typeof key !== 'string') continue
    const [provider, accountId] = key.split('::')
    if (!PROVIDER_IDS.includes(provider) || accountId === undefined || accountId === '') continue
    if (entry === null || typeof entry !== 'object') continue
    const fetchedAt = typeof entry.fetchedAt === 'number' && Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : 0
    if (fetchedAt <= 0 || now - fetchedAt > MAX_AGE_MS) continue
    const models = Array.isArray(entry.models) ? entry.models.map(normalizeCachedModel).filter((model) => model !== undefined).slice(0, MAX_MODELS) : []
    if (models.length === 0) continue
    out.set(key, { models, fetchedAt })
  }
  return out
}

/**
 * 写目录缓存。
 *
 * 只存有模型的条目；失败安静返回 false（缓存坏了不该影响聊天）。
 * 若磁盘上的现有文件来自更高版本的插件，拒绝覆盖（返回 false）——降级安装时
 * 不能把未来版本的缓存降级成当前格式。坏文件仍允许重写修复。
 *
 * @param dataDir - 插件数据目录。
 * @param entries - `Map<provider::accountId, {models, fetchedAt}>`。
 * @returns 是否写成功。
 */
export function saveCatalogCache(dataDir, entries) {
  if (typeof dataDir !== 'string' || dataDir === '' || entries === undefined) return false
  if (entries.writeBlocked === true) return false
  const file = join(dataDir, FILE)
  const currentVersion = existingVersion(file)
  if (currentVersion !== undefined && currentVersion > VERSION) return false
  const payload = {}
  let count = 0
  for (const [key, entry] of entries) {
    if (count >= MAX_ENTRIES) break
    if (typeof key !== 'string' || !key.includes('::')) continue
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.models) || entry.models.length === 0) continue
    const models = entry.models.map(normalizeCachedModel).filter((model) => model !== undefined).slice(0, MAX_MODELS)
    if (models.length === 0) continue
    payload[key] = {
      models,
      fetchedAt: typeof entry.fetchedAt === 'number' && Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : Date.now(),
    }
    count += 1
  }
  return writeJsonAtomic(file, { version: VERSION, entries: payload })
}
