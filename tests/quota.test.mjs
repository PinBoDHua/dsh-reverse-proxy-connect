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

test('Qoder 计划接口失败时，0 额度仍按 Free 处理（不误判用尽、不触发换号）', () => {
  // /api/v2/user/plan 429/500/超时：三件证据（freePlan / paid / planName）全缺，
  // usage 仍然是 Free 的 total=0 + isQuotaExceeded=true。
  const credits = { state: 'ok', remain: 0, total: 0, used: 0, exceeded: true, planUnknown: true }
  assert.equal(isQoderFreePlan('qoder-global', credits), true)
  assert.equal(isExhaustedCredits(credits, 'qoder-global'), false)
  assert.equal(creditsAlertOf(credits, { enabled: true, lowRatio: 0.15 }, 'qoder-global'), undefined)
  // 明确是付费套餐时不因 planUnknown 兜底而被当成 Free。
  assert.equal(isQoderFreePlan('qoder', { state: 'ok', total: 0, remain: 0, planUnknown: true, paid: true }), false)
  assert.equal(isExhaustedCredits({ state: 'ok', total: 0, remain: 0, planUnknown: true, paid: true }, 'qoder'), true)
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

test('预警：分母非有限或荒谬大数时不判低额度（坏缓存不再恒亮警示色）', () => {
  const alerts = { enabled: true, lowRatio: 0.15 }
  // 这三个值都能出现在被手改 / 被旧版本写坏的 credits-cache.json 里：
  // Infinity / 1e308 是合法 JSON 数字，NaN 由中间运算产生。
  // 旧实现里 `remain / Infinity` 与 `remain / 1e308` 都等于 0，于是永远 ≤ 阈值。
  for (const total of [Infinity, -Infinity, Number.NaN, 1e308, 1e13]) {
    const credits = { state: 'ok', remain: 675, total, planName: 'Pro', paid: true }
    assert.equal(creditsAlertOf(credits, alerts, 'qoder'), undefined, `total=${String(total)} 不该判低额度`)
  }
  // remain 非有限同理：不能因为一个坏余额就报警。
  assert.equal(creditsAlertOf({ state: 'ok', remain: Number.NaN, total: 1200 }, alerts, 'qoder'), undefined)
  assert.equal(creditsAlertOf({ state: 'ok', remain: Infinity, total: 1200 }, alerts, 'qoder'), undefined)
  // 正常数字仍按阈值判。
  assert.equal(creditsAlertOf({ state: 'ok', remain: 100, total: 1200 }, alerts, 'qoder'), 'low')
  assert.equal(creditsAlertOf({ state: 'ok', remain: 1000, total: 1200 }, alerts, 'qoder'), undefined)
})
