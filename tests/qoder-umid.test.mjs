import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import {
  __resetUmidCache,
  parseUmidBlock,
  readUmidBlock,
  umidBinaries,
  umidHeadersFor,
} from '../lib/qoder/umid.js'

/** 与实现约定一致的测试接缝名。 */
const UMID_PROBE = '__dshReverseProxyQoderUmidProbe'

beforeEach(() => {
  delete globalThis[UMID_PROBE]
  __resetUmidCache()
})

afterEach(() => {
  delete globalThis[UMID_PROBE]
  __resetUmidCache()
})

test('umid 解析：完整 JSON / 对象通过，缺字段、空串、坏 JSON 一律 null', () => {
  const block = { machineToken: 'tk', machineType: 'tp', machineCode: 'cd' }
  assert.deepEqual(parseUmidBlock(JSON.stringify(block)), block)
  assert.deepEqual(parseUmidBlock('\uFEFF' + JSON.stringify(block)), block, 'stdout 带 BOM 时也要能解析')
  assert.deepEqual(parseUmidBlock(block), block)

  assert.equal(parseUmidBlock('{not json'), null)
  assert.equal(parseUmidBlock(null), null)
  assert.equal(parseUmidBlock([]), null)
  assert.equal(parseUmidBlock({}), null)
  assert.equal(parseUmidBlock({ ...block, machineToken: '' }), null)
  assert.equal(parseUmidBlock({ ...block, machineType: '' }), null)
  assert.equal(parseUmidBlock({ ...block, machineCode: '' }), null)
  assert.equal(parseUmidBlock({ ...block, machineCode: 42 }), null)
})

test('umid 请求头：完整身份才发三件套，半份身份退回空对象', async () => {
  globalThis[UMID_PROBE] = () => ({ machineToken: 'tk', machineType: 'tp', machineCode: 'cd' })
  __resetUmidCache()
  assert.deepEqual(await umidHeadersFor(), {
    'Cosy-MachineToken': 'tk',
    'Cosy-MachineCode': 'cd',
    'Cosy-MachineType': 'tp',
  })

  globalThis[UMID_PROBE] = () => ({ machineToken: 'tk', machineType: 'tp' })
  __resetUmidCache()
  assert.deepEqual(await umidHeadersFor(), {}, '缺 machineCode 时必须整组不发')

  globalThis[UMID_PROBE] = () => {
    throw new Error('binary crashed')
  }
  __resetUmidCache()
  assert.deepEqual(await umidHeadersFor(), {}, '二进制抛错不能让签到崩掉')
})

test('umid 读取按进程缓存：两次调用只跑一次探针', async () => {
  let runs = 0
  globalThis[UMID_PROBE] = () => {
    runs += 1
    return { machineToken: 'tk', machineType: 'tp', machineCode: 'cd' }
  }
  __resetUmidCache()
  await readUmidBlock()
  await readUmidBlock()
  assert.equal(runs, 1, '并发/连续调用不能反复启动二进制')
})

test('umid 安装根：桌面端版本目录按数值新到旧，带空格的 Qoder CN 也覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-umid-'))
  const localAppData = join(dir, 'Local')
  const home = join(dir, 'home')
  const programs = join(localAppData, 'Programs')
  try {
    for (const version of ['0.4.9', '0.4.10', '0.4.3']) {
      mkdirSync(join(programs, 'Qoder', '.qoder-versions', version), { recursive: true })
    }
    mkdirSync(join(programs, 'Qoder CN', '.qoder-versions', '0.5.6'), { recursive: true })
    mkdirSync(join(home, '.qoder', '.bin', 'umid-win32-x64-hash'), { recursive: true })
    mkdirSync(join(home, '.qoder-cn', '.bin', 'umid-win32-x64-hash2'), { recursive: true })

    const binaries = umidBinaries({ platform: 'win32', env: { LOCALAPPDATA: localAppData }, home })
    const indexOf = (suffix) => binaries.findIndex((item) => item.endsWith(suffix))

    assert.ok(indexOf(join('Qoder', '.qoder-versions', '0.4.10', 'resources', 'umid', 'runtime-info.exe')) >= 0)
    assert.ok(indexOf(join('Qoder CN', '.qoder-versions', '0.5.6', 'resources', 'umid', 'runtime-info.exe')) >= 0)
    assert.ok(indexOf(join('.qoder', '.bin', 'umid-win32-x64-hash', 'runtime-info.exe')) >= 0)
    assert.ok(indexOf(join('.qoder-cn', '.bin', 'umid-win32-x64-hash2', 'runtime-info.exe')) >= 0)
    assert.ok(
      indexOf(join('.qoder-versions', '0.4.10', 'resources', 'umid', 'runtime-info.exe'))
        < indexOf(join('.qoder-versions', '0.4.9', 'resources', 'umid', 'runtime-info.exe')),
      '0.4.10 必须排在 0.4.9 前面（按数值而不是字典序）',
    )
    assert.equal(new Set(binaries).size, binaries.length, '候选路径不能重复')
    assert.deepEqual(umidBinaries({ platform: 'linux', env: { LOCALAPPDATA: localAppData }, home }), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
