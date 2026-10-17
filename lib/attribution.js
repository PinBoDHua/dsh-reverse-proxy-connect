/**
 * 请求归因：让上游能看到这些流量来自 DeepSeek Harness 的插件，而不是伪装成
 * 官方客户端。
 *
 * DSH 的 `LlmAdapter` 约定每个 provider 请求都带 `attributionHeaders()`
 * （标准实现里就是 `User-Agent: deepseek-harness/<version> (+url)`）。
 * 本插件不能照抄这条约定：WorkBuddy 的 `/v3/config` **按 User-Agent 决定返回哪份
 * 花名册**，换成 DSH 的 UA 会直接拿不到 `cli` agent（详见 README）。
 *
 * 所以折中：UA 保持上游要求的客户端身份，另外追加一个不影响上游解析的
 * `x-dsh-attribution` 头，写明「由哪个插件、哪个版本发起」。既满足归因的
 * 精神，也不破坏上游协议。
 *
 * @module dsh-reverse-proxy-connect/attribution
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 产品名（与 package.json 的 name 一致）。 */
export const PRODUCT = 'dsh-reverse-proxy-connect'

/** 仓库地址（与 package.json 的 homepage 一致）。 */
export const HOMEPAGE = 'https://github.com/PinBoDHua/dsh-reverse-proxy-connect'

/** 自述：`<product>/<version> (+<url>)`，与 DSH 的 UA 形式一致。 */
function selfIdentity() {
  let version = '0.0.0'
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    if (typeof pkg.version === 'string' && pkg.version !== '') version = pkg.version
  } catch {
    /* 读不到就用占位版本，归因头不值得让请求失败 */
  }
  return `${PRODUCT}/${version} (+${HOMEPAGE})`
}

/** 缓存的头对象。 */
const HEADERS = Object.freeze({
  'x-dsh-attribution': selfIdentity(),
  'x-dsh-attribution-product': 'deepseek-harness',
})

/**
 * 归因头（合并进任何上游请求）。
 *
 * 返回的是共享的冻结对象，调用方应展开（`...attributionHeaders()`）而不是修改它。
 *
 * @returns 头字典。
 */
export function attributionHeaders() {
  return HEADERS
}
