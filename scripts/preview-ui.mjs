// 生成连接器设置的静态 HTML 预览，用无头 Chrome 截图做视觉回归。
//
// 用法：
//   node scripts/preview-ui.mjs [输出目录]
// 输出：每个变体一个 .html（自带插件主题 CSS + 宿主 token 近似值）。
//
// 这不是测试，不参与 npm test；只服务于「改 UI 时能真的看到画面」。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(process.argv[2] || join(ROOT, '.preview'))
const source = readFileSync(join(ROOT, 'client/client.js'), 'utf8')

// ── 迷你 React（与 tests/client-credits.mjs 同构，去掉断言） ────────────
let hookStates = []
let hookIndex = 0
let refSlots = {}
let refIndex = 0
let effects = []
let dirty = false

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function beginRender() {
  hookIndex = 0
  refIndex = 0
  effects = []
  dirty = false
}

function useState(initial) {
  const index = hookIndex++
  if (!(index in hookStates)) hookStates[index] = { value: typeof initial === 'function' ? initial() : initial }
  const slot = hookStates[index]
  const set = (value) => {
    const next = typeof value === 'function' ? value(slot.value) : value
    if (next !== slot.value) {
      slot.value = next
      dirty = true
    }
  }
  return [slot.value, set]
}

function useRef(initial) {
  const index = refIndex++
  if (!(index in refSlots)) refSlots[index] = { current: initial }
  return refSlots[index]
}

function createElement(type, props, ...children) {
  const raw = props ?? {}
  const key = raw.key
  const cleaned = { ...raw }
  delete cleaned.key
  return { type, key, props: cleaned, children: children.flat(Infinity) }
}

const React = {
  createElement,
  Fragment: 'Fragment',
  useState,
  useEffect: (fn) => { effects.push(fn) },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef,
}

// ── 载入 bundle ────────────────────────────────────────────────────────
const capturedStyles = []
const styleById = new Map()
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: (fn) => { fn(); return 0 },
  fetch: async () => ({
    ok: true,
    status: 200,
    json: async () => STATUS,
    text: async () => JSON.stringify({ ok: true, diagnostics: 'audit' }),
  }),
  navigator: { clipboard: undefined },
  document: {
    visibilityState: 'visible',
    createElement: (tag) => ({ tagName: tag, id: '', textContent: '', children: [], appendChild(child) { this.children.push(child) } }),
    getElementById: (id) => styleById.get(id) ?? null,
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    head: {
      appendChild: (element) => {
        if (element && element.id) styleById.set(element.id, element)
        capturedStyles.push(element.textContent || '')
      },
    },
  },
}
let captured
sandbox.window = {
  innerWidth: 1280,
  innerHeight: 900,
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
let locale
const ctx = {
  slots: {
    register(options, component) { registered.push({ options, component }); return () => {} },
    inject(name, callback) { callback() },
    entries() { return [] },
  },
  locale: {
    register: (namespace, value) => { locale = value; return () => {} },
    bind: () => (key) => key,
  },
  effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  inject: (names, cb) => cb(ctx),
}
captured.apply(ctx)

const t = (key, params) => {
  let text = locale && locale.zh && locale.zh[key] !== undefined ? locale.zh[key] : key
  if (params !== undefined && typeof text === 'string') {
    text = text.replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])))
  }
  return text
}

const card = registered.find((entry) => entry.options.name === 'plugin-settings.item')?.component
if (card === undefined) throw new Error('没有注册 plugin-settings.item')

// ── 渲染 ───────────────────────────────────────────────────────────────
async function render(props) {
  let tree
  for (let pass = 0; pass < 8; pass++) {
    beginRender()
    tree = card(props)
    for (const effect of effects) effect()
    await sleep(2)
    if (!dirty) break
  }
  return tree
}

function mount(props) {
  hookStates = []
  refSlots = {}
  return render(props)
}

function walk(tree, visit) {
  if (tree === null || tree === undefined) return
  if (Array.isArray(tree)) { tree.forEach((child) => walk(child, visit)); return }
  if (typeof tree !== 'object') return
  visit(tree)
  walk(tree.children, visit)
}

function textOf(tree) {
  const out = []
  walk(tree, (node) => {})
  ;(function collect(node) {
    if (node === null || node === undefined) return
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (typeof node === 'object') collect(node.children)
  })(tree)
  return out.join(' ')
}

function findButton(tree, label, className) {
  let found
  walk(tree, (node) => {
    if (found !== undefined || node.type !== 'button') return
    if (className !== undefined && !String(node.props?.className || '').includes(className)) return
    const text = textOf(node)
    if (text.includes(label)) found = node
  })
  return found
}

/** 点一下某个按钮（模拟事件），再渲染到稳定。 */
async function click(props, label) {
  const tree = await render(props)
  const button = findButton(tree, label, 'rpc-pagetab')
  if (button === undefined) throw new Error('找不到按钮：' + label)
  button.props.onClick({ preventDefault() {}, stopPropagation() {} })
  return render(props)
}

// ── HTML 序列化 ────────────────────────────────────────────────────────
const VOID = new Set(['br', 'hr', 'img', 'input', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'source'])
const UNITLESS = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order', 'zoom', 'strokeWidth', 'columnCount', 'aspectRatio'])
const SVG_ATTR = {
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeDasharray: 'stroke-dasharray',
  fillRule: 'fill-rule',
  clipRule: 'clip-rule',
  viewBox: 'viewBox',
  focusable: 'focusable',
}
const ATTR = { className: 'class', htmlFor: 'for', tabIndex: 'tabindex', maxLength: 'maxlength' }

function esc(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]))
}

function kebab(name) {
  return name.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase())
}

function styleText(style) {
  if (style === null || typeof style !== 'object') return ''
  const parts = []
  for (const [name, value] of Object.entries(style)) {
    if (value === undefined || value === null || value === '') continue
    if (typeof value === 'number' && !name.startsWith('--') && !UNITLESS.has(name)) {
      parts.push(`${kebab(name)}:${value}px`)
    } else {
      parts.push(`${name.startsWith('--') ? name : kebab(name)}:${value}`)
    }
  }
  return parts.join(';')
}

function attrsOf(node) {
  const out = {}
  for (const [name, value] of Object.entries(node.props || {})) {
    if (value === null || value === undefined || value === false) continue
    if (name === 'style' || name === 'key' || name === 'ref' || name === 'children') continue
    if (/^on[A-Z]/.test(name)) continue
    out[name] = value
  }
  return out
}

function serialize(node, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map((child) => serialize(child, depth)).join('')
  if (typeof node !== 'object') return ''

  if (typeof node.type === 'function') return serialize(node.type({ ...node.props, children: node.children }), depth)
  if (node.type === 'Fragment') return node.children.map((child) => serialize(child, depth)).join('')

  const tag = String(node.type)
  const props = attrsOf(node)
  const parts = []
  for (const [name, value] of Object.entries(props)) {
    if (name === 'style') continue
    const attr = ATTR[name] || SVG_ATTR[name] || name
    if (value === true) parts.push(attr)
    else if (name === 'value' || name === 'checked') parts.push(`${attr}="${esc(value)}"`)
    else parts.push(`${attr}="${esc(value)}"`)
  }
  const style = styleText(node.props?.style)
  if (style !== '') parts.push(`style="${esc(style)}"`)
  const open = `<${tag}${parts.length > 0 ? ' ' + parts.join(' ') : ''}>`
  if (VOID.has(tag)) return `<${tag}${parts.length > 0 ? ' ' + parts.join(' ') : ''} />`
  return open + node.children.map((child) => serialize(child, depth + 1)).join('') + `</${tag}>`
}

// ── 预览外壳 ───────────────────────────────────────────────────────────
const HOST_TOKENS = `
:root{
  --dsw-alias-bg-base:#ffffff;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-l2:#f7f8fa;
  --dsw-alias-bg-layer-2:#ffffff;--dsw-alias-bg-layer-3:#f2f3f5;
  --dsw-alias-border-l2:rgba(0,0,0,.08);--dsw-alias-border-l3:rgba(0,0,0,.12);
  --dsw-alias-label-primary:#1d2129;--dsw-alias-label-secondary:#4e5969;
  --dsw-alias-label-tertiary:#86909c;--dsw-alias-label-caption:#86909c;
  --dsw-alias-state-error-primary:#d92d20;--dsw-alias-state-success-primary:#12a150;
  --dsw-alias-state-business-primary:#2154ce;--dsw-alias-state-warning-primary:#d97706;
  --dsw-alias-link:#2154ce;
}
`

function page(bodyHtml, { width = 1240, dark = false, title = 'preview' } = {}) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
${HOST_TOKENS}
html,body{margin:0;padding:0;background:${dark ? '#17181c' : '#ffffff'};}
body{font-family:"Segoe UI","Microsoft YaHei",-apple-system,BlinkMacSystemFont,sans-serif;
  color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased;}
#stage{width:${width}px;padding:22px 24px 28px;box-sizing:border-box;margin:0 auto;}
button{font-family:inherit}
${dark ? ':root{--dsw-alias-bg-base:#17181c;--dsw-alias-bg-layer-1:#1e1f24;--dsw-alias-bg-l2:#24262c;--dsw-alias-label-primary:#ebeef2;--dsw-alias-label-secondary:#cfd3d6;--dsw-alias-label-tertiary:#adb2b8;--dsw-alias-label-caption:#adb2b8;--dsw-alias-border-l2:rgba(255,255,255,.12);--dsw-alias-border-l3:rgba(255,255,255,.18);}' : ''}
</style>
<style>${capturedStyles.join('\n')}</style>
</head><body><div id="stage">${bodyHtml}</div></body></html>`
}

// ── 假 /status：贴近截图里的真实数据 ───────────────────────────────────
const NOW = Date.parse('2026-10-19T23:01:48+08:00')
const points = (base, count) => Array.from({ length: count }, (_, index) => ({ at: NOW - (count - 1 - index) * 600000, remain: Math.max(0, base - index * 3) }))

function provider(overrides) {
  return {
    enabled: true,
    kind: 'desktop',
    catalogSource: 'live',
    fetchedAt: NOW - 180000,
    health: { state: 'ok', consecutiveFailures: 0, lastErrorAt: 0, lastSuccessAt: NOW - 60000 },
    usage: { requests: 1013, ok: 1001, failed: 12, totalTokens: 1820034, avgDurationMs: 2400, successRate: 0.988,
      today: { requests: 1013, totalTokens: 18200 },
      last: { at: NOW - 60000, accountId: 'default', model: 'deepseek-v4.1-flash', kind: 'stop', durationMs: 1200, totalTokens: 120 } },
    models: [],
    modelCount: 19,
    ...overrides,
  }
}

const STATUS = {
  version: 8,
  key: 'preview',
  plugin: { name: 'dsh-reverse-proxy-connect', version: '0.6.0', host: 'in-process', api: 8, node: '24.0.0' },
  host: { images: true, stats: true, catalogCache: true },
  probe: { enabled: true, lastRunAt: NOW - 300000, results: {} },
  settings: {
    showRateInModelName: true,
    showUsageInSidebar: true,
    autoSwitch: { enabled: true, thresholdRatio: 0.05 },
    alerts: { enabled: true, lowRatio: 0.15 },
    checkin: true,
    probe: true,
    advanced: { idleTimeoutMs: 180000, catalogRefreshMs: 600000, creditsRefreshMs: 120000, stats: true, catalogCache: true },
  },
  providers: [
    provider({
      provider: 'workbuddy', displayName: 'WorkBuddy',
      credential: { status: 'signed-in', uid: 'u-1', source: 'desktop', message: '' },
      credits: { state: 'ok', remain: 735, total: 1300, unit: 'credits', planName: 'Pro', resetAtMs: NOW + 86400000, fetchedAt: NOW, items: [], trend: { sampleCount: 42, spentToday: 64, spent7d: 320, burnPerHour: 12, etaMs: 52 * 3600000, points: points(760, 24) } },
      accounts: [
        { id: 'default', label: '本机登录', active: true, kind: 'desktop', configured: true, source: 'desktop',
          usage: { requests: 911, totalTokens: 303700000, lastAt: NOW - 2 * 3600000 },
          credits: { state: 'ok', remain: 735, total: 1300, unit: 'credits', resetAtMs: NOW + 86400000, trend: { sampleCount: 42, spentToday: 64, points: points(760, 24) } } },
        { id: 'acc-2', label: '风雪', active: false, kind: 'desktop', configured: true, source: 'browser-login',
          usage: { requests: 1336, totalTokens: 401100000 },
          credits: { state: 'ok', remain: 2336, total: 6700, unit: 'credits', resetAtMs: NOW + 11 * 86400000 }, cooldownUntil: NOW + 45000, lastTest: { ok: false, latencyMs: 380, error: 'HTTP 429' } },
      ],
      checkin: { enabled: true, lastRunAt: NOW - 4 * 3600000, result: { provider: 'workbuddy', claimed: 2, credit: 200, outcomes: [{ accountId: 'default', kind: 'claimed', credit: 100 }, { accountId: 'acc-2', kind: 'claimed', credit: 100 }] } },
      models: [
        { id: 'deepseek-v4', name: 'DeepSeek-V4', contextWindow: 256000, maxTokens: 32000, supportsImages: true, reasoningEfforts: ['low', 'high'], credits: 'x1', disabled: false },
        { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 48000, supportsImages: true, reasoningEfforts: [], credits: 'x0.79', disabled: false },
        { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 200000, maxTokens: 16384, supportsImages: false, reasoningEfforts: [], credits: 'x1.2', disabled: true },
      ],
      autoSwitch: true,
      usage: { requests: 1013, ok: 1001, failed: 12, totalTokens: 1820034, avgDurationMs: 2400, successRate: 0.988, today: { requests: 1013, totalTokens: 18200 }, last: { at: NOW - 60000, accountId: 'default', model: 'deepseek-v4.1-flash', kind: 'stop', durationMs: 1200, totalTokens: 120 } },
    }),
    provider({
      provider: 'workbuddy-ai', displayName: 'WorkBuddy AI', enabled: true,
      credential: { status: 'signed-in', uid: 'u-2', source: 'desktop' },
      credits: { state: 'ok', remain: 52, total: 1300, unit: 'credits', planName: 'Pro', resetAtMs: NOW + 86400000, fetchedAt: NOW, items: [], trend: { sampleCount: 18, spentToday: 12, burnPerHour: 2, etaMs: 26 * 3600000, points: points(60, 20) } },
      modelCount: 27, models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 48000, supportsImages: true, reasoningEfforts: [] }],
      accounts: [{ id: 'default', label: '本机登录', active: true, kind: 'desktop', configured: true, source: 'desktop', credits: { state: 'ok', remain: 52, total: 1300, unit: 'credits' } }],
      health: { state: 'ok', consecutiveFailures: 0, lastErrorAt: 0, lastSuccessAt: NOW - 900000 },
    }),
    provider({
      provider: 'qoder', displayName: 'Qoder', kind: 'pat', enabled: true,
      credential: { status: 'none' },
      credits: { state: 'none' },
      modelCount: 2, models: [], accounts: [],
      health: { state: 'unknown', consecutiveFailures: 0 },
      usage: { requests: 0, ok: 0, failed: 0, totalTokens: 0, avgDurationMs: 0 },
    }),
    provider({
      provider: 'qoder-global', displayName: 'Qoder Global', kind: 'pat', enabled: true,
      credential: { status: 'signed-in', email: 'dev@example.com' },
      credits: { state: 'ok', remain: 0, total: 0, unit: 'credits', planName: 'Free', exceeded: true, resetAtMs: NOW + 12 * 3600000, fetchedAt: NOW, items: [] },
      modelCount: 1, models: [{ id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 200000, maxTokens: 32768, supportsImages: true, reasoningEfforts: [] }],
      accounts: [{ id: 'default', label: '默认令牌', active: true, kind: 'pat', configured: true, source: 'pat', credits: { state: 'ok', remain: 0, total: 0, unit: 'credits', exceeded: true } }],
      health: { state: 'degraded', consecutiveFailures: 1, lastErrorAt: NOW - 1200000 },
    }),
    provider({
      provider: 'trae', displayName: 'Trae', kind: 'pat', enabled: true,
      credential: { status: 'signed-in', email: 'dev@example.com' },
      credits: { state: 'ok', remain: 192.6, total: 300, unit: 'credits', planName: 'Pro', resetAtMs: NOW + 6 * 86400000, fetchedAt: NOW, items: [], trend: { sampleCount: 30, spentToday: 42, burnPerHour: 1.8, etaMs: 106 * 3600000, points: points(200, 20) } },
      modelCount: 21, models: [{ id: 'trae-sonnet', name: 'Claude-Sonnet-4.5', contextWindow: 200000, maxTokens: 64000, supportsImages: true, reasoningEfforts: [] }],
      accounts: [{ id: 'default', label: '默认令牌', active: true, kind: 'pat', configured: true, source: 'pat', credits: { state: 'ok', remain: 192.6, total: 300, unit: 'credits' } }],
      health: { state: 'stale', consecutiveFailures: 3, lastErrorAt: NOW - 26 * 3600000, lastSuccessAt: NOW - 30 * 3600000 },
    }),
    provider({
      provider: 'trae-global', displayName: 'Trae Global', kind: 'pat', enabled: false,
      credential: { status: 'none' },
      credits: { state: 'none' },
      modelCount: 2, models: [], accounts: [],
      health: { state: 'unknown', consecutiveFailures: 0 },
    }),
  ],
  events: {
    version: 1, count: 4, latestAt: NOW, limit: 50,
    items: [
      { id: 'ev-1', at: NOW - 60000, type: 'account-switch', level: 'warn', provider: 'workbuddy', message: '账号「本机登录」请求失败（RATE_LIMIT），切换到「浏览器登录 · 备用」', data: { from: 'default', to: 'acc-2', reason: 'RATE_LIMIT' } },
      { id: 'ev-2', at: NOW - 900000, type: 'credential-refresh', level: 'info', provider: 'workbuddy', message: '登录令牌已自动续期（本机登录）' },
      { id: 'ev-3', at: NOW - 1800000, type: 'checkin', level: 'info', provider: 'workbuddy', message: '签到成功：2 个账号，+200 积分' },
      { id: 'ev-4', at: NOW - 3600000, type: 'credits', level: 'warn', provider: 'qoder-global', message: '额度读取失败（默认令牌）：HTTP 503' },
    ],
  },
  stats: {
    enabled: true, since: NOW - 7 * 86400000,
    totals: { requests: 1013, ok: 1001, failed: 12, totalTokens: 1820034, avgDurationMs: 2400, successRate: 0.988 },
    today: { requests: 1013, totalTokens: 18200, date: '2026-10-19' },
    providers: { workbuddy: { requests: 900, ok: 890, failed: 10, totalTokens: 1600000, avgDurationMs: 2400, successRate: 0.988 } },
    providerToday: { workbuddy: { requests: 900, totalTokens: 16000, date: '2026-10-19' } },
    accounts: { 'workbuddy::default': { requests: 800, totalTokens: 1400000, avgDurationMs: 2100 } },
    models: {
      'workbuddy::deepseek-v4.1-flash': { requests: 2246, totalTokens: 704773415, avgDurationMs: 6900 },
      'workbuddy::hy3': { requests: 1, totalTokens: 109, avgDurationMs: 1400 },
    },
    accountModels: {
      'workbuddy::default::deepseek-v4.1-flash': { provider: 'workbuddy', accountId: 'default', model: 'deepseek-v4.1-flash', requests: 1500, totalTokens: 400000000, avgDurationMs: 9800 },
      'workbuddy::acc-2::deepseek-v4.1-flash': { provider: 'workbuddy', accountId: 'acc-2', model: 'deepseek-v4.1-flash', requests: 500, totalTokens: 150000000, avgDurationMs: 6000 },
    },
    accountModelToday: {
      'workbuddy::default::deepseek-v4.1-flash': { provider: 'workbuddy', accountId: 'default', model: 'deepseek-v4.1-flash', requests: 744, totalTokens: 200794754, avgDurationMs: 10500 },
      'workbuddy::acc-2::deepseek-v4.1-flash': { provider: 'workbuddy', accountId: 'acc-2', model: 'deepseek-v4.1-flash', requests: 269, totalTokens: 103725914, avgDurationMs: 5900 },
    },
    daily: [
      { date: '2026-10-13', requests: 88, totalTokens: 120000 },
      { date: '2026-10-14', requests: 102, totalTokens: 140000 },
      { date: '2026-10-15', requests: 96, totalTokens: 132000 },
      { date: '2026-10-16', requests: 121, totalTokens: 168000 },
      { date: '2026-10-17', requests: 143, totalTokens: 190000 },
      { date: '2026-10-18', requests: 133, totalTokens: 176000 },
      { date: '2026-10-19', requests: 120, totalTokens: 160000 },
    ],
    providerDaily: {
      workbuddy: [
        { date: '2026-10-18', requests: 120, totalTokens: 160000 },
        { date: '2026-10-19', requests: 110, totalTokens: 150000 },
      ],
    },
    currentSession: { id: 's-global', requests: 24, totalTokens: 68000, avgDurationMs: 2300, successRate: 1 },
    providerCurrentSession: { workbuddy: { id: 's-1', requests: 18, totalTokens: 52000, avgDurationMs: 2200, successRate: 1 } },
    health: { workbuddy: { state: 'ok' } },
    recent: [
      { at: NOW - 60000, provider: 'workbuddy', accountId: 'default', model: 'deepseek-v4.1-flash', kind: 'stop', durationMs: 1200, totalTokens: 120 },
      { at: NOW - 300000, provider: 'workbuddy', accountId: 'default', model: 'deepseek-v4.1-flash', kind: 'error', code: 'RATE_LIMIT', durationMs: 300, totalTokens: 0, message: 'HTTP 429 Too Many Requests' },
    ],
  },
}

// ── 变体 ───────────────────────────────────────────────────────────────
const props = { t }
mkdirSync(OUT, { recursive: true })

const variants = [
  { name: 'overview', provider: 'workbuddy', page: '概览' },
  { name: 'accounts', provider: 'workbuddy', page: '账号' },
  { name: 'usage', provider: 'workbuddy', page: '用量' },
  { name: 'models', provider: 'workbuddy', page: '模型' },
  { name: 'settings', provider: 'workbuddy', page: '设置' },
  { name: 'activity', provider: 'workbuddy', page: '动态' },
  { name: 'qoder-global-overview', provider: 'qoder-global', page: '概览' },
  { name: 'trae-overview', provider: 'trae', page: '概览' },
  { name: 'overview-narrow', provider: 'workbuddy', page: '概览', width: 620 },
  // 设置弹窗里的实际容器宽度约 470–500px：这两组变体专门盯窄屏表格。
  { name: 'accounts-narrow', provider: 'workbuddy', page: '账号', width: 530 },
  { name: 'usage-narrow', provider: 'workbuddy', page: '用量', width: 530 },
  { name: 'accounts-mid', provider: 'workbuddy', page: '账号', width: 780 },
  { name: 'usage-mid', provider: 'workbuddy', page: '用量', width: 780 },
  { name: 'accounts-narrow-dark', provider: 'workbuddy', page: '账号', width: 530, dark: true },
  { name: 'usage-narrow-dark', provider: 'workbuddy', page: '用量', width: 530, dark: true },
  { name: 'overview-dark', provider: 'workbuddy', page: '概览', dark: true },
]

for (const variant of variants) {
  hookStates = []
  refSlots = {}
  const tree = await mount({ ...props, initialProvider: variant.provider })
  let current = tree
  if (variant.page !== '概览') current = await click({ ...props, initialProvider: variant.provider }, variant.page)
  writeFileSync(join(OUT, variant.name + '.html'), page(serialize(current), {
    title: variant.name,
    width: variant.width,
    dark: variant.dark === true,
  }))
  console.log('写好了', variant.name + '.html')
}

// 首屏加载态 / 错误态
{
  hookStates = []
  refSlots = {}
  const originalFetch = sandbox.fetch
  sandbox.fetch = () => new Promise(() => {})
  const loading = await mount(props)
  writeFileSync(join(OUT, 'loading.html'), page(serialize(loading), { title: 'loading' }))
  sandbox.fetch = originalFetch
  console.log('写好了 loading.html')
}
{
  hookStates = []
  refSlots = {}
  const originalFetch = sandbox.fetch
  sandbox.fetch = async () => { throw new Error('fetch failed: ECONNREFUSED') }
  const failed = await mount(props)
  writeFileSync(join(OUT, 'error.html'), page(serialize(failed), { title: 'error' }))
  sandbox.fetch = originalFetch
  console.log('写好了 error.html')
}

console.log('全部写到', OUT)
