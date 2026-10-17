import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { pluginVersion } from '../lib/index.js'

test('插件版本与 package.json 一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pluginVersion, pkg.version)
})

test('版本号是可显示的三段式', () => {
  assert.match(pluginVersion, /^\d+\.\d+\.\d+/)
})
