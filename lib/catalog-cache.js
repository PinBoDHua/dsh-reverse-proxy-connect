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
  // 删除墓碑：账号被删后它的目录不能再从磁盘/另一个进程的合并里复活。
  // 与 `credits-cache.js` / `credit-history.js` 同一套做法。
  out.forgotten = new Set(
    (Array.isArray(raw.forgotten) ? raw.forgotten : []).filter((key) => typeof key === 'string' && key !== ''),
  )
  const entries = raw.entries
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return out
  const now = Date.now()
  // 先**逐条校验**、再截断到 MAX_ENTRIES。
  //
  // 旧实现先 `Object.entries(...).slice(0, MAX_ENTRIES)` 再逐条过滤：24 条过期
  // （或坏行）恰好排在前面就能把唯一有效的那条挤出窗口，于是断网重启时模型
  // 选择器退回内置兜底（每家只有 4 个模型），而磁盘上明明还有完整目录。
  const valid = []
  let order = 0
  for (const [key, entry] of Object.entries(entries)) {
    if (typeof key !== 'string') continue
    const [provider, accountId] = key.split('::')
    if (!PROVIDER_IDS.includes(provider) || accountId === undefined || accountId === '') continue
    if (out.forgotten.has(key)) continue
    if (entry === null || typeof entry !== 'object') continue
    const fetchedAt = typeof entry.fetchedAt === 'number' && Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : 0
    if (fetchedAt <= 0 || now - fetchedAt > MAX_AGE_MS) continue
    const models = Array.isArray(entry.models) ? entry.models.map(normalizeCachedModel).filter((model) => model !== undefined).slice(0, MAX_MODELS) : []
    if (models.length === 0) continue
    valid.push({ key, value: { models, fetchedAt }, order: order++ })
  }
  // 超过上限时保留**最新**的条目（按 fetchedAt 倒序），而不是文件里最先写入的。
  // `fetchedAt` 相同时（同一轮刷新写下的多个账号）用写入顺序做 tie-break：
  // 后写入的是更晚连接的账号，丢掉它比丢掉老账号更糟。稳定排序本身会保留
  // 插入顺序，所以这里显式把 order 倒过来比较。
  valid.sort((a, b) => (b.value.fetchedAt - a.value.fetchedAt) || (b.order - a.order))
  for (const entry of valid.slice(0, MAX_ENTRIES)) out.set(entry.key, entry.value)
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
  // 删除墓碑（本进程 + 磁盘上的）：被删账号的目录**绝不能**再从合并里复活，
  // 否则连「删账号」都会在重启后把它的模型带回选择器。
  const forgotten = new Set(
    (entries.forgotten instanceof Set ? [...entries.forgotten] : []).filter((key) => typeof key === 'string' && key !== ''),
  )
  // 复活的 key：账号重新出现并成功拉到目录。它们要从磁盘墓碑里摘掉，
  // 否则新目录会只存在内存里，重启后又被过滤掉。
  const revived = new Set(
    (entries.revived instanceof Set ? [...entries.revived] : []).filter((key) => typeof key === 'string' && key !== ''),
  )
  for (const key of revived) forgotten.delete(key)
  // 超过 MAX_ENTRIES 时保留**最新**的条目：按写入顺序 `break` 会把刚刷新的
  // 账号丢掉、留下几个月前的旧目录（用户新加的账号反而不进选择器）。
  const candidates = []
  let order = 0
  for (const [key, entry] of entries) {
    if (typeof key !== 'string' || !key.includes('::')) continue
    if (forgotten.has(key)) continue
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.models) || entry.models.length === 0) continue
    const models = entry.models.map(normalizeCachedModel).filter((model) => model !== undefined).slice(0, MAX_MODELS)
    if (models.length === 0) continue
    candidates.push({
      key,
      value: {
        models,
        fetchedAt: typeof entry.fetchedAt === 'number' && Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : Date.now(),
      },
      order: order++,
      // 本地条目 = 这一次刷新真正拿到的目录，同时间戳时优先保留。
      local: true,
    })
  }
  // 跨进程合并：宿主与 CLI（或两个窗口）各自持有一份内存快照，整份覆盖会把
  // 对方刚缓存的账号目录静默抹掉 —— 断网重启后那一家就退回内置兜底。
  // 与 `saveCreditsCache()` 同一套做法：先读磁盘，逐 key 取 `fetchedAt` 更新的
  // 那一份，再写回。磁盘文件不可读/版本更高时前面已经拒绝或按空处理。
  const disk = new Map()
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readTextFile(file))
      const version = raw !== null && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.version === 'number' ? raw.version : VERSION
      if (version === VERSION) {
        // 磁盘上的墓碑也要采纳并继续写回（否则本进程保存时会把它们抹掉）。
        // 本次刚复活（真拉到目录）的 key 除外。
        for (const key of Array.isArray(raw.forgotten) ? raw.forgotten : []) {
          if (typeof key === 'string' && key !== '' && !revived.has(key)) forgotten.add(key)
        }
        const diskEntries = raw.entries
        if (diskEntries !== null && typeof diskEntries === 'object' && !Array.isArray(diskEntries)) {
          const now = Date.now()
          for (const [key, entry] of Object.entries(diskEntries)) {
            if (typeof key !== 'string' || !key.includes('::')) continue
            if (forgotten.has(key)) continue
            if (entry === null || typeof entry !== 'object') continue
            const fetchedAt = typeof entry.fetchedAt === 'number' && Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : 0
            if (fetchedAt <= 0 || now - fetchedAt > MAX_AGE_MS) continue
            const models = Array.isArray(entry.models) ? entry.models.map(normalizeCachedModel).filter((model) => model !== undefined).slice(0, MAX_MODELS) : []
            if (models.length === 0) continue
            disk.set(key, { models, fetchedAt })
          }
        }
      }
    }
  } catch {
    // 坏文件：按「磁盘上没有可合并的条目」处理，让这次写入把它修好。
  }
  for (const [key, value] of disk) {
    const local = candidates.find((candidate) => candidate.key === key)
    if (local === undefined) {
      // 只有磁盘有：标成 `local: false`。同 `fetchedAt` 时本地优先（见下方排序），
      // 因为本地这一份是**这一次刷新**刚写进来的。
      candidates.push({ key, value, order: order++, local: false })
      continue
    }
    // 两边都有：留更晚抓取的那份（同时间戳时留本进程的，它刚刷新过）。
    if (value.fetchedAt > local.value.fetchedAt) local.value = value
    local.local = true
  }
  // 与 loadCatalogCache 同一套排序：fetchedAt 倒序。
  //
  // 同 `fetchedAt` 时**本地条目优先**：它们来自这一次刷新（`saveCatalogCache`
  // 的 `entries` 参数），而磁盘上的那些只是别的进程上次留下的。旧实现用
  // `order` 做 tie-break，而本地条目的 order 更小 → 恰好在上限边缘把刚刷新的
  // 账号挤掉，用户新加的账号又进不了选择器（正是这个函数注释里说要避免的事）。
  candidates.sort((a, b) => (b.value.fetchedAt - a.value.fetchedAt) || (Number(b.local) - Number(a.local)) || (b.order - a.order))
  // 墓碑可能在读磁盘之后才被合并进来：必须**先**过滤再截断，否则一个已删账号
  // 的旧条目会占着 MAX_ENTRIES 名额，把刚刷新成功的活账号挤出缓存。
  const kept = candidates.filter((candidate) => !forgotten.has(candidate.key))
  for (const candidate of kept.slice(0, MAX_ENTRIES)) payload[candidate.key] = candidate.value
  // 墓碑随文件落盘：删账号那一刻写下的「不要再加载这个 key」必须活过重启，
  // 否则重启后 loadCatalogCache 又会把已删账号的目录读回来（实测：删完重启，
  // 已删账号的模型重新出现在选择器里）。
  const ok = writeJsonAtomic(file, {
    version: VERSION,
    entries: payload,
    ...(forgotten.size === 0 ? {} : { forgotten: [...forgotten] }),
  })
  // 落盘成功后这次「复活」已经反映到磁盘，内存里不用再记；失败则保留，下次重试。
  if (ok && entries.revived instanceof Set) entries.revived.clear()
  return ok
}
