import assert from 'node:assert/strict'
import test from 'node:test'

import { parseLocalTime, emptyCredits } from '../lib/credits.js'
import { normalizeRateLabel, displayNameOfModel, toModelInfo } from '../lib/adapter.js'

test('parseLocalTime 按本机时区解析无时区时间', () => {
  const ms = parseLocalTime('2026-10-18 12:04:44')
  const date = new Date(ms)
  assert.equal(date.getFullYear(), 2026)
  assert.equal(date.getMonth(), 9)
  assert.equal(date.getDate(), 18)
  assert.equal(date.getHours(), 12)
  assert.equal(date.getMinutes(), 4)
  assert.equal(date.getSeconds(), 44)
})

test('parseLocalTime 对非法输入返回 undefined', () => {
  assert.equal(parseLocalTime(''), undefined)
  assert.equal(parseLocalTime('not a date'), undefined)
  assert.equal(parseLocalTime(123), undefined)
  assert.equal(parseLocalTime(undefined), undefined)
})

test('emptyCredits 是稳定的空快照', () => {
  const value = emptyCredits()
  assert.equal(value.state, 'none')
  assert.equal(value.remain, 0)
  assert.deepEqual(value.items, [])
})

test('倍率归一化：各种上游写法都收敛成 xN / 免费', () => {
  assert.equal(normalizeRateLabel('x0.79 credits'), 'x0.79')
  assert.equal(normalizeRateLabel('x0.79'), 'x0.79')
  assert.equal(normalizeRateLabel('0.79'), 'x0.79')
  assert.equal(normalizeRateLabel('x0'), '免费')
  assert.equal(normalizeRateLabel('x0.00'), '免费')
  assert.equal(normalizeRateLabel('免费'), undefined)
  assert.equal(normalizeRateLabel(undefined), undefined)
  assert.equal(normalizeRateLabel(''), undefined)
})

test('模型名拼倍率：只在开启且有可识别倍率时拼，且不重复', () => {
  const model = { id: 'glm', name: 'GLM-5.3', credits: 'x0.79 credits' }
  assert.equal(displayNameOfModel(model, true), 'GLM-5.3 · x0.79')
  assert.equal(displayNameOfModel(model, false), 'GLM-5.3')
  // 认不出倍率 → 保持原名，绝不凭空补数字。
  assert.equal(displayNameOfModel({ id: 'x', name: 'X' }, true), 'X')
  // 名字里已含同一段 → 不重复。
  assert.equal(displayNameOfModel({ id: 'x', name: 'X · x0.79', credits: 'x0.79' }, true), 'X · x0.79')
  // 免费档显示「免费」。
  assert.equal(displayNameOfModel({ id: 'h', name: 'Hy3', credits: 'x0.00' }, true), 'Hy3 · 免费')
})

test('toModelInfo 的 name 随 showRate 变化，id 不变', () => {
  const model = { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79', supportsImages: true }
  const plain = toModelInfo('workbuddy', model, false)
  const rated = toModelInfo('workbuddy', model, true)
  assert.equal(plain.id, 'glm-5.3')
  assert.equal(rated.id, 'glm-5.3')
  assert.equal(plain.name, 'GLM-5.3')
  assert.equal(rated.name, 'GLM-5.3 · x0.79')
  assert.deepEqual(rated.inputModalities, ['text', 'image'])
})
