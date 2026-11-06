import assert from 'node:assert/strict'
import test from 'node:test'

import { fallbackModelsFor } from '../lib/fallback-models.js'
import { PROVIDER_IDS } from '../lib/protocol.js'

test('每个 provider 都有兜底清单，且行结构可被适配器消费', () => {
  for (const provider of PROVIDER_IDS) {
    const models = fallbackModelsFor(provider)
    assert.ok(models.length > 0, `${provider} 的兜底清单不能为空`)
    for (const model of models) {
      assert.equal(typeof model.id, 'string')
      assert.ok(model.id.length > 0)
      assert.equal(typeof model.name, 'string')
      assert.ok(model.contextWindow > 0)
      assert.ok(model.maxTokens > 0)
      assert.equal(model.fallback, true)
      assert.ok(Array.isArray(model.reasoningEfforts))
    }
  }
})

test('兜底清单里没有重复 id', () => {
  for (const provider of PROVIDER_IDS) {
    const ids = fallbackModelsFor(provider).map((model) => model.id)
    assert.equal(new Set(ids).size, ids.length, `${provider} 有重复 id`)
  }
})

test('Trae 兜底清单里的 DeepSeek-V4-Flash 按 1M 窗口计算', () => {
  for (const provider of ['trae', 'trae-global']) {
    const flash = fallbackModelsFor(provider).find((model) => model.id === 'DeepSeek-V4-Flash-Official')
    assert.ok(flash, `${provider} 缺少 DeepSeek-V4-Flash-Official`)
    assert.equal(flash.contextWindow, 1_000_000)
    assert.equal(flash.maxTokens, 64_000)
  }
})

test('未知 provider 返回空数组而不是抛错', () => {
  assert.deepEqual(fallbackModelsFor('nope'), [])
})
