// 事件账本：有上限、可持久化、只记元数据。
//
// 这些用例保护的是「排障时还能看到刚才发生了什么」这条产品承诺：
// 账本不能无限长、不能因为一行坏数据整体失效、不能在后台轮询时被刷屏。

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  EVENT_LIMIT,
  EVENT_VERSION,
  EventLog,
  eventsPathOf,
  normalizeEvent,
  normalizeEventData,
  scrubSecretText,
} from '../lib/events.js'

/** 一个临时目录，测试结束自动删除。 */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-events-'))
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

test('事件归一化：未知 provider 丢弃，消息一行且截断，复杂数据不进账本', () => {
  const event = normalizeEvent({
    type: 'account-switch',
    level: 'warn',
    provider: 'not-a-provider',
    accountId: 'acc-1',
    message: '第一行\n第二行  多了些空白',
    data: { from: 'a', nested: { token: 'secret' }, list: [1, 'two', { bad: true }] },
  }, { now: 1_700_000_000_000 })
  assert.equal(event.type, 'account-switch')
  assert.equal(event.level, 'warn')
  assert.equal(event.provider, undefined)
  assert.equal(event.accountId, 'acc-1')
  assert.equal(event.at, 1_700_000_000_000)
  assert.equal(event.message, '第一行 第二行 多了些空白')
  // 嵌套对象与对象数组都不该进账本 —— 令牌之类的东西最容易藏在里面。
  assert.deepEqual(event.data, { from: 'a', list: [1, 'two'] })

  const long = normalizeEvent({ type: 'x', message: 'x'.repeat(1000) })
  assert.ok(long.message.length <= 301, '消息必须截断')
  assert.ok(long.message.endsWith('…'))
})

test('事件归一化：坏输入不会抛异常，级别回落到 info', () => {
  assert.equal(normalizeEvent(undefined), undefined)
  assert.equal(normalizeEvent('nope'), undefined)
  const event = normalizeEvent({ type: 'custom', level: 'fatal', message: 42 })
  assert.equal(event.level, 'info')
  assert.equal(event.type, 'custom')
  assert.equal(event.message, 'custom')
})

test('令牌兜底脱敏：Bearer / JWT / pt- / 查询参数都不原样进账本', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'
  const text = scrubSecretText(`请求失败：Authorization: Bearer abcdefghijklmnop ${jwt} pt-1234567890 见 https://x/y?access_token=abc123&x=1`)
  assert.ok(!text.includes('abcdefghijklmnop'))
  assert.ok(!text.includes(jwt))
  assert.ok(!text.includes('pt-1234567890'))
  assert.ok(!text.includes('abc123'))
  assert.ok(text.includes('[redacted]'))
  assert.ok(text.includes('[redacted-jwt]'))
  assert.ok(text.includes('x=1'), '无关参数不能被误伤')

  const event = normalizeEvent({ type: 'x', message: `token=Bearer ${jwt}` })
  assert.ok(!event.message.includes(jwt))
})
test('附加数据：只保留简单值，字符串截断，嵌套对象丢弃', () => {
  assert.deepEqual(normalizeEventData({ a: 1, b: true, c: 'x', d: null }), { a: 1, b: true, c: 'x' })
  assert.equal(normalizeEventData({ nested: { a: 1 } }), undefined)
  const long = normalizeEventData({ text: 'x'.repeat(5000) })
  assert.ok(long.text.length <= 161, '长字符串要截断，而不是整份写进账本')
  assert.equal(normalizeEventData([]), undefined)
})

test('账本有上限：超过 EVENT_LIMIT 后丢最旧的', () => {
  const log = new EventLog({ limit: 5, persistLimit: 3 })
  for (let index = 0; index < 8; index++) log.record({ type: 'test', message: `第 ${index} 条` })
  assert.equal(log.summary().count, 5)
  const items = log.list({ limit: 10 })
  assert.equal(items.length, 5)
  assert.equal(items[0].message, '第 7 条', 'list 最新在前')
  assert.equal(items[4].message, '第 3 条')
  assert.equal(EVENT_LIMIT, 200)
})

test('去重只压掉时间窗内的同一条，不误伤不同 provider / 不同类型', () => {
  let now = 1_700_000_000_000
  const log = new EventLog({ now: () => now })
  assert.ok(log.record({ type: 'credits', provider: 'qoder', level: 'warn', message: '读取失败' }, { dedupeMs: 60_000 }))
  now += 1_000
  assert.equal(log.record({ type: 'credits', provider: 'qoder', level: 'warn', message: '读取失败' }, { dedupeMs: 60_000 }), false)
  assert.ok(log.record({ type: 'credits', provider: 'trae', level: 'warn', message: '读取失败' }, { dedupeMs: 60_000 }))
  assert.ok(log.record({ type: 'checkin', provider: 'qoder', message: '读取失败' }, { dedupeMs: 60_000 }))
  now += 61_000
  assert.ok(log.record({ type: 'credits', provider: 'qoder', level: 'warn', message: '读取失败' }, { dedupeMs: 60_000 }))
  assert.equal(log.summary().count, 4)
})

test('筛选：按类型 / provider / 级别 / 时间起点', () => {
  let now = 1_700_000_000_000
  const log = new EventLog({ now: () => now })
  log.record({ type: 'account-switch', provider: 'qoder', message: '换号', at: now })
  now += 10_000
  log.record({ type: 'credits', provider: 'qoder', level: 'warn', message: '额度失败', at: now })
  now += 10_000
  log.record({ type: 'credits', provider: 'trae', level: 'error', message: '额度失败', at: now })
  assert.deepEqual(log.list({ type: 'credits' }).map((item) => item.provider), ['trae', 'qoder'])
  assert.deepEqual(log.list({ provider: 'qoder' }).map((item) => item.type), ['credits', 'account-switch'])
  assert.deepEqual(log.list({ level: 'error' }).map((item) => item.provider), ['trae'])
  assert.equal(log.list({ since: now }).length, 1)
  assert.equal(log.list({ limit: 1 }).length, 1)
})

test('持久化：写盘是原子 JSON、重启后能读回，且只保留 persistLimit 条', () => {
  const { dir, dispose } = tempDir()
  try {
    const file = eventsPathOf(dir)
    assert.equal(file, join(dir, 'events.json'))
    const log = new EventLog({ filePath: file, persistDelayMs: 0 })
    for (let index = 0; index < 6; index++) log.record({ type: 'test', message: `第 ${index} 条` })
    assert.equal(log.flush(), true)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.version, EVENT_VERSION)
    assert.equal(raw.events.length, 6)
    assert.ok(raw.events[0].id !== undefined, '落盘事件带稳定 id')

    const restored = new EventLog({ filePath: file })
    assert.equal(restored.summary().count, 6)
    assert.equal(restored.list({ limit: 1 })[0].message, '第 5 条')

    const capped = new EventLog({ filePath: file, limit: 10, persistLimit: 2 })
    for (let index = 0; index < 4; index++) capped.record({ type: 'test', message: `新 ${index}` })
    capped.flush()
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).events.length, 2)
  } finally {
    dispose()
  }
})

test('坏文件 / 错版本 / 坏条目不会让账本整体失效', () => {
  const { dir, dispose } = tempDir()
  try {
    const file = eventsPathOf(dir)
    writeFileSync(file, '{ not json')
    assert.equal(new EventLog({ filePath: file }).summary().count, 0)

    writeFileSync(file, JSON.stringify({ version: 99, events: [{ type: 'test', message: 'x' }] }))
    assert.equal(new EventLog({ filePath: file }).summary().count, 0)

    writeFileSync(file, JSON.stringify({
      version: EVENT_VERSION,
      events: [
        null,
        { type: 'test', message: '好的一条', at: 1_700_000_000_000 },
        { type: '', message: '没有类型' },
      ],
    }))
    const log = new EventLog({ filePath: file })
    assert.equal(log.summary().count, 2, '坏条目丢弃，好条目保留')
  } finally {
    dispose()
  }
})

test('clear() 同时清内存与磁盘；stop() 之后不再记录', () => {
  const { dir, dispose } = tempDir()
  try {
    const file = eventsPathOf(dir)
    const log = new EventLog({ filePath: file })
    log.record({ type: 'test', message: '一' })
    log.record({ type: 'test', message: '二' })
    assert.equal(log.clear(), true)
    assert.equal(log.summary().count, 0)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).events.length, 0)

    log.record({ type: 'test', message: '三' })
    log.stop()
    assert.equal(log.record({ type: 'test', message: '四' }), false)
    assert.equal(new EventLog({ filePath: file }).summary().count, 1)
  } finally {
    dispose()
  }
})
