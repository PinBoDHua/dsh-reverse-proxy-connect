// R26 审计回归：R25 修复自身的回归与漏网同类。
// 与 R25 不同，这里尽量驱动**真实** SettingsStore / 真实 HTTP 路由，
// 避免浅合并假 store 掩盖 mergeDeep 并集语义这类交叉路径缺陷。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { ACTION_PATH, DATA_DIR_NAME, PROVIDER_IDS, SETTINGS_PATH, STATUS_PATH } from '../lib/protocol.js'
import { SettingsStore } from '../lib/settings.js'
import {
  accountsFor,
  applyCredentialRefresh,
  mergeAccountSecrets,
  syncLegacyCredentialPaths,
} from '../lib/accounts.js'
import { Runtime } from '../lib/runtime.js'
import { parseStream as parseTraeStream } from '../lib/trae/transport.js'

function send(port, options, body) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path,
      headers: options.headers ?? {},
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** 起一个只挂插件路由的真实 HTTP 服务；settings 由调用方写入数据目录。 */
async function startHost(settings) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-r26-'))
  mkdirSync(join(root, DATA_DIR_NAME), { recursive: true })
  writeFileSync(join(root, DATA_DIR_NAME, 'settings.json'), JSON.stringify(settings))
  const handlers = {}
  const disposers = []
  const ctx = {
    get(name) { return name === 'profileContext' ? { dir: root } : undefined },
    inject(names, callback) {
      if (names.includes('webServer')) {
        callback({
          webServer: {
            register(route) { handlers[route.path] = route.handler; return () => { delete handlers[route.path] } },
          },
          effect(fn) { const d = fn(); disposers.push(d); return d },
        })
      }
    },
    effect(fn) { const d = fn(); disposers.push(d); return d },
    llm: { registerAdapter: () => () => {} },
    emit() {},
    logger: { info() {}, warn() {} },
  }
  const server = createServer((req, res) => {
    const handler = handlers[req.url.split('?')[0]]
    if (handler === undefined) { res.statusCode = 404; res.end('not found'); return }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  apply(ctx, {})
  return {
    port,
    root,
    async close() {
      for (const d of disposers) { try { d() } catch {} }
      await new Promise((resolve) => server.close(resolve))
      rmSync(root, { recursive: true, force: true })
    },
  }
}

// 只启用 workbuddy，且其唯一账号被显式停用 → activeAccountFor 返回 undefined。
const ALL_DISABLED_SETTINGS = {
  version: 2,
  providers: Object.fromEntries(PROVIDER_IDS.map((p) => [p, { enabled: p === 'workbuddy', disabledModels: [] }])),
  accounts: { workbuddy: [{ id: 'default', label: '本机登录', enabled: false, authFile: '' }] },
}

test('R26 B-1：启用 provider 全账号停用时 /status 不再 500（含 light/core）', async () => {
  const host = await startHost(ALL_DISABLED_SETTINGS)
  try {
    const headers = { host: `127.0.0.1:${host.port}` }
    for (const path of [STATUS_PATH, STATUS_PATH + '?light=1', STATUS_PATH + '?view=core']) {
      const res = await send(host.port, { path, headers })
      assert.equal(res.status, 200, `${path} 应 200，实际 ${res.status}`)
    }
    const doc = JSON.parse((await send(host.port, { path: STATUS_PATH, headers })).body)
    const wb = doc.providers.find((p) => p.provider === 'workbuddy')
    assert.equal(wb.credential.status, 'no-account')
    assert.equal(wb.accounts[0].active, false)
  } finally { await host.close() }
})

test('R26 B-6：全账号停用时 action 成功即 200，不再「动作生效却回 500」', async () => {
  const host = await startHost(ALL_DISABLED_SETTINGS)
  try {
    const headers = { host: `127.0.0.1:${host.port}` }
    const key = JSON.parse((await send(host.port, { path: STATUS_PATH, headers })).body).key
    const res = await send(host.port, {
      method: 'POST', path: ACTION_PATH,
      headers: { ...headers, 'x-rpc-key': key, 'content-type': 'application/json' },
    }, JSON.stringify({ action: 'stats-reset' }))
    assert.equal(res.status, 200)
  } finally { await host.close() }
})

test('R26 B-2：真实 SettingsStore 下删除默认账号后重配，墓碑撤销必须落盘', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-r26-store-'))
  const file = join(root, 'settings.json')
  try {
    const store = new SettingsStore(file)
    store.patch({ accounts: { qoder: [{ id: 'default', label: 'd', pat: 'pt-old' }] } })
    // 删除默认账号 → 写墓碑。
    store.patch(mergeAccountSecrets({ removedAccounts: { qoder: ['default'] } }, store.get()))
    assert.ok(store.get().removedAccountAt['qoder::default'] > 0)
    // 重新粘贴 PAT（legacy 字段）→ 撤销墓碑。
    const legacy = syncLegacyCredentialPaths({ qoder: { qoder: { pat: 'pt-new' } } }, store.get())
    store.patch(mergeAccountSecrets(legacy, store.get()))
    assert.equal(store.get().removedAccountAt['qoder::default'], undefined, '内存里墓碑应被撤销')
    // 重启（新 store 读同一文件）后仍然撤销，且续期写回被接受。
    const reopened = new SettingsStore(file)
    assert.equal(reopened.get().removedAccountAt['qoder::default'], undefined, '磁盘上墓碑应被撤销')
    assert.equal(applyCredentialRefresh(reopened, 'qoder', 'default', { token: 't' }), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R26 B-3：legacy qoder.pat 空串必须清掉物化池里的旧 PAT', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-r26-pat-'))
  try {
    const store = new SettingsStore(join(root, 'settings.json'))
    store.patch({ accounts: { qoder: [
      { id: 'default', label: 'd', pat: 'pt-old' },
      { id: 'acc-b', label: 'b', pat: 'pt-b' },
    ] } })
    const legacy = syncLegacyCredentialPaths({ qoder: { qoder: { pat: '' } } }, store.get())
    store.patch(mergeAccountSecrets(legacy, store.get()))
    const rows = accountsFor('qoder', store.get())
    assert.equal(rows.find((r) => r.id === 'default').pat, undefined, '默认行旧 PAT 应被清除')
    assert.equal(rows.find((r) => r.id === 'acc-b').pat, 'pt-b', '其它账号不受影响')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R26 T-2：forgetCredentialState 必须摘掉在途续期登记（防跨账号复用旧令牌）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-r26-rt-'))
  try {
    const rt = new Runtime({ settings: () => ({}), dataDir: root, logger: { info() {}, warn() {} } })
    rt.credentialRefreshing.set('qoder::default', new Promise(() => {}))
    rt.identityRefreshing.set('qoder::default', new Promise(() => {}))
    rt.forgetCredentialState([{ provider: 'qoder', accountId: 'default' }])
    assert.equal(rt.credentialRefreshing.has('qoder::default'), false, '在途续期登记应被清除')
    assert.equal(rt.identityRefreshing.has('qoder::default'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function traeBody(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

test('R26 T-3：Trae 流内字符串 code 与数字同判（1001→auth、1005→quota）', async () => {
  const auth = ['event:error', 'data:{"code":"1001","message":"login expired"}', ''].join('\n')
  await assert.rejects(
    (async () => { for await (const _e of parseTraeStream(traeBody(auth), undefined)) {} })(),
    (error) => error.kind === 'auth' && error.status === 401,
  )
  const quota = ['event:error', 'data:{"code":"1005","message":""}', ''].join('\n')
  await assert.rejects(
    (async () => { for await (const _e of parseTraeStream(traeBody(quota), undefined)) {} })(),
    (error) => error.kind === 'quota' && error.status === 402,
  )
})

test('R26 B-5：账号池满 100 再新增必须显式 400，而不是静默丢弃回 200', async () => {
  const oneHundred = Array.from({ length: 100 }, (_, i) => ({ id: 'acc-' + i, label: 'a' + i, pat: 'pt-' + i }))
  const settings = {
    version: 2,
    providers: Object.fromEntries(PROVIDER_IDS.map((p) => [p, { enabled: p === 'qoder', disabledModels: [] }])),
    accounts: { qoder: oneHundred },
  }
  const host = await startHost(settings)
  try {
    const headers = { host: `127.0.0.1:${host.port}` }
    const key = JSON.parse((await send(host.port, { path: STATUS_PATH, headers })).body).key
    const res = await send(host.port, {
      method: 'POST', path: SETTINGS_PATH,
      headers: { ...headers, 'x-rpc-key': key, 'content-type': 'application/json' },
    }, JSON.stringify({ accounts: { qoder: [{ id: 'acc-new', label: 'new', pat: 'pt-new' }] } }))
    assert.equal(res.status, 400, '超限应 400，实际 ' + res.status)
  } finally { await host.close() }
})

test('R26：labelKey 纯渲染字段不落盘', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-r26-label-'))
  const file = join(root, 'settings.json')
  try {
    const store = new SettingsStore(file)
    store.patch(mergeAccountSecrets({ accounts: { qoder: [{ id: 'acc-new', label: 'n', pat: 'x' }] } }, store.get()))
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    for (const row of onDisk.accounts.qoder) {
      assert.equal(row.labelKey, undefined, 'labelKey 不应出现在 settings.json')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
