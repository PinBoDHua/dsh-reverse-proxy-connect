import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { pluginVersion } from '../lib/index.js'
import { STATUS_VERSION } from '../lib/protocol.js'
import { EVENT_VERSION } from '../lib/events.js'

test('插件版本与 package.json 一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pluginVersion, pkg.version)
})

test('版本号是可显示的三段式', () => {
  assert.match(pluginVersion, /^\d+\.\d+\.\d+/)
})

test('客户端状态版本与宿主协议一致（避免旧 bundle 静默少渲染字段）', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const expected = Number(/EXPECTED_STATUS_VERSION = (\d+)/.exec(client)?.[1])
  assert.equal(expected, STATUS_VERSION)
  assert.equal(STATUS_VERSION, 8)
  assert.equal(EVENT_VERSION, 1)
})
