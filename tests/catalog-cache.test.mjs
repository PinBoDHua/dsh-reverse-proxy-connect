import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadCatalogCache, normalizeCachedModel, saveCatalogCache } from '../lib/catalog-cache.js'
import { Runtime } from '../lib/runtime.js'
import { defaults } from '../lib/settings.js'

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

test('目录缓存：更高版本的缓存拒绝覆盖（降级安装不能把 v99 写成 v1）', () => {
  // 用户可见行为：降级安装/文件被更新版本写过时，原缓存必须原样保留，
  // 否则另一家的模型清单会被当前进程的「空基线」覆盖、选择器退回兜底。
  const dir = tempDir()
  try {
    const file = join(dir, 'catalog-cache.json')
    const future = JSON.stringify({
      version: 99,
      entries: {
        'workbuddy::acc-a': { models: [MODEL], fetchedAt: Date.now() },
        'trae::acc-t': { models: [{ ...MODEL, id: 'kimi-k2.6' }], fetchedAt: Date.now() },
      },
    }, null, 2)
    writeFileSync(file, future)

    const loaded = loadCatalogCache(dir)
    assert.equal(loaded.size, 0, '未来版本的条目当前版本读不懂')
    assert.equal(loaded.writeBlocked, true, '必须标记为只读，拒绝写回')

    const wrote = saveCatalogCache(dir, new Map([['workbuddy::acc-b', { models: [MODEL], fetchedAt: Date.now() }]]))
    assert.equal(wrote, false, '不能把 v99 降级覆盖成 v1')
    assert.equal(readFileSync(file, 'utf8'), future, '原文件必须一字不改')

    // Runtime 启动时加载未来缓存、退出时 flushCaches 也不能覆盖它。
    const runtime = new Runtime({ settings: () => defaults(), dataDir: dir, logger: {} })
    runtime.flushCaches()
    assert.equal(readFileSync(file, 'utf8'), future, 'runtime 落盘路径同样不能覆盖未来版本')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录缓存：坏文件仍然允许重写修复（只有未来版本才只读）', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'catalog-cache.json')
    writeFileSync(file, '{"version":1,"entries":') // 半截 JSON，模拟写坏/手改坏
    const loaded = loadCatalogCache(dir)
    assert.equal(loaded.size, 0)
    assert.notEqual(loaded.writeBlocked, true, '坏文件不应阻止修复')
    assert.equal(saveCatalogCache(dir, new Map([['workbuddy::acc-a', { models: [MODEL], fetchedAt: Date.now() }]])), true)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(after.version, 1)
    assert.equal(loadCatalogCache(dir).size, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
