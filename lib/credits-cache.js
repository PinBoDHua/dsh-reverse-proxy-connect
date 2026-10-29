/**
 * 额度快照的磁盘缓存。
 *
 * 为什么需要：额度是网络请求，冷启动时至少几百毫秒、慢的时候几秒。而侧栏小卡
 * 一挂载就会读 `/status` —— 那会儿内存里什么都没有，于是「DSH 都开了 10 秒，
 * 积分才出现」。把上一次成功的快照落到磁盘，启动瞬间就能显示上次的数字，
 * 后台再刷新，观感上就没有空窗期。
 *
 * 缓存只读不改语义：写盘失败、文件损坏、字段过期，全部安静退化成「没有缓存」，
 * 绝不能让额度这种东西把插件搞挂。
 *
 * @module dsh-reverse-proxy-connect/credits-cache
 */

import { join } from 'node:path'

import { readJsonFile, writeJsonAtomic } from './atomic.js'

/** 缓存文件名。 */
const FILE = 'credits-cache.json'

/** 缓存文件格式版本。旧版本是无 version 的裸 provider map，仍然兼容读取。 */
const VERSION = 1

/**
 * 超过这个年龄的缓存不再展示：一周前的余额看着像真的，其实早就不作数了。
 */
const MAX_AGE_MS = 7 * 24 * 3600_000

/**
 * 归一化磁盘里的额度快照：只保留卡片认识的字段与数组元素。
 *
 * credits-cache 是「外部数据」：可能被手改、被旧版本写过。1.2.0 只检查
 * `state === 'ok'`，于是 `items:[null]` 这类坏行会原样进 /status，客户端
 * 渲染明细时直接抛 TypeError，整张设置卡片被宿主的 SlotErrorBoundary 替换。
 *
 * @param data - 缓存里的 data。
 * @returns 可安全展示的额度快照。
 */
function normalizeCachedCredits(data) {
  const out = { ...data }
  out.items = Array.isArray(data.items)
    ? data.items
        .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
        .filter((item) => typeof item.name === 'string' || (typeof item.remain === 'number' && Number.isFinite(item.remain)))
        .slice(0, 50)
        .map((item) => ({
          name: typeof item.name === 'string' && item.name !== '' ? item.name.slice(0, 120) : '额度包',
          remain: typeof item.remain === 'number' && Number.isFinite(item.remain) ? item.remain : 0,
          total: typeof item.total === 'number' && Number.isFinite(item.total) ? item.total : 0,
          ...(typeof item.endAtMs === 'number' && Number.isFinite(item.endAtMs) ? { endAtMs: item.endAtMs } : {}),
          ...(item.expired === true ? { expired: true } : {}),
          // 企业账号的「不限量」包：不保留这个标记时，卡片主值写着 ∞，
          // 展开的套餐明细却显示「0 / 0」——同一份快照自相矛盾。
          ...(item.unlimited === true ? { unlimited: true } : {}),
        }))
    : []
  // 数字字段一律收敛成有限数：坏缓存里的 "x" / null 会让卡片算出 NaN，
  // 渲染出来是「NaN / NaN」且进度条宽度变成非法 CSS。
  for (const key of ['remain', 'total', 'used', 'resetAtMs', 'fetchedAt']) {
    if (out[key] !== undefined && (typeof out[key] !== 'number' || !Number.isFinite(out[key]))) delete out[key]
  }
  // 布尔与字符串同样只保留认识的形态，避免 `credits.paid === false` 之类的判定被 "false" 骗过。
  for (const key of ['exceeded', 'stale', 'unlimited', 'freePlan']) {
    if (out[key] !== undefined && typeof out[key] !== 'boolean') delete out[key]
  }
  if (out.paid !== undefined && typeof out.paid !== 'boolean') delete out.paid
  for (const key of ['unit', 'planName', 'error', 'message']) {
    if (out[key] !== undefined && typeof out[key] !== 'string') delete out[key]
  }
  return out
}

/**
 * 读缓存。
 * @param dataDir - 插件数据目录。
 * @returns provider → `{data, fetchedAt}`，读不到就是空 Map。
 */
export function loadCreditsCache(dataDir) {
  const out = new Map()
  // 已删除账号的墓碑：落盘合并时会重新读磁盘，光删内存里的 key 会被
  // 「保存时与磁盘合并」的逻辑原样写回来。墓碑跟着缓存一起持久化。
  out.forgotten = new Set()
  // 复活集合：账号重新出现并读到额度后，要从墓碑里**永久**摘掉。
  // 只在内存里记「这次保存要摘掉谁」，落盘成功后清空。
  out.revived = new Set()
  if (typeof dataDir !== 'string' || dataDir === '') return out
  const raw = readJsonFile(join(dataDir, FILE))
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  // 新格式是 `{version:1, entries}`；旧格式是裸 provider map。遇到未来版本
  // 不要按当前字段硬读（可能把不同语义的值当成余额），并标记只读：
  // 否则下一次落盘会把它整份覆盖成当前版本的空/子集（降级安装就会丢快照）。
  if (raw.version !== undefined && raw.version !== VERSION) {
    if (typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version > VERSION) {
      out.writeBlocked = true
      out.unsupportedVersion = raw.version
    }
    return out
  }
  const entries = raw.version === VERSION && raw.entries !== null && typeof raw.entries === 'object' && !Array.isArray(raw.entries)
    ? raw.entries
    : raw.version === undefined ? raw : {}
  const now = Date.now()
  for (const rawKey of Array.isArray(raw.forgotten) ? raw.forgotten : []) {
    if (typeof rawKey === 'string' && rawKey !== '') out.forgotten.add(rawKey)
  }
  for (const [rawKey, entry] of Object.entries(entries)) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.data === null || typeof entry.data !== 'object') continue
    if (entry.data.state !== 'ok') continue
    const fetchedAt = typeof entry.fetchedAt === 'number' ? entry.fetchedAt : 0
    if (fetchedAt <= 0 || now - fetchedAt > MAX_AGE_MS) continue
    // 老格式的键是纯 provider（`workbuddy`），新版是 `provider::账号`。
    // 老格式一律视为默认账号，升级后第一帧仍然有数字可显示。
    const key = rawKey.includes('::') ? rawKey : `${rawKey}::default`
    // 墓碑必须在这里就过滤掉：删除账号时写下的 `forgotten` 是为了「删号后
    // 重启也别把旧余额带回来」。只在保存时清理不够 —— 冷启动的 /status 会
    // 直接读内存 Map，同 id（特别是隐式的 `default`）的新账号会先显示上一个
    // 账号的余额，直到下一轮刷新。catalog-cache 早已按同一规则处理。
    if (out.forgotten.has(key) || out.forgotten.has(rawKey)) continue
    out.set(key, { data: normalizeCachedCredits(entry.data), fetchedAt, stale: true })
  }
  return out
}

/**
 * 写缓存。只存成功快照 —— 错误态存下来毫无意义。
 * @param dataDir - 插件数据目录。
 * @param entries - provider → `{data, fetchedAt}`。
 * @returns 是否写成功（失败不抛）。
 */
export function saveCreditsCache(dataDir, entries) {
  if (typeof dataDir !== 'string' || dataDir === '' || entries === undefined) return false
  // 更高版本写过的缓存：拒绝覆盖（与 catalog-cache / stats / settings 一致）。
  // `loadCreditsCache()` 读到未来版本时会在这个 Map 上打标记；这里再查一次
  // 磁盘，是因为调用方也可能传一个新建的 Map（例如「关闭后重新加载」的路径）。
  if (entries?.writeBlocked === true) return false
  const file = join(dataDir, FILE)
  const currentVersion = existingCreditsCacheVersion(file)
  if (currentVersion !== undefined && currentVersion > VERSION) return false
  const payload = {}
  for (const [provider, entry] of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.data === null || typeof entry.data !== 'object') continue
    if (entry.data.state !== 'ok') continue
    payload[provider] = { data: entry.data, fetchedAt: entry.fetchedAt }
  }
  // 落盘前与磁盘上**已有的**快照按 key 合并，而不是整份覆盖。
  //
  // 这份缓存会被两个进程同时写：宿主每 2 分钟刷新一次，CLI（`bin.js credits` /
  // `doctor`）也会刷新并在退出时落盘。两边各自从同一份基线起算，谁后写谁就把
  // 对方刚拿到的快照整份抹掉 —— 典型跨进程 lost update（用户看到卡片上的额度
  // 又变回上一次刷新前的数字）。合并规则与 `stats.js` 一致：同一个 key 保留
  // `fetchedAt` 更新的那一份。
  const onDisk = readJsonFile(file)
  const existing = onDisk !== null && typeof onDisk === 'object' && !Array.isArray(onDisk)
    && onDisk.entries !== null && typeof onDisk.entries === 'object' && !Array.isArray(onDisk.entries)
    ? onDisk.entries
    : {}
  const merged = { ...existing }
  for (const [key, value] of Object.entries(payload)) {
    const previous = merged[key]
    const previousAt = previous !== null && typeof previous === 'object'
      && typeof previous.fetchedAt === 'number' && Number.isFinite(previous.fetchedAt)
      ? previous.fetchedAt
      : 0
    const nextAt = typeof value.fetchedAt === 'number' && Number.isFinite(value.fetchedAt) ? value.fetchedAt : 0
    if (previous !== undefined && previousAt > nextAt) continue
    merged[key] = value
  }
  // 删除账号时写下的墓碑：合并进来的条目、以及磁盘上遗留的同 key 条目都要
  // 丢掉，否则「删除 → 重新配置」会让新账号继承已删除账号的余额。
  const forgotten = new Set()
  for (const key of Array.isArray(onDisk?.forgotten) ? onDisk.forgotten : []) {
    if (typeof key === 'string' && key !== '') forgotten.add(key)
  }
  for (const key of entries?.forgotten instanceof Set ? entries.forgotten : []) {
    if (typeof key === 'string' && key !== '') forgotten.add(key)
  }
  // 复活：账号重新读到额度后，墓碑必须从磁盘上也摘掉。只从内存 Set 里删不够 ——
  // 下一次保存会把磁盘上的旧墓碑并回来，于是新快照又被删掉、永远写不进缓存。
  for (const key of entries?.revived instanceof Set ? entries.revived : []) {
    forgotten.delete(key)
  }
  for (const key of forgotten) delete merged[key]
  // 只保留成功快照（外部写入的坏行也顺手丢掉）。
  const clean = {}
  for (const [key, value] of Object.entries(merged)) {
    if (forgotten.has(key)) continue
    if (value === null || typeof value !== 'object') continue
    if (value.data === null || typeof value.data !== 'object') continue
    if (value.data.state !== 'ok') continue
    clean[key] = value
  }
  const ok = writeJsonAtomic(file, { version: VERSION, entries: clean, forgotten: [...forgotten].slice(-200) })
  // 落盘成功后这次「复活」已经反映到磁盘，内存里不用再记；失败则保留，下次重试。
  if (ok && entries?.revived instanceof Set) entries.revived.clear()
  return ok
}

/**
 * 磁盘上现有缓存的格式版本（读不到 / 不是 JSON 对象时 undefined）。
 *
 * 坏文件返回 undefined：允许下一次成功落盘把它修好；只有「解析得出且版本更高」
 * 才必须拒绝覆盖。
 *
 * @param file - 缓存文件的绝对路径。
 * @returns 版本号，或 undefined。
 */
function existingCreditsCacheVersion(file) {
  const raw = readJsonFile(file)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : undefined
}
