import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SettingsStore, defaults } from '../lib/settings.js'
import { applyCredentialRefresh, applyLoginAccount } from '../lib/accounts.js'

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

test('CLI 登录写回：登录等待期宿主新增的账号与续期的令牌不能被旧快照覆盖', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'settings.json')
    const token = (accessToken, refreshToken, uid) => ({
      accessToken,
      refreshToken,
      expiresAtMs: Date.now() + 3600_000,
      refreshExpiresAtMs: 0,
      domain: 'codebuddy.cn',
      uid,
      enterpriseId: '',
    })
    const base = defaults()
    base.accounts.workbuddy = [{ id: 'acc-old', label: '旧账号', enabled: true, token: token('TOKEN-OLD', 'R1', 'uid-old') }]
    base.activeAccount.workbuddy = 'acc-old'
    new SettingsStore(file).patch(base)

    // CLI 启动 `node lib/bin.js login` 时读到快照，然后开始等浏览器登录（最长 5 分钟）。
    const cli = new SettingsStore(file)
    // 等待期间宿主把旧账号令牌续期了，并且新增了一个账号（GUI 登录 / 后台写回）。
    const host = new SettingsStore(file)
    host.patch({
      accounts: {
        workbuddy: [
          { id: 'acc-old', label: '旧账号', enabled: true, token: token('TOKEN-REFRESHED', 'R2', 'uid-old') },
          { id: 'acc-host-new', label: '宿主新账号', enabled: true, token: token('TOKEN-HOST', 'R3', 'uid-host') },
        ],
      },
    })

    // 浏览器登录完成：走与 `bin.js login` 相同的落盘入口。
    applyLoginAccount(cli, 'workbuddy', {
      uid: 'uid-cli',
      label: '浏览器登录账号',
      token: token('TOKEN-CLI', 'R4', 'uid-cli'),
    })

    const saved = JSON.parse(readFileSync(file, 'utf8'))
    const rows = saved.accounts.workbuddy
    assert.ok(rows.some((row) => row.id === 'acc-host-new'), '等待期间宿主新增的账号必须保留')
    assert.equal(
      rows.find((row) => row.id === 'acc-old')?.token?.accessToken,
      'TOKEN-REFRESHED',
      '宿主续期后的令牌不能被回退成登录开始时的旧值',
    )
    const added = rows.find((row) => row.token?.uid === 'uid-cli')
    assert.ok(added !== undefined, '本次登录的账号必须写入')
    assert.equal(saved.activeAccount.workbuddy, added.id, '当前账号应指向本次登录的账号')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置读盘：更高版本的文件只读加载，拒绝降级写回', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'settings.json')
    const original = JSON.stringify({
      version: 3,
      qoder: { qoder: { pat: 'pt-NEW' } },
      future: { field: 'keep-me' },
    })
    writeFileSync(file, original)
    const store = new SettingsStore(file)
    assert.equal(store.get().qoder.qoder.pat, 'pt-NEW', '认识的字段仍然只读展示')
    assert.equal(store.writeBlocked, true)
    assert.match(store.loadError, /版本 v3/)
    assert.throws(() => store.patch({ checkin: { lastRunAt: 1 } }), /版本 v3/)
    assert.equal(readFileSync(file, 'utf8'), original, '拒绝写入时原文件必须一字不改')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置写盘：写锁在成功后释放，崩溃遗留的过期锁会被清理', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'settings.json')
    const store = new SettingsStore(file)
    store.patch({ checkin: { lastRunAt: 1 } })
    assert.equal(existsSync(`${file}.lock`), false, '正常写盘后不能留下锁文件')

    // 模拟进程崩溃留下的旧锁：超过 10 秒应视为过期，而不是让插件永远写不了。
    writeFileSync(`${file}.lock`, '12345')
    const old = new Date(Date.now() - 20_000)
    utimesSync(`${file}.lock`, old, old)
    store.patch({ checkin: { lastRunAt: 2 } })
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).checkin.lastRunAt, 2)
    assert.equal(existsSync(`${file}.lock`), false)
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
    assert.ok(store.loadError !== undefined, '读目录应当被当成不可读')
    assert.equal(store.unreadable, true)
    const before = store.get()
    assert.throws(() => store.patch({ checkin: { lastRunAt: 3 } }), /无法读取|拒绝写入/)
    assert.equal(store.get(), before, '写失败后内存值必须回滚')
    assert.equal(store.get().checkin.lastRunAt, defaults().checkin.lastRunAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置读盘：暂时读不到时拒绝写盘，文件恢复可读后继续（不能拿默认值覆盖账号）', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'settings.json')
    // 目录占住路径 = 读盘抛 EISDIR（与 Windows 上被杀毒/编辑器短暂占用同类）：
    // 必须判成「不可读」，而不是「坏文件 + 默认值」。
    mkdirSync(file)
    const store = new SettingsStore(file)
    assert.equal(store.unreadable, true)
    assert.equal(store.corruptPath, undefined, '读不出来时不该假装备份成功')
    assert.match(store.loadError, /不会写入/)
    assert.throws(() => store.patch({ checkin: { lastRunAt: 9 } }), /无法读取|拒绝写入/)
    assert.equal(store.get().checkin.lastRunAt, 0, '内存里只有默认值，不能写盘')

    // 用户把文件恢复成一份带 PAT 的合法设置后，下一次写盘应先重读、再合并。
    rmSync(file, { recursive: true, force: true })
    writeFileSync(file, JSON.stringify({ version: 2, qoder: { qoder: { pat: 'pt-KEEP' } } }))
    store.patch({ checkin: { lastRunAt: 9 } })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.qoder.qoder.pat, 'pt-KEEP', '恢复后必须保留原账号')
    assert.equal(saved.checkin.lastRunAt, 9)
    assert.equal(store.unreadable, false)
    assert.equal(store.loadError, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置读盘：JSON 顶层不是对象也算坏文件（先备份，不静默覆盖）', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'settings.json')
    writeFileSync(file, '[]')
    const store = new SettingsStore(file)
    assert.ok(store.loadError !== undefined)
    assert.ok(store.corruptPath !== undefined, '非对象 JSON 也必须先备份')
    assert.equal(readFileSync(store.corruptPath, 'utf8'), '[]')
    store.patch({ checkin: { lastRunAt: 1 } })
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).checkin.lastRunAt, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置读盘：坏文件备份失败时拒绝写盘（原文件是唯一副本）', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{"version":2,"qoder":{"qoder":{"pat":"pt-ONLY-COPY"}},')
    const RealDate = Date
    const fixed = new RealDate('2026-10-18T12:00:00Z')
    // 备份文件名精确到毫秒，并且会避开已存在的路径。把所有候选名都占成
    // 目录（stamp / stamp-1 … stamp-100），让 copyFileSync 必然失败。
    const stamp = fixed.toISOString().replace(/\D/g, '').slice(0, 17)
    for (let index = 0; index <= 100; index++) {
      mkdirSync(index === 0 ? `${file}.corrupt-${stamp}` : `${file}.corrupt-${stamp}-${String(index)}`)
    }
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length === 0 ? [fixed.getTime()] : args)) }
      static now() { return fixed.getTime() }
    }
    try {
      const store = new SettingsStore(file)
      assert.ok(store.loadError !== undefined)
      assert.equal(store.writeBlocked, true)
      assert.throws(() => store.patch({ checkin: { lastRunAt: 2 } }), /备份也失败|拒绝.*写入/)
      assert.match(readFileSync(file, 'utf8'), /pt-ONLY-COPY/, '拒绝写入时原文件必须原样保留')
    } finally {
      globalThis.Date = RealDate
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI 续期写回：按 id 局部 upsert，不覆盖等待期外部新增的账号与别的账号令牌', () => {
  // 用户可见行为：CLI 命令续期后令牌必须落盘（否则宿主之后续期失败要重新登录），
  // 但也不能把 CLI 启动时的旧快照整表写回、冲掉并发新增的账号。
  const dir = tempDir()
  try {
    const file = join(dir, 'settings.json')
    const token = (accessToken, refreshToken) => ({
      accessToken,
      refreshToken,
      expiresAtMs: Date.now() + 3600_000,
      refreshExpiresAtMs: 0,
      domain: 'codebuddy.cn',
      uid: 'uid-a',
      enterpriseId: '',
    })
    const base = defaults()
    base.accounts.workbuddy = [{ id: 'acc-old', label: '旧账号', enabled: true, token: token('TOKEN-OLD', 'R1') }]
    base.activeAccount.workbuddy = 'acc-old'
    new SettingsStore(file).patch(base)

    const cli = new SettingsStore(file) // CLI 命令启动时的快照（之后可能变旧）
    const host = new SettingsStore(file)
    // 等待期宿主：别的账号续期 + 新增一个账号。
    host.patch({
      accounts: {
        workbuddy: [
          { id: 'acc-old', label: '旧账号', enabled: true, token: token('TOKEN-HOST-REFRESHED', 'R2') },
          { id: 'acc-host-new', label: '等待期新增', enabled: true, token: token('TOKEN-HOST-NEW', 'R3') },
        ],
      },
    })

    // CLI 刷新拿到新 token，走与 bin.js makeRuntime 相同的写回入口。
    assert.equal(applyCredentialRefresh(cli, 'workbuddy', 'acc-old', token('TOKEN-CLI-REFRESHED', 'R4')), true)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    const rows = saved.accounts.workbuddy
    assert.ok(rows.some((row) => row.id === 'acc-host-new'), '等待期新增的账号必须保留')
    assert.equal(rows.find((row) => row.id === 'acc-old').token.accessToken, 'TOKEN-CLI-REFRESHED', 'CLI 续期令牌必须写回')
    assert.equal(rows.find((row) => row.id === 'acc-old').token.refreshToken, 'R4')

    // 已经删掉的账号不能被续期结果「复活」。
    assert.equal(applyCredentialRefresh(cli, 'workbuddy', 'ghost', token('X', 'Y')), false)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).accounts.workbuddy.some((row) => row.id === 'ghost'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
