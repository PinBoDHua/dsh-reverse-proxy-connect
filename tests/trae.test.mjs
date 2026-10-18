/**
 * Trae 协议层用例。
 *
 * 这一层几乎全是「猜错就静默坏掉」的东西，所以每条都对着一个真实的失败现象：
 *
 * - `tc` 信封解错 → 卡片显示「未登录」，但 Trae 明明是登录的；
 * - 少一个请求头 → 401「not able to authenticate you」，完全看不出缺了什么；
 * - 目录解析漏掉 `is_invisible_to_user` → 选择器里出现 `browser_use_subagent`；
 * - 工具调用的 `parameters` 传对象 → 上游 400，工具循环直接不可用；
 * - 工具分片不按 `index` 累积 → 一次正常调用被拆成两段，参数丢一半；
 * - 额度用 `consumption_ratio` 反推 → 剩余量被四舍五入成错的数字。
 *
 * @module dsh-reverse-proxy-connect/tests/trae
 */

import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  TRAE_ENDPOINTS,
  decryptStorageValue,
  describeStoredAuth,
  detectEncType,
  endpointsFor,
  exchangeRefreshToken,
  generateTempToken,
  needsRefresh,
  readStoredAuth,
  resolveTraeCredential,
  storagePathsFor,
} from '../lib/trae/credential.js'
import {
  buildChatBody,
  interpretCheckinStatus,
  interpretClaim,
  kindOfStatus,
  normalizeUsage,
  parseCatalog,
  parseCredits,
  parseRetryAfter,
  parseStream,
  toTraeMessages,
  toTraeTools,
  traeHeaders,
} from '../lib/trae/transport.js'

/** 测试用的盐（与实现里的一致，用来构造一个合法的 `tc` 信封）。 */
const SALT_A = [
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]
const SALT_B = [
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]

/**
 * 造一个合法的 `tc` 信封（`AES` 类型）。
 * @param plaintext - 明文 JSON。
 * @returns base64 字符串。
 */
function sealTc(plaintext) {
  const random = Buffer.alloc(32)
  for (let index = 0; index < 32; index++) random[index] = (index * 37 + 11) & 0xff
  const salt = Buffer.alloc(64)
  for (let index = 0; index < 64; index++) salt[index] = SALT_A[index] ^ SALT_B[index]
  const first = createHash('sha512').update(random).digest()
  const second = createHash('sha512').update(Buffer.concat([first, salt])).digest()
  const body = Buffer.from(plaintext, 'utf8')
  const hash = createHash('sha512').update(body).digest()
  const cipher = createCipheriv('aes-128-cbc', second.subarray(0, 16), second.subarray(16, 32))
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([hash, body])), cipher.final()])
  return Buffer.concat([Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]), random, encrypted]).toString('base64')
}

/** 造一个临时 Trae 用户目录，返回 storage.json 的路径。 */
function writeStorage(edition, authObject) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-trae-'))
  const dir = join(root, edition, 'User', 'globalStorage')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'storage.json')
  writeFileSync(file, JSON.stringify({
    'iCubeAuthInfo://icube.cloudide': sealTc(JSON.stringify(authObject)),
  }))
  return file
}

/** 一个最小可用的登录态对象。 */
function authObject(overrides = {}) {
  return {
    token: 'cloudide-token',
    refreshToken: 'refresh-token',
    expiredAt: '2030-01-01T00:00:00.000Z',
    refreshExpiredAt: '2031-01-01T00:00:00.000Z',
    userId: '3616754657145179',
    host: 'https://api.trae.cn',
    userRegion: { region: 'CN' },
    account: { username: '用户2906168306', email: '', avatar_url: 'https://x/y.png' },
    ...overrides,
  }
}

// ---------- 凭证 ----------

test('Trae：tc 信封能解回明文，且校验失败会被拒绝', () => {
  const payload = JSON.stringify(authObject())
  assert.equal(decryptStorageValue(sealTc(payload)), payload)

  // 改掉一个字节：hash 校验必须拦住，而不是返回一段乱码。
  const sealed = Buffer.from(sealTc(payload), 'base64')
  sealed[sealed.length - 1] ^= 0xff
  assert.throws(() => decryptStorageValue(sealed.toString('base64')), /解密失败|校验失败/)

  // 头认不出来时明确报「格式未知」，不要拿一个猜的盐去解。
  const unknown = Buffer.alloc(64)
  assert.throws(() => decryptStorageValue(unknown.toString('base64')), /未知的加密格式/)
})

test('Trae：两种信封头分别识别，其余一律 UNKNOWN', () => {
  assert.equal(detectEncType(Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00])), 'AES')
  assert.equal(detectEncType(Buffer.from([18, 57, 32, 32, 2, 3])), 'AES_PRIVATE')
  assert.equal(detectEncType(Buffer.from([1, 2, 3, 4, 5, 6])), 'UNKNOWN')
  assert.equal(detectEncType(Buffer.from([0x74, 0x63])), 'UNKNOWN')
})

test('Trae：storage.json 能被读出来，缺文件与缺账号信息各有明确原因', () => {
  const file = writeStorage('Trae CN', authObject())
  const auth = readStoredAuth('trae', file)
  assert.equal(auth.token, 'cloudide-token')
  assert.equal(auth.userId, '3616754657145179')
  assert.equal(auth.name, '用户2906168306')
  assert.equal(auth.file, file)
  assert.equal(auth.expiredAtMs, Date.parse('2030-01-01T00:00:00.000Z'))

  // 明文 JSON（老版本国际版）也要能读。
  const root = mkdtempSync(join(tmpdir(), 'dsh-trae-plain-'))
  const dir = join(root, 'Trae', 'User', 'globalStorage')
  mkdirSync(dir, { recursive: true })
  const plain = join(dir, 'storage.json')
  writeFileSync(plain, JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': JSON.stringify(authObject({ token: 'plain-token' })) }))
  assert.equal(readStoredAuth('trae-global', plain).token, 'plain-token')

  // 手填的路径不存在时会退回自动发现；一个都找不到才报错。这里把 APPDATA 指到
  // 一个空目录，模拟「这台机器上没装 Trae」。
  const savedAppData = process.env.APPDATA
  process.env.APPDATA = mkdtempSync(join(tmpdir(), 'dsh-trae-none-'))
  try {
    assert.throws(() => readStoredAuth('trae', join(root, 'nope.json')), /没有找到 Trae 的登录文件/)
  } finally {
    if (savedAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = savedAppData
  }
})

test('Trae：候选路径包含国内版与国际版两个目录', () => {
  const cn = storagePathsFor('trae')
  const global = storagePathsFor('trae-global')
  assert.ok(cn.some((path) => path.includes('Trae CN')), '国内版路径应包含 Trae CN')
  assert.ok(global.some((path) => path.includes(`${join('Roaming', 'Trae')}`) || path.includes('Trae/User')), '国际版路径应指向 Trae')
  // 两个变体的目录名不能混：混了就会拿国内版的登录去配国际版。
  assert.notEqual(TRAE_ENDPOINTS.trae.dataDirName, TRAE_ENDPOINTS['trae-global'].dataDirName)
})

test('Trae：登录态描述在文件损坏时返回 signed-out 而不是抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-trae-bad-'))
  const file = join(root, 'storage.json')
  writeFileSync(file, '{ not json')
  const status = describeStoredAuth('trae', file)
  assert.equal(status.status, 'signed-out')
  assert.ok(typeof status.message === 'string' && status.message !== '')
})

test('Trae：needsRefresh 按 1 天余量判断，缺过期时间时视为要续', () => {
  const now = Date.parse('2026-10-18T00:00:00Z')
  assert.equal(needsRefresh(now + 2 * 24 * 3600_000, now), false)
  assert.equal(needsRefresh(now + 3600_000, now), true)
  assert.equal(needsRefresh(0, now), true)
  assert.equal(needsRefresh(undefined, now), true)
})

test('Trae：换令牌与续期都要求 ClientSecret，缺字段时上游判无效参数', async () => {
  // 这两条不真的打网络：只断言请求体形状（上游对形状很挑）。
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) })
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ Result: { Token: 'new-jwt', ExpiredAt: 1792897604381, RefreshToken: 'new-refresh', TokenExpireAt: 1792897604381 } })
      },
    }
  }
  try {
    const temp = await generateTempToken('trae', 'cloudide-token')
    assert.equal(temp.token, 'new-jwt')
    assert.equal(temp.expiresAtMs, 1792897604381)
    assert.ok(seen[0].url.includes('/cloudide/api/v3/trae/GenerateTempToken'))

    const refreshed = await exchangeRefreshToken('trae', 'refresh-token', 'uid-1')
    assert.equal(refreshed.token, 'new-jwt')
    assert.equal(refreshed.refreshToken, 'new-refresh')
    const body = seen[1].body
    assert.equal(body.ClientID, 'ono9krqynydwx5')
    assert.equal(body.ClientSecret, '-', 'ClientSecret 必须存在，否则上游回 400 无效参数')
    assert.equal(body.RefreshToken, 'refresh-token')
    assert.ok(seen[1].url.includes('/oauth/ExchangeToken'))
  } finally {
    globalThis.fetch = original
  }
})

test('Trae：401 换令牌会被翻成「登录已失效」而不是模糊的 HTTP 错误', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async text() {
      return '{"ResponseMetadata":{"Error":{"Code":"20310"}}}'
    },
  })
  try {
    await assert.rejects(() => generateTempToken('trae', 'expired'), /登录状态可能已失效/)
  } finally {
    globalThis.fetch = original
  }
})

test('Trae：账号里已有可用 JWT 时不再打登录文件，也不需要网络', async () => {
  // 缓存里已经有 5 天有效的 JWT：即使登录文件读不到，也不该让请求失败。
  // 这里把 APPDATA 指到空目录，确保不会意外读到本机真实登录。
  const savedAppData = process.env.APPDATA
  process.env.APPDATA = mkdtempSync(join(tmpdir(), 'dsh-trae-cache-'))
  try {
    const credential = await resolveTraeCredential({
      variantId: 'trae',
      stored: { accessToken: 'cached-jwt', expiresAtMs: Date.now() + 5 * 24 * 3600_000, uid: 'u1' },
      authFile: 'Z:\\definitely-missing\\storage.json',
    })
    assert.equal(credential.jwt, 'cached-jwt')
    assert.equal(credential.userId, 'u1')
  } finally {
    if (savedAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = savedAppData
  }
})

test('Trae：没有缓存令牌且读不到登录文件时给出可操作的原因', async () => {
  const savedAppData = process.env.APPDATA
  process.env.APPDATA = mkdtempSync(join(tmpdir(), 'dsh-trae-miss-'))
  try {
    await assert.rejects(
      () => resolveTraeCredential({ variantId: 'trae', stored: undefined, authFile: 'Z:\\missing\\storage.json' }),
      /没有找到 Trae 的登录文件/,
    )
  } finally {
    if (savedAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = savedAppData
  }
})

// ---------- 请求头与工具 ----------

test('Trae：请求头带齐认证三件套与设备身份', () => {
  const headers = traeHeaders('trae', { jwt: 'jwt-1', userId: 'uid-1' }, 'text/event-stream')
  assert.equal(headers.Authorization, 'Cloud-IDE-JWT jwt-1')
  assert.equal(headers['X-Cloudide-Token'], 'jwt-1')
  assert.equal(headers['X-Ide-Token'], 'jwt-1')
  assert.equal(headers['X-Uid'], 'uid-1')
  assert.equal(headers['X-App-Id'], '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8')
  assert.equal(headers['Request-Traffic-Type'], 'prod')
  assert.equal(headers['X-User-Region'], 'CN')
  assert.equal(headers.Accept, 'text/event-stream')
  assert.equal(headers['x-dsh-attribution-product'], 'deepseek-harness')
  // 设备身份每次都换：固定值会让上游把它当成一台长期在线的设备。
  const other = traeHeaders('trae', { jwt: 'jwt-1', userId: 'uid-1' }, 'text/event-stream')
  assert.notEqual(headers['X-Machine-Id'], other['X-Machine-Id'])
  // 国际版区域不同，不能串。
  assert.equal(traeHeaders('trae-global', { jwt: 'j', userId: '' }, 'application/json')['X-User-Region'], 'SG')
})

test('Trae：工具定义的 parameters 必须序列化成字符串', () => {
  const tools = toTraeTools([{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  }])
  assert.equal(tools.length, 1)
  assert.equal(typeof tools[0].function.parameters, 'string')
  assert.deepEqual(JSON.parse(tools[0].function.parameters), {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  })
  assert.equal(toTraeTools([]), undefined)
  assert.equal(toTraeTools(undefined), undefined)
  // 没有 parameters 的也要补一个合法空 schema，而不是留 undefined。
  const bare = toTraeTools([{ function: { name: 'ping' } }])
  assert.deepEqual(JSON.parse(bare[0].function.parameters), { type: 'object', properties: {} })
})

test('Trae：消息里的 developer 角色改成 system，content 必须是块数组', () => {
  const messages = toTraeMessages([
    { role: 'developer', content: 'be nice' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
    { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', content: 'result', tool_call_id: 'c1' },
  ])
  assert.equal(messages[0].role, 'system')
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'be nice' }])
  assert.deepEqual(messages[1].content, [
    { type: 'text', text: 'hi' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
  ])
  assert.equal(messages[2].role, 'assistant')
  assert.equal(messages[2].content[0].text, 'ok')
  assert.equal(messages[2].content[1].type, 'tool_calls')
  assert.equal(messages[2].content[1].tool_calls[0].function_call.name, 'f')
  assert.equal(messages[3].tool_call_id, 'c1')
})

test('Trae：请求体固定 stream=true，并带 request_id 与 session_id', () => {
  const body = buildChatBody({ messages: [{ role: 'user', content: 'hi' }], model: 'glm-5.2', maxTokens: 1234 })
  assert.equal(body.stream, true)
  assert.equal(body.function, 'solo_work_lite')
  assert.equal(body.model, 'glm-5.2')
  assert.equal(body.max_tokens, 1234)
  assert.ok(typeof body.request_id === 'string' && body.request_id !== '')
  assert.ok(typeof body.session_id === 'string' && body.session_id !== '')
  // 没给 tools 时不能出现空数组：上游对空 tools 的处理与「没有这个字段」不同。
  assert.equal(body.tools, undefined)
})

// ---------- 目录 ----------

test('Trae：目录跳过内部 agent、自定义模型槽位与关掉的模型', () => {
  const models = parseCatalog({
    config_info_list: [
      {
        config_name: 'glm-5.2',
        config_switch: true,
        context_window_tokens: { dev: 200_000 },
        display_config: { display_name: 'GLM-5.2', model_capability: 'reasoning_model', multimodal: false },
        display_contact_config: JSON.stringify({ consumption_rate: { enable: true, data: { rate: 0.78 } } }),
        reasoning_effort_config: { support_thinking: false },
      },
      { config_name: 'browser_use_subagent', config_switch: true, is_invisible_to_user: true, context_window_tokens: { dev: 184_000 }, display_config: { display_name: '' } },
      { config_name: 'custom_model_1M', config_switch: true, context_window_tokens: { dev: 1_000_000 }, display_config: { display_name: '' } },
      { config_name: 'old-model', config_switch: false, context_window_tokens: { dev: 100_000 }, display_config: { display_name: 'Old' } },
      { config_name: 'no-window', config_switch: true, context_window_tokens: {}, display_config: { display_name: 'NoWindow' } },
      null,
    ],
  })
  assert.equal(models.length, 1)
  const model = models[0]
  assert.equal(model.id, 'glm-5.2')
  assert.equal(model.name, 'GLM-5.2')
  assert.equal(model.contextWindow, 200_000)
  assert.equal(model.supportsImages, false)
  assert.equal(model.credits, 'x0.78')
  assert.deepEqual(model.reasoningEfforts, [])
})

test('Trae：多模态模型声明图片能力，max 窗口作为兜底', () => {
  const models = parseCatalog({
    config_info_list: [{
      config_name: 'Doubao-Seed-2.1-Turbo',
      config_switch: true,
      context_window_tokens: { max: 256_000 },
      display_config: { display_name: 'Seed-2.1-Turbo', multimodal: true, is_beta: true },
      display_contact_config: 'not json',
    }],
  })
  assert.equal(models.length, 1)
  assert.equal(models[0].contextWindow, 256_000)
  assert.equal(models[0].supportsImages, true)
  assert.equal(models[0].beta, true)
  // 倍率读不出来时宁可不写，也不编一个。
  assert.equal(models[0].credits, undefined)
})

test('Trae：support_thinking 为真时才列档位，且不列 none', () => {
  const models = parseCatalog({
    config_info_list: [{
      config_name: 'thinky',
      config_switch: true,
      context_window_tokens: { dev: 100_000 },
      display_config: { display_name: 'Thinky' },
      reasoning_effort_config: { support_thinking: true, reasoning_effort_options: ['none', 'low', 'high', 'high', 'bogus'] },
    }],
  })
  assert.equal(models[0].supportsReasoning, true)
  assert.deepEqual(models[0].reasoningEfforts, ['low', 'high'])
})

test('Trae：工具分片没有 index 时用上一个 index，不拆成两次调用', async () => {
  const text = [
    'event:output',
    'data:{"response":"","tool_calls":[{"id":"c1","function_call":{"name":"","arguments":"{\\"a\\":"}}]}',
    '',
    'event:output',
    'data:{"response":"","tool_calls":[{"function_call":{"name":"do_it","arguments":"1}"}}]}',
    '',
    'event:done',
    'data:{"finish_reason":"tool_calls"}',
    '',
  ].join('\n')
  const tools = []
  for await (const event of parseStream(bodyOf(text), undefined)) if (event.type === 'tool') tools.push(event)
  assert.equal(tools.length, 1, '没有 index 的两片必须落到同一个工具块')
  assert.equal(tools[0].id, 'c1')
  assert.equal(tools[0].name, 'do_it')
  assert.equal(tools[0].argumentsDelta, '{"a":1}')
})

test('Trae：event:done 之后即使连接不关闭也能立即结束', async () => {
  const bytes = new TextEncoder().encode([
    'event:output',
    'data:{"response":"好"}',
    '',
    'event:done',
    'data:{"finish_reason":"stop"}',
    '',
  ].join('\n'))
  let sent = false
  const openBody = {
    getReader() {
      return {
        async read() {
          if (sent) return new Promise(() => {}) // 上游保持连接：只靠 done 结束
          sent = true
          return { done: false, value: bytes }
        },
        async cancel() {},
      }
    },
  }
  const events = await Promise.race([
    (async () => {
      const list = []
      for await (const event of parseStream(openBody, undefined)) list.push(event)
      return list
    })(),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
  ])
  assert.notEqual(events, 'timeout', 'event:done 必须立即收流，而不是等 EOF/空闲超时')
  assert.equal(events.at(-1).type, 'finish')
  assert.equal(events.at(-1).kind, 'stop')
})

// ---------- 流解析 ----------

/**
 * 把一段 SSE 文本包成 `response.body` 形状。
 * @param text - SSE 文本。
 * @returns `{getReader}`。
 */
function bodyOf(text) {
  const bytes = new TextEncoder().encode(text)
  let sent = false
  return {
    getReader() {
      return {
        async read() {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: bytes }
        },
        async cancel() {},
      }
    },
  }
}

test('Trae：流解析把 output 帧拆成正文/思考/工具/用量与终态', async () => {
  const text = [
    'event:metadata',
    'data:{"model":"","session_id":"s"}',
    '',
    'event:output',
    'data:{"response":"","reasoning_content":"想一下"}',
    '',
    'event:output',
    'data:{"response":"你好","reasoning_content":null}',
    '',
    'event:output',
    'data:{"response":"","tool_calls":[{"index":0,"id":"call_1","type":"function","function_call":{"name":"get_weather","arguments":""}}]}',
    '',
    'event:output',
    'data:{"response":"","tool_calls":[{"index":0,"id":"","type":"","function_call":{"name":"","arguments":"{\\"city\\":\\"北京\\"}"}}]}',
    '',
    'event:token_usage',
    'data:{"prompt_tokens":45,"completion_tokens":349,"reasoning_tokens":315,"cache_read_input_tokens":5}',
    '',
    'event:done',
    'data:{"finish_reason":"stop"}',
    '',
  ].join('\n')
  const events = []
  for await (const event of parseStream(bodyOf(text), undefined)) events.push(event)
  const kinds = events.map((event) => event.type)
  assert.ok(kinds.includes('reasoning'), '思考内容要转成 reasoning 事件')
  assert.ok(kinds.includes('text'), '正文要转成 text 事件')
  const tools = events.filter((event) => event.type === 'tool')
  // 第一帧给了 id + name（参数为空），第二帧补参数：分片按 index 累积，
  // 拼起来才是完整的工具调用。
  assert.ok(tools.length >= 1)
  assert.equal(tools[0].name, 'get_weather')
  assert.equal(tools[0].id, 'call_1')
  assert.equal(tools.map((event) => event.argumentsDelta).join(''), '{"city":"北京"}')
  const usage = events.find((event) => event.type === 'usage')
  assert.deepEqual(usage.usage, { inputTokens: 40, outputTokens: 349, cacheReadTokens: 5, reasoningTokens: 315 })
  const finish = events.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.kind, 'tool-calls')
})

test('Trae：工具调用的 name 晚到时会压住参数分片，不把一次调用拆成两段', async () => {
  const text = [
    'event:output',
    'data:{"response":"","tool_calls":[{"index":0,"id":"c9","function_call":{"name":"","arguments":"{\\"a\\":"}}]}',
    '',
    'event:output',
    'data:{"response":"","tool_calls":[{"index":0,"function_call":{"name":"","arguments":"1}"}}]}',
    '',
    'event:output',
    'data:{"response":"","tool_calls":[{"index":0,"function_call":{"name":"do_it","arguments":""}}]}',
    '',
    'event:done',
    'data:{"finish_reason":"tool_calls"}',
    '',
  ].join('\n')
  const tools = []
  for await (const event of parseStream(bodyOf(text), undefined)) if (event.type === 'tool') tools.push(event)
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'do_it')
  assert.equal(tools[0].id, 'c9')
  assert.equal(tools[0].argumentsDelta, '{"a":1}')
})

test('Trae：name 永远不到时兜底补一片，保证宿主找得到 block-end', async () => {
  const text = [
    'event:output',
    'data:{"response":"","tool_calls":[{"index":0,"id":"c1","function_call":{"name":"","arguments":"{}"}}]}',
    '',
    'event:done',
    'data:{"finish_reason":"stop"}',
    '',
  ].join('\n')
  const tools = []
  for await (const event of parseStream(bodyOf(text), undefined)) if (event.type === 'tool') tools.push(event)
  assert.equal(tools.length, 1)
  assert.equal(tools[0].id, 'c1')
  assert.equal(tools[0].argumentsDelta, '{}')
})

test('Trae：event:error 帧按 code 分类（1005 额度、3003 服务端）', async () => {
  const quota = ['event:error', 'data:{"code":1005,"message":"","extra":"{\\"plan\\":4}"}', '', 'event:done', 'data:{"finish_reason":"stop"}', ''].join('\n')
  await assert.rejects(async () => {
    for await (const _event of parseStream(bodyOf(quota), undefined)) {
      /* 只关心抛错 */
    }
  }, (error) => error.kind === 'quota')

  const server = ['event:error', 'data:{"code":3003,"message":"model service is unavailable"}', ''].join('\n')
  await assert.rejects(async () => {
    for await (const _event of parseStream(bodyOf(server), undefined)) {
      /* 只关心抛错 */
    }
  }, (error) => error.kind === 'server')
})

test('Trae 内容安全拦截：终态带 CONTENT_FILTER failure，而不是一个没有 code 的 error', async () => {
  // 用户可见行为：模型因内容安全被拦截时，界面/统计要能显示「内容过滤」，
  // 而不是一句没有 code、没有 message 的通用错误。
  const text = [
    'event:output',
    'data:{"finish_reason":"content_filter"}',
    '',
    'event:done',
    'data:{}',
    '',
  ].join('\n')
  const events = []
  for await (const event of parseStream(bodyOf(text), undefined)) events.push(event)
  const finish = events.find((event) => event.type === 'finish')
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure?.code, 'CONTENT_FILTER', 'content_filter 终态必须带可路由的 failure code')
  assert.match(finish.failure?.message ?? '', /内容安全|content_filter/)
})

test('Trae：只有元信息帧时发心跳（不转发、但重置空闲计时器）', async () => {
  const text = [
    'event:metadata',
    'data:{"model":"m"}',
    '',
    'event:timing_cost',
    'data:{"name":"llm_raw_chat_v2"}',
    '',
  ].join('\n')
  const events = []
  for await (const event of parseStream(bodyOf(text), undefined)) events.push(event)
  assert.ok(events.some((event) => event.type === 'heartbeat'))
  assert.equal(events.filter((event) => event.type === 'text').length, 0)
})

test('Trae：usage 归一化会扣掉缓存命中量', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, cache_read_input_tokens: 30 }), {
    inputTokens: 70,
    outputTokens: 20,
    cacheReadTokens: 30,
  })
  assert.deepEqual(normalizeUsage({}), { inputTokens: 0, outputTokens: 0 })
})

// ---------- 额度与签到 ----------

test('Trae：额度按总额减已消耗算，不用四舍五入的比例反推', () => {
  const credits = parseCredits({
    is_credits_billing: true,
    usage_summary: { consumed_amount: 600.1, consumption_ratio: 0.750125, total_amount: 800 },
    user_entitlement_pack_list: [{ display_desc: '免费', entitlement_base_info: { quota: { credit_amount: 200 } } }],
  })
  assert.equal(credits.state, 'ok')
  assert.equal(credits.total, 800)
  assert.equal(credits.used, 600.1)
  assert.equal(credits.remain, 199.9)
  assert.equal(credits.unit, 'credits')
  assert.equal(credits.freePlan, undefined)
  assert.equal(credits.items[0].name, '免费')
})

test('Trae：总额为 0 时按免费套餐处理，不是「已用尽」', () => {
  const credits = parseCredits({ usage_summary: { consumed_amount: 0, total_amount: 0 } })
  assert.equal(credits.remain, 0)
  assert.equal(credits.freePlan, true)
  assert.equal(credits.planName, 'Free')
})

test('Trae：签到状态与领取结果的码都覆盖到', () => {
  assert.equal(interpretCheckinStatus({ checked_in: true, credits: 100, extra_credits: 100 }).kind, 'already')
  assert.equal(interpretCheckinStatus({ checked_in: false, credits: 100, extra_credits: 50 }).kind, 'active')
  assert.equal(interpretCheckinStatus({ checked_in: false, enable: false }).kind, 'inactive')
  assert.equal(interpretCheckinStatus(null).kind, 'failed')

  assert.equal(interpretClaim({ code: 0, message: 'success' }).kind, 'claimed')
  assert.equal(interpretClaim({ code: 10001 }).kind, 'already')
  assert.equal(interpretClaim({ code: 500, message: 'boom' }).kind, 'failed')
  assert.equal(interpretClaim({ code: 500, message: 'boom' }).message, 'boom')
})

test('Trae：HTTP 状态到失败类别的映射与换号判据一致', () => {
  assert.equal(kindOfStatus(401), 'auth')
  assert.equal(kindOfStatus(403), 'auth')
  assert.equal(kindOfStatus(402), 'quota')
  assert.equal(kindOfStatus(429), 'soft-rate')
  assert.equal(kindOfStatus(500), 'server')
  assert.equal(kindOfStatus(400), 'malformed')
})

test('Trae：Retry-After 支持秒数与 HTTP 日期，并夹到 10 分钟', () => {
  const now = Date.parse('2026-10-18T00:00:00Z')
  assert.equal(parseRetryAfter('30', now), 30_000)
  assert.equal(parseRetryAfter('99999', now), 600_000)
  assert.equal(parseRetryAfter(new Date(now + 60_000).toUTCString(), now), 60_000)
  assert.equal(parseRetryAfter(undefined, now), undefined)
  assert.equal(parseRetryAfter('soon', now), undefined)
})

test('Trae：两个变体的端点不混用', () => {
  assert.equal(endpointsFor('trae').apiHost, 'https://api.trae.cn')
  assert.equal(endpointsFor('trae').chatHost, 'https://trae-api-cn.mchost.guru')
  assert.equal(endpointsFor('trae-global').apiHost, 'https://api.trae.ai')
  assert.equal(endpointsFor('trae-global').chatHost, 'https://a0ai-api-sg.byteintlapi.com')
  assert.equal(endpointsFor('unknown').apiHost, 'https://api.trae.cn')
})
