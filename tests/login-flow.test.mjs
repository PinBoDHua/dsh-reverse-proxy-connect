import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { findAuthFile, peekAuthIdentity, snapshotAuthFile, startLoginWatch } from '../lib/workbuddy/login-flow.js'

/** 造一个登录文件。 */
function writeAuth(file, uid, extra = {}) {
  writeFileSync(file, JSON.stringify({
    account: { uid, uin: '330100120012' },
    auth: { domain: 'copilot.tencent.com', ...extra },
    accounts: [],
    allAccounts: [],
  }), 'utf8')
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-login-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 异步版：等 fn 真的结束再删目录。 */
async function withTempDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-login-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 轮询等待条件成立。 */
async function waitFor(predicate, timeoutMs = 8000, stepMs = 50) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return false
}

test('peekAuthIdentity 只读明文 uid，不碰加密字段', () => {
  withTempDir((dir) => {
    const file = join(dir, 'workbuddy-desktop.info')
    writeAuth(file, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      accessToken: { $wbEncrypted: 1, envelope: 'xxx' },
    })
    const identity = peekAuthIdentity(file)
    assert.equal(identity.uid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    assert.equal(identity.uin, '330100120012')
    assert.equal(identity.domain, 'copilot.tencent.com')
    assert.ok(identity.mtimeMs > 0)
  })
})

test('peekAuthIdentity 对坏文件返回 undefined，不抛', () => {
  withTempDir((dir) => {
    const file = join(dir, 'bad.info')
    writeFileSync(file, '{ not json', 'utf8')
    assert.equal(peekAuthIdentity(file), undefined)
    assert.equal(peekAuthIdentity(join(dir, 'missing.info')), undefined)
  })
})

test('snapshotAuthFile 按 uid 命名，同一账号重复登录覆盖同一份', () => {
  withTempDir((dir) => {
    const source = join(dir, 'workbuddy-desktop.info')
    writeAuth(source, 'uid-1')
    const first = snapshotAuthFile(dir, 'workbuddy', 'uid-1', source)
    assert.ok(first.endsWith('workbuddy-uid-1.info'))
    writeAuth(source, 'uid-1', { accessToken: 'changed' })
    const second = snapshotAuthFile(dir, 'workbuddy', 'uid-1', source)
    assert.equal(first, second)
    assert.equal(JSON.parse(readFileSync(second, 'utf8')).auth.accessToken, 'changed')
  })
})

test('findAuthFile 优先显式路径，否则回落到默认候选', () => {
  withTempDir((dir) => {
    const explicit = join(dir, 'custom.info')
    writeAuth(explicit, 'x')
    assert.equal(findAuthFile('workbuddy', explicit), explicit)
    // 显式路径不存在时不报错，而是回落到默认候选；本机装了 App 就会命中，
    // 没装则返回 undefined —— 两种都算正常，只断言「不抛且不是那个不存在的路径」。
    const fallback = findAuthFile('workbuddy', join(dir, 'missing.info'))
    assert.notEqual(fallback, join(dir, 'missing.info'))
    if (fallback !== undefined) assert.ok(fallback.endsWith('workbuddy-desktop.info'))
  })
})

test('登录流程：检测到新 uid 后自动快照并进入 done', async () => {
  await withTempDirAsync(async (dir) => {
    const file = join(dir, 'workbuddy-desktop.info')
    writeAuth(file, 'old-uid')

    let done
    const job = startLoginWatch({
      variantId: 'workbuddy',
      dataDir: dir,
      explicitAuthFile: file,
      spawn: () => ({ unref() {} }),
      pollMs: 30,
      timeoutMs: 8000,
      onDone: (state) => { done = state },
    })

    assert.equal(job.state.phase, 'starting')
    assert.ok(await waitFor(() => job.state.phase === 'waiting'), '没有进入 waiting')
    assert.equal(job.state.baselineUid, 'old-uid')

    // 等文件 mtime 稳定（实现里要求 mtime 距今 > 1s 才抓）
    await new Promise((resolve) => setTimeout(resolve, 1200))
    writeAuth(file, 'new-uid')

    assert.ok(await waitFor(() => job.state.phase === 'done'), `流程没有完成，当前 ${job.state.phase}`)
    assert.equal(job.state.uid, 'new-uid')
    assert.ok(done !== undefined, 'onDone 没有被调用')
    assert.equal(JSON.parse(readFileSync(job.state.account.snapshot, 'utf8')).account.uid, 'new-uid')
    job.cancel()
  })
})
