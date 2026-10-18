import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDiagnostics, redactPath, redactStatus, renderDiagnosticsText } from '../lib/diagnostics.js'

const STATUS = {
  version: 5,
  key: 'super-secret-control-key',
  plugin: { name: 'dsh-reverse-proxy-connect', version: '1.1.0', host: 'in-process', api: 5, node: '24.0.0' },
  host: { images: true, stats: true, catalogCache: true },
  providers: [{
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    enabled: true,
    catalogSource: 'live',
    modelCount: 18,
    credential: {
      status: 'signed-out',
      reason: 'no-credential',
      message: '没有找到登录文件：C:\\Users\\张三\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info',
      file: 'C:\\Users\\张三\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info',
      patTail: 'abcd',
    },
    health: { state: 'degraded' },
    credits: { state: 'ok', remain: 10, total: 100, unit: 'credits', planName: 'Free', stale: false, trend: { spentToday: 5, spent7d: 20, burnPerHour: 2, etaMs: 300000 } },
    accounts: [{ id: 'a', label: '本机登录', active: true, source: 'desktop', cooldownUntil: 0, lastTest: { ok: true, latencyMs: 120 } }],
    checkin: { enabled: true, completedToday: true, lastRunAt: 1, result: { claimed: 1 } },
  }],
  stats: {
    enabled: true,
    since: 1,
    today: { requests: 2, totalTokens: 20 },
    totals: { requests: 5, totalTokens: 50 },
    currentSession: { requests: 1, totalTokens: 10 },
    health: { workbuddy: { state: 'ok' } },
  },
  settings: {
    showRateInModelName: true,
    showUsageInSidebar: true,
    autoSwitch: { enabled: true, thresholdRatio: 0.1 },
    alerts: { enabled: true, lowRatio: 0.15 },
    checkin: true,
    probe: true,
    advanced: { idleTimeoutMs: 180000 },
    workbuddy: { workbuddy: { authFile: 'C:\\Users\\张三\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info' } },
  },
}

test('诊断：合法共享引用不会被误写成 [circular]', () => {
  const shared = { state: 'ok', consecutiveFailures: 0 }
  const status = {
    ...STATUS,
    providers: [{ ...STATUS.providers[0], health: shared }],
    stats: { ...STATUS.stats, health: { workbuddy: shared } },
  }
  const safe = redactStatus(status)
  assert.equal(safe.providers[0].health.state, 'ok')
  assert.equal(safe.stats.health.workbuddy.state, 'ok', '共享对象第二次出现仍应完整')
  assert.ok(!JSON.stringify(safe).includes('[circular]'))

  // 真正的环仍然要截断，避免生成 JSON 时无限递归。
  const loop = { name: 'loop' }
  loop.self = loop
  assert.equal(redactStatus(loop).self, '[circular]')
})

test('诊断：控制密钥、令牌字段与绝对用户路径都不出现', () => {
  const safe = redactStatus(STATUS)
  assert.equal(safe.key, '[redacted]')
  assert.equal(safe.providers[0].credential.file, '%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info')
  assert.ok(!JSON.stringify(safe).includes('super-secret-control-key'))
  assert.ok(!JSON.stringify(safe).includes('张三'))
  assert.ok(!JSON.stringify(safe).includes('C:\\Users'))
})

test('诊断：文本包含可排障信息但没有密钥', () => {
  const { document, text } = buildDiagnostics(STATUS, { now: 1_800_000_000_000 })
  assert.equal(document.plugin.version, '1.1.0')
  assert.equal(document.providers[0].credits.trend.etaMs, 300000)
  assert.ok(text.includes('[workbuddy]'))
  assert.ok(text.includes('今日消耗'))
  assert.ok(text.includes('当前会话'))
  assert.ok(!text.includes('super-secret-control-key'))
  assert.ok(!text.includes('张三'))
  assert.equal(renderDiagnosticsText(document), text)
})

test('诊断：路径缩写覆盖 APPDATA / home / 其他用户目录', () => {
  const text = redactPath('C:\\Users\\李\\AppData\\Roaming\\x /home/alice/y C:\\Users\\bob\\z')
  assert.ok(!text.includes('李'))
  assert.ok(!text.includes('C:\\Users\\bob'))
  assert.ok(text.includes('%APPDATA%'))
  assert.ok(text.includes('~'))
})

test('诊断：不限量账号显示「不限量」，不是 0 / 0', () => {
  const unlimited = {
    ...STATUS,
    providers: [{
      ...STATUS.providers[0],
      credits: { state: 'ok', remain: 0, total: 0, unit: 'credits', unlimited: true },
    }],
  }
  const { text } = buildDiagnostics(unlimited)
  assert.ok(text.includes('不限量'))
  assert.ok(!text.includes('0 / 0'))
})

test('诊断：事件账本带最近事件，路径与令牌字段都脱敏', () => {
  const withEvents = {
    ...STATUS,
    events: {
      count: 2,
      latestAt: 1_800_000_000_000,
      items: [
        {
          id: 'e1',
          at: 1_800_000_000_000,
          type: 'credits',
          level: 'warn',
          provider: 'qoder',
          message: '额度读取失败：C:\\Users\\张三\\AppData\\Local\\x',
          data: { token: 'pat-super-secret', account: '默认' },
        },
      ],
    },
  }
  const { document, text } = buildDiagnostics(withEvents)
  assert.equal(document.events.items.length, 1)
  assert.equal(document.events.items[0].data.token, '[redacted]')
  assert.ok(!document.events.items[0].message.includes('张三'))
  assert.ok(text.includes('最近事件'))
  assert.ok(text.includes('[warn]'))
  assert.ok(!text.includes('pat-super-secret'))
  assert.ok(!text.includes('张三'))
})

test('诊断：坏输入不抛错', () => {
  assert.equal(redactStatus(null), null)
  const { text } = buildDiagnostics({})
  assert.ok(typeof text === 'string' && text.includes('dsh-reverse-proxy-connect'))
})

test('诊断：「没读到」与「读失败」都不冒充 0 / 0 credits', () => {
  const base = STATUS.providers[0]
  const none = {
    ...STATUS,
    providers: [{
      ...base,
      provider: 'trae-global',
      credits: { state: 'none', remain: 0, total: 0, unit: 'credits', items: [], fetchedAt: 0, error: 'Trae 国际版没有提供额度查询接口' },
    }],
  }
  const noneText = buildDiagnostics(none).text
  assert.ok(noneText.includes('未读取'), '没有额度端点时应写「未读取」并带原因')
  assert.ok(noneText.includes('没有提供额度查询接口'))
  assert.ok(!noneText.includes('0 / 0'), '不能把占位的 0 当成余额打印')
  // 读失败时不该再打一行「今日消耗 0 / 近 7 天 0」的噪音。
  assert.ok(!noneText.includes('今日消耗'), '没有快照时不打印趋势行')

  const failed = {
    ...STATUS,
    providers: [{ ...base, credits: { state: 'error', remain: 0, total: 0, unit: 'credits', items: [], fetchedAt: Date.now(), error: 'HTTP 503' } }],
  }
  const failedText = buildDiagnostics(failed).text
  assert.ok(failedText.includes('读取失败'))
  assert.ok(failedText.includes('HTTP 503'))
  assert.ok(!failedText.includes('0 / 0'))
})

test('诊断：耗尽预估用人类可读时长，不再摊成六位数分钟', () => {
  // 252 天：旧实现会打印「预计可用: 363476 分钟」。
  const long = {
    ...STATUS,
    providers: [{
      ...STATUS.providers[0],
      credits: { ...STATUS.providers[0].credits, trend: { spentToday: 1, spent7d: 2, burnPerHour: 0.03, etaMs: 252 * 86_400_000 } },
    }],
  }
  const text = buildDiagnostics(long).text
  assert.ok(text.includes('预计可用: 252 天'), text)
  assert.ok(!text.includes('363476'), '不该出现六位数分钟')
})
