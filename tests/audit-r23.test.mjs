/**
 * 第 23 轮审计的回归用例。
 *
 * 每条都对应一个可复现的缺陷（修前 FAIL / 修后 PASS）：
 * - 删掉一个「已经不存在的账号」会把隐式默认账号物化为显式行，冻结当时的
 *   PAT / 登录路径 —— 之后 CLI 更新的 provider 级凭证永远不生效；
 * - Qoder 的活动领取把 HTTP 200 + 业务失败体当成已领取：签到显示成功、
 *   当天不再重试，而奖励一分未到账。
 *
 * @module dsh-reverse-proxy-connect/tests/audit-r23
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { accountsFor, mergeAccountSecrets } from '../lib/accounts.js'
import { qoderClaimCampaigns } from '../lib/checkin.js'
import { apply } from '../lib/index.js'
import { DATA_DIR_NAME, PROVIDERS, SETTINGS_PATH, STATUS_PATH } from '../lib/protocol.js'
import { defaults } from '../lib/settings.js'

/** 临时目录。 */
function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `dsh-r23-${tag}-`))
}

/** 等一小会儿。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('账号池：删除一个不存在的账号不会把隐式默认账号物化', () => {
  const current = defaults()
  current.qoder[PROVIDERS.qoder].pat = 'pat-1'

  // 另一个窗口已经删过这个 id：本窗口再删一次是常态。
  const merged = mergeAccountSecrets({
    removedAccounts: { [PROVIDERS.qoder]: ['acc-x'] },
  }, current)
  assert.deepEqual(merged.accounts[PROVIDERS.qoder], [], '空池删一个不存在的 id 仍是空池')

  // 空数组补丁同理（客户端可能发一个空的增量列表）。
  const empty = mergeAccountSecrets({ accounts: { [PROVIDERS.qoder]: [] } }, current)
  assert.deepEqual(empty.accounts[PROVIDERS.qoder], [], '空增量不应物化默认账号')

  // 池仍是空的 → accountsFor 继续读旧字段里的 PAT（CLI 之后更新的值必须生效）。
  const view = {
    ...current,
    qoder: { ...current.qoder, [PROVIDERS.qoder]: { pat: 'pat-2' } },
    accounts: { ...current.accounts, [PROVIDERS.qoder]: merged.accounts[PROVIDERS.qoder] },
  }
  assert.equal(accountsFor(PROVIDERS.qoder, view)[0].pat, 'pat-2', 'provider 级 PAT 仍是最新值')

  // 真正新增账号时，隐式默认账号仍必须一起物化，否则它会被新行取代。
  const added = mergeAccountSecrets({
    accounts: { [PROVIDERS.qoder]: [{ id: 'acc-2', label: '备用', pat: 'pat-b' }] },
  }, current)
  const rows = added.accounts[PROVIDERS.qoder]
  assert.equal(rows.length, 2, '新增账号时要保留隐式默认账号')
  assert.equal(rows.find((row) => row.id === 'default')?.pat, 'pat-1')
  assert.equal(rows.find((row) => row.id === 'acc-2')?.pat, 'pat-b')
})

test('设置接口：删除不存在的账号不会把默认账号写进 settings.json', async () => {
  const root = tempDir('remove-ghost')
  const dataDir = join(root, DATA_DIR_NAME)
  mkdirSync(dataDir, { recursive: true })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '{}' })
  const host = fakeHost(root)
  try {
    apply(host.ctx, {})
    await sleep(60)
    const first = await hostGet(host.handlers[STATUS_PATH], STATUS_PATH)
    const response = await hostPost(host.handlers[SETTINGS_PATH], SETTINGS_PATH, {
      removedAccounts: { [PROVIDERS.qoder]: ['acc-x'] },
    }, first.body.key)
    assert.equal(response.status, 200)
    const settings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
    assert.deepEqual(settings.accounts?.[PROVIDERS.qoder] ?? [], [], '没删到东西就不该写账号行')
    assert.equal(settings.qoder[PROVIDERS.qoder].pat, '', '旧字段里的空 PAT 保持不变')
  } finally {
    globalThis.fetch = originalFetch
    for (const dispose of host.disposers.reverse()) {
      try { dispose() } catch { /* 已停止 */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('Qoder 领取：HTTP 200 的业务失败体不能算成已领取', async () => {
  const originalFetch = globalThis.fetch
  const bodies = {
    c1: { code: 400, message: '活动已结束' },
    c2: { code: 0, data: { credit: 5 } },
  }
  const claimCalls = []
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/sash/api/v1/me/campaigns') && !target.includes('/claim')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          campaigns: [
            { campaignId: 'c1', title: '活动一', actionType: 'CLAIM_BENEFIT', claimStatus: 'AVAILABLE' },
            { campaignId: 'c2', title: '活动二', actionType: 'CLAIM_BENEFIT', claimStatus: 'AVAILABLE' },
          ],
        }),
      }
    }
    const match = /\/campaigns\/([^/]+)\/claim/.exec(target)
    if (match !== null) {
      claimCalls.push(match[1])
      return { ok: true, status: 200, json: async () => bodies[match[1]] }
    }
    throw new Error(`unexpected fetch ${target}`)
  }
  try {
    const identity = { authToken: 'job-token' }
    const mixed = await qoderClaimCampaigns(identity, 'global')
    assert.equal(claimCalls.length, 2, '两个可领活动都应尝试一次')
    assert.equal(mixed.kind, 'claimed', '有一个真的领到了')
    assert.equal(mixed.claimed, 1, '业务失败的 c1 不能计数')
    assert.equal(mixed.credit, 5, '只累计真正到账的积分')
    assert.match(String(mixed.message), /另有一项失败/, '部分失败要在文案里说出来')

    // 全部业务失败：必须返回 failed（保留 10 分钟重试），而不是假的「已领取」。
    bodies.c1 = { code: 110, message: '额度已用尽' }
    bodies.c2 = { success: false, message: '活动已结束' }
    claimCalls.length = 0
    const allFailed = await qoderClaimCampaigns(identity, 'global')
    assert.equal(allFailed.kind, 'failed', '全部业务失败时不能报告成功')
    assert.match(String(allFailed.message), /额度已用尽/, '保留上游的失败原因')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Qoder 领取：业务失败体的判据保守且可区分', async () => {
  const originalFetch = globalThis.fetch
  const bodies = {
    c1: { code: '200' },
    c2: { success: true, code: 1001 },
  }
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/sash/api/v1/me/campaigns') && !target.includes('/claim')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          campaigns: [
            { campaignId: 'c1', title: '活动一', actionType: 'CLAIM_BENEFIT', claimStatus: 'AVAILABLE' },
            { campaignId: 'c2', title: '活动二', actionType: 'CLAIM_BENEFIT', claimStatus: 'AVAILABLE' },
          ],
        }),
      }
    }
    const match = /\/campaigns\/([^/]+)\/claim/.exec(target)
    if (match !== null) return { ok: true, status: 200, json: async () => bodies[match[1]] }
    throw new Error(`unexpected fetch ${target}`)
  }
  try {
    // 200 / success:true 都是上游用过的「成功」形状；空响应体同理（无法证明失败）。
    const outcome = await qoderClaimCampaigns({ authToken: 'job-token' }, 'global')
    assert.equal(outcome.kind, 'claimed', '成功码 / success:true 不能被当成失败')
    assert.equal(outcome.claimed, 2)
    assert.equal(outcome.credit, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

/** 收集路由与 disposer 的最小宿主。 */
function fakeHost(root) {
  const handlers = {}
  const disposers = []
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { dir: root }
      return undefined
    },
    inject(names, callback) {
      if (names.includes('webServer')) {
        callback({
          webServer: {
            register(route) {
              handlers[route.path] = route.handler
              return () => { delete handlers[route.path] }
            },
          },
          effect(fn) {
            const dispose = fn()
            disposers.push(dispose)
            return dispose
          },
        })
      }
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    llm: { registerAdapter() { return () => {} } },
    emit() {},
    logger: { info() {}, warn() {} },
  }
  return { handlers, disposers, ctx }
}

/** 发一个带控制密钥的 GET。 */
async function hostGet(handler, url) {
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const res = {
    status: 0,
    body: '',
    writeHead(status) { res.status = status; return res },
    end(chunk) { res.body = chunk === undefined ? '' : String(chunk); resolveDone() },
  }
  handler({
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:65466' },
    socket: { remoteAddress: '127.0.0.1' },
  }, res)
  await done
  return { status: res.status, body: JSON.parse(res.body) }
}

/** 发一个带控制密钥与 JSON 体的 POST。 */
async function hostPost(handler, url, body, key) {
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const res = {
    status: 0,
    body: '',
    writeHead(status) { res.status = status; return res },
    setHeader() {},
    end(chunk) { res.body = chunk === undefined ? '' : String(chunk); resolveDone() },
  }
  const req = new EventEmitter()
  Object.assign(req, {
    method: 'POST',
    url,
    headers: {
      host: '127.0.0.1:65466',
      'x-rpc-key': key,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(JSON.stringify(body))),
    },
    socket: { remoteAddress: '127.0.0.1' },
  })
  handler(req, res)
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  await done
  return { status: res.status, body: JSON.parse(res.body) }
}
