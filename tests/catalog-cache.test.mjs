import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadCatalogCache, normalizeCachedModel, saveCatalogCache } from '../lib/catalog-cache.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-rpc-catalog-'))
}

const MODEL = {
  id: 'glm-5.3',
  name: 'GLM-5.3',
  contextWindow: 1_000_000,
  maxTokens: 64_000,
  supportsImages: true,
  supportsReasoning: true,
  reasoningEfforts: ['low', 'medium'],
  defaultEffort: 'medium',
  credits: 'x0.79',
  contextOptions: { '200K': { tokenCount: 200_000, isDefault: true } },
  source: 'system',
}

test('目录缓存：按 provider::account 存取，模型行完整保留', () => {
  const dir = tempDir()
  try {
    const entries = new Map([['workbuddy::default', { models: [MODEL], fetchedAt: Date.now() }]])
    assert.equal(saveCatalogCache(dir, entries), true)
    const loaded = loadCatalogCache(dir)
    assert.equal(loaded.size, 1)
    const entry = loaded.get('workbuddy::default')
    assert.equal(entry.models.length, 1)
    assert.equal(entry.models[0].id, 'glm-5.3')
    assert.equal(entry.models[0].contextWindow, 1_000_000)
    assert.deepEqual(entry.models[0].reasoningEfforts, ['low', 'medium'])
    assert.equal(entry.models[0].defaultEffort, 'medium')
    assert.equal(entry.models[0].contextOptions['200K'].isDefault, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录缓存：超过 30 天、坏行、坏键都被丢弃', () => {
  const dir = tempDir()
  try {
    const stale = Date.now() - 40 * 24 * 3600_000
    writeFileSync(
      join(dir, 'catalog-cache.json'),
      JSON.stringify({
        version: 1,
        entries: {
          'workbuddy::old': { models: [MODEL], fetchedAt: stale },
          'workbuddy::bad': { models: [{ id: 'x', name: 'X' }], fetchedAt: Date.now() },
          'bogus::x': { models: [MODEL], fetchedAt: Date.now() },
          'qoder::ok': { models: [MODEL], fetchedAt: Date.now() },
        },
      }),
    )
    const loaded = loadCatalogCache(dir)
    assert.deepEqual([...loaded.keys()], ['qoder::ok'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录缓存：空模型不写盘，写盘文件是合法 JSON', () => {
  const dir = tempDir()
  try {
    assert.equal(saveCatalogCache(dir, new Map([['workbuddy::default', { models: [], fetchedAt: Date.now() }]])), true)
    const raw = JSON.parse(readFileSync(join(dir, 'catalog-cache.json'), 'utf8'))
    assert.deepEqual(raw.entries, {})
    assert.equal(loadCatalogCache(dir).size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录缓存：单行归一化剥掉未知字段并修正常见错值', () => {
  const model = normalizeCachedModel({
    id: 'm',
    name: '',
    contextWindow: 100,
    maxTokens: 10,
    reasoningEfforts: ['max', 'bogus', 'low', 'max'],
    defaultEffort: 'bogus',
    contextOptions: { a: { tokenCount: 5 }, b: { tokenCount: 0 }, c: 'nope' },
    unknown: 'drop-me',
  })
  assert.equal(model.name, 'm')
  assert.deepEqual(model.reasoningEfforts, ['max', 'low'])
  assert.equal(model.defaultEffort, undefined)
  assert.deepEqual(model.contextOptions, { a: { tokenCount: 5, isDefault: false } })
  assert.equal(model.unknown, undefined)
  assert.equal(normalizeCachedModel({ id: '' }), undefined)
})
