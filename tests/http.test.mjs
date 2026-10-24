// 真实 HTTP 边界：413、代理头、多字节控制密钥。
//
// 这些路径在假 req/res 的单元测试里看不到：旧实现超限时先 req.destroy()，
// 413 根本没机会写出去，客户端只看到 ECONNRESET。

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { ACTION_PATH, DATA_DIR_NAME, PROVIDER_IDS, SETTINGS_PATH, STATUS_PATH } from '../lib/protocol.js'

/** 发一个 HTTP 请求，收集状态码与响应体。 */
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

test('HTTP：超限请求返回 413；代理头与多字节密钥返回 403/413 而不是 500', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rpc-http-'))
  // 全部 provider 关闭：避免测试期间真的访问上游。注意要写进插件的数据目录
  // （profile/.dsh-reverse-proxy-connect/settings.json）—— 写到 profile 根上
  // 不会被读到，provider 会按默认值全部启用，首轮刷新把内置兜底目录写进缓存，
  // test-model 就真的发起上游请求（结果取决于刷新与断言的先后，变成竞态）。
  const providers = Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, { enabled: false, disabledModels: [] }]))
  mkdirSync(join(root, DATA_DIR_NAME), { recursive: true })
  writeFileSync(join(root, DATA_DIR_NAME, 'settings.json'), JSON.stringify({ version: 2, providers }))

  const handlers = {}
  const disposers = []
  const ctx = {
    get(name) { return name === 'profileContext' ? { dir: root } : undefined },
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
    llm: { registerAdapter: () => () => {} },
    emit() {},
    logger: { info() {}, warn() {} },
  }

  const server = createServer((req, res) => {
    const handler = handlers[req.url.split('?')[0]]
    if (handler === undefined) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    apply(ctx, {})
    const status = await send(port, { path: STATUS_PATH, headers: { host: `127.0.0.1:${port}` } })
    assert.equal(status.status, 200)
    const key = JSON.parse(status.body).key

    // 正常写入。
    const ok = await send(port, {
      method: 'POST',
      path: SETTINGS_PATH,
      headers: { host: `127.0.0.1:${port}`, 'x-rpc-key': key, 'content-type': 'application/json' },
    }, JSON.stringify({ display: { showUsageInSidebar: true } }))
    assert.equal(ok.status, 200)

    // 1.1MB：必须是 413，而不是 ECONNRESET/500。
    const tooLarge = await send(port, {
      method: 'POST',
      path: SETTINGS_PATH,
      headers: { host: `127.0.0.1:${port}`, 'x-rpc-key': key, 'content-type': 'application/json' },
    }, Buffer.alloc(1_100_000, 0x61))
    assert.equal(tooLarge.status, 413)
    assert.match(tooLarge.body, /body-too-large/)

    // 多字节控制密钥：长度按字节比较，返回 403 而不是 500。
    const multibyte = await send(port, {
      method: 'POST',
      path: SETTINGS_PATH,
      headers: { host: `127.0.0.1:${port}`, 'x-rpc-key': 'é'.repeat(48), 'content-type': 'application/json' },
    }, '{}')
    assert.equal(multibyte.status, 403)

    // 本地反向代理的典型头：不能把回环连接当成可信浏览器。
    const proxied = await send(port, {
      path: STATUS_PATH,
      headers: { host: `127.0.0.1:${port}`, via: '1.1 nginx' },
    })
    assert.equal(proxied.status, 403)

    // 越权 action 依旧被拒绝。
    const noKey = await send(port, {
      method: 'POST',
      path: ACTION_PATH,
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
    }, JSON.stringify({ action: 'stats-reset' }))
    assert.equal(noKey.status, 403)

    // 账号 × 模型检测 action：没有目录时返回 NO_MODEL，并把结果放进状态。
    const modelTest = await send(port, {
      method: 'POST',
      path: ACTION_PATH,
      headers: { host: `127.0.0.1:${port}`, 'x-rpc-key': key, 'content-type': 'application/json' },
    }, JSON.stringify({ action: 'test-model', provider: 'workbuddy', accountId: 'default', model: 'auto' }))
    assert.equal(modelTest.status, 200)
    const modelTestBody = JSON.parse(modelTest.body)
    assert.equal(modelTestBody.test.code, 'NO_MODEL')
    const workbuddy = modelTestBody.status.providers.find((provider) => provider.provider === 'workbuddy')
    assert.equal(workbuddy.accounts[0].modelTests.auto.code, 'NO_MODEL')
  } finally {
    for (const dispose of disposers.reverse()) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 忽略清理失败 */
      }
    }
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})
