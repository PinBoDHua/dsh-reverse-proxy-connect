import assert from 'node:assert/strict'
import test from 'node:test'

import { creditsAlertOf, isExhaustedCredits, isQoderFreePlan } from '../lib/quota.js'

/** 一份 Qoder Free 的额度快照。 */
function freeCredits(extra = {}) {
  return { state: 'ok', remain: 0, total: 0, used: 0, planName: 'Free', paid: false, exceeded: true, ...extra }
}

test('Qoder Free：0 付费额度按 Free 处理，不算耗尽、不触发预警', () => {
  const credits = freeCredits()
  assert.equal(isQoderFreePlan('qoder-global', credits), true)
  assert.equal(isExhaustedCredits(credits, 'qoder-global'), false)
  assert.equal(creditsAlertOf(credits, { enabled: true, lowRatio: 0.15 }, 'qoder-global'), undefined)
  // 老缓存没有 freePlan / paid：只看套餐名也要能识别。
  assert.equal(isQoderFreePlan('qoder', { state: 'ok', total: 0, remain: 0, planName: 'free' }), true)
  assert.equal(isQoderFreePlan('qoder', { state: 'ok', total: 0, remain: 0, planName: '免费' }), true)
})

test('Qoder 付费套餐的 0 仍然是「用尽」，不能被 Free 判定误伤', () => {
  const credits = { state: 'ok', remain: 0, total: 0, planName: 'Pro', paid: true, exceeded: true }
  assert.equal(isQoderFreePlan('qoder-global', credits), false)
  assert.equal(isExhaustedCredits(credits, 'qoder-global'), true)
  assert.equal(creditsAlertOf(credits, { enabled: true }, 'qoder-global'), 'exhausted')
  // 有付费额度时即使套餐名叫 Free 也不算 Free。
  assert.equal(isQoderFreePlan('qoder', { state: 'ok', total: 10, remain: 5, planName: 'Free' }), false)
})

test('预警：alerts.enabled=false 关掉所有预警等级，不只是横幅', () => {
  const low = { state: 'ok', remain: 5, total: 100, planName: 'Pro', paid: true }
  assert.equal(creditsAlertOf(low, { enabled: true, lowRatio: 0.15 }, 'qoder'), 'low')
  assert.equal(creditsAlertOf(low, { enabled: false, lowRatio: 0.15 }, 'qoder'), undefined)
  // 非 Qoder provider 不受 Free 判定影响。
  assert.equal(creditsAlertOf(low, { enabled: true, lowRatio: 0.15 }, 'workbuddy'), 'low')
  assert.equal(isExhaustedCredits({ state: 'ok', remain: 0, total: 100 }, 'workbuddy'), true)
  // 读不到不算耗尽。
  assert.equal(isExhaustedCredits({ state: 'error', remain: 0, total: 0 }, 'workbuddy'), false)
})
