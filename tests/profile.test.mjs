// profile / 数据目录解析：CLI 与宿主必须指向同一份设置。
//
// 旧实现里 CLI 找不到 DSH_PROFILE_DIR 时会退回 ~/.dsh，于是 README 里的
// `node lib/bin.js status` 读到的是另一份空设置，看起来像插件没装。

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { resolveDataDir, resolveProfileDir } from '../lib/profile.js'

test('profile：显式 DSH_PROFILE_DIR 优先，且必须真实存在', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-profile-'))
  try {
    const profile = join(root, 'custom-profile')
    mkdirSync(profile)
    assert.equal(resolveProfileDir({ DSH_PROFILE_DIR: profile }), resolve(profile))
    assert.throws(() => resolveProfileDir({ DSH_PROFILE_DIR: join(root, 'missing') }), /不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('profile：没有显式变量时优先 $DSH_HOME/profiles/desktop', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-rpc-home-'))
  try {
    const desktop = join(home, 'profiles', 'desktop')
    mkdirSync(desktop, { recursive: true })
    assert.equal(resolveProfileDir({ DSH_HOME: home }), resolve(desktop))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('profile：只有一个自定义 profile 时自动选中；多个时要求显式指定', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-rpc-home-'))
  try {
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    assert.equal(resolveProfileDir({ DSH_HOME: home }), join(home, 'profiles', 'web'))
    mkdirSync(join(home, 'profiles', 'cli'), { recursive: true })
    assert.throws(() => resolveProfileDir({ DSH_HOME: home }), /多个 profile/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('数据目录：DSH_REVERSE_PROXY_DATA_DIR 覆盖优先，否则落在 profile 下', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-profile-'))
  try {
    const profile = join(root, 'profile')
    mkdirSync(profile)
    assert.equal(resolveDataDir({ DSH_PROFILE_DIR: profile }), join(profile, '.dsh-reverse-proxy-connect'))
    const custom = join(root, 'data')
    assert.equal(resolveDataDir({ DSH_REVERSE_PROXY_DATA_DIR: custom, DSH_PROFILE_DIR: profile }), resolve(custom))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
