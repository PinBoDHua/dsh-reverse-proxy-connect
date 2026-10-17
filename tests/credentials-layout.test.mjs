import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { VARIANTS, resolveAppBinary } from '../lib/workbuddy/credentials.js'

test('显式 App 路径：macOS Electron 布局可以识别，不再要求 .exe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-layout-'))
  try {
    const macos = join(dir, 'WorkBuddy.app', 'Contents', 'MacOS')
    const resources = join(dir, 'WorkBuddy.app', 'Contents', 'Resources')
    mkdirSync(macos, { recursive: true })
    mkdirSync(resources, { recursive: true })
    const electron = join(macos, 'Electron')
    writeFileSync(electron, '')
    writeFileSync(join(resources, 'app.asar'), '')
    assert.equal(await resolveAppBinary(VARIANTS.workbuddy, electron), electron)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('显式 App 路径：Linux Electron 布局（resources/app.asar）也可以识别', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-layout-'))
  try {
    mkdirSync(join(dir, 'resources'), { recursive: true })
    const binary = join(dir, 'workbuddy')
    writeFileSync(binary, '')
    writeFileSync(join(dir, 'resources', 'app.asar'), '')
    assert.equal(await resolveAppBinary(VARIANTS.workbuddy, binary), binary)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('显式 App 路径：不像 Electron 应用时仍然拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-layout-'))
  try {
    const fake = join(dir, 'workbuddy.exe')
    writeFileSync(fake, '')
    await assert.rejects(() => resolveAppBinary(VARIANTS.workbuddy, fake), (error) => error?.code === 'app-path-invalid')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
