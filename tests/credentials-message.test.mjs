import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { describeAuthCandidates, displayAuthPath } from '../lib/workbuddy/credentials.js'

test('凭证路径展示：环境变量缩写，不再展开完整用户目录', () => {
  const originalLocal = process.env.LOCALAPPDATA
  const originalRoaming = process.env.APPDATA
  process.env.LOCALAPPDATA = 'C:\\Users\\Test\\AppData\\Local'
  process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming'
  try {
    const local = `${process.env.LOCALAPPDATA}\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info`
    const roaming = `${process.env.APPDATA}\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info`
    assert.equal(displayAuthPath(local), '%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info')
    assert.equal(displayAuthPath(roaming), '%APPDATA%\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info')
    assert.ok(displayAuthPath(join(homedir(), 'x.info')).startsWith('~'))
  } finally {
    if (originalLocal === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = originalLocal
    if (originalRoaming === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalRoaming
  }
})

test('凭证候选描述：只展示主路径 + 位置数量，不重复同一文件名', () => {
  const originalLocal = process.env.LOCALAPPDATA
  const originalRoaming = process.env.APPDATA
  process.env.LOCALAPPDATA = 'C:\\Users\\Test\\AppData\\Local'
  process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming'
  try {
    const local = `${process.env.LOCALAPPDATA}\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info`
    const roaming = `${process.env.APPDATA}\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info`
    const text = describeAuthCandidates([local, roaming])
    assert.ok(text.startsWith('%LOCALAPPDATA%'))
    assert.ok(text.includes('等 2 个位置'))
    assert.ok(!text.includes(roaming), '不应再列出第二个完整路径')
    assert.ok(!text.includes(' / '), '不应再用 / 拼接两个路径')
    assert.equal(describeAuthCandidates([local]), '%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info')
    assert.equal(describeAuthCandidates([]), '')
    assert.equal(describeAuthCandidates(undefined), '')
  } finally {
    if (originalLocal === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = originalLocal
    if (originalRoaming === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalRoaming
  }
})
