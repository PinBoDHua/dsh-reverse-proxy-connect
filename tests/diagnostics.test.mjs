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

test('诊断：坏输入不抛错', () => {
  assert.equal(redactStatus(null), null)
  const { text } = buildDiagnostics({})
  assert.ok(typeof text === 'string' && text.includes('dsh-reverse-proxy-connect'))
})
