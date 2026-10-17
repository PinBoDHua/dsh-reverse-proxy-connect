import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SettingsStore, defaults } from '../lib/settings.js'

/** 临时目录。 */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-rpc-settings-'))
}

test('设置读盘：UTF-8 BOM 与 UTF-16LE 都不会被当成坏文件', () => {
  const dir = tempDir()
  try {
    const utf8 = join(dir, 'bom.json')
    writeFileSync(utf8, `\uFEFF${JSON.stringify({ version: 2, qoder: { qoder: { pat: 'pt-SECRET' } } })}`)
    assert.equal(new SettingsStore(utf8).get().qoder.qoder.pat, 'pt-SECRET')

    const utf16 = join(dir, 'utf16.json')
    writeFileSync(utf16, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(JSON.stringify({ version: 2, qoder: { qoder: { pat: 'pt-UTF16' } } }), 'utf16le'),
    ]))
    assert.equal(new SettingsStore(utf16).get().qoder.qoder.pat, 'pt-UTF16')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置读盘：坏文件先备份再退回默认值，原内容不会凭空消失', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{"version":2,"qoder":{"qoder":{"pat":"pt-KEEP"}},')
    const store = new SettingsStore(file)
    assert.ok(store.loadError !== undefined)
    assert.ok(store.corruptPath !== undefined && existsSync(store.corruptPath))
    assert.match(readFileSync(store.corruptPath, 'utf8'), /pt-KEEP/)
    assert.equal(store.get().qoder.qoder.pat, '')
    // 自动写盘仍然可用（用户之后可以重新配置），但坏文件已经被备份。
    store.patch({ checkin: { lastRunAt: 1 } })
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).checkin.lastRunAt, 1)
    assert.match(readFileSync(store.corruptPath, 'utf8'), /pt-KEEP/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置写盘：另一个进程改过文件时先重读再合并，不能拿旧快照覆盖新账号', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'settings.json')
    const first = new SettingsStore(file)
    first.patch({ qoder: { qoder: { pat: 'pt-OLD' } } })

    // 模拟 CLI 使用另一份 SettingsStore 写入新账号。
    const cli = new SettingsStore(file)
    cli.patch({ accounts: { qoder: [{ id: 'cli-acc', label: 'CLI 新账号', pat: 'pt-CLI' }] } })

    // 宿主内存里还是旧值；下一次自动写必须保留 CLI 的账号。
    first.patch({ checkin: { lastRunAt: 2 } })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.accounts.qoder.find((account) => account.id === 'cli-acc')?.pat, 'pt-CLI')
    assert.equal(saved.checkin.lastRunAt, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置写盘失败会抛错并回滚内存值，而不是假装保存成功', () => {
  const dir = tempDir()
  try {
    // 把目标路径做成目录：rename 到目录会失败（EISDIR/EPERM）。
    const target = join(dir, 'settings.json')
    mkdirSync(target)
    const store = new SettingsStore(target)
    assert.ok(store.loadError !== undefined, '读目录应当被当成坏文件')
    const before = store.get()
    assert.throws(() => store.patch({ checkin: { lastRunAt: 3 } }))
    assert.equal(store.get(), before, '写失败后内存值必须回滚')
    assert.equal(store.get().checkin.lastRunAt, defaults().checkin.lastRunAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
