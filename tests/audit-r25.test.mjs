// 第二十五轮审计（R25）回归测试。
//
// 覆盖本轮修复：Trae 强制续期消费、EOF 无终态帧记 incomplete、stats/history
// 卸载守卫、刷新兜底收敛、checkin 白名单补字段、账号删除墓碑、startAt 健壮性、
// umid 头校验、以及一批归一化/CLI/调度边界。

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  activeAccountFor,
  applyCredentialRefresh,
  loginAccountPatch,
  mergeAccountSecrets,
  normalizeAccount,
} from '../lib/accounts.js'
import { interpretQoderCampaigns } from '../lib/checkin.js'
import { checkinDue } from '../lib/checkin-schedule.js'
import { CreditHistory } from '../lib/credit-history.js'
import { refreshFallbackTargets, refreshTargetsOf } from '../lib/index.js'
import { sanitizePatch } from '../lib/patch.js'
import { parseUmidBlock, readUmidBlock, __resetUmidCache } from '../lib/qoder/umid.js'
import { readMachineId, parseStream as parseQoderStream } from '../lib/qoder/transport.js'
import { parseOpenAiSse } from '../lib/runtime.js'
import { normalize } from '../lib/settings.js'
import { Stats } from '../lib/stats.js'
import { resolveTraeCredential } from '../lib/trae/credential.js'
import { parseStream as parseTraeStream, traeCheckinHeaders } from '../lib/trae/transport.js'

/** 把若干段文本做成一个 SSE 字节流。 */
function textStream(chunks) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** 收集一条归一化事件流（过滤内部心跳）。 */
async function collect(stream) {
  const events = []
  for await (const event of stream) {
    if (event.type !== 'heartbeat') events.push(event)
  }
  return events
}

const tempDirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-r25-'))
  tempDirs.push(dir)
  return dir
}
test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

// ── Trae 强制续期（R24 T-5 的 Trae 半边） ─────────────────────────────

test('Trae：force 绕过本地时钟续期一次；不 force 仍复用未过期令牌', async () => {
  const stored = {
    accessToken: 'revoked-jwt',
    refreshToken: 'rt-1',
    // 3 天有效期：落在 Trae 1 天续期余量之外，plain 分支才不该续期。
    expiresAtMs: Date.now() + 3 * 86400_000,
    uid: 'u-1',
  }
  // 显式指向不存在的文件：隔离本机真实 Trae 登录，只测账号令牌分支。
  const authFile = join(tempDir(), 'missing-storage.json')
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({
        Result: { Token: 'new-jwt', RefreshToken: 'rt-2', TokenExpireAt: Date.now() + 7 * 86400_000 },
      }),
    }
  }
  try {
    const forced = await resolveTraeCredential({ variantId: 'trae', stored, authFile, force: true })
    assert.equal(forced.jwt, 'new-jwt')
    assert.equal(calls.length, 1)
    assert.match(calls[0], /ExchangeToken/)
    calls.length = 0
    const plain = await resolveTraeCredential({ variantId: 'trae', stored, authFile })
    assert.equal(plain.jwt, 'revoked-jwt')
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── EOF 无终态帧：宿主兼容 stop，统计标 incomplete ────────────────────

test('WorkBuddy SSE：EOF 无 [DONE]/finish_reason 标 incomplete；有终态帧不标', async () => {
  const truncated = await collect(parseOpenAiSse(textStream([
    'data: {"choices":[{"delta":{"content":"半截回答"}}]}\n',
  ])))
  const finish = truncated.find((event) => event.type === 'finish')
  assert.equal(finish.kind, 'stop')
  assert.equal(finish.incomplete, true)

  const complete = await collect(parseOpenAiSse(textStream([
    'data: {"choices":[{"delta":{"content":"完整"}}]}\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n',
    'data: [DONE]\n',
  ])))
  assert.equal(complete.find((event) => event.type === 'finish').incomplete, undefined)
})

test('Qoder SSE：EOF 无终态帧标 incomplete；[DONE] 不标', async () => {
  const frame = (inner) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n`
  const truncated = await collect(parseQoderStream(textStream([
    frame({ choices: [{ delta: { content: '半截' } }] }),
  ])))
  assert.equal(truncated.find((event) => event.type === 'finish').incomplete, true)

  const complete = await collect(parseQoderStream(textStream([
    frame({ choices: [{ delta: { content: '完整' } }] }),
    'data: [DONE]\n',
  ])))
  assert.equal(complete.find((event) => event.type === 'finish').incomplete, undefined)
})

test('Trae SSE：EOF 无 event:done/finish_reason 标 incomplete；done 帧不标', async () => {
  const truncated = await collect(parseTraeStream(textStream([
    'data: {"response":"半截"}\n',
  ])))
  assert.equal(truncated.find((event) => event.type === 'finish').incomplete, true)

  const complete = await collect(parseTraeStream(textStream([
    'data: {"response":"完整"}\n',
    'event: done\ndata: \n\n',
  ])))
  assert.equal(complete.find((event) => event.type === 'finish').incomplete, undefined)
})

// ── 卸载后不再记账/写盘 ───────────────────────────────────────────────

test('Stats：stop() 后 record 拒绝且不挂定时器', () => {
  const stats = new Stats({ filePath: join(tempDir(), 'stats.json'), persistDelayMs: 10 })
  assert.equal(stats.record({ provider: 'qoder', kind: 'stop', at: Date.now(), durationMs: 10, totalTokens: 1 }), true)
  stats.stop()
  assert.equal(stats.record({ provider: 'qoder', kind: 'stop', at: Date.now(), durationMs: 10, totalTokens: 1 }), false)
  assert.equal(stats.timer, undefined)
})

test('CreditHistory：stop() 后 record 拒绝且不挂定时器', () => {
  const history = new CreditHistory({ filePath: join(tempDir(), 'history.json'), persistDelayMs: 10 })
  const credits = { state: 'ok', remain: 10, total: 100 }
  assert.equal(history.record('qoder', 'default', credits, Date.now()), true)
  history.stop()
  assert.equal(history.record('qoder', 'default', credits, Date.now()), false)
  assert.equal(history.timer, undefined)
})

// ── 刷新兜底收敛（B-3 残留） ──────────────────────────────────────────

test('刷新兜底：改名/停用/改 App 路径只刷补丁里那一家，且不刷额度', () => {
  assert.deepEqual(refreshFallbackTargets({ accounts: { qoder: [{ id: 'a', label: '新名字' }] } }), [
    { provider: 'qoder', credits: false },
  ])
  assert.deepEqual(refreshFallbackTargets({ accounts: { trae: [{ id: 'a', enabled: false }] } }), [
    { provider: 'trae', credits: false },
  ])
  assert.deepEqual(refreshFallbackTargets({ workbuddy: { workbuddy: { electronPath: 'D:\\x.exe' } } }), [
    { provider: 'workbuddy', credits: false },
  ])
  assert.deepEqual(refreshFallbackTargets({ display: { showRateInModelName: false } }), [])
  // 凭证真的变了仍走 refreshTargetsOf 的额度刷新。
  assert.deepEqual(refreshTargetsOf({ qoder: { pat: 'x' } }, [{ provider: 'qoder' }], []), [
    { provider: 'qoder', credits: true },
  ])
})

// ── checkin.results 白名单补字段（B-11 修复回归） ─────────────────────

test('checkin 白名单：credit/streakDays/activityName/coversToday 落盘往返不丢', () => {
  const normalized = normalize({
    checkin: {
      results: {
        qoder: {
          at: 1,
          claimed: 1,
          credit: 100,
          outcomes: [{
            accountId: 'default', label: '默认', kind: 'claimed', message: 'ok',
            credit: 100, streakDays: 8, activityName: '每日领取', coversToday: true,
            machineIdentity: true, gated: false, evil: 'x',
          }],
        },
      },
    },
  })
  const outcome = normalized.checkin.results.qoder.outcomes[0]
  assert.equal(outcome.credit, 100)
  assert.equal(outcome.streakDays, 8)
  assert.equal(outcome.activityName, '每日领取')
  assert.equal(outcome.coversToday, true)
  assert.equal(outcome.evil, undefined)
})

// ── 账号删除墓碑（跨进程续期不复活已删默认账号） ──────────────────────

test('墓碑：删除 default 后 CLI 续期写回被拒；重新配置 PAT 后复活', () => {
  const store = {
    current: normalize({}),
    update(fn) {
      const next = fn(this.current)
      if (next !== null && next !== undefined) this.current = normalize({ ...this.current, ...next })
    },
  }
  // 删除隐式默认账号。
  store.update((current) => mergeAccountSecrets({ removedAccounts: { qoder: ['default'] } }, current))
  assert.equal(typeof store.current.removedAccountAt['qoder::default'], 'number')
  // 独立进程的续期写回不能复活它。
  assert.equal(applyCredentialRefresh(store, 'qoder', 'default', { accessToken: 't1', refreshToken: 'r1', expiresAtMs: Date.now() + 3600_000 }), false)
  assert.deepEqual(store.current.accounts.qoder, [])
  // 用户重新粘贴 PAT = 重新配置：墓碑清除，写回恢复。
  store.update((current) => mergeAccountSecrets({ qoder: { qoder: { pat: 'pt-new' } } }, current))
  assert.equal(store.current.removedAccountAt['qoder::default'], undefined)
  assert.equal(applyCredentialRefresh(store, 'qoder', 'default', { accessToken: 't2', refreshToken: 'r2', expiresAtMs: Date.now() + 3600_000 }), true)
})

test('墓碑：显式 upsert 同 id 撤销墓碑；normalize 保留墓碑且拒非法键', () => {
  const deleted = mergeAccountSecrets({ removedAccounts: { trae: ['default'] } }, normalize({}))
  assert.equal(typeof deleted.removedAccountAt['trae::default'], 'number')
  const rebuilt = mergeAccountSecrets({ accounts: { trae: [{ id: 'default', label: '重建' }] } }, normalize(deleted))
  assert.equal(rebuilt.removedAccountAt['trae::default'], undefined)
  const kept = normalize({ removedAccountAt: { 'qoder::default': 123, 'evil::x': 1, 'qoder::': 1, 'qoder::a': -5 } })
  assert.deepEqual(kept.removedAccountAt, { 'qoder::default': 123 })
})

// ── 账号归一化边界 ────────────────────────────────────────────────────

test('forget 指向已删账号是 no-op：不物化 default、不生成空行', () => {
  const merged = mergeAccountSecrets({ accounts: { qoder: [{ id: 'ghost', forget: true }] } }, normalize({}))
  assert.deepEqual(merged.accounts.qoder, [])
})

test('账号 id 上限 64：与 activeAccount/events 的截断口径对齐', () => {
  const account = normalizeAccount('qoder', { id: 'x'.repeat(100_000), pat: 'p' }, 0)
  assert.equal(account.id.length, 64)
  const patch = sanitizePatch({ accounts: { qoder: [{ id: 'y'.repeat(100_000), pat: 'p' }] } })
  assert.equal(patch.accounts.qoder[0].id.length, 64)
})

test('批量新增账号 id 不塌缩：同补丁内互不相同', () => {
  const rows = Array.from({ length: 30 }, () => ({ pat: 'pt-x' }))
  const patch = sanitizePatch({ accounts: { qoder: rows } })
  const ids = patch.accounts.qoder.map((row) => row.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('normalize 数组上限：手改文件塞不进几万条', () => {
  const normalized = normalize({
    providers: { qoder: { disabledModels: Array.from({ length: 5000 }, (_, i) => `m${i}`) } },
    accounts: { qoder: Array.from({ length: 150 }, (_, i) => ({ id: `a${i}`, pat: 'p' })) },
  })
  assert.equal(normalized.providers.qoder.disabledModels.length, 2000)
  assert.equal(normalized.accounts.qoder.length, 100)
})

test('停用账号重新登录即启用：钉选不再静默落空', () => {
  const current = normalize({ accounts: { workbuddy: [{ id: 'acc-a', label: '旧', enabled: false, token: { uid: 'u1', accessToken: 'old' } }] } })
  const patch = loginAccountPatch('workbuddy', current, { uid: 'u1', label: '新', token: { uid: 'u1', accessToken: 'new' } })
  assert.equal(patch.accounts.workbuddy[0].enabled, true)
  assert.equal(patch.activeAccount.workbuddy, 'acc-a')
})

test('全部账号停用时 activeAccountFor 返回 undefined（关得掉）', () => {
  const settings = normalize({ accounts: { qoder: [{ id: 'a', enabled: false, pat: 'p' }] } })
  assert.equal(activeAccountFor('qoder', settings), undefined)
})

// ── Qoder 签到 startAt / gated 边界 ──────────────────────────────────

const NOON_UTC8 = Date.UTC(2026, 10, 11, 4, 0, 0) // 12:00 UTC+8，已过刷新时刻
const TODAY_START_SEC = Date.UTC(2026, 10, 11, 2, 0, 0) / 1000 // 10:00 UTC+8

test('startAt 数字字符串也认；今天这一轮 coversToday=true', () => {
  const interpreted = interpretQoderCampaigns({
    campaigns: [{ actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', startAt: String(TODAY_START_SEC) }],
  }, NOON_UTC8, { region: 'china' })
  assert.equal(interpreted.kind, 'active')
  assert.equal(interpreted.coversToday, true)
})

test('缺 startAt 的可领活动：领取照常但不冒充今天已完成', () => {
  const interpreted = interpretQoderCampaigns({
    campaigns: [{ actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' }],
  }, NOON_UTC8, { region: 'china' })
  assert.equal(interpreted.kind, 'active')
  assert.equal(interpreted.coversToday, false)
})

test('国际版缺机器身份：空列表也按 gated/pending，不说「没有活动」', () => {
  const interpreted = interpretQoderCampaigns({ campaigns: [], showCampaign: false }, NOON_UTC8, { region: 'global', machineIdentity: false })
  assert.equal(interpreted.kind, 'pending')
  assert.equal(interpreted.gated, true)
})

test('时钟回拨：未来的 lastAttempt 不堵当天重试', () => {
  const now = Date.UTC(2026, 10, 11, 4, 0, 0)
  const rolled = { enabled: true, lastAttemptAt: { qoder: now + 30 * 60_000 } }
  assert.equal(checkinDue(rolled, 'qoder', now), true)
  const backedOff = { enabled: true, lastAttemptAt: { qoder: now - 60_000 } }
  assert.equal(checkinDue(backedOff, 'qoder', now), false)
})

// ── umid 头校验与机器标识 ─────────────────────────────────────────────

test('umid：含控制字符的字段整组丢弃，正常 ASCII 通过', () => {
  assert.equal(parseUmidBlock({ machineToken: 'a\r\nb', machineType: 't', machineCode: 'c' }), null)
  assert.equal(parseUmidBlock({ machineToken: 'a', machineType: 't\n', machineCode: 'c' }), null)
  const ok = parseUmidBlock({ machineToken: 'tok-1', machineType: 'win', machineCode: 'code-1' })
  assert.deepEqual(ok, { machineToken: 'tok-1', machineType: 'win', machineCode: 'code-1' })
})

test('umid：成功缓存有 TTL，探针换值后到期能读到新值', async () => {
  __resetUmidCache()
  let value = { machineToken: 't1', machineType: 'w', machineCode: 'c1' }
  globalThis.__dshReverseProxyQoderUmidProbe = async () => value
  try {
    assert.equal((await readUmidBlock()).machineToken, 't1')
    value = { machineToken: 't2', machineType: 'w', machineCode: 'c2' }
    // 未到期仍读旧值（缓存生效）。
    assert.equal((await readUmidBlock()).machineToken, 't1')
  } finally {
    delete globalThis.__dshReverseProxyQoderUmidProbe
    __resetUmidCache()
  }
})

test('readMachineId：身份跨调用稳定且为 UUID（优先复用官方机器标识）', () => {
  const seed = join(tempDir(), 'machine_id')
  writeFileSync(seed, '', 'utf8')
  const first = readMachineId(seed)
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.equal(readMachineId(seed), first)
})

// ── Trae 签到设备身份不再全局共享 ─────────────────────────────────────

test('缺 userId 时按账号稳定标识派生设备头：不同账号不同设备', () => {
  const a = traeCheckinHeaders('trae', { jwt: 'j', userId: '', email: 'a@example.com' })
  const b = traeCheckinHeaders('trae', { jwt: 'j', userId: '', email: 'b@example.com' })
  assert.notEqual(a['X-Device-Id'], b['X-Device-Id'])
  assert.notEqual(a['X-Market-User-Id'], b['X-Market-User-Id'])
  const a2 = traeCheckinHeaders('trae', { jwt: 'j2', userId: '', email: 'a@example.com' })
  assert.equal(a['X-Device-Id'], a2['X-Device-Id'])
})
