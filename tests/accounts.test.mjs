import assert from 'node:assert/strict'
import test from 'node:test'

import {
  accountsFor,
  activeAccountFor,
  isAccountUsable,
  isBelowThreshold,
  isExhausted,
  mergeAccountSecrets,
  newAccountId,
  normalizeAccount,
  pickFailoverCandidates,
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
  assert.equal(activeAccountFor(QG, settings).id, 'a', '钉住的账号被禁用时让位给第一个启用的账号（禁用是更强的信号）')
})

test('低于阈值提前换号：不会切到另一个同样低的账号', () => {
  assert.equal(isBelowThreshold({ state: 'ok', remain: 10, total: 100 }, 0.15), true)
  assert.equal(isBelowThreshold({ state: 'ok', remain: 20, total: 100 }, 0.15), false)
  assert.equal(isBelowThreshold({ state: 'ok', remain: 0, total: 0 }, 0.15), false)
  assert.equal(isBelowThreshold({ state: 'ok', remain: 1, total: 100, stale: true }, 0.15), false)
  assert.equal(isBelowThreshold({ state: 'ok', remain: 1, total: 100 }, 0), false)

  const settings = settingsWith({
    accounts: { [QG]: [{ id: 'a', pat: 'p1' }, { id: 'b', pat: 'p2' }, { id: 'c', pat: 'p3' }] },
  })
  const credits = {
    a: { state: 'ok', remain: 10, total: 100 },
    b: { state: 'ok', remain: 10, total: 100 },
    c: { state: 'ok', remain: 90, total: 100 },
  }
  const target = pickSwitchTarget(QG, settings, 'a', (id) => credits[id], { minRatio: 0.15 })
  assert.equal(target.id, 'c', 'b 也低于阈值，不应该切过去')
})

test('请求失败换号：排除刚失败的账号，优先额度明确可用的', () => {
  const settings = settingsWith({
    accounts: { [QG]: [{ id: 'a', pat: 'p1' }, { id: 'b', pat: 'p2' }, { id: 'c', pat: 'p3' }, { id: 'd', pat: 'p4', enabled: false }] },
  })
  const credits = {
    a: { state: 'ok', remain: 0 },
    b: { state: 'none' },
    c: { state: 'ok', remain: 10 },
    d: { state: 'ok', remain: 10 },
  }
  const list = pickFailoverCandidates(QG, settings, 'a', (id) => credits[id], { isCoolingDown: (id) => id === 'c' })
  assert.deepEqual(list.map((account) => account.id), ['b'], 'c 冷却中被跳过、d 被禁用、a 是当前账号')
})

test('账号更新是增量 upsert：没提到的账号与密钥都保留', () => {
  const settings = settingsWith({
    accounts: {
      [QG]: [
        { id: 'a', label: 'A', pat: 'keep-a' },
        { id: 'b', label: 'B', pat: 'keep-b' },
      ],
    },
  })
  const merged = mergeAccountSecrets({ accounts: { [QG]: [{ id: 'a', label: 'A2' }] } }, settings)
  assert.deepEqual(merged.accounts[QG].map((account) => account.id), ['a', 'b'])
  assert.equal(merged.accounts[QG][0].label, 'A2')
  assert.equal(merged.accounts[QG][0].pat, 'keep-a', '没带 pat 时沿用旧密钥')
  assert.equal(merged.accounts[QG][1].pat, 'keep-b', '没提到的账号原样保留')
})

test('账号删除必须显式 removedAccounts；forget 清空单个账号密钥', () => {
  const settings = settingsWith({
    accounts: {
      [QG]: [
        { id: 'a', label: 'A', pat: 'pa' },
        { id: 'b', label: 'B', pat: 'pb' },
      ],
    },
  })
  const removed = mergeAccountSecrets({ removedAccounts: { [QG]: ['a'] } }, settings)
  assert.deepEqual(removed.accounts[QG].map((account) => account.id), ['b'])
  assert.equal(removed.accounts[QG][0].pat, 'pb')

  const forgot = mergeAccountSecrets({ accounts: { [QG]: [{ id: 'b', forget: true }] } }, settings)
  assert.equal(forgot.accounts[QG].find((account) => account.id === 'b').pat, undefined)
  assert.equal(forgot.accounts[QG].find((account) => account.id === 'b').forget, undefined, 'forget 不应写进设置')
})

test('账号可用性：桌面账号允许空路径，PAT 账号必须有令牌', () => {
  assert.equal(isAccountUsable({ id: 'x', enabled: true }), true, '桌面默认账号')
  assert.equal(isAccountUsable({ id: 'x', enabled: true, authFile: 'C:/a.info' }), true)
  assert.equal(isAccountUsable({ id: 'x', enabled: true, pat: '' }), false)
  assert.equal(isAccountUsable({ id: 'x', enabled: true, pat: 'tok' }), true)
  assert.equal(isAccountUsable({ id: 'x', enabled: false, pat: 'tok' }), false)
  // 带 provider 时必须区分两种凭证类型：PAT 账号的空 authFile 不是「本机登录」。
  assert.equal(isAccountUsable({ id: 'x', enabled: true }, QG), false, '未配置 PAT 的 Qoder 账号不可用')
  assert.equal(isAccountUsable({ id: 'x', enabled: true, pat: 'tok' }, QG), true)
  assert.equal(isAccountUsable({ id: 'x', enabled: true }, WB), true, '桌面账号空路径 = 本机登录')
  assert.equal(isAccountUsable({ id: 'x', enabled: true, authFile: 'C:/a.info' }, WB), true)
})

test('额度耗尽判定：0 / 超额 / 不限量', () => {
  assert.equal(isExhausted({ state: 'ok', remain: 0 }), true)
  assert.equal(isExhausted({ state: 'ok', remain: 1 }), false)
  assert.equal(isExhausted({ state: 'ok', remain: 5, exceeded: true }), true)
  assert.equal(isExhausted({ state: 'ok', remain: 0, unlimited: true }), false)
  assert.equal(isExhausted({ state: 'none' }), false, '读不到不算耗尽')
  // Qoder Free 的 0 是付费额度为 0，免费模型仍可用，不能算耗尽。
  assert.equal(isExhausted({ state: 'ok', remain: 0, total: 0, exceeded: true, planName: 'Free' }, QG), false)
  assert.equal(isExhausted({ state: 'ok', remain: 0, total: 0, exceeded: true, paid: false }, QG), false)
  assert.equal(isExhausted({ state: 'ok', remain: 0, total: 0, exceeded: true, planName: 'Pro', paid: true }, QG), true)
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

  // 「读不到、保留上次结果」不能当作可切换依据
  settings.accounts[QG][2].enabled = true
  balances.c = { state: 'ok', remain: 9, error: '读取失败' }
  assert.equal(pickSwitchTarget(QG, settings, 'a', (id) => balances[id]), undefined)
  balances.c = { state: 'ok', remain: 9, stale: true }
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
