import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadCreditsCache, saveCreditsCache } from '../lib/credits-cache.js'

/** 造一个目录，用完删。 */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-credits-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const NOW = Date.now()
const sample = {
  data: { state: 'ok', remain: 675, total: 1200, unit: 'credits', items: [], fetchedAt: NOW },
  fetchedAt: NOW,
}

test('额度缓存能存能读，且读回来带 stale 标记', () => {
  withTempDir((dir) => {
    assert.equal(saveCreditsCache(dir, new Map([['workbuddy::default', sample]])), true)
    const loaded = loadCreditsCache(dir)
    assert.equal(loaded.size, 1)
    assert.equal(loaded.get('workbuddy::default').data.remain, 675)
    assert.equal(loaded.get('workbuddy::default').stale, true)
  })
})

test('老格式（键只有 provider）自动迁移到默认账号', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, 'credits-cache.json'),
      JSON.stringify({ workbuddy: sample }),
      'utf8',
    )
    const loaded = loadCreditsCache(dir)
    assert.deepEqual([...loaded.keys()], ['workbuddy::default'])
    assert.equal(loaded.get('workbuddy::default').data.remain, 675)
  })
})

test('只缓存成功快照：错误态与空快照不写盘', () => {
  withTempDir((dir) => {
    saveCreditsCache(dir, new Map([
      ['workbuddy', { data: { state: 'error', message: 'x' }, fetchedAt: 2000 }],
      ['qoder', { data: { state: 'none' }, fetchedAt: 0 }],
      ['workbuddy-ai', sample],
    ]))
    const loaded = loadCreditsCache(dir)
    assert.deepEqual([...loaded.keys()], ['workbuddy-ai::default'])
  })
})

test('过期缓存不展示：超过一周的直接丢掉', () => {
  withTempDir((dir) => {
    const old = Date.now() - 8 * 24 * 3600_000
    saveCreditsCache(dir, new Map([['workbuddy', { data: { ...sample.data, fetchedAt: old }, fetchedAt: old }]]))
    assert.equal(loadCreditsCache(dir).size, 0)
  })
})

test('缓存里的坏套餐行会被丢弃，不能把 null 原样送进 /status', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'credits-cache.json'), JSON.stringify({
      'workbuddy::default': {
        fetchedAt: NOW,
        data: { state: 'ok', remain: 10, total: 20, items: [null, 3, { name: 42, remain: 'x' }, { name: 'ok', remain: 5, total: 10 }] },
      },
    }), 'utf8')
    const loaded = loadCreditsCache(dir)
    const items = loaded.get('workbuddy::default').data.items
    assert.equal(items.length, 1)
    assert.equal(items[0].name, 'ok')
    assert.equal(items[0].remain, 5)
  })
})

test('缓存里的坏数字/坏布尔会被丢掉，不能让卡片算出 NaN', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'credits-cache.json'), JSON.stringify({
      'qoder-global::default': {
        fetchedAt: NOW,
        data: {
          state: 'ok',
          remain: 'x',
          total: null,
          used: 'many',
          resetAtMs: '2026-10-18',
          unit: 42,
          planName: 7,
          exceeded: 'true',
          paid: 'false',
          freePlan: 1,
          unlimited: null,
          items: [],
        },
      },
    }), 'utf8')
    const data = loadCreditsCache(dir).get('qoder-global::default').data
    assert.equal(data.remain, undefined, '字符串数字要丢掉，而不是留着让卡片算出 NaN')
    assert.equal(data.total, undefined)
    assert.equal(data.used, undefined)
    assert.equal(data.resetAtMs, undefined)
    assert.equal(data.unit, undefined)
    assert.equal(data.planName, undefined)
    assert.equal(data.exceeded, undefined, '字符串 "true" 不能冒充满额')
    assert.equal(data.paid, undefined, '字符串 "false" 不能让 freePlan 判定误命中')
    assert.equal(data.freePlan, undefined)
    assert.equal(data.unlimited, undefined)
    assert.equal(data.state, 'ok', 'state 本身是合法值，要保留')
  })
})

test('坏文件 / 不存在 / 非对象内容都安静退化成空缓存', () => {
  withTempDir((dir) => {
    assert.equal(loadCreditsCache(dir).size, 0, '目录里没文件')
    writeFileSync(join(dir, 'credits-cache.json'), '{ not json', 'utf8')
    assert.equal(loadCreditsCache(dir).size, 0, '坏 JSON')
    writeFileSync(join(dir, 'credits-cache.json'), '[]', 'utf8')
    assert.equal(loadCreditsCache(dir).size, 0, '数组')
    writeFileSync(join(dir, 'credits-cache.json'), '{"workbuddy":{"data":{"state":"ok"},"fetchedAt":0}}', 'utf8')
    assert.equal(loadCreditsCache(dir).size, 0, '缺 fetchedAt')
  })
})

test('写盘失败不抛（目录不可写时返回 false）', () => {
  assert.equal(saveCreditsCache('', new Map([['workbuddy', sample]])), false)
})

test('磁盘缓存来自更高版本：只读加载并拒绝覆盖（降级安装不能清空快照）', () => {
  withTempDir((dir) => {
    const file = join(dir, 'credits-cache.json')
    const future = JSON.stringify({
      version: 2,
      entries: {
        'qoder::default': { data: { state: 'ok', remain: 42, total: 100, unit: 'credits' }, fetchedAt: NOW },
      },
    })
    writeFileSync(file, future, 'utf8')

    const entries = loadCreditsCache(dir)
    assert.equal(entries.size, 0, '未来版本不做字段猜测')
    assert.equal(entries.writeBlocked, true, '必须标记只读，否则下一次落盘会覆盖它')
    assert.equal(entries.unsupportedVersion, 2)

    // 三条写入路径都必须被挡住：带标记的 Map、全新的空 Map、以及有新数据的 Map。
    assert.equal(saveCreditsCache(dir, entries), false, '带标记时拒绝写')
    assert.equal(saveCreditsCache(dir, new Map()), false, '新建的 Map 也要先查磁盘版本')
    assert.equal(
      saveCreditsCache(dir, new Map([['qoder::default', sample]])),
      false,
      '有新数据也不能覆盖未来版本的缓存',
    )
    assert.equal(readFileSync(file, 'utf8'), future, '原文件一个字节都不能变')
  })
})
