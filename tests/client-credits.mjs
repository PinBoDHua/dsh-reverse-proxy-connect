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

function beginRender() {
  activeOwner = ++ownerSeq
  hookIndex = 0
  refIndex = 0
  effects = []
  dirty = false
  return activeOwner
}

function useState(initial) {
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
  return { type, props: props ?? {}, children: children.flat(Infinity) }
}

// useRef 必须**跨渲染保留**（按 hook 序号），否则 pending 集合之类的东西
// 每次渲染都会被重置，测出来的行为是假的。
let refSlots = {}
let refIndex = 0
function useRef(initial) {
  const index = refIndex++
  if (!(index in refSlots)) refSlots[index] = { current: initial }
  return refSlots[index]
}

const React = {
  createElement,
  Fragment: 'Fragment',
  useState,
  useEffect: (fn) => effects.push(fn),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
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
        last: { at: 1792234000000, model: 'auto', kind: 'stop', durationMs: 1000, totalTokens: 20 },
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
      health: { state: 'degraded', consecutiveFailures: 2, lastErrorAt: 1792234000000 },
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
async function fakeFetch(url, init) {
  const target = String(url)
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
const ctx = {
  slots: {
    register(options, component) { registered.push({ options, component }); return () => {} },
    inject(name, callback) { callback() },
    entries() { return [] },
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  inject: (names, cb) => cb(ctx),
}
captured.apply(ctx)

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

/** 按可见文字找按钮。 */
function findButton(tree, label) {
  return find(tree, (node) => node.type === 'button' && textOf(node) === label)
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
console.log('✓ 高级设置会发 advanced 补丁')

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
  if (!finalList.includes('t1') || !finalList.includes('t2')) {
    throw new Error(`全关后单独开启一个模型，把整批改动丢了：${JSON.stringify(afterAllOff)}`)
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

/** 账号 × 模型的数据行（表头与数据行共用同一套 gridTemplateColumns，按文本筛掉表头）。 */
const pairRowNodes = (tree) => findAll(tree, (node) => node.type === 'div'
  && typeof node.props?.style?.gridTemplateColumns === 'string'
  && node.props.style.gridTemplateColumns === 'minmax(78px, 1fr) minmax(92px, 1.3fr) minmax(40px, .55fr) minmax(60px, .8fr) minmax(50px, .65fr) minmax(104px, 1.15fr)'
  && !textOf(node).includes('usageAccountCol'))

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
if (textOf(cardTree).includes('eventTitle')) throw new Error('没有事件字段时不该渲染事件区块')
STATUS.events = eventsSnapshot
console.log('✓ 老宿主没有事件账本时整块隐藏')

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
const aiTab = find(cardTree, (node) => node.type === 'button' && textOf(node) === 'WorkBuddy AI')
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

// 8) 账号 × 模型可以现场「检测」：429 要打「限额」徽章，按钮发 test-model。
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
  const limitChip = find(limitedRow, (node) => textOf(node) === 'limitBadge')
  if (limitChip === undefined || !String(limitChip.props?.title ?? '').includes('limitUntil')) {
    throw new Error('限额徽章的悬停提示缺少重置时间')
  }
  const testModelButton = find(limitedRow, (node) => node.type === 'button' && textOf(node) === 'modelTest')
  if (testModelButton === undefined) throw new Error('账号 × 模型行缺少「检测」按钮')
  const beforeModelTest = calls.length
  testModelButton.props.onClick()
  const modelTestCall = calls[calls.length - 1]
  if (calls.length === beforeModelTest || !String(modelTestCall.body).includes('"action":"test-model"')) {
    throw new Error('点「检测」没有发 test-model 请求')
  }
  if (!String(modelTestCall.body).includes('"model":"auto"') || !String(modelTestCall.body).includes('"accountId":"default"')) {
    throw new Error(`test-model 请求缺少账号或模型：${String(modelTestCall.body)}`)
  }
  await render(card, { t: (key) => key })
  console.log('✓ 账号 × 模型可现场检测，429 显示「限额」徽章')
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
console.log('✓ 复制失败有可见反馈与手动复制兜底')

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
  const manyEvents = Array.from({ length: 8 }, (_, i) => ({ ...baseEvents[i % baseEvents.length], id: 'ev-many-' + i, at: baseEvents[0].at - i * 60000 }))
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
  const extract = (header) => {
    const start = source.indexOf(header)
    if (start < 0) throw new Error(`client.js 里找不到 ${header}`)
    const name = header.slice('function '.length, header.indexOf('('))
    let depth = 0
    let end = start
    for (let i = source.indexOf('{', start); i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    return new Function(`${source.slice(start, end)}; return ${name}`)()
  }
  const fShortTime = extract('function formatShortTime(ms) {')
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

console.log('client-credits: OK')
