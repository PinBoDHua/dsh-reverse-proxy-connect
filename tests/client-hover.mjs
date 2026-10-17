// 悬停气泡的回归测试。
//
// 复现过的真实 bug：CreditsBubble 里写成了
//     var setVersion = versionState[0]   // 取到的是值 0
//     var bump = setVersion[1]           // (0)[1] === undefined
// 于是悬停时监听器一调用就抛 TypeError，被上线时的 try/catch 吞掉，
// 气泡永远不重渲染 —— 表现就是「鼠标悬停没有详细信息」。
//
// 关键在顺序：必须先渲染一次气泡（visible=false → null）让订阅 effect 跑起来，
// 再模拟悬停，然后断言「订阅确实把重渲染标记打上了」。
// 只测「悬停后第一次渲染」会漏掉这个 bug（当时的冒烟测试就是这么漏的）。
//
// 用法：
//   node tests/client-hover.mjs        # 正常源码，应通过
//   BUG=1 node tests/client-hover.test.mjs  # 注入旧 bug，应失败并指出订阅是坏的

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const CLIENT_PATH = new URL('../client/client.js', import.meta.url)
let source = readFileSync(CLIENT_PATH, 'utf8')

if (process.env.BUG === '1') {
  const before = source
  source = source.replace(
    '        var bump = React.useState(0)[1]',
    '        var versionState = React.useState(0)\n        var setVersion = versionState[0]\n        var bump = setVersion[1]',
  )
  if (source === before) throw new Error('注入旧 bug 失败：找不到目标行')
  console.log('（已注入旧 bug，预期失败）')
}

// ---------- 迷你 hooks ----------
let hookStates = []
let hookIndex = 0
let effects = []
let rerenderRequested = false
// 谁被要求重渲染。全局标志不够用：悬停时胶囊自己的 setHovered 也会点亮它，
// 会把「气泡订阅坏了」这件事盖住。
let ownerSeq = 0
let activeOwner = 0
let rerenderOwners = new Set()

function beginRender() {
  activeOwner = ++ownerSeq
  hookIndex = 0
  effects = []
  rerenderRequested = false
  return activeOwner
}
function useState(initial) {
  const index = hookIndex++
  if (!(index in hookStates) || hookStates[index].owner === undefined) {
    hookStates[index] = { value: typeof initial === 'function' ? initial() : initial, owner: activeOwner }
  }
  const slot = hookStates[index]
  const set = (value) => {
    const next = typeof value === 'function' ? value(slot.value) : value
    if (next !== slot.value) {
      slot.value = next
      rerenderRequested = true
      rerenderOwners.add(slot.owner)
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
      credits: { state: 'ok', remain: 0, total: 0, unit: 'credits', planName: 'Free', resetAtMs: 1794803568608, exceeded: true, items: [], fetchedAt: 1792234000000 },
      credential: { status: 'signed-in', email: 'a@b.c' },
    },
  ],
  settings: { workbuddy: {}, qoder: { qoder: { configured: false }, 'qoder-global': { configured: true } }, showRateInModelName: true },
  probe: { enabled: true, lastRunAt: 1792234000000, results: {} },
}

async function fakeFetch() {
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
  document: { createElement: () => ({}), querySelector: () => null, head: { appendChild: () => {} } },
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

// ---------- 取出组件 ----------
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

const pill = registered.find((entry) => entry.options.name === 'sidebar.footer.action')?.component
const bubble = registered.find((entry) => entry.options.name === 'shell.overlay')?.component
const card = registered.find((entry) => entry.options.name === 'plugin-settings.item')?.component
if (pill === undefined) throw new Error('没有注册 sidebar.footer.action')
if (bubble === undefined) throw new Error('没有注册 shell.overlay')
if (card === undefined) throw new Error('没有注册 plugin-settings.item')

// ---------- 设置卡片：版本号必须显示 ----------
hookStates = []
let cardTree
for (let pass = 0; pass < 6; pass++) {
  beginRender()
  cardTree = card({ t: (key) => key })
  for (const effect of effects) effect()
  await new Promise((resolve) => setTimeout(resolve, 5))
  if (!rerenderRequested) break
}
const cardText = []
;(function walkCard(node) {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') { cardText.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach(walkCard); return }
  if (typeof node === 'object') walkCard(node.children)
})(cardTree)
if (!cardText.includes('v9.9.9')) {
  throw new Error(`卡片没有显示版本号，渲染到的是：${JSON.stringify(cardText.slice(0, 8))}`)
}
console.log('✓ 卡片显示版本号 v9.9.9')

// ---------- 渲染胶囊 ----------
hookStates = []
let pillTree
for (let pass = 0; pass < 6; pass++) {
  beginRender()
  pillTree = pill({ t: (key) => key, wide: true })
  for (const effect of effects) effect()
  await new Promise((resolve) => setTimeout(resolve, 5))
  if (!rerenderRequested) break
}
const pillOwner = hookStates.length > 0 ? hookStates[0].owner : -1

// ---------- 先挂载气泡（应为 null） ----------
hookStates = []
rerenderOwners = new Set()
beginRender()
const bubbleOwner = activeOwner
const beforeHover = bubble({ t: (key) => key })
for (const effect of effects) effect()
if (beforeHover !== null) throw new Error('未悬停时气泡应返回 null')
console.log('✓ 未悬停时气泡不渲染')

// ---------- 悬停 ----------
let button
;(function find(node) {
  if (button !== undefined || node === null || node === undefined) return
  if (Array.isArray(node)) { node.forEach(find); return }
  if (typeof node === 'object' && node.type === 'button' && node.props?.onMouseEnter) { button = node; return }
  if (typeof node === 'object') find(node.children)
})(pillTree)
if (button === undefined) throw new Error('胶囊上没有 onMouseEnter')

// 警示色只该落在「真低」的那个账号上：Qoder Global 是 0，
// WorkBuddy 675/1200、WorkBuddy AI 99/100 都不该变警示色。
const warned = []
;(function findWarn(node) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { node.forEach(findWarn); return }
  if (typeof node !== 'object') return
  const color = node.props?.style?.color
  if (typeof color === 'string' && color.includes('state-warning')) {
    const text = []
    ;(function collect(child) {
      if (typeof child === 'string' || typeof child === 'number') { text.push(String(child)); return }
      if (Array.isArray(child)) { child.forEach(collect); return }
      if (child && typeof child === 'object') collect(child.children)
    })(node.children)
    warned.push(text.join(''))
  }
  findWarn(node.children)
})(pillTree)
if (!warned.includes('0')) throw new Error(`余额 0 的账号没有变警示色，命中：${JSON.stringify(warned)}`)
if (warned.some((text) => text.includes('675') || text.includes('99'))) {
  throw new Error(`不该警示的账号变红了：${JSON.stringify(warned)}`)
}
console.log('✓ 只有余额为 0 的账号亮警示色')

button.props.onMouseEnter({
  currentTarget: { getBoundingClientRect: () => ({ left: 12, top: 700, right: 150, bottom: 724, width: 138 }) },
})

// 关键断言：必须是**气泡自己**被要求重渲染。
// 只看全局标志会把「胶囊的 setHovered 点亮了它」误判成通过 —— 那正是漏掉此 bug 的原因。
if (!rerenderOwners.has(bubbleOwner)) {
  throw new Error('悬停后气泡没有收到重渲染通知 —— bump 取错了（应该是 useState 的第二个元素）')
}
if (!rerenderOwners.has(pillOwner)) throw new Error('胶囊自身没有重渲染（悬停高亮失效）')
console.log('✓ 悬停触发了气泡重渲染')

// ---------- 渲染气泡 ----------
let bubbleTree
for (let pass = 0; pass < 4; pass++) {
  beginRender()
  bubbleTree = bubble({ t: (key) => key })
  for (const effect of effects) effect()
  await new Promise((resolve) => setTimeout(resolve, 2))
  if (!rerenderRequested) break
}
if (bubbleTree === null || bubbleTree === undefined) throw new Error('气泡没有渲染')
// 气泡里有可点的按钮，语义上是 dialog 而不是 tooltip。
if (bubbleTree.props?.role !== 'dialog') throw new Error('气泡缺少 role=dialog')

const text = []
;(function walk(node) {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (typeof node === 'object') walk(node.children)
})(bubbleTree)

const joined = text.join(' ')
for (const needle of ['WorkBuddy', '675', 'Qoder Global', 'Free', 'WorkBuddy AI', '99', 'pillHint']) {
  if (!joined.includes(needle)) throw new Error(`气泡缺少内容：${needle}`)
}
const bars = []
;(function countBars(node) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { node.forEach(countBars); return }
  // 进度条：细长、带圆角与半透明底。按「厚度在 2–6px」认，别写死具体值 ——
  // 调视觉时（3px → 4px）不该让测试无故变红。
  const style = node.props?.style
  if (typeof node === 'object' && style && typeof style.height === 'number' && style.height >= 2 && style.height <= 6 && style.borderRadius === 999) bars.push(node)
  if (typeof node === 'object') countBars(node.children)
})(bubbleTree)
if (bars.length < 2) throw new Error(`额度进度条数量不对：${bars.length}`)

console.log('气泡文本:', JSON.stringify(joined))
console.log(`✓ 气泡显示 3 个账号、${bars.length} 条进度条与提示`)

// ---------- 胶囊宽度：必须是 border-box ----------
// 曾经的 bug：默认 content-box，padding 把宽度撑出侧栏，胶囊往左溢出。
const pillBox = button.props?.style?.boxSizing
if (pillBox !== 'border-box') throw new Error(`胶囊缺少 boxSizing:border-box（实际 ${String(pillBox)}），会在侧栏里横向溢出`)
console.log('✓ 胶囊用 border-box，不会撑出侧栏')

// ---------- 气泡可交互 ----------
// 曾经的 bug：pointerEvents:none + 立即关闭，鼠标一离开胶囊气泡就消失，
// 里面的按钮根本点不到。
if (bubbleTree.props?.style?.pointerEvents !== 'auto') throw new Error('气泡不可交互（pointerEvents 不是 auto）')
if (typeof bubbleTree.props?.onMouseEnter !== 'function') throw new Error('气泡没有 onMouseEnter，移进去就会关掉')

const refreshButton = (() => {
  let found
  ;(function find(node) {
    if (found !== undefined || node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach(find); return }
    if (typeof node === 'object' && node.type === 'button' && typeof node.props?.onClick === 'function') { found = node; return }
    if (typeof node === 'object') find(node.children)
  })(bubbleTree)
  return found
})()
if (refreshButton === undefined) throw new Error('气泡里没有可点击的刷新按钮')

const label = []
;(function collect(node) {
  if (typeof node === 'string' || typeof node === 'number') { label.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach(collect); return }
  if (node && typeof node === 'object') collect(node.children)
})(refreshButton.children)
if (!label.join('').includes('creditsRefresh')) throw new Error(`刷新按钮文案不对：${JSON.stringify(label)}`)
console.log('✓ 气泡可交互，且带着可点的刷新按钮')

// ---------- 延迟关闭：鼠标能挪进气泡 ----------
button.props.onMouseLeave()          // 离开胶囊 → 安排 160ms 后关闭
bubbleTree.props.onMouseEnter()      // 进入气泡 → 取消关闭
await new Promise((resolve) => setTimeout(resolve, 240))
beginRender()
const stillVisible = bubble({ t: (key) => key })
if (stillVisible === null || stillVisible === undefined) {
  throw new Error('鼠标移进气泡后气泡仍被关闭了 —— 延迟关闭没生效，用户点不到按钮')
}
console.log('✓ 鼠标可以从胶囊移进气泡而不被关掉')

// ---------- 但真的离开后仍会关闭 ----------
stillVisible.props.onMouseLeave()
await new Promise((resolve) => setTimeout(resolve, 240))
beginRender()
const afterLeave = bubble({ t: (key) => key })
if (afterLeave !== null) throw new Error('鼠标离开后气泡没有关闭，会一直挡在界面上')
console.log('✓ 真正离开后气泡会自行关闭')

console.log('client-hover: OK')
