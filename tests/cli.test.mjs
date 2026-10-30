/**
 * CLI 语义集成测试（2.4.0 第二轮审计 #3/#5 的修复）：
 *
 * - `doctor` 不再把「启用但未配置登录」的可选 provider 当失败，`--strict` 仍 exit 0；
 * - 所有带 provider 参数的命令遇到未知 provider 一律输出清晰错误 + exit 2，
 *   不再静默输出空数据后 exit 0。
 *
 * 用临时 profile 跑真实 CLI 子进程，不碰用户 profile。
 *
 * @module dsh-reverse-proxy-connect/tests/cli
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 仓库根目录。 */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 跑一次 CLI。
 * @param args - 参数（不含 node / bin.js）。
 * @param env - 附加环境变量（覆盖继承值）。
 * @returns spawnSync 结果。
 */
function runCli(args, env = {}) {
  return spawnSync(process.execPath, [join(ROOT, 'lib', 'bin.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  })
}

test('CLI：未知 provider 一律 exit 2，不能先输出空数据再 exit 0', () => {
  for (const command of ['models', 'usage', 'credits', 'checkin', 'probe', 'test']) {
    const child = runCli([command, 'bogus-provider'])
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
    assert.equal(child.status, 2, `${command} 未知 provider 应 exit 2，实际 ${String(child.status)}；输出：${output}`)
    assert.match(output, /未知 provider/, `${command} 应打印可用 provider 列表`)
    // 不能在报错前先输出了正常数据（例如 usage 的「统计起点」/ provider 段落）。
    assert.doesNotMatch(child.stdout ?? '', /统计起点|健康/, `${command} 不应先输出空数据再失败`)
  }
})

test('CLI：doctor 不把未配置的可选 provider 当失败（--strict 仍 exit 0）', () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-rpc-cli-doctor-'))
  try {
    const dataDir = join(profile, '.dsh-reverse-proxy-connect')
    mkdirSync(dataDir, { recursive: true })
    // 只启用 qoder 且不配 PAT：这是「可选 provider 未配置」，不是故障。
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      version: 2,
      providers: {
        workbuddy: { enabled: false },
        'workbuddy-ai': { enabled: false },
        qoder: { enabled: true },
        'qoder-global': { enabled: false },
        trae: { enabled: false },
        'trae-global': { enabled: false },
      },
    }))
    const child = runCli(['doctor', '--strict', '--profile', profile], {
      QODER_CN_PERSONAL_ACCESS_TOKEN: '',
      QODER_PERSONAL_ACCESS_TOKEN: '',
    })
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
    assert.equal(child.status, 0, `doctor --strict 不应因未配置可选 provider 失败；输出：${output}`)
    assert.match(output, /未配置（可选）/, '未配置的 provider 应以提示行显示')
    assert.doesNotMatch(output, /✗/, '未配置不应显示为失败项')
    assert.match(output, /体检通过/)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})


test('CLI：doctor --quiet 只输出问题项（健康时完全静默）', () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-rpc-cli-quiet-'))
  try {
    const dataDir = join(profile, '.dsh-reverse-proxy-connect')
    mkdirSync(dataDir, { recursive: true })
    // 与上一个用例相同：只有 qoder 启用且未配置 —— 「可选但未配置」不算问题。
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      version: 2,
      providers: {
        workbuddy: { enabled: false },
        'workbuddy-ai': { enabled: false },
        qoder: { enabled: true },
        'qoder-global': { enabled: false },
        trae: { enabled: false },
        'trae-global': { enabled: false },
      },
    }))
    const child = runCli(['doctor', '--quiet', '--strict', '--profile', profile], {
      QODER_CN_PERSONAL_ACCESS_TOKEN: '',
      QODER_PERSONAL_ACCESS_TOKEN: '',
    })
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
    assert.equal(child.status, 0, `doctor --quiet --strict 应成功；输出：${output}`)
    // 没有问题时一个字都不该输出：脚本/开机自检据此判断「无需处理」。
    assert.equal(output.trim(), '', `--quiet 在健康环境不应有任何输出，实际：${output}`)
    assert.doesNotMatch(output, /✓|体检通过|未配置（可选）/, '--quiet 不应输出成功项或提示项')
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('CLI probe 会把探测结果写回设置（和 GUI 的「检测账号可用模型」一致）', () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-rpc-cli-probe-'))
  try {
    const dataDir = join(profile, '.dsh-reverse-proxy-connect')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      version: 2,
      providers: {
        workbuddy: { enabled: true },
        'workbuddy-ai': { enabled: false },
        qoder: { enabled: false },
        'qoder-global': { enabled: false },
        trae: { enabled: false },
        'trae-global': { enabled: false },
      },
      accounts: {
        workbuddy: [{
          id: 'a',
          label: 'A',
          enabled: true,
          token: {
            accessToken: 'tok',
            refreshToken: '',
            expiresAtMs: Date.now() + 86_400_000,
            refreshExpiresAtMs: 0,
            domain: 'codebuddy.cn',
            uid: 'u',
            enterpriseId: '',
          },
        }],
      },
      activeAccount: { workbuddy: 'a' },
      checkin: { enabled: false },
      probe: { enabled: true, lastRunAt: 0, results: {} },
    }))

    // 子进程里没有别的办法拦截硬编码的上游地址：用 --import 预加载一个 fetch mock。
    const mockFile = join(profile, 'mock-fetch.mjs')
    writeFileSync(mockFile, `
const encoder = new TextEncoder()
globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (href.includes('/v3/config')) {
    return Response.json({ code: 0, data: { agents: [{ name: 'cli', models: ['m1', 'm2'] }], models: [
      { id: 'm1', name: 'M1', maxInputTokens: 1000, maxOutputTokens: 100 },
      { id: 'm2', name: 'M2', maxInputTokens: 1000, maxOutputTokens: 100 },
    ] } })
  }
  if (href.includes('/meter/get-user-resource')) {
    return Response.json({ code: 0, data: { Response: { Data: { Accounts: [] } } } })
  }
  if (href.includes('/v2/chat/completions')) {
    let model = ''
    try { model = JSON.parse(init && init.body ? init.body : '{}').model || '' } catch {}
    if (model === 'm1') {
      return new Response(JSON.stringify({ displayMsg: { zh: '当前账号类型暂不支持该模型' } }), { status: 400 })
    }
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\\n\\ndata: [DONE]\\n\\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return new Response('unexpected ' + href, { status: 500 })
}
`)

    const child = runCli(['probe', 'workbuddy', '--profile', profile], {
      NODE_OPTIONS: `--import=${pathToFileURL(mockFile).href}`,
    })
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
    assert.equal(child.status, 0, `probe 应成功；输出：${output}`)
    assert.match(output, /账号不支持 1 个/)

    const saved = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
    assert.deepEqual(saved.unavailableModels.workbuddy, ['m1'], '探测结论必须落盘，否则选择器毫无变化')
    assert.equal(saved.probe.results.workbuddy.probed, 2)
    assert.equal(saved.probe.results.workbuddy.unavailable, 1)
    assert.equal(saved.probe.results.workbuddy.accountId, 'a')
    assert.ok(saved.probe.lastRunAt > 0, '手动探测也要更新时间戳')
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('CLI：全部 provider 关闭时，probe / test / credits / checkin 都不能「什么都不做却 exit 0」', () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-rpc-cli-alldisabled-'))
  try {
    const dataDir = join(profile, '.dsh-reverse-proxy-connect')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      version: 2,
      providers: {
        workbuddy: { enabled: false },
        'workbuddy-ai': { enabled: false },
        qoder: { enabled: false },
        'qoder-global': { enabled: false },
        trae: { enabled: false },
        'trae-global': { enabled: false },
      },
    }))
    for (const command of ['probe', 'test', 'credits', 'checkin']) {
      const child = runCli([command, '--profile', profile], {
        QODER_CN_PERSONAL_ACCESS_TOKEN: '',
        QODER_PERSONAL_ACCESS_TOKEN: '',
      })
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
      assert.equal(child.status, 2, `${command} 在全部关闭时应 exit 2，实际 ${String(child.status)}；输出：${output}`)
      assert.match(output, /已在设置里关闭/, `${command} 应说明为什么什么都没做`)
    }
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('CLI：高版本 stats / events 文件在 doctor 里报只读，stats-reset 不假成功', () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-rpc-cli-readonly-'))
  try {
    const dataDir = join(profile, '.dsh-reverse-proxy-connect')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      version: 2,
      providers: {
        workbuddy: { enabled: false },
        'workbuddy-ai': { enabled: false },
        qoder: { enabled: false },
        'qoder-global': { enabled: false },
        trae: { enabled: false },
        'trae-global': { enabled: false },
      },
    }))
    writeFileSync(join(dataDir, 'stats.json'), JSON.stringify({ version: 999, totals: { requests: 7 } }))
    writeFileSync(join(dataDir, 'events.json'), JSON.stringify({ version: 99, events: [] }))

    const doctor = runCli(['doctor', '--strict', '--profile', profile])
    const doctorOut = `${doctor.stdout ?? ''}${doctor.stderr ?? ''}`
    assert.equal(doctor.status, 1, `只读文件必须让 --strict 失败；输出：${doctorOut}`)
    assert.match(doctorOut, /用量统计文件.*只读/, 'doctor 应说明统计文件只读')
    assert.match(doctorOut, /事件账本文件.*只读/, 'doctor 应说明事件账本只读')

    const reset = runCli(['stats-reset', '--profile', profile])
    const resetOut = `${reset.stdout ?? ''}${reset.stderr ?? ''}`
    assert.equal(reset.status, 1, `只读文件的重置必须 exit 1；输出：${resetOut}`)
    assert.match(resetOut, /重置失败/)
    assert.doesNotMatch(resetOut, /已清空/, '不能一边失败一边打印「已清空」')

    // 磁盘文件必须原样保留（不能被降级成 v4 空统计）。
    const statsDoc = JSON.parse(readFileSync(join(dataDir, 'stats.json'), 'utf8'))
    assert.equal(statsDoc.version, 999)
    assert.equal(statsDoc.totals.requests, 7)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})
