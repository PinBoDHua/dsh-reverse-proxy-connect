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
  version: 3,
  plugin: { name: 'dsh-reverse-proxy-connect', version: '9.9.9', host: 'in-process' },
  key: 'k',
  providers: [
    {
      provider: 'workbuddy', displayName: 'WorkBuddy', kind: 'desktop', enabled: true,
      catalogSource: 'live', fetchedAt: 1792234000000,
      models: [{ id: 'auto', name: 'Auto', contextWindow: 256000, maxTokens: 32000, supportsImages: true, reasoningEfforts: [], disabled: false, unavailable: false, forced: false }],
      accounts: [
        { id: 'default', label: '本机登录', active: true, kind: 'desktop', configured: true, credits: { state: 'ok', remain: 675, total: 1200, unit: 'credits', items: [] } },
        { id: 'acc-2', label: '备用账号', active: false, kind: 'desktop', configured: true, credits: { state: 'ok', remain: 0, total: 0, unit: 'credits' } },
      ],
      checkin: { enabled: true, lastRunAt: 1792234000000, result: { provider: 'workbuddy', claimed: 0, credit: 0, outcomes: [{ accountId: 'default', kind: 'already' }] } },
      autoSwitch: true,
      credits: { state: 'ok', remain: 675, total: 1200, unit: 'credits', resetAtMs: 1793900000000, fetchedAt: 1792234000000, items: [] },
      credential: { status: 'signed-in', uid: 'u' },
    },
    {
      provider: 'workbuddy-ai', displayName: 'WorkBuddy AI', kind: 'desktop', enabled: true,
      catalogSource: 'live', fetchedAt: 1792234000000,
      models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 48000, supportsImages: true, reasoningEfforts: ['low'], credits: 'x0.79', disabled: false }],
      credits: { state: 'ok', remain: 99, total: 100, unit: 'credits', resetAtMs: 1793500000000, items: [], fetchedAt: 1792234000000 },
      credential: { status: 'signed-in', uid: 'u2' },
    },
    {
      provider: 'qoder-global', displayName: 'Qoder Global', kind: 'pat', enabled: true,
      catalogSource: 'live', fetchedAt: 1792234000000,
      models: [{ id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 200000, maxTokens: 32768, supportsImages: true, reasoningEfforts: [], credits: 'x0', disabled: false }],
      accounts: [{ id: 'default', label: '默认令牌', active: true, kind: 'pat', configured: true, credits: { state: 'ok', remain: 0, total: 0, unit: 'credits', exceeded: true } }],
      autoSwitch: true,
      credits: { state: 'ok', remain: 0, total: 0, unit: 'credits', planName: 'Free', resetAtMs: 1794803568608, exceeded: true, items: [], fetchedAt: 1792234000000 },
      credential: { status: 'signed-in', email: 'a@b.c' },
    },
  ],
  settings: { workbuddy: {}, qoder: { qoder: { configured: false }, 'qoder-global': { configured: true } }, showRateInModelName: true },
  probe: { enabled: true, lastRunAt: 1792234000000, results: {} },
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
async function render(component, props) {
  let tree
  for (let pass = 0; pass < 6; pass++) {
    beginRender()
    tree = component(props)
    for (const effect of effects) effect()
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

// ---------- 1. 设置卡片：版本号 + 各分组都在 ----------
const cardTree = await mount(card, { t: (key) => key })
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

console.log('client-credits: OK')
