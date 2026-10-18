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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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
