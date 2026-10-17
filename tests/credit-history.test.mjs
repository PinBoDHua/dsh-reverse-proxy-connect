import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CreditHistory,
  creditsHistoryPathOf,
  emptyTrend,
  normalizeHistoryEntry,
  recordSample,
  summarizeHistory,
} from '../lib/credit-history.js'

/** 本地时间构造。 */
function at(hour, minute = 0, day = 18) {
  return new Date(2026, 9, day, hour, minute, 0, 0).getTime()
}

test('额度历史：逐段累加下降量，充值不把已花掉的钱抹掉', () => {
  let entry = recordSample(undefined, { at: at(8), remain: 100 })
  entry = recordSample(entry, { at: at(9), remain: 80 })
  entry = recordSample(entry, { at: at(10), remain: 120 })
  entry = recordSample(entry, { at: at(11), remain: 110 })
  const trend = summarizeHistory(entry, { now: at(12) })
  assert.equal(trend.spentToday, 30)
  assert.equal(trend.topupToday, 40)
  assert.equal(trend.spent7d, 30)
  assert.equal(trend.sampleCount, 4)
  assert.deepEqual(trend.points.map((point) => point.remain), [100, 80, 120, 110])
})

test('额度历史：消耗速度与耗尽时间按最近样本计算', () => {
  let entry
  for (let minute = 0; minute <= 60; minute += 10) {
    entry = recordSample(entry, { at: at(10, minute), remain: 1000 - minute * 10 })
  }
  const trend = summarizeHistory(entry, { now: at(11, 5) })
  // 60 分钟花掉 600，速度 600/小时，剩 400 → 约 40 分钟。
  assert.equal(trend.burnPerHour, 600)
  assert.equal(trend.etaMs, Math.round((400 / 600) * 3600_000))
})

test('额度历史：非整小时时区按本地整点分桶，午夜消耗不会算到昨天', () => {
  const moduleUrl = new URL('../lib/credit-history.js', import.meta.url).href
  const script = `
    import { recordSample, summarizeHistory } from ${JSON.stringify(moduleUrl)}
    const at = (hour, minute, day) => new Date(2026, 9, day, hour, minute, 0, 0).getTime()
    let entry = recordSample(undefined, { at: at(23, 50, 18), remain: 100 })
    entry = recordSample(entry, { at: at(0, 10, 19), remain: 90 })
    const trend = summarizeHistory(entry, { now: at(0, 20, 19) })
    process.stdout.write(String(trend.spentToday))
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'Asia/Kolkata' },
    encoding: 'utf8',
  })
  assert.equal(output, '10')
})

test('额度历史：同一刷新窗口内数值不变才去重；数值变了是真实消耗', () => {
  let entry = recordSample(undefined, { at: at(9), remain: 100 })
  // 数值没变：同一轮刷新，不重复落点。
  entry = recordSample(entry, { at: at(9) + 5_000, remain: 100 })
  assert.equal(entry.recent.length, 1)
  assert.equal(summarizeHistory(entry, { now: at(9) + 5_000 }).spentToday, 0)
  // 30 秒内余额变了（刚发完一条消息）：必须累计，否则这段消耗会被吞掉。
  entry = recordSample(entry, { at: at(9) + 10_000, remain: 90 })
  entry = recordSample(entry, { at: at(9) + 20_000, remain: 80 })
  const trend = summarizeHistory(entry, { now: at(9) + 25_000 })
  assert.equal(trend.spentToday, 20)
  assert.deepEqual(trend.points.map((point) => point.remain), [100, 90, 80])
})

test('额度历史：时钟回拨不会让样本乱序或产生负消耗', () => {
  let entry = recordSample(undefined, { at: at(10), remain: 100 })
  entry = recordSample(entry, { at: at(9), remain: 90 })
  const trend = summarizeHistory(entry, { now: at(11) })
  assert.equal(trend.spentToday, 10)
  assert.equal(entry.recent.length, 2)
  assert.ok(entry.recent[0].at <= entry.recent[1].at)
})

test('额度历史：跨小时边界的下降计入新桶，断档不猜', () => {
  let entry = recordSample(undefined, { at: at(9, 59), remain: 100 })
  entry = recordSample(entry, { at: at(10, 1), remain: 90 })
  let trend = summarizeHistory(entry, { now: at(10, 30) })
  assert.equal(trend.spentToday, 10)

  // 隔了 5 小时才回来：这段下降无法归因到某一小时，不累计。
  entry = recordSample(undefined, { at: at(10), remain: 100 })
  entry = recordSample(entry, { at: at(15), remain: 50 })
  trend = summarizeHistory(entry, { now: at(16) })
  assert.equal(trend.spentToday, 0)
})

test('额度历史：今日/最近 7 天按自然日与窗口分开', () => {
  let entry = recordSample(undefined, { at: at(12, 0, 12), remain: 1000 })
  entry = recordSample(entry, { at: at(13, 0, 12), remain: 900 })
  entry = recordSample(entry, { at: at(12, 0, 18), remain: 800 })
  entry = recordSample(entry, { at: at(13, 0, 18), remain: 700 })
  const trend = summarizeHistory(entry, { now: at(14, 0, 18) })
  assert.equal(trend.spentToday, 100)
  assert.equal(trend.spent7d, 200)
})

test('额度历史：坏样本、error、unlimited 不写入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-history-'))
  try {
    const history = new CreditHistory({ filePath: creditsHistoryPathOf(dir) })
    assert.equal(history.record('workbuddy', 'a', { state: 'error' }), false)
    assert.equal(history.record('workbuddy', 'a', { state: 'ok', unlimited: true, remain: 0 }), false)
    assert.equal(history.record('workbuddy', 'a', { state: 'ok', remain: Number.NaN }), false)
    assert.deepEqual(history.trendFor('workbuddy', 'a'), emptyTrend())
    history.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('额度历史：落盘后可恢复，超量条目会被裁剪', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-history-'))
  try {
    const filePath = creditsHistoryPathOf(dir)
    const history = new CreditHistory({ filePath, now: () => at(12) })
    history.record('workbuddy', 'a', { state: 'ok', remain: 675, total: 1200 }, at(10))
    history.record('workbuddy', 'a', { state: 'ok', remain: 600, total: 1200 }, at(11))
    history.stop()

    const restored = new CreditHistory({ filePath, now: () => at(12) })
    const trend = restored.trendFor('workbuddy', 'a')
    assert.equal(trend.spentToday, 75)
    assert.equal(trend.points.length, 2)
    restored.stop()

    // 超量的小时桶/原始点在读入时被裁到最后 168/60 个。
    const entry = normalizeHistoryEntry({
      recent: Array.from({ length: 80 }, (_, index) => ({ at: at(0, 0, 1) + index * 60_000, remain: 100 - index })),
      hours: Array.from({ length: 200 }, (_, index) => ({
        at: at(0, 0, 1) + index * 3600_000,
        first: 100,
        last: 99,
        spent: 1,
        topup: 0,
        samples: 1,
      })),
    })
    assert.equal(entry.recent.length, 60)
    assert.equal(entry.hours.length, 168)
    // 80 个点裁到最后 60 个：remain 从 80 到 21。
    assert.equal(entry.recent[0].remain, 80)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
