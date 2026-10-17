import assert from 'node:assert/strict'
import test from 'node:test'

import {
  accountsFor,
  activeAccountFor,
  isAccountUsable,
  isExhausted,
  newAccountId,
  normalizeAccount,
  pickSwitchTarget,
} from '../lib/accounts.js'
import { PROVIDERS } from '../lib/protocol.js'

const WB = PROVIDERS.workbuddy
const QG = PROVIDERS.qoderGlobal

/** 造一份最小设置。 */
function settingsWith(extra) {
  return {
    providers: {},
    workbuddy: { workbuddy: { authFile: '', electronPath: '', useMaximumContext: true } },
    qoder: { [QG]: { pat: '' } },
    accounts: {},
    activeAccount: {},
    ...extra,
  }
}

test('没有 accounts 字段时合成默认账号，行为与老版本一致', () => {
  const desktop = accountsFor(WB, settingsWith({}))
  assert.equal(desktop.length, 1)
  assert.equal(desktop[0].id, 'default')
  assert.equal(desktop[0].authFile, undefined, '空 authFile 表示读本机登录')

  const pat = accountsFor(QG, settingsWith({ qoder: { [QG]: { pat: 'tok' } } }))
  assert.equal(pat.length, 1)
  assert.equal(pat[0].pat, 'tok')
})

test('自定义账号按顺序列出，重复 id 被丢弃', () => {
  const settings = settingsWith({
    accounts: {
      [QG]: [
        { id: 'a', label: '小号', pat: 'p1' },
        { id: 'a', label: '重复', pat: 'p2' },
        { label: '无 id', pat: 'p3' },
        { id: 'c', label: '', pat: '' },
      ],
    },
  })
  const list = accountsFor(QG, settings)
  assert.deepEqual(list.map((account) => account.id), ['a', 'acc-2', 'c'])
  assert.equal(list[0].label, '小号')
  assert.equal(list[1].label, '无 id')
  assert.equal(list[2].label, '账号 3', '兜底名按已收录数量递增，不跳号')
  assert.equal(list[2].pat, undefined, '空 PAT 不该写入')
})

test('activeAccount 钉住优先，否则取第一个启用的', () => {
  const settings = settingsWith({
    accounts: { [QG]: [{ id: 'a', pat: 'p1' }, { id: 'b', pat: 'p2' }, { id: 'c', pat: 'p3', enabled: false }] },
    activeAccount: { [QG]: 'b' },
  })
  assert.equal(activeAccountFor(QG, settings).id, 'b')

  settings.activeAccount[QG] = 'missing'
  assert.equal(activeAccountFor(QG, settings).id, 'a')

  settings.activeAccount[QG] = 'c'
  assert.equal(activeAccountFor(QG, settings).id, 'c', '钉住的账号即使禁用也尊重用户选择')
})

test('账号可用性：桌面账号允许空路径，PAT 账号必须有令牌', () => {
  assert.equal(isAccountUsable({ id: 'x', enabled: true }), true, '桌面默认账号')
  assert.equal(isAccountUsable({ id: 'x', enabled: true, authFile: 'C:/a.info' }), true)
  assert.equal(isAccountUsable({ id: 'x', enabled: true, pat: '' }), false)
  assert.equal(isAccountUsable({ id: 'x', enabled: true, pat: 'tok' }), true)
  assert.equal(isAccountUsable({ id: 'x', enabled: false, pat: 'tok' }), false)
})

test('额度耗尽判定：0 / 超额 / 不限量', () => {
  assert.equal(isExhausted({ state: 'ok', remain: 0 }), true)
  assert.equal(isExhausted({ state: 'ok', remain: 1 }), false)
  assert.equal(isExhausted({ state: 'ok', remain: 5, exceeded: true }), true)
  assert.equal(isExhausted({ state: 'ok', remain: 0, unlimited: true }), false)
  assert.equal(isExhausted({ state: 'none' }), false, '读不到不算耗尽')
})

test('自动切换：优先挑还有余额且可用的账号', () => {
  const settings = settingsWith({
    accounts: { [QG]: [{ id: 'a', pat: 'p1' }, { id: 'b', pat: 'p2' }, { id: 'c', pat: 'p3' }] },
    activeAccount: { [QG]: 'a' },
  })
  const balances = {
    a: { state: 'ok', remain: 0 },
    b: { state: 'ok', remain: 0 },
    c: { state: 'ok', remain: 42 },
  }
  const target = pickSwitchTarget(QG, settings, 'a', (id) => balances[id])
  assert.equal(target?.id, 'c')

  // 都没余额 → 不切换
  balances.c = { state: 'ok', remain: 0 }
  assert.equal(pickSwitchTarget(QG, settings, 'a', (id) => balances[id]), undefined)

  // 禁用账号不参与
  balances.c = { state: 'ok', remain: 9 }
  settings.accounts[QG][2].enabled = false
  assert.equal(pickSwitchTarget(QG, settings, 'a', (id) => balances[id]), undefined)
})

test('newAccountId 跳过已占用的 id', () => {
  assert.equal(newAccountId([]), 'acc-1')
  assert.equal(newAccountId([{ id: 'acc-1' }, { id: 'acc-2' }]), 'acc-3')
})

test('normalizeAccount 丢弃非对象与超长标签', () => {
  assert.equal(normalizeAccount(QG, null, 0), undefined)
  assert.equal(normalizeAccount(QG, 'x', 0), undefined)
  const long = normalizeAccount(QG, { id: 'a', label: 'x'.repeat(80), pat: 'p' }, 0)
  assert.equal(long.label.length, 40)
})
