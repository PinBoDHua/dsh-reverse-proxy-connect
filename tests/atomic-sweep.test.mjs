/**
 * 孤儿临时文件清理。
 *
 * 这些文件只有「进程在 writeFileSync 与 renameSync 之间被强杀」才会留下，
 * 正常失败路径会自己删。真实安装里已经见过一个 24 KB 的
 * `.credits-history.json.<pid>.<hex>.tmp` 从宿主重启一直留到下次重启。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { sweepTempFiles } from '../lib/atomic.js'

/** 把文件时间改成 ageMs 之前。 */
function ageFile(file, ageMs, now = Date.now()) {
  const stamp = new Date(now - ageMs)
  utimesSync(file, stamp, stamp)
}

test('临时文件清理：只删本插件写出且已过期的，不碰新文件与正常文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-sweep-'))
  const now = Date.now()
  try {
    const staleAtomic = join(dir, '.settings.json.204944.1cb6e0e6.tmp')
    const staleDoctor = join(dir, '.doctor-204944.tmp')
    const freshAtomic = join(dir, '.stats.json.204945.abcdef12.tmp')
    const normal = join(dir, 'settings.json')
    const foreignTmp = join(dir, 'note.tmp')
    const badSuffix = join(dir, '.stats.json.204946.not-hex.tmp')

    writeFileSync(staleAtomic, 'a'.repeat(120))
    writeFileSync(staleDoctor, 'b'.repeat(30))
    writeFileSync(freshAtomic, 'fresh')
    writeFileSync(normal, '{}')
    writeFileSync(foreignTmp, 'user file')
    writeFileSync(badSuffix, 'nope')
    ageFile(staleAtomic, 2 * 60 * 60_000, now)
    ageFile(staleDoctor, 30 * 60_000, now)
    ageFile(freshAtomic, 60_000, now)
    ageFile(foreignTmp, 3 * 60 * 60_000, now)
    ageFile(badSuffix, 3 * 60 * 60_000, now)

    const result = sweepTempFiles(dir, { now })
    assert.deepEqual(result, { removed: 2, bytes: 150 })
    assert.equal(existsSync(staleAtomic), false, '过期原子写临时文件应删除')
    assert.equal(existsSync(staleDoctor), false, 'doctor 探针临时文件应删除')
    assert.equal(existsSync(freshAtomic), true, '10 分钟内仍在写的临时文件不能删')
    assert.equal(existsSync(normal), true, '正常数据文件不能删')
    assert.equal(existsSync(foreignTmp), true, '同名后缀的用户临时文件不能删')
    assert.equal(existsSync(badSuffix), true, '不符合本插件命名规则的文件不能删')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('临时文件清理：目录不存在或没有孤儿时返回 0，不抛异常', () => {
  const missing = join(tmpdir(), `dsh-rpc-missing-${String(Date.now())}`)
  assert.deepEqual(sweepTempFiles(missing), { removed: 0, bytes: 0 })

  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-sweep-empty-'))
  try {
    writeFileSync(join(dir, 'events.json'), '{}')
    assert.deepEqual(sweepTempFiles(dir), { removed: 0, bytes: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('临时文件清理：maxAgeMs 可调，0 表示连刚写完的也清', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-sweep-zero-'))
  try {
    const temp = join(dir, '.events.json.1.deadbeef.tmp')
    writeFileSync(temp, 'x')
    assert.deepEqual(sweepTempFiles(dir, { maxAgeMs: 60_000 }), { removed: 0, bytes: 0 })
    // 文件系统 mtime 只精确到秒级时，「刚写完」可能比 Date.now() 略晚；
    // 显式把 now 推到之后，避免 maxAgeMs:0 在并发跑测试时被时间抖动干扰。
    assert.deepEqual(sweepTempFiles(dir, { maxAgeMs: 0, now: Date.now() + 5000 }), { removed: 1, bytes: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
