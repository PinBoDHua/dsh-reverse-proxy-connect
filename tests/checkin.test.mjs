import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import { interpretCampaignClaim, interpretCheckinStatus, interpretClaim, interpretQoderCampaigns, qoderCampaigns, qoderClaimCampaigns } from '../lib/checkin.js'
import { checkinDue, checkinTerminal } from '../lib/checkin-schedule.js'
import { EventLog } from '../lib/events.js'
import { __resetUmidCache } from '../lib/qoder/umid.js'
import { Runtime } from '../lib/runtime.js'
import { defaults, normalize } from '../lib/settings.js'

/** 单测里替掉真实的 umid 二进制：固定三件套，保证任何机器上结果一致。 */
const UMID_PROBE = '__dshReverseProxyQoderUmidProbe'

beforeEach(() => {
  globalThis[UMID_PROBE] = () => ({ machineToken: 'machine-token', machineType: 'machine-type', machineCode: 'machine-code' })
  __resetUmidCache()
})

afterEach(() => {
  delete globalThis[UMID_PROBE]
  __resetUmidCache()
})

test('签到状态：活动进行中且今天已签', () => {
  const value = interpretCheckinStatus({
    code: 0,
    data: {
      active: true,
      today_checked_in: true,
      streak_days: 8,
      daily_credit: 100,
      total_credits: 800,
      activity_name: 'Buddy应用',
      end_time: '2026-10-31 23:59:59',
      checkin_dates: ['2026-10-17', '2026-10-16'],
    },
  })
  assert.equal(value.kind, 'already')
  assert.equal(value.streakDays, 8)
  assert.equal(value.dailyCredit, 100)
  assert.equal(value.activityName, 'Buddy应用')
  assert.deepEqual(value.checkinDates, ['2026-10-17', '2026-10-16'])
})

test('签到状态：活动进行中但今天未签 → active（可领）', () => {
  const value = interpretCheckinStatus({ code: 0, data: { active: true, today_checked_in: false, streak_days: 3 } })
  assert.equal(value.kind, 'active')
  assert.equal(value.streakDays, 3)
})

test('签到状态：没有活动（国际版实测返回 active:false）', () => {
  const value = interpretCheckinStatus({ code: 0, data: { active: false, today_checked_in: false } })
  assert.equal(value.kind, 'inactive')
  assert.equal(value.dailyCredit, 0)
})

test('签到状态：上游报错与非 JSON 都要退化成 failed', () => {
  assert.equal(interpretCheckinStatus({ code: 500, msg: 'boom' }).kind, 'failed')
  assert.equal(interpretCheckinStatus(null).kind, 'failed')
  assert.equal(interpretCheckinStatus({ code: 0, data: null }).kind, 'inactive')
})

test('签到状态：data 有字段但缺 active 视为失败（schema 改名不能吞掉整天）', () => {
  assert.equal(interpretCheckinStatus({ code: 0, data: { today_checked_in: false } }).kind, 'failed')
  assert.equal(interpretCheckinStatus({ code: 0, data: {} }).kind, 'inactive')
})

test('领取：成功时带出积分与连续天数', () => {
  const value = interpretClaim({ code: 0, data: { credit: 100, streak_days: 9 } })
  assert.equal(value.kind, 'claimed')
  assert.equal(value.credit, 100)
  assert.equal(value.streakDays, 9)
})

test('领取：已领取的两种码都算 already，不是失败', () => {
  assert.equal(interpretClaim({ code: 10001 }).kind, 'already')
  assert.equal(interpretClaim({ code: 1001 }).kind, 'already')
})

test('领取：无资格 / 活动结束算 inactive', () => {
  assert.equal(interpretClaim({ code: 1002 }).kind, 'inactive')
  assert.equal(interpretClaim({ code: 1003 }).kind, 'inactive')
})

test('领取：未知码算 failed，并带上原文', () => {
  const value = interpretClaim({ code: 4242, msg: '限流' })
  assert.equal(value.kind, 'failed')
  assert.equal(value.message, '限流')
})

test('领取：响应里没给积分数时不编造', () => {
  const value = interpretClaim({ code: 0, data: {} })
  assert.equal(value.kind, 'claimed')
  assert.equal(value.credit, 0)
})

/** 构造一个 UTC+8 时刻。 */
function utc8(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0)
}

/** 某个 UTC+8 时刻的秒级时间戳（活动 startAt 用的单位）。 */
function utc8Seconds(year, month, day, hour, minute = 0) {
  return Math.floor(utc8(year, month, day, hour, minute) / 1000)
}

test('Qoder 活动列表：10:00 前看到的是昨天那一轮，不能算今天已完成', () => {
  const now = utc8(2026, 11, 8, 9, 0)
  const value = interpretQoderCampaigns({
    showCampaign: true,
    claimable: false,
    campaigns: [{
      campaignId: 'c1',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMED',
      startAt: utc8Seconds(2026, 11, 7, 10),
      benefit: { amount: 100 },
    }],
  }, now)
  assert.equal(value.kind, 'pending')
  assert.equal(value.coversToday, false)
  assert.match(value.message, /10:00/)
})

test('Qoder 活动列表：刷新后出现可领活动 → active', () => {
  const now = utc8(2026, 11, 8, 10, 5)
  const value = interpretQoderCampaigns({
    showCampaign: true,
    claimable: true,
    campaigns: [{
      campaignId: 'c2',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMABLE',
      startAt: utc8Seconds(2026, 11, 8, 10),
      placements: [{ content: { zh: { title: '每天领 100 Credits' } } }],
      benefit: { amount: 100 },
    }],
  }, now)
  assert.equal(value.kind, 'active')
  assert.equal(value.claimable, 1)
  assert.equal(value.coversToday, true)
  assert.deepEqual(value.campaigns.map((item) => item.id), ['c2'])
  assert.equal(value.campaigns[0].title, '每天领 100 Credits')
})

test('Qoder 活动列表：10:00 后旧活动仍可领时，不能算今天已完成', () => {
  const now = utc8(2026, 11, 8, 10, 5)
  const value = interpretQoderCampaigns({
    campaigns: [{
      campaignId: 'c1',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMABLE',
      startAt: utc8Seconds(2026, 11, 7, 10),
    }],
  }, now)
  assert.equal(value.kind, 'active', '旧活动还可以领')
  assert.equal(value.coversToday, false, '但今天这一轮还没开始，不能写 completedOn')
})

test('Qoder 活动列表：几点刷新后仍只有昨天那一轮 → pending，不是 already', () => {
  const now = utc8(2026, 11, 8, 10, 5)
  const value = interpretQoderCampaigns({
    campaigns: [{
      campaignId: 'c1',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMED',
      startAt: utc8Seconds(2026, 11, 7, 10),
    }],
  }, now)
  assert.equal(value.kind, 'pending', '旧活动延迟下架时不能把今天判成已领')
  assert.match(value.message, /新一轮/)
})

test('Qoder 活动列表：今天这一轮已领 → already', () => {
  const now = utc8(2026, 11, 8, 11, 0)
  const value = interpretQoderCampaigns({
    campaigns: [{
      campaignId: 'c2',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMED',
      startAt: utc8Seconds(2026, 11, 8, 10),
    }],
  }, now)
  assert.equal(value.kind, 'already')
  assert.equal(value.coversToday, true)
})

test('Qoder 活动列表：没有每日领取活动 → inactive', () => {
  const value = interpretQoderCampaigns({ showCampaign: false, campaigns: [] }, utc8(2026, 11, 8, 11, 0))
  assert.equal(value.kind, 'inactive')
  assert.match(value.message, /没有每日领取活动/)
})

test('Qoder 国际版：列表被裁成 VIEW_DETAILS → pending，绝不报「没有签到活动」', () => {
  // 上游实测：不给 umid 机器身份时，国际版只回常驻的 VIEW_DETAILS 横幅，
  // 每日 CLAIM_BENEFIT 轮次被整条裁掉；这正是用户看到的「无签到活动」。
  const value = interpretQoderCampaigns({
    showCampaign: true,
    campaigns: [{
      campaignId: 'banner',
      actionType: 'VIEW_DETAILS',
      claimStatus: 'CLAIMED',
      startAt: utc8Seconds(2026, 10, 1, 10),
    }],
  }, utc8(2026, 11, 8, 12, 30), { region: 'global', machineIdentity: false })
  assert.equal(value.kind, 'pending', '被裁的列表不是「没有活动」，而是「这次没拿到活动」')
  assert.equal(value.gated, true)
  assert.equal(value.machineIdentity, false)
  assert.match(value.message, /机器身份|umid|桌面端/)
  assert.doesNotMatch(value.message, /没有每日领取活动/)
})

test('Qoder 国际版：身份齐全但只有常驻活动 → pending 等新一轮', () => {
  const value = interpretQoderCampaigns({
    showCampaign: true,
    campaigns: [{
      campaignId: 'banner',
      actionType: 'VIEW_DETAILS',
      claimStatus: 'CLAIMED',
      startAt: utc8Seconds(2026, 10, 1, 10),
    }],
  }, utc8(2026, 11, 8, 12, 30), { region: 'global', machineIdentity: true })
  assert.equal(value.kind, 'pending')
  assert.match(value.message, /稍后自动重试/)
})

test('Qoder 国际版：showCampaign:true + 空数组是瞬时态，不能钉死成一整天无活动', () => {
  const value = interpretQoderCampaigns(
    { showCampaign: true, campaigns: [] },
    utc8(2026, 11, 8, 12, 30),
    { region: 'global', machineIdentity: true },
  )
  assert.equal(value.kind, 'pending')
  assert.match(value.message, /稍后自动重试/)
})

test('Qoder 请求头：国际版带 umid 三件套；领取请求带 origin', async () => {
  const original = globalThis.fetch
  const realNow = Date.now
  Date.now = () => utc8(2026, 11, 8, 10, 5)
  const captured = []
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), headers: init?.headers })
    if (String(url).includes('/claim')) {
      return { ok: true, status: 200, json: async () => ({ status: 'CLAIMED', replayed: false, benefit: { amount: 100 } }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        showCampaign: true,
        campaigns: [{
          campaignId: 'c1',
          actionType: 'CLAIM_BENEFIT',
          claimStatus: 'CLAIMABLE',
          startAt: utc8Seconds(2026, 11, 8, 10),
        }],
      }),
    }
  }
  try {
    const value = await qoderClaimCampaigns({ authToken: 'job-token' }, 'global')
    assert.equal(value.kind, 'claimed')
    assert.equal(captured.length, 2)
    assert.equal(captured[0].headers['Cosy-MachineToken'], 'machine-token')
    assert.equal(captured[0].headers['Cosy-MachineCode'], 'machine-code')
    assert.equal(captured[0].headers['Cosy-MachineType'], 'machine-type')
    assert.equal(captured[0].headers['cosy-clienttype'], '10')
    assert.equal(captured[1].headers.origin, 'https://openapi.qoder.sh')
    assert.equal(captured[1].headers['Cosy-MachineToken'], 'machine-token')
  } finally {
    globalThis.fetch = original
    Date.now = realNow
  }
})

test('Qoder 国际版：读不到 umid 时请求退回裸身份，并把被裁列表报成 pending', async () => {
  const original = globalThis.fetch
  const realNow = Date.now
  globalThis[UMID_PROBE] = () => null
  __resetUmidCache()
  Date.now = () => utc8(2026, 11, 8, 12, 30)
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), headers: init?.headers }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        showCampaign: true,
        campaigns: [{
          campaignId: 'banner',
          actionType: 'VIEW_DETAILS',
          claimStatus: 'CLAIMED',
          startAt: utc8Seconds(2026, 10, 1, 10),
        }],
      }),
    }
  }
  try {
    const value = await qoderCampaigns({ authToken: 'job-token' }, 'global')
    assert.equal(captured.headers['Cosy-MachineToken'], undefined, '读不到时不能发半份/伪造身份')
    assert.equal(value.kind, 'pending')
    assert.equal(value.machineIdentity, false)
    assert.match(value.message, /机器身份/)
  } finally {
    globalThis.fetch = original
    Date.now = realNow
  }
})

test('Qoder 签到诊断字段能持久化：machineIdentity / gated 不被设置白名单丢掉', () => {
  const normalized = normalize({
    checkin: {
      results: {
        'qoder-global': {
          provider: 'qoder-global',
          outcomes: [{
            accountId: 'a',
            kind: 'pending',
            message: '缺少桌面端机器身份',
            machineIdentity: false,
            gated: true,
          }],
        },
      },
    },
  })
  const outcome = normalized.checkin.results['qoder-global'].outcomes[0]
  assert.equal(outcome.machineIdentity, false)
  assert.equal(outcome.gated, true)
})

test('Qoder 领取结果：replayed/status/benefit.amount 按当前协议解释', () => {
  const replayed = interpretCampaignClaim({ status: 'CLAIMED', replayed: true, benefit: { amount: 100 } })
  assert.equal(replayed.kind, 'already', '重复领取不能报成新领到 100 分')
  const fresh = interpretCampaignClaim({ status: 'CLAIMED', replayed: false, benefit: { amount: 100 } })
  assert.equal(fresh.kind, 'claimed')
  assert.equal(fresh.credit, 100)
  const failed = interpretCampaignClaim({ status: 'FAILED' })
  assert.equal(failed.kind, 'failed')
  assert.match(failed.message, /status=FAILED/)
})

test('Qoder 请求头：活动接口必须用桌面客户端身份（cosy-clienttype=10）', async () => {
  // 实测同一枚 job token：clienttype 5 → showCampaign:false + 空数组；
  // 10 → 正常返回每日活动。少了这个头，卡片永远显示「没有可领取的活动」。
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), headers: init?.headers }
    return { ok: true, status: 200, json: async () => ({ campaigns: [] }) }
  }
  try {
    await qoderCampaigns({ authToken: 'job-token' }, 'china')
    assert.equal(captured.headers['cosy-clienttype'], '10')
    assert.equal(captured.headers['user-agent'], 'Qoder')
    assert.equal(captured.headers['Cosy-MachineToken'], undefined, '国内版不需要 umid，也不该启动本机二进制')
    assert.match(captured.url, /openapi\.qoder\.com\.cn\/sash\/api\/v1\/me\/campaigns/)
  } finally {
    globalThis.fetch = original
  }
})

test('Qoder 领取：10:00 前只查列表，不打领取接口', async () => {
  const originalFetch = globalThis.fetch
  const realNow = Date.now
  Date.now = () => utc8(2026, 11, 8, 9, 0)
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        campaigns: [{
          campaignId: 'c1',
          actionType: 'CLAIM_BENEFIT',
          claimStatus: 'CLAIMED',
          startAt: utc8Seconds(2026, 11, 7, 10),
        }],
      }),
    }
  }
  try {
    const outcome = await qoderClaimCampaigns({ authToken: 'job-token' }, 'global')
    assert.equal(outcome.kind, 'pending')
    assert.equal(calls.length, 1, '刷新前不应该尝试领取昨天那一轮')
    assert.ok(!calls[0].includes('/claim'))
  } finally {
    globalThis.fetch = originalFetch
    Date.now = realNow
  }
})

test('Qoder 领取：当前 status/replayed 协议能区分真领取与重复领取', async () => {
  const originalFetch = globalThis.fetch
  const realNow = Date.now
  Date.now = () => utc8(2026, 11, 8, 10, 5)
  let claimCalls = 0
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/claim')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          campaigns: [{
            campaignId: 'c1',
            actionType: 'CLAIM_BENEFIT',
            claimStatus: 'CLAIMABLE',
            startAt: utc8Seconds(2026, 11, 8, 10),
            benefit: { amount: 100 },
          }],
        }),
      }
    }
    claimCalls += 1
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'CLAIMED', replayed: false, benefit: { amount: 100 } }),
    }
  }
  try {
    const outcome = await qoderClaimCampaigns({ authToken: 'job-token' }, 'global')
    assert.equal(outcome.kind, 'claimed')
    assert.equal(outcome.claimed, 1)
    assert.equal(outcome.credit, 100)
    assert.equal(outcome.coversToday, true)
    assert.equal(claimCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
    Date.now = realNow
  }
})

test('签到降噪：未配置登录的账号记 unconfigured（info、不算失败、不请求上游、不触发重试）', async () => {
  // 用户可见行为：没登录/没配 PAT 的账号不再每天在事件账本里报「签到失败」，
  // 也不会每 10 分钟重试一次；卡片上显示的是「未登录，已跳过」这种已知状态。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-checkin-unconfigured-'))
  const originalFetch = globalThis.fetch
  const savedCnToken = process.env.QODER_CN_PERSONAL_ACCESS_TOKEN
  const savedGlobalToken = process.env.QODER_PERSONAL_ACCESS_TOKEN
  delete process.env.QODER_CN_PERSONAL_ACCESS_TOKEN
  delete process.env.QODER_PERSONAL_ACCESS_TOKEN

  const events = new EventLog({})
  const settings = defaults()
  const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {}, events })
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('未配置账号不应该请求上游')
  }
  try {
    const outcome = await runtime.runCheckin('qoder')
    assert.equal(outcome.outcomes.length, 1)
    assert.equal(outcome.outcomes[0].kind, 'unconfigured', '未配置账号应记 unconfigured，而不是 failed')
    assert.match(outcome.outcomes[0].message, /令牌|登录/, '原因要能读懂（未配置登录）')
    assert.equal(outcome.claimed, 0)
    assert.equal(fetchCalls, 0, '未配置账号不应该打上游签到接口')

    const checkinEvents = events.list({ type: 'checkin' })
    assert.equal(checkinEvents.length, 1)
    assert.equal(checkinEvents[0].level, 'info', '未登录是已知状态，事件级别必须是 info 而不是 warn')
    assert.match(checkinEvents[0].message, /未登录，已跳过/)

    // index.js 的终态判定：排除 unconfigured 之后才算「今天结束」，
    // 否则调度器看到非终态会每 10 分钟重试一次。
    assert.equal(checkinTerminal(outcome), false, '原始结果不算终态（需要 index 过滤）')
    const settled = { ...outcome, outcomes: outcome.outcomes.filter((item) => item.kind !== 'unconfigured') }
    assert.equal(checkinTerminal(settled), true, '排除未配置账号后必须是终态，不能触发 10 分钟重试')
  } finally {
    runtime.flushCaches()
    globalThis.fetch = originalFetch
    if (savedCnToken !== undefined) process.env.QODER_CN_PERSONAL_ACCESS_TOKEN = savedCnToken
    if (savedGlobalToken !== undefined) process.env.QODER_PERSONAL_ACCESS_TOKEN = savedGlobalToken
    rmSync(dir, { recursive: true, force: true })
  }
})

test('签到回归：瞬时凭证读取失败记为 failed（保留 10 分钟重试），不能变成 unconfigured', async () => {
  // 用户可见行为：网络抖动/登录文件被占用时，当天签到不能被标成「已完成」而
  // 直接跳过 —— 必须记 failed，10 分钟后自动重试，不能漏掉当天奖励。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rpc-checkin-transient-'))
  const originalFetch = globalThis.fetch
  const events = new EventLog({})
  const settings = defaults()
  settings.accounts.qoder = [{ id: 'a', label: 'PAT 账号', enabled: true, pat: 'pt-real' }]
  settings.activeAccount.qoder = 'a'
  const runtime = new Runtime({ settings: () => settings, dataDir: dir, logger: {}, events })
  globalThis.fetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
  }
  try {
    const outcome = await runtime.runCheckin('qoder')
    const accountOutcome = outcome.outcomes[0]
    assert.equal(accountOutcome.kind, 'failed', '瞬时读取失败必须是 failed，不能是 unconfigured')
    assert.match(accountOutcome.message, /fetch failed/)

    const checkinEvent = events.list({ type: 'checkin' })[0]
    assert.equal(checkinEvent.level, 'warn', '真失败仍要 warn，不能被降噪吞掉')

    // 复刻 lib/index.js 的终态判定：failed 不是终态 → 不写 completedOn。
    const settled = outcome.outcomes.filter((item) => item.kind !== 'unconfigured')
    assert.equal(checkinTerminal({ ...outcome, outcomes: settled }), false, 'failed 不能算今天已结束')

    // 按 failed 写入（completedOn 为空）后，11 分钟时应允许重试。
    const now = Date.now()
    assert.equal(
      checkinDue({ enabled: true, completedOn: {}, lastAttemptAt: { qoder: now } }, 'qoder', now + 11 * 60_000, ['a']),
      true,
      '瞬时失败后 11 分钟必须重试，不能整天跳过',
    )

    // 上游繁忙时重试会连续失败：账本只保留 1 小时内第一条同样的失败，
    // 否则 6 条/小时会把换号、凭证失效这些真正的异常挤出最近 50 条。
    const retried = await runtime.runCheckin('qoder')
    assert.equal(retried.outcomes[0].kind, 'failed')
    assert.equal(events.list({ type: 'checkin' }).length, 1, '同一失败原因在去重窗口内只记一条')
  } finally {
    runtime.flushCaches()
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})
