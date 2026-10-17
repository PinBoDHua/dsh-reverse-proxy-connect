import assert from 'node:assert/strict'
import test from 'node:test'

import { patchNeedsRefresh, sanitizePatch } from '../lib/patch.js'
import { defaults, normalize } from '../lib/settings.js'

test('设置补丁：已知字段全部接受，未知字段全部丢弃', () => {
  const patch = sanitizePatch({
    providers: {
      workbuddy: { enabled: false, disabledModels: ['a', 3, 'b'], junk: true },
      bogus: { enabled: true },
    },
    qoder: { qoder: { pat: '  tok  ' }, 'qoder-global': { pat: 123 } },
    accounts: {
      qoder: [{ id: 'a', label: 'A', pat: 'p' }, { id: 'b', label: 'B' }],
    },
    removedAccounts: { qoder: ['c'], bogus: ['x'] },
    activeAccount: { qoder: 'a', bogus: 'x' },
    autoSwitch: { enabled: false, thresholdRatio: 0.12 },
    alerts: { enabled: true, lowRatio: 0.2 },
    forcedModels: { workbuddy: ['x'] },
    probe: { enabled: false },
    checkin: { enabled: false },
    display: { showRateInModelName: false, showUsageInSidebar: false, unknown: 1 },
    advanced: { idleTimeoutMs: 999_999_999, catalogRefreshMs: 1, creditsRefreshMs: 60_000, qoderQueueWaitMs: 999_999, stats: false, catalogCache: false },
    unknown: 'drop',
  })
  assert.equal(patch.providers.workbuddy.enabled, false)
  assert.deepEqual(patch.providers.workbuddy.disabledModels, ['a', 'b'])
  assert.equal(patch.providers.bogus, undefined)
  assert.equal(patch.qoder.qoder.pat, 'tok')
  assert.equal(patch.qoder['qoder-global'], undefined)
  assert.equal(patch.accounts.qoder.length, 2)
  assert.equal(patch.accounts.qoder[0].pat, 'p')
  assert.deepEqual(patch.removedAccounts.qoder, ['c'])
  assert.equal(patch.removedAccounts.bogus, undefined)
  assert.equal(patch.activeAccount.qoder, 'a')
  assert.equal(patch.activeAccount.bogus, undefined)
  assert.equal(patch.autoSwitch.enabled, false)
  assert.equal(patch.autoSwitch.thresholdRatio, 0.12)
  assert.equal(patch.alerts.enabled, true)
  assert.equal(patch.alerts.lowRatio, 0.2)
  assert.deepEqual(patch.forcedModels.workbuddy, ['x'])
  assert.equal(patch.probe.enabled, false)
  assert.equal(patch.checkin.enabled, false)
  assert.equal(patch.display.showRateInModelName, false)
  assert.equal(patch.display.showUsageInSidebar, false)
  assert.equal(patch.display.unknown, undefined)
  // 夹进合法区间。
  assert.equal(patch.advanced.idleTimeoutMs, 900_000)
  assert.equal(patch.advanced.catalogRefreshMs, 120_000)
  assert.equal(patch.advanced.creditsRefreshMs, 60_000)
  assert.equal(patch.advanced.qoderQueueWaitMs, 180_000)
  assert.equal(patch.advanced.stats, false)
  assert.equal(patch.advanced.catalogCache, false)
  assert.equal(patch.unknown, undefined)
})

test('设置补丁：非对象输入与错类型都不会炸', () => {
  assert.deepEqual(sanitizePatch(null), {})
  assert.deepEqual(sanitizePatch([]), {})
  assert.deepEqual(sanitizePatch({ providers: [] }), {})
  assert.deepEqual(sanitizePatch({ advanced: { idleTimeoutMs: 'x' } }), {})
})

test('设置补丁：换凭证/切账号需要刷新，模型开关不需要', () => {
  assert.equal(patchNeedsRefresh({ qoder: { qoder: { pat: 'x' } } }), true)
  assert.equal(patchNeedsRefresh({ accounts: { qoder: [] } }), true)
  assert.equal(patchNeedsRefresh({ activeAccount: { qoder: 'a' } }), true)
  assert.equal(patchNeedsRefresh({ providers: { qoder: { enabled: false } } }), true)
  assert.equal(patchNeedsRefresh({ providers: { qoder: { disabledModels: ['a'] } } }), false)
  assert.equal(patchNeedsRefresh({ display: { showRateInModelName: false } }), false)
  assert.equal(patchNeedsRefresh({ advanced: { idleTimeoutMs: 30_000 } }), false)
  assert.equal(patchNeedsRefresh({ alerts: { lowRatio: 0.2 } }), false)
  assert.equal(patchNeedsRefresh({ autoSwitch: { thresholdRatio: 0.1 } }), false)
})

test('设置：v2 默认值包含 advanced，并且 normalize 会夹取非法数字', () => {
  const value = defaults()
  assert.equal(value.version, 2)
  assert.equal(value.advanced.stats, true)
  assert.equal(value.advanced.catalogCache, true)
  assert.equal(value.advanced.qoderQueueWaitMs, 60_000)
  assert.equal(value.display.showUsageInSidebar, true)
  assert.deepEqual(value.checkin.completedOn, {})
  assert.deepEqual(value.checkin.lastAttemptAt, {})

  const merged = normalize({ version: 1, advanced: { idleTimeoutMs: -1, catalogRefreshMs: 10, creditsRefreshMs: 999_999_999, qoderQueueWaitMs: 999_999 } })
  assert.equal(merged.version, 2)
  assert.equal(merged.advanced.idleTimeoutMs, 15_000)
  assert.equal(merged.advanced.catalogRefreshMs, 120_000)
  assert.equal(merged.advanced.creditsRefreshMs, 21_600_000)
  assert.equal(merged.advanced.qoderQueueWaitMs, 180_000)
})

test('设置：签到完成日期与尝试时间按 provider 归一化，坏值丢弃', () => {
  const value = normalize({
    checkin: {
      completedOn: { workbuddy: '2026-10-18', 'workbuddy-ai': '昨天', qoder: 42, bogus: '2026-10-18' },
      lastAttemptAt: { workbuddy: 1792253476620, qoder: -1, bogus: 123 },
    },
  })
  assert.equal(value.checkin.completedOn.workbuddy, '2026-10-18')
  assert.equal(value.checkin.completedOn['workbuddy-ai'], undefined)
  assert.equal(value.checkin.completedOn.qoder, undefined)
  assert.equal(value.checkin.completedOn.bogus, undefined)
  assert.equal(value.checkin.lastAttemptAt.workbuddy, 1792253476620)
  assert.equal(value.checkin.lastAttemptAt.qoder, undefined)
  assert.equal(value.checkin.lastAttemptAt.bogus, undefined)
})

test('设置：预警与自动换号阈值会被夹取，百分数写法收敛成小数', () => {
  const defaultsValue = defaults()
  assert.equal(defaultsValue.alerts.enabled, true)
  assert.equal(defaultsValue.alerts.lowRatio, 0.15)
  assert.equal(defaultsValue.autoSwitch.thresholdRatio, 0)

  const value = normalize({
    alerts: { enabled: false, lowRatio: 85 },
    autoSwitch: { enabled: true, thresholdRatio: 120 },
  })
  assert.equal(value.alerts.enabled, false)
  assert.equal(value.alerts.lowRatio, 0.85)
  assert.equal(value.autoSwitch.thresholdRatio, 0.5)

  const bad = normalize({ alerts: { lowRatio: 'x' }, autoSwitch: { thresholdRatio: -1 } })
  assert.equal(bad.alerts.lowRatio, 0.15)
  assert.equal(bad.autoSwitch.thresholdRatio, 0)
})
