// 客户端组件测试：侧栏积分小卡（内嵌面板）。
//
// 这里验证的是「用户实际踩过的坑」：
//   1. 挂载后能显示版本号；
//   2. 面板默认收起，点胶囊才展开；
//   3. 面板宽度是 100%（内嵌），不是 fixed 悬浮 —— 悬浮那版会越过侧栏压到对话区；
//   4. 面板里有可点的「刷新积分」按钮，点了会真的发请求；
//   5. 余额为 0 的账号亮警示色，675 / 99 不亮。
//
// 用法：
//   node tests/client-credits.mjs
//   BUG=1 node tests/client-credits.mjs   # 注入「fixed 悬浮」回归，应失败

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const CLIENT_PATH = new URL('../client/client.js', import.meta.url)
let source = readFileSync(CLIENT_PATH, 'utf8')

if (process.env.BUG === '1') {
  const before = source
  // 把面板宽度改成 fixed 悬浮，模拟 0.4.6 之前的行为。
  source = source.replace(
    "              width: '100%',\n              boxSizing: 'border-box',\n              border: '0.5px solid var(--dsw-alias-border-l2)',",
    "              position: 'fixed',\n              width: 296,\n              boxSizing: 'border-box',\n              border: '0.5px solid var(--dsw-alias-border-l2)',",
  )
  if (source === before) throw new Error('注入回归失败：找不到面板宽度那一行')
  console.log('（已注入 fixed 悬浮回归，预期失败）')
}

// ---------- 迷你 hooks ----------
let hookStates = []
let hookIndex = 0
let effects = []
let dirty = false
let ownerSeq = 0
let activeOwner = 0
let dirtyOwners = new Set()
/** 本次渲染已调用的 hook 数量，以及上一次渲染的总数（用于顺序校验）。 */
let hookCallCount = 0
let lastHookCallCount = null

function beginRender() {
  activeOwner = ++ownerSeq
  hookIndex = 0
  refIndex = 0
  hookCallCount = 0
  effects = []
  dirty = false
  return activeOwner
}

/**
 * 记录一次 hook 调用，并校验「两次渲染之间 hook 数量不增加」。
 *
 * React 要求同一个组件每次渲染调用**相同数量、相同顺序**的 hook；违反时会抛
 * "Rendered more hooks than during the previous render"，宿主的错误边界把整张
 * 卡片替换成空白。之前的迷你 React 只按序号取值、没有这个约束，于是「hook 写在
 * 条件 return 之后」这类真实事故测不出来（0.4.2 就踩了：首帧 status 未到提前
 * return，状态到达后多调用一个 useEffect，设置卡片整块空白）。
 *
 * @param kind - hook 名称，仅用于报错信息。
 */
function countHook(kind) {
  hookCallCount += 1
  if (lastHookCallCount !== null && hookCallCount > lastHookCallCount) {
    throw new Error(
      `hook 数量在两次渲染之间增加了（第 ${hookCallCount} 个 ${kind}）：`
      + '说明有 hook 写在条件 return 之后，真实 React 会整卡崩溃',
    )
  }
}

/**
 * 一次渲染结束时校验 hook 总数与上次**完全相同**。
 *
 * React 对「变少」同样报错（Rendered fewer hooks than expected），两种方向都会
 * 让宿主的错误边界把整张卡片替换成空白，所以两边都要拦。
 */
function assertHookCountStable() {
  if (lastHookCallCount === null) return
  if (hookCallCount !== lastHookCallCount) {
    throw new Error(
      `hook 数量在两次渲染之间变化（${lastHookCallCount} -> ${hookCallCount}）：`
      + '说明有 hook 写在条件 return 之后，真实 React 会整卡崩溃',
    )
  }
}

function useState(initial) {
  countHook('useState')
  const index = hookIndex++
  if (!(index in hookStates)) hookStates[index] = { value: typeof initial === 'function' ? initial() : initial, owner: activeOwner }
  const slot = hookStates[index]
  const set = (value) => {
    const next = typeof value === 'function' ? value(slot.value) : value
    if (next !== slot.value) {
      slot.value = next
      dirty = true
      dirtyOwners.add(slot.owner)
    }
  }
  return [slot.value, set]
}

function createElement(type, props, ...children) {
  if (type === undefined || type === null) throw new Error('createElement 收到空组件')
  const raw = props ?? {}
  // 真实 React 会把 key 从 props 里摘走，放到 element.key 上。测试也照做，
  // 否则「按 props.key 给分区归页」这类真实环境才会犯的错测不出来。
  const key = raw.key
  const cleaned = { ...raw }
  delete cleaned.key
  return { type, key, props: cleaned, children: children.flat(Infinity) }
}

// useRef 必须**跨渲染保留**（按 hook 序号），否则 pending 集合之类的东西
// 每次渲染都会被重置，测出来的行为是假的。
let refSlots = {}
let refIndex = 0
function useRef(initial) {
  countHook('useRef')
  const index = refIndex++
  if (!(index in refSlots)) refSlots[index] = { current: initial }
  return refSlots[index]
}

const React = {
  createElement,
  Fragment: 'Fragment',
  useState,
  useEffect: (fn) => {
    countHook('useEffect')
    effects.push(fn)
  },
  useCallback: (fn) => {
    countHook('useCallback')
    return fn
  },
  useMemo: (fn) => {
    countHook('useMemo')
    return fn()
  },
  useRef,
}

// ---------- 假的 /status ----------
const STATUS = {
  version: 8,
  plugin: { name: 'dsh-reverse-proxy-connect', version: '9.9.9', host: 'in-process', api: 8, node: '24.0.0' },
  host: { images: true, stats: true, catalogCache: true },
  key: 'k',
  providers: [
    {
      provider: 'workbuddy', displayName: 'WorkBuddy', kind: 'desktop', enabled: true,
      catalogSource: 'live', fetchedAt: 1792234000000,
      health: { state: 'ok', consecutiveFailures: 0, lastErrorAt: 0 },
      usage: {
        requests: 12, ok: 11, failed: 1, aborted: 0, inputTokens: 100, outputTokens: 200, totalTokens: 300,
        avgDurationMs: 1200, successRate: 11 / 12,
        // 今日 10 次，但 accountModelToday 只覆盖了 3 次 —— 复刻真实场景：
        // 交叉维度从升级后才开始累积，覆盖率必然小于 100%。
        today: { requests: 10, totalTokens: 80 },
        last: { at: 1792234000000, accountId: 'default', model: 'auto', kind: 'stop', durationMs: 1000, totalTokens: 20 },
      },
      models: [{ id: 'auto', name: 'Auto', contextWindow: 256000, maxTokens: 32000, supportsImages: true, reasoningEfforts: [], disabled: false, unavailable: false, forced: false }],
      modelCount: 1,
      images: true,
      accounts: [
        { id: 'default', label: '本机登录', active: true, kind: 'desktop', configured: true, source: 'desktop', credits: { state: 'ok', remain: 675, total: 1200, unit: 'credits', items: [], trend: { sampleCount: 12, spentToday: 24, spent7d: 96, burnPerHour: 6, etaMs: 7200000, points: [{ at: 1792230000000, remain: 720 }, { at: 1792233600000, remain: 699 }, { at: 1792234000000, remain: 675 }] } } },
        { id: 'acc-2', label: '备用账号', active: false, kind: 'desktop', configured: true, source: 'browser-login', credits: { state: 'ok', remain: 0, total: 0, unit: 'credits' }, cooldownUntil: Date.now() + 60000, lastTest: { ok: false, latencyMs: 120, error: 'HTTP 429' } },
      ],
      checkin: { enabled: true, lastRunAt: 1792234000000, result: { provider: 'workbuddy', claimed: 0, credit: 0, outcomes: [{ accountId: 'default', kind: 'already' }] } },
      autoSwitch: true,
      credits: { state: 'ok', remain: 675, total: 1200, unit: 'credits', resetAtMs: 1793900000000, fetchedAt: 1792234000000, items: [], trend: { sampleCount: 12, spentToday: 24, spent7d: 96, burnPerHour: 6, etaMs: 7200000, points: [{ at: 1792230000000, remain: 720 }, { at: 1792233600000, remain: 699 }, { at: 1792234000000, remain: 675 }] } },
      credential: { status: 'signed-in', uid: 'u' },
    },
    {
      provider: 'workbuddy-ai', displayName: 'WorkBuddy AI', kind: 'desktop', enabled: true,
      catalogSource: 'live', fetchedAt: 1792234000000,
      health: { state: 'degraded', consecutiveFailures: 2, lastErrorAt: Date.now() },
      usage: { requests: 2, ok: 1, failed: 1, totalTokens: 40, avgDurationMs: 800, successRate: 0.5, today: { requests: 1, totalTokens: 20 } },
      models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 48000, supportsImages: true, reasoningEfforts: ['low'], credits: 'x0.79', disabled: false }],
      modelCount: 1,
      credits: { state: 'ok', remain: 99, total: 100, unit: 'credits', resetAtMs: 1793500000000, items: [], fetchedAt: 1792234000000, trend: { sampleCount: 4, spentToday: 1, spent7d: 1, burnPerHour: 1, etaMs: 3600000, points: [{ at: 1792230000000, remain: 100 }, { at: 1792234000000, remain: 99 }] } },
      credential: { status: 'signed-in', uid: 'u2' },
    },
    {
      provider: 'qoder-global', displayName: 'Qoder Global', kind: 'pat', enabled: true,
      catalogSource: 'live', fetchedAt: 1792234000000,
      health: { state: 'unknown', consecutiveFailures: 0 },
      usage: { requests: 0, ok: 0, failed: 0, totalTokens: 0, avgDurationMs: 0, today: { requests: 0, totalTokens: 0 } },
      models: [{ id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 200000, maxTokens: 32768, supportsImages: true, reasoningEfforts: [], credits: 'x0', disabled: false }],
      modelCount: 1,
      accounts: [{ id: 'default', label: '默认令牌', active: true, kind: 'pat', configured: true, source: 'pat', credits: { state: 'ok', remain: 0, total: 0, unit: 'credits', exceeded: true } }],
      autoSwitch: true,
      credits: { state: 'ok', remain: 0, total: 0, unit: 'credits', planName: 'Free', resetAtMs: 1794803568608, exceeded: true, items: [], fetchedAt: 1792234000000 },
      credential: { status: 'signed-in', email: 'a@b.c' },
    },
  ],
  settings: {
    workbuddy: {},
    qoder: { qoder: { configured: false }, 'qoder-global': { configured: true } },
    showRateInModelName: true,
    showUsageInSidebar: true,
    autoSwitch: { enabled: true, thresholdRatio: 0.05 },
    alerts: { enabled: true, lowRatio: 0.15 },
    checkin: true,
    probe: true,
    advanced: { idleTimeoutMs: 180000, catalogRefreshMs: 600000, creditsRefreshMs: 120000, stats: true, catalogCache: true },
  },
  probe: { enabled: true, lastRunAt: 1792234000000, results: {} },
  // v8：事件账本（2.0.0）。卡片只渲染最近 50 条，这里给 3 条覆盖三种筛选。
  events: {
    version: 1,
    count: 3,
    latestAt: 1792234000000,
    limit: 50,
    items: [
      {
        id: 'ev-1', at: 1792234000000, type: 'account-switch', level: 'warn', provider: 'workbuddy',
        message: '账号「本机登录」请求失败（RATE_LIMIT），切换到「备用账号」',
        data: { from: 'default', to: 'acc-2', reason: 'RATE_LIMIT' },
      },
      {
        id: 'ev-2', at: 1792233600000, type: 'credential-refresh', level: 'info', provider: 'workbuddy',
        message: '登录令牌已自动续期（本机登录）',
      },
      {
        id: 'ev-3', at: 1792233000000, type: 'credits', level: 'warn', provider: 'qoder-global',
        message: '额度读取失败（默认令牌）：HTTP 503',
      },
    ],
  },
  stats: {
    enabled: true,
    since: 1792000000000,
    totals: { requests: 14, ok: 12, failed: 2, totalTokens: 340, avgDurationMs: 1100, successRate: 12 / 14 },
    today: { requests: 4, totalTokens: 100, date: '2026-10-18' },
    providers: {},
    providerToday: {},
    accounts: {},
    models: {
      'workbuddy::auto': { requests: 8, totalTokens: 400, avgDurationMs: 1200 },
      'workbuddy::glm-5.3': { requests: 2, totalTokens: 80, avgDurationMs: 900 },
      'qoder-global::qfmodel': { requests: 1, totalTokens: 10, avgDurationMs: 300 },
    },
    // v4：账号 × 模型交叉维度。WorkBuddy 有两个账号，默认账号用了 auto，
    // 备用账号也用了 auto —— 这正是「哪个账号烧的 token」要看的那一格。
    //
    // 今日与累计刻意给不同的数字：卡片默认显示「今日」，必须与上方那个
    // 「今日 4 次」同一口径；拿成累计会让用户看到两个对不上的数。
    accountModels: {
      'workbuddy::default::auto': { provider: 'workbuddy', accountId: 'default', model: 'auto', requests: 6, totalTokens: 300, avgDurationMs: 1200 },
      'workbuddy::acc-2::auto': { provider: 'workbuddy', accountId: 'acc-2', model: 'auto', requests: 2, totalTokens: 100, avgDurationMs: 1100 },
      'workbuddy::default::glm-5.3': { provider: 'workbuddy', accountId: 'default', model: 'glm-5.3', requests: 2, totalTokens: 80, avgDurationMs: 900 },
      'qoder-global::default::qfmodel': { provider: 'qoder-global', accountId: 'default', model: 'qfmodel', requests: 1, totalTokens: 10, avgDurationMs: 300 },
    },
    accountModelToday: {
      'workbuddy::default::auto': { provider: 'workbuddy', accountId: 'default', model: 'auto', requests: 2, totalTokens: 50, avgDurationMs: 1000 },
      'workbuddy::acc-2::auto': { provider: 'workbuddy', accountId: 'acc-2', model: 'auto', requests: 1, totalTokens: 20, avgDurationMs: 900 },
    },
    daily: [
      { date: '2026-10-15', requests: 1, totalTokens: 10 },
      { date: '2026-10-16', requests: 2, totalTokens: 40 },
      { date: '2026-10-17', requests: 4, totalTokens: 120 },
      { date: '2026-10-18', requests: 4, totalTokens: 100 },
    ],
    // 1.3.0：每个 provider 自己的每日/会话维度。WorkBuddy 的 2026-10-18 是 3 次 / 80 tok，
    // 与全局的 4 次 / 100 tok 不同，用来验证卡片没有拿全局数字串台。
    providerDaily: {
      workbuddy: [
        { date: '2026-10-17', requests: 2, totalTokens: 50 },
        { date: '2026-10-18', requests: 3, totalTokens: 80 },
      ],
      'workbuddy-ai': [{ date: '2026-10-18', requests: 1, totalTokens: 20 }],
      qoder: [],
      'qoder-global': [{ date: '2026-10-18', requests: 1, totalTokens: 10 }],
    },
    currentSession: { id: 'global-session', requests: 9, totalTokens: 999, avgDurationMs: 999, successRate: 1 },
    providerCurrentSession: {
      workbuddy: { id: 's1', requests: 2, totalTokens: 30, avgDurationMs: 500, successRate: 1 },
      'workbuddy-ai': { id: 's2', requests: 1, totalTokens: 20, avgDurationMs: 800, successRate: 1 },
    },
    health: {},
    recent: [
      { at: 1792234000000, provider: 'workbuddy', accountId: 'default', model: 'auto', kind: 'stop', durationMs: 1000, totalTokens: 20 },
      { at: 1792233000000, provider: 'workbuddy', accountId: 'default', model: 'auto', kind: 'error', code: 'RATE_LIMIT', durationMs: 300, totalTokens: 0 },
    ],
  },
}

const calls = []
// 失败注入：'status' 让 /status 直接 reject（首屏错误态），'action' 让 /action reject（刷新失败提示）。
let fetchFailure = null
// /action 的响应延迟：用来在「A 家的操作还在飞」时切到 B 家，验证 busy 键没有串台。
let fetchDelayMs = 0
async function fakeFetch(url, init) {
  const target = String(url)
  if (fetchDelayMs > 0 && target.includes('/action')) {
    await new Promise((resolve) => setTimeout(resolve, fetchDelayMs))
  }
  calls.push({ url: target, method: init?.method ?? 'GET', body: init?.body })
  if (fetchFailure === 'status' && target.includes('/status')) throw new Error('fetch failed: ECONNREFUSED')
  if (fetchFailure === 'action' && target.includes('/action')) throw new Error('HTTP 500 upstream reset')
  return {
    ok: true,
    status: 200,
    json: async () => STATUS,
    text: async () => JSON.stringify({ ok: true, diagnostics: 'audit' }),
  }
}

// ---------- 载入 bundle ----------
let captured
// 记录注入的 <style>，验证主题 token 只注入一次（幂等）。
const injectedStyles = []
const styleById = new Map()
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: fakeFetch,
  navigator: {},
  document: {
    createElement: (tag) => ({ tagName: tag, id: '', textContent: '', children: [], appendChild(child) { this.children.push(child) } }),
    getElementById: (id) => styleById.get(id) ?? null,
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    head: {
      appendChild: (element) => {
        if (element && element.id) styleById.set(element.id, element)
        injectedStyles.push(element)
      },
    },
  },
}
sandbox.window = {
  innerWidth: 1280,
  innerHeight: 800,
  __ModuleLoader__: {
    load(definition) {
      const require = (name) => {
        if (name === 'react') return React
        if (name === 'react/jsx-runtime') return { jsx: createElement, jsxs: createElement }
        throw new Error('unexpected require ' + name)
      }
      captured = definition.factory(require)
    },
  },
}
sandbox.window.window = sandbox.window
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const registered = []
// 捕获真实 locale 表：新用例要断言插值后的数字（如「成功率 50%」），
// 只返回 key 的假 t 会把 {percent} 之类直接吞掉。
let realLocale
const ctx = {
  slots: {
    register(options, component) { registered.push({ options, component }); return () => {} },
    inject(name, callback) { callback() },
    entries() { return [] },
  },
  locale: {
    register: (namespace, value) => { realLocale = value; return () => {} },
    // 保持原来的 key-only 行为：侧栏组件内部用 ctx.locale.bind，而不是 props.t。
    // 新用例要真实插值文本时显式用 realT（只传给卡片）。
    bind: () => (key) => key,
  },
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  inject: (names, cb) => cb(ctx),
}
captured.apply(ctx)

const realT = (key, params) => {
  let text = realLocale && realLocale.zh && realLocale.zh[key] !== undefined ? realLocale.zh[key] : key
  if (params !== undefined && typeof text === 'string') {
    text = text.replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])))
  }
  return text
}

const card = registered.find((entry) => entry.options.name === 'plugin-settings.item')?.component
const pill = registered.find((entry) => entry.options.name === 'sidebar.footer.action')?.component
if (card === undefined) throw new Error('没有注册 plugin-settings.item')
if (pill === undefined) throw new Error('没有注册 sidebar.footer.action')
if (registered.some((entry) => entry.options.name === 'shell.overlay')) {
  throw new Error('仍然注册了 shell.overlay —— 悬浮气泡应该已经移除')
}

/** 走一遍渲染，直到状态收敛。 */
async function render(component, props, skipEffects) {
  let tree
  for (let pass = 0; pass < 6; pass++) {
    beginRender()
    tree = component(props)
    // 每次渲染结束校验 hook 总数：必须与上一次完全相同（React 的 hooks 规则）。
    assertHookCountStable()
    lastHookCallCount = hookCallCount
    if (skipEffects !== true) {
      for (const effect of effects) effect()
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (!dirty) break
  }
  return tree
}

/**
 * 换一个组件重新挂载。
 *
 * 必须清空 hook 槽：卡片与小卡是两棵独立的树，共用槽位会让小卡的 `expanded`
 * 读到卡片的 `tab`（字符串），表现为「点了不展开」。
 */
function mount(component, props) {
  hookStates = []
refSlots = {}
  lastHookCallCount = null
  return render(component, props)
}

/** 把树里的文本收集出来。 */
function textOf(tree) {
  const out = []
  ;(function walk(node) {
    if (node === null || node === undefined) return
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node === 'object') walk(node.children)
  })(tree)
  return out.join(' | ')
}

/** 按条件找第一个节点。 */
function find(tree, predicate) {
  let found
  ;(function walk(node) {
    if (found !== undefined || node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node === 'object') {
      if (predicate(node)) { found = node; return }
      walk(node.children)
    }
  })(tree)
  return found
}

/** 按可见文字找按钮（provider 卡是 role=tab 的按钮，文字前缀是服务商名）。 */
function findButton(tree, label) {
  return find(tree, (node) => {
    if (node.type !== 'button') return false
    const text = textOf(node)
    if (text === label) return true
    // 3.0 起概览卡与 provider tab 合并：按钮文字是「名称 | 状态 | 余额 | …」。
    if (node.props?.role === 'tab') return text.split(' | ')[0] === label
    return false
  })
}

/** 收集所有符合条件的节点。 */
function findAll(tree, predicate) {
  const out = []
  ;(function walk(node) {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    if (predicate(node)) out.push(node)
    walk(node.children)
  })(tree)
  return out
}

/**
 * 扫描整棵树里所有用户可见的数值出口：文本、title、aria-label、input value
 * 与内联样式。任何 NaN / Infinity 都算可视化缺陷（上一轮 NaN% 的同类）。
 */
function badNumbersIn(tree) {
  const bad = []
  const check = (where, value) => {
    const text = String(value)
    if (/NaN|Infinity/.test(text)) bad.push(where + ': ' + text.slice(0, 160))
  }
  check('text', textOf(tree))
  for (const node of findAll(tree, () => true)) {
    const props = node.props ?? {}
    for (const key of ['title', 'aria-label', 'value', 'placeholder']) {
      if (props[key] !== undefined) check(key, props[key])
    }
    for (const [key, value] of Object.entries(props.style ?? {})) {
      if (typeof value === 'number' && !Number.isFinite(value)) bad.push('style.' + key + ': ' + String(value))
      else if (typeof value === 'string' && /NaN|Infinity/.test(value)) bad.push('style.' + key + ': ' + value)
    }
  }
  return [...new Set(bad)]
}

function assertNoBadNumbers(tree, label) {
  const bad = badNumbersIn(tree)
  if (bad.length > 0) throw new Error(`${label} 仍渲染出非有限值：${bad.slice(0, 4).join(' | ')}`)
}

// ---------- 1. 设置卡片：版本号 + 各分组都在 ----------
let cardTree = await mount(card, { t: (key) => key })
const cardText = textOf(cardTree)
if (!cardText.includes('v9.9.9')) throw new Error('卡片没有显示版本号')
for (const section of ['secStatus', 'secConnection', 'models', 'credits']) {
  if (!cardText.includes(section)) throw new Error(`卡片缺少分组：${section}`)
}
// 账号总览里应能看到两家的余额（Qoder Global 是 0 也在）
for (const value of ['WorkBuddy', '675', 'WorkBuddy AI', '99']) {
  if (!cardText.includes(value)) throw new Error(`账号总览缺少 ${value}`)
}
// 模型列表要渲染出模型行（auto）
if (!cardText.includes('auto')) throw new Error('模型列表没有渲染')
// 桌面 provider 的新增账号只走浏览器登录，不再显示手填登录文件路径的添加框。
if (find(cardTree, (node) => node.type === 'input' && node.props.placeholder === 'accountLabel') !== undefined) {
  throw new Error('桌面 provider 不应再有手动添加账号输入框')
}
console.log('✓ 卡片分组、总览与模型列表都渲染出来了')

// 1a. 信息架构：六个分区只显示当前页，且不是所有内容都堆进概览。
//     这里同时验证「真实 React 会把 key 从 props 摘到 element.key」——
//     如果按 props.key 归页，所有分区都会落到概览。
//
//     分区用 `role="group"` 而不是 `role="tabpanel"`：它们是「页内导航」的六页，
//     共享同一个 provider tablist 的 panel（`dsh-rpc-detail`）。以前把这六页
//     标成 tabpanel，于是 tab 的 `aria-controls="dsh-rpc-detail"` 指向一个
//     没有 role 的容器、六个真 tabpanel 又没有 tab 指向它们 —— tabs 语义两头
//     都不成立。第 1a-1 段专门守这条契约。
{
  const panels = findAll(cardTree, (node) => typeof node.props?.id === 'string'
    && node.props.id.startsWith('dsh-rpc-page-'))
  if (panels.length !== 6) throw new Error(`应有 6 个详情分区，实际 ${panels.length}`)
  const visible = panels.filter((node) => node.props.style?.display !== 'none')
  if (visible.length !== 1) throw new Error(`同一时间应只有 1 个分区可见，实际 ${visible.length}`)
  if (visible[0].props.id !== 'dsh-rpc-page-overview') throw new Error('默认分区不是概览')
  const overviewText = textOf(visible[0])
  for (const needle of ['credits', 'secStatus', 'secAccounts']) {
    if (!overviewText.includes(needle)) throw new Error(`概览分区缺少 ${needle}`)
  }
  for (const hidden of ['usageHeatmap', 'eventTitle', 'secConnection', 'modelRateToggle']) {
    if (overviewText.includes(hidden)) throw new Error(`不属于概览的内容被堆进了概览：${hidden}`)
  }

  // 1a-1. tabs 契约：每个 tab 的 aria-controls 必须解析到唯一的 role=tabpanel，
  //       且那个 panel 的 aria-labelledby 指回当前选中的 tab。
  const tabs = findAll(cardTree, (node) => node.props?.role === 'tab')
  if (tabs.length === 0) throw new Error('找不到服务商 tab')
  const tabpanels = findAll(cardTree, (node) => node.props?.role === 'tabpanel')
  if (tabpanels.length !== 1) throw new Error(`服务商 tablist 应只有一个 tabpanel，实际 ${tabpanels.length}`)
  const panelId = tabpanels[0].props.id
  if (typeof panelId !== 'string' || panelId === '') throw new Error('tabpanel 缺少 id')
  const selectedTab = tabs.find((node) => node.props['aria-selected'] === true)
  if (selectedTab === undefined) throw new Error('没有 aria-selected 的 tab')
  for (const tab of tabs) {
    if (tab.props['aria-controls'] !== panelId) {
      throw new Error(`tab ${tab.props.id} 的 aria-controls 指向 ${String(tab.props['aria-controls'])}，应为 ${panelId}`)
    }
  }
  if (tabpanels[0].props['aria-labelledby'] !== selectedTab.props.id) {
    throw new Error(`tabpanel 的 aria-labelledby 应指回选中的 tab ${selectedTab.props.id}，实际 ${String(tabpanels[0].props['aria-labelledby'])}`)
  }
  // 页内六页不能同时又是 tabpanel：那会让上面的「唯一 tabpanel」断言失效。
  for (const panel of panels) {
    if (panel.props.role === 'tabpanel') throw new Error(`${panel.props.id} 不应是 role=tabpanel（它是页内分区，不是 tablist 的 panel）`)
  }
  // 点击「账号」页：只切换可见性，不丢失其它分区。
  const accountsTab = find(cardTree, (node) => node.type === 'button'
    && node.props?.className === 'rpc-pagetab'
    && textOf(node).startsWith('navAccounts'))
  if (accountsTab === undefined) throw new Error('找不到「账号」分区按钮')
  accountsTab.props.onClick()
  cardTree = await render(card, { t: (key) => key })
  const accountsPanel = find(cardTree, (node) => node.props?.id === 'dsh-rpc-page-accounts')
  if (accountsPanel.props.style?.display !== 'flex') throw new Error('点「账号」后账号分区仍不可见')
  // 切换服务商应回到概览，避免停在上一家的设置页。
  const nextProvider = find(cardTree, (node) => node.props?.role === 'tab' && node.type === 'button'
    && textOf(node).startsWith('WorkBuddy AI'))
  nextProvider.props.onClick()
  cardTree = await render(card, { t: (key) => key })
  const resetPanel = find(cardTree, (node) => node.props?.id === 'dsh-rpc-page-overview')
  if (resetPanel.props.style?.display !== 'flex') throw new Error('切换服务商后没有回到概览')
  console.log('✓ 六个详情分区按页切换，切换服务商回到概览')
  cardTree = await mount(card, { t: (key) => key })
}


// 账号区：能列出两个账号，并且「使用」会发 activeAccount 补丁
if (!cardText.includes('secAccounts')) throw new Error('卡片缺少账号分组')
if (!cardText.includes('本机登录') || !cardText.includes('备用账号')) {
  throw new Error('账号列表没有渲染出来')
}
const useButton = (function findUse(node) {
  if (node === null || node === undefined) return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findUse(child)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof node !== 'object') return undefined
  if (node.type === 'button') {
    const label = []
    ;(function collect(child) {
      if (typeof child === 'string') label.push(child)
      if (Array.isArray(child)) child.forEach(collect)
      else if (child && typeof child === 'object') collect(child.children)
    })(node.children)
    if (label.join('') === 'useAccount') return node
  }
  return findUse(node.children)
})(cardTree)
if (useButton === undefined) throw new Error('账号行上没有「使用」按钮')
const beforeUse = calls.length
useButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
const useCall = calls[calls.length - 1]
if (calls.length === beforeUse || !String(useCall.body).includes('activeAccount')) {
  throw new Error(`点「使用」没有发出 activeAccount 补丁：${String(useCall?.body).slice(0, 120)}`)
}
if (!String(useCall.body).includes('acc-2')) throw new Error('切换目标账号不对')
console.log('✓ 账号区可切换当前账号')

const checkinButton = (function findCheckin(node) {
  if (node === null || node === undefined) return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findCheckin(child)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof node !== 'object') return undefined
  if (node.type === 'button') {
    const label = []
    ;(function collect(child) {
      if (typeof child === 'string') label.push(child)
      if (Array.isArray(child)) child.forEach(collect)
      else if (child && typeof child === 'object') collect(child.children)
    })(node.children)
    if (label.join('') === 'checkinNow') return node
  }
  return findCheckin(node.children)
})(cardTree)
if (checkinButton === undefined) throw new Error('卡片上没有「立即签到」按钮')
const beforeCheckin = calls.length
checkinButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
const checkinCall = calls[calls.length - 1]
if (calls.length === beforeCheckin || !String(checkinCall.body).includes('checkin')) {
  throw new Error('点签到没有发出 action=checkin')
}
if (!String(checkinCall.body).includes('workbuddy')) throw new Error('签到请求没有带 provider')
console.log('✓ 签到按钮会发 action=checkin')

// ---------- 1b. 账号表格：固定列、每账号积分 / 状态 / 签到各自成格 ----------
{
  const provider = STATUS.providers[0]
  const checkinSnapshot = provider.checkin
  const accountsSnapshot = provider.accounts
  const now = Date.now()
  provider.accounts = [
    {
      ...accountsSnapshot[0],
      credits: { state: 'ok', remain: 1783, total: 2400, unit: 'credits', items: [] },
      cooldownUntil: now + 4 * 3600_000,
      lastTest: { at: now - 3600_000, ok: false, code: 'RATE_LIMIT', model: 'glm-5.3', latencyMs: 820, error: '频率限制，将在 2026-10-19 16:48:44 重置' },
    },
    {
      ...accountsSnapshot[1],
      credits: { state: 'ok', remain: 0, total: 0, unit: 'credits', items: [] },
      cooldownUntil: 0,
      lastTest: { at: now - 5 * 60_000, ok: false, code: 'RATE_LIMIT', model: 'auto', latencyMs: 310, error: 'HTTP 429' },
    },
  ]
  provider.checkin = {
    enabled: true,
    lastRunAt: now,
    result: {
      claimed: 1,
      credit: 100,
      outcomes: [
        { accountId: 'default', label: '本机登录', kind: 'already', streakDays: 9, credit: 200 },
        { accountId: 'acc-2', label: '备用账号', kind: 'claimed', credit: 100 },
      ],
    },
  }
  try {
    cardTree = await mount(card, { t: realT })
    const table = find(cardTree, (node) => node.props?.role === 'table')
    if (table === undefined) throw new Error('账号区没有渲染 role=table 的表格')
    const tableText = textOf(table)
    for (const header of ['账号', '积分', '状态 / 模型', '签到', '操作']) {
      if (!tableText.includes(header)) throw new Error(`账号表格缺少列头：${header}`)
    }
    if (!tableText.includes('冷却至')) throw new Error('冷却中的账号没有显示冷却时间')
    if (!tableText.includes('被限流')) throw new Error('最近测试 429 的账号没有显示「被限流」')
    if (!tableText.includes('限额')) throw new Error('限流账号没有「限额」徽章')
    if (!tableText.includes('已签到')) throw new Error('账号表格没有显示签到状态')
    if (!tableText.includes('连续 9 天')) throw new Error('已签到账号没有显示连续天数')
    if (!tableText.includes('+100')) throw new Error('本次签到成功的账号没有显示获得积分')
    if (!tableText.includes('1,783')) throw new Error('账号自己的积分没有进表格')
    if (!tableText.includes('/ 2,400')) throw new Error('账号积分分母没有进表格')
    if (!tableText.includes('到期')) throw new Error('账号积分没有显示到期时间')
    if (!/小时前|分钟前|刚刚/.test(tableText)) throw new Error('状态列没有显示相对时间')
    if (!tableText.includes('解除')) throw new Error('冷却中的账号没有「解除」入口')
    console.log('✓ 账号表格：列头、积分、限流状态、逐账号签到与冷却解除都在固定格子里')
  } finally {
    provider.accounts = accountsSnapshot
    provider.checkin = checkinSnapshot
  }
}

// ---------- 1b2. 可用性测试：账号 + 模型都由用户选，模型真正传给 /action ----------
{
  const provider = STATUS.providers[0]
  const modelsSnapshot = provider.models
  const accountsSnapshot = provider.accounts
  const modelCountSnapshot = provider.modelCount
  try {
    provider.models = modelsSnapshot.concat({
      id: 'hy3', name: 'Hy3', contextWindow: 192000, maxTokens: 64000,
      supportsImages: true, reasoningEfforts: [], disabled: false, unavailable: false,
    })
    provider.modelCount = provider.models.length
    provider.accounts = accountsSnapshot.map((account, index) => index === 0
      ? {
          ...account,
          modelTests: {
            hy3: { at: Date.now() - 60_000, ok: false, latencyMs: 320, code: 'RATE_LIMIT', model: 'hy3', error: 'HTTP 429', resetHint: '2026-10-19 20:00' },
          },
        }
      : account)
    cardTree = await mount(card, { t: (key) => key })
    const accountSelect = find(cardTree, (node) => node.type === 'select' && node.props?.['aria-label'] === 'testModelAccount')
    const modelSelect = find(cardTree, (node) => node.type === 'select' && node.props?.['aria-label'] === 'testModelModel')
    if (accountSelect === undefined || modelSelect === undefined) throw new Error('可用性测试缺少账号/模型选择器')
    const modelOptions = findAll(modelSelect, (node) => node.type === 'option').map(textOf)
    if (!modelOptions.includes('Hy3')) throw new Error(`模型选择器没有列出 Hy3：${modelOptions.join(' / ')}`)
    modelSelect.props.onChange({ target: { value: 'hy3' } })
    cardTree = await render(card, { t: (key) => key })
    const availability = find(cardTree, (node) => node.key === 'availability-test')
    if (availability === undefined) throw new Error('找不到可用性测试区块')
    const availabilityText = textOf(availability)
    if (!availabilityText.includes('Hy3')) throw new Error('切换模型后没有保留所选模型')
    if (!availabilityText.includes('limitBadge')) throw new Error('限额的测试结果没有显示「限额」徽标')
    if (!availabilityText.includes('limitUntil')) throw new Error('限额的测试结果没有显示重置时间')
    const runButton = findButton(cardTree, 'testModelStart')
    if (runButton === undefined) throw new Error('找不到「开始测试」按钮')
    const beforeTestModel = calls.length
    runButton.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const testModelCall = calls[calls.length - 1]
    const body = String(testModelCall?.body)
    if (calls.length === beforeTestModel || !body.includes('test-model') || !body.includes('hy3') || !body.includes('"accountId":"default"')) {
      throw new Error(`可用性测试请求不对：${body.slice(0, 200)}`)
    }
    console.log('✓ 可用性测试可选择账号/模型，并把模型传给 test-model')
  } finally {
    provider.models = modelsSnapshot
    provider.accounts = accountsSnapshot
    provider.modelCount = modelCountSnapshot
    cardTree = await mount(card, { t: (key) => key })
  }
}

// ---------- 1b3. 深度测试开关：勾上之后 /action 必须带 deep: true ----------
//
// 普通测试只发 1 token 的 `ping`，测不出「测试通过、对话 400」（2026-10-21 的
// 「请求被拦截」就是这么漏掉的）。这个开关把请求换成真实对话的形状，所以
// 「勾了却没传上去」等于功能不存在。
{
  try {
    cardTree = await mount(card, { t: (key) => key })
    let availability = find(cardTree, (node) => node.key === 'availability-test')
    if (availability === undefined) throw new Error('找不到可用性测试区块')
    const deepBox = find(availability, (node) => node.type === 'input' && node.props?.type === 'checkbox')
    if (deepBox === undefined) throw new Error('可用性测试缺少「深度测试」勾选框')
    deepBox.props.onChange({ target: { checked: true } })
    cardTree = await render(card, { t: (key) => key })
    availability = find(cardTree, (node) => node.key === 'availability-test')
    if (!textOf(availability).includes('testModelDeepHint')) throw new Error('勾选深度测试后没有给出说明')
    const runButton = findButton(cardTree, 'testModelStart')
    if (runButton === undefined) throw new Error('找不到「开始测试」按钮')
    const before = calls.length
    runButton.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 10))
    if (calls.length === before) throw new Error('勾选深度测试后没有发出请求')
    const body = String(calls[calls.length - 1]?.body)
    if (!body.includes('test-model') || !body.includes('"deep":true')) {
      throw new Error(`深度测试没有把 deep 传给服务端：${body.slice(0, 200)}`)
    }
    console.log('✓ 勾选深度测试后，test-model 请求带 deep: true')
  } finally {
    cardTree = await mount(card, { t: (key) => key })
  }
}

// ---------- 1c. 状态列：过期测试与凭证失效都不能显示成「可用」 ----------
{
  const provider = STATUS.providers[0]
  const accountsSnapshot = provider.accounts
  const credentialSnapshot = provider.credential
  const now = Date.now()
  const accountRow = () => findAll(cardTree, (node) => node.props?.role === 'row' && textOf(node).includes('本机登录'))[0]
  try {
    provider.accounts = [{
      ...accountsSnapshot[0],
      active: true,
      configured: true,
      credits: { state: 'ok', remain: 100, total: 200, unit: 'credits', items: [] },
      cooldownUntil: 0,
      lastTest: { at: now - 2 * 3600_000, ok: false, code: 'RATE_LIMIT', model: 'auto', error: 'HTTP 429' },
    }]
    cardTree = await mount(card, { t: (key) => key })
    let row = accountRow()
    if (row === undefined) throw new Error('找不到账号行')
    if (textOf(row).includes('accountRateLimited')) throw new Error('2 小时前的测试失败仍被当成当前状态')
    if (!textOf(row).includes('accountAvailable')) throw new Error('过期测试失败后应回落到「可用」')

    // 1 分钟内的失败仍然是当前状态。
    provider.accounts = [{
      ...provider.accounts[0],
      lastTest: { at: now - 60_000, ok: false, code: 'RATE_LIMIT', model: 'auto', error: 'HTTP 429' },
    }]
    cardTree = await mount(card, { t: (key) => key })
    row = accountRow()
    if (!textOf(row).includes('accountRateLimited')) throw new Error('刚失败的测试结果没有显示「被限流」')

    // 凭证探测说 signed-out 时，桌面账号的 configured=true 不能让它显示成可用。
    provider.accounts = [{ ...provider.accounts[0], lastTest: undefined }]
    provider.credential = { status: 'signed-out', reason: 'pat-invalid', message: 'PAT 已失效' }
    cardTree = await mount(card, { t: (key) => key })
    row = accountRow()
    if (!textOf(row).includes('accountAuthFailed')) throw new Error('凭证失效的账号没有显示「凭证失效」')
    if (textOf(row).includes('accountAvailable')) throw new Error('凭证失效的账号仍显示「可用」')
    console.log('✓ 状态列：过期测试不再冒充当前状态，凭证失效优先于「可用」')
  } finally {
    provider.accounts = accountsSnapshot
    provider.credential = credentialSnapshot
  }
}

// ---------- 2. 小卡默认收起 ----------
let tree = await mount(pill, { t: (key) => key, wide: true })
const collapsedText = textOf(tree)
if (collapsedText.includes('creditsRefresh')) throw new Error('默认就渲染了面板，应该先收起')
if (!collapsedText.includes('WB') || !collapsedText.includes('675')) {
  throw new Error(`胶囊内容不对：${collapsedText}`)
}
console.log('✓ 胶囊默认收起，只显示汇总')

// Qoder Free 的 0 是「付费额度为 0」，免费模型仍可用，不能亮警示色。
// 675 / 1200 与 99 / 100 也不该亮。
const warned = []
;(function walk(node) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (typeof node !== 'object') return
  if (typeof node.props?.style?.color === 'string' && node.props.style.color.includes('rpc-warn')) {
    const inner = []
    ;(function collect(child) {
      if (typeof child === 'string' || typeof child === 'number') { inner.push(String(child)); return }
      if (Array.isArray(child)) { child.forEach(collect); return }
      if (child && typeof child === 'object') collect(child.children)
    })(node.children)
    warned.push(inner.join(''))
  }
  walk(node.children)
})(tree)
if (warned.length !== 0) {
  throw new Error(`没有任何账号该亮警示色（Qoder Free 的 0 不算）：${JSON.stringify(warned)}`)
}
console.log('✓ Qoder Free 的 0 与正常余额都不亮警示色')

// 胶囊必须满宽：收起时也不能缩成内容宽度（否则比展开时窄一截）。
const collapsedToggle = find(tree, (node) => node.type === 'button' && node.props?.onClick !== undefined)
if (collapsedToggle.props.style?.width !== '100%') {
  throw new Error(`收起时胶囊宽度应为 100%，实际 ${String(collapsedToggle.props.style?.width)}`)
}
if (collapsedToggle.props.style?.justifyContent !== 'space-between') {
  throw new Error('满宽胶囊里的账号应两端对齐铺开')
}
console.log('✓ 胶囊收起时也是满宽')

// 六家 provider 之后，单行 `nowrap` + `overflow:hidden` 会把最后一个数字
// 静默剪成半个（截图里 TRAE 的 197 被裁掉一截）。胶囊必须允许换行，
// 而且数字区要是自适应栅格 —— 够宽两列、不够宽自动降一列，绝不裁字。
const pillGrid = find(collapsedToggle, (node) => node.props?.style?.display === 'grid'
  && typeof node.props?.style?.gridTemplateColumns === 'string')
if (pillGrid === undefined) {
  throw new Error('胶囊数字区不是栅格：provider 放不下时只能被裁掉，无法折行')
}
if (!String(pillGrid.props.style.gridTemplateColumns).includes('auto-fit')) {
  throw new Error(`胶囊栅格应使用 auto-fit 自适应列数，实际：${String(pillGrid.props.style.gridTemplateColumns)}`)
}
if (!String(pillGrid.props.style.gridTemplateColumns).includes('minmax')) {
  throw new Error(`胶囊栅格应使用 minmax 让列宽自适应，实际：${String(pillGrid.props.style.gridTemplateColumns)}`)
}
if (collapsedToggle.props.style?.whiteSpace === 'nowrap') {
  throw new Error('胶囊仍然是 nowrap：provider 多了会被裁掉而不是换行')
}
if (collapsedToggle.props.style?.overflow === 'hidden') {
  throw new Error('胶囊仍是 overflow:hidden：放不下的内容会被静默剪掉')
}
// 每个 provider 一格。
const segmentCells = findAll(pillGrid, (node) => node.props?.style?.justifyContent === 'flex-start'
  && typeof node.props?.title === 'string')
// 测试数据里 3 个 provider 有可用额度（WB / WBAI / QDG）。
if (segmentCells.length !== 3) {
  throw new Error(`当前测试数据有 3 个有额度的 provider，应占 3 格，实际 ${segmentCells.length}`)
}
// 两列必须同一种对齐方式。
//
// 之前左列 `flex-start`、右列 `flex-end`：左列从固定位置起排，右列贴着右边缘，
// 两列起点不一致，右列看起来像「浮在半空」（截图里 WBAI / TRAE 参差不齐）。
// 现在统一左对齐 —— 两行扫下来每条竖线都是齐的。
segmentCells.forEach((cell, index) => {
  if (cell.props.style.justifyContent !== 'flex-start') {
    throw new Error(`第 ${index} 格应为左对齐（两列一致），实际 ${String(cell.props.style.justifyContent)}`)
  }
})
// 自动排布时不能有显式定位：`auto-fit` 只对自动放置生效，
// 写了 gridColumn 就会退化回固定列数，窄侧栏里又开始挤压。
segmentCells.forEach((cell, index) => {
  if (cell.props.style.gridColumn !== undefined) {
    throw new Error(`第 ${index} 格不该显式指定 gridColumn（会让 auto-fit 失效）`)
  }
})
// 数字永远不缩：额度是这个胶囊唯一要传达的信息。
// 让数字省略会得到「19…」，看起来像另一个数字，比标签短一截误导得多。
segmentCells.forEach((cell, index) => {
  const numbers = findAll(cell, (node) => node.props?.style?.fontVariantNumeric === 'tabular-nums')
  if (numbers.length !== 1) throw new Error(`第 ${index} 格应恰好有一个数字节点，实际 ${numbers.length}`)
  if (numbers[0].props.style.flex !== '0 0 auto') {
    throw new Error(`第 ${index} 格的数字不该被压缩（flex=${String(numbers[0].props.style.flex)}）`)
  }
  if (numbers[0].props.style.textOverflow === 'ellipsis') {
    throw new Error(`第 ${index} 格的数字不该省略：会显示成「19…」这种假数字`)
  }
})
console.log('✓ 胶囊可折行：数字区自适应列数、两列左对齐、数字不被裁切')

// ---------- 2b. 悬停要有反馈（用户靠这个判断「能点」）----------
// 箭头必须是内联 SVG 的折线，而不是 `▾` 字符 —— 9px 的字形在侧栏里几乎看不见。
const caret = find(collapsedToggle, (node) => node.type === 'svg')
if (caret === undefined) throw new Error('胶囊上没有展开箭头（SVG），用户看不出能点')
if (Number(caret.props.width) < 12 || Number(caret.props.height) < 12) {
  throw new Error(`箭头太小：${String(caret.props.width)}x${String(caret.props.height)}（至少 12）`)
}
const caretPath = find(caret, (node) => node.type === 'path')
if (caretPath === undefined) throw new Error('箭头没有折线路径')
if (Number(caretPath.props.strokeWidth) < 1.5) throw new Error('箭头描边太细，缩放后会糊')
if (caretPath.props.stroke !== 'currentColor') throw new Error('箭头应跟随文字颜色（currentColor）')

const idleBackground = String(collapsedToggle.props.style?.background)
collapsedToggle.props.onMouseEnter()
tree = await render(pill, { t: (key) => key, wide: true })
const hoveredToggle = find(tree, (node) => node.type === 'button' && node.props?.['aria-expanded'] !== undefined)
const hoverBackground = String(hoveredToggle.props.style?.background)
if (hoverBackground === idleBackground || !hoverBackground.includes('rpc-fill')) {
  throw new Error(`悬停没有底色反馈：idle=${idleBackground} hover=${hoverBackground}`)
}
if (!String(hoveredToggle.props.style?.border).includes('border-l3')) {
  throw new Error('悬停时描边没有加深')
}
if (hoveredToggle.props.style?.boxShadow === 'none' || hoveredToggle.props.style?.boxShadow === undefined) {
  throw new Error('悬停时缺少阴影，层级感不足')
}

// 移开要恢复
hoveredToggle.props.onMouseLeave()
tree = await render(pill, { t: (key) => key, wide: true })
const idleAgain = find(tree, (node) => node.type === 'button' && node.props?.['aria-expanded'] !== undefined)
if (String(idleAgain.props.style?.background) !== idleBackground) throw new Error('移开鼠标后底色没有恢复')
console.log('✓ 胶囊有悬停底色、描边加深与展开箭头')

// ---------- 3. 点胶囊展开 ----------
const toggle = find(tree, (node) => node.type === 'button' && node.props?.onClick !== undefined)
if (toggle === undefined) throw new Error('胶囊不是可点按钮')
if (toggle.props['aria-expanded'] !== false) throw new Error('收起时 aria-expanded 应为 false')
toggle.props.onClick({ preventDefault() {} })

tree = await render(pill, { t: (key) => key, wide: true })
const expandedText = textOf(tree)
if (!expandedText.includes('creditsRefresh')) throw new Error('展开后没有渲染面板')
// 面板的层级信息：provider 数量、百分比、今日用量、已用尽徽标、更新时间。
for (const label of ['creditsSources', 'creditsPercent', 'creditsToday', 'creditsFreeQueue', 'creditsFetchedAt']) {
  if (!expandedText.includes(label)) throw new Error(`展开面板缺少 ${label}`)
}
console.log('✓ 点击胶囊展开面板')

// ---------- 4. 面板必须是内嵌（宽度 100%），不能是 fixed ----------
const panel = find(tree, (node) => node.props?.id !== undefined && String(node.props.id).includes('credits-panel'))
if (panel === undefined) throw new Error('找不到面板节点')
if (panel.props.style?.position === 'fixed') {
  throw new Error('面板用了 position:fixed —— 会越过侧栏压到对话区（0.4.6 的 bug）')
}
if (panel.props.style?.width !== '100%') {
  throw new Error(`面板宽度应为 100%，实际 ${String(panel.props.style?.width)}`)
}
console.log('✓ 面板是内嵌的（width:100%，非 fixed）')

// ---------- 5. 面板里的刷新按钮真的会发请求 ----------
const before = calls.length
const refreshButton = find(panel, (node) => node.type === 'button' && node.props?.onClick !== undefined)
if (refreshButton === undefined) throw new Error('面板里没有刷新按钮')
if (!textOf(refreshButton).includes('creditsRefresh')) throw new Error('刷新按钮文案不对')
refreshButton.props.onClick({ preventDefault() {} })
await new Promise((resolve) => setTimeout(resolve, 10))
if (calls.length <= before) throw new Error('点刷新没有发出请求')
const posted = calls[calls.length - 1]
if (posted.method !== 'POST' || !String(posted.body).includes('credits')) {
  throw new Error(`刷新请求不对：${JSON.stringify(posted)}`)
}
console.log('✓ 面板里的刷新按钮会发 POST /action')

// ---------- 6. 再点一次收起 ----------
tree = await render(pill, { t: (key) => key, wide: true })
const toggle2 = find(tree, (node) => node.type === 'button' && node.props?.['aria-expanded'] !== undefined)
if (toggle2.props['aria-expanded'] !== true) throw new Error('展开后 aria-expanded 应为 true')
toggle2.props.onClick({ preventDefault() {} })
tree = await render(pill, { t: (key) => key, wide: true })
if (textOf(tree).includes('creditsRefresh')) throw new Error('再点一次没有收起面板')
console.log('✓ 再点一次收起面板')

// ---------- 7. 1.0.0：健康状态与用量区块 ----------
// 小卡用的是另一棵组件树；不重新挂载的话下面的 hook 槽还是小卡的。
cardTree = await mount(card, { t: (key) => key })
const v4Text = textOf(cardTree)
if (!v4Text.includes('healthOk')) throw new Error('卡片没有显示健康状态')
if (!v4Text.includes('healthDegraded')) throw new Error('降级状态没有显示')
if (!v4Text.includes('imagesShort')) throw new Error('卡片没有标记图片输入能力')
if (!v4Text.includes('usage')) throw new Error('卡片缺少用量分组')
if (!v4Text.includes('usageToday') || !v4Text.includes('usageTotal')) {
  throw new Error('用量区块缺少今日/累计')
}
if (!v4Text.includes('usageRecent') && !v4Text.includes('RATE_LIMIT')) {
  throw new Error('最近请求没有渲染')
}
// 表格必须有明确的表头与栅格约束，不能是一堆没有对齐的数字。
for (const header of ['usageAvg', 'usageTime', 'usageTokenShort']) {
  if (!v4Text.includes(header)) throw new Error(`用量表缺少表头：${header}`)
}
const usageGrid = find(cardTree, (node) => typeof node.props?.style?.gridTemplateColumns === 'string' && node.props.style.gridTemplateColumns.includes('minmax'))
if (usageGrid === undefined) throw new Error('用量区块没有表格栅格')
console.log('✓ 健康状态、图片能力与用量区块都渲染出来了')

// 7b. 健康状态是历史证据：连续失败如果是 2 小时前，不能继续断言「不可用」。
//     展示层应降级为「待验证」，并说明最近成功/失败的时间；只有近期失败
//     （30 分钟内）才显示 healthDown。
{
  const provider = STATUS.providers[0]
  const healthSnapshot = provider.health
  const accountsSnapshot = provider.accounts
  const tokensOf = (text) => text.split(' | ')
  try {
    provider.health = {
      state: 'down',
      consecutiveFailures: 6,
      lastErrorAt: Date.now() - 2 * 60 * 60_000,
      lastSuccessAt: Date.now() - 3 * 60 * 60_000,
    }
    provider.accounts = accountsSnapshot
    cardTree = await mount(card, { t: (key) => key })
    const staleText = textOf(cardTree)
    const staleTokens = tokensOf(staleText)
    if (!staleTokens.includes('healthStale')) throw new Error('过期健康证据没有降级成「待验证」')
    if (staleTokens.includes('healthDown')) throw new Error('2 小时前的连续失败仍显示「连续失败」')
    if (!staleTokens.includes('healthStaleHint')) throw new Error('「待验证」没有说明原因')
    if (!staleTokens.includes('lastSuccessAtLabel')) throw new Error('没有显示最近成功时间')
    if (staleTokens.includes('testedAvailableShort')) throw new Error('没有测试结果时不应显示「刚测可用」')

    provider.accounts = accountsSnapshot.map((account, index) => index === 0
      ? { ...account, modelTests: { auto: { at: Date.now() - 60_000, ok: true, latencyMs: 900, model: 'auto' } } }
      : account)
    cardTree = await mount(card, { t: (key) => key })
    const okText = textOf(cardTree)
    const okTokens = tokensOf(okText)
    if (!okTokens.includes('testedAvailableShort')) throw new Error('最近测试通过没有回写到状态卡')
    if (!okTokens.includes('healthStaleTestOkHint')) throw new Error('最近测试通过后没有更新待验证说明')
    if (okTokens.includes('healthStale')) throw new Error('有近期测试结果时仍同时显示「待验证」，状态互相矛盾')
    // 「刚刚可用」旁边不能再挂一条警告色的 6 天前失败：stale 时旧失败只能
    // 作为「历史失败」以中性色呈现，否则两个结论互相打架（用户实测截图）。
    if (!okTokens.includes('lastFailureHistory')) throw new Error('待验证状态下的旧失败没有标成「历史失败」')
    const oldFailureLine = find(cardTree, (node) => node.type === 'p' && textOf(node) === 'lastFailureHistory')
    if (oldFailureLine === undefined) throw new Error('历史失败行没有渲染')
    if (oldFailureLine.props.className !== 'rpc-tiny') throw new Error(`历史失败仍用警告色渲染：${oldFailureLine.props.className}`)
    if (find(cardTree, (node) => node.type === 'p' && node.props?.className === 'rpc-warn-text' && textOf(node) === 'lastFailure')) {
      throw new Error('stale 时同一条失败仍以「最近一次失败」警告色渲染')
    }

    provider.accounts = accountsSnapshot.map((account, index) => index === 0
      ? { ...account, modelTests: { auto: { at: Date.now() - 60_000, ok: false, code: 'RATE_LIMIT', latencyMs: 250, model: 'auto', error: 'HTTP 429', resetHint: '2026-10-19 20:00' } } }
      : account)
    cardTree = await mount(card, { t: (key) => key })
    const limitedText = textOf(cardTree)
    const limitedTokens = tokensOf(limitedText)
    if (!limitedTokens.includes('testedLimitedShort')) throw new Error('最近测试限额没有回写到状态卡')
    if (!limitedTokens.includes('healthStaleTestLimitHint')) throw new Error('最近测试限额后没有更新待验证说明')

    provider.accounts = accountsSnapshot
    provider.health = {
      state: 'down',
      consecutiveFailures: 3,
      lastErrorAt: Date.now() - 60_000,
      lastSuccessAt: Date.now() - 2 * 60_000,
    }
    cardTree = await mount(card, { t: (key) => key })
    const freshText = textOf(cardTree)
    const freshTokens = tokensOf(freshText)
    if (!freshTokens.includes('healthDown')) throw new Error('30 分钟内的连续失败没有显示 healthDown')
    if (freshTokens.includes('healthStale')) throw new Error('近期失败不应显示「待验证」')
    // 仍在 30 分钟内的失败必须保持警告色与「最近一次失败」措辞，不能被
    // 上面的历史样式一起弱化。
    const freshFailureLine = find(cardTree, (node) => node.type === 'p' && textOf(node) === 'lastFailure')
    if (freshFailureLine === undefined || freshFailureLine.props.className !== 'rpc-warn-text') {
      throw new Error('30 分钟内的失败没有保持警告色')
    }
    console.log('✓ 健康状态按时间降级，最近测试结果合并为单一状态')
  } finally {
    provider.health = healthSnapshot
    provider.accounts = accountsSnapshot
    cardTree = await mount(card, { t: (key) => key })
  }
}

// 自动签到开关：界面上可见、可点，并且会发 checkin 补丁。
if (!v4Text.includes('checkinAuto') || !v4Text.includes('checkinAutoHint')) {
  throw new Error('缺少自动签到开关或说明')
}
const autoLabel = find(cardTree, (node) => node.type === 'label' && textOf(node) === 'checkinAuto')
if (autoLabel === undefined) throw new Error('找不到自动签到开关')
const autoInput = find(autoLabel, (node) => node.type === 'input')
if (autoInput === undefined) throw new Error('自动签到开关没有 checkbox')
const beforeAuto = calls.length
autoInput.props.onChange({ target: { checked: false } })
await new Promise((resolve) => setTimeout(resolve, 10))
const autoCall = calls[calls.length - 1]
if (calls.length === beforeAuto || !String(autoCall.body).includes('"checkin"')) {
  throw new Error(`切换自动签到没有发 checkin 补丁：${String(autoCall?.body).slice(0, 160)}`)
}
console.log('✓ 自动签到开关可切换并会发 checkin 补丁')

// 「重置统计」发 action=stats-reset
const resetStatsButton = findButton(cardTree, 'usageReset')
if (resetStatsButton === undefined) throw new Error('用量区块没有「重置统计」按钮')
const beforeReset = calls.length
resetStatsButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
const resetCall = calls[calls.length - 1]
if (calls.length === beforeReset || !String(resetCall.body).includes('stats-reset')) {
  throw new Error('点重置统计没有发出 action=stats-reset')
}
console.log('✓ 重置统计会发 action=stats-reset')

// 高级设置：保存会发 advanced 补丁
const advancedSaveButton = findButton(cardTree, 'advancedSave')
if (advancedSaveButton === undefined) throw new Error('高级设置里没有保存按钮')
const beforeAdvanced = calls.length
advancedSaveButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
const advancedCall = calls[calls.length - 1]
if (calls.length === beforeAdvanced || !String(advancedCall.body).includes('advanced')) {
  throw new Error('保存高级设置没有发出 advanced 补丁')
}
if (!String(advancedCall.body).includes('"alerts"') || !String(advancedCall.body).includes('thresholdRatio') || !String(advancedCall.body).includes('qoderQueueWaitMs') || !String(advancedCall.body).includes('"probe"')) {
  throw new Error(`高级设置没有带上预警/换号/排队/探测开关：${String(advancedCall.body).slice(0, 280)}`)
}
// 高级表单不拥有「自动换号」的开关：带上它会把账号页刚关掉的开关按旧快照写回。
// 服务端支持部分字段合并，所以这里只应出现 thresholdRatio。
const advancedBody = JSON.parse(String(advancedCall.body))
if (advancedBody.autoSwitch !== undefined && advancedBody.autoSwitch.enabled !== undefined) {
  throw new Error(`高级设置越权写入 autoSwitch.enabled：${String(advancedCall.body).slice(0, 280)}`)
}
console.log('✓ 高级设置会发 advanced 补丁，且不覆盖账号页的自动换号开关')

// ---------- 8. PAT 保存要写进当前账号（而不是被忽略的旧字段） ----------
const qoderTab = findButton(cardTree, 'Qoder Global')
if (qoderTab === undefined) throw new Error('找不到 Qoder Global 标签')
qoderTab.props.onClick()
cardTree = await render(card, { t: (key) => key })
const patInput = find(cardTree, (node) => node.type === 'input' && node.props.type === 'password' && String(node.props.placeholder).includes('patConfigured'))
if (patInput === undefined) throw new Error('找不到 PAT 输入框')
// Qoder 没有浏览器登录，仍然保留「名称 + PAT」的手动添加。
if (find(cardTree, (node) => node.type === 'input' && node.props.placeholder === 'accountLabel') === undefined) {
  throw new Error('PAT provider 缺少手动添加账号输入框')
}
if (find(cardTree, (node) => node.type === 'input' && node.props.placeholder === 'accountPat') === undefined) {
  throw new Error('PAT provider 缺少 PAT 输入框')
}
patInput.props.onChange({ target: { value: 'pt-123' } })
// 简化版 hooks 每次渲染都会重跑 effect；跳过一轮，模拟 React 里
// 「依赖没变就不重置输入草稿」的行为。
cardTree = await render(card, { t: (key) => key }, true)
const savePatButton = findButton(cardTree, 'save')
if (savePatButton === undefined) throw new Error('找不到保存 PAT 按钮')
const beforePat = calls.length
savePatButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
const patCall = calls[calls.length - 1]
if (calls.length === beforePat) throw new Error('保存 PAT 没有发请求')
if (!String(patCall.body).includes('"accounts"') || !String(patCall.body).includes('pt-123')) {
  throw new Error(`有账号池时 PAT 应写进 accounts，实际：${String(patCall.body).slice(0, 200)}`)
}
console.log('✓ 有账号池时 PAT 会写进当前账号')

// ---------- 8b. 删除账号：两步确认，确认后才走 removedAccounts ----------
const wbTab = findButton(cardTree, 'WorkBuddy')
if (wbTab === undefined) throw new Error('找不到 WorkBuddy 标签')
wbTab.props.onClick()
cardTree = await render(card, { t: (key) => key })
const removeButtons = findAll(cardTree, (node) => node.type === 'button' && textOf(node) === 'removeAccount')
if (removeButtons.length !== 2) throw new Error(`应有 2 个删除按钮，实际 ${removeButtons.length}`)
const removePosts = () => calls.filter((call) => call.method === 'POST' && String(call.url).includes('/settings')
  && String(call.body).includes('removedAccounts')).length
const beforeRemovePosts = removePosts()
removeButtons[1].props.onClick()
cardTree = await render(card, { t: (key) => key })
if (removePosts() !== beforeRemovePosts) throw new Error('第一次点删除就发了 removedAccounts 请求，缺少二次确认')
const confirmButtons = findAll(cardTree, (node) => node.type === 'button' && textOf(node) === 'removeConfirm')
if (confirmButtons.length !== 1) throw new Error(`第一次点击后应只有 1 个按钮进入确认态，实际 ${confirmButtons.length}`)
confirmButtons[0].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
const removeCall = calls.filter((call) => call.method === 'POST' && String(call.url).includes('/settings')
  && String(call.body).includes('removedAccounts')).pop()
if (removePosts() !== beforeRemovePosts + 1 || !String(removeCall.body).includes('acc-2')) {
  throw new Error(`删除账号应发 removedAccounts：${String(removeCall?.body).slice(0, 200)}`)
}
console.log('✓ 删除账号两步确认：第一次不发请求，第二次才发 removedAccounts')
// aria-label 带账号名（用支持 {name} 插值的 t 验证真实的 aria-label 文本）
cardTree = await mount(card, { t: (key) => (key === 'removeAccountAria' ? '{name}' : key) })
const namedRemoveButtons = findAll(cardTree, (node) => node.type === 'button' && node.props?.['aria-label'] !== undefined && node.props['aria-label'].indexOf('本机登录') !== -1)
if (namedRemoveButtons.length === 0) throw new Error('删除按钮的 aria-label 没有带账号名')
console.log('✓ 删除按钮 aria-label 带账号名，多账号不混淆')

// 删除确认必须按 provider 隔离：workbuddy 与 workbuddy-ai 的默认账号 id 都叫
// `default`，只比 id 会让另一个标签页的同 id 账号预先进入「确认删除」。
{
  const provider = STATUS.providers[1]
  const accountsSnapshot = provider.accounts
  provider.accounts = [
    { id: 'default', label: 'AI 默认', active: true, kind: 'desktop', configured: true, source: 'desktop', credits: { state: 'ok', remain: 10, total: 100, unit: 'credits', items: [] } },
    { id: 'ai-2', label: 'AI 备用', active: false, kind: 'desktop', configured: true, source: 'desktop', credits: { state: 'ok', remain: 20, total: 100, unit: 'credits', items: [] } },
  ]
  try {
    cardTree = await mount(card, { t: (key) => key })
    const workbuddyTab = findButton(cardTree, 'WorkBuddy')
    workbuddyTab.props.onClick()
    cardTree = await render(card, { t: (key) => key })
    const workbuddyRemoves = findAll(cardTree, (node) => node.type === 'button' && textOf(node) === 'removeAccount')
    workbuddyRemoves[0].props.onClick()
    cardTree = await render(card, { t: (key) => key })
    if (findAll(cardTree, (node) => node.type === 'button' && textOf(node) === 'removeConfirm').length !== 1) {
      throw new Error('WorkBuddy 的删除确认没有进入确认态')
    }
    const aiTab = findButton(cardTree, 'WorkBuddy AI')
    aiTab.props.onClick()
    cardTree = await render(card, { t: (key) => key })
    if (findAll(cardTree, (node) => node.type === 'button' && textOf(node) === 'removeConfirm').length !== 0) {
      throw new Error('切换 provider 后，另一个标签页的同 id 账号被预先武装成「确认删除」')
    }
    const beforeCrossRemove = removePosts()
    const aiRemoves = findAll(cardTree, (node) => node.type === 'button' && textOf(node) === 'removeAccount')
    aiRemoves[0].props.onClick()
    cardTree = await render(card, { t: (key) => key })
    if (removePosts() !== beforeCrossRemove) throw new Error('跨 provider 后第一次点删除就发了 removedAccounts')
    console.log('✓ 删除确认按 provider 隔离，同 id 账号不会跨标签页误删')
  } finally {
    provider.accounts = accountsSnapshot
  }
}

// ---------- 9. 侧栏小卡用轻量状态，不再拉整份模型清单 ----------
if (!calls.some((call) => String(call.url).includes('?light=1'))) {
  throw new Error('侧栏小卡没有走 ?light=1 轻量状态')
}
console.log('✓ 侧栏小卡走轻量状态接口')

// ---------- 10. 小面板不显示完整凭证错误，只给短状态 ----------
const aiProvider = STATUS.providers[1]
const longError = '没有找到 workbuddy-ai 的登录文件（已找：C:\\Users\\李\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info）。请先打开 WorkBuddy AI 并登录。'
STATUS.providers[1] = {
  ...aiProvider,
  credential: { status: 'signed-out', reason: 'no-credential', message: longError },
  credits: { ...aiProvider.credits, stale: true, error: longError },
}
try {
  hookStates = []
refSlots = {}
  let errorTree = await mount(pill, { t: (key) => key, wide: true })
  const errorToggle = find(errorTree, (node) => node.type === 'button' && node.props?.['aria-expanded'] !== undefined)
  errorToggle.props.onClick({ preventDefault() {} })
  errorTree = await render(pill, { t: (key) => key, wide: true })
  const errorText = textOf(errorTree)
  if (!errorText.includes('creditsNeedLogin')) throw new Error('小面板没有显示简短的「未登录」')
  if (errorText.includes('没有找到')) throw new Error('小面板不应展开完整错误文案')
  if (!errorText.includes('creditsCached')) throw new Error('小面板没有标记缓存数据')
  console.log('✓ 小面板把凭证错误简写成「未登录」，完整原因只留在卡片')
} finally {
  STATUS.providers[1] = aiProvider
}

// ---------- 12. 1.1.0：额度趋势、预警、账号测试与用量历史 ----------
cardTree = await mount(card, { t: (key) => key })
const trendCardText = textOf(cardTree)
// Qoder Free 的 0 是「付费额度为 0」，不是「已用尽」；不应触发顶部橙色横幅。
if (trendCardText.includes('alertBannerExhausted')) {
  throw new Error('Qoder Free 的 0 付费额度不应显示「额度已用尽」横幅')
}
if (!trendCardText.includes('trend') || !trendCardText.includes('trendToday')) {
  throw new Error('额度区块没有渲染趋势')
}
if (!trendCardText.includes('trendEta')) throw new Error('没有渲染耗尽预估')
if (find(cardTree, (node) => node.type === 'polyline') === undefined) {
  throw new Error('额度趋势没有折线')
}
// 用量热力图与「当前会话」必须用当前 provider 自己的数字，不能拿全局值串台。
// 热力图格子的 title 走 locale 模板（`usageHeatCell`），这里同时兼容模板与渲染后的文案。
const workbuddyDayBar = find(cardTree, (node) => typeof node.props?.title === 'string'
  && ((node.props.title.includes('2026-10-18')
    && node.props.title.includes('3 次')
    && node.props.title.includes('80 tok'))
    || node.props.title.includes('usageHeatCell')))
if (workbuddyDayBar === undefined) {
  throw new Error('WorkBuddy 热力图没有使用 providerDaily（应显示 3 次 / 80 tok）')
}
// 固定 14 个槽位：只有一天数据时不能只画一根占满整行的柱子。
const heatCells = findAll(cardTree, (node) => node.props?.title === 'usageHeatCell')
if (heatCells.length !== 14) throw new Error(`近 14 天应固定 14 个槽位，实际 ${heatCells.length}`)
const sessionRow = find(cardTree, (node) => node.type === 'div'
  && Array.isArray(node.children)
  && node.children.length > 0
  && textOf(node.children[0]) === 'usageSession')
if (sessionRow === undefined) throw new Error('没有渲染当前会话行')
const sessionRowText = textOf(sessionRow)
if (!sessionRowText.includes('30') || sessionRowText.includes('999')) {
  throw new Error(`当前会话应使用该 provider 的 30 tok，而不是全局的 999：${sessionRowText}`)
}

// 诊断面板里的原始 JSON 不能带控制密钥（key 能改设置 / 触发签到与测试）。
const diagButton = findButton(cardTree, 'diagnostics')
if (diagButton === undefined) throw new Error('找不到诊断按钮')
diagButton.props.onClick()
cardTree = await render(card, { t: (key) => key })
const diagPre = find(cardTree, (node) => node.type === 'pre')
if (diagPre === undefined) throw new Error('展开诊断后没有 JSON')
const diagText = textOf(diagPre)
if (diagText.includes('"key": "k"') || diagText.includes('"key":"k"')) {
  throw new Error('诊断 JSON 泄露了控制密钥')
}
if (!diagText.includes('[redacted]')) throw new Error('诊断 JSON 没有标记脱敏字段')
const closeDiagButton = findButton(cardTree, 'diagnostics')
if (closeDiagButton !== undefined) closeDiagButton.props.onClick()
cardTree = await render(card, { t: (key) => key })

// 真正的低额度账号仍然要有橙色横幅（用临时 5% 的 WorkBuddy AI 验证）。
const lowProvider = STATUS.providers[1]
STATUS.providers[1] = { ...lowProvider, credits: { ...lowProvider.credits, remain: 5, total: 100 } }
try {
  cardTree = await mount(card, { t: (key) => key })
  if (!textOf(cardTree).includes('alertBannerLow')) {
    throw new Error('低额度账号没有渲染预警横幅')
  }
  console.log('✓ 低额度账号仍会触发预警横幅')
} finally {
  STATUS.providers[1] = lowProvider
  cardTree = await mount(card, { t: (key) => key })
}

// 关闭预警开关后：横幅、卡片数字、侧栏颜色都要一起关掉（1.2.0 只关了横幅）。
STATUS.settings.alerts.enabled = false
let beforeDisable
try {
  beforeDisable = STATUS.providers[1]
  STATUS.providers[1] = { ...beforeDisable, credits: { ...beforeDisable.credits, remain: 5, total: 100 } }
  cardTree = await mount(card, { t: (key) => key })
  const noAlertText = textOf(cardTree)
  if (noAlertText.includes('alertBannerLow')) throw new Error('关闭预警后仍然渲染了低额度横幅')
  const stillWarned = []
  ;(function walk(node) {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node.props?.style?.color === 'string'
      && node.props.style.color.includes('rpc-warn')
      && typeof node.props.style.fontSize === 'number'
      && node.props.style.fontSize >= 19) stillWarned.push(textOf(node))
    walk(node.children)
  })(cardTree)
  if (stillWarned.length > 0) throw new Error(`关闭预警后仍有琥珀色：${JSON.stringify(stillWarned)}`)
  console.log('✓ 关闭预警后卡片与侧栏不再亮警示色')
} finally {
  if (beforeDisable !== undefined) STATUS.providers[1] = beforeDisable
  STATUS.settings.alerts.enabled = true
  cardTree = await mount(card, { t: (key) => key })
}
for (const label of ['usageSession', 'usageHeatmap', 'usageTopModels', 'usageShowInSidebar']) {
  if (!trendCardText.includes(label)) throw new Error(`用量区块缺少 ${label}`)
}
if (!trendCardText.includes('testAccount') || !trendCardText.includes('cooldown')) {
  throw new Error('账号行缺少测试按钮或冷却标记')
}
console.log('✓ 额度趋势、预警、账号测试与用量历史都渲染出来了')

// 账号「测试」会走 /action test-account，并带 accountId。
const testButtons = findAll(cardTree, (node) => node.type === 'button' && textOf(node) === 'testAccount')
if (testButtons.length !== 2) throw new Error(`应有 2 个账号测试按钮，实际 ${testButtons.length}`)
const beforeTest = calls.length
testButtons[0].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
const testCall = calls[calls.length - 1]
if (calls.length === beforeTest || !String(testCall.body).includes('test-account') || !String(testCall.body).includes('"accountId":"default"')) {
  throw new Error(`账号测试请求不对：${String(testCall?.body).slice(0, 160)}`)
}
console.log('✓ 账号测试按钮会发 action=test-account')

// 侧栏显示今日用量开关会发 display 补丁。
const usageLabel = find(cardTree, (node) => node.type === 'label' && textOf(node) === 'usageShowInSidebar')
if (usageLabel === undefined) throw new Error('找不到「侧栏显示今日用量」开关')
const usageInput = find(usageLabel, (node) => node.type === 'input')
if (usageInput === undefined) throw new Error('侧栏用量开关没有 checkbox')
const beforeUsageToggle = calls.length
usageInput.props.onChange({ target: { checked: false } })
await new Promise((resolve) => setTimeout(resolve, 10))
const usageCall = calls[calls.length - 1]
if (calls.length === beforeUsageToggle || !String(usageCall.body).includes('showUsageInSidebar')) {
  throw new Error(`切换侧栏用量没有发 display 补丁：${String(usageCall?.body).slice(0, 160)}`)
}
console.log('✓ 侧栏用量开关可切换并会发 display 补丁')

// 设置文件读坏时要有明确提示（不能静默重置成默认值）。
STATUS.storage = { settingsError: 'Unexpected token', settingsBackup: 'C:\\data\\settings.json.corrupt-1' }
try {
  cardTree = await mount(card, { t: (key) => key })
  if (!textOf(cardTree).includes('settingsCorrupt')) throw new Error('设置文件损坏时没有提示')
  cardTree = await mount(card, { t: (key) => key })
} finally {
  delete STATUS.storage
}
console.log('✓ 设置文件损坏时会明确提示')

// Qoder Free：0 付费额度要说明「免费模型排队」，而不是让人以为模型坏了。
const qoderGlobalTab = findButton(cardTree, 'Qoder Global')
if (qoderGlobalTab === undefined) throw new Error('找不到 Qoder Global 标签')
qoderGlobalTab.props.onClick()
cardTree = await render(card, { t: (key) => key })
if (!textOf(cardTree).includes('freeModelHint')) {
  throw new Error('Qoder Free 没有渲染「免费模型排队」说明')
}
console.log('✓ Qoder Free 显示免费模型排队说明')

// ---------- 13. 侧栏面板显示趋势；关闭后今日用量徽标消失 ----------
hookStates = []
refSlots = {}
let trendPill = await mount(pill, { t: (key) => key, wide: true })
let trendToggle = find(trendPill, (node) => node.type === 'button' && node.props?.['aria-expanded'] !== undefined)
trendToggle.props.onClick({ preventDefault() {} })
trendPill = await render(pill, { t: (key) => key, wide: true })
const trendPillText = textOf(trendPill)
if (!trendPillText.includes('trendToday') || !trendPillText.includes('trendEta')) {
  throw new Error('侧栏面板没有显示今日消耗与耗尽预估')
}
if (find(trendPill, (node) => node.type === 'polyline') === undefined) {
  throw new Error('侧栏面板没有趋势折线')
}
console.log('✓ 侧栏面板显示今日消耗、耗尽预估与趋势折线')

STATUS.settings.showUsageInSidebar = false
try {
  hookStates = []
refSlots = {}
  let noUsagePill = await mount(pill, { t: (key) => key, wide: true })
  const noUsageToggle = find(noUsagePill, (node) => node.type === 'button' && node.props?.['aria-expanded'] !== undefined)
  noUsageToggle.props.onClick({ preventDefault() {} })
  noUsagePill = await render(pill, { t: (key) => key, wide: true })
  if (textOf(noUsagePill).includes('creditsToday')) {
    throw new Error('关闭「侧栏显示今日用量」后仍然渲染了今日用量徽标')
  }
  console.log('✓ 关闭开关后侧栏不再显示今日用量')
} finally {
  STATUS.settings.showUsageInSidebar = true
}

const wbaiSnapshot = STATUS.providers[1]
STATUS.providers[1] = {
  ...wbaiSnapshot,
  message: longError,
  credential: { status: 'signed-out', reason: 'no-credential', message: longError },
  checkin: {
    enabled: true,
    lastRunAt: 1792253476620,
    completedToday: false,
    lastAttemptAt: 1792253476620,
    result: { provider: 'workbuddy-ai', claimed: 0, credit: 0, outcomes: [{ kind: 'failed', message: longError }] },
  },
}
try {
  cardTree = await mount(card, { t: (key) => key })
  const aiTab = findButton(cardTree, 'WorkBuddy AI')
  if (aiTab === undefined) throw new Error('找不到 WorkBuddy AI 标签')
  aiTab.props.onClick()
  cardTree = await render(card, { t: (key) => key })
  const errorCardText = textOf(cardTree)
  const occurrences = errorCardText.split(longError).length - 1
  if (occurrences !== 1) throw new Error(`同一段长错误应只显示一次，实际 ${occurrences} 次`)
  if (!errorCardText.includes('checkinFailed')) throw new Error('签到失败状态没有渲染')
  const titled = find(cardTree, (node) => node.props?.title === longError)
  if (titled === undefined) throw new Error('签到失败应保留完整原因在 title 里')
  console.log('✓ 长错误只显示一次，签到失败只给短原因（全文在悬停提示里）')
} finally {
  STATUS.providers[1] = wbaiSnapshot
}

// 手改 / 旧版本写坏的磁盘缓存会以 null、字符串、缺字段的形式进 /status。
// 卡片与侧栏小卡必须活下来：一个坏行不能让宿主的 SlotErrorBoundary 把整块替换掉。
const providersSnapshot = STATUS.providers
const statsSnapshot = STATUS.stats
const settingsSnapshot = STATUS.settings
STATUS.providers = [
  null,
  {
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    enabled: true,
    models: [null, { id: 'm' }, { id: 'n', name: 5 }],
    accounts: [null, { id: 'a', credits: null }, { id: 'b', credits: { state: 'ok', items: [null, 7] } }],
    credits: { state: 'ok', remain: null, total: 'x', items: [null, { name: 3 }], trend: { points: [null, { remain: 'x' }] } },
    usage: { today: null },
    checkin: { result: { outcomes: [null, { kind: 'failed' }] } },
    credential: null,
    health: null,
  },
  { provider: 'qoder-global', displayName: 'Qoder Global', enabled: true, models: 'nope', accounts: 'nope', credits: null, usage: {}, checkin: null, credential: {}, health: {} },
]
STATUS.stats = {
  today: null,
  daily: [null, { date: '2026-10-18' }],
  providerDaily: { workbuddy: [null, { date: '2026-10-18', totalTokens: 'x' }] },
  models: { 'workbuddy::m': null },
  recent: [null, { kind: 5 }],
  providerCurrentSession: { workbuddy: null },
}
STATUS.settings = { alerts: { lowRatio: 'x' }, advanced: null, autoSwitch: 'yes', workbuddy: null, qoder: null }
try {
  cardTree = await mount(card, { t: (key) => key })
  if (cardTree === undefined) throw new Error('坏数据下设置卡片没有渲染')

  const brokenPill = await mount(pill, { t: (key) => key, wide: true })
  if (brokenPill === null) throw new Error('坏数据下侧栏小卡不应整块返回 null')

  // 逐页点过去：任何一个 provider 标签都不能把渲染炸掉。
  cardTree = await mount(card, { t: (key) => key })
  for (const tab of findAll(cardTree, (node) => node.type === 'button' && node.props?.role === 'tab')) {
    tab.props.onClick()
    cardTree = await render(card, { t: (key) => key })
  }
  console.log('✓ 坏数据（null / 错类型 / 缺字段）下卡片、标签页与侧栏小卡仍能渲染')
} finally {
  STATUS.providers = providersSnapshot
  STATUS.stats = statsSnapshot
  STATUS.settings = settingsSnapshot
}

// Trae：凭证是桌面端的登录态，不是 PAT。卡片必须显示「登录文件」输入框，
// 而不是 PAT 输入框；保存时补丁要落在 settings.trae 下（不是 settings.qoder）。
const traeSnapshot = STATUS.providers.slice()
STATUS.providers = [
  ...traeSnapshot,
  {
    provider: 'trae', displayName: 'Trae', kind: 'desktop-auth', enabled: true,
    catalogSource: 'live', fetchedAt: 1792234000000,
    health: { state: 'ok', consecutiveFailures: 0, lastErrorAt: 0 },
    usage: { requests: 3, ok: 3, failed: 0, totalTokens: 900, avgDurationMs: 1500, today: { requests: 2, totalTokens: 700 } },
    models: [{ id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200000, maxTokens: 48000, supportsImages: false, reasoningEfforts: [], credits: 'x0.78', disabled: false }],
    modelCount: 1,
    accounts: [{ id: 'default', label: '本机登录', active: true, kind: 'desktop-auth', configured: true, source: 'desktop', credits: { state: 'ok', remain: 199.9, total: 800, unit: 'credits', items: [] } }],
    credits: { state: 'ok', remain: 199.9, total: 800, unit: 'credits', items: [], fetchedAt: 1792234000000 },
    credential: { status: 'signed-in', source: 'desktop', name: '用户2906168306', userId: '3616754657145179', file: 'C:\\Users\\x\\AppData\\Roaming\\Trae CN\\User\\globalStorage\\storage.json' },
    autoSwitch: true,
  },
]
STATUS.settings = { ...settingsSnapshot, trae: { trae: { storageFile: '', configured: true } } }
try {
  cardTree = await mount(card, { t: (key) => key })
  const traeTab = findButton(cardTree, 'Trae')
  if (traeTab === undefined) throw new Error('找不到 Trae 标签')
  traeTab.props.onClick()
  cardTree = await render(card, { t: (key) => key })
  if (find(cardTree, (node) => node.type === 'input' && node.props.type === 'password') !== undefined) {
    throw new Error('Trae 不应该显示 PAT 输入框（它的凭证来自客户端登录态）')
  }
  const storageInput = find(cardTree, (node) => node.type === 'input' && node.props.type === 'text' && String(node.props.placeholder).includes('storage.json'))
  if (storageInput === undefined) throw new Error('Trae 缺少登录文件路径输入框')
  if (!textOf(cardTree).includes('traeSignedIn')) throw new Error('Trae 已登录时没有显示登录态提示')
  // Trae 没有浏览器登录流程（服务端 login-start 会直接拒绝）。账号页不能挂一个
  // 必然失败的「浏览器登录新增账号」按钮，也不能用 WorkBuddy 的添加说明误导用户。
  if (textOf(cardTree).includes('loginAddTitle')) throw new Error('Trae 账号页不应出现浏览器登录按钮')
  if (!textOf(cardTree).includes('accountsHintTrae')) throw new Error('Trae 账号页缺少专属的登录来源说明')
  storageInput.props.onChange({ target: { value: 'D:\\trae\\storage.json' } })
  cardTree = await render(card, { t: (key) => key }, true)
  const saveTraeButton = findButton(cardTree, 'save')
  if (saveTraeButton === undefined) throw new Error('找不到 Trae 保存按钮')
  const beforeTrae = calls.length
  saveTraeButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const traeCall = calls[calls.length - 1]
  if (calls.length === beforeTrae) throw new Error('保存 Trae 路径没有发请求')
  if (!String(traeCall.body).includes('"trae"') || !String(traeCall.body).includes('storage.json')) {
    throw new Error(`Trae 路径应写进 settings.trae，实际：${String(traeCall.body).slice(0, 220)}`)
  }
  console.log('✓ Trae 用登录文件而不是 PAT，路径写进 settings.trae')
} finally {
  STATUS.providers = traeSnapshot
  STATUS.settings = settingsSnapshot
}

// 连点两个模型：第一个 POST 还没回来时点第二个，第二个请求必须带上第一个的改动。
// 旧实现每次都基于「上一次 /status」算 disabledModels，后到的那次会把前一次覆盖掉。
const toggleProviderSnapshot = STATUS.providers[0]
try {
  STATUS.providers[0] = {
    ...toggleProviderSnapshot,
    models: [
      { id: 't1', name: 'T1', contextWindow: 1000, maxTokens: 100, supportsImages: false, reasoningEfforts: [], disabled: false },
      { id: 't2', name: 'T2', contextWindow: 1000, maxTokens: 100, supportsImages: false, reasoningEfforts: [], disabled: false },
    ],
  }
  cardTree = await mount(card, { t: (key) => key })
  const modelBoxes = () => findAll(cardTree, (node) => node.type === 'input'
    && node.props?.type === 'checkbox'
    && typeof node.props['aria-label'] === 'string'
    && (node.props['aria-label'] === 'T1' || node.props['aria-label'] === 'T2'))
  const boxesBefore = modelBoxes()
  if (boxesBefore.length !== 2) throw new Error(`模型复选框数量不对：${boxesBefore.length}`)

  const writesBefore = calls.filter((call) => call.method === 'POST' && String(call.url).includes('/settings')).length
  // 两次点击之间不等响应：这正是不加保护时会丢改动的那种时序。
  boxesBefore[0].props.onChange()
  boxesBefore[1].props.onChange()
  await new Promise((resolve) => setTimeout(resolve, 30))
  // 只看这一次交互追加的补丁（按次数切片，避开前面所有用例留下的调用）。
  const sent = calls
    .filter((call) => call.method === 'POST' && String(call.url).includes('/settings'))
    .slice(writesBefore)
    .map((call) => {
      try {
        return JSON.parse(call.body)?.providers?.workbuddy?.disabledModels
      } catch {
        return undefined
      }
    })
    .filter((value) => Array.isArray(value))
  if (sent.length < 2) throw new Error(`应当发两次设置补丁，实际 ${sent.length}（${JSON.stringify(calls.slice(writesBefore))}）`)
  const last = sent[sent.length - 1]
  if (!last.includes('t1') || !last.includes('t2')) {
    throw new Error(`连点两个模型时后一次请求丢了前一次改动：${JSON.stringify(sent)}`)
  }

  // 再验一条：先「全部关闭」，紧接着单独开启一个 —— 第二次必须基于全关后的集合，
  // 而不是回到只有那一个 id 的状态（否则其余模型会全部复活成「开启」）。
  const allOff = find(cardTree, (node) => node.type === 'button' && textOf(node) === 'hideAll')
  if (allOff === undefined) throw new Error('找不到「全部关闭」按钮')
  const beforeAllOff = calls.filter((call) => call.method === 'POST' && String(call.url).includes('/settings')).length
  allOff.props.onClick()
  const boxesAfterAllOff = modelBoxes()
  boxesAfterAllOff[0].props.onChange()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const afterAllOff = calls
    .filter((call) => call.method === 'POST' && String(call.url).includes('/settings'))
    .slice(beforeAllOff)
    .map((call) => {
      try {
        return JSON.parse(call.body)?.providers?.workbuddy?.disabledModels
      } catch {
        return undefined
      }
    })
    .filter((value) => Array.isArray(value))
  if (afterAllOff.length < 2) throw new Error(`全关 + 单开后应当发两次补丁，实际 ${afterAllOff.length}`)
  const finalList = afterAllOff[afterAllOff.length - 1]
  // 全关后单独开启 t1：t2 必须仍然关着（批量改动没被丢），t1 必须真的被移出
  // 关闭列表（本地意图生效）。旧实现拿 status 里的 model.disabled（全关前后都是
  // false）算下一次值，会把 t1 又塞回列表 —— 界面上勾上了、补丁里还关着。
  if (!finalList.includes('t2')) {
    throw new Error(`全关后单独开启一个模型，把其它模型的关闭状态丢了：${JSON.stringify(afterAllOff)}`)
  }
  if (finalList.includes('t1')) {
    throw new Error(`全关后单独开启 t1，补丁仍把 t1 关着（本地意图没生效）：${JSON.stringify(afterAllOff)}`)
  }
  console.log('✓ 连点两个模型不会互相覆盖（后一次补丁带上全部改动）')
} finally {
  STATUS.providers[0] = toggleProviderSnapshot
}

// ---------- 14. 读失败不冒充 0 分 ----------
//
// 1.7.x：`credits.state === 'error'` 的 provider 在卡片上走「大号数字」分支，
// 显示成「0 积分 / 未读取」；CLI 与诊断则拼成「0 / 0 credits」。用户看到的
// 是一个看起来像真实余额的 0，而不是「读不到」。
const errorSnapshot = STATUS.providers[0]
try {
  STATUS.providers[0] = {
    ...errorSnapshot,
    credits: { state: 'error', remain: 0, total: 0, unit: 'credits', items: [], fetchedAt: Date.now(), message: 'HTTP 503', error: 'HTTP 503' },
  }
  cardTree = await mount(card, { t: (key) => key })
  const errorCard = textOf(cardTree)
  if (errorCard.includes('creditsUnreadable') === false) {
    throw new Error('额度读失败时卡片没有显示「读取失败」')
  }
  // 侧栏胶囊：读失败的 provider 不该占一格（它没有可显示的数字）。
  // 只断言「这一家不在」——QDG 的 0 是 Free 套餐的真实数字，必须留着。
  const errorPill = await mount(pill, { t: (key) => key, wide: true })
  const errorPillSegments = findAll(errorPill, (node) => node.props?.style?.justifyContent === 'flex-start'
    && typeof node.props?.title === 'string')
  const errorPillText = errorPillSegments.map((node) => String(node.props.title)).join(' | ')
  // `displayName` 是「WorkBuddy」而不是「WorkBuddy AI」——用完整前缀区分，
  // 否则 `startsWith('WorkBuddy ')` 会把 WorkBuddy AI 一起算进去。
  if (errorPillSegments.some((node) => /^WorkBuddy\s+\d/.test(String(node.props.title)))) {
    throw new Error(`读失败的 provider 不该在胶囊里出现：${errorPillText}`)
  }
  if (!errorPillText.includes('WorkBuddy AI')) {
    throw new Error(`其余 provider 不该被误删：${errorPillText}`)
  }
  console.log('✓ 额度读失败时显示「读取失败」，不冒充 0 分')
} finally {
  STATUS.providers[0] = errorSnapshot
}

// 全部读失败时，胶囊的兜底入口也要说「读取失败」而不是「未读取」。
const allErrorSnapshot = STATUS.providers.slice()
try {
  STATUS.providers = allErrorSnapshot.map((entry) => ({
    ...entry,
    credits: { state: 'error', remain: 0, total: 0, unit: 'credits', items: [], fetchedAt: Date.now(), error: 'boom' },
  }))
  const fallback = await mount(pill, { t: (key) => key, wide: true })
  const fallbackText = textOf(fallback)
  if (!fallbackText.includes('creditsUnreadable')) {
    throw new Error(`全部读失败时胶囊应显示「读取失败」，实际：${fallbackText}`)
  }
  if (fallbackText.includes('creditsNone')) {
    throw new Error('全部读失败时不该显示「未读取」：那是「还没读过」的意思')
  }
  console.log('✓ 全部读失败时胶囊说明「读取失败」')
} finally {
  STATUS.providers = allErrorSnapshot
}

// ---------- 15. 账号 × 模型用量 ----------
//
// 用户要的是「哪个账号用了哪个模型、多少 token」。models 只给模型合计、
// accounts 只给账号合计，两个账号都用 auto 时都答不了 —— 必须有交叉维度。
cardTree = await mount(card, { t: (key) => key })
const pairText = textOf(cardTree)
if (!pairText.includes('usageAccountModels')) {
  throw new Error('WorkBuddy 有两个账号，卡片应渲染「账号 × 模型用量」')
}
for (const label of ['usageAccountCol', 'usageAccountModelsHint', 'usageModelCalls', 'usageModelTokens']) {
  if (!pairText.includes(label)) throw new Error(`账号 × 模型表缺少 ${label}`)
}

/** 账号 × 模型的数据行（显式 data 标记，列宽调整不再影响测试）。 */
const pairRowNodes = (tree) => findAll(tree, (node) => node.type === 'div'
  && node.props?.['data-pair-row'] === 'true')

// 默认口径必须是「今日」：卡片上方写的是「今日 4 次」，交叉表也必须按今日，
// 否则两处数字对不上（交叉维度是升级后才开始累积的，累计值天然更小）。
let pairRows = pairRowNodes(cardTree)
if (pairRows.length !== 2) {
  throw new Error(`默认「今日」应有 2 行（default/auto、acc-2/auto），实际 ${pairRows.length}`)
}
const todayJoined = pairRows.map((row) => textOf(row)).join(' || ')
if (!todayJoined.includes('50') || todayJoined.includes('300')) {
  throw new Error(`默认应显示今日的 50 tok，而不是累计的 300：${todayJoined}`)
}
if (todayJoined.includes('glm-5.3')) {
  throw new Error('今日没有 glm-5.3 的请求，不该出现这一行')
}
// 覆盖率提示：交叉维度只从升级后开始累积，覆盖的请求数一定小于上方总量。
// 必须显式写出来（「已记录 3 / 4 次」），否则用户拿它和上方「今日 4 次」
// 对比只会觉得数字坏了 —— 这正是用户反馈的那个现象。
const coverageText = textOf(cardTree)
if (!coverageText.includes('usageAccountModelCoverage')) {
  throw new Error('交叉维度覆盖不全时没说清楚：用户会以为数字漏记了')
}
console.log('✓ 账号 × 模型默认按「今日」口径，并标明覆盖率')

// 切到「累计」应换成另一组数字。
const allRangeButton = find(cardTree, (node) => node.type === 'button' && textOf(node) === 'usageTotal')
if (allRangeButton === undefined) throw new Error('缺少「累计」切换按钮')
allRangeButton.props.onClick()
cardTree = await render(card, { t: (key) => key })
pairRows = pairRowNodes(cardTree)
if (pairRows.length !== 3) throw new Error(`「累计」应有 3 行，实际 ${pairRows.length}`)
const joined = pairRows.map((row) => textOf(row)).join(' || ')
if (!joined.includes('本机登录') || !joined.includes('备用账号')) {
  throw new Error(`账号列应显示设置里的 label 而不是 id：${joined}`)
}
if (!joined.includes('auto') || !joined.includes('glm-5.3')) {
  throw new Error(`模型列没有渲染：${joined}`)
}
// 按 token 倒序：300 那条在最前。
const firstPair = textOf(pairRows[0])
if (!firstPair.includes('300') || !firstPair.includes('本机登录')) {
  throw new Error(`账号 × 模型应按 token 倒序，第一行应是「本机登录 / auto / 300」：${firstPair}`)
}
console.log('✓ 账号 × 模型可切到「累计」，按 token 倒序且显示账号名称')

// 只有一个账号时不该渲染这张表（和模型用量完全重复）。
const wbaiTab = findButton(cardTree, 'WorkBuddy AI')
if (wbaiTab !== undefined) {
  wbaiTab.props.onClick()
  cardTree = await render(card, { t: (key) => key })
  if (textOf(cardTree).includes('usageAccountModels')) {
    throw new Error('只有一个账号的 provider 不该渲染「账号 × 模型」表：与模型用量完全重复')
  }
  console.log('✓ 单账号 provider 不渲染账号 × 模型表')
}

// ── 2.0.0：最近事件 ─────────────────────────────────────────────
//
// 这一块回答的是用户最常问的两个问题：「怎么突然换账号了」「额度什么时候
// 开始读不到的」。它只渲染服务端下发的元数据，不能让一个坏字段把卡片打崩。
cardTree = await mount(card, { t: (key) => key })
let eventText = textOf(cardTree)
for (const needle of ['eventTitle', 'eventHint', 'eventSwitch', 'eventRefresh', 'eventCredits']) {
  if (!eventText.includes(needle)) throw new Error(`事件区块缺少 ${needle}`)
}
if (!eventText.includes('切换到「备用账号」')) throw new Error('换号事件的消息没有渲染')
if (!eventText.includes('HTTP 503')) throw new Error('额度失败事件的消息没有渲染')

// 筛选「换号」后，只留下 account-switch 那一条。
const switchFilter = find(cardTree, (node) => node.type === 'button' && textOf(node).startsWith('eventSwitchFilter'))
if (switchFilter === undefined) throw new Error('缺少「换号」筛选按钮')
switchFilter.props.onClick()
cardTree = await render(card, { t: (key) => key })
eventText = textOf(cardTree)
if (!eventText.includes('切换到「备用账号」')) throw new Error('筛选「换号」后应保留换号事件')
if (eventText.includes('登录令牌已自动续期') || eventText.includes('HTTP 503')) {
  throw new Error('筛选「换号」后不该出现其它类型的事件')
}
const selectedSwitch = find(cardTree, (node) => node.type === 'button' && textOf(node).startsWith('eventSwitchFilter'))
if (selectedSwitch.props['aria-pressed'] !== true) throw new Error('筛选按钮没有 aria-pressed 选中态')
console.log('✓ 最近事件可筛选，换号/续期/额度失败分开显示')

// 同一个后台失败会每轮刷新重复一次：时间线必须合并成一行并标 ×N。
// 真实账本里 Trae 国际版「没有额度端点」15 小时记了 14 条，把真正的异常挤下去了。
{
  const eventsSnapshot = STATUS.events
  const base = { type: 'credits', level: 'warn', provider: 'trae-global', accountId: 'default', message: '额度读取失败（本机登录）：Trae 国际版没有提供额度查询接口' }
  STATUS.events = {
    version: 1,
    count: 4,
    latestAt: 1792234600000,
    limit: 50,
    items: [
      { ...base, id: 'dup-1', at: 1792234600000 },
      { ...base, id: 'dup-2', at: 1792234000000 },
      { ...base, id: 'dup-3', at: 1792233400000 },
      { ...base, id: 'dup-4', at: 1792232800000 },
    ],
  }
  try {
    cardTree = await mount(card, { t: realT })
    const rows = findAll(cardTree, (node) => node.type === 'li' && textOf(node).includes('Trae 国际版没有提供额度查询接口'))
    if (rows.length !== 1) throw new Error(`同一事件应合并成 1 行，实际 ${rows.length} 行`)
    const rowText = textOf(rows[0])
    if (!rowText.includes('×4')) throw new Error('合并后的行没有显示 ×4 次数')
    if (!/异常\s*1/.test(textOf(cardTree))) throw new Error('筛选按钮的计数没有跟着合并后的行数走')
    const repeat = find(cardTree, (node) => typeof node.props?.title === 'string' && node.props.title.includes('同一事件共 4 次'))
    if (repeat === undefined) throw new Error('合并行没有给出首次/最新时间的悬停说明')
    if (!/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(String(repeat.props.title))) {
      throw new Error('合并行的首次/最新时间没有格式化')
    }
    console.log('✓ 重复事件合并为一行，显示 ×N 与首末时间')
  } finally {
    STATUS.events = eventsSnapshot
  }
  // 后面的清空用例要用回 key-only 的 t 与默认筛选状态。
  cardTree = await mount(card, { t: (key) => key })
}

// 清空是写操作：必须带控制密钥走 /action，不能只清本地状态。
const clearButton = find(cardTree, (node) => node.type === 'button' && textOf(node) === 'eventClear')
if (clearButton === undefined) throw new Error('缺少「清空事件」按钮')
const beforeClear = calls.length
clearButton.props.onClick()
const clearCall = calls[calls.length - 1]
cardTree = await render(card, { t: (key) => key })
if (calls.length === beforeClear || !clearCall.url.includes('/action')) throw new Error('清空事件没有发 /action 请求')
if (!String(clearCall.body).includes('events-clear')) throw new Error('清空事件的请求体不对')
console.log('✓ 清空事件走服务端事件账本')

// 老宿主（status v7 之前）没有 events 字段：整块隐藏，而不是渲染半个空区块。
const eventsSnapshot = STATUS.events
delete STATUS.events
cardTree = await mount(card, { t: (key) => key })
if (textOf(cardTree).includes('eventTitle')) throw new Error('没有事件字段时不该渲染半个空区块')
STATUS.events = eventsSnapshot
console.log('✓ 老宿主没有事件账本时整块隐藏')

// ── 0.7.0：事件按服务商 / 账号筛选，并能导出当前结果 ─────────────
{
  const snapshot = STATUS.events
  const baseAt = 1792234000000
  STATUS.events = {
    version: 1,
    count: 4,
    latestAt: baseAt,
    limit: 50,
    items: [
      { id: 'f1', at: baseAt, type: 'account-switch', level: 'warn', provider: 'workbuddy', accountId: 'acc-2', message: '切换到「备用账号」' },
      { id: 'f2', at: baseAt - 60000, type: 'credential-refresh', level: 'info', provider: 'workbuddy', accountId: 'default', message: '令牌已续期（本机登录）' },
      { id: 'f3', at: baseAt - 120000, type: 'credits', level: 'warn', provider: 'qoder-global', accountId: 'default', message: '额度读取失败（默认令牌）：HTTP 503' },
      { id: 'f4', at: baseAt - 180000, type: 'checkin', level: 'info', provider: 'qoder', accountId: 'default', message: '签到完成' },
    ],
  }
  const providerSelectOf = (tree) => find(tree, (node) => node.type === 'select' && node.props?.['aria-label'] === '按服务商筛选事件')
  const accountSelectOf = (tree) => find(tree, (node) => node.type === 'select' && node.props?.['aria-label'] === '按账号筛选事件')
  try {
    cardTree = await mount(card, { t: realT })
    const providerSelect = providerSelectOf(cardTree)
    if (providerSelect === undefined) throw new Error('缺少按服务商筛选事件的下拉框')
    const providerText = textOf(providerSelect)
    for (const name of ['全部服务商', 'WorkBuddy', 'Qoder Global', 'qoder']) {
      if (!providerText.includes(name)) throw new Error(`服务商下拉缺少「${name}」：${providerText}`)
    }
    const accountSelect = accountSelectOf(cardTree)
    if (accountSelect === undefined) throw new Error('缺少按账号筛选事件的下拉框')
    const accountText = textOf(accountSelect)
    for (const name of ['全部账号', 'WorkBuddy · 本机登录', 'WorkBuddy · 备用账号']) {
      if (!accountText.includes(name)) throw new Error(`账号下拉缺少「${name}」：${accountText}`)
    }

    providerSelect.props.onChange({ target: { value: 'workbuddy' } })
    cardTree = await render(card, { t: realT })
    let eventText = textOf(cardTree)
    if (!eventText.includes('切换到「备用账号」') || !eventText.includes('令牌已续期')) {
      throw new Error('按服务商筛选后应保留该服务商的事件')
    }
    if (eventText.includes('HTTP 503') || eventText.includes('签到完成')) {
      throw new Error('按服务商筛选后仍显示其它服务商的事件')
    }
    // 计数跟着筛选范围走：WorkBuddy 只有 2 条。
    if (!find(cardTree, (node) => node.type === 'button' && textOf(node) === '全部 2')) {
      throw new Error('类型筛选计数没有跟着服务商范围收窄')
    }

    const accountSelect2 = accountSelectOf(cardTree)
    const scopedAccountText = textOf(accountSelect2)
    if (scopedAccountText.includes('WorkBuddy ·')) throw new Error('选定服务商后账号下拉仍在拼服务商前缀')
    accountSelect2.props.onChange({ target: { value: 'workbuddy::default' } })
    cardTree = await render(card, { t: realT })
    eventText = textOf(cardTree)
    if (!eventText.includes('令牌已续期')) throw new Error('按账号筛选后应保留该账号的事件')
    if (eventText.includes('切换到「备用账号」') || eventText.includes('HTTP 503')) {
      throw new Error('按账号筛选后仍显示其它账号的事件')
    }

    // 导出：沙箱里没有 Blob/URL，必须退化成可复制的 JSON 文本，而不是点了没反应。
    const exportButton = find(cardTree, (node) => node.type === 'button' && node.props?.['aria-label'] === '把当前筛选的事件导出为 JSON')
    if (exportButton === undefined) throw new Error('缺少导出按钮')
    if (exportButton.props.disabled === true) throw new Error('有筛选结果时导出按钮不应禁用')
    exportButton.props.onClick()
    cardTree = await render(card, { t: realT })
    const fallbackBox = find(cardTree, (node) => node.type === 'textarea' && String(node.props?.value || '').startsWith('{'))
    if (fallbackBox === undefined) throw new Error('无法下载时没有给出可复制的 JSON')
    const exported = JSON.parse(fallbackBox.props.value)
    if (exported.filters.provider !== 'workbuddy' || exported.filters.accountId !== 'default') {
      throw new Error(`导出没有带上当前筛选条件：${JSON.stringify(exported.filters)}`)
    }
    if (exported.retained !== 1 || exported.events.length !== 1) throw new Error('导出没有按当前筛选收窄事件')
    if (exported.count !== 4) throw new Error('导出应保留历史总数，不能让人误以为只有筛出来的这些')
    console.log('✓ 事件可按服务商 / 账号筛选，计数同步收窄，并能导出当前结果 JSON')

    const resetButton = find(cardTree, (node) => node.type === 'button' && textOf(node).includes('重置筛选'))
    if (resetButton === undefined) throw new Error('筛选生效后没有重置入口')
    resetButton.props.onClick()
    cardTree = await render(card, { t: realT })
    eventText = textOf(cardTree)
    if (!eventText.includes('HTTP 503') || !eventText.includes('签到完成')) throw new Error('重置筛选后没有恢复全部事件')
    if (!find(cardTree, (node) => node.type === 'select' && node.props?.value === '')) throw new Error('重置后下拉没有回到「全部」')
    if (find(cardTree, (node) => node.type === 'textarea' && String(node.props?.value || '').startsWith('{'))) {
      throw new Error('重置筛选后应清掉上一次的导出兜底文本')
    }
    console.log('✓ 重置筛选恢复全部事件，并清掉导出兜底')
  } finally {
    STATUS.events = snapshot
  }
}

// ── 0.7.0：账号行显示「最近成功 / 最近失败」而不是最后一次请求 ─────
{
  const provider = STATUS.providers[0]
  const accountsSnapshot = provider.accounts
  const now = Date.now()
  provider.accounts = [
    {
      ...accountsSnapshot[0],
      usage: {
        requests: 5, ok: 4, failed: 1, totalTokens: 700,
        lastAt: now - 60_000, lastOkAt: now - 5 * 60_000, lastErrorAt: now - 60_000,
      },
    },
    {
      ...accountsSnapshot[1],
      cooldownUntil: 0,
      lastTest: undefined,
      usage: {
        requests: 2, ok: 2, failed: 0, totalTokens: 20,
        lastAt: now - 2 * 3600_000, lastOkAt: now - 2 * 3600_000, lastErrorAt: 0,
      },
    },
  ]
  try {
    cardTree = await mount(card, { t: realT })
    const accountsTab = find(cardTree, (node) => node.type === 'button' && textOf(node).split(' | ')[0] === '账号')
    if (accountsTab === undefined) throw new Error('缺少账号分区入口')
    accountsTab.props.onClick()
    cardTree = await render(card, { t: realT })
    const rows = findAll(cardTree, (node) => node.type === 'div' && node.props?.role === 'row' && node.props?.className === 'rpc-table-row rpc-account-row')
    if (rows.length !== 2) throw new Error(`账号表应有 2 行，实际 ${rows.length}`)
    const activeRow = rows.find((row) => textOf(row).includes('本机登录'))
    const idleRow = rows.find((row) => textOf(row).includes('备用账号'))
    if (activeRow === undefined || idleRow === undefined) throw new Error('账号行没有按名称渲染')
    const activeText = textOf(activeRow)
    if (!activeText.includes('最近成功')) throw new Error('账号行没有显示最近一次成功请求时间')
    if (!activeText.includes('最近失败')) throw new Error('最近失败晚于成功时没有同时显示失败时间')
    if (!activeText.includes('模型 auto')) throw new Error('最近成功时间旁边丢了模型名')
    const idleTitled = find(idleRow, (node) => typeof node.props?.title === 'string' && /最近成功\s+\d{4}-\d{2}-\d{2}/.test(node.props.title))
    if (idleTitled === undefined) throw new Error('账号行的悬停提示没有给出完整成功时间戳')
    if (!textOf(idleRow).includes('最近成功')) throw new Error('只有成功记录的账号也应显示最近成功时间')
    if (textOf(idleRow).includes('最近失败')) throw new Error('没有失败记录的账号不应显示最近失败')
    console.log('✓ 账号行显示最近成功时间（失败晚于成功时并列），完整时间戳在悬停里')
  } finally {
    provider.accounts = accountsSnapshot
  }
}

// ── 2.0.0：审查修复的回归 ───────────────────────────────────────
//
// 1) forced 模型不能混在「可用列表」里：那个勾选框代表启用/停用，点一下却
//    会取消强制显示，语义完全错位。
const wbModelsSnapshot = STATUS.providers[0].models.slice()
STATUS.providers[0].models.push({
  id: 'paid-only', name: 'Paid Only', contextWindow: 128000, maxTokens: 32000,
  supportsImages: false, reasoningEfforts: [], disabled: false, unavailable: true, forced: true,
})
STATUS.providers[0].modelCount = STATUS.providers[0].models.length
cardTree = await mount(card, { t: (key) => key })
if (!textOf(cardTree).includes('unavailableCount')) throw new Error('有 unavailable 模型时应渲染折叠区')
const forcedInput = find(cardTree, (node) => node.type === 'input' && node.props?.['aria-label'] === 'Paid Only')
if (forcedInput === undefined) throw new Error('forced 模型应出现在「账号不支持」折叠区')
if (forcedInput.props.checked !== true) throw new Error('forced 模型的勾选态应为 true')
const beforeUnforce = calls.length
forcedInput.props.onChange()
const unforceCall = calls[calls.length - 1]
if (calls.length === beforeUnforce || !String(unforceCall.body).includes('forcedModels')) {
  throw new Error('取消强制显示应发送 forcedModels 补丁')
}
if (String(unforceCall.body).includes('paid-only')) throw new Error('取消强制显示后不应再包含该模型 id')
STATUS.providers[0].models = wbModelsSnapshot
STATUS.providers[0].modelCount = wbModelsSnapshot.length
console.log('✓ forced 模型只出现在「账号不支持」区，勾选即强制显示')

// 2) 状态版本不一致要显式告警，而不是静默少渲染字段。
const versionSnapshot = STATUS.version
STATUS.version = 7
cardTree = await mount(card, { t: (key) => key })
if (!textOf(cardTree).includes('statusVersionMismatch')) throw new Error('状态版本不匹配时没有告警')
STATUS.version = versionSnapshot
console.log('✓ 状态版本不一致时给出明确告警')

// 3) 部分模型数据缺 name/id 时，搜索不能把整张卡片打崩。
const searchModels = STATUS.providers[0].models.slice()
STATUS.providers[0].models = Array.from({ length: 7 }, (_, index) => ({
  id: 'm' + index, name: index === 0 ? undefined : 'Model ' + index,
  contextWindow: 1000, maxTokens: 100, supportsImages: false, reasoningEfforts: [], disabled: false,
}))
STATUS.providers[0].modelCount = 7
cardTree = await mount(card, { t: (key) => key })
const searchInput = find(cardTree, (node) => node.type === 'input' && node.props?.type === 'search')
if (searchInput === undefined) throw new Error('模型多于 6 个时应出现搜索框')
searchInput.props.onChange({ target: { value: 'zzz' } })
cardTree = await render(card, { t: (key) => key })
if (!textOf(cardTree).includes('searchEmpty')) throw new Error('无匹配时应显示空结果，而不是抛错')
STATUS.providers[0].models = searchModels
STATUS.providers[0].modelCount = searchModels.length
console.log('✓ 坏模型数据 + 搜索不会打崩卡片')

// 4) tabs 支持方向键（WAI-ARIA 的标准模式）。
cardTree = await mount(card, { t: (key) => key })
const tablist = find(cardTree, (node) => node.props?.role === 'tablist')
if (tablist === undefined) throw new Error('缺少 tablist')
let prevented = false
tablist.props.onKeyDown({ key: 'ArrowRight', preventDefault() { prevented = true } })
cardTree = await render(card, { t: (key) => key })
const aiTab = findButton(cardTree, 'WorkBuddy AI')
if (aiTab === undefined || aiTab.props['aria-selected'] !== true) throw new Error('ArrowRight 应切到下一个 provider')
if (!prevented) throw new Error('方向键应 preventDefault，避免滚动页面')
console.log('✓ provider 标签支持方向键切换')

// 5) 用量汇总不再用 52px 固定标签列：中文「当前会话」会被裁成「当…」。
//    改成 KPI 卡片后，标签列不再存在；如果谁把旧表格加回来，这条会失败。
cardTree = await mount(card, { t: (key) => key })
const legacySummary = find(cardTree, (node) => typeof node.props?.style?.gridTemplateColumns === 'string'
  && node.props.style.gridTemplateColumns.startsWith('52px minmax'))
if (legacySummary !== undefined) throw new Error('用量汇总仍在使用 52px 固定标签列，中文会被截断')
const sessionCard = find(cardTree, (node) => node.type === 'div'
  && Array.isArray(node.children) && node.children.length > 0
  && textOf(node.children[0]) === 'usageSession')
if (sessionCard === undefined) throw new Error('缺少「当前会话」KPI 卡片')
const sessionCardText = textOf(sessionCard)
if (!sessionCardText.includes('30')) throw new Error(`当前会话卡片缺少 tokens 数字：${sessionCardText}`)
if (!sessionCardText.includes('usageTokenShort')) throw new Error('当前会话卡片缺少 tokens 标签')
const tokenValue = find(sessionCard, (node) => textOf(node) === '30' && node.props?.style?.textAlign === 'right')
if (tokenValue === undefined) throw new Error('KPI 指标数值应右对齐，才能跨卡片对齐')
if (find(sessionCard, (node) => textOf(node) === '·') !== undefined) {
  throw new Error('KPI 指标不应再用「·」连接（窄卡片换行会以点开头）')
}
console.log('✓ 用量汇总改为 KPI 卡片，长中文标签不再被截断')

// 6) 今日桶暂时为空、但累计桶有数据时，不能把整张「账号 × 模型」表藏掉。
//    这正是用户反馈「1.9 的账号×模型好像没实现」的场景：升级后当天还没发请求，
//    accountModelToday 是 {}，旧逻辑把它当成有今日口径 → 0 行 → 表消失。
const todayPairSnapshot = STATUS.stats.accountModelToday
STATUS.stats.accountModelToday = {}
try {
  cardTree = await mount(card, { t: (key) => key })
  const fallbackPairRows = pairRowNodes(cardTree)
  if (fallbackPairRows.length !== 3) {
    throw new Error(`今日为空时应回退到累计的 3 行，实际 ${fallbackPairRows.length}`)
  }
  const fallbackText = textOf(cardTree)
  if (!fallbackText.includes('usageAccountModelTodayEmpty')) {
    throw new Error('回退到累计时没有说明「今天还没有记录」')
  }
  if (!fallbackText.includes('usageAccountModelCoverage')) {
    throw new Error('回退到累计时仍要标明覆盖率，不能装作数据完整')
  }
  if (find(cardTree, (node) => node.type === 'button' && textOf(node) === 'usageTotal') !== undefined) {
    throw new Error('没有今日数据时不该渲染无意义的「累计」切换按钮')
  }
  console.log('✓ 今日交叉数据为空时回退显示累计，不再整表消失')
} finally {
  STATUS.stats.accountModelToday = todayPairSnapshot
}

// 7) 即使账号 × 模型没有历史交叉数据，账号行也要能回答「这个账号一共用了多少」。
const accountUsageSnapshot = STATUS.providers[0].accounts
STATUS.providers[0].accounts = STATUS.providers[0].accounts.map((account, index) => ({
  ...account,
  usage: index === 0
    ? { requests: 639, totalTokens: 199976603 }
    : { requests: 590, totalTokens: 200276253 },
}))
try {
  cardTree = await mount(card, { t: (key) => key })
  const accountListText = textOf(cardTree)
  if (!accountListText.includes('639') || !accountListText.includes('200.3M')) {
    throw new Error('账号行没有显示该账号自己的请求数 / token')
  }
  if (!accountListText.includes('usageCalls') || !accountListText.includes('usageTokenShort')) {
    throw new Error('账号用量缺少文案标签')
  }
  console.log('✓ 账号行显示各自累计请求与 token')
} finally {
  STATUS.providers[0].accounts = accountUsageSnapshot
}

// 8) 账号 × 模型只展示测试结果徽章；重复的「检测」按钮已移除。
//    自定义模型测试统一走概览的「可用性测试」。
const modelTestSnapshot = STATUS.providers[0].accounts
STATUS.providers[0].accounts = STATUS.providers[0].accounts.map((account) => ({
  ...account,
  modelTests: account.id === 'default'
    ? {
        auto: {
          at: Date.now(),
          ok: false,
          code: 'RATE_LIMIT',
          model: 'auto',
          error: '您的使用量已超出频率限制，将在 2026-10-19 15:33:04 UTC+8 重置',
          resetHint: '2026-10-19 15:33:04 UTC+8',
        },
      }
    : {},
}))
try {
  cardTree = await mount(card, { t: (key) => key })
  const modelTestRows = pairRowNodes(cardTree)
  const limitedRow = modelTestRows.find((row) => textOf(row).includes('本机登录') && textOf(row).includes('auto'))
  if (limitedRow === undefined) throw new Error('找不到 default / auto 的账号 × 模型行')
  if (!textOf(limitedRow).includes('limitBadge')) {
    throw new Error('429 的模型测试结果没有渲染「限额」徽章')
  }
  const limitChip = find(limitedRow, (node) => node.type === 'span' && textOf(node) === 'limitBadge')
  if (limitChip === undefined || !String(limitChip.props?.title ?? '').includes('limitUntil')) {
    throw new Error('限额徽章的悬停提示缺少重置时间')
  }
  const duplicateTestButton = find(limitedRow, (node) => node.type === 'button' && textOf(node) === 'modelTest')
  if (duplicateTestButton !== undefined) {
    throw new Error('账号 × 模型行仍有重复的「检测」按钮，应统一走可用性测试')
  }
  console.log('✓ 账号 × 模型只展示测试结果徽章，重复的「检测」按钮已移除')
} finally {
  STATUS.providers[0].accounts = modelTestSnapshot
}

// ── 2.2.1 UI/UX 修复回归 ─────────────────────────────────────────
// 9) 宿主没有 bg-l2 / state-warning-primary 这两个 token，插件自建
//    --dsh-rpc-fill / --dsh-rpc-warn（亮/暗各一套）；重复 apply 不得重复注入。
if (injectedStyles.length !== 1) throw new Error(`主题样式应只注入一次，实际 ${injectedStyles.length}`)
const themeCss = String(injectedStyles[0].textContent)
if (!themeCss.includes('--dsh-rpc-warn') || !themeCss.includes('--dsh-rpc-fill')) {
  throw new Error('主题样式缺少 --dsh-rpc-warn / --dsh-rpc-fill')
}
if (!themeCss.includes('body[data-ds-dark-theme]')) throw new Error('主题样式缺少暗色主题覆盖')
captured.apply(ctx)
if (injectedStyles.length !== 1) throw new Error('重复 apply 时主题样式被重复注入')
console.log('✓ 主题 token 自建属性只注入一次（亮/暗各一套）')

// 10) 小字对比度：≤12.5px 的文本不得再用 label-tertiary，也不得靠 ≤0.62 的透明度降级。
cardTree = await mount(card, { t: (key) => key })
const tinyTextNodes = findAll(cardTree, (node) => typeof node.type === 'string'
  && textOf(node) !== ''
  && typeof node.props?.style?.fontSize === 'number'
  && node.props.style.fontSize <= 12.5)
const badTiny = tinyTextNodes.filter((node) => {
  const style = node.props.style
  if (String(style.color ?? '').includes('label-tertiary')) return true
  return typeof style.opacity === 'number' && style.opacity <= 0.62
})
if (badTiny.length > 0) {
  throw new Error(`仍有小字用 tertiary/透明度降级：${badTiny.map((node) => textOf(node).slice(0, 20)).join(' | ')}`)
}
console.log('✓ 小字统一用 label-secondary，不再叠低透明度')

// 11) 首屏 /status 失败：完整卡片外壳 + 本地化说明 + 可点重试，role=status。
fetchFailure = 'status'
try {
  cardTree = await mount(card, { t: (key) => key })
  const failText = textOf(cardTree)
  if (!failText.includes('statusLoadFailed') || !failText.includes('statusLoadFailedHint')) {
    throw new Error(`首屏失败态缺少本地化说明：${failText}`)
  }
  if (failText.includes('ECONNREFUSED')) throw new Error('首屏失败态仍把裸英文错误显示在正文')
  const retryButton = findButton(cardTree, 'retry')
  if (retryButton === undefined) throw new Error('首屏失败态缺少重试按钮')
  if (!find(cardTree, (node) => node.props?.role === 'status')) throw new Error('首屏失败态缺少 role=status')
  const beforeRetry = calls.length
  fetchFailure = null
  retryButton.props.onClick()
  cardTree = await render(card, { t: (key) => key })
  if (calls.length === beforeRetry) throw new Error('点重试没有重新请求 /status')
  if (!textOf(cardTree).includes('v9.9.9')) throw new Error('重试成功后没有恢复正常卡片')
  console.log('✓ 首屏读取失败有本地化说明与可点的重试按钮')
} finally {
  fetchFailure = null
}

// 12) IMG/TXT 徽标走 locale，不再硬编码。
cardTree = await mount(card, { t: (key) => key })
const imgText = textOf(cardTree)
if (imgText.includes('IMG') || imgText.includes('TXT')) throw new Error('图片能力徽标仍然硬编码 IMG/TXT')
if (!find(cardTree, (node) => textOf(node) === 'imagesShort')) throw new Error('图片能力徽标没有走 locale')
console.log('✓ IMG/TXT 徽标改为 locale 文案')

// 13) 未登录 provider 的「立即签到」禁用，已登录 provider 不受影响。
const signedInCard = await mount(card, { t: (key) => key })
const signedInCheckin = findButton(signedInCard, 'checkinNow')
if (signedInCheckin === undefined || signedInCheckin.props.disabled === true) {
  throw new Error('已登录 provider 的签到按钮被误禁用')
}
const qoderCredential = STATUS.providers[2].credential
STATUS.providers[2].credential = { status: 'signed-out', reason: 'no-credential' }
try {
  cardTree = await mount(card, { t: (key) => key, initialProvider: 'qoder-global' })
  const blockedCheckin = findButton(cardTree, 'checkinNow')
  if (blockedCheckin === undefined) throw new Error('未登录 provider 缺少签到按钮')
  if (blockedCheckin.props.disabled !== true) throw new Error('未登录时「立即签到」仍可点')
  if (blockedCheckin.props.title !== 'checkinNeedLogin') throw new Error('签到禁用没有说明原因')
  const beforeBlockedClick = calls.length
  blockedCheckin.props.onClick()
  if (calls.length !== beforeBlockedClick) throw new Error('禁用状态下仍然发出了签到请求')
  console.log('✓ 未登录 provider 的「立即签到」禁用并给出原因')
} finally {
  STATUS.providers[2].credential = qoderCredential
}

// 14) aria-controls 只在目标节点真正渲染时输出（折叠态不留悬空引用）。
cardTree = await mount(card, { t: (key) => key })
const diagToggleButtons = findAll(cardTree, (node) => node.type === 'button' && textOf(node) === 'diagnostics')
if (diagToggleButtons.length === 0) throw new Error('找不到诊断按钮')
if (diagToggleButtons.some((node) => node.props['aria-controls'] !== undefined)) {
  throw new Error('折叠时 aria-controls 指向了未挂载的诊断节点')
}
diagToggleButtons[0].props.onClick()
cardTree = await render(card, { t: (key) => key })
const openDiag = findAll(cardTree, (node) => node.type === 'button'
  && textOf(node) === 'diagnostics' && node.props['aria-controls'] !== undefined)
if (openDiag.length === 0) throw new Error('展开后诊断按钮没有 aria-controls')
let fixPill = await mount(pill, { t: (key) => key, wide: true })
const fixPillToggle = find(fixPill, (node) => node.type === 'button' && node.props?.['aria-expanded'] !== undefined)
if (fixPillToggle === undefined) throw new Error('找不到胶囊展开按钮')
if (fixPillToggle.props['aria-controls'] !== undefined) throw new Error('胶囊折叠时 aria-controls 悬空')
fixPillToggle.props.onClick({ preventDefault() {} })
fixPill = await render(pill, { t: (key) => key, wide: true })
const expandedToggle = find(fixPill, (node) => node.type === 'button' && node.props?.['aria-expanded'] === true)
if (expandedToggle === undefined || expandedToggle.props['aria-controls'] === undefined) {
  throw new Error('胶囊展开后缺少 aria-controls')
}
console.log('✓ aria-controls 只在目标节点真正渲染时输出')

// 15) 文本/数字输入都有可访问名（aria-label）。
cardTree = await mount(card, { t: (key) => key })
const ariaLabels = findAll(cardTree, (node) => node.type === 'input' && typeof node.props?.['aria-label'] === 'string')
  .map((node) => node.props['aria-label'])
for (const expected of ['appPath', 'authFile', 'advancedIdle', 'advancedCatalog', 'advancedCredits', 'advancedAlert', 'advancedSwitch', 'advancedQueue']) {
  if (!ariaLabels.includes(expected)) throw new Error(`输入框缺少 aria-label：${expected}`)
}
cardTree = await mount(card, { t: (key) => key, initialProvider: 'qoder-global' })
const patAriaLabels = findAll(cardTree, (node) => node.type === 'input' && typeof node.props?.['aria-label'] === 'string')
  .map((node) => node.props['aria-label'])
for (const expected of ['pat', 'accountLabel', 'accountPat']) {
  if (!patAriaLabels.includes(expected)) throw new Error(`PAT 输入框缺少 aria-label：${expected}`)
}
console.log('✓ 文本/数字输入都有 aria-label 可访问名')

// 16) 侧栏刷新失败：面板底部 role=status 文案，不再只有 1.6 秒描边变色。
fetchFailure = 'action'
try {
  fixPill = await mount(pill, { t: (key) => key, wide: true })
  const pillToggle = find(fixPill, (node) => node.type === 'button' && node.props?.['aria-expanded'] === false)
  pillToggle.props.onClick({ preventDefault() {} })
  fixPill = await render(pill, { t: (key) => key, wide: true })
  const refreshButton = find(fixPill, (node) => node.type === 'button' && textOf(node) === 'creditsRefresh')
  if (refreshButton === undefined) throw new Error('展开面板里找不到刷新按钮')
  refreshButton.props.onClick({ preventDefault() {} })
  fixPill = await render(pill, { t: (key) => key, wide: true })
  if (!textOf(fixPill).includes('refreshFailed')) throw new Error('刷新失败没有可见文案提示')
  if (!find(fixPill, (node) => node.props?.role === 'status' && textOf(node).includes('refreshFailed'))) {
    throw new Error('刷新失败提示缺少 role=status')
  }
  console.log('✓ 侧栏刷新失败有 role=status 文案')
} finally {
  fetchFailure = null
}

// 17) 诊断复制失败不再静默：按钮变「复制失败」并给出可手动复制的 textarea。
cardTree = await mount(card, { t: (key) => key })
const copyButton = find(cardTree, (node) => node.type === 'button' && textOf(node) === 'copyDiagnostics')
if (copyButton === undefined) throw new Error('找不到「复制诊断」按钮')
copyButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
cardTree = await render(card, { t: (key) => key })
if (!textOf(cardTree).includes('copyFailed')) throw new Error('复制失败没有可见反馈')
if (!textOf(cardTree).includes('copyFallbackHint')) throw new Error('复制失败没有手动复制说明')
const fallbackArea = find(cardTree, (node) => node.type === 'textarea' && typeof node.props?.value === 'string' && node.props.value.length > 10)
if (fallbackArea === undefined) throw new Error('复制失败没有可手动复制的 textarea 兜底')

// 之后自动复制恢复：手动复制框必须收掉，否则界面会一直摆着一份可能过期的诊断。
sandbox.navigator.clipboard = { writeText: () => Promise.resolve() }
const copyAgain = find(cardTree, (node) => node.type === 'button' && (textOf(node) === 'copyFailed' || textOf(node) === 'copyDiagnostics'))
if (copyAgain === undefined) throw new Error('复制失败后找不到再次复制按钮')
copyAgain.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 20))
cardTree = await render(card, { t: (key) => key })
if (find(cardTree, (node) => node.type === 'textarea' && typeof node.props?.value === 'string' && node.props.value.length > 10) !== undefined) {
  throw new Error('复制恢复成功后仍留着上一次的失败兜底 textarea')
}
delete sandbox.navigator.clipboard
console.log('✓ 复制失败有可见反馈与手动复制兜底；恢复后兜底会收掉')

// ── 2.4.0 UI 打磨回归 ────────────────────────────────────────────
// 18) Qoder Free 的汇总卡大数字显示「免费」，不再显示 0；完整额度留在 title。
cardTree = await mount(card, { t: (key) => key })
const freeValueSpan = find(cardTree, (node) => node.type === 'span'
  && node.props?.style?.fontSize === 20
  && textOf(node) === 'creditsFree')
if (freeValueSpan === undefined) throw new Error('Qoder Free 汇总卡仍显示 0，没有显示「免费」')
if (String(freeValueSpan.props?.title ?? '').indexOf('creditsUnit') === -1) {
  throw new Error('Qoder Free 汇总卡的 title 没有保留完整额度文案')
}
// 19) 侧栏胶囊里的 Qoder Free 显示短版「免费」，title/aria-label 仍是完整文案。
fixPill = await mount(pill, { t: (key) => key, wide: true })
if (!textOf(fixPill).includes('creditsFreeShort')) throw new Error('胶囊里的 Qoder Free 没有显示短版「免费」')
const freeSegment = find(fixPill, (node) => String(node.props?.title ?? '').includes('creditsUnit')
  && String(node.props.title).indexOf('Qoder Global') !== -1)
if (freeSegment === undefined) throw new Error('胶囊段的 title 没有保留完整额度文案')
console.log('✓ Qoder Free 在汇总卡/胶囊显示「免费」，完整额度保留在 title')

// 20) 读不到额度：中性色「—」+ 原因 title，不再用 provider 强调色；不换行保证 6 卡高度稳定。
const savedCredits01 = STATUS.providers[0].credits
try {
  STATUS.providers[0].credits = { state: 'error', error: 'HTTP 503' }
  cardTree = await mount(card, { t: (key) => key })
  const unreadableSpan = find(cardTree, (node) => node.type === 'span'
    && node.props?.style?.fontSize === 20
    && String(node.props?.title ?? '').indexOf('creditsUnreadable') !== -1)
  if (unreadableSpan === undefined) throw new Error('读取失败的汇总卡没有给出原因 title')
  if (String(unreadableSpan.props.title).indexOf('HTTP 503') === -1) throw new Error('读取失败的 title 缺少上游错误')
  if (!String(unreadableSpan.props.style?.color ?? '').includes('label-tertiary')) {
    throw new Error(`读不到额度仍在用强调色：${unreadableSpan.props.style?.color}`)
  }
  if (unreadableSpan.props.style?.whiteSpace !== 'nowrap') throw new Error('大数字没有 nowrap，卡片高度可能因文案换行')
  if (textOf(unreadableSpan) !== '—') throw new Error('读不到额度应显示「—」')
  STATUS.providers[0].credits = { state: 'none' }
  cardTree = await mount(card, { t: (key) => key })
  const noneSpan = find(cardTree, (node) => node.type === 'span'
    && node.props?.style?.fontSize === 20
    && String(node.props?.title ?? '').indexOf('creditsNone') !== -1)
  if (noneSpan === undefined) throw new Error('「未读取」与「读取失败」没有区分 title')
  console.log('✓ 读不到额度用中性色「—」，title 区分未读取/读取失败且不换行')
} finally {
  STATUS.providers[0].credits = savedCredits01
}

// 21) 数字格式一致：10000 以下带千分位（汇总卡 + 胶囊），10000 以上仍 k 缩写。
const bigValueTexts = (tree) => findAll(tree, (node) => node.type === 'span'
  && node.props?.style?.fontSize === 20 && node.props?.style?.fontVariantNumeric === 'tabular-nums')
  .map((node) => textOf(node))
try {
  STATUS.providers[0].credits = { state: 'ok', remain: 2388, total: 10000, unit: 'credits' }
  cardTree = await mount(card, { t: (key) => key })
  if (!bigValueTexts(cardTree).includes('2,388')) throw new Error('汇总卡 2388 没有千分位')
  fixPill = await mount(pill, { t: (key) => key, wide: true })
  if (!textOf(fixPill).includes('2,388')) throw new Error('胶囊 2388 没有千分位')
  STATUS.providers[0].credits = { state: 'ok', remain: 12345, total: 20000, unit: 'credits' }
  cardTree = await mount(card, { t: (key) => key })
  if (!bigValueTexts(cardTree).includes('12.3k')) throw new Error('10000 以上没有保持 k 缩写')
  if (bigValueTexts(cardTree).includes('12,345')) throw new Error('10000 以上汇总卡不应展开完整数字')
  console.log('✓ 数字格式统一：<10000 千分位、>=10000 保持 k 缩写')
} finally {
  STATUS.providers[0].credits = savedCredits01
}

// 22) 签到 unconfigured：不能落进默认分支显示「今日已签」，且不影响 failed 优先级。
const savedCheckin01 = STATUS.providers[0].checkin
try {
  STATUS.providers[0].checkin = {
    ...savedCheckin01,
    result: { provider: 'workbuddy', claimed: 0, credit: 0, outcomes: [{ accountId: 'default', kind: 'unconfigured' }] },
  }
  cardTree = await mount(card, { t: (key) => key })
  const checkinText = textOf(cardTree)
  if (!checkinText.includes('checkinUnconfigured')) throw new Error('unconfigured outcome 没有专属文案')
  if (checkinText.includes('checkinAutoDone')) throw new Error('unconfigured 被当成了「今日已签」')
  STATUS.providers[0].checkin = {
    ...savedCheckin01,
    result: { provider: 'workbuddy', claimed: 0, credit: 0, outcomes: [{ kind: 'failed', message: 'HTTP 500' }, { kind: 'unconfigured' }] },
  }
  cardTree = await mount(card, { t: (key) => key })
  if (!textOf(cardTree).includes('checkinFailed')) throw new Error('failed 优先级被 unconfigured 抢走了')
  if (textOf(cardTree).includes('checkinUnconfigured')) throw new Error('failed 与 unconfigured 同时出现时应只显示 failed')
  console.log('✓ 签到 unconfigured outcome 有专属文案，failed 优先级不变')
} finally {
  STATUS.providers[0].checkin = savedCheckin01
}

// 23) 侧栏刷新：失败后 5 秒内再次刷新成功，失败提示要立刻消失。
fetchFailure = 'action'
try {
  fixPill = await mount(pill, { t: (key) => key, wide: true })
  const expandToggle = find(fixPill, (node) => node.type === 'button' && node.props?.['aria-expanded'] === false)
  expandToggle.props.onClick({ preventDefault() {} })
  fixPill = await render(pill, { t: (key) => key, wide: true })
  let refreshBtn = find(fixPill, (node) => node.type === 'button' && textOf(node) === 'creditsRefresh')
  refreshBtn.props.onClick({ preventDefault() {} })
  fixPill = await render(pill, { t: (key) => key, wide: true })
  if (!textOf(fixPill).includes('refreshFailed')) throw new Error('先制造一次刷新失败的前提不成立')
  fetchFailure = null
  refreshBtn = find(fixPill, (node) => node.type === 'button' && textOf(node) === 'creditsRefresh')
  refreshBtn.props.onClick({ preventDefault() {} })
  fixPill = await render(pill, { t: (key) => key, wide: true })
  if (textOf(fixPill).includes('refreshFailed')) throw new Error('刷新成功后失败提示仍然显示')
  console.log('✓ 刷新成功后立即清掉上一次的失败提示')
} finally {
  fetchFailure = null
}

// ── 2.5.0 UI 修复回归 ────────────────────────────────────────────
// 24) 事件账本：计数统一 items.length；有历史总数时说明只保留最近 N 条；展开渲染全部。
const eventsSnapshotR3 = STATUS.events
try {
  const baseEvents = eventsSnapshotR3.items
  const manyEvents = Array.from({ length: 8 }, (_, i) => ({
    ...baseEvents[i % baseEvents.length],
    id: 'ev-many-' + i,
    at: baseEvents[0].at - i * 60000,
    // 每条消息都不同，避免被「重复事件合并」压成 3 行（下面的分组用例单独覆盖）。
    message: String(baseEvents[i % baseEvents.length].message) + ' #' + i,
  }))
  STATUS.events = { ...eventsSnapshotR3, count: 63, items: manyEvents }
  cardTree = await mount(card, { t: (key) => key })
  const evText = textOf(cardTree)
  if (!evText.includes('eventRetained')) throw new Error('有历史总数时没有提示只保留最近 N 条')
  if (evText.includes('eventTitle | 63')) throw new Error('事件区块计数仍在用历史总数 63')
  if (!evText.includes('eventTitle | 8')) throw new Error('事件区块计数没有用 items.length')
  if (!findAll(cardTree, (n) => n.type === 'button' && textOf(n).includes('eventAll 8')).length) {
    throw new Error('「全部」筛选计数没有用 items.length')
  }
  const expandEventBtn = findAll(cardTree, (n) => n.type === 'button' && textOf(n).includes('eventMore'))[0]
  if (expandEventBtn === undefined) throw new Error('事件超过 6 条时没有展开按钮')
  expandEventBtn.props.onClick()
  cardTree = await render(card, { t: (key) => key })
  const eventRows = findAll(cardTree, (n) => n.type === 'li'
    && (n.children || []).some((c) => c && c.type === 'span' && typeof c.props?.title === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(c.props.title)))
  if (eventRows.length !== 8) throw new Error(`展开后应渲染全部 8 条，实际 ${eventRows.length}`)
  if (textOf(cardTree).includes('eventMore')) throw new Error('展开后仍显示「展开全部」')
  console.log('✓ 事件账本计数统一 items.length，展开渲染全部筛选结果')
} finally {
  STATUS.events = eventsSnapshotR3
}

// 25) 无额度端点：title 透出宿主 credits.error；error 态逻辑不变。
const creditsNoneSnapshot = STATUS.providers[0].credits
try {
  STATUS.providers[0].credits = { state: 'none', error: 'Trae 国际版没有提供额度查询接口，额度请在 Trae 客户端里查看。' }
  cardTree = await mount(card, { t: (key) => key })
  const noneTitleSpans = findAll(cardTree, (n) => n.type === 'span'
    && n.props?.style?.fontSize === 20
    && typeof n.props?.title === 'string' && n.props.title.includes('creditsNone'))
  if (noneTitleSpans.length === 0) throw new Error('state=none 的大数字没有 creditsNone title')
  if (!String(noneTitleSpans[0].props.title).includes('没有提供额度查询接口')) {
    throw new Error(`state=none 的 title 没有透出宿主原因：${noneTitleSpans[0].props.title}`)
  }
  STATUS.providers[0].credits = { state: 'error', error: 'HTTP 503' }
  cardTree = await mount(card, { t: (key) => key })
  const errTitleSpan = findAll(cardTree, (n) => n.type === 'span'
    && n.props?.style?.fontSize === 20
    && typeof n.props?.title === 'string' && n.props.title.includes('creditsUnreadable'))[0]
  if (errTitleSpan === undefined || !String(errTitleSpan.props.title).includes('HTTP 503')) {
    throw new Error('error 态的 creditsUnreadable + 上游错误逻辑被改坏')
  }
  console.log('✓ 无额度端点的「—」title 透出宿主原因，error 态保持原逻辑')
} finally {
  STATUS.providers[0].credits = creditsNoneSnapshot
}

// 26) 高级设置非法/空值：aria-invalid + 行内提示 + 禁用保存 + 不发请求。
cardTree = await mount(card, { t: (key) => key })
const advIdleInput = findAll(cardTree, (n) => n.type === 'input' && n.props?.['aria-label'] === 'advancedIdle')[0]
if (advIdleInput === undefined) throw new Error('找不到 idle 超时输入框')
advIdleInput.props.onChange({ target: { value: '5' } })
// 跳过 effect 重跑：真实 React 里草稿 effect 不会因为我们输入而重跑，
// 这个测试 harness 每轮都会执行 effect，会把草稿覆盖回服务端值。
cardTree = await render(card, { t: (key) => key }, true)
const invalidIdleInput = findAll(cardTree, (n) => n.type === 'input' && n.props?.['aria-label'] === 'advancedIdle')[0]
if (invalidIdleInput.props['aria-invalid'] !== true) throw new Error('非法输入没有 aria-invalid')
if (!textOf(cardTree).includes('advancedInvalid')) throw new Error('非法输入没有行内提示')
const blockedSaveBtn = findButton(cardTree, 'advancedSave')
if (blockedSaveBtn.props.disabled !== true) throw new Error('存在非法输入时保存按钮仍可点')
const beforeInvalidSave = calls.filter((c) => c.method === 'POST' && String(c.url).includes('/settings')).length
blockedSaveBtn.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
const afterInvalidSave = calls.filter((c) => c.method === 'POST' && String(c.url).includes('/settings')).length
if (afterInvalidSave !== beforeInvalidSave) throw new Error('非法输入仍然发出了保存请求')
const advCatalogInput = findAll(cardTree, (n) => n.type === 'input' && n.props?.['aria-label'] === 'advancedCatalog')[0]
advCatalogInput.props.onChange({ target: { value: '' } })
cardTree = await render(card, { t: (key) => key }, true)
const emptyCatalogInput = findAll(cardTree, (n) => n.type === 'input' && n.props?.['aria-label'] === 'advancedCatalog')[0]
if (emptyCatalogInput.props['aria-invalid'] !== true) throw new Error('空值没有 aria-invalid')
console.log('✓ 高级设置非法/空值有 aria-invalid + 行内提示且禁用保存')

// 27) 高级设置夹取提示：前端范围合法但宿主夹取时，提示最终保存值；「已保存」只在成功后出现。
const advancedSnapshot = STATUS.settings.advanced
try {
  STATUS.settings.advanced = { ...advancedSnapshot, idleTimeoutMs: 180000 }
  cardTree = await mount(card, { t: (key) => key })
  const idleForClamp = findAll(cardTree, (n) => n.type === 'input' && n.props?.['aria-label'] === 'advancedIdle')[0]
  idleForClamp.props.onChange({ target: { value: '300' } })
  cardTree = await render(card, { t: (key) => key }, true)
  const clampSaveBtn = findButton(cardTree, 'advancedSave')
  if (clampSaveBtn.props.disabled === true) throw new Error('合法数值却禁用了保存')
  clampSaveBtn.props.onClick()
  cardTree = await render(card, { t: (key) => key }, true)
  if (!textOf(cardTree).includes('advancedClamped')) throw new Error('宿主夹取后没有提示最终保存值')
  if (!textOf(cardTree).includes('advancedSaved')) throw new Error('保存成功后没有「已保存」反馈')
  console.log('✓ 宿主夹取时提示最终保存值，「已保存」只在成功回调后出现')
} finally {
  STATUS.settings.advanced = advancedSnapshot
}

// 28) 模型搜索：只命中不可用模型与完全无匹配两种空状态文案不同。
const searchModelsSnapshot = STATUS.providers[0].models
try {
  const manyModels = Array.from({ length: 7 }, (_, i) => ({ id: 'm' + i, name: 'M' + i, contextWindow: 1000, maxTokens: 100, supportsImages: false, reasoningEfforts: [], credits: 'x1', disabled: false }))
  manyModels.push({ id: 'ghost-model', name: 'Ghost', contextWindow: 1000, maxTokens: 100, supportsImages: false, reasoningEfforts: [], credits: 'x1', disabled: false, unavailable: true })
  STATUS.providers[0].models = manyModels
  cardTree = await mount(card, { t: (key) => key })
  const modelSearchInput = findAll(cardTree, (n) => n.type === 'input' && n.props?.type === 'search')[0]
  if (modelSearchInput === undefined) throw new Error('模型 >6 时没有搜索框')
  modelSearchInput.props.onChange({ target: { value: 'ghost' } })
  cardTree = await render(card, { t: (key) => key })
  const onlyUnavailableText = textOf(cardTree)
  if (!onlyUnavailableText.includes('searchOnlyUnavailable')) throw new Error('只命中不可用模型时没有专属文案')
  if (onlyUnavailableText.includes('searchEmpty')) throw new Error('只命中不可用模型时仍显示「没有匹配的模型」')
  const modelSearchInput2 = findAll(cardTree, (n) => n.type === 'input' && n.props?.type === 'search')[0]
  modelSearchInput2.props.onChange({ target: { value: 'zzzz-nothing' } })
  cardTree = await render(card, { t: (key) => key })
  if (!textOf(cardTree).includes('searchEmpty')) throw new Error('完全没有匹配时没有显示原空状态')
  console.log('✓ 搜索空状态区分「只命中不可用模型」与「完全没有匹配」')
} finally {
  STATUS.providers[0].models = searchModelsSnapshot
}

// 29) 时间格式化：无效/超范围时间戳绝不产出 "Invalid Date" 或 "NaN"（本轮修的坑）。
{
  const functionText = (header) => {
    const start = source.indexOf(header)
    if (start < 0) throw new Error(`client.js 里找不到 ${header}`)
    let depth = 0
    let end = start
    for (let i = source.indexOf('{', start); i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    return source.slice(start, end)
  }
  const extract = (header) => {
    const name = header.slice('function '.length, header.indexOf('('))
    return new Function(`${functionText(header)}; return ${name}`)()
  }
  // formatShortTime 跨天时会调用 formatTime；只抽它自己会让用例在「当天」通过、
  // 第二天因 ReferenceError 失败。两个函数放进同一个作用域再测。
  const fShortTime = new Function(
    `${functionText('function formatTime(ms) {')}; ${functionText('function formatShortTime(ms) {')}; return formatShortTime`,
  )()
  const fShortDate = extract('function formatShortDate(ms) {')
  const bad = [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1, '2026-10-18', {}, true]
  for (const v of bad) {
    const st = fShortTime(v)
    const sd = fShortDate(v)
    if (/Invalid|NaN/.test(st)) throw new Error(`formatShortTime(${String(v)}) = ${st}`)
    if (/Invalid|NaN/.test(sd)) throw new Error(`formatShortDate(${String(v)}) = ${sd}`)
    if (st !== '—' || sd !== '—') throw new Error(`无效值应回 —：st=${st} sd=${sd}`)
  }
  const ts = 1_792_296_284_000
  if (!/^\d{1,2}\/\d{1,2}$/.test(fShortDate(ts)) && !/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(fShortDate(ts))) {
    throw new Error(`formatShortDate 合法输出异常：${fShortDate(ts)}`)
  }
  const okTime = fShortTime(ts)
  if (!/^\d{2}:\d{2}:\d{2}$/.test(okTime) && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(okTime)) {
    throw new Error(`formatShortTime 合法输出异常：${okTime}`)
  }
  console.log('✓ 时间格式化：无效/超范围一律 —，不再渲染 Invalid Date / NaN')
}

// 30) creditsPercentOf：remain 缺省/非有限时必须返回 undefined（不得把 NaN 喂给百分比模板 → "NaN%"）。
{
  const header = 'function creditsPercentOf(credits) {'
  const start = source.indexOf(header)
  if (start < 0) throw new Error('client.js 里找不到 creditsPercentOf')
  let depth = 0
  let end = start
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  const creditsPercentOf = new Function(`${source.slice(start, end)}; return creditsPercentOf`)()
  if (creditsPercentOf({ state: 'ok', total: 100 }) !== undefined) throw new Error('缺 remain 应返回 undefined，实际 ' + String(creditsPercentOf({ state: 'ok', total: 100 })))
  if (creditsPercentOf({ state: 'ok', total: 100, remain: Number.NaN }) !== undefined) throw new Error('NaN remain 应返回 undefined')
  if (creditsPercentOf({ state: 'ok', total: 100, remain: Number.POSITIVE_INFINITY }) !== undefined) throw new Error('Infinity remain 应返回 undefined')
  if (creditsPercentOf({ state: 'ok', total: 0 }) !== undefined) throw new Error('total=0 应返回 undefined')
  if (creditsPercentOf({ state: 'ok', total: 100, remain: 25 }) !== 25) throw new Error('正常百分比被改坏')
  console.log('✓ creditsPercentOf 对缺省/非有限 remain 返回 undefined，不再产出 NaN%')
}

// ── 第五轮：有限但会溢出的数值 / 只判 typeof number 的可见出口 ─────────
// 上一轮修的是「remain 缺省 → NaN%」。这一轮沿同一条线继续挖：
//   A. 输入是有限数，但中间运算（*10 / *100）溢出成 Infinity；
//   B. 守卫只写了 typeof === 'number'，NaN / Infinity 照样进模板或样式。

/** 抽出 client.js 里一个顶层函数的源码。 */
function extractSource(header) {
  const start = source.indexOf(header)
  if (start < 0) throw new Error(`client.js 里找不到 ${header}`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1) }
  }
  throw new Error(`client.js 里 ${header} 的函数体不完整`)
}

/** 从 client.js 抽出顶层纯函数（内部不能依赖闭包里的其它函数）。 */
function extractFn(header) {
  const name = header.slice('function '.length, header.indexOf('('))
  return new Function(`${extractSource(header)}; return ${name}`)()
}

// 31) 纯格式化函数：有限但极大（1e308）不能因中间乘法溢出成字面 Infinity。
{
  const formatNumber = extractFn('function formatNumber(value, decimals) {')
  const formatWindow = extractFn('function formatWindow(tokens) {')
  const ratioPercent = extractFn('function ratioPercent(ratio) {')
  if (formatNumber(2388) !== '2,388') throw new Error('formatNumber 正常千分位被改坏：' + formatNumber(2388))
  if (formatNumber(Number.NaN) !== '—' || formatNumber(Number.POSITIVE_INFINITY) !== '—') throw new Error('formatNumber 非有限值应回 —')
  for (const huge of [1e308, Number.MAX_VALUE, -1e308]) {
    const out = formatNumber(huge)
    if (/Infinity/.test(out)) throw new Error(`formatNumber(${huge}) 仍输出 ${out}`)
  }
  if (formatWindow(256000) !== '256K' || formatWindow(1000000) !== '1M') throw new Error('formatWindow 正常缩写被改坏')
  // 1200 被写成「1K」会丢掉 200 token；保留一位小数后与详情数字对得上。
  if (formatWindow(1200) !== '1.2K' || formatWindow(1500) !== '1.5K') throw new Error('formatWindow 丢掉小数位：' + formatWindow(1200))
  const compactNumber = extractFn('function compactNumber(value) {')
  // 999,999 按「千」四舍五入是 1000：必须进位成 1M，不能输出「1000k」。
  if (compactNumber(999999) !== '1M' || compactNumber(10000) !== '10k' || compactNumber(1200000) !== '1.2M') {
    throw new Error('compactNumber 单位进位被改坏：' + compactNumber(999999))
  }
  // 金额必须两位小数：0.04 美元按一位小数会显示成 0（像余额被清零）。
  // formatCreditsNumber 依赖 formatNumber 与 isMoneyCredits：三者要一起求值。
  const creditsFmt = new Function([
    extractSource('function formatNumber(value, decimals) {'),
    extractSource('function isMoneyCredits(credits) {'),
    extractSource('function formatCreditsNumber(value, credits) {'),
    'return { isMoneyCredits, formatCreditsNumber }',
  ].join('\n'))()
  const isMoneyCredits = creditsFmt.isMoneyCredits
  const formatCreditsNumber = creditsFmt.formatCreditsNumber
  if (formatCreditsNumber(0.04, { unit: 'usd' }) !== '0.04') throw new Error('美元 0.04 被舍成：' + formatCreditsNumber(0.04, { unit: 'usd' }))
  if (formatCreditsNumber(0.05, { unit: 'cny' }) !== '0.05') throw new Error('人民币 0.05 被舍成：' + formatCreditsNumber(0.05, { unit: 'cny' }))
  if (formatCreditsNumber(600.1, { unit: 'credits' }) !== '600.1') throw new Error('积分一位小数被改坏')
  if (isMoneyCredits({ unit: 'credits' }) !== false || isMoneyCredits({ unit: 'usd' }) !== true) throw new Error('isMoneyCredits 判定被改坏')
  if (formatWindow(Number.NaN) !== '—' || formatWindow(Number.POSITIVE_INFINITY) !== '—' || formatWindow(0) !== '—') {
    throw new Error('formatWindow 非有限/非正值应回 —')
  }
  if (ratioPercent(0.25) !== '25%') throw new Error('ratioPercent 正常值被改坏')
  if (ratioPercent(1e308) !== '—' || ratioPercent(Number.NaN) !== '—' || ratioPercent(2) !== '—') {
    throw new Error('ratioPercent 越界/非有限应回 —')
  }
  console.log('✓ 格式化函数：1e308 等有限大数不再溢出成 Infinity，非有限值统一回 —')
}

// 32) 成功率：NaN / Infinity / 1e308 都不能拼成「NaN% / Infinity%」。
{
  const usageSnapshot = STATUS.providers[0].usage
  try {
    STATUS.providers[0].usage = { ...usageSnapshot, successRate: 0.5 }
    let tree = await mount(card, { t: realT })
    if (!textOf(tree).includes('50%')) throw new Error('正常成功率 0.5 没有渲染成 50%')
    assertNoBadNumbers(tree, 'successRate=0.5')
    for (const rate of [Number.NaN, Number.POSITIVE_INFINITY, 1e308, -1]) {
      STATUS.providers[0].usage = { ...usageSnapshot, successRate: rate }
      tree = await mount(card, { t: realT })
      assertNoBadNumbers(tree, `successRate=${String(rate)}`)
    }
    console.log('✓ 成功率对 NaN / Infinity / 1e308 一律回 —，不再出现 NaN% / Infinity%')
  } finally {
    STATUS.providers[0].usage = usageSnapshot
  }
}

// 33) 汇总卡：modelCount 原始插值与模型 contextWindow 的非有限值。
{
  const modelsSnapshot = STATUS.providers[0].models
  const modelCountSnapshot = STATUS.providers[0].modelCount
  try {
    const baseModel = modelsSnapshot[0]
    STATUS.providers[0].models = [{ ...baseModel, contextWindow: Number.NaN }]
    STATUS.providers[0].modelCount = Number.POSITIVE_INFINITY
    let tree = await mount(card, { t: realT })
    assertNoBadNumbers(tree, 'modelCount=Infinity / contextWindow=NaN')
    if (textOf(tree).includes('Infinity 模型')) throw new Error('modelCount 非有限值仍被插值成「Infinity 模型」')
    if (!textOf(tree).includes('1 模型')) throw new Error('modelCount 非有限时没有回落到模型数组长度')

    STATUS.providers[0].models = [{ ...baseModel, contextWindow: Number.POSITIVE_INFINITY }]
    STATUS.providers[0].modelCount = Number.NaN
    tree = await mount(card, { t: realT })
    assertNoBadNumbers(tree, 'modelCount=NaN / contextWindow=Infinity')
    console.log('✓ 模型数量与上下文窗口对非有限值回 —/真实条数，不再渲染 NaN / InfinityM')
  } finally {
    STATUS.providers[0].models = modelsSnapshot
    STATUS.providers[0].modelCount = modelCountSnapshot
  }
}

// 34) 高级设置输入框：宿主给 NaN / Infinity / 有限大数时不能把坏数字灌进 value。
{
  const settingsSnapshot = STATUS.settings
  try {
    STATUS.settings = {
      ...settingsSnapshot,
      advanced: {
        ...settingsSnapshot.advanced,
        idleTimeoutMs: Number.NaN,
        catalogRefreshMs: Number.POSITIVE_INFINITY,
        creditsRefreshMs: Number.NaN,
        qoderQueueWaitMs: Number.POSITIVE_INFINITY,
      },
      alerts: { ...settingsSnapshot.alerts, lowRatio: Number.NaN },
      autoSwitch: { ...settingsSnapshot.autoSwitch, thresholdRatio: Number.POSITIVE_INFINITY },
    }
    const tree = await mount(card, { t: realT })
    assertNoBadNumbers(tree, '高级设置非有限值')
    const inputValue = (labelKey) => {
      const input = find(tree, (node) => node.type === 'input' && node.props?.['aria-label'] === realT(labelKey))
      if (input === undefined) throw new Error(`找不到输入框 ${labelKey}`)
      return input.props.value
    }
    const expected = [['advancedIdle', '180'], ['advancedCatalog', '600'], ['advancedCredits', '120'], ['advancedAlert', '15'], ['advancedSwitch', '0'], ['advancedQueue', '60']]
    for (const [key, value] of expected) {
      if (inputValue(key) !== value) throw new Error(`${key} 应回默认 ${value}，实际 ${inputValue(key)}`)
    }

    // 有限但极大：lowRatio=1e308 的 *100 也会溢出，必须同样回默认。
    STATUS.settings = {
      ...settingsSnapshot,
      alerts: { ...settingsSnapshot.alerts, lowRatio: 1e308 },
      autoSwitch: { ...settingsSnapshot.autoSwitch, thresholdRatio: 1e308 },
    }
    const hugeTree = await mount(card, { t: realT })
    assertNoBadNumbers(hugeTree, '高级设置 1e308')
    const hugeValue = (labelKey) => {
      const input = find(hugeTree, (node) => node.type === 'input' && node.props?.['aria-label'] === realT(labelKey))
      return input?.props.value
    }
    if (hugeValue('advancedAlert') !== '15' || hugeValue('advancedSwitch') !== '0') {
      throw new Error(`1e308 比例应回默认值，实际 alert=${hugeValue('advancedAlert')} switch=${hugeValue('advancedSwitch')}`)
    }
    console.log('✓ 高级设置对 NaN / Infinity / 1e308 的比例与毫秒值回默认，输入框不再出现 NaN/Infinity')
  } finally {
    STATUS.settings = settingsSnapshot
  }
}

// 35) 签到：claimed / credit 原始插值，NaN / Infinity 不能进「+N 积分」。
{
  const checkinSnapshot = STATUS.providers[0].checkin
  try {
    STATUS.providers[0].checkin = {
      enabled: true,
      lastRunAt: 1792234000000,
      result: { claimed: 1, credit: Number.NaN, outcomes: [] },
    }
    let tree = await mount(card, { t: realT })
    assertNoBadNumbers(tree, 'checkin credit=NaN')
    if (!textOf(tree).includes('1 个账号')) throw new Error('签到成功文案被改坏')

    STATUS.providers[0].checkin = {
      enabled: true,
      lastRunAt: 1792234000000,
      result: { claimed: Number.POSITIVE_INFINITY, credit: Number.POSITIVE_INFINITY, outcomes: [] },
    }
    tree = await mount(card, { t: realT })
    assertNoBadNumbers(tree, 'checkin claimed/credit=Infinity')
    console.log('✓ 签到次数/积分对 NaN / Infinity 不再插值成「Infinity 个账号 / +NaN 积分」')
  } finally {
    STATUS.providers[0].checkin = checkinSnapshot
  }
}

// 36) 状态版本与连续失败次数：原始插值同样要过有限性。
{
  const versionSnapshot = STATUS.version
  const healthSnapshot = STATUS.providers[0].health
  try {
    STATUS.version = Number.NaN
    STATUS.providers[0].health = { ...healthSnapshot, consecutiveFailures: Number.POSITIVE_INFINITY }
    const tree = await mount(card, { t: realT })
    assertNoBadNumbers(tree, 'version=NaN / consecutiveFailures=Infinity')
    const text = textOf(tree)
    if (text.includes('vNaN') || text.includes('vInfinity')) throw new Error('状态版本仍插值出 vNaN / vInfinity')
    if (!text.includes('宿主 v?')) throw new Error('非法版本号没有回落到 ?')
    const badge = find(tree, (node) => node.type === 'span' && node.props?.title !== undefined && /连败/.test(node.props.title))
    if (badge !== undefined) throw new Error('非有限连续失败次数仍生成「Infinity 连败」提示')
    console.log('✓ 状态版本与连续失败次数对非有限值回 ?/空，不再渲染 vNaN / Infinity 连败')
  } finally {
    STATUS.version = versionSnapshot
    STATUS.providers[0].health = healthSnapshot
  }
}

// 37) 14 天柱状图：某个桶 totalTokens=Infinity 会让 height/opacity 变成 NaN。
{
  const providerDailySnapshot = STATUS.stats.providerDaily
  try {
    STATUS.stats.providerDaily = {
      ...providerDailySnapshot,
      workbuddy: [
        { date: '2026-10-17', requests: 2, totalTokens: 50 },
        { date: '2026-10-18', requests: 3, totalTokens: Number.POSITIVE_INFINITY },
      ],
    }
    const tree = await mount(card, { t: realT })
    assertNoBadNumbers(tree, 'daily totalTokens=Infinity')
    console.log('✓ 日用量柱状图对 Infinity 不再产出 height:NaN / opacity:NaN')
  } finally {
    STATUS.stats.providerDaily = providerDailySnapshot
  }
}

// 38) 额度总量：total=Infinity 不能触发 0% / 低额度，也不能让大数缩放出 Infinity；
//     remain=1e308 这类有限大数同样不能经 formatNumber 的 *10 溢出。
{
  const creditsSnapshot = STATUS.providers[0].credits
  try {
    STATUS.providers[0].credits = { ...creditsSnapshot, remain: 2388, total: Number.POSITIVE_INFINITY }
    let tree = await mount(card, { t: realT })
    assertNoBadNumbers(tree, 'credits.total=Infinity')
    if (textOf(tree).includes(realT('alertLow'))) throw new Error('total=Infinity 被误判成低额度')

    STATUS.providers[0].credits = { ...creditsSnapshot, remain: 1e308, total: 6600 }
    tree = await mount(card, { t: realT })
    assertNoBadNumbers(tree, 'credits.remain=1e308')
    if (!textOf(tree).includes('1e+308')) throw new Error('1e308 余额没有按科学计数法显示，可能仍溢出')

    const pillTree = await mount(pill, { t: realT, wide: true })
    assertNoBadNumbers(pillTree, 'pill credits.remain=1e308')
    console.log('✓ 额度总量/余额对 Infinity 与 1e308 不再渲染 Infinity、不再误判低额度')
  } finally {
    STATUS.providers[0].credits = creditsSnapshot
  }
}

// 39) 今日请求数 / 测试延迟 / 侧栏用量：原始数字插值统一兜底。
{
  const usageSnapshot = STATUS.providers[0].usage
  const accountsSnapshot = STATUS.providers[0].accounts
  try {
    STATUS.providers[0].usage = { ...usageSnapshot, today: { ...usageSnapshot.today, requests: Number.POSITIVE_INFINITY } }
    let tree = await mount(card, { t: realT })
    assertNoBadNumbers(tree, 'usage.today.requests=Infinity')

    const pillTree = await mount(pill, { t: realT, wide: true })
    assertNoBadNumbers(pillTree, 'pill usage.today.requests=Infinity')

    STATUS.providers[0].accounts = accountsSnapshot.map((account, index) => index === 0
      ? { ...account, lastTest: { ok: true, latencyMs: Number.POSITIVE_INFINITY } }
      : account)
    tree = await mount(card, { t: realT })
    assertNoBadNumbers(tree, 'lastTest.latencyMs=Infinity')

    STATUS.providers[0].accounts = accountsSnapshot.map((account, index) => index === 0
      ? { ...account, modelTests: { auto: { ok: true, latencyMs: Number.NaN } } }
      : account)
    tree = await mount(card, { t: realT })
    assertNoBadNumbers(tree, 'modelTests.latencyMs=NaN')
    console.log('✓ 今日请求数、测试延迟与侧栏用量对非有限值回 —，不再出现 Infinity 次 / NaNms')
  } finally {
    STATUS.providers[0].usage = usageSnapshot
    STATUS.providers[0].accounts = accountsSnapshot
  }
}


// ── 0.4.1 审计回归 ────────────────────────────────────────────────
// 0.4.1 前后端审计确认的前端缺陷：每条都对应一个可复现的用户可见问题。

// 40) 签到汇总：任一账号失败时必须显性说出来，不能被「今天已签到」盖住。
{
  const snapshot = STATUS.providers[0].checkin
  try {
    STATUS.providers[0].checkin = {
      enabled: true,
      completedToday: true,
      result: {
        provider: 'workbuddy',
        claimed: 0,
        credit: 0,
        outcomes: [
          { accountId: 'default', label: '本机登录', kind: 'already', streakDays: 3 },
          { accountId: 'acc-2', label: '备用账号', kind: 'failed', message: 'HTTP 500' },
        ],
      },
    }
    const tree = await mount(card, { t: realT })
    const text = textOf(tree)
    if (!text.includes('签到失败')) throw new Error('多账号里有失败时，汇总仍只显示「今天已签到」')
    if (!text.includes(realT('checkinRetryHint'))) throw new Error('签到失败没有给出重试说明')
    console.log('✓ 签到汇总：任一账号失败时显示失败与重试提示，不被「已签到」吞掉')
  } finally {
    STATUS.providers[0].checkin = snapshot
  }
}

// 41) 可用性测试的模型下拉不得包含「账号不支持」的模型。
{
  const snapshot = STATUS.providers[0].models
  try {
    STATUS.providers[0].models = [
      { id: 'auto', name: 'Auto', contextWindow: 256000, maxTokens: 32000, supportsImages: true, reasoningEfforts: [], disabled: false, unavailable: false, forced: false },
      { id: 'ghost-model', name: 'Ghost', contextWindow: 1000, maxTokens: 100, supportsImages: false, reasoningEfforts: [], disabled: false, unavailable: true, forced: false },
    ]
    STATUS.providers[0].modelCount = STATUS.providers[0].models.length
    const tree = await mount(card, { t: realT })
    const select = find(tree, (node) => node.type === 'select' && node.props?.['aria-label'] === realT('testModelModel'))
    if (select === undefined) throw new Error('找不到可用性测试的模型下拉')
    const values = findAll(select, (node) => node.type === 'option').map((node) => node.props.value)
    if (values.includes('ghost-model')) throw new Error('「账号不支持」的模型出现在可用性测试下拉里，可被选中并发请求')
    if (!values.includes('auto')) throw new Error('可用模型反而不在下拉里')
    console.log('✓ 可用性测试下拉与「可用模型」列表口径一致，不列账号不支持的模型')
  } finally {
    STATUS.providers[0].models = snapshot
    STATUS.providers[0].modelCount = snapshot.length
  }
}

// 42) 所有模型都「账号不支持」时，空状态不能说成「没有匹配的模型」。
{
  const snapshot = STATUS.providers[0].models
  try {
    STATUS.providers[0].models = [
      { id: 'paid-a', name: 'Paid A', contextWindow: 128000, maxTokens: 32000, supportsImages: false, reasoningEfforts: [], disabled: false, unavailable: true, forced: false },
      { id: 'paid-b', name: 'Paid B', contextWindow: 128000, maxTokens: 32000, supportsImages: false, reasoningEfforts: [], disabled: false, unavailable: true, forced: false },
    ]
    STATUS.providers[0].modelCount = 2
    const tree = await mount(card, { t: realT })
    const text = textOf(tree)
    const searchInput = find(tree, (node) => node.type === 'input' && node.props?.type === 'search')
    if (searchInput !== undefined) throw new Error('前提不成立：两个模型时不该渲染搜索框')
    if (text.includes(realT('searchEmpty'))) throw new Error('没有搜索框却说「没有匹配的模型」，用户无处可清')
    if (!text.includes(realT('searchAllUnavailable', { count: 2 }))) throw new Error('全部不可用时没有给出正确解释')
    console.log('✓ 全部模型「账号不支持」时给出专门文案，不再误报「搜索无匹配」')
  } finally {
    STATUS.providers[0].models = snapshot
    STATUS.providers[0].modelCount = snapshot.length
  }
}

// 43) 所有 provider 都被关闭时，侧栏胶囊说「全部已关闭」，而不是「未读取」。
{
  const snapshot = STATUS.providers.map((entry) => entry.enabled)
  try {
    for (const entry of STATUS.providers) entry.enabled = false
    // 胶囊内部用自己的 `t`（测试里是 key 回显），断言按 key 做。
    await mount(pill, { t: (key) => key, wide: true })
    // 首帧只拿到「读取中」；等一次 /status 回来再断言。
    await new Promise((resolve) => setTimeout(resolve, 20))
    const tree = await render(pill, { t: (key) => key, wide: true })
    const text = textOf(tree)
    if (text.includes('creditsNone')) throw new Error('provider 全关时仍显示「未读取」')
    if (!text.includes('providersAllDisabled')) throw new Error('provider 全关时没有说明原因：' + JSON.stringify(text.slice(0, 160)))
    console.log('✓ provider 全关时胶囊显示「全部已关闭」并带解释')
  } finally {
    STATUS.providers.forEach((entry, index) => { entry.enabled = snapshot[index] })
  }
}

// 44) 未保存的 PAT / 登录文件草稿按 provider 记忆，切走再切回不丢。
{
  const snapshot = STATUS.providers[0].accounts
  try {
    STATUS.providers[0].accounts = [
      { id: 'default', label: '本机登录', active: true, kind: 'desktop', configured: true, source: 'desktop', credits: { state: 'ok', remain: 675, total: 1200, unit: 'credits', items: [] } },
    ]
    let tree = await mount(card, { t: realT })
    const authInput = () => find(tree, (node) => node.type === 'input' && node.props?.['aria-label'] === realT('authFile'))
    if (authInput() === undefined) throw new Error('找不到登录文件输入框')
    authInput().props.onChange({ target: { value: 'D:\\unsaved\\wb.info' } })
    tree = await render(card, { t: realT })
    if (authInput().props.value !== 'D:\\unsaved\\wb.info') throw new Error('输入后值没写进 state')

    findButton(tree, 'WorkBuddy AI').props.onClick()
    tree = await render(card, { t: realT })
    findButton(tree, 'WorkBuddy').props.onClick()
    tree = await render(card, { t: realT })
    if (authInput().props.value !== 'D:\\unsaved\\wb.info') {
      throw new Error('切走再切回后，未保存的登录文件路径被清空')
    }
    console.log('✓ 未保存的路径草稿按 provider 记忆，切走再切回仍在')
  } finally {
    STATUS.providers[0].accounts = snapshot
  }
}

// 45) 删除确认态随 provider 切换重置（避免「几十秒前的确认」在切回后复活）。
{
  const snapshot = STATUS.providers[1].accounts
  try {
    STATUS.providers[1].accounts = [
      { id: 'default', label: 'AI 默认', active: true, kind: 'desktop', configured: true, source: 'desktop', credits: { state: 'ok', remain: 10, total: 100, unit: 'credits', items: [] } },
    ]
    let tree = await mount(card, { t: realT })
    const removeButtons = findAll(tree, (node) => node.type === 'button' && textOf(node) === realT('removeAccount'))
    if (removeButtons.length === 0) throw new Error('找不到删除按钮')
    removeButtons[0].props.onClick()
    tree = await render(card, { t: realT })
    if (findAll(tree, (node) => node.type === 'button' && textOf(node) === realT('removeConfirm')).length === 0) {
      throw new Error('第一次点击没有进入确认态')
    }
    findButton(tree, 'WorkBuddy AI').props.onClick()
    tree = await render(card, { t: realT })
    findButton(tree, 'WorkBuddy').props.onClick()
    tree = await render(card, { t: realT })
    if (findAll(tree, (node) => node.type === 'button' && textOf(node) === realT('removeConfirm')).length > 0) {
      throw new Error('切走再切回后，删除确认态仍然挂着')
    }
    console.log('✓ 删除确认态随 provider 切换重置')
  } finally {
    STATUS.providers[1].accounts = snapshot
  }
}

// 46) /status 返回 JSON null：只显示「读取失败」，不能白屏。
{
  const original = sandbox.fetch
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => null, text: async () => 'null' })
  try {
    let tree = await mount(card, { t: realT })
    await new Promise((resolve) => setTimeout(resolve, 20))
    tree = await render(card, { t: realT })
    const text = textOf(tree)
    if (!text.includes(realT('statusLoadFailed'))) {
      throw new Error('status 文档是 null 时没有落到加载失败态：' + JSON.stringify(text.slice(0, 120)))
    }
    console.log('✓ status 文档为 null 时显示加载失败，不再白屏')
  } finally {
    sandbox.fetch = original
  }
}

// 47) modelTests 里的 null 条目不能炸掉整张卡片（typeof null === 'object'）。
{
  const snapshot = STATUS.providers[0].accounts[0]
  try {
    STATUS.providers[0].accounts[0] = { ...snapshot, modelTests: { auto: null } }
    let tree = await mount(card, { t: realT })
    const usageTab = find(tree, (node) => node.type === 'button'
      && node.props?.className === 'rpc-pagetab'
      && textOf(node).startsWith(realT('navUsage')))
    if (usageTab === undefined) throw new Error('找不到「用量」分区按钮')
    usageTab.props.onClick()
    tree = await render(card, { t: realT })
    if (!textOf(tree).includes(realT('navUsage'))) throw new Error('用量页没有渲染')
    console.log('✓ modelTests 的 null 条目不再炸整张卡片')
  } finally {
    STATUS.providers[0].accounts[0] = snapshot
  }
}

// 48) 高级设置的复选框改动不能被下一次状态轮询冲掉。
{
  let tree = await mount(card, { t: realT })
  const boxOf = () => {
    const label = find(tree, (node) => node.type === 'label' && textOf(node) === realT('advancedStats'))
    return label === undefined ? undefined : find(label, (node) => node.type === 'input')
  }
  if (boxOf() === undefined) throw new Error('找不到「记录用量统计」开关')
  if (boxOf().props.checked !== true) throw new Error('高级设置开关初始态不对')
  boxOf().props.onChange({ target: { checked: false } })
  tree = await render(card, { t: realT })
  if (boxOf().props.checked !== false) throw new Error('取消勾选没有生效')
  // 触发一次完整状态回读（模拟 20 秒轮询），未保存的勾选必须保留。
  const refresh = findButton(tree, realT('refresh'))
  if (refresh === undefined) throw new Error('找不到刷新按钮')
  refresh.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  tree = await render(card, { t: realT })
  if (boxOf().props.checked !== false) {
    throw new Error('轮询把未保存的高级设置勾选冲掉了')
  }
  console.log('✓ 高级设置复选框的未保存改动不会被轮询覆盖')
}

// 49) 清除 PAT 后连草稿一起清，切走再切回不能把刚清掉的令牌填回来。
{
  const snapshot = STATUS.providers[2].accounts
  try {
    STATUS.providers[2].accounts = [
      { id: 'default', label: '默认令牌', active: true, kind: 'pat', configured: true, source: 'pat', credits: { state: 'ok', remain: 10, total: 100, unit: 'credits' } },
    ]
    STATUS.settings.qoder['qoder-global'].configured = true
    let tree = await mount(card, { t: realT })
    findButton(tree, 'Qoder Global').props.onClick()
    tree = await render(card, { t: realT })
    const patInput = () => find(tree, (node) => node.type === 'input' && node.props?.['aria-label'] === realT('pat'))
    if (patInput() === undefined) throw new Error('找不到 PAT 输入框')
    patInput().props.onChange({ target: { value: 'pt-should-be-forgotten' } })
    tree = await render(card, { t: realT })
    const clearButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === realT('clear'))[0]
    if (clearButton === undefined) throw new Error('找不到「清除」按钮')
    clearButton.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    tree = await render(card, { t: realT })
    if (patInput().props.value !== '') throw new Error('清除后输入框仍然有值')
    findButton(tree, 'WorkBuddy').props.onClick()
    tree = await render(card, { t: realT })
    findButton(tree, 'Qoder Global').props.onClick()
    tree = await render(card, { t: realT })
    if (patInput().props.value !== '') {
      throw new Error('切走再切回后，被清除的 PAT 又从草稿里复活了')
    }
    console.log('✓ 清除 PAT 会同时清掉按 provider 记住的草稿')
  } finally {
    STATUS.providers[2].accounts = snapshot
  }
}

// 50) 模型数降到 ≤6、搜索框消失后，不能再拿隐藏的搜索词过滤列表。
{
  const snapshot = STATUS.providers[0].models
  try {
    STATUS.providers[0].models = Array.from({ length: 7 }, (_, index) => (
      { id: 'm' + index, name: 'Model ' + index, contextWindow: 1000, maxTokens: 100, supportsImages: false, reasoningEfforts: [], disabled: false }
    ))
    STATUS.providers[0].modelCount = 7
    let tree = await mount(card, { t: realT })
    const modelsTab = find(tree, (node) => node.type === 'button'
      && node.props?.className === 'rpc-pagetab'
      && textOf(node).startsWith(realT('navModels')))
    modelsTab.props.onClick()
    tree = await render(card, { t: realT })
    const search = find(tree, (node) => node.type === 'input' && node.props?.['aria-label'] === realT('searchPlaceholder'))
    if (search === undefined) throw new Error('7 个模型时没有渲染搜索框')
    search.props.onChange({ target: { value: 'zzz' } })
    tree = await render(card, { t: realT })
    if (!textOf(tree).includes(realT('searchEmpty'))) throw new Error('搜索无匹配时没有空状态')
    // 目录缩小到 6 个：输入框消失，隐藏的搜索词不能再过滤。
    STATUS.providers[0].models = STATUS.providers[0].models.slice(0, 6)
    STATUS.providers[0].modelCount = 6
    const refresh = findButton(tree, realT('refresh'))
    refresh.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 30))
    tree = await render(card, { t: realT })
    const text = textOf(tree)
    if (text.includes(realT('searchEmpty'))) {
      throw new Error('模型数降到 6 后仍被已隐藏的搜索词过滤')
    }
    if (!text.includes('Model 0')) throw new Error('模型列表没有恢复完整')
    console.log('✓ 搜索框隐藏后不再用旧搜索词过滤模型列表')
  } finally {
    STATUS.providers[0].models = snapshot
    STATUS.providers[0].modelCount = snapshot.length
  }
}

// 51) 折叠状态下「状态」列不能整列为空：只有被折叠起来的行带徽章时，
//     可见的 8 行会得到一整列空白 —— 正是 0.6.0 想避免的「空列挤掉模型名」。
{
  const statsSnapshot = { accountModels: STATUS.stats.accountModels, accountModelToday: STATUS.stats.accountModelToday }
  const accountsSnapshot = STATUS.providers[0].accounts
  try {
    const pairs = {}
    const today = {}
    for (let index = 0; index < 12; index++) {
      // 补零：表体按 token → 账号 → 模型排序，id 不补零会让「第 12 行」跑到
      // 可见区里去（'m10' < 'm2'），测试前提就不成立了。
      const model = `m${String(index).padStart(2, '0')}`
      const key = `workbuddy::default::${model}`
      const row = { provider: 'workbuddy', accountId: 'default', model, requests: 1, totalTokens: 10, avgDurationMs: 100 }
      pairs[key] = { ...row }
      today[key] = { ...row }
    }
    STATUS.stats.accountModels = pairs
    STATUS.stats.accountModelToday = today
    // 徽章落在排序后**最后一行**（m11），折叠时它在隐藏区里。
    STATUS.providers[0].accounts = accountsSnapshot.map((account, index) => index === 0
      ? { ...account, modelTests: { m11: { ok: true, latencyMs: 100, at: Date.now() } } }
      : account)
    let tree = await mount(card, { t: realT })
    const usageTab = find(tree, (node) => node.type === 'button'
      && node.props?.className === 'rpc-pagetab'
      && textOf(node).startsWith(realT('navUsage')))
    if (usageTab === undefined) throw new Error('找不到「用量」分区按钮')
    usageTab.props.onClick()
    tree = await render(card, { t: realT })
    const head = find(tree, (node) => node.props?.className === 'rpc-usage-head rpc-usage-pairs')
    if (head === undefined) throw new Error('找不到账号 × 模型表头')
    const columns = head.children.filter((child) => child !== null && child !== undefined).length
    if (columns !== 5) {
      throw new Error(`折叠时唯一的徽章在被折叠的行里，可见行却仍渲染了「状态」空列（列数 ${String(columns)}）`)
    }
    console.log('✓ 折叠时状态列按可见行计算，不会整列为空')
  } finally {
    STATUS.stats.accountModels = statsSnapshot.accountModels
    STATUS.stats.accountModelToday = statsSnapshot.accountModelToday
    STATUS.providers[0].accounts = accountsSnapshot
  }
}

// 52) 全新安装（六家都没有凭证、没有目录、没有统计）：卡片六个分区与侧栏胶囊
//     都要能渲染。这一份形状取自后端真实产出的 /status（冷启动、隔离了本机
//     登录态），不是手编的：credits 是 `state:'none'` 且带 `error`、models 为空、
//     account.usage / lastTest 整个字段缺失、modelTests 是空对象、stats 全零。
{
  const providersSnapshot = STATUS.providers
  const statsSnapshot = STATUS.stats
  const counters = () => ({
    requests: 0, ok: 0, failed: 0, aborted: 0, incomplete: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    durationMs: 0, maxDurationMs: 0, lastAt: 0, lastOkAt: 0, lastErrorAt: 0, consecutiveFailures: 0,
    avgDurationMs: 0, totalTokens: 0,
  })
  const trend = { points: [], spentToday: 0, spent7d: 0, topupToday: 0, topup7d: 0, sampleCount: 0, lastAt: 0, firstAt: 0 }
  const reason = '没有找到 Trae 的登录文件（已查找 1 个位置）。请先打开 Trae 并登录，或在连接设置里指定 storage.json 的路径。'
  try {
    STATUS.providers = ['workbuddy', 'workbuddy-ai', 'qoder', 'qoder-global', 'trae', 'trae-global'].map((provider) => {
      const creditsOf = () => ({ state: 'none', remain: 0, total: 0, unit: 'credits', items: [], fetchedAt: 0, error: reason, trend })
      return {
        provider,
        displayName: provider,
        kind: provider.startsWith('qoder') ? 'pat' : 'desktop',
        enabled: true,
        catalogSource: 'builtin',
        fetchedAt: 0,
        accountId: 'default',
        models: [],
        modelCount: 0,
        credits: creditsOf(),
        accounts: [{
          id: 'default',
          label: '本机登录',
          enabled: true,
          kind: 'desktop',
          active: true,
          configured: false,
          authFile: '',
          source: 'desktop',
          credits: creditsOf(),
          cooldownUntil: 0,
          modelTests: {},
        }],
        checkin: {
          enabled: true,
          lastRunAt: 0,
          completedOn: '2026-10-20',
          completedToday: true,
          lastAttemptAt: 0,
          result: {
            provider,
            claimed: 0,
            credit: 0,
            outcomes: [{ accountId: 'default', label: '本机登录', kind: 'unconfigured', message: reason }],
          },
        },
        autoSwitch: true,
        credential: { status: 'signed-out', reason: 'no-credential', message: reason },
        health: { state: 'unknown', consecutiveFailures: 0, lastErrorAt: 0, lastSuccessAt: 0 },
        usage: { ...counters(), today: counters() },
        images: true,
      }
    })
    STATUS.stats = {
      enabled: true,
      since: 1792234000000,
      totals: counters(),
      today: counters(),
      providers: {},
      providerToday: {},
      accounts: {},
      models: {},
      accountModels: {},
      accountModelToday: {},
      daily: [],
      providerDaily: {},
      providerCurrentSession: {},
      health: {},
      recent: [],
    }

    let tree = await mount(card, { t: realT })
    assertNoBadNumbers(tree, '全新安装：卡片')
    const text = textOf(tree)
    for (const bad of ['undefined', '[object Object]', 'NaN']) {
      if (text.includes(bad)) throw new Error(`全新安装的空态渲染出 ${bad}`)
    }
    // 六个分区逐个切过去：模型清单为空、额度未读取、签到今天已判过，都不能抛。
    const tabs = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'rpc-pagetab')
    if (tabs.length !== 6) throw new Error(`应有 6 个分区，实际 ${String(tabs.length)}`)
    for (const tab of tabs) {
      tab.props.onClick()
      tree = await render(card, { t: realT })
      assertNoBadNumbers(tree, '全新安装：分区')
    }

    // 侧栏胶囊：六家都是 none → 落到「未读取」，而不是空白或坏值。
    await mount(pill, { t: (key) => key, wide: true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const pillTree = await render(pill, { t: (key) => key, wide: true })
    if (!textOf(pillTree).includes('creditsNone')) {
      throw new Error(`全新安装时胶囊没有说明「未读取」：${JSON.stringify(textOf(pillTree).slice(0, 120))}`)
    }
    assertNoBadNumbers(pillTree, '全新安装：侧栏胶囊')
    console.log('✓ 全新安装（六家全空）时六个分区与胶囊都能渲染，不出现坏值')
  } finally {
    STATUS.providers = providersSnapshot
    STATUS.stats = statsSnapshot
  }
}

// ---------- 第七轮审计（0.6.6）的前端回归 ----------
//
// 每条都对应一个用真实输入复现过的缺陷；改成旧写法会立刻红。
{
  const providersSnapshot = STATUS.providers
  const statsSnapshot = STATUS.stats
  try {
    // 1) 整轮签到失败时宿主只给 `accountId: '*'` 的兜底 outcome。
    //    旧实现按 accountId/label 匹配，'*' 两头不命中 → 横幅说「失败」、
    //    每行签到列却都是「—」，同一份数据两个结论。
    const base = providersSnapshot[0]
    STATUS.providers = [
      {
        ...base,
        checkin: {
          enabled: true,
          completedOn: '',
          completedToday: false,
          lastRunAt: 1792234000000,
          result: {
            provider: base.provider,
            claimed: 0,
            credit: 0,
            at: 1792234000000,
            outcomes: [{ accountId: '*', label: '全部账号', kind: 'failed', message: 'settings.json 正被另一个进程写入' }],
          },
        },
        accounts: JSON.parse(JSON.stringify(base.accounts)).map((account) => ({ ...account, active: false })),
      },
      ...providersSnapshot.slice(1),
    ]
    let tree = await mount(card, { t: realT })
    const accountTabs = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'rpc-pagetab')
    accountTabs.find((node) => textOf(node).startsWith(realT('navAccounts'))).props.onClick()
    tree = await render(card, { t: realT })
    const checkinCells = findAll(tree, (node) => typeof node.props?.className === 'string'
      && node.props.className.includes('rpc-acc-checkin'))
      .map((node) => textOf(node))
      .filter((text) => text !== '')
    if (checkinCells.length === 0) throw new Error('账号页没有签到单元格')
    for (const cell of checkinCells) {
      if (!cell.includes(realT('accountCheckinFailed')) && !cell.includes('—')) {
        throw new Error(`整轮签到失败时账号行没有结论：${JSON.stringify(cell)}`)
      }
    }
    if (!checkinCells.some((cell) => cell.includes(realT('accountCheckinFailed')))) {
      throw new Error(`整轮签到失败没有落到账号行（仍是 —）：${JSON.stringify(checkinCells)}`)
    }
    console.log('✓ 整轮签到失败的 `accountId: "*"` 兜底结论会落到每个账号行')

    // 2) Qoder 计划接口失败（planUnknown）不能被读成「额度已用尽」：
    //    服务端按 Free 处理（不预警、不换号），客户端必须同一口径。
    STATUS.providers = [
      {
        ...base,
        provider: 'qoder-global',
        displayName: 'Qoder Global',
        kind: 'pat',
        credits: { state: 'ok', remain: 0, total: 0, used: 0, unit: 'credits', planUnknown: true, exceeded: true, items: [], fetchedAt: 1792234000000 },
        accounts: [{ id: 'default', label: '默认令牌', labelKey: 'accountDefaultPat', active: true, kind: 'pat', configured: true, source: 'pat', credits: { state: 'ok', remain: 0, total: 0, unit: 'credits', planUnknown: true, exceeded: true, items: [], fetchedAt: 1792234000000 } }],
        checkin: { enabled: true },
        credential: { status: 'signed-in' },
      },
      ...providersSnapshot.slice(1),
    ]
    tree = await mount(card, { t: realT })
    const qoderText = textOf(tree)
    if (qoderText.includes(realT('creditsExhausted'))) {
      throw new Error('planUnknown 的 Qoder 被渲染成「额度已用尽」，与服务端的 Free 判定矛盾')
    }
    if (!qoderText.includes(realT('creditsFreeQueue')) && !qoderText.includes(realT('creditsFree'))) {
      throw new Error('planUnknown 的 Qoder 既不是「用尽」也不是「免费」')
    }
    console.log('✓ Qoder 的 planUnknown 与服务端同判为 Free，不再显示「额度已用尽」')

    // 2b) Trae 也会下发 `freePlan: true`（按免费额度计费）。客户端旧实现只认
    //     qoder 前缀，于是 Trae Free 在卡片上是红色的「额度已用尽」，而服务端
    //     （lib/quota.js）判的是「不预警、不换号」—— 同一份快照两个结论。
    STATUS.providers = [
      {
        ...base,
        provider: 'trae',
        displayName: 'Trae',
        kind: 'desktop-auth',
        credits: { state: 'ok', remain: 0, total: 0, unit: 'credits', freePlan: true, planName: 'Free', items: [], fetchedAt: 1792234000000 },
        accounts: [{
          id: 'default', label: '本机登录', active: true, kind: 'desktop-auth', configured: true, source: 'desktop',
          credits: { state: 'ok', remain: 0, total: 0, unit: 'credits', freePlan: true, planName: 'Free', items: [], fetchedAt: 1792234000000 },
        }],
        checkin: { enabled: true },
        credential: { status: 'signed-in' },
      },
      ...providersSnapshot.slice(1),
    ]
    tree = await mount(card, { t: realT })
    const traeFreeText = textOf(tree)
    if (traeFreeText.includes(realT('creditsExhausted'))) {
      throw new Error('Trae 的 freePlan 被渲染成「额度已用尽」（服务端判的是不预警、不换号）')
    }
    // 真的用完（有付费额度、剩 0）时必须仍然是「用尽」。
    STATUS.providers = [
      {
        ...base,
        provider: 'trae',
        displayName: 'Trae',
        kind: 'desktop-auth',
        credits: { state: 'ok', remain: 0, total: 1000, unit: 'credits', items: [], fetchedAt: 1792234000000 },
        accounts: [{
          id: 'default', label: '本机登录', active: true, kind: 'desktop-auth', configured: true, source: 'desktop',
          credits: { state: 'ok', remain: 0, total: 1000, unit: 'credits', items: [], fetchedAt: 1792234000000 },
        }],
        checkin: { enabled: true },
        credential: { status: 'signed-in' },
      },
      ...providersSnapshot.slice(1),
    ]
    tree = await mount(card, { t: realT })
    if (!textOf(tree).includes(realT('creditsExhausted'))) {
      throw new Error('真的用完的付费账号也必须显示「额度已用尽」')
    }
    console.log('✓ Trae Free 不显示「额度已用尽」，真用完的付费账号仍然显示')

    // 3) 美元计价的额度要显示 $，不能一律写成「积分」。
    //    服务端 lib/trae/transport.js 在按美元计费时下发 `unit: 'usd'`。
    STATUS.providers = [
      {
        ...base,
        credits: { state: 'ok', remain: 12.5, total: 100, used: 87.5, unit: 'usd', items: [{ name: 'Pro pack', remain: 12.5, total: 100 }], fetchedAt: 1792234000000 },
        accounts: JSON.parse(JSON.stringify(base.accounts)).map((account, index) => ({
          ...account,
          credits: { state: 'ok', remain: 12.5, total: 100, unit: 'usd', items: [], fetchedAt: 1792234000000 },
          active: index === 0,
        })),
        checkin: { enabled: true },
        credential: { status: 'signed-in' },
      },
      ...providersSnapshot.slice(1),
    ]
    tree = await mount(card, { t: realT })
    const usdText = textOf(tree)
    if (!usdText.includes('$')) throw new Error('美元计价的额度没有显示 $')
    if (usdText.includes('12.5 / 100 ' + realT('creditsUnit'))) {
      throw new Error('美元计价的额度被写成了「积分」')
    }
    // 账号页的额度单元格也要跟着换单位。
    const usdTabs = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'rpc-pagetab')
    usdTabs.find((node) => textOf(node).startsWith(realT('navAccounts'))).props.onClick()
    tree = await render(card, { t: realT })
    const usdAccountText = textOf(tree)
    if (!usdAccountText.includes('$')) throw new Error('账号页的额度单元格没有显示 $')
    console.log('✓ 美元计价的额度显示 $，不再冒充「积分」')

    // 4) 模型名是对象/缺失时不能渲染 [object Object]（坏缓存、手改目录）。
    STATUS.providers = [
      {
        ...base,
        models: [
          { id: 'auto', name: { bogus: true }, contextWindow: 200000, maxTokens: 8192, supportsImages: false, reasoningEfforts: [], disabled: false },
          { id: 'glm', name: 'GLM-5.3', contextWindow: 100000, maxTokens: 8192, supportsImages: false, reasoningEfforts: [], disabled: false },
        ],
        modelCount: 2,
      },
      ...providersSnapshot.slice(1),
    ]
    tree = await mount(card, { t: realT })
    const modelTabs = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'rpc-pagetab')
    modelTabs.find((node) => textOf(node).startsWith(realT('navModels'))).props.onClick()
    tree = await render(card, { t: realT })
    const modelText = textOf(tree)
    if (modelText.includes('[object Object]')) throw new Error('坏模型名被渲染成 [object Object]')
    if (!modelText.includes('auto')) throw new Error('坏模型名没有回落到模型 id')
    console.log('✓ 坏模型名（对象/缺失）回落到 id，不渲染 [object Object]')

    // 5) 「立即生效」的复选框：点完不能立刻弹回原值，连点两次必须发出两个
    //    相反的值（第二次是撤销）。旧实现直接读服务端字段、也没有本地意图：
    //    ① POST 在飞时 checked 仍是旧值（用户看不到自己刚点的结果）；
    //    ② 连点两次都从同一份旧 status 出发，发出**同一个**补丁。
    STATUS.providers = providersSnapshot
    tree = await mount(card, { t: realT })
    const settingsTabs = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'rpc-pagetab')
    settingsTabs.find((node) => textOf(node).startsWith(realT('navSettings'))).props.onClick()
    tree = await render(card, { t: realT })
    const checkLabels = findAll(tree, (node) => node.type === 'label' && node.props?.className === 'rpc-check-label')
    const findBox = (needle) => {
      const label = checkLabels.find((node) => textOf(node).includes(realT(needle)))
      if (label === undefined) throw new Error(`找不到开关：${needle}`)
      return { label, box: label.children.find((child) => child && child.type === 'input') }
    }
    const usageToggle = findBox('usageShowInSidebar')
    if (usageToggle.box.props.checked !== true) throw new Error('侧栏用量开关初始应为勾选')
    const beforeUsage = calls.filter((call) => call.method === 'POST' && String(call.url).includes('/settings')).length
    // 让 /settings 挂住不返回：真实宿主保存时要 await 一轮目录 + 额度刷新，
    // 最长 90 秒，这正是「用户点完看不到结果」的窗口。请求仍然记进 `calls`，
    // 只是永不 resolve —— 与真实慢保存一致。
    const heldFetch = sandbox.fetch
    sandbox.fetch = (url, init) => {
      if (!String(url).includes('/settings')) return heldFetch(url, init)
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
      return new Promise(() => {})
    }
    try {
      usageToggle.box.props.onChange()
      tree = await render(card, { t: realT })
      const afterUsage = findAll(tree, (node) => node.type === 'label' && node.props?.className === 'rpc-check-label')
        .find((node) => textOf(node).includes(realT('usageShowInSidebar')))
        .children.find((child) => child && child.type === 'input')
      if (afterUsage.props.checked !== false) {
        throw new Error('点完「侧栏显示今日用量」后复选框弹回勾选（POST 还没回来就用了旧的服务端值）')
      }

      // 连点两次：两次必须发相反的值（第二次把第一次撤销掉）。
      const rateToggle = findBox('modelRateToggle')
      const beforeRate = calls.filter((call) => call.method === 'POST' && String(call.url).includes('/settings')).length
      rateToggle.box.props.onChange()
      tree = await render(card, { t: realT })
      const rateBox2 = findAll(tree, (node) => node.type === 'label' && node.props?.className === 'rpc-check-label')
        .find((node) => textOf(node).includes(realT('modelRateToggle')))
        .children.find((child) => child && child.type === 'input')
      rateBox2.props.onChange()
      const ratePosts = calls.filter((call) => call.method === 'POST' && String(call.url).includes('/settings')).slice(beforeRate)
      if (ratePosts.length !== 2) throw new Error(`连点两次应发两个补丁，实际 ${ratePosts.length}`)
      const firstRate = JSON.parse(ratePosts[0].body).display?.showRateInModelName
      const secondRate = JSON.parse(ratePosts[1].body).display?.showRateInModelName
      if (firstRate === secondRate) {
        throw new Error(`连点两次发出了一样的值（${String(firstRate)}），第二次撤销丢失`)
      }
    } finally {
      sandbox.fetch = heldFetch
    }
    const usagePosts = calls.filter((call) => call.method === 'POST' && String(call.url).includes('/settings')).slice(beforeUsage)
    if (usagePosts.length < 1) throw new Error('一次点击应只发一个补丁')
    if (JSON.parse(usagePosts[0].body).display?.showUsageInSidebar !== false) {
      throw new Error(`补丁内容不对：${usagePosts[0].body}`)
    }
    console.log('✓ 立即生效的开关点完立刻反映，连点两次能正确撤销')

    // 6) 接入开关的本地意图不能被一次 /status 轮询清掉。
    //    /settings 会等一轮目录 + 额度刷新（最长 90 秒），期间必然穿插轮询；
    //    旧实现在 `useEffect([status])` 里无条件清空意图，开关会自己弹回「开」。
    tree = await mount(card, { t: (key) => key })
    const beforeToggle = calls.filter((call) => call.method === 'POST' && String(call.url).includes('/settings')).length
    const switchOf = (node) => find(node, (item) => item.type === 'input' && item.props?.className === 'rpc-switch-input')
    const switchInput = switchOf(tree)
    if (switchInput === undefined) throw new Error('找不到接入开关')
    if (switchInput.props.checked !== true) throw new Error('接入开关初始应为开')
    // 同样让 /settings 挂住：PATCH 在飞时才可能被轮询「翻回去」。
    const heldFetch2 = sandbox.fetch
    sandbox.fetch = (url, init) => {
      if (!String(url).includes('/settings')) return heldFetch2(url, init)
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
      return new Promise(() => {})
    }
    try {
      switchInput.props.onChange()
      tree = await render(card, { t: (key) => key })
      if (switchOf(tree).props.checked !== false) throw new Error('关掉接入后开关没有立刻变成关闭')
      // 模拟 PATCH 还没回来时的一次轮询（同样的 status 送达，effect 重跑）。
      tree = await render(card, { t: (key) => key })
      if (switchOf(tree).props.checked !== false) {
        throw new Error('一次 /status 轮询把接入开关的本地意图清掉了（开关弹回「开」）')
      }
    } finally {
      sandbox.fetch = heldFetch2
    }
    const togglePosts = calls.filter((call) => call.method === 'POST' && String(call.url).includes('/settings')).slice(beforeToggle)
    if (togglePosts.length !== 1 || JSON.parse(togglePosts[0].body).providers?.workbuddy?.enabled !== false) {
      throw new Error(`接入开关的补丁不对：${JSON.stringify(togglePosts.map((call) => call.body))}`)
    }
    console.log('✓ 接入开关的本地意图不会在 /status 轮询时被清掉')

    // 7) 被后续写入「超过」的那次保存，响应到达时也必须把意图交还。
    //
    //    场景：A 还在飞时用户又点了 B。B 的响应先回（`writeSeq` 变成 2），
    //    A 的响应后回却因 `seq !== writeSeq.current` 提前 return —— 旧实现把
    //    settle 写在那个 return 之后，于是 A 的意图永远留在 pending 里，开关
    //    冻在用户点出来的值上，之后新到的 /status 也不再让它跟随服务端
    //    （实测：侧栏用量显示「关」、settings 里其实是「开」，直到刷新页面）。
    //
    //    这里用「把 /settings 响应挂起来、手动乱序 resolve」复现，两个开关都
    //    必须回到服务端值。
    {
      const held = []
      const restore = sandbox.fetch
      sandbox.fetch = (url, init) => {
        if (!String(url).includes('/settings')) return restore(url, init)
        return new Promise((resolve) => {
          held.push(() => resolve({ ok: true, status: 200, json: async () => STATUS, text: async () => '' }))
        })
      }
      let raceTree
      try {
        raceTree = await mount(card, { t: realT })
        const raceTabs = findAll(raceTree, (node) => node.type === 'button' && node.props?.className === 'rpc-pagetab')
        raceTabs.find((node) => textOf(node).startsWith(realT('navSettings'))).props.onClick()
        raceTree = await render(card, { t: realT })
        const boxIn = (tree, needle) => findAll(tree, (node) => node.type === 'label' && node.props?.className === 'rpc-check-label')
          .find((node) => textOf(node).includes(realT(needle)))
          .children.find((child) => child && child.type === 'input')
        boxIn(raceTree, 'usageShowInSidebar').props.onChange()
        raceTree = await render(card, { t: realT })
        boxIn(raceTree, 'modelRateToggle').props.onChange()
        raceTree = await render(card, { t: realT })
        if (held.length !== 2) throw new Error(`应有两个挂起的 /settings 写入，实际 ${held.length}`)
        // 先resolve 后发的（序号更大），再 resolve 先发的（已被超过的那次）。
        held[1]()
        await new Promise((resolve) => setTimeout(resolve, 20))
        raceTree = await render(card, { t: realT })
        held[0]()
        await new Promise((resolve) => setTimeout(resolve, 20))
        raceTree = await render(card, { t: realT })
        // 服务端两处都是 true；被超过的那次也必须交还意图、回到服务端值。
        if (boxIn(raceTree, 'usageShowInSidebar').props.checked !== true) {
          throw new Error('被后续写入超过的那次保存没有交还意图，开关卡在乐观值上')
        }
        // 再走一次完整轮询，确认它真的重新跟随服务端。
        raceTree = await render(card, { t: realT })
        if (boxIn(raceTree, 'usageShowInSidebar').props.checked !== true) {
          throw new Error('被超过的开关在 /status 轮询后仍不跟随服务端')
        }
      } finally {
        sandbox.fetch = restore
        // 放掉还挂着的（如果有），避免影响后续用例。
        for (const resolve of held) resolve()
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      console.log('✓ 被后续写入超过的保存也会交还意图，开关不会卡在乐观值上')
    }
  } finally {
    STATUS.providers = providersSnapshot
    STATUS.stats = statsSnapshot
  }
}

// ---------- 第十二轮审计（0.6.10）的前端回归 ----------
{
  const providersSnapshot = STATUS.providers
  const statsSnapshot = STATUS.stats
  const settingsSnapshot = STATUS.settings
  try {
    // 1) 先点的开关失败、后点的成功：失败那次也必须交还本地意图。
    //    旧实现只在成功分支 settle，失败且被更新写入超过时直接 return，
    //    第一个开关永远停在用户点出来的值，连轮询也不纠正。
    {
      const held = []
      const restore = sandbox.fetch
      sandbox.fetch = (url, init) => {
        if (!String(url).includes('/settings')) return restore(url, init)
        return new Promise((resolve, reject) => { held.push({ resolve, reject }) })
      }
      try {
        let tree = await mount(card, { t: realT })
        const tabs = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'rpc-pagetab')
        tabs.find((node) => textOf(node).startsWith(realT('navSettings'))).props.onClick()
        tree = await render(card, { t: realT })
        const boxIn = (needle) => findAll(tree, (node) => node.type === 'label' && node.props?.className === 'rpc-check-label')
          .find((node) => textOf(node).includes(realT(needle)))
          .children.find((child) => child && child.type === 'input')
        boxIn('modelRateToggle').props.onChange()
        tree = await render(card, { t: realT })
        boxIn('usageShowInSidebar').props.onChange()
        tree = await render(card, { t: realT })
        if (held.length !== 2) throw new Error(`应有两个挂起的 /settings 写入，实际 ${held.length}`)
        // 后发的先成功，先发的最后失败（被更新写入超过）。
        held[1].resolve({ ok: true, status: 200, json: async () => STATUS, text: async () => '' })
        await new Promise((resolve) => setTimeout(resolve, 20))
        held[0].reject(new Error('network down'))
        await new Promise((resolve) => setTimeout(resolve, 20))
        tree = await render(card, { t: realT })
        const rateBox = boxIn('modelRateToggle')
        if (rateBox.props.checked !== true) {
          throw new Error('先点的开关失败后被更新写入掩盖，界面永久停在错误的本地值')
        }
        if (textOf(tree).includes(realT('error'))) throw new Error('被更新写入超过的失败不应弹出错误横幅')
      } finally {
        sandbox.fetch = restore
        for (const entry of held) entry.resolve({ ok: true, status: 200, json: async () => STATUS, text: async () => '' })
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      console.log('✓ 被更新写入掩盖的保存失败也会交还意图，开关回到服务端值')
    }

    // 2) 当前账号未登录、但账号池里还有另一个已配置账号时，「立即签到」不能整家禁用。
    {
      const base = providersSnapshot[0]
      STATUS.providers = [
        {
          ...base,
          credential: { status: 'signed-out' },
          accounts: [
            { id: 'default', label: '本机登录', active: true, kind: 'desktop', configured: false, source: 'desktop', credits: { state: 'none' } },
            { id: 'acc-2', label: '备用账号', active: false, kind: 'desktop', configured: true, source: 'browser-login', credits: { state: 'ok', remain: 10, total: 100, unit: 'credits' } },
          ],
          checkin: { enabled: true },
        },
        ...providersSnapshot.slice(1),
      ]
      let tree = await mount(card, { t: realT })
      const tabs = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'rpc-pagetab')
      tabs.find((node) => textOf(node).startsWith(realT('navAccounts'))).props.onClick()
      tree = await render(card, { t: realT })
      const checkinButton = find(tree, (node) => node.type === 'button' && textOf(node) === realT('checkinNow'))
      if (checkinButton === undefined) throw new Error('账号页找不到「立即签到」按钮')
      if (checkinButton.props.disabled === true) {
        throw new Error('另一个账号已配置时，整家的「立即签到」仍被当前账号的未登录状态禁用')
      }
      console.log('✓ 其它账号已配置时「立即签到」不再被当前账号禁用')
    }

    // 3) 长模型 id 不能把模型名/元信息挤成 0 宽；必须有省略号与宽度上限。
    if (!source.includes('.rpc-model-id{font-family:')
      || !source.includes('max-width:42%;overflow:hidden;text-overflow:ellipsis}')) {
      throw new Error('长模型 id 缺少宽度上限与省略号（会把模型名挤成 0 宽并溢出）')
    }
    console.log('✓ 长模型 id 有宽度上限与省略号，不再挤掉模型名')

    // 4) 英文单数：1 个模型 / 1 次请求不能写成复数。
    {
      const base = providersSnapshot[0]
      STATUS.providers = [
        {
          ...base,
          models: [{ id: 'only', name: 'Only', contextWindow: 1000, maxTokens: 100, supportsImages: false, reasoningEfforts: [], disabled: false }],
          modelCount: 1,
          usage: { ...base.usage, today: { requests: 1, totalTokens: 10 } },
          accounts: [{ id: 'default', label: '本机登录', active: true, kind: 'desktop', configured: true, source: 'desktop', usage: { requests: 1, totalTokens: 10 }, credits: { state: 'ok', remain: 1, total: 1, unit: 'credits' } }],
        },
        ...providersSnapshot.slice(1),
      ]
      STATUS.stats = { ...statsSnapshot, totalTokens: 10 }
      const enT = (key, params) => {
        let text = realLocale.en[key] !== undefined ? realLocale.en[key] : key
        if (params !== undefined) {
          text = String(text).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])))
        }
        return text
      }
      const tree = await mount(card, { t: enT })
      const text = textOf(tree)
      if (/(^|\s|· )1 Models(\s|$)/.test(text)) throw new Error(`英文界面把 1 个模型写成复数：${text.slice(0, 160)}`)
      if (/(^|\s|· )1 Requests(\s|$)/.test(text)) throw new Error(`英文界面把 1 次请求写成复数：${text.slice(0, 160)}`)
      console.log('✓ 英文界面单数不再写成复数（1 Model / 1 Request）')
    }

    // 5) 超时的英文 DOMException 不应原样进中文横幅。
    {
      const restore = sandbox.fetch
      try {
        let tree = await mount(card, { t: realT })
        const tabs = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'rpc-pagetab')
        tabs.find((node) => textOf(node).startsWith(realT('navSettings'))).props.onClick()
        tree = await render(card, { t: realT })
        sandbox.fetch = async (url, init) => {
          if (String(url).includes('/settings')) {
            calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
            throw new Error('The operation was aborted due to timeout')
          }
          return restore(url, init)
        }
        const rateBox = findAll(tree, (node) => node.type === 'label' && node.props?.className === 'rpc-check-label')
          .find((node) => textOf(node).includes(realT('modelRateToggle')))
          .children.find((child) => child && child.type === 'input')
        rateBox.props.onChange()
        await new Promise((resolve) => setTimeout(resolve, 20))
        // 跳过 effects：迷你 harness 每次渲染都会重跑所有 effect，而真实 React
        // 只跑一次；不跳过的话成功的 /status 会立刻把错误横幅清掉。
        tree = await render(card, { t: realT }, true)
        const text = textOf(tree)
        if (!text.includes(realT('errorTimeout'))) throw new Error(`超时没有给出本地化说明：${text.slice(0, 200)}`)
        if (text.includes('aborted due to timeout')) throw new Error('中文界面原样显示了英文 DOMException')
      } finally {
        sandbox.fetch = restore
      }
      console.log('✓ 保存超时会给出可读的本地化说明，不显示英文 DOMException')
    }
  } finally {
    STATUS.providers = providersSnapshot
    STATUS.stats = statsSnapshot
    STATUS.settings = settingsSnapshot
  }
}

// ---------- 第十四轮审计（0.7.2）的前端回归 ----------
{
  const providersSnapshot = STATUS.providers
  const statsSnapshot = STATUS.stats
  const settingsSnapshot = STATUS.settings
  const eventsSnapshot = STATUS.events
  const openPage = async (tree, key) => {
    const tabs = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'rpc-pagetab')
    const tab = tabs.find((node) => textOf(node).startsWith(realT(key)))
    if (tab === undefined) throw new Error(`找不到「${key}」页签`)
    tab.props.onClick()
    return await render(card, { t: realT })
  }
  try {
    // 1) 停用账号的「使用」按钮必须禁用并说明原因：宿主会跳过停用账号，
    //    旧实现点了零变化、零报错，像按钮坏了。
    {
      const base = providersSnapshot[0]
      STATUS.providers = [
        {
          ...base,
          credential: { status: 'signed-in' },
          accounts: [
            { id: 'default', label: '本机登录', active: true, kind: 'desktop', configured: true, source: 'desktop', credits: { state: 'ok', remain: 10, total: 100, unit: 'credits' } },
            { id: 'acc-off', label: '停用账号', active: false, enabled: false, kind: 'desktop', configured: true, source: 'browser-login', credits: { state: 'ok', remain: 5, total: 100, unit: 'credits' } },
          ],
        },
        ...providersSnapshot.slice(1),
      ]
      let tree = await mount(card, { t: realT })
      tree = await openPage(tree, 'navAccounts')
      const buttons = findAll(tree, (node) => node.type === 'button' && textOf(node) === realT('useAccount'))
      if (buttons.length === 0) throw new Error('账号页找不到「使用」按钮')
      const disabledButton = buttons.find((node) => node.props?.title === realT('useAccountDisabled'))
      if (disabledButton === undefined) throw new Error('停用账号的「使用」按钮没有给出「已停用」说明')
      if (disabledButton.props.disabled !== true) throw new Error('停用账号的「使用」按钮仍可点击')
      console.log('✓ 停用账号的「使用」按钮被禁用并说明原因')
    }

    // 2) 过期的账号 × 模型测试结论不能冒充当前证据：降级成中性色 +
    //    「历史结论（N 天前）」，30 分钟内的结论仍保持警告色。
    {
      const base = providersSnapshot[0]
      const staleAt = Date.now() - 7 * 86400000
      STATUS.providers = [
        {
          ...base,
          accounts: [
            {
              ...base.accounts[0],
              modelTests: { auto: { ok: false, code: 'RATE_LIMIT', at: staleAt, resetHint: '2026-10-22 10:00:00', error: '429' } },
            },
            {
              id: 'acc-2', label: '备用账号', active: false, kind: 'desktop', configured: true, source: 'browser-login',
              credits: { state: 'ok', remain: 10, total: 100, unit: 'credits' },
            },
          ],
        },
        ...providersSnapshot.slice(1),
      ]
      let tree = await mount(card, { t: realT })
      tree = await openPage(tree, 'navUsage')
      const badges = findAll(tree, (node) => node.type === 'span' && textOf(node) === realT('limitBadge'))
      const staleBadge = badges.find((node) => String(node.props?.title ?? '').startsWith('历史结论'))
      if (staleBadge === undefined) throw new Error('过期的模型测试没有标成历史结论')
      if (String(staleBadge.props.className).includes('rpc-chip-warn')) throw new Error('过期结论仍在用警告色')

      // 30 分钟内：仍是当前证据。
      STATUS.providers[0].accounts[0].modelTests.auto.at = Date.now() - 60_000
      tree = await mount(card, { t: realT })
      tree = await openPage(tree, 'navUsage')
      const fresh = findAll(tree, (node) => node.type === 'span' && textOf(node) === realT('limitBadge'))
      const freshBadge = fresh.find((node) => String(node.props?.className).includes('rpc-chip-warn'))
      if (freshBadge === undefined) throw new Error('30 分钟内的限额结论必须保持警告色')
      console.log('✓ 过期的模型测试降级为中性「历史结论」，30 分钟内仍是警告色')
    }

    // 3) 事件筛选值失效时下拉框不能变成空白；导出必须带服务商。
    {
      const scoped = {
        id: 'ev-scope', at: Date.now(), type: 'account-switch', level: 'warn', provider: 'workbuddy',
        accountId: 'acc-x', message: '切换到临时账号',
      }
      STATUS.events = { ...eventsSnapshot, items: [scoped, ...eventsSnapshot.items], count: eventsSnapshot.count + 1 }
      let tree = await mount(card, { t: realT })
      tree = await openPage(tree, 'navActivity')
      const accountSelect = findAll(tree, (node) => node.type === 'select' && node.props?.['aria-label'] === realT('eventAccountLabel'))[0]
      if (accountSelect === undefined) throw new Error('动态页找不到账号筛选下拉框')
      accountSelect.props.onChange({ target: { value: 'workbuddy::acc-x' } })
      tree = await render(card, { t: realT })
      const exportButton = findAll(tree, (node) => node.type === 'button' && textOf(node).includes(realT('eventExport')))[0]
      if (exportButton === undefined) throw new Error('动态页找不到导出按钮')
      exportButton.props.onClick()
      tree = await render(card, { t: realT })
      const textarea = findAll(tree, (node) => node.type === 'textarea' && typeof node.props?.value === 'string' && node.props.value.includes('"filters"'))[0]
      if (textarea === undefined) throw new Error('导出没有给出可复制的 JSON 兜底')
      const exported = JSON.parse(textarea.props.value)
      if (exported.filters.provider !== 'workbuddy') throw new Error('导出条件丢了服务商：' + JSON.stringify(exported.filters))
      if (exported.filters.accountId !== 'acc-x') throw new Error('导出条件丢了账号：' + JSON.stringify(exported.filters))

      // 该账号的事件被新事件挤出保留窗口后，下拉框仍要显示当前筛选值。
      STATUS.events = { ...eventsSnapshot, items: [...eventsSnapshot.items] }
      tree = await render(card, { t: realT })
      const selectAfter = findAll(tree, (node) => node.type === 'select' && node.props?.['aria-label'] === realT('eventAccountLabel'))[0]
      const options = findAll(selectAfter, (node) => node.type === 'option')
      if (!options.some((node) => node.props?.value === 'workbuddy::acc-x')) {
        throw new Error('筛选值失效后下拉框会显示空白（当前值不在 options 里）')
      }
      console.log('✓ 事件导出带服务商，失效的筛选值仍在下拉框里可见')
    }

    // 4) 服务端错误码必须本地化，不能把 `settings-write-failed` 原样显示。
    {
      const restore = sandbox.fetch
      try {
        let tree = await mount(card, { t: realT })
        tree = await openPage(tree, 'navSettings')
        sandbox.fetch = async (url, init) => {
          if (String(url).includes('/settings')) return { ok: false, status: 500, json: async () => ({ error: 'settings-write-failed' }) }
          return restore(url, init)
        }
        const rateBox = findAll(tree, (node) => node.type === 'label' && node.props?.className === 'rpc-check-label')
          .find((node) => textOf(node).includes(realT('modelRateToggle')))
          .children.find((child) => child && child.type === 'input')
        rateBox.props.onChange()
        await new Promise((resolve) => setTimeout(resolve, 20))
        tree = await render(card, { t: realT }, true)
        const text = textOf(tree)
        if (!text.includes(realT('errorServerWriteFailed'))) throw new Error('服务端错误码没有本地化：' + text.slice(0, 160))
        if (text.includes('settings-write-failed')) throw new Error('中文界面原样显示了服务端错误码')
      } finally {
        sandbox.fetch = restore
      }
      console.log('✓ 服务端错误码显示为可操作的中文说明')
    }

    // 5) 金额按分显示、英文单数：0.04 不能变成 0；「1 packages」不能出现。
    {
      STATUS.providers = [
        {
          ...providersSnapshot[0],
          credits: { state: 'ok', remain: 0.04, total: 100, unit: 'usd', items: [{ name: 'Pack', remain: 0.04, total: 0.5 }] },
        },
        ...providersSnapshot.slice(1),
      ]
      let tree = await mount(card, { t: realT })
      if (!textOf(tree).includes('0.04')) throw new Error('美元余额 0.04 被显示成 0')
      const enT = (key, params) => {
        let text = realLocale.en[key] !== undefined ? realLocale.en[key] : key
        if (params !== undefined) {
          text = String(text).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])))
        }
        return text
      }
      tree = await mount(card, { t: enT })
      const text = textOf(tree)
      if (text.includes('1 packages')) throw new Error('英文界面把 1 个套餐包写成复数')
      if (!text.includes('1 package')) throw new Error('英文界面缺少单数「1 package」')
      if (!source.includes("rows.length === 1 ? 'creditsSourcesOne'")) throw new Error('侧栏服务商数量没有单数分支')
      if (!source.includes("todayUsage.requests === 1 ? 'creditsTodayOne'")) throw new Error('侧栏今日次数没有单数分支')
      console.log('✓ 美元余额按分显示；英文单数与侧栏计数分支都已接上')
    }
  } finally {
    STATUS.providers = providersSnapshot
    STATUS.stats = statsSnapshot
    STATUS.settings = settingsSnapshot
    STATUS.events = eventsSnapshot
  }
}

// ---------- 第十五轮审计（0.7.3）的前端回归 ----------
{
  const providersSnapshot = STATUS.providers
  const statsSnapshot = STATUS.stats
  const settingsSnapshot = STATUS.settings
  const enT = (key, params) => {
    let text = realLocale.en[key] !== undefined ? realLocale.en[key] : key
    if (params !== undefined) {
      text = String(text).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])))
    }
    return text
  }
  const openPageWith = async (tree, t, key) => {
    const tabs = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'rpc-pagetab')
    const tab = tabs.find((node) => textOf(node).startsWith(t(key)))
    if (tab === undefined) throw new Error(`找不到「${key}」页签`)
    tab.props.onClick()
    return await render(card, { t })
  }
  try {
    // 1) 诊断按钮离开「动态」页后不能继续报 aria-expanded=true；从别的页
    //    点它必须是「跳过去并打开」，不能是第一下反而关掉面板。
    {
      let tree = await mount(card, { t: realT })
      const heroDiag = find(tree, (node) => node.type === 'button'
        && node.props?.className === 'rpc-btn' && textOf(node) === realT('diagnostics'))
      if (heroDiag === undefined) throw new Error('找不到页头诊断按钮')
      heroDiag.props.onClick()
      tree = await render(card, { t: realT })
      if (find(tree, (node) => node.type === 'pre') === undefined) throw new Error('首次点诊断没有展开 JSON')
      tree = await openPageWith(tree, realT, 'navAccounts')
      const heroAfter = find(tree, (node) => node.type === 'button'
        && node.props?.className === 'rpc-btn' && textOf(node) === realT('diagnostics'))
      if (heroAfter.props['aria-expanded'] === true) throw new Error('离开动态页后 aria-expanded 仍是 true')
      if (heroAfter.props['aria-controls'] !== undefined) throw new Error('离开动态页后 aria-controls 仍指向不可见节点')
      heroAfter.props.onClick()
      tree = await render(card, { t: realT })
      const activity = find(tree, (node) => node.props?.id === 'dsh-rpc-page-activity')
      if (activity === undefined || activity.props.style?.display !== 'flex') throw new Error('从其他页点诊断没有跳到动态页')
      if (find(tree, (node) => node.type === 'pre') === undefined) throw new Error('从其他页点诊断把面板关掉了')
      const heroOpen = find(tree, (node) => node.type === 'button'
        && node.props?.className === 'rpc-btn' && textOf(node) === realT('diagnostics'))
      if (heroOpen.props['aria-expanded'] !== true) throw new Error('打开后 aria-expanded 不是 true')
      console.log('✓ 诊断按钮跨页后状态与可见性一致')
    }

    // 2) /status 一直失败时，侧栏小卡不能永远停在「读取中…」：要给失败文案
    //    与可点的重试入口（宿主重启期间卡片已有重试，小卡没有）。
    {
      fetchFailure = 'status'
      try {
        await mount(pill, { t: realT, wide: true })
        await new Promise((resolve) => setTimeout(resolve, 20))
        let tree = await render(pill, { t: realT, wide: true })
        // 侧栏组件走 ctx.locale.bind（测试沙箱里是 key-only），所以这里断言 key。
        if (!textOf(tree).includes('statusLoadFailed')) throw new Error('首屏读取失败仍显示「读取中」')
        const retryButton = find(tree, (node) => node.type === 'button' && textOf(node).includes('retry'))
        if (retryButton === undefined) throw new Error('读取失败没有重试按钮')
        if (retryButton.props.disabled === true) throw new Error('重试按钮仍是 disabled')
        const before = calls.length
        retryButton.props.onClick()
        await new Promise((resolve) => setTimeout(resolve, 20))
        if (calls.length <= before) throw new Error('点重试没有发出请求')
        console.log('✓ 侧栏首屏读取失败给出重试入口')
      } finally {
        fetchFailure = null
      }
    }

    // 3) provider 条目缺字符串 id 时，侧栏小卡不能整块崩掉（设置卡片是好的）。
    {
      const snapshot = STATUS.providers
      try {
        STATUS.providers = [{ ...snapshot[0], provider: undefined }, ...snapshot.slice(1)]
        const tree = await mount(pill, { t: realT, wide: true })
        if (tree === undefined) throw new Error('缺 provider id 时侧栏小卡没有渲染')
        console.log('✓ provider 缺 id 时侧栏小卡不再抛 TypeError')
      } finally {
        STATUS.providers = snapshot
      }
    }

    // 4) 账号 × 模型表的展开按钮在英文界面不能写成 “Show all N events”。
    {
      const statsSnapshotLocal = { accountModels: STATUS.stats.accountModels, accountModelToday: STATUS.stats.accountModelToday }
      try {
        const rows = {}
        for (let index = 0; index < 10; index++) {
          const model = `m${String(index).padStart(2, '0')}`
          rows[`workbuddy::default::${model}`] = { provider: 'workbuddy', accountId: 'default', model, requests: 1, totalTokens: 10, avgDurationMs: 100 }
        }
        STATUS.stats.accountModels = rows
        STATUS.stats.accountModelToday = rows
        let tree = await mount(card, { t: enT })
        tree = await openPageWith(tree, enT, 'navUsage')
        const expand = find(tree, (node) => node.type === 'button'
          && typeof textOf(node) === 'string' && textOf(node).includes('Show all 10'))
        if (expand === undefined) throw new Error('英文界面找不到账号 × 模型的展开按钮')
        if (textOf(expand).includes('events')) throw new Error('用量表的展开按钮写成了 events：' + textOf(expand))
        if (!textOf(expand).includes('Show all 10 rows')) throw new Error('展开按钮文案不是 rows：' + textOf(expand))
        console.log('✓ 英文界面用量表展开按钮不再指向 events')
      } finally {
        STATUS.stats.accountModels = statsSnapshotLocal.accountModels
        STATUS.stats.accountModelToday = statsSnapshotLocal.accountModelToday
      }
    }

    // 5) 最近请求不能静默截断成 6 行、摘要却按截断后的数字写。
    {
      const recentSnapshot = STATUS.stats.recent
      try {
        const recent = []
        for (let index = 0; index < 12; index++) {
          recent.push({
            at: Date.now() - index * 60_000, provider: 'workbuddy', accountId: 'default',
            model: `recent-${String(index).padStart(2, '0')}`, kind: 'stop', durationMs: 900, totalTokens: 20,
          })
        }
        STATUS.stats.recent = recent
        let tree = await mount(card, { t: realT })
        tree = await openPageWith(tree, realT, 'navUsage')
        const text = textOf(tree)
        if (!text.includes(realT('usageRecent') + ' · 12')) throw new Error('最近请求摘要没有显示真实条数')
        if (!text.includes('recent-11')) throw new Error('最近请求被截断，最后一条没有渲染')
        console.log('✓ 最近请求展示全部条目，摘要与行数一致')
      } finally {
        STATUS.stats.recent = recentSnapshot
      }
    }

    // 6) 停用账号的「请先启用」不能是死胡同：账号行要给一个可点的「启用」。
    {
      const base = providersSnapshot[0]
      STATUS.providers = [
        {
          ...base,
          credential: { status: 'signed-in' },
          accounts: [
            { id: 'default', label: '本机登录', active: true, kind: 'desktop', configured: true, source: 'desktop', credits: { state: 'ok', remain: 10, total: 100, unit: 'credits' } },
            { id: 'acc-off', label: '停用账号', active: false, enabled: false, kind: 'desktop', configured: true, source: 'browser-login', credits: { state: 'ok', remain: 5, total: 100, unit: 'credits' } },
          ],
        },
        ...providersSnapshot.slice(1),
      ]
      let tree = await mount(card, { t: realT })
      tree = await openPageWith(tree, realT, 'navAccounts')
      const enable = find(tree, (node) => node.type === 'button' && textOf(node) === realT('enableAccount'))
      if (enable === undefined) throw new Error('停用账号没有「启用」入口')
      if (enable.props.disabled === true) throw new Error('「启用」按钮不可点')
      const before = calls.length
      enable.props.onClick()
      await new Promise((resolve) => setTimeout(resolve, 20))
      const posted = calls.slice(before).find((entry) => entry.method === 'POST'
        && typeof entry.body === 'string' && entry.body.includes('acc-off'))
      if (posted === undefined) throw new Error('点「启用」没有写出设置')
      const patch = JSON.parse(posted.body)
      const row = patch.accounts?.workbuddy?.[0]
      if (row === undefined || row.enabled !== true) throw new Error('启用补丁没有把 enabled 设为 true')
      if (row.label !== '停用账号') throw new Error('启用补丁丢了账号名（会被服务端改成「账号 N」）')
      console.log('✓ 停用账号可在账号行直接启用')
    }
  } finally {
    STATUS.providers = providersSnapshot
    STATUS.stats = statsSnapshot
    STATUS.settings = settingsSnapshot
  }
}


// ---------- 第十六轮审计（0.7.4）的前端回归 ----------
{
  const providersSnapshot = STATUS.providers
  const statsSnapshot = STATUS.stats
  const enT = (key, params) => {
    let text = realLocale.en[key] !== undefined ? realLocale.en[key] : key
    if (params !== undefined) {
      text = String(text).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])))
    }
    return text
  }
  const openPageWith = async (tree, t, key) => {
    const tabs = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'rpc-pagetab')
    const tab = tabs.find((node) => textOf(node).startsWith(t(key)))
    if (tab === undefined) throw new Error(`找不到「${key}」页签`)
    tab.props.onClick()
    return await render(card, { t })
  }
  const openProvider = async (tree, provider, t) => {
    const tab = find(tree, (node) => node.type === 'button' && node.props?.id === 'dsh-rpc-tab-' + provider)
    if (tab === undefined) throw new Error(`找不到服务商 ${provider} 的页签`)
    tab.props.onClick()
    return await render(card, { t })
  }
  try {
    // 1) 额度读失败但还留着旧数字：必须显示失败原因，chip 不能再写「正在刷新…」。
    {
      const base = providersSnapshot[0]
      STATUS.providers = [
        {
          ...base,
          credits: { ...base.credits, stale: true, error: 'HTTP 503 upstream unavailable' },
        },
        ...providersSnapshot.slice(1),
      ]
      const tree = await mount(card, { t: realT })
      const text = textOf(tree)
      if (!text.includes(realT('creditsFailed', { message: 'HTTP 503 upstream unavailable' }))) {
        throw new Error('stale 额度没有显示读取失败原因')
      }
      if (text.includes(realT('creditsStale'))) throw new Error('没有请求在飞时仍写「正在刷新…」')
      if (!text.includes(realT('creditsCachedHint'))) throw new Error('stale 额度缺少「显示上次结果」的说明')
    }

    // 2) 凭证失效时，服务商页签 / 页头 / 状态 chip 不能再写「正常」。
    {
      const base = providersSnapshot[1]
      STATUS.providers = [
        providersSnapshot[0],
        { ...base, health: { state: 'degraded', consecutiveFailures: 2, lastErrorAt: Date.now() }, credential: { status: 'no-credential', reason: 'no-credential' } },
        ...providersSnapshot.slice(2),
      ]
      let tree = await mount(card, { t: realT })
      const tab = find(tree, (node) => node.type === 'button' && node.props?.id === 'dsh-rpc-tab-workbuddy-ai')
      if (!textOf(tab).includes(realT('signedOut'))) throw new Error('未登录的页签没有写「未登录」')
      if (textOf(tab).includes(realT('healthDegraded'))) throw new Error('未登录的页签仍在写健康状态')
      tree = await openProvider(tree, 'workbuddy-ai', realT)
      if (textOf(tree).includes(realT('healthDegraded'))) throw new Error('未登录的详情区仍挂着「健康一般」')
    }

    // 3) 签到 / 刷新额度的 busy 键按 provider 隔离：A 家在跑，B 家按钮仍可用。
    {
      const tree0 = await mount(card, { t: realT })
      let tree = await openPageWith(tree0, realT, 'navAccounts')
      const checkinButton = findButton(tree, realT('checkinNow'))
      if (checkinButton === undefined) throw new Error('找不到「立即签到」按钮')
      fetchDelayMs = 120
      checkinButton.props.onClick()
      tree = await render(card, { t: realT })
      tree = await openProvider(tree, 'qoder-global', realT)
      tree = await openPageWith(tree, realT, 'navAccounts')
      const other = findButton(tree, realT('checkinNow'))
      if (other === undefined) throw new Error('切到 Qoder 后「立即签到」变成了别的文案（busy 串台）')
      if (other.props.disabled === true) throw new Error('A 家签到把 B 家的按钮禁用了')
      await new Promise((resolve) => setTimeout(resolve, 200))
      fetchDelayMs = 0
    }

    // 4) 账号 × 模型状态列只看「最近一次请求」：之后已经成功，就不能再挂旧限额。
    {
      const recentSnapshot = STATUS.stats.recent
      STATUS.stats = {
        ...statsSnapshot,
        recent: [
          { at: Date.now(), provider: 'workbuddy', accountId: 'default', model: 'auto', kind: 'stop', durationMs: 800, totalTokens: 20 },
          { at: Date.now() - 600_000, provider: 'workbuddy', accountId: 'default', model: 'auto', kind: 'error', code: 'RATE_LIMIT', durationMs: 300, totalTokens: 0 },
        ],
      }
      try {
        let tree = await mount(card, { t: realT })
        tree = await openPageWith(tree, realT, 'navUsage')
        // 只看「文字恰好是限额」的徽章：概览里「是否被限额」的说明句不算。
        const badges = findAll(tree, (node) => textOf(node) === realT('limitBadge'))
        if (badges.length > 0) throw new Error('最近一次已成功，仍挂着旧的「限额」徽章')
      } finally {
        STATUS.stats = statsSnapshot
        void recentSnapshot
      }
    }

    // 5) 概览的账号摘要点必须跟账号页同一判据：未配置不能画成绿色。
    {
      const base = providersSnapshot[0]
      STATUS.providers = [
        {
          ...base,
          accounts: [{ ...base.accounts[0], configured: false }],
        },
        ...providersSnapshot.slice(1),
      ]
      const tree = await mount(card, { t: realT })
      const section = find(tree, (node) => node.key === 'overview-accounts')
      const point = section === undefined ? undefined : find(section, (node) => node.props?.style?.width === 6 && node.props?.style?.height === 6)
      if (point === undefined) throw new Error('概览账号摘要缺少状态点')
      if (point.props.style.background === 'var(--dsw-alias-state-success-primary, #1a8f5f)') {
        throw new Error('未配置账号在概览里仍画成绿色')
      }
    }

    // 6) 一家从未发过请求时，14 天用量块仍要在，并显示空态文案。
    {
      const dailySnapshot = STATUS.stats.providerDaily
      STATUS.stats = { ...statsSnapshot, providerDaily: { ...dailySnapshot, 'qoder-global': [] } }
      try {
        let tree = await mount(card, { t: realT })
        tree = await openProvider(tree, 'qoder-global', realT)
        tree = await openPageWith(tree, realT, 'navUsage')
        if (!textOf(tree).includes(realT('usageHeatEmpty'))) throw new Error('零数据时整块 14 天趋势消失，空态文案不可达')
      } finally {
        STATUS.stats = statsSnapshot
      }
    }

    // 7) 英文界面的额度失败原因不是中文硬编码。
    {
      const base = providersSnapshot[0]
      STATUS.providers = [
        { ...base, credits: { ...base.credits, stale: true, error: 'HTTP 503' } },
        ...providersSnapshot.slice(1),
      ]
      const tree = await mount(card, { t: enT })
      if (!textOf(tree).includes(enT('creditsCachedHint'))) throw new Error('英文界面的 stale chip 文案不对')
      if (!textOf(tree).includes('HTTP 503')) throw new Error('英文界面丢了失败原因')
    }
    console.log('✓ 额度失败原因 / 未登录文案 / busy 隔离 / 旧限额徽章 / 概览状态点 / 14 天空态')
  } finally {
    STATUS.providers = providersSnapshot
    STATUS.stats = statsSnapshot
    fetchDelayMs = 0
  }
}

console.log('client-credits: OK')
