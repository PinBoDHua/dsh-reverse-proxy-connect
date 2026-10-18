/**
 * 共享常量：宿主半边与浏览器半边都必须一致的字面量。
 *
 * 这个模块**不许** import 任何 node: 内建模块 —— 它会被浏览器 bundle 直接
 * 复制过去（见 scripts/build-client.mjs 里的常量内联），一旦引入 node:fs
 * 之类的东西，页面加载就会失败。
 *
 * @module dsh-reverse-proxy-connect/protocol
 */

/** 插件数据目录（位于 profile 目录下，与 dsh-qoder-connect 的惯例一致）。 */
export const DATA_DIR_NAME = '.dsh-reverse-proxy-connect'

/** 数据目录的环境变量覆盖。 */
export const DATA_DIR_ENV = 'DSH_REVERSE_PROXY_DATA_DIR'

/** provider 路由 id —— DSH 的模型选择器按这些 id 分组。 */
export const PROVIDERS = Object.freeze({
  workbuddy: 'workbuddy',
  workbuddyAi: 'workbuddy-ai',
  qoder: 'qoder',
  qoderGlobal: 'qoder-global',
  trae: 'trae',
  traeGlobal: 'trae-global',
})

/** 各 provider 的展示信息。 */
export const PROVIDER_META = Object.freeze({
  [PROVIDERS.workbuddy]: Object.freeze({
    id: PROVIDERS.workbuddy,
    displayName: 'WorkBuddy',
    // 国内版桌面端（腾讯 CodeBuddy 系）
    variant: 'workbuddy',
    credentialKind: 'desktop',
    envAuthFile: 'WORKBUDDY_AUTH_FILE',
    envElectron: 'WORKBUDDY_ELECTRON_BIN',
    appName: 'WorkBuddy',
  }),
  [PROVIDERS.workbuddyAi]: Object.freeze({
    id: PROVIDERS.workbuddyAi,
    displayName: 'WorkBuddy AI',
    variant: 'workbuddy-ai',
    credentialKind: 'desktop',
    envAuthFile: 'WORKBUDDY_AI_AUTH_FILE',
    envElectron: 'WORKBUDDY_AI_ELECTRON_BIN',
    appName: 'WorkBuddy AI',
  }),
  [PROVIDERS.qoder]: Object.freeze({
    id: PROVIDERS.qoder,
    displayName: 'Qoder',
    variant: 'qoder',
    credentialKind: 'pat',
    envPat: 'QODER_CN_PERSONAL_ACCESS_TOKEN',
    appName: 'Qoder',
  }),
  [PROVIDERS.qoderGlobal]: Object.freeze({
    id: PROVIDERS.qoderGlobal,
    displayName: 'Qoder Global',
    variant: 'qoder-global',
    credentialKind: 'pat',
    envPat: 'QODER_PERSONAL_ACCESS_TOKEN',
    appName: 'Qoder Global',
  }),
  // Trae 的凭证是桌面端的加密登录态（`storage.json` 里的 `tc` 信封），
  // 与 WorkBuddy 的「明文/加密登录文件」不同，所以单独一类 `desktop-auth`：
  // 卡片据此显示「登录文件路径」而不是 PAT 输入框。
  [PROVIDERS.trae]: Object.freeze({
    id: PROVIDERS.trae,
    displayName: 'Trae',
    variant: 'trae',
    credentialKind: 'desktop-auth',
    envAuthFile: 'TRAE_CN_STORAGE_FILE',
    appName: 'Trae CN',
  }),
  [PROVIDERS.traeGlobal]: Object.freeze({
    id: PROVIDERS.traeGlobal,
    displayName: 'Trae Global',
    variant: 'trae-global',
    credentialKind: 'desktop-auth',
    envAuthFile: 'TRAE_GLOBAL_STORAGE_FILE',
    appName: 'Trae',
  }),
})

/** 全部 provider id，按展示顺序。 */
export const PROVIDER_IDS = Object.freeze(Object.values(PROVIDERS))

/** 状态文档的接口版本：客户端据此判断字段是否齐全。 */
export const STATUS_VERSION = 7

/** 同源设置接口：GET 读状态，POST 写设置；诊断只读且已脱敏。 */
export const STATUS_PATH = '/plugins/dsh-reverse-proxy-connect/status'
export const SETTINGS_PATH = '/plugins/dsh-reverse-proxy-connect/settings'
export const ACTION_PATH = '/plugins/dsh-reverse-proxy-connect/action'
export const DIAGNOSTICS_PATH = '/plugins/dsh-reverse-proxy-connect/diagnostics'

/**
 * 写接口的请求体上限（字节）。
 *
 * `/settings` 的补丁里可能有 20 个账号 × 每个几千字的 PAT，几十 KB 就够；
 * 这里给 1MB 是宽松但明确的上限，超了直接 413 并断开连接，不让一个坏客户端
 * 把进程内存吃满。
 */
export const REQUEST_BODY_LIMIT = 1_000_000

/** 错误码：卡片据此分支，不看文案。 */
export const REASON = Object.freeze({
  noCredential: 'no-credential',
  credentialUnreadable: 'credential-unreadable',
  credentialExpired: 'credential-expired',
  appNotFound: 'app-not-found',
  appAmbiguous: 'app-ambiguous',
  appPathInvalid: 'app-path-invalid',
  regionMismatch: 'region-mismatch',
  patInvalid: 'pat-invalid',
  upstreamError: 'upstream-error',
  proxyDown: 'proxy-down',
  imageUnavailable: 'image-unavailable',
  timeout: 'timeout',
})

/**
 * 上游流的**空闲**超时：多久没有收到任何事件就认定卡死。
 *
 * 注意这与「整条流总时长」不是一回事：长思考、长代码输出可以持续几分钟，
 * 只要一直有数据就不该被打断。旧版本把 5 分钟当成总超时，会把正常的
 * 长回答直接切断。
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 180_000

/** 打开上游连接（等响应头）的超时。与流空闲超时分开计。 */
export const OPEN_TIMEOUT_MS = 60_000

/** 目录自动刷新间隔的默认值。 */
export const DEFAULT_CATALOG_REFRESH_MS = 600_000

/** 额度自动刷新间隔的默认值。 */
export const DEFAULT_CREDITS_REFRESH_MS = 120_000

/** Qoder 免费模型排队时本地等待预算的默认值。 */
export const DEFAULT_QODER_QUEUE_WAIT_MS = 60_000

/** 凭证过期前的刷新余量。 */
export const REFRESH_MARGIN_MS = 300_000
