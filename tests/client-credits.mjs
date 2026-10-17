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

const React = {
  createElement,
  Fragment: 'Fragment',
  useState,
  useEffect: (fn) => effects.push(fn),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}

// ---------- 假的 /status ----------
const STATUS = {
  version: 4,
  plugin: { name: 'dsh-reverse-proxy-connect', version: '9.9.9', host: 'in-process', api: 4, node: '24.0.0' },
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
        today: { requests: 3, totalTokens: 80 },
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
    daily: [
      { date: '2026-10-15', requests: 1, totalTokens: 10 },
      { date: '2026-10-16', requests: 2, totalTokens: 40 },
      { date: '2026-10-17', requests: 4, totalTokens: 120 },
      { date: '2026-10-18', requests: 4, totalTokens: 100 },
    ],
    currentSession: { id: 's1', requests: 2, totalTokens: 30, avgDurationMs: 500, successRate: 1 },
    health: {},
    recent: [
      { at: 1792234000000, provider: 'workbuddy', accountId: 'default', model: 'auto', kind: 'stop', durationMs: 1000, totalTokens: 20 },
      { at: 1792233000000, provider: 'workbuddy', accountId: 'default', model: 'auto', kind: 'error', code: 'RATE_LIMIT', durationMs: 300, totalTokens: 0 },
    ],
  },
}

const calls = []
async function fakeFetch(url, init) {
  calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
  return { ok: true, status: 200, json: async () => STATUS }
}

// ---------- 载入 bundle ----------
let captured
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: fakeFetch,
  navigator: {},
  document: {
    createElement: () => ({}),
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    head: { appendChild: () => {} },
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

// 余额 0 的账号亮警示色，675 / 99 不亮
const warned = []
;(function walk(node) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (typeof node !== 'object') return
  if (typeof node.props?.style?.color === 'string' && node.props.style.color.includes('state-warning')) {
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
if (!warned.includes('0')) throw new Error(`余额 0 没有警示色：${JSON.stringify(warned)}`)
if (warned.some((value) => value.includes('675') || value.includes('99'))) {
  throw new Error(`不该警示的账号变红了：${JSON.stringify(warned)}`)
}
console.log('✓ 只有余额为 0 的账号亮警示色')

// 胶囊必须满宽：收起时也不能缩成内容宽度（否则比展开时窄一截）。
const collapsedToggle = find(tree, (node) => node.type === 'button' && node.props?.onClick !== undefined)
if (collapsedToggle.props.style?.width !== '100%') {
  throw new Error(`收起时胶囊宽度应为 100%，实际 ${String(collapsedToggle.props.style?.width)}`)
}
if (collapsedToggle.props.style?.justifyContent !== 'space-between') {
  throw new Error('满宽胶囊里的账号应两端对齐铺开')
}
console.log('✓ 胶囊收起时也是满宽')

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
if (hoverBackground === idleBackground || !hoverBackground.includes('bg-l2')) {
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
for (const label of ['creditsSources', 'creditsPercent', 'creditsToday', 'creditsExhausted', 'creditsFetchedAt']) {
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
if (!v4Text.includes('IMG')) throw new Error('卡片没有标记图片输入能力')
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
if (!String(advancedCall.body).includes('"alerts"') || !String(advancedCall.body).includes('thresholdRatio')) {
  throw new Error(`高级设置没有带上预警/换号阈值：${String(advancedCall.body).slice(0, 240)}`)
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

// ---------- 8b. 删除账号走 removedAccounts（避免旧列表覆盖新账号） ----------
const wbTab = findButton(cardTree, 'WorkBuddy')
if (wbTab === undefined) throw new Error('找不到 WorkBuddy 标签')
wbTab.props.onClick()
cardTree = await render(card, { t: (key) => key })
const removeButtons = findAll(cardTree, (node) => node.type === 'button' && textOf(node) === 'removeAccount')
if (removeButtons.length !== 2) throw new Error(`应有 2 个删除按钮，实际 ${removeButtons.length}`)
const beforeRemove = calls.length
removeButtons[1].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
const removeCall = calls[calls.length - 1]
if (calls.length === beforeRemove || !String(removeCall.body).includes('removedAccounts') || !String(removeCall.body).includes('acc-2')) {
  throw new Error(`删除账号应发 removedAccounts：${String(removeCall?.body).slice(0, 200)}`)
}
console.log('✓ 删除账号走 removedAccounts')

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
if (!trendCardText.includes('alertBannerExhausted') && !trendCardText.includes('alertBannerLow')) {
  throw new Error('额度为 0 时没有渲染预警横幅')
}
if (!trendCardText.includes('trend') || !trendCardText.includes('trendToday')) {
  throw new Error('额度区块没有渲染趋势')
}
if (!trendCardText.includes('trendEta')) throw new Error('没有渲染耗尽预估')
if (find(cardTree, (node) => node.type === 'polyline') === undefined) {
  throw new Error('额度趋势没有折线')
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

// ---------- 13. 侧栏面板显示趋势；关闭后今日用量徽标消失 ----------
hookStates = []
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

console.log('client-credits: OK')
