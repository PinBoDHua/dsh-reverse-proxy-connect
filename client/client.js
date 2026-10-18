window.__ModuleLoader__.load({
  id: 'dsh-reverse-proxy-connect',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    // ────────────────────────────────────────────────────────────────
    // 与宿主同源的接口路径与状态结构（lib/protocol.js 的浏览器侧镜像）。
    // 刻意写死字面量：宿主 bundle 与浏览器 bundle 独立构建，共享表达式
    // 只会在构建配置漂移时变成「卡片问了个宿主没挂的路由」。
    // ────────────────────────────────────────────────────────────────
    var STATUS_PATH = '/plugins/dsh-reverse-proxy-connect/status'
    var SETTINGS_PATH = '/plugins/dsh-reverse-proxy-connect/settings'
    var ACTION_PATH = '/plugins/dsh-reverse-proxy-connect/action'
    var DIAGNOSTICS_PATH = '/plugins/dsh-reverse-proxy-connect/diagnostics'

    /** 本 bundle 读得懂的状态文档版本（与 lib/protocol.js 的 STATUS_VERSION 对齐）。 */
    var EXPECTED_STATUS_VERSION = 8

    var SHARED_SECTION_SLOT = 'settings.section'
    var SHARED_SECTION_ID = 'plugin-settings'
    var SHARED_SECTION_ORDER = 900
    var SHARED_ITEM_SLOT = 'plugin-settings.item'
    var SHARED_ITEM_ID = 'dsh-reverse-proxy-connect'
    var PLUGIN_MANAGER_SLOT = 'plugins.bundle.config'
    var PLUGIN_MANAGER_KEY = 'dsh-reverse-proxy-connect'

    var inject = ['slots', 'locale']

    var POLL_MS = 20000

    /**
     * 插件自带的两组主题自适应属性。
     *
     * 宿主 0.2.1 的 ui-theme 里没有 `--dsw-alias-bg-l2` / `--dsw-alias-state-warning-primary`
     * 这两个名字（真实 token：背景是 `bg-layer-1/2/3`，警告色是 `state-warn-*`），
     * 旧代码里的 `var(--dsw-alias-bg-l2, ...)` 永远走 fallback —— 亮色下勉强能用，
     * 暗色下就是一块浅灰。这里注入插件自己的变量，亮/暗主题各一套；注入失败时
     * 每个使用点仍保留原来的 fallback 值。
     */
    var THEME_STYLE_ID = 'dsh-reverse-proxy-connect-theme'
    function ensureThemeStyles() {
      try {
        if (typeof document === 'undefined' || document === null || typeof document.getElementById !== 'function') return
        if (document.getElementById(THEME_STYLE_ID) !== null && document.getElementById(THEME_STYLE_ID) !== undefined) return
        if (typeof document.createElement !== 'function') return
        var style = document.createElement('style')
        if (style === null || style === undefined) return
        style.id = THEME_STYLE_ID
        style.textContent =
          ':root{--dsh-rpc-warn:#9d5c00;--dsh-rpc-fill:rgba(20,28,45,.06)}' +
          'body[data-ds-dark-theme]{--dsh-rpc-warn:#f0a63c;--dsh-rpc-fill:rgba(255,255,255,.08)}'
        var head = document.head
        if (head === undefined || head === null) {
          head = typeof document.getElementsByTagName === 'function' ? document.getElementsByTagName('head')[0] : undefined
        }
        if (head === undefined || head === null || typeof head.appendChild !== 'function') return
        head.appendChild(style)
      } catch (_) {
        /* 宿主没有 DOM（SSR / 纯数据测试）时静默跳过，使用内联 fallback */
      }
    }

    /** 侧栏底部那一排（宿主 `dsh-client-ui-sidebar` 声明）。 */
    var SIDEBAR_FOOTER_SLOT = 'sidebar.footer.action'

    /** 内嵌面板的 id（给 aria-controls 用）。 */
    var PANEL_ID = 'dsh-reverse-proxy-connect-credits-panel'

    // ── 文案 ────────────────────────────────────────────────────────
    var zh = {
      nav: '反代连接器',
      title: '反代连接器',
      intro: '把 WorkBuddy、Qoder 与 Trae 的账号模型接进 DSH：多账号、额度趋势与事件账本。',
      service: '服务',
      refresh: '刷新',
      refreshing: '刷新中…',
      enabled: '接入',
      disabled: '已关闭',
      models: '模型',
      noModels: '还没有模型。请先登录对应 App，或填好个人访问令牌（PAT）。',
      catalogLive: '已从上游拉取',
      catalogSaved: '上游不可达，显示上次结果',
      catalogNone: '尚无目录',
      signedIn: '已登录',
      signedOut: '未登录',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      pat: '个人访问令牌（PAT）',
      patHint: '在账号设置 → 个人访问令牌里生成，粘贴到这里。保存后会立即重新拉取模型目录。',
      patConfigured: '已保存（末尾 {tail}）',
      patPlaceholder: '粘贴 pt-… 开头的令牌',
      clear: '清除',
      showAll: '全部开启',
      hideAll: '全部关闭',
      appPath: 'App 可执行文件（可选）',
      appPathHint: '留空自动查找。填 WorkBuddy.exe / WorkBuddyAI.exe 的完整路径可跳过注册表探测。',
      authFile: '登录文件（可选）',
      authFileHint: '留空读取默认位置：%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth。',
      traeStorageFile: 'Trae 登录文件（可选）',
      traeStorageFileHint: '留空自动查找：%APPDATA%\\Trae CN\\User\\globalStorage\\storage.json（国际版为 Trae\\User\\globalStorage\\storage.json）。',
      traeSignedIn: '已读取本机 Trae 登录：{name}',
      traeSignInHint: '还没有读到 Trae 登录。请先打开 Trae 客户端登录一次，插件会直接复用那份登录态（不需要粘贴令牌）。',
      maxContext: '使用上游声明的最大上下文窗口',
      diagnostics: '诊断',
      copyDiagnostics: '复制诊断',
      copied: '已复制',
      kindDesktop: '读取桌面端登录',
      kindPat: '使用个人访问令牌',
      kindDesktopAuth: '复用桌面端登录态',
      fixed: '固定',
      reasoning: '推理档位',
      noReasoning: '不支持推理档位',
      error: '出错了',
      loading: '读取中…',
      probe: '检测账号可用模型',
      probing: '检测中…',
      probeHint: '逐个模型发一次极短请求，把账号用不了的自动隐藏（不消耗对话额度）。每 6 小时最多一次。',
      probeLast: '上次检测：{time}',
      probeNever: '尚未检测',
      unavailable: '账号不支持',
      unavailableHint: '这些模型产品里有、但你这个账号用不了。勾选可强制显示并自行尝试。',
      unavailableCount: '{count} 个模型账号不支持',
      forceShow: '强制显示',
      forced: '已强制显示',
      credits: '积分',
      creditsNone: '未读取',
      creditsUnlimited: '不限量',
      creditsUnit: '积分',
      creditsRefresh: '刷新积分',
      creditsRefreshing: '读取中…',
      creditsPlan: '套餐',
      creditsReset: '最近到期',
      creditsExhausted: '额度已用尽',
      creditsFreeQueue: '免费模型排队',
      creditsFree: '免费',
      creditsFreeShort: '免费',
      creditsPackages: '{count} 个套餐包',
      creditsPackageFallback: '额度包',
      usageHeatCell: '{date} · {requests} 次 · {tokens} tok',
      creditsFailed: '额度暂时读不到：{message}',
      creditsFetchedAt: '更新于 {time}',
      modelRateToggle: '在模型名后显示倍率',
      modelRateHint: 'DSH 的模型选择器只显示名字，倍率只有拼在名字里才看得见。',
      search: '搜索模型',
      searchPlaceholder: '按名字或 id 过滤…',
      searchEmpty: '没有匹配的模型。',
      pillHint: '数据每 2 分钟自动刷新',
      creditsStale: '上次结果，正在刷新…',
      creditsCachedHint: '显示上次结果 · 可手动刷新',
      creditsCached: '缓存数据',
      creditsSources: '{count} 家',
      creditsPercent: '{percent}%',
      creditsToday: '今日 {count} 次 · {tokens} tok',
      creditsCurrent: '当前 {label}',
      creditsNoData: '未读取',
      creditsUnreadable: '读取失败',
      creditsNeedLogin: '未登录',
      creditsResetShort: '到期 {date}',
      catalogBuiltin: '内置兜底列表（上游不可达且没有存档）',
      summary: '账号总览',
      secStatus: '状态',
      secConnection: '连接设置',
      show: '展开',
      hide: '收起',
      secAccounts: '账号',
      autoSwitch: '额度用完自动切换',
      accountsHintPat: '可以为同一个 provider 添加多个 PAT；当前账号积分用完后会按上面的开关自动切换。',
      accountsHintDesktop: '桌面账号用上面的「浏览器登录新增账号」添加；本机已有登录会自动读取。',
      accountLabel: '账号名称',
      accountPat: '粘贴个人访问令牌（PAT）',
      accountAuthFile: '登录文件路径（留空 = 读本机登录）',
      accountSecretHint: '令牌只保存在本机设置里，不会回传到浏览器。',
      accountDefaultLabel: '新账号',
      addAccount: '添加账号',
      useAccount: '使用',
      removeAccount: '删除',
      currentAccount: '当前',
      checkinNow: '立即签到',
      checkinRunning: '签到中…',
      checkinOff: '自动签到已关闭',
      checkinNever: '还没有签到记录',
      checkinClaimed: '本次签到成功：{count} 个账号，+{credit} 积分',
      checkinAlready: '今天已签到',
      checkinInactive: '当前账号没有签到活动',
      checkinFailed: '签到失败：{reason}',
      checkinUnconfigured: '有账号未登录，已跳过自动签到',
      checkinLastAt: '上次尝试 {time}',
      checkinAuto: '自动签到',
      checkinAutoHint: '每天自动检查一次；失败 10 分钟后重试。关闭后只能手动点。',
      checkinAutoDone: '今日已完成',
      checkinRetryHint: '上次失败，10 分钟后自动重试',
      loginAdd: '浏览器登录新增账号',
      loginOpening: '正在打开…',
      loginCancel: '取消',
      loginOpenManually: '没有自动打开？点这里',
      // 1.0.0 新增：健康、用量、高级
      healthOk: '正常',
      healthDegraded: '降级',
      healthDown: '不可用',
      healthUnknown: '无记录',
      usage: '用量',
      usageToday: '今日',
      usageTotal: '累计',
      usageRequests: '{count} 次请求',
      usageCalls: '请求',
      usageRate: '成功率',
      usageAvg: '平均耗时',
      usageTokens: '{count} tokens',
      usageTokenShort: 'tokens',
      usageTime: '时间',
      usageSuccess: '成功率 {rate}%',
      usageLatency: '平均 {ms}',
      usageRecent: '最近请求',
      usageEmpty: '还没有请求记录。发一次消息后这里会出现用量。',
      usageDisabled: '用量统计已关闭（可在高级设置里打开）。',
      usageReset: '重置统计',
      usageResetting: '重置中…',
      usageResetDone: '已重置',
      usageSince: '统计起点 {time}',
      usageModel: '模型',
      usageDuration: '耗时',
      usageOutcome: '结果',
      usageKindStop: '完成',
      usageKindTools: '工具调用',
      usageKindMaxTokens: '达到上限',
      usageKindError: '失败',
      usageKindAborted: '已取消',
      usageKindIncomplete: '中断',
      advanced: '高级',
      advancedHint: '这些参数一般不需要改；改错了也不会让插件失效，数字会被夹到安全区间。',
      advancedIdle: '流空闲超时（秒）',
      advancedIdleHint: '多久没有新数据就判定卡死。长回答只要持续出字就不会被打断。',
      advancedCatalog: '目录刷新间隔（秒）',
      advancedCredits: '额度刷新间隔（秒）',
      advancedStats: '记录用量统计',
      advancedCache: '把模型目录缓存到磁盘（重启后立即有模型）',
      advancedAlertsEnabled: '启用额度预警（横幅与琥珀色）',
      advancedProbe: '自动检测账号可用模型（每 6 小时最多一次）',
      advancedSave: '保存高级设置',
      advancedSaved: '已保存',
      imagesOn: '图片输入已启用',
      imagesOff: '宿主未提供附件服务，图片输入不可用',
      catalogDisk: '已缓存（启动时恢复）',
      patOpen: '打开 PAT 页面',
      patLinkHint: '还没有令牌？',
      usageInSidebar: '侧栏显示今日用量',
      summaryProviders: '六个 provider',
      accountSourceBrowser: '浏览器登录',
      accountSourceDesktop: '桌面登录',
      accountSourcePat: 'PAT',
      lastErrorAt: '最近失败 {time}',
      lastFailure: '最近一次失败：{code} · {model} · {time}',
      settingsCorrupt: '设置文件读取失败，已使用默认值；原文件已备份，请检查 settings.json。',
      settingsCorruptBackup: '备份：{path}',
      statusVersionMismatch: '客户端与宿主的状态版本不一致（宿主 v{host}，客户端期望 v{client}）。请刷新页面；仍然不一致时请重启 DeepSeek Harness，避免看到不完整的设置。',
      consecutiveFailures: '{count} 连败',
      imagesShort: '图',
      listSeparator: '、',
      // 1.1.0：额度趋势、预警与账号测试
      trend: '额度趋势',
      trendToday: '今日消耗 {value}',
      trendWeek: '近 7 天 {value}',
      trendRate: '约 {value}/小时',
      trendEta: '预计还能用 {duration}',
      trendEtaUnknown: '样本不足，暂不估算',
      trendTopup: '今日补充 {value}',
      trendHint: '按最近成功读取的额度估算，充值不会算进消耗。',
      alertLow: '额度偏低',
      alertExhausted: '额度已用尽',
      alertBannerLow: '额度偏低：{names}。建议切换账号或等待重置。',
      alertBannerExhausted: '额度已用尽：{names}。',
      testAccount: '测试',
      testing: '测试中…',
      testOk: '正常 {ms}',
      testFailed: '失败：{reason}',
      cooldown: '冷却至 {time}',
      resetCooldown: '解除冷却',
      usageSession: '当前会话',
      usageHeatmap: '近 14 天',
      usageTopModels: '模型用量',
      usageAccountModels: '账号 × 模型用量',
      usageAccountModelsHint: '同一个模型可能被多个账号用过；这一栏按账号分开算 token。',
      usageAccountModelCoverage: '已记录 {covered} / {total} 次（{percent}%）：历史请求拆不出账号，只从 1.9.x 起累积',
      usageAccountModelTodayEmpty: '今天这个账号还没有新的请求记录；下表是累计数据（账号 × 模型从 1.9.x 起累积，历史请求拆不出账号）。',
      usageAccountModelStatus: '状态',
      modelTest: '检测',
      modelTesting: '检测中…',
      modelTestOk: '可用',
      modelTestFailed: '失败',
      limitBadge: '限额',
      authBadge: '失效',
      limitUntil: '限额至 {time}',
      recentLimitHint: '最近一次请求被上游限额（{code}）',
      usageAccountCol: '账号',
      usageAllAccounts: '全部账号',
      usageModelCalls: '请求',
      usageModelTokens: 'tokens',
      usageShowInSidebar: '侧栏显示今日用量',
      advancedAlert: '额度预警阈值（%）',
      advancedAlertHint: '剩余低于该比例时，侧栏与卡片亮警示色。',
      advancedSwitch: '低于该比例自动换号（%）',
      advancedSwitchHint: '0 = 只在额度用尽时切换；换号只发生在还有其它可用账号时。',
      advancedQueue: 'Qoder 排队等待上限（秒）',
      advancedQueueHint: '免费模型排队时最多等这么久；调大可以等更久，但会占用一次请求。',
      freeModelHint: 'Free 套餐的付费额度为 0；免费模型不扣积分，但高峰期会排队。可在「高级」里延长排队等待。',
      usageNoUsage: '上游没有返回 token 统计；这里显示 0 不代表没有消耗。',
      // 2.0.0：事件账本
      eventTitle: '最近事件',
      eventHint: '记录换号、令牌续期、目录/额度降级、签到与探测；只保留最近 200 条元数据。',
      eventEmpty: '还没有事件。后台发生换号、续期或降级时会记在这里。',
      eventNoMatch: '没有符合筛选的事件。',
      eventAll: '全部',
      eventSwitchFilter: '换号',
      eventProblemFilter: '异常',
      eventCredentialFilter: '凭证',
      eventClear: '清空',
      eventClearConfirm: '清空最近事件？只影响本机事件账本，不影响账号与设置。',
      eventCount: '{count} 条',
      eventMore: '展开全部 {count} 条',
      eventLess: '收起',
      eventStartup: '启动',
      eventSwitch: '换号',
      eventRefresh: '令牌续期',
      eventCredential: '凭证',
      eventCatalog: '目录',
      eventCredits: '额度',
      eventCheckin: '签到',
      eventProbe: '探测',
      eventLogin: '登录',
      eventSettings: '设置',
      eventStats: '统计',
      eventEvents: '账本',
      eventTest: '账号测试',
      eventUnknown: '事件',
      eventRetained: '仅保留最近 {count} 条，更早的事件已轮转。',
      searchOnlyUnavailable: '没有可用的匹配模型；{count} 个「账号不支持」的模型匹配，可在下方勾选强制显示。',
      advancedInvalid: '超出允许范围：{min}–{max}。',
      advancedClamped: '已按宿主安全范围保存：{fields}。',
      removeConfirm: '再次点击确认删除',
      removeAccountAria: '删除账号 {name}',
      // 2.3.0：失败重试、a11y 与国际化补齐
      imagesShortOff: '无图',
      statusLoadFailed: '读取状态失败',
      statusLoadFailedHint: '插件没有拿到 /status。宿主可能还没就绪，也可能后台进程刚重启；可以稍等或手动重试。',
      retry: '重试',
      retrying: '重试中…',
      checkinNeedLogin: '先登录再签到',
      refreshFailed: '刷新失败，稍后重试',
      copyFailed: '复制失败',
      copyFallbackHint: '自动复制失败，请手动选中下面的文本复制。',
    }
    var en = {
      nav: 'Reverse proxy',
      title: 'Reverse proxy connector',
      intro: 'Bring WorkBuddy, Qoder and Trae account models into DSH — multi-account, credit trends and an event journal.',
      service: 'Service',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      enabled: 'Enabled',
      disabled: 'Disabled',
      models: 'Models',
      noModels: 'No models yet. Sign in to the desktop app, or save a personal access token.',
      catalogLive: 'Fetched from upstream',
      catalogSaved: 'Upstream unreachable — showing the last result',
      catalogNone: 'No catalog yet',
      signedIn: 'Signed in',
      signedOut: 'Signed out',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      pat: 'Personal access token',
      patHint: 'Generate one under account settings → personal access tokens, then paste it here. The catalog reloads on save.',
      patConfigured: 'Saved (ends with {tail})',
      patPlaceholder: 'Paste a pt-… token',
      clear: 'Clear',
      showAll: 'Enable all',
      hideAll: 'Disable all',
      appPath: 'App executable (optional)',
      appPathHint: 'Leave empty to auto-detect. Point it at WorkBuddy.exe / WorkBuddyAI.exe to skip registry probing.',
      authFile: 'Sign-in file (optional)',
      authFileHint: 'Empty reads the default location: %LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth.',
      traeStorageFile: 'Trae sign-in file (optional)',
      traeStorageFileHint: 'Empty auto-detects: %APPDATA%\\Trae CN\\User\\globalStorage\\storage.json (Trae\\User\\globalStorage\\storage.json for the global build).',
      traeSignedIn: 'Using the local Trae sign-in: {name}',
      traeSignInHint: 'No Trae sign-in found yet. Open the Trae client and sign in once — the plugin reuses that session, no token needed.',
      maxContext: 'Use the upstream maximum context window',
      diagnostics: 'Diagnostics',
      copyDiagnostics: 'Copy diagnostics',
      copied: 'Copied',
      kindDesktop: 'Reads the desktop sign-in',
      kindPat: 'Uses a personal access token',
      kindDesktopAuth: 'Reuses the desktop session',
      fixed: 'fixed',
      reasoning: 'Reasoning levels',
      noReasoning: 'No reasoning levels',
      error: 'Something went wrong',
      loading: 'Loading…',
      probe: 'Check which models my account can use',
      probing: 'Checking…',
      probeHint: 'Sends one tiny request per model and hides the ones this account cannot use. Runs at most once per 6 hours.',
      probeLast: 'Last check: {time}',
      probeNever: 'Not checked yet',
      unavailable: 'Not in plan',
      unavailableHint: 'These models exist in the product but your account cannot use them. Tick to force-show and try anyway.',
      unavailableCount: '{count} models not in this plan',
      forceShow: 'Force show',
      forced: 'Force-shown',
      credits: 'Credits',
      creditsNone: 'Not read yet',
      creditsUnlimited: 'Unlimited',
      creditsUnit: 'credits',
      creditsRefresh: 'Refresh credits',
      creditsRefreshing: 'Reading…',
      creditsPlan: 'Plan',
      creditsReset: 'Expires',
      creditsExhausted: 'Quota exhausted',
      creditsFreeQueue: 'Free model queues',
      creditsFree: 'Free',
      creditsFreeShort: 'free',
      creditsPackages: '{count} packages',
      creditsPackageFallback: 'Credit package',
      usageHeatCell: '{date} · {requests} requests · {tokens} tok',
      creditsFailed: 'Credits unavailable: {message}',
      creditsFetchedAt: 'Updated {time}',
      modelRateToggle: 'Show rate after model names',
      modelRateHint: 'DSH’s model picker renders the name only, so the rate has to live in the name to be visible.',
      search: 'Search models',
      searchPlaceholder: 'Filter by name or id…',
      searchEmpty: 'No model matches.',
      pillHint: 'Refreshes every 2 minutes',
      creditsStale: 'Last known — refreshing…',
      creditsCachedHint: 'Showing the last result · refresh manually',
      creditsCached: 'Cached',
      creditsSources: '{count} providers',
      creditsPercent: '{percent}%',
      creditsToday: 'Today {count} calls · {tokens} tok',
      creditsCurrent: 'Current: {label}',
      creditsNoData: 'Not read yet',
      creditsUnreadable: 'Read failed',
      creditsNeedLogin: 'Signed out',
      creditsResetShort: 'Expires {date}',
      catalogBuiltin: 'Built-in fallback list (upstream unreachable, no saved catalog)',
      summary: 'Accounts',
      secStatus: 'Status',
      secConnection: 'Connection',
      show: 'Expand',
      hide: 'Collapse',
      secAccounts: 'Accounts',
      autoSwitch: 'Switch when out of credits',
      accountsHintPat: 'Add more than one PAT per provider; when the current account runs out, it switches automatically.',
      accountsHintDesktop: 'Add desktop accounts with “Add account via browser login” above; an existing local sign-in is picked up automatically.',
      accountLabel: 'Account name',
      accountPat: 'Paste a personal access token',
      accountAuthFile: 'Sign-in file path (blank = local sign-in)',
      accountSecretHint: 'Tokens stay in the local settings file and are never sent back to the browser.',
      accountDefaultLabel: 'New account',
      addAccount: 'Add account',
      useAccount: 'Use',
      removeAccount: 'Remove',
      currentAccount: 'Current',
      checkinNow: 'Check in',
      checkinRunning: 'Checking in…',
      checkinOff: 'Auto check-in is off',
      checkinNever: 'No check-in yet',
      checkinClaimed: 'Checked in: {count} account(s), +{credit} credits',
      checkinAlready: 'Already checked in today',
      checkinInactive: 'No check-in activity for this account',
      checkinFailed: 'Check-in failed: {reason}',
      checkinUnconfigured: 'Some accounts are not signed in, so check-in was skipped',
      checkinLastAt: 'Last attempt {time}',
      checkinAuto: 'Auto check-in',
      checkinAutoHint: 'Checks once a day; failed attempts retry after 10 minutes. Turn it off to check in manually only.',
      checkinAutoDone: 'Done for today',
      checkinRetryHint: 'Last attempt failed; retrying in 10 minutes',
      loginAdd: 'Add account via browser login',
      loginOpening: 'Opening…',
      loginCancel: 'Cancel',
      loginOpenManually: 'Not opened? Click here',
      // 1.0.0 additions: health, usage, advanced
      healthOk: 'Healthy',
      healthDegraded: 'Degraded',
      healthDown: 'Unavailable',
      healthUnknown: 'No data',
      usage: 'Usage',
      usageToday: 'Today',
      usageTotal: 'All time',
      usageRequests: '{count} requests',
      usageCalls: 'Requests',
      usageRate: 'Success',
      usageAvg: 'Avg time',
      usageTokens: '{count} tokens',
      usageTokenShort: 'tokens',
      usageTime: 'Time',
      usageSuccess: '{rate}% success',
      usageLatency: '{ms} avg',
      usageRecent: 'Recent requests',
      usageEmpty: 'No requests recorded yet. Send a message and the usage will show up here.',
      usageDisabled: 'Usage recording is off (enable it in Advanced).',
      usageReset: 'Reset stats',
      usageResetting: 'Resetting…',
      usageResetDone: 'Reset',
      usageSince: 'Counting since {time}',
      usageModel: 'Model',
      usageDuration: 'Took',
      usageOutcome: 'Outcome',
      usageKindStop: 'Completed',
      usageKindTools: 'Tool calls',
      usageKindMaxTokens: 'Max tokens',
      usageKindError: 'Failed',
      usageKindAborted: 'Cancelled',
      usageKindIncomplete: 'Interrupted',
      advanced: 'Advanced',
      advancedHint: 'You normally do not need these. Out-of-range values are clamped to safe bounds.',
      advancedIdle: 'Stream idle timeout (seconds)',
      advancedIdleHint: 'How long without any data before the stream is considered stuck. Long answers keep flowing and are never cut off.',
      advancedCatalog: 'Catalog refresh interval (seconds)',
      advancedCredits: 'Credits refresh interval (seconds)',
      advancedStats: 'Record usage statistics',
      advancedCache: 'Cache the model catalog on disk (models appear instantly after a restart)',
      advancedAlertsEnabled: 'Enable low-credit warnings (banner and amber accents)',
      advancedProbe: 'Probe which models the account can use (at most once per 6 hours)',
      advancedSave: 'Save advanced settings',
      advancedSaved: 'Saved',
      imagesOn: 'Image input enabled',
      imagesOff: 'The host exposes no attachment service, so image input is unavailable',
      catalogDisk: 'Cached (restored at startup)',
      patOpen: 'Open the PAT page',
      patLinkHint: 'Need a token first?',
      usageInSidebar: 'Show today’s usage in the sidebar',
      summaryProviders: 'Six providers',
      accountSourceBrowser: 'Browser login',
      accountSourceDesktop: 'Desktop login',
      accountSourcePat: 'PAT',
      lastErrorAt: 'Last failure {time}',
      lastFailure: 'Last failure: {code} · {model} · {time}',
      settingsCorrupt: 'Settings could not be read; defaults are in use. The original file was backed up — check settings.json.',
      settingsCorruptBackup: 'Backup: {path}',
      statusVersionMismatch: 'The client and host status versions differ (host v{host}, client expects v{client}). Refresh the page; if it persists, restart DeepSeek Harness so the settings are not rendered incomplete.',
      consecutiveFailures: '{count} in a row',
      imagesShort: 'img',
      listSeparator: ', ',
      // 1.1.0: credit trend, alerts, account tests
      trend: 'Credit trend',
      trendToday: 'Today {value}',
      trendWeek: 'Last 7 days {value}',
      trendRate: '~{value}/hour',
      trendEta: '~{duration} left',
      trendEtaUnknown: 'Not enough samples yet',
      trendTopup: 'Added today {value}',
      trendHint: 'Estimated from successful credit reads; top-ups are not counted as spend.',
      alertLow: 'Low credits',
      alertExhausted: 'Out of credits',
      alertBannerLow: 'Low credits: {names}. Switch accounts or wait for a reset.',
      alertBannerExhausted: 'Out of credits: {names}.',
      testAccount: 'Test',
      testing: 'Testing…',
      testOk: 'OK {ms}',
      testFailed: 'Failed: {reason}',
      cooldown: 'Cooling down until {time}',
      resetCooldown: 'Clear cooldown',
      usageSession: 'This session',
      usageHeatmap: 'Last 14 days',
      usageTopModels: 'Model usage',
      usageAccountModels: 'Account × model usage',
      usageAccountModelsHint: 'The same model can be used by several accounts; this table splits tokens per account.',
      usageAccountModelCoverage: 'Recorded {covered} of {total} requests ({percent}%): older requests carry no account split',
      usageAccountModelTodayEmpty: 'No new requests for this account today; showing cumulative data (account × model only accumulates from 1.9.x).',
      usageAccountModelStatus: 'Status',
      modelTest: 'Test',
      modelTesting: 'Testing…',
      modelTestOk: 'OK',
      modelTestFailed: 'Failed',
      limitBadge: 'Limited',
      authBadge: 'Auth',
      limitUntil: 'Limited until {time}',
      recentLimitHint: 'The latest request was limited upstream ({code})',
      usageAccountCol: 'Account',
      usageAllAccounts: 'All accounts',
      usageModelCalls: 'Requests',
      usageModelTokens: 'tokens',
      usageShowInSidebar: 'Show today’s usage in the sidebar',
      advancedAlert: 'Low-credit warning threshold (%)',
      advancedAlertHint: 'The sidebar and card turn amber below this remaining ratio.',
      advancedSwitch: 'Switch accounts below (%)',
      advancedSwitchHint: '0 = switch only when exhausted; switching requires another usable account.',
      advancedQueue: 'Qoder queue wait limit (seconds)',
      advancedQueueHint: 'How long to wait for a queued free model; raising it can wait longer but holds the request.',
      freeModelHint: 'The Free plan has no paid quota; free models cost no credits but may queue at peak times. You can raise the wait limit under Advanced.',
      usageNoUsage: 'The upstream did not report token usage; 0 here does not mean nothing was consumed.',
      // 2.0.0: event journal
      eventTitle: 'Recent events',
      eventHint: 'Account switches, token refreshes, catalog/credit fallbacks, check-ins and probes; only the latest 200 metadata entries are kept.',
      eventEmpty: 'No events yet. Background switches, refreshes and fallbacks will appear here.',
      eventNoMatch: 'No events match this filter.',
      eventAll: 'All',
      eventSwitchFilter: 'Switches',
      eventProblemFilter: 'Problems',
      eventCredentialFilter: 'Credentials',
      eventClear: 'Clear',
      eventClearConfirm: 'Clear recent events? Only the local event journal is affected; accounts and settings are untouched.',
      eventCount: '{count} events',
      eventMore: 'Show all {count} events',
      eventLess: 'Collapse',
      eventStartup: 'Startup',
      eventSwitch: 'Account switch',
      eventRefresh: 'Token refresh',
      eventCredential: 'Credential',
      eventCatalog: 'Catalog',
      eventCredits: 'Credits',
      eventCheckin: 'Check-in',
      eventProbe: 'Probe',
      eventLogin: 'Login',
      eventSettings: 'Settings',
      eventStats: 'Stats',
      eventEvents: 'Journal',
      eventTest: 'Account test',
      eventUnknown: 'Event',
      eventRetained: 'Only the latest {count} events are kept; older entries have rotated out.',
      searchOnlyUnavailable: 'No available model matches; {count} model(s) not in this plan match — expand the list below to force-show one.',
      advancedInvalid: 'Out of range: {min}–{max}.',
      advancedClamped: 'Saved with host-safe values: {fields}.',
      removeConfirm: 'Click again to confirm',
      removeAccountAria: 'Remove account {name}',
      // 2.3.0: failure retry, a11y and i18n
      imagesShortOff: 'no img',
      statusLoadFailed: 'Failed to load status',
      statusLoadFailedHint: 'The plugin could not read /status. The host may not be ready yet, or the backend just restarted; wait a moment or retry.',
      retry: 'Retry',
      retrying: 'Retrying…',
      checkinNeedLogin: 'Sign in before checking in',
      refreshFailed: 'Refresh failed, please try again later',
      copyFailed: 'Copy failed',
      copyFallbackHint: 'Automatic copy failed. Select the text below and copy it manually.',
    }

    function bind(t, key, vars) {
      var text = t(key)
      if (vars === undefined) return text
      return String(text).replace(/\{(\w+)\}/g, function (_, name) {
        return vars[name] === undefined ? '' : String(vars[name])
      })
    }

    /**
     * 诊断面板里可展示的状态副本：去掉写接口控制密钥，并缩掉用户目录。
     *
     * `/status` 里的 `key` 能改设置、触发签到/测试/登录，绝不能出现在
     * 设置页的 `<pre>` 里（截图、共享屏幕都会泄露）。路径同理，至少把
     * 用户名缩掉，避免排障截图带出本机账号。
     */
    function displayStatus(status) {
      var secretKeys = { key: true, pat: true, token: true, accesstoken: true, refreshtoken: true, authorization: true, cookie: true, secret: true }
      var redactText = function (text) {
        return String(text)
          .replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/g, '$1<user>')
          .replace(/\/Users\/[^/\s"']+/g, '/Users/<user>')
          .replace(/\/home\/[^/\s"']+/g, '/home/<user>')
          .replace(/([?&]state=)[^&\s"']+/g, '$1<redacted>')
      }
      var walk = function (value, name) {
        if (typeof value === 'string') return redactText(value)
        if (value === null || typeof value !== 'object') return value
        if (Array.isArray(value)) return value.map(function (item) { return walk(item, name) })
        var out = {}
        Object.keys(value).forEach(function (childKey) {
          if (secretKeys[String(childKey).toLowerCase()] === true) {
            out[childKey] = '[redacted]'
            return
          }
          out[childKey] = walk(value[childKey], childKey)
        })
        return out
      }
      return walk(status, '')
    }

    /** 只保留数组里的对象元素：状态可能来自手改过的磁盘缓存，不能信任。 */
    function safeArray(value) {
      return Array.isArray(value) ? value.filter(function (item) { return item !== null && typeof item === 'object' }) : []
    }

    /** 数字千分位（模块级，卡片与侧栏小卡共用）。 */
    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      var rounded = Math.round(value * 10) / 10
      return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /** 各 provider 的强调色（与 DSH 主题变量兼容，取不到就用兜底色）。 */
    var PROVIDER_ACCENT = {
      workbuddy: '#2f6fed',
      'workbuddy-ai': '#7a5af8',
      qoder: '#12a594',
      'qoder-global': '#0f9d8f',
      trae: '#e0533d',
      'trae-global': '#d97757',
    }

    /** 短名，给小卡用。 */
    function shortProviderName(provider) {
      if (provider === 'workbuddy') return 'WB'
      if (provider === 'workbuddy-ai') return 'WBAI'
      if (provider === 'qoder') return 'QD'
      if (provider === 'qoder-global') return 'QDG'
      if (provider === 'trae') return 'TRAE'
      if (provider === 'trae-global') return 'TRAEG'
      return provider.slice(0, 4).toUpperCase()
    }

    /**
     * 紧凑数字：上万折成 k，一万以下仍带千分位。
     *
     * 之前 2388 在汇总卡/胶囊显示「2388」、详情却是「2,388」，同一份数据两种
     * 写法；现在 <10000 走 formatNumber，>=10000 才缩写，保证同屏数字格式一致。
     */
    function compactNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value >= 10000) return String(Math.round(value / 100) / 10) + 'k'
      return formatNumber(value)
    }

    /** 大数缩写：1.2K / 400.3M / 1.1B（KPI 卡片用，完整数字放 title）。 */
    function compactTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
      if (value >= 1e9) return String(Math.round((value / 1e9) * 10) / 10) + 'B'
      if (value >= 1e6) return String(Math.round((value / 1e6) * 10) / 10) + 'M'
      if (value >= 1e3) return String(Math.round((value / 1e3) * 10) / 10) + 'K'
      return String(Math.round(value))
    }

    /** 低于这个比例就提前提醒，别等到真的见底。 */
    var LOW_CREDITS_RATIO = 0.15

    /**
     * 高级设置的前端校验区间，与 lib/settings.js 的 ADVANCED_LIMITS 对齐
     * （毫秒换算成秒：idle 15-900、catalog 120-86400、credits 30-21600、
     * queue 15-180；另外两个是百分数：预警 1-95、自动换号 0-50）。
     * 后端保存时还会再夹一次，前端先校验是为了把「静默回退」变成行内提示。
     */
    var ADVANCED_LIMITS = {
      idle: { min: 15, max: 900 },
      catalog: { min: 120, max: 86400 },
      credits: { min: 30, max: 21600 },
      queue: { min: 15, max: 180 },
      alert: { min: 1, max: 95 },
      switchRatio: { min: 0, max: 50 },
    }
    /** 返回 'empty' / 'nan' / 'range' / ''（合法）。 */
    function advancedInputError(value, limit) {
      var text = String(value === undefined || value === null ? '' : value).trim()
      if (text === '') return 'empty'
      var parsed = Number(text)
      if (!Number.isFinite(parsed)) return 'nan'
      if (parsed < limit.min || parsed > limit.max) return 'range'
      return ''
    }

    /**
     * 这份额度是否该亮警示色。
     *
     * 三个条件任一成立：已用尽、上游标记超额、或剩余不足 15%。
     * 第三条是刻意的 —— 等到 0 才变色已经太晚了。
     *
     * @param credits - 额度快照。
     * @returns 是否警示。
     */
    function isCreditsLow(credits, ratio) {
      var threshold = typeof ratio === 'number' && ratio > 0 && ratio < 1 ? ratio : LOW_CREDITS_RATIO
      if (credits.unlimited === true) return false
      if (credits.exceeded === true) return true
      if (typeof credits.remain === 'number' && credits.remain <= 0) return true
      if (typeof credits.total === 'number' && credits.total > 0 && typeof credits.remain === 'number') {
        return credits.remain / credits.total <= threshold
      }
      return false
    }

    /**
     * Qoder Free 的 0 付费额度不是「用尽」：免费模型仍可用，只是排队。
     * 返回 true 时不要把它标成红色/已用尽。
     *
     * 优先认宿主写入的 `freePlan`（1.3.0），老宿主/老缓存则看套餐名与 paid。
     */
    function isQoderFreePlan(provider, credits) {
      if (typeof provider !== 'string' || provider.indexOf('qoder') !== 0) return false
      if (credits === undefined || credits === null) return false
      if (credits.state !== undefined && credits.state !== 'ok') return false
      if (typeof credits.total === 'number' && credits.total > 0) return false
      if (credits.freePlan === true) return true
      if (credits.paid === false) return true
      var plan = typeof credits.planName === 'string' ? credits.planName.toLowerCase() : ''
      return plan === 'free' || plan.indexOf('free') !== -1 || plan.indexOf('免费') !== -1
    }

    /**
     * 额度是否该亮警示色。
     *
     * 三个条件任一成立：已用尽、上游标记超额、或剩余低于阈值。
     * Qoder Free 的 0 不算；`alerts.enabled === false` 时整个警示色关闭 ——
     * 1.2.0 只关掉了横幅，侧栏与卡片仍然在亮，属于同一个开关两套行为。
     *
     * @param credits - 额度快照。
     * @param provider - provider id。
     * @param ratio - 低额度比例。
     * @param enabled - 预警是否开启。
     * @returns 是否警示。
     */
    function creditsWarning(credits, provider, ratio, enabled) {
      if (enabled === false) return false
      if (credits === undefined || credits === null || credits.state !== 'ok') return false
      if (isQoderFreePlan(provider, credits)) return false
      return isCreditsLow(credits, ratio)
    }

    /** 额度预警等级：优先用宿主算好的，老宿主没有就按同一套规则补。 */
    function alertOfCredits(credits, ratio, provider, enabled) {
      if (enabled === false) return undefined
      if (credits === undefined || credits === null || credits.state !== 'ok') return undefined
      if (isQoderFreePlan(provider, credits)) return undefined
      if (credits.alert === 'low' || credits.alert === 'exhausted') return credits.alert
      if (credits.unlimited === true) return undefined
      if (credits.exceeded === true || (typeof credits.remain === 'number' && credits.remain <= 0)) return 'exhausted'
      if (typeof credits.total === 'number' && credits.total > 0 && typeof credits.remain === 'number') {
        var threshold = typeof ratio === 'number' && ratio > 0 && ratio < 1 ? ratio : LOW_CREDITS_RATIO
        if (credits.remain / credits.total <= threshold) return 'low'
      }
      return undefined
    }

    /** 毫秒 → 紧凑时长（45m / 3h 20m / 2d 4h）。 */
    function formatCompactDuration(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '—'
      var minutes = Math.max(1, Math.round(ms / 60000))
      if (minutes < 60) return String(minutes) + 'm'
      var hours = Math.floor(minutes / 60)
      var restMinutes = minutes % 60
      if (hours < 24) return String(hours) + 'h' + (restMinutes > 0 ? ' ' + String(restMinutes) + 'm' : '')
      var days = Math.floor(hours / 24)
      var restHours = hours % 24
      return String(days) + 'd' + (restHours > 0 ? ' ' + String(restHours) + 'h' : '')
    }

    /** 百分比整数。 */
    function ratioPercent(ratio) {
      if (typeof ratio !== 'number' || !isFinite(ratio)) return '—'
      return String(Math.round(ratio * 100)) + '%'
    }

    /**
     * 一条极简折线。额度趋势不需要坐标轴，只要「在涨还是在跌」。
     *
     * @param points - `[{at, remain}]`。
     * @param color - 线色。
     * @returns SVG 节点，或 undefined（少于两个点）。
     */
    function sparkline(points, color) {
      var valid = (Array.isArray(points) ? points : []).filter(function (point) {
        return point !== null && typeof point === 'object' && typeof point.remain === 'number' && isFinite(point.remain)
      })
      if (valid.length < 2) return undefined
      var min = valid[0].remain
      var max = valid[0].remain
      for (var index = 1; index < valid.length; index++) {
        if (valid[index].remain < min) min = valid[index].remain
        if (valid[index].remain > max) max = valid[index].remain
      }
      var span = max - min
      var coordinates = valid.map(function (point, index) {
        var x = valid.length === 1 ? 50 : (index / (valid.length - 1)) * 100
        var y = span <= 0 ? 12 : 22 - ((point.remain - min) / span) * 20
        return String(Math.round(x * 10) / 10) + ',' + String(Math.round(y * 10) / 10)
      })
      return h('svg', {
        viewBox: '0 0 100 24',
        preserveAspectRatio: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', width: '100%', height: 22, overflow: 'visible' },
      }, h('polyline', {
        points: coordinates.join(' '),
        fill: 'none',
        stroke: color === undefined ? 'currentColor' : color,
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        vectorEffect: 'non-scaling-stroke',
      }))
    }

    /** 额度百分比（读不到 / 不限量 / 没有总量 / 余额非有限时返回 undefined）。 */
    function creditsPercentOf(credits) {
      if (credits === undefined || credits.state !== 'ok') return undefined
      if (credits.unlimited === true) return undefined
      if (!(credits.total > 0)) return undefined
      if (!Number.isFinite(credits.remain)) return undefined
      return Math.max(0, Math.min(100, Math.round((credits.remain / credits.total) * 100)))
    }

    /**
     * 把额度拆成「大数字 + 小分母 + 单位」，给侧栏面板做层级。
     *
     * 旧版把「775 / 1,300 积分」塞进一个 12.5px 的粗体串里，三个数字一样重，
     * 一眼看不出重点是「还剩多少」。
     */
    function creditsValueParts(credits, t) {
      if (credits === undefined || credits.state !== 'ok') {
        return {
          big: '—',
          small: credits !== undefined && credits.state === 'none' ? bind(t, 'creditsNoData') : bind(t, 'creditsUnreadable'),
          unit: '',
        }
      }
      if (credits.unlimited === true) return { big: '∞', small: '', unit: bind(t, 'creditsUnit') }
      return {
        big: formatNumber(credits.remain),
        small: credits.total > 0 ? '/ ' + formatNumber(credits.total) : '',
        unit: bind(t, 'creditsUnit'),
      }
    }

    /** 侧栏面板里的小徽标。 */
    function microChip(color) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0 5px',
        borderRadius: 999,
        fontSize: 10,
        lineHeight: '15px',
        fontWeight: 500,
        color: color === undefined ? 'var(--dsw-alias-label-secondary)' : color,
        background: 'var(--dsh-rpc-fill, rgba(127,127,127,.10))',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      }
    }

    /** 比较两条错误文案是否在说同一件事（空白归一化后互相包含也算）。 */
    function isSameMessage(a, b) {
      var left = String(a === undefined || a === null ? '' : a).replace(/\s+/g, ' ').trim()
      var right = String(b === undefined || b === null ? '' : b).replace(/\s+/g, ' ').trim()
      if (left === '' || right === '') return false
      return left === right || left.indexOf(right) !== -1 || right.indexOf(left) !== -1
    }

    /**
     * 卡片与签到区里用的短错误。
     *
     * 凭证缺失的原始文案会带两三个绝对路径，塞进签到行里就是三四行橙色文字。
     * 这里只保留「未登录」；完整原因仍然在状态区显示一次。
     */
    function shortErrorMessage(message, t) {
      var text = String(message === undefined || message === null ? '' : message).replace(/\s+/g, ' ').trim()
      if (text === '') return '—'
      if (/没有找到|登录文件|尚未保存|未登录|no-credential|not found|signed out|sign in/i.test(text)) return bind(t, 'creditsNeedLogin')
      var http = /HTTP\s*\d{3}/i.exec(text)
      if (http !== null) return http[0]
      return text.length > 48 ? text.slice(0, 48) + '…' : text
    }

    /**
     * 一份额度快照的人话描述。
     *
     * 「读不到」与「真的是 0」必须长得不一样：前者走错误文案，后者才显示 0 ——
     * 否则用户会以为额度被清零了。
     *
     * @param credits - 状态文档里的 credits。
     * @param t - 文案绑定。
     * @returns 描述文本。
     */
    function formatCreditsText(credits, t) {
      if (credits === undefined || credits.state === 'none') return bind(t, 'creditsNone')
      // 读失败（上游 5xx / 没配凭证）**不能**退化成「0 积分」：
      // 那看起来像是这个账号真的一分额度都没有了。
      if (credits.state === 'error') return bind(t, 'creditsUnreadable')
      if (credits.unlimited === true) return bind(t, 'creditsUnlimited')
      var remain = formatNumber(credits.remain)
      var total = credits.total > 0 ? ' / ' + formatNumber(credits.total) : ''
      var unit = credits.unit === 'credits' ? bind(t, 'creditsUnit') : ''
      return remain + total + ' ' + unit
    }

    /** 健康状态的文案键。 */
    function healthTextKey(state) {
      if (state === 'ok') return 'healthOk'
      if (state === 'degraded') return 'healthDegraded'
      if (state === 'down') return 'healthDown'
      return 'healthUnknown'
    }

    /** 健康状态的颜色。 */
    function healthColor(state) {
      if (state === 'ok') return 'var(--dsw-alias-state-success-primary, #1a8f5f)'
      if (state === 'degraded') return 'var(--dsh-rpc-warn, #9d5c00)'
      if (state === 'down') return 'var(--dsw-alias-state-error-primary, #b3261e)'
      return 'var(--dsw-alias-label-secondary)'
    }

    /** 毫秒 → 人话。 */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
      if (ms < 1000) return String(Math.round(ms)) + 'ms'
      return String(Math.round(ms / 100) / 10) + 's'
    }

    /** 请求终态 → 文案键。 */
    function kindTextKey(kind) {
      if (kind === 'tool-calls') return 'usageKindTools'
      if (kind === 'max-tokens') return 'usageKindMaxTokens'
      if (kind === 'error') return 'usageKindError'
      if (kind === 'aborted') return 'usageKindAborted'
      if (kind === 'incomplete') return 'usageKindIncomplete'
      return 'usageKindStop'
    }

    /**
     * 事件类型 → 文案键（与 lib/events.js 的 eventLabelKey 保持一致）。
     * @param type - 事件类型。
     * @returns 文案键。
     */
    function eventTextKey(type) {
      switch (type) {
        case 'startup':
          return 'eventStartup'
        case 'account-switch':
          return 'eventSwitch'
        case 'credential-refresh':
          return 'eventRefresh'
        case 'credential':
          return 'eventCredential'
        case 'catalog':
          return 'eventCatalog'
        case 'credits':
          return 'eventCredits'
        case 'checkin':
          return 'eventCheckin'
        case 'probe':
          return 'eventProbe'
        case 'login':
          return 'eventLogin'
        case 'settings':
          return 'eventSettings'
        case 'stats':
          return 'eventStats'
        case 'events':
          return 'eventEvents'
        case 'test':
          return 'eventTest'
        default:
          return 'eventUnknown'
      }
    }

    /** 事件级别 → 颜色（info 用弱化色，warn/error 与全站状态色一致）。 */
    function eventColor(level) {
      if (level === 'error') return 'var(--dsw-alias-state-error-primary, #b3261e)'
      if (level === 'warn') return 'var(--dsh-rpc-warn, #9d5c00)'
      return 'var(--dsw-alias-label-secondary)'
    }

    /** Qoder PAT 页面（按区域）。 */
    var PAT_PAGE = {
      qoder: 'https://qoder.cn/account/integrations',
      'qoder-global': 'https://qoder.com/account/integrations',
    }

    // ── 极简样式 ────────────────────────────────────────────────────
    // ── 设计变量 ────────────────────────────────────────────────────
    //
    // 排版按 4px 栅格走：间距只用 4/6/8/10/14/18，字号只用
    // 11.5（辅助）/12.5（正文）/13（强调）/16（标题）四档。
    // 之前是随手写的，所以「已从上游拉取」「更新于」「上次检测」这些
    // 同类信息一会儿 12 一会儿 12.5、行高也不一致，越看越乱。
    var TEXT = {
      tiny: 11.5,
      body: 12.5,
      strong: 13,
      title: 16,
    }

    var LINE = {
      dense: '17px',
      body: '20px',
      loose: '22px',
    }

    // 小字可读性：≤12.5px 的说明文字统一用 label-secondary（亮色 #61666b ≈ 5.9:1），
    // 不再用 label-tertiary（亮色 #81858c ≈ 3.6:1）叠 opacity —— 后者在亮色主题下
    // 连 4.5:1 都不到，叠到 .5 只有 2~3:1。层级靠 secondary vs primary 区分。
    var S = {
      card: {
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        padding: '16px 18px 15px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        boxSizing: 'border-box',
        maxWidth: '100%',
      },

      // 页头
      header: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: TEXT.title, fontWeight: 600, letterSpacing: '.01em', color: 'var(--dsw-alias-label-primary)' },
      version: {
        marginLeft: 'auto',
        fontSize: TEXT.tiny,
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-secondary)',
        userSelect: 'text',
      },
      intro: { margin: 0, fontSize: TEXT.body, lineHeight: LINE.body, color: 'var(--dsw-alias-label-secondary)', maxWidth: 620 },

      // 分组：统一用一条极淡的上边线分隔，省掉原来三种不同的 divider
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
        paddingTop: 12,
        borderTop: '0.5px solid var(--dsw-alias-border-l2)',
      },
      sectionHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      sectionTitle: {
        margin: 0,
        fontSize: TEXT.tiny,
        fontWeight: 600,
        letterSpacing: '.08em',
        color: 'var(--dsw-alias-label-secondary)',
      },
      sectionCount: {
        fontSize: TEXT.tiny,
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-secondary)',
      },

      // 胶囊徽标
      badge: {
        fontSize: TEXT.tiny,
        lineHeight: '18px',
        padding: '0 7px',
        borderRadius: 999,
        border: '0.5px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      badgeWarn: {
        fontSize: TEXT.tiny,
        lineHeight: '18px',
        padding: '0 7px',
        borderRadius: 999,
        border: '0.5px solid var(--dsh-rpc-warn, #9d5c00)',
        color: 'var(--dsh-rpc-warn, #9d5c00)',
        whiteSpace: 'nowrap',
      },
      badgeSoft: {
        fontSize: TEXT.tiny,
        lineHeight: '18px',
        padding: '0 7px',
        borderRadius: 999,
        background: 'var(--dsh-rpc-fill, rgba(127,127,127,.10))',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },

      // 通用行
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      stack: { display: 'flex', flexDirection: 'column', gap: 6 },
      grow: { flex: 1, minWidth: 0 },
      divider: { height: 0, borderTop: '0.5px solid var(--dsw-alias-border-l2)', margin: '2px 0' },
      hint: { margin: 0, fontSize: TEXT.body, lineHeight: LINE.body, color: 'var(--dsw-alias-label-secondary)' },
      hintTiny: { margin: 0, fontSize: TEXT.tiny, lineHeight: LINE.dense, color: 'var(--dsw-alias-label-secondary)' },
      hintWarn: { margin: 0, fontSize: TEXT.body, lineHeight: LINE.body, color: 'var(--dsh-rpc-warn, #9d5c00)' },
      hintError: { margin: 0, fontSize: TEXT.body, lineHeight: LINE.body, color: 'var(--dsw-alias-state-error-primary, #b3261e)' },
      label: { fontSize: TEXT.body, color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))', fontWeight: 500 },

      // 按钮：三种层级，尺寸统一
      button: {
        font: 'inherit',
        fontSize: TEXT.body,
        lineHeight: '20px',
        padding: '4px 11px',
        borderRadius: 7,
        cursor: 'pointer',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      },
      buttonPrimary: {
        font: 'inherit',
        fontSize: TEXT.body,
        lineHeight: '20px',
        padding: '4px 12px',
        borderRadius: 7,
        cursor: 'pointer',
        border: '0.5px solid var(--dsw-alias-state-business-primary, #2f6fed)',
        background: 'var(--dsw-alias-state-business-primary, #2f6fed)',
        color: '#fff',
        fontWeight: 500,
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      },
      buttonGhost: {
        font: 'inherit',
        fontSize: TEXT.tiny,
        lineHeight: '18px',
        padding: '2px 9px',
        borderRadius: 999,
        cursor: 'pointer',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      },

      // 输入
      field: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 },
      input: {
        font: 'inherit',
        fontSize: TEXT.body,
        lineHeight: '20px',
        padding: '6px 9px',
        borderRadius: 7,
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsh-rpc-fill, rgba(127,127,127,.06))',
        color: 'var(--dsw-alias-label-primary)',
        width: '100%',
        boxSizing: 'border-box',
      },

      // 模型列表
      modelList: {
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        maxHeight: 320,
        overflowY: 'auto',
        margin: 0,
        padding: 0,
        listStyle: 'none',
        borderRadius: 8,
        border: '0.5px solid var(--dsw-alias-border-l2)',
      },
      modelRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        fontSize: TEXT.body,
        lineHeight: '21px',
        padding: '5px 10px',
        minWidth: 0,
      },
      modelRowDivider: { borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
      modelName: { color: 'var(--dsw-alias-label-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      modelMeta: { color: 'var(--dsw-alias-label-secondary)', fontSize: TEXT.tiny, whiteSpace: 'nowrap' },
      modelId: {
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: TEXT.tiny,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        whiteSpace: 'nowrap',
      },

      // 标签页：改成胶囊分段，比下划线更贴合宿主的圆角风格
      tabs: { display: 'flex', gap: 4, flexWrap: 'wrap' },

      pre: {
        margin: 0,
        padding: '10px 12px',
        borderRadius: 8,
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsh-rpc-fill, rgba(0,0,0,.04))',
        fontSize: TEXT.tiny,
        lineHeight: LINE.dense,
        maxHeight: 240,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
    }

    /** 小圆点：用来在标签页与统计行里表达状态。 */
    function dot(color) {
      return { width: 6, height: 6, borderRadius: 999, background: color, flex: '0 0 auto' }
    }

    var DOT_OK = 'var(--dsw-alias-state-success-primary, #1a8f5f)'
    var DOT_OFF = 'var(--dsh-rpc-warn, #9d5c00)'

    function tabStyle(active) {
      return {
        font: 'inherit',
        fontSize: TEXT.body,
        fontWeight: active ? 600 : 500,
        padding: '5px 11px',
        borderRadius: 8,
        cursor: 'pointer',
        border: '0.5px solid ' + (active ? 'var(--dsw-alias-border-l2)' : 'transparent'),
        background: active ? 'var(--dsh-rpc-fill, rgba(127,127,127,.10))' : 'transparent',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      }
    }

    // ── 网络 ────────────────────────────────────────────────────────
    /**
     * 浏览器端请求超时信号。
     *
     * 没有超时的 fetch 会让 busy 永远停在「保存中…」；宿主 /settings 在换 PAT 时
     * 还会 await 一轮目录 + 额度刷新，所以设置保存给 90 秒，状态轮询给 15 秒。
     */
    function requestSignal(ms) {
      try {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
      } catch (_) {
        /* 老浏览器没有 AbortSignal.timeout */
      }
      return undefined
    }

    function fetchStatus(light) {
      var url = light === true ? STATUS_PATH + '?light=1' : STATUS_PATH
      return fetch(url, { headers: { Accept: 'application/json' }, signal: requestSignal(15_000) }).then(function (response) {
        if (!response.ok) throw new Error('status ' + response.status)
        return response.json()
      })
    }

    function postJson(path, body, key) {
      return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RPC-Key': key === undefined ? '' : key },
        body: JSON.stringify(body === undefined ? {} : body),
        signal: requestSignal(90_000),
      }).then(function (response) {
        return response.json().then(function (document) {
          if (!response.ok) throw new Error(document && document.error ? document.error : 'http ' + response.status)
          return document
        })
      })
    }

    /** 拉取脱敏后的诊断文本；失败时由调用方回退。 */
    function fetchDiagnosticsText() {
      return fetch(DIAGNOSTICS_PATH + '?format=text', { headers: { Accept: 'text/plain' }, signal: requestSignal(20_000) }).then(function (response) {
        if (!response.ok) throw new Error('diagnostics ' + response.status)
        return response.text()
      })
    }

    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      var date = new Date(ms)
      if (!Number.isFinite(date.getTime())) return '—'
      var pad = function (value) { return String(value).padStart(2, '0') }
      return String(date.getFullYear()) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
        ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    /** 表格里的紧凑时间：今天只显示时分秒，跨天再带日期。无效返回 `—`。 */
    function formatShortTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      var date = new Date(ms)
      if (!Number.isFinite(date.getTime())) return '—'
      var now = new Date()
      var sameDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate()
      if (!sameDay) return formatTime(ms)
      var pad = function (value) { return String(value).padStart(2, '0') }
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    /** 侧栏面板用的短日期：同一年只显示 M/D。无效返回 `—`（不再产出 NaN/NaN/NaN）。 */
    function formatShortDate(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      var date = new Date(ms)
      if (!Number.isFinite(date.getTime())) return '—'
      var now = new Date()
      var prefix = date.getFullYear() === now.getFullYear() ? '' : String(date.getFullYear()) + '/'
      return prefix + String(date.getMonth() + 1) + '/' + String(date.getDate())
    }

    function formatWindow(tokens) {
      if (typeof tokens !== 'number' || tokens <= 0) return '—'
      if (tokens >= 1000000) return String(Math.round((tokens / 1000000) * 10) / 10) + 'M'
      if (tokens >= 1000) return String(Math.round(tokens / 1000)) + 'K'
      return String(tokens)
    }

    /**
     * 生成账号 id。
     *
     * 以前用 `acc-` + Date.now()：同一毫秒连点两次会撞 id（后一条被 upsert 合并），
     * 慢一点再点则会创建两个相同密钥的账号。优先用 crypto.randomUUID，环境不支持
     * 时退到时间戳 + 随机后缀。
     *
     * @returns 新账号 id。
     */
    function newAccountId() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
          return 'acc-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        }
      } catch (_) {
        /* 非安全上下文没有 randomUUID */
      }
      return 'acc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    }

    // ── 卡片 ────────────────────────────────────────────────────────
    function ConnectorCard(props) {
      var t = props.t
      var useState = React.useState
      var useEffect = React.useEffect
      var useCallback = React.useCallback
      var useRef = React.useRef

      var statusState = useState(undefined)
      var status = statusState[0]
      var setStatus = statusState[1]
      var errorState = useState(undefined)
      var error = errorState[0]
      var setError = errorState[1]
      // 2.0.0：每类操作一个 busy 键。单字符串会让「额度刷新完成」把还在
      // 保存中的设置按钮重新点亮，也会让一个模型开关把无关按钮显示成「保存中」。
      var busyState = useState({})
      var busy = busyState[0]
      var setBusy = busyState[1]
      var busyRef = useRef({})
      var beginBusy = function (key) {
        busyRef.current[key] = true
        setBusy(Object.assign({}, busyRef.current))
      }
      var endBusy = function (key) {
        delete busyRef.current[key]
        setBusy(Object.assign({}, busyRef.current))
      }
      var isBusy = function (key) { return busy[key] === true }
      var busyNow = function (key) { return busyRef.current[key] === true }
      var tabState = useState(props.initialProvider || 'workbuddy')
      var activeTab = tabState[0]
      var setActiveTab = tabState[1]
      var patState = useState('')
      var patDraft = patState[0]
      var setPatDraft = patState[1]
      var appPathState = useState('')
      var appPathDraft = appPathState[0]
      var setAppPathDraft = appPathState[1]
      var authFileState = useState('')
      var authFileDraft = authFileState[0]
      var setAuthFileDraft = authFileState[1]
      var showDiagState = useState(false)
      var showDiag = showDiagState[0]
      var setShowDiag = showDiagState[1]
      var copiedState = useState(false)
      var copied = copiedState[0]
      var setCopied = copiedState[1]
      // 自动复制失败（无剪贴板权限 / 非安全上下文 / 写入被拒）时的兜底状态。
      var copyFailedState = useState(false)
      var copyFailed = copyFailedState[0]
      var setCopyFailed = copyFailedState[1]
      var copyFallbackState = useState('')
      var copyFallback = copyFallbackState[0]
      var setCopyFallback = copyFallbackState[1]
      // 诊断面板打开时，不要让每次轮询/输入都重新序列化整份状态。
      var diagnosticsJson = React.useMemo(function () {
        return showDiag === true && status !== undefined ? JSON.stringify(displayStatus(status), null, 2) : ''
      }, [status, showDiag])
      var searchState = useState('')
      var searchDraft = searchState[0]
      var setSearchDraft = searchState[1]
      // 账号 × 模型表的统计口径：默认「今日」，与卡片上方那个「今日」对齐。
      var accountModelRangeState = useState('today')
      var accountModelRange = accountModelRangeState[0]
      var setAccountModelRange = accountModelRangeState[1]
      // 2.0.0：最近事件的时间线筛选与展开。
      var eventFilterState = useState('all')
      var eventFilter = eventFilterState[0]
      var setEventFilter = eventFilterState[1]
      var eventsExpandedState = useState(false)
      var eventsExpanded = eventsExpandedState[0]
      var setEventsExpanded = eventsExpandedState[1]
      // 删除账号二次确认：第一次点击只进入确认态，3 秒后自动复原。
      var deleteConfirmState = useState(undefined)
      var deleteConfirm = deleteConfirmState[0]
      var setDeleteConfirm = deleteConfirmState[1]
      var deleteConfirmTimer = useRef(undefined)
      var accLabelState = useState('')
      var accLabel = accLabelState[0]
      var setAccLabel = accLabelState[1]
      var accSecretState = useState('')
      var accSecret = accSecretState[0]
      var setAccSecret = accSecretState[1]
      // 高级设置草稿（秒为单位；保存时换算回毫秒）。
      var advIdleState = useState('')
      var advIdle = advIdleState[0]
      var setAdvIdle = advIdleState[1]
      var advCatalogState = useState('')
      var advCatalog = advCatalogState[0]
      var setAdvCatalog = advCatalogState[1]
      var advCreditsState = useState('')
      var advCredits = advCreditsState[0]
      var setAdvCredits = advCreditsState[1]
      var advStatsState = useState(true)
      var advStats = advStatsState[0]
      var setAdvStats = advStatsState[1]
      var advCacheState = useState(true)
      var advCache = advCacheState[0]
      var setAdvCache = advCacheState[1]
      var advSavedState = useState(false)
      var advSaved = advSavedState[0]
      var setAdvSaved = advSavedState[1]
      // 宿主夹取后的提示（例如「已按宿主安全范围保存：流空闲超时」）。
      var advNoticeState = useState('')
      var advNotice = advNoticeState[0]
      var setAdvNotice = advNoticeState[1]
      // 1.1.0：两个比例阈值（预警 / 自动换号），以百分数展示。
      var advAlertState = useState('')
      var advAlert = advAlertState[0]
      var setAdvAlert = advAlertState[1]
      var advSwitchState = useState('')
      var advSwitch = advSwitchState[0]
      var setAdvSwitch = advSwitchState[1]
      var advQueueState = useState('')
      var advQueue = advQueueState[0]
      var setAdvQueue = advQueueState[1]
      var advAlertsEnabledState = useState(true)
      var advAlertsEnabled = advAlertsEnabledState[0]
      var setAdvAlertsEnabled = advAlertsEnabledState[1]
      var advProbeEnabledState = useState(true)
      var advProbeEnabled = advProbeEnabledState[0]
      var setAdvProbeEnabled = advProbeEnabledState[1]
      // 浏览器登录轮询的取消令牌：切标签/关闭设置/卸载时递增，旧轮询自然失效。
      var loginPollToken = useRef(0)
      var loginPollTimer = useRef(undefined)
      // 2.0.0：后台标签页不再每 20 秒拉一次状态；同时只允许一个状态请求在飞。
      var statusLoading = useRef(false)
      var lastStatusAt = useRef(0)
      // 每次本地动作/写入成功都递增：更早发出的 GET /status 回来时直接丢弃，
      // 否则一个慢轮询会把刚保存的账号切换/模型开关覆盖回旧快照。
      var statusEpoch = useRef(0)
      var applyStatus = function (document) {
        statusEpoch.current += 1
        setStatus(document)
      }

      var load = useCallback(
        function () {
          // 卡片打开时定时器与「窗口重新可见」可能同时触发；重复请求既浪费
          // 一次完整 /status（含凭据探测），也会让旧响应覆盖新响应。
          if (statusLoading.current === true) return Promise.resolve()
          statusLoading.current = true
          var epoch = statusEpoch.current
          return fetchStatus()
            .then(function (document) {
              statusLoading.current = false
              lastStatusAt.current = Date.now()
              if (epoch !== statusEpoch.current) return document
              applyStatus(document)
              setError(undefined)
              return document
            }, function (failure) {
              statusLoading.current = false
              setError(String(failure && failure.message ? failure.message : failure))
            })
        },
        [setStatus, setError],
      )

      /** 首屏失败态里的「重试」：复用 load()，用 busy 标记避免连点。 */
      var retryLoad = function () {
        if (busyNow('reload')) return
        beginBusy('reload')
        load().then(function () { endBusy('reload') }, function () { endBusy('reload') })
      }

      useEffect(function () {
        var disposed = false
        load()
        var timer = setInterval(function () {
          // 页面在后台时不要轮询：用户看不见，宿主也没必要每 20 秒做一次
          // 凭据探测 + 上游健康检查。
          if (disposed) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load()
        }, POLL_MS)
        var onVisibility = function () {
          if (disposed) return
          if (typeof document === 'undefined' || document.visibilityState === 'hidden') return
          // 回到前台且数据已经旧了：立即补一次，而不是等下一个 20 秒。
          if (Date.now() - lastStatusAt.current >= 5000) load()
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibility)
        }
        return function () {
          disposed = true
          clearInterval(timer)
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility)
          }
          // 卸载时让还在等待的登录轮询失效，避免继续请求并 setState。
          loginPollToken.current += 1
          if (loginPollTimer.current !== undefined) {
            clearTimeout(loginPollTimer.current)
            loginPollTimer.current = undefined
          }
        }
      }, [load])

      var providers = safeArray(status && status.providers)
      var active = providers.filter(function (entry) {
        return entry.provider === activeTab
      })[0]

      // 切换标签只重置「这个 provider 的路径草稿」；高级设置是全局的，
      // 不能因为切标签就把用户还没保存的输入清掉。
      useEffect(function () {
        var desktop = active === undefined
          ? undefined
          : status && status.settings && status.settings.workbuddy
            ? status.settings.workbuddy[active.provider]
            : undefined
        // Trae 的路径覆盖存在 settings.trae 下（不是 settings.workbuddy）。
        var trae = active === undefined
          ? undefined
          : status && status.settings && status.settings.trae
            ? status.settings.trae[active.provider]
            : undefined
        // 必须无条件写回：旧代码只在 settings 存在时才 set，缺字段时会保留
        // 上一个 provider 的草稿，保存时把别人的路径写到当前 provider 上。
        setAppPathDraft(desktop !== undefined && desktop !== null ? desktop.electronPath || '' : '')
        setAuthFileDraft(
          desktop !== undefined && desktop !== null && (desktop.authFile || '') !== ''
            ? desktop.authFile
            : trae !== undefined && trae !== null ? trae.storageFile || '' : '',
        )
        setPatDraft('')
        setAccLabel('')
        setAccSecret('')
      }, [activeTab, active === undefined])

      // 高级设置只在第一次拿到状态时灌入草稿（依赖是布尔值，不随每次轮询重跑）。
      useEffect(function () {
        if (status === undefined || !status.settings) return
        var advanced = status.settings.advanced || {}
        if (typeof advanced.idleTimeoutMs === 'number') setAdvIdle(String(Math.round(advanced.idleTimeoutMs / 1000)))
        if (typeof advanced.catalogRefreshMs === 'number') setAdvCatalog(String(Math.round(advanced.catalogRefreshMs / 1000)))
        if (typeof advanced.creditsRefreshMs === 'number') setAdvCredits(String(Math.round(advanced.creditsRefreshMs / 1000)))
        // 老宿主（没有 advanced）也显示已知默认值，而不是空输入框。
        if (typeof advanced.idleTimeoutMs !== 'number') setAdvIdle('180')
        if (typeof advanced.catalogRefreshMs !== 'number') setAdvCatalog('600')
        if (typeof advanced.creditsRefreshMs !== 'number') setAdvCredits('120')
        setAdvStats(advanced.stats !== false)
        setAdvCache(advanced.catalogCache !== false)
        var alerts = status.settings.alerts || {}
        setAdvAlert(typeof alerts.lowRatio === 'number' ? String(Math.round(alerts.lowRatio * 100)) : '15')
        setAdvAlertsEnabled(alerts.enabled !== false)
        setAdvProbeEnabled(status.settings.probe !== false)
        var auto = status.settings.autoSwitch
        var switchRatio = auto !== null && typeof auto === 'object' && typeof auto.thresholdRatio === 'number'
          ? auto.thresholdRatio
          : 0
        setAdvSwitch(String(Math.round(switchRatio * 100)))
        if (typeof advanced.qoderQueueWaitMs === 'number') setAdvQueue(String(Math.round(advanced.qoderQueueWaitMs / 1000)))
        if (typeof advanced.qoderQueueWaitMs !== 'number') setAdvQueue('60')
      }, [status === undefined])

      /**
       * 本地已生效、但服务端还没回来的模型开关。
       *
       * 为什么需要：`toggleModel()` 每次都回传**完整的** `disabledModels`，而它是
       * 基于上一次 `/status` 计算出来的。连点两个模型时（第一个 POST 还没回来），
       * 第二次仍然从旧 status 出发，后到的响应会把第一次的改动覆盖掉 ——
       * 典型 lost update：勾一个、再勾一个，第一个又恢复成原样。
       *
       * 这里在本地记下「这一轮用户改了哪些 id」，计算时以它为准；服务端响应回来后
       * 清空对应条目。只覆盖模型/强制显示这类幂等的开关，账号与密钥仍走原逻辑。
       */
      var pendingModelToggles = useRef({})
      /** 最近的写入序号：旧响应不能覆盖新响应。 */
      var writeSeq = useRef(0)

      /**
       * 把一个 provider 的「用户已勾选的模型集合」算出来（含尚未落盘的本地改动）。
       *
       * @param entry - 状态里的 provider 条目。
       * @param field - `'disabled'` 或 `'forced'`。
       * @returns 模型 id 数组。
       */
      var pendingSetFor = function (entry, field) {
        var key = entry.provider + '::' + field
        var local = pendingModelToggles.current[key]
        var base = safeArray(entry.models)
          .filter(function (row) { return row[field] })
          .map(function (row) { return row.id })
        var merged = base.slice()
        if (local !== undefined) {
          Object.keys(local).forEach(function (id) {
            var on = local[id]
            var at = merged.indexOf(id)
            if (on && at === -1) merged.push(id)
            else if (!on && at !== -1) merged.splice(at, 1)
          })
        }
        return merged
      }

      /** 记下一个本地改动，等下一次服务端响应回来时清掉。 */
      var markPending = function (provider, field, id, on) {
        var key = provider + '::' + field
        var bucket = pendingModelToggles.current[key]
        if (bucket === undefined) bucket = pendingModelToggles.current[key] = {}
        bucket[id] = on
      }

      var mutate = function (patch, options) {
        if (status === undefined) return Promise.resolve()
        beginBusy('save')
        // 每次写入都占一个序号；只有最新一次的响应才允许覆盖本地状态，
        // 否则「先发的慢响应」会把「后发的快响应」结果冲掉。
        writeSeq.current += 1
        var seq = writeSeq.current
        return postJson(SETTINGS_PATH, patch, status.key)
          .then(function (document) {
            if (seq !== writeSeq.current) return document
            // 最新一次写入的响应就是权威状态：本地「未落盘的开关意图」到此
            // 已全部并入它，必须清空。否则用户之后在 CLI/另一个窗口改的
            // 模型开关会被这份陈旧意图永久盖住。
            pendingModelToggles.current = {}
            applyStatus(document)
            setError(undefined)
            endBusy('save')
            if (options !== undefined && options.clearPatDraft === true) setPatDraft('')
            if (options !== undefined && typeof options.onSuccess === 'function') options.onSuccess()
            return document
          })
          .catch(function (failure) {
            if (seq === writeSeq.current) {
              endBusy('save')
              setError(String(failure && failure.message ? failure.message : failure))
            }
            // 失败时丢弃本地猜测，让界面回到服务端真实值。
            pendingModelToggles.current = {}
            throw failure
          })
      }

      var refresh = function () {
        if (status === undefined || busyNow('refresh')) return
        beginBusy('refresh')
        postJson(ACTION_PATH, { action: 'refresh' }, status.key)
          .then(function (document) {
            applyStatus(document)
            endBusy('refresh')
            setError(undefined)
          })
          .catch(function (failure) {
            endBusy('refresh')
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      var toggleProvider = function (entry) {
        var providersPatch = {}
        providersPatch[entry.provider] = { enabled: !entry.enabled }
        mutate({ providers: providersPatch })
      }

      var toggleModel = function (entry, model) {
        // 分两种情况，写不同的字段：
        // - 账号不支持的模型：勾选 = 加入 forced（强制显示），与用户的 disabled 无关；
        // - 正常模型：勾选 = 从 disabled 移除。
        if (model.unavailable) {
          // 基于「含本地未落盘改动」的集合计算，避免连点时用旧快照覆盖。
          var forced = pendingSetFor(entry, 'forced').filter(function (id) { return id !== model.id })
          if (!model.forced) forced.push(model.id)
          markPending(entry.provider, 'forced', model.id, !model.forced)
          var forcePatch = { forcedModels: {} }
          forcePatch.forcedModels[entry.provider] = forced
          mutate(forcePatch)
          return
        }
        var disabled = pendingSetFor(entry, 'disabled').filter(function (id) { return id !== model.id })
        if (!model.disabled) disabled.push(model.id)
        markPending(entry.provider, 'disabled', model.id, !model.disabled)
        var providersPatch = {}
        providersPatch[entry.provider] = { disabledModels: disabled }
        mutate({ providers: providersPatch })
      }

      var setAllModels = function (entry, hidden) {
        var providersPatch = {}
        providersPatch[entry.provider] = {
          // 「全部关闭」只处理账号本来就可用的那些；本来就不支持的保持原样。
          disabledModels: hidden
            ? safeArray(entry.models).filter(function (row) { return !row.unavailable }).map(function (row) { return row.id })
            : [],
        }
        // 全开/全关要写成「本地意图」，否则紧随其后的单模型开关仍从旧 status 出发、
        // 只发一个 id，把这次批量改动整份冲掉（全关后发现只有一个模型被关）。
        var key = entry.provider + '::disabled'
        var bucket = {}
        safeArray(entry.models).forEach(function (row) {
          if (row.unavailable) return
          bucket[row.id] = hidden === true
        })
        pendingModelToggles.current[key] = bucket
        mutate({ providers: providersPatch })
      }

      /**
       * 打开 App 登录并导入账号。
       *
       * 宿主那边会拉起 WorkBuddy 窗口并轮询登录文件；导入完成后 `/status` 里
       * 就多了一个账号。所以这里只负责「发一次请求 + 轮询状态」。
       */
      var startLogin = function (provider) {
        if (status === undefined || busyNow('login')) return
        loginPollToken.current += 1
        var token = loginPollToken.current
        if (loginPollTimer.current !== undefined) {
          clearTimeout(loginPollTimer.current)
          loginPollTimer.current = undefined
        }
        beginBusy('login')
        postJson(ACTION_PATH, { action: 'login-start', provider: provider }, status.key)
          .then(function (document) {
            endBusy('login')
            if (document.status !== undefined) applyStatus(document.status)
            setError(undefined)
            pollLogin(provider, 0, token)
          })
          .catch(function (failure) {
            endBusy('login')
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 轮询登录进度，直到 done / failed / cancelled；token 变化后旧轮询自动停止。 */
      var pollLogin = function (provider, attempt, token) {
        if (status === undefined || attempt > 150 || token !== loginPollToken.current) return
        loginPollTimer.current = setTimeout(function () {
          if (token !== loginPollToken.current) return
          fetchStatus()
            .then(function (document) {
              if (token !== loginPollToken.current) return
              applyStatus(document)
              var entry = safeArray(document.providers).find(function (item) { return item.provider === provider })
              var job = entry === undefined ? undefined : entry.login
              if (job === undefined) return
              if (job.phase === 'waiting' || job.phase === 'starting') {
                pollLogin(provider, attempt + 1, token)
              }
            })
            .catch(function () {})
        }, 2000)
      }

      var cancelLogin = function (provider) {
        if (status === undefined) return
        loginPollToken.current += 1
        if (loginPollTimer.current !== undefined) {
          clearTimeout(loginPollTimer.current)
          loginPollTimer.current = undefined
        }
        postJson(ACTION_PATH, { action: 'login-cancel', provider: provider }, status.key)
          .then(function (document) { applyStatus(document) })
          .catch(function () {})
      }

      var runCheckin = function (provider) {
        if (status === undefined || busyNow('checkin')) return
        beginBusy('checkin')
        postJson(ACTION_PATH, { action: 'checkin', provider: provider }, status.key)
          .then(function (document) {
            applyStatus(document)
            endBusy('checkin')
            setError(undefined)
          })
          .catch(function (failure) {
            endBusy('checkin')
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      var runProbeNow = function () {
        if (status === undefined || busyNow('probe')) return
        beginBusy('probe')
        postJson(ACTION_PATH, { action: 'probe' }, status.key)
          .then(function (document) {
            applyStatus(document)
            endBusy('probe')
            setError(undefined)
          })
          .catch(function (failure) {
            endBusy('probe')
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 真发一次 1-token 请求，验证某个账号现在能不能用。 */
      var testAccount = function (provider, accountId) {
        if (status === undefined) return
        var key = 'test:' + accountId
        if (busyNow(key)) return
        beginBusy(key)
        postJson(ACTION_PATH, { action: 'test-account', provider: provider, accountId: accountId }, status.key)
          .then(function (document) {
            applyStatus(document.status !== undefined ? document.status : document)
            endBusy(key)
            setError(undefined)
          })
          .catch(function (failure) {
            endBusy(key)
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 真发一次 1-token 请求，验证某个账号 × 模型当前能不能用 / 是否被限额。 */
      var testAccountModel = function (provider, accountId, modelId) {
        if (status === undefined) return
        var key = 'model-test:' + accountId + ':' + modelId
        if (busyNow(key)) return
        beginBusy(key)
        postJson(ACTION_PATH, {
          action: 'test-model',
          provider: provider,
          accountId: accountId,
          model: modelId,
        }, status.key)
          .then(function (document) {
            applyStatus(document.status !== undefined ? document.status : document)
            endBusy(key)
            setError(undefined)
          })
          .catch(function (failure) {
            endBusy(key)
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 清除一个账号的失败冷却。 */
      var resetCooldown = function (provider, accountId) {
        if (status === undefined) return
        var key = 'reset:' + accountId
        if (busyNow(key)) return
        beginBusy(key)
        postJson(ACTION_PATH, { action: 'reset-account', provider: provider, accountId: accountId }, status.key)
          .then(function (document) {
            applyStatus(document)
            endBusy(key)
            setError(undefined)
          })
          .catch(function (failure) {
            endBusy(key)
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 被用户强制显示的模型数量。 */
      var forcedCount = function (entry) {
        return safeArray(entry.models).filter(function (row) {
          return row.forced
        }).length
      }

      /** 刷新额度（强制绕过缓存）。 */
      var refreshCredits = function () {
        if (status === undefined || busyNow('credits')) return
        beginBusy('credits')
        postJson(ACTION_PATH, { action: 'credits' }, status.key)
          .then(function (document) {
            applyStatus(document)
            endBusy('credits')
            setError(undefined)
          })
          .catch(function (failure) {
            endBusy('credits')
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 六个数字字段的校验结果：非法值不再静默回退到旧值。 */
      var advancedFieldErrors = function () {
        return {
          idle: advancedInputError(advIdle, ADVANCED_LIMITS.idle),
          catalog: advancedInputError(advCatalog, ADVANCED_LIMITS.catalog),
          credits: advancedInputError(advCredits, ADVANCED_LIMITS.credits),
          queue: advancedInputError(advQueue, ADVANCED_LIMITS.queue),
          alert: advancedInputError(advAlert, ADVANCED_LIMITS.alert),
          switchRatio: advancedInputError(advSwitch, ADVANCED_LIMITS.switchRatio),
        }
      }
      var advancedSaveBlocked = function () {
        var errors = advancedFieldErrors()
        return Object.keys(errors).some(function (key) { return errors[key] !== '' })
      }

      /** 保存高级设置：秒 → 毫秒；先做与宿主一致的区间校验，再交给宿主夹取。 */
      var saveAdvanced = function () {
        if (status === undefined || busyNow('advanced')) return
        if (advancedSaveBlocked()) return
        var toMs = function (value, fallback) {
          var parsed = Number(String(value).trim())
          if (!isFinite(parsed) || parsed <= 0) return fallback
          return Math.round(parsed * 1000)
        }
        var current = (status.settings && status.settings.advanced) || {}
        var toPercent = function (value, fallback) {
          var parsed = Number(String(value).trim())
          if (!isFinite(parsed) || parsed < 0) return fallback
          return Math.max(0, Math.min(95, Math.round(parsed))) / 100
        }
        var sent = {
          idleTimeoutMs: toMs(advIdle, current.idleTimeoutMs || 180000),
          catalogRefreshMs: toMs(advCatalog, current.catalogRefreshMs || 600000),
          creditsRefreshMs: toMs(advCredits, current.creditsRefreshMs || 120000),
          qoderQueueWaitMs: toMs(advQueue, current.qoderQueueWaitMs || 60000),
          lowRatio: toPercent(advAlert, 0.15),
          thresholdRatio: toPercent(advSwitch, 0),
        }
        beginBusy('advanced')
        setAdvSaved(false)
        setAdvNotice('')
        postJson(SETTINGS_PATH, {
          advanced: {
            idleTimeoutMs: toMs(advIdle, current.idleTimeoutMs || 180000),
            catalogRefreshMs: toMs(advCatalog, current.catalogRefreshMs || 600000),
            creditsRefreshMs: toMs(advCredits, current.creditsRefreshMs || 120000),
            qoderQueueWaitMs: toMs(advQueue, current.qoderQueueWaitMs || 60000),
            stats: advStats !== false,
            catalogCache: advCache !== false,
          },
          alerts: {
            enabled: advAlertsEnabled !== false,
            lowRatio: toPercent(advAlert, 0.15),
          },
          probe: { enabled: advProbeEnabled !== false },
          autoSwitch: {
            enabled: (status.settings && status.settings.autoSwitch && typeof status.settings.autoSwitch === 'object')
              ? status.settings.autoSwitch.enabled !== false
              : true,
            thresholdRatio: toPercent(advSwitch, 0),
          },
        }, status.key)
          .then(function (document) {
            applyStatus(document)
            endBusy('advanced')
            setError(undefined)
            // 只有真的保存成功才显示「已保存」。
            setAdvSaved(true)
            // 用服务端夹取后的值回填草稿：用户输入 9999 秒会被夹到 900 秒，
            // 不能继续显示 9999 却告诉用户「已保存」。
            var savedAdvanced = (document && document.settings && document.settings.advanced) || {}
            var savedAlertsForClamp = document && document.settings && document.settings.alerts
            var savedAutoForClamp = document && document.settings && document.settings.autoSwitch
            // 宿主把越界值夹到安全区间时，明确告诉用户最终保存的是什么，而不是假装存了原值。
            var clampLabels = []
            if (typeof savedAdvanced.idleTimeoutMs === 'number' && savedAdvanced.idleTimeoutMs !== sent.idleTimeoutMs) clampLabels.push(bind(t, 'advancedIdle'))
            if (typeof savedAdvanced.catalogRefreshMs === 'number' && savedAdvanced.catalogRefreshMs !== sent.catalogRefreshMs) clampLabels.push(bind(t, 'advancedCatalog'))
            if (typeof savedAdvanced.creditsRefreshMs === 'number' && savedAdvanced.creditsRefreshMs !== sent.creditsRefreshMs) clampLabels.push(bind(t, 'advancedCredits'))
            if (typeof savedAdvanced.qoderQueueWaitMs === 'number' && savedAdvanced.qoderQueueWaitMs !== sent.qoderQueueWaitMs) clampLabels.push(bind(t, 'advancedQueue'))
            if (savedAlertsForClamp && typeof savedAlertsForClamp.lowRatio === 'number' && Math.abs(savedAlertsForClamp.lowRatio - sent.lowRatio) > 1e-9) clampLabels.push(bind(t, 'advancedAlert'))
            if (savedAutoForClamp && typeof savedAutoForClamp.thresholdRatio === 'number' && Math.abs(savedAutoForClamp.thresholdRatio - sent.thresholdRatio) > 1e-9) clampLabels.push(bind(t, 'advancedSwitch'))
            if (clampLabels.length > 0) {
              setAdvNotice(bind(t, 'advancedClamped', { fields: clampLabels.join(bind(t, 'listSeparator')) }))
              setTimeout(function () { setAdvNotice('') }, 6000)
            }
            if (typeof savedAdvanced.idleTimeoutMs === 'number') setAdvIdle(String(Math.round(savedAdvanced.idleTimeoutMs / 1000)))
            if (typeof savedAdvanced.catalogRefreshMs === 'number') setAdvCatalog(String(Math.round(savedAdvanced.catalogRefreshMs / 1000)))
            if (typeof savedAdvanced.creditsRefreshMs === 'number') setAdvCredits(String(Math.round(savedAdvanced.creditsRefreshMs / 1000)))
            if (typeof savedAdvanced.qoderQueueWaitMs === 'number') setAdvQueue(String(Math.round(savedAdvanced.qoderQueueWaitMs / 1000)))
            var savedAlerts = document && document.settings && document.settings.alerts
            if (savedAlerts && typeof savedAlerts.lowRatio === 'number') setAdvAlert(String(Math.round(savedAlerts.lowRatio * 100)))
            if (savedAlerts) setAdvAlertsEnabled(savedAlerts.enabled !== false)
            if (document && document.settings) setAdvProbeEnabled(document.settings.probe !== false)
            var savedAuto = document && document.settings && document.settings.autoSwitch
            if (savedAuto && typeof savedAuto.thresholdRatio === 'number') setAdvSwitch(String(Math.round(savedAuto.thresholdRatio * 100)))
            setAdvStats(savedAdvanced.stats !== false)
            setAdvCache(savedAdvanced.catalogCache !== false)
            setTimeout(function () { setAdvSaved(false) }, 1600)
          })
          .catch(function (failure) {
            endBusy('advanced')
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 重置用量统计。 */
      var resetStats = function () {
        if (status === undefined || busyNow('stats')) return
        beginBusy('stats')
        postJson(ACTION_PATH, { action: 'stats-reset' }, status.key)
          .then(function (document) {
            applyStatus(document)
            endBusy('stats')
            setError(undefined)
          })
          .catch(function (failure) {
            endBusy('stats')
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 清空最近事件（只影响本机事件账本）。 */
      var clearEvents = function () {
        if (status === undefined || busyNow('events')) return
        var confirmed = typeof window === 'undefined' || typeof window.confirm !== 'function'
          ? true
          : window.confirm(bind(t, 'eventClearConfirm'))
        if (!confirmed) return
        beginBusy('events')
        postJson(ACTION_PATH, { action: 'events-clear' }, status.key)
          .then(function (document) {
            applyStatus(document)
            endBusy('events')
            setError(undefined)
          })
          .catch(function (failure) {
            endBusy('events')
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /**
       * 额度文案。
       *
       * 「读不到」与「真的是 0」必须长得不一样：前者显示为错误提示，
       * 后者才显示 0 —— 否则用户会以为额度被清零了。
       *
       * 复用的是模块级的 helper（侧栏小卡也要用），这里只做绑定。
       */
      var creditsText = function (credits) {
        return formatCreditsText(credits, t)
      }

      /** 账号池的最小可回传形态（密钥永远不回传，服务端按 id 合并）。 */
      var accountRows = safeArray(active && active.accounts)

      var activeRow = accountRows.filter(function (row) { return row.active })[0]

      /**
       * 只回传「当前账号」这一行。
       *
       * 不要传整张旧的账号列表：另一个窗口/CLI 刚删掉或改名的账号会以旧快照
       * 被 upsert 回来（幽灵账号），这正是 1.0.0 改成增量 upsert 想避免的事。
       */
      var activeAccountPatch = function (extra) {
        if (activeRow === undefined) return undefined
        var row = { id: activeRow.id, label: activeRow.label, enabled: activeRow.enabled !== false }
        if (activeRow.authFile !== undefined && activeRow.authFile !== '') row.authFile = activeRow.authFile
        if (extra !== undefined) {
          if (extra.pat !== undefined) row.pat = extra.pat
          if (extra.forget === true) row.forget = true
        }
        var patch = { accounts: {} }
        patch.accounts[active.provider] = [row]
        return patch
      }

      var savePat = function () {
        if (active === undefined) return
        var pat = patDraft.trim()
        if (pat === '') return
        // 账号池存在时必须写进「当前账号」，否则写的是被忽略的旧字段，
        // 用户会看到「保存成功但状态没变」。
        if (accountRows.length > 0 && activeRow !== undefined) {
          mutate(activeAccountPatch({ pat: pat }), { clearPatDraft: true })
          return
        }
        var patch = { qoder: {} }
        patch.qoder[active.provider] = { pat: pat }
        mutate(patch, { clearPatDraft: true })
      }

      var clearPat = function () {
        if (active === undefined) return
        if (accountRows.length > 0 && activeRow !== undefined) {
          mutate(activeAccountPatch({ forget: true }), { clearPatDraft: true })
          return
        }
        var patch = { qoder: {} }
        patch.qoder[active.provider] = { pat: '' }
        mutate(patch, { clearPatDraft: true })
      }

      var saveDesktop = function () {
        if (active === undefined) return
        var patch = { workbuddy: {} }
        patch.workbuddy[active.provider] = { electronPath: appPathDraft.trim(), authFile: authFileDraft.trim() }
        mutate(patch)
      }

      /** Trae 只保存 storage.json 的路径覆盖（凭证本身由客户端维护）。 */
      var saveTrae = function () {
        if (active === undefined) return
        var patch = { trae: {} }
        patch.trae[active.provider] = { storageFile: authFileDraft.trim() }
        mutate(patch)
      }

      var copyDiagnostics = function () {
        // 自动复制失败（无剪贴板权限 / 非安全上下文 / 写入被拒）不能静默：
        // 按钮临时变「复制失败」，并渲染可手动全选的 textarea 兜底。
        var showFallback = function (text) {
          setCopyFallback(String(text === undefined || text === null ? '' : text))
          setCopyFailed(true)
          setTimeout(function () { setCopyFailed(false) }, 6000)
        }
        var write = function (text) {
          if (typeof navigator !== 'undefined' && navigator !== null && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(function () {
              setCopied(true)
              setTimeout(function () { setCopied(false) }, 1500)
            }, function () { showFallback(text) })
            return
          }
          showFallback(text)
        }
        if (status !== undefined) {
          // 新版宿主提供脱敏后的纯文本诊断；旧宿主没有这条路由时退回精简 JSON
          // （至少先删掉控制密钥，不能把写接口的钥匙复制出去）。
          fetchDiagnosticsText().then(write, function () {
            write(JSON.stringify(displayStatus(status), null, 2))
          })
          return
        }
        write(JSON.stringify({ error: error }, null, 2))
      }

      if (status === undefined) {
        // 首屏读取失败时不能再只留一行裸英文错误：给完整卡片外壳 + 本地化说明 +
        // 可点的「重试」，否则用户只能等 20 秒轮询或重开设置页。
        return h(
          'div',
          { style: S.card },
          h('div', { key: 'head', style: S.header },
            h('h3', { style: S.title }, bind(t, 'title')),
            h('span', { key: 'grow', style: S.grow }),
            h('button', {
              type: 'button',
              style: S.buttonPrimary,
              onClick: retryLoad,
              disabled: isBusy('reload'),
            }, isBusy('reload') ? bind(t, 'retrying') : bind(t, 'retry'))),
          error === undefined
            ? h('p', { key: 'loading', style: S.hint, role: 'status' }, bind(t, 'loading'))
            : h('div', { key: 'load-fail', role: 'status' },
                h('p', { style: S.hintError, title: error }, bind(t, 'statusLoadFailed')),
                h('p', { style: S.hintTiny }, bind(t, 'statusLoadFailedHint'))),
        )
      }

      // 预警阈值由宿主下发；老宿主没有 alerts 时沿用 15%。
      var alertSettings = (status.settings && status.settings.alerts) || {}
      var alertRatio = typeof alertSettings.lowRatio === 'number' ? alertSettings.lowRatio : LOW_CREDITS_RATIO
      var alertsEnabled = alertSettings.enabled !== false
      var storage = status.storage || {}
      var settingsCorrupt = typeof storage.settingsError === 'string' && storage.settingsError !== ''
        ? h('p', {
            key: 'settings-corrupt',
            style: S.hintWarn,
            title: typeof storage.settingsBackup === 'string' && storage.settingsBackup !== ''
              ? bind(t, 'settingsCorruptBackup', { path: storage.settingsBackup })
              : '',
          }, bind(t, 'settingsCorrupt'))
        : null
      // 浏览器缓存了旧 bundle、宿主已经升到新状态版本时，字段会悄悄缺一块。
      // 明确告警比让用户对着空区块猜要好。
      var versionMismatch = status.version !== EXPECTED_STATUS_VERSION
        ? h('p', {
            key: 'version-mismatch',
            style: S.hintWarn,
          }, bind(t, 'statusVersionMismatch', {
            host: status.version === undefined ? '?' : String(status.version),
            client: String(EXPECTED_STATUS_VERSION),
          }))
        : null

      var tabs = providers.map(function (entry) {
        var signed = entry.credential !== undefined && entry.credential !== null && entry.credential.status === 'signed-in'
        var tabHealth = entry.health || { state: 'unknown' }
        return h(
          'button',
          {
            key: entry.provider,
            id: 'dsh-rpc-tab-' + entry.provider,
            type: 'button',
            role: 'tab',
            'aria-selected': entry.provider === activeTab,
            'aria-controls': 'dsh-rpc-status-panel',
            // 标准 tabs 模式：只有当前 tab 进 Tab 键序列，方向键在 tab 间移动。
            tabIndex: entry.provider === activeTab ? 0 : -1,
            style: tabStyle(entry.provider === activeTab),
            title: entry.displayName,
            onClick: function () { setActiveTab(entry.provider) },
          },
          h(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            h('span', { style: dot(signed ? (tabHealth.state === 'unknown' ? DOT_OK : healthColor(tabHealth.state)) : DOT_OFF) }),
            entry.displayName,
          ),
        )
      })

      // 账号总览：每家 provider 一张可点的卡片。比原来一行小胶囊多三样东西：
      // 健康圆点、今日用量、当前账号名 —— 不切标签就能判断「该不该点进去」。
      // 六家之后用 auto-fit 栅格排布：宽屏一行三张、窄屏自动降成一列。
      var summaryCards = providers.map(function (entry) {
        var health = entry.health || { state: 'unknown' }
        var signed = entry.credential !== undefined && entry.credential !== null && entry.credential.status === 'signed-in'
        var credits = entry.credits || { state: 'none' }
        var today = (entry.usage && entry.usage.today) || {}
        var selected = entry.provider === activeTab
        var accent = PROVIDER_ACCENT[entry.provider] || 'currentColor'
        var low = creditsWarning(credits, entry.provider, alertRatio, alertsEnabled)
        // Qoder Free 的 0 付费额度不是「用尽」：大数字显示「免费」，避免被读成额度耗尽。
        // 完整额度文案仍在 title / aria-label 里，信息不丢。
        var freePlan = isQoderFreePlan(entry.provider, credits)
        // 读失败与「真的是 0」必须长得不一样：前者给 `—`，后者才显示 0。
        var valueText = credits.state === 'ok'
          ? credits.unlimited === true ? '∞' : freePlan ? bind(t, 'creditsFree') : compactNumber(credits.remain)
          : '—'
        // 大数字的完整说明：正常态给完整额度文案；读不到时说明原因（未读取 / 读取失败 + 上游错误）。
        // state==='none' 也可能是「该 provider 没有额度接口」：宿主会把原因放进
        // credits.error（如 Trae 国际版），这里必须透出，否则用户会反复刷新白等。
        var valueTitle = credits.state === 'ok'
          ? formatCreditsText(credits, t)
          : typeof credits.error === 'string' && credits.error !== ''
            ? bind(t, credits.state === 'error' ? 'creditsUnreadable' : 'creditsNone') + ': ' + credits.error
            : bind(t, credits.state === 'none' ? 'creditsNone' : 'creditsUnreadable')
        var metaParts = [String(entry.modelCount !== undefined ? entry.modelCount : safeArray(entry.models).length) + ' ' + bind(t, 'models')]
        if (today.requests > 0) metaParts.push(compactNumber(today.totalTokens || 0) + ' tok')
        var activeRow = safeArray(entry.accounts).filter(function (row) { return row.active })[0]
        if (activeRow !== undefined) metaParts.push(activeRow.label)
        return h(
          'button',
          {
            key: entry.provider,
            type: 'button',
            'aria-pressed': selected,
            onClick: function () { setActiveTab(entry.provider) },
            style: {
              font: 'inherit',
              textAlign: 'left',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '8px 10px',
              borderRadius: 10,
              cursor: 'pointer',
              border: '0.5px solid ' + (selected ? 'var(--dsw-alias-state-business-primary, #2f6fed)' : 'var(--dsw-alias-border-l2)'),
              background: selected
                ? 'var(--dsh-rpc-fill, rgba(127,127,127,.10))'
                : 'var(--dsw-alias-bg-layer-1, transparent)',
              color: 'var(--dsw-alias-label-primary)',
              minWidth: 0,
              opacity: entry.enabled === false ? 0.55 : 1,
            },
          },
          h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            h('span', { title: bind(t, healthTextKey(health.state)), style: Object.assign({}, dot(signed ? healthColor(health.state) : DOT_OFF)) }),
            h('span', { style: { fontSize: TEXT.tiny, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.displayName),
            h('span', { style: S.grow }),
            h('span', {
              style: {
                fontSize: TEXT.tiny,
                color: healthColor(health.state),
                whiteSpace: 'nowrap',
              },
            }, bind(t, healthTextKey(health.state)))),
          h('span', {
            // 读不到额度时不要用 provider 强调色画「—」：中性色 + 悬停原因，
            // 避免把「未读取/读取失败」看成某种品牌状态。字号/行高不变，6 张卡高度一致。
            title: valueTitle,
            'aria-label': valueTitle,
            style: {
              fontSize: 20,
              lineHeight: '24px',
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              color: credits.state !== 'ok'
                ? 'var(--dsw-alias-label-tertiary, #81858c)'
                : low ? 'var(--dsh-rpc-warn, #9d5c00)' : accent,
            },
          }, valueText),
          h('span', {
            style: { fontSize: TEXT.tiny, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, metaParts.join(' · ')),
        )
      })

      // 额度预警：只提醒，不改变行为。真正换号由 autoSwitch.thresholdRatio 控制。
      var alertProviders = alertsEnabled
        ? providers.filter(function (entry) {
            return entry.enabled !== false && alertOfCredits(entry.credits, alertRatio, entry.provider, alertsEnabled) !== undefined
          })
        : []
      var exhaustedNames = alertProviders
        .filter(function (entry) { return alertOfCredits(entry.credits, alertRatio, entry.provider, alertsEnabled) === 'exhausted' })
        .map(function (entry) { return entry.displayName })
      var lowNames = alertProviders
        .filter(function (entry) { return alertOfCredits(entry.credits, alertRatio, entry.provider, alertsEnabled) === 'low' })
        .map(function (entry) { return entry.displayName })
      var alertLines = []
      if (exhaustedNames.length > 0) alertLines.push(bind(t, 'alertBannerExhausted', { names: exhaustedNames.join(bind(t, 'listSeparator')) }))
      if (lowNames.length > 0) alertLines.push(bind(t, 'alertBannerLow', { names: lowNames.join(bind(t, 'listSeparator')) }))
      var alertBanner = alertLines.length === 0
        ? null
        : h('div', {
            key: 'alert',
            role: 'status',
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              gap: 7,
              padding: '7px 10px',
              borderRadius: 8,
              border: '0.5px solid var(--dsh-rpc-warn, #9d5c00)',
              background: 'color-mix(in srgb, var(--dsh-rpc-warn, #9d5c00) 9%, transparent)',
              color: 'var(--dsh-rpc-warn, #9d5c00)',
              fontSize: TEXT.body,
              lineHeight: '19px',
            },
          },
          h('span', { style: { fontWeight: 700, flex: '0 0 auto' } }, '!'),
          h('span', { style: { minWidth: 0 } }, alertLines.join(' ')))

      var sections = [
        h('div', { key: 'head', style: S.header },
          h('h3', { style: S.title }, bind(t, 'title')),
          // 版本号：排查问题时第一件要问的就是「你装的是哪一版」。
          h('span', { style: S.version }, 'v' + (status.plugin && status.plugin.version ? status.plugin.version : '?')),
          h('span', {
            style: S.badgeSoft,
            title: status.host && status.host.images === true ? bind(t, 'imagesOn') : bind(t, 'imagesOff'),
          }, status.host && status.host.images === true ? bind(t, 'imagesShort') : bind(t, 'imagesShortOff'))),
        h('p', { key: 'intro', style: S.intro }, bind(t, 'intro')),
        h('div', { key: 'toolbar', style: S.row },
          h('button', { type: 'button', style: S.buttonPrimary, onClick: refresh, disabled: isBusy('refresh') },
            isBusy('refresh') ? bind(t, 'refreshing') : bind(t, 'refresh')),
          h('span', { style: S.grow }),
          h('button', {
            type: 'button',
            style: S.buttonGhost,
            'aria-expanded': showDiag,
            // 折叠时诊断节点还没挂载，aria-controls 指向不存在的 id 会让读屏失效。
            'aria-controls': showDiag ? 'dsh-reverse-proxy-diagnostics' : undefined,
            onClick: function () { setShowDiag(!showDiag) },
          }, bind(t, 'diagnostics'))),
        error === undefined ? null : h('p', { key: 'err', style: S.hintError }, bind(t, 'error') + ': ' + error),
        settingsCorrupt,
        versionMismatch,
        alertBanner,
        summaryCards.length === 0
          ? null
          : h('div', { key: 'summary', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 } }, summaryCards),
        h('div', {
          key: 'tabs',
          role: 'tablist',
          style: S.tabs,
          onKeyDown: function (event) {
            var key = event !== undefined ? event.key : undefined
            if (key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'Home' && key !== 'End') return
            if (providers.length === 0) return
            var current = providers.findIndex(function (entry) { return entry.provider === activeTab })
            if (current === -1) current = 0
            var next = current
            if (key === 'ArrowRight') next = (current + 1) % providers.length
            else if (key === 'ArrowLeft') next = (current - 1 + providers.length) % providers.length
            else if (key === 'Home') next = 0
            else next = providers.length - 1
            if (event.preventDefault !== undefined) event.preventDefault()
            setActiveTab(providers[next].provider)
          },
        }, tabs),
      ]

      if (active === undefined) {
        sections.push(h('p', { key: 'empty', style: S.hint }, bind(t, 'noModels')))
        return h('div', { style: S.card }, sections)
      }

      // ── 状态 ────────────────────────────────────────────────────
      var credential = active.credential || {}
      var activeHealth = active.health || { state: 'unknown' }
      var catalogText =
        active.catalogSource === 'live'
          ? bind(t, 'catalogLive') + ' · ' + formatTime(active.fetchedAt)
          : active.catalogSource === 'saved'
            ? bind(t, 'catalogSaved') + ' · ' + formatTime(active.fetchedAt)
            : active.catalogSource === 'disk'
              ? bind(t, 'catalogDisk') + ' · ' + formatTime(active.fetchedAt)
              : active.catalogSource === 'builtin'
                ? bind(t, 'catalogBuiltin')
                : bind(t, 'catalogNone')

      // 目录失败与凭证失败经常是同一个原因（例如没有登录文件）。两处各显示一遍
      // 会得到截图里那种「同一段长文案出现两次」；这里做一次归一化去重。
      var credentialMessage = credential.status !== 'signed-in'
        && credential.status !== 'disabled'
        && typeof credential.message === 'string' && credential.message !== ''
        ? credential.message
        : undefined
      var extraMessage = typeof active.message === 'string' && active.message !== ''
        && !isSameMessage(credentialMessage, active.message)
        ? active.message
        : undefined
      // 最近一次失败的具体原因（1.3.0 起统计里带 message）。
      // 健康状态只说「最近失败是什么时候」，这条才回答「为什么失败」。
      var statusStats = status.stats || {}
      var lastFailure = safeArray(statusStats.recent).filter(function (entry) {
        return entry.provider === active.provider && (entry.kind === 'error' || entry.kind === 'incomplete')
      })[0]

      sections.push(
        h('div', {
          key: 'status',
          id: 'dsh-rpc-status-panel',
          role: 'tabpanel',
          'aria-labelledby': 'dsh-rpc-tab-' + active.provider,
          style: S.section,
        },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, bind(t, 'secStatus'))),
          h('div', { key: 'r', style: S.row },
            h('label', { style: Object.assign({}, S.row, { cursor: 'pointer', marginRight: 2 }) },
              h('input', {
                type: 'checkbox',
                checked: active.enabled !== false,
                onChange: function () { toggleProvider(active) },
              }),
              h('span', { style: S.label }, bind(t, 'enabled'))),
            h('span', { style: S.badgeSoft }, active.kind === 'desktop'
              ? bind(t, 'kindDesktop')
              : active.kind === 'desktop-auth' ? bind(t, 'kindDesktopAuth') : bind(t, 'kindPat')),
            h('span', {
              style: credential.status === 'signed-in'
                ? S.badge
                : credential.status === 'disabled' ? S.badgeSoft : S.badgeWarn,
            }, credential.status === 'signed-in'
              ? bind(t, 'signedIn')
              : credential.status === 'disabled' ? bind(t, 'disabled') : bind(t, 'signedOut')),
            h('span', {
              title: activeHealth.consecutiveFailures > 0 ? bind(t, 'consecutiveFailures', { count: activeHealth.consecutiveFailures }) : '',
              style: Object.assign({}, S.badgeSoft, { color: healthColor(activeHealth.state) }),
            }, bind(t, healthTextKey(activeHealth.state))),
            h('span', {
              style: active.images === true ? S.badgeSoft : S.badgeWarn,
              title: active.images === true ? bind(t, 'imagesOn') : bind(t, 'imagesOff'),
            }, active.images === true ? bind(t, 'imagesShort') : bind(t, 'imagesShortOff'))),
          h('p', { key: 'cat', style: S.hintTiny }, catalogText),
          credential.status === 'signed-in' && credential.email
            ? h('p', { key: 'who', style: S.hintTiny }, credential.email)
            : null,
          credentialMessage !== undefined
            ? h('p', { key: 'why', style: S.hintWarn }, credentialMessage)
            : null,
          activeHealth.lastErrorAt > 0 && activeHealth.state !== 'ok'
            ? h('p', { key: 'last', style: S.hintWarn }, bind(t, 'lastErrorAt', { time: formatTime(activeHealth.lastErrorAt) }))
            : null,
          lastFailure !== undefined
            ? h('p', {
                key: 'lastfail',
                style: S.hintWarn,
                title: typeof lastFailure.message === 'string' ? lastFailure.message : '',
              }, bind(t, 'lastFailure', {
                code: lastFailure.code || 'ERROR',
                time: formatTime(lastFailure.at),
                model: lastFailure.model || '—',
              }))
            : null,
          extraMessage !== undefined ? h('p', { key: 'msg', style: S.hintWarn }, extraMessage) : null),
      )

      // ── 账号 ────────────────────────────────────────────────────
      //
      // 多账号的意义：一个账号的积分用完了，自动/手动切到另一个还能用的账号。
      // 这里只做「增删与选定」，PAT 本身从不回传给浏览器（状态文档里没有）。
      accountRows = safeArray(active && active.accounts)
      var isPatProvider = active.kind === 'pat'
      var loginJob = active.login
      var loginWaiting = loginJob !== undefined && (loginJob.phase === 'waiting' || loginJob.phase === 'starting')
      // 登录等待中也要禁用「新增账号」：否则连点几次会起多个登录任务。
      var loginBusy = isBusy('login') || loginWaiting
      // 删除确认态：只允许一个账号处于「再次点击确认删除」，3 秒后自动复原。
      var clearDeleteConfirm = function () {
        if (deleteConfirmTimer.current !== undefined) {
          clearTimeout(deleteConfirmTimer.current)
          deleteConfirmTimer.current = undefined
        }
        setDeleteConfirm(undefined)
      }
      var armDeleteConfirm = function (accountId) {
        clearDeleteConfirm()
        setDeleteConfirm(accountId)
        deleteConfirmTimer.current = setTimeout(function () { clearDeleteConfirm() }, 3000)
      }
      var accountItems = accountRows.map(function (account, index) {
        var snapshot = account.credits || { state: 'none' }
        var cooling = typeof account.cooldownUntil === 'number' && account.cooldownUntil > Date.now()
        var lastTest = account.lastTest
        var testKey = 'test:' + account.id
        var resetKey = 'reset:' + account.id
        return h('li', {
          key: account.id,
          style: Object.assign({}, S.modelRow, { flexWrap: 'wrap' }, index > 0 ? S.modelRowDivider : {}),
        },
        h('span', {
          style: dot(account.active ? DOT_OK : DOT_OFF),
          title: account.active ? bind(t, 'currentAccount') : '',
        }),
        h('span', {
          style: Object.assign({}, S.modelName, { fontWeight: account.active ? 600 : 400 }),
          title: account.label,
        }, account.label),
        account.active ? h('span', { style: S.badgeSoft }, bind(t, 'currentAccount')) : null,
        // 每个账号自己的累计用量：即使「账号 × 模型」里没有历史交叉拆分，
        // 也能先看到这个账号一共发了多少请求、用了多少 token。
        account.usage !== undefined && account.usage !== null && (account.usage.requests || 0) > 0
          ? h('span', {
              style: Object.assign({}, S.modelMeta, { whiteSpace: 'nowrap' }),
              title: bind(t, 'usageTokenShort') + ' ' + formatNumber(account.usage.totalTokens || 0),
            }, formatNumber(account.usage.requests || 0) + ' ' + bind(t, 'usageCalls') + ' · '
              + compactTokens(account.usage.totalTokens || 0) + ' ' + bind(t, 'usageTokenShort'))
          : null,
        cooling
          ? h('span', {
              style: S.badgeWarn,
              title: bind(t, 'cooldown', { time: formatTime(account.cooldownUntil) }),
            }, bind(t, 'cooldown', { time: formatShortTime(account.cooldownUntil) }))
          : null,
        h('span', { style: S.grow }),
        lastTest !== undefined && lastTest !== null
          ? h('span', {
              style: Object.assign({}, S.modelMeta, { color: lastTest.ok ? healthColor('ok') : healthColor('degraded') }),
              title: lastTest.error === undefined ? '' : String(lastTest.error),
            }, lastTest.ok
              ? bind(t, 'testOk', { ms: String(lastTest.latencyMs || 0) + 'ms' })
              : bind(t, 'testFailed', { reason: shortErrorMessage(lastTest.error, t) }))
          : null,
        h('span', { style: S.modelMeta }, creditsText(snapshot)),
        cooling
          ? h('button', {
              type: 'button',
              style: S.buttonGhost,
              disabled: isBusy(resetKey),
              onClick: function () { resetCooldown(active.provider, account.id) },
            }, bind(t, 'resetCooldown'))
          : null,
        h('button', {
          type: 'button',
          style: S.buttonGhost,
          disabled: isBusy(testKey),
          title: bind(t, 'testAccount'),
          onClick: function () { testAccount(active.provider, account.id) },
        }, isBusy(testKey) ? bind(t, 'testing') : bind(t, 'testAccount')),
        account.active
          ? null
          : h('button', {
              type: 'button',
              style: S.buttonGhost,
              disabled: isBusy('save'),
              onClick: function () {
                var patch = { activeAccount: {} }
                patch.activeAccount[active.provider] = account.id
                mutate(patch)
              },
            }, bind(t, 'useAccount')),
        accountRows.length > 1
          ? h('button', {
              type: 'button',
              style: Object.assign({}, S.buttonGhost, deleteConfirm === account.id
                ? { color: 'var(--dsw-alias-state-error-primary, #b3261e)', borderColor: 'var(--dsw-alias-state-error-primary, #b3261e)' }
                : {}),
              disabled: isBusy('save'),
              // 多账号时多个按钮都叫「删除」，用 aria-label/title 带上账号名，读屏与悬停都不混淆。
              'aria-label': bind(t, 'removeAccountAria', { name: account.label }),
              title: bind(t, 'removeAccountAria', { name: account.label }),
              onClick: function () {
                if (deleteConfirm !== account.id) {
                  armDeleteConfirm(account.id)
                  return
                }
                clearDeleteConfirm()
                // 删除用显式 id，而不是回传一个「少了这一条」的列表：
                // 列表可能是轮询前的旧快照，整表覆盖会把刚登录的账号一起冲掉。
                var remaining = accountRows.filter(function (row) { return row.id !== account.id })
                var patch = { removedAccounts: {} }
                patch.removedAccounts[active.provider] = [account.id]
                if (account.active === true && remaining.length > 0) {
                  patch.activeAccount = {}
                  patch.activeAccount[active.provider] = remaining[0].id
                }
                mutate(patch)
              },
            }, deleteConfirm === account.id ? bind(t, 'removeConfirm') : bind(t, 'removeAccount'))
          : null)
      })

      var addAccount = function () {
        // 保存请求在飞时再点一次会创建两个同密钥账号（旧代码的 disabled
        // 依赖一个从未被设置的 'accounts' 键，等于没有保护）。
        if (busyNow('save')) return
        var secret = accSecret.trim()
        var label = accLabel.trim() === '' ? bind(t, 'accountDefaultLabel') : accLabel.trim()
        var next = { id: newAccountId(), label: label, enabled: true }
        if (isPatProvider) {
          if (secret === '') return
          next.pat = secret
        } else if (secret !== '') {
          next.authFile = secret
        }
        var patch = { accounts: {}, activeAccount: {} }
        // 增量 upsert：服务端会把这一条并进现有账号池，不会覆盖别的账号。
        patch.accounts[active.provider] = [next]
        // 新加的账号直接设为当前，省得用户再点一次。
        patch.activeAccount[active.provider] = next.id
        // 只有保存成功才清空输入；失败时保留用户刚粘贴的 PAT。
        mutate(patch, {
          onSuccess: function () {
            setAccLabel('')
            setAccSecret('')
          },
        })
      }

      // 签到状态：优先显示「今日已签 / 可领 N 分 / 无活动 / 失败原因」。
      var checkin = active.checkin || {}
      var checkinResult = checkin.result !== null && typeof checkin.result === 'object' ? checkin.result : undefined
      var checkinLabel
      var checkinTone = 'hintTiny'
      var checkinFailureRaw = ''
      if (checkin.enabled === false) {
        checkinLabel = bind(t, 'checkinOff')
      } else if (checkinResult === undefined) {
        checkinLabel = checkin.completedToday === true ? bind(t, 'checkinAutoDone') : bind(t, 'checkinNever')
      } else {
        var claimedCount = typeof checkinResult.claimed === 'number' ? checkinResult.claimed : 0
        var claimedCredit = typeof checkinResult.credit === 'number' ? checkinResult.credit : 0
        var kinds = safeArray(checkinResult.outcomes).map(function (item) { return item.kind })
        if (claimedCount > 0) {
          checkinLabel = bind(t, 'checkinClaimed', { count: claimedCount, credit: claimedCredit })
        } else if (kinds.indexOf('already') !== -1) {
          checkinLabel = bind(t, 'checkinAlready')
        } else if (kinds.indexOf('inactive') !== -1) {
          checkinLabel = bind(t, 'checkinInactive')
        } else if (kinds.indexOf('failed') !== -1) {
          checkinFailureRaw = (safeArray(checkinResult.outcomes).find(function (item) { return item.kind === 'failed' }) || {}).message || '—'
          checkinLabel = bind(t, 'checkinFailed', { reason: shortErrorMessage(checkinFailureRaw, t) })
          checkinTone = 'hintWarn'
        } else if (kinds.indexOf('unconfigured') !== -1) {
          // 后端 2.4.0 新增：没有配置登录的账号会被跳过。这里必须单独识别，
          // 否则会落进默认分支显示成「今日已签」，把跳过说成成功。
          checkinLabel = bind(t, 'checkinUnconfigured')
        } else {
          checkinLabel = checkin.completedToday === true ? bind(t, 'checkinAutoDone') : bind(t, 'checkinNever')
        }
      }
      var checkinFailed = checkinTone === 'hintWarn' && checkin.enabled !== false
      // 凭证状态明确不是 signed-in（未登录 / 已禁用）时签到必然失败，先禁掉按钮；
      // credential 缺省（老宿主）按可用处理，避免误伤现有用户。
      var checkinBlocked = credential.status !== undefined && credential.status !== null && credential.status !== 'signed-in'

      sections.push(
        h('div', { key: 'accounts', style: S.section },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, bind(t, 'secAccounts')),
            h('span', { style: S.sectionCount }, String(accountRows.length)),
            h('span', { style: S.grow }),
            h('label', { style: Object.assign({}, S.row, { cursor: 'pointer' }) },
              h('input', {
                type: 'checkbox',
                checked: active.autoSwitch !== false,
                onChange: function () { mutate({ autoSwitch: { enabled: active.autoSwitch === false } }) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'autoSwitch')))),
          h('div', { key: 'checkin', style: S.row },
            h('button', {
              type: 'button',
              style: S.buttonGhost,
              disabled: isBusy('checkin') || checkinBlocked,
              title: checkinBlocked ? bind(t, 'checkinNeedLogin') : undefined,
              onClick: function () {
                if (checkinBlocked) return
                runCheckin(active.provider)
              },
            }, isBusy('checkin') ? bind(t, 'checkinRunning') : bind(t, 'checkinNow')),
            h('label', { style: Object.assign({}, S.row, { cursor: 'pointer' }) },
              h('input', {
                type: 'checkbox',
                checked: checkin.enabled !== false,
                onChange: function () { mutate({ checkin: { enabled: checkin.enabled === false } }) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'checkinAuto'))),
            h('span', { style: S[checkinTone], title: checkinFailureRaw !== '' ? checkinFailureRaw : '' }, checkinLabel),
            checkinFailed ? h('span', { style: S.hintTiny }, bind(t, 'checkinRetryHint')) : null,
            checkin.lastRunAt > 0
              ? h('span', { style: S.modelMeta }, bind(t, 'checkinLastAt', { time: formatTime(checkin.lastRunAt) }))
              : null),
          h('p', { key: 'checkinhint', style: S.hintTiny }, bind(t, 'checkinAutoHint')),
          h('p', { key: 'hint', style: S.hintTiny }, bind(t, isPatProvider ? 'accountsHintPat' : 'accountsHintDesktop')),
          // 桌面 provider：一键打开 App 登录，登录成功后自动导入账号。
          isPatProvider
            ? null
            : h('div', { key: 'login', style: S.row },
                h('button', {
                  type: 'button',
                  style: S.button,
                  disabled: loginBusy,
                  onClick: function () { startLogin(active.provider) },
                }, loginBusy ? bind(t, 'loginOpening') : bind(t, 'loginAdd')),
                loginJob === undefined
                  ? null
                  : h('span', {
                      style: loginJob.phase === 'failed' ? S.hintWarn : S.hintTiny,
                    }, loginJob.message),
                loginJob !== undefined && typeof loginJob.authUrl === 'string' && /^https?:\/\//i.test(loginJob.authUrl)
                  ? h('a', {
                      href: loginJob.authUrl,
                      target: '_blank',
                      rel: 'noreferrer',
                      style: { fontSize: 11.5, color: 'var(--dsw-alias-link, var(--dsw-alias-state-business-primary, #2f6fed))' },
                    }, bind(t, 'loginOpenManually'))
                  : null,
                loginJob !== undefined && (loginJob.phase === 'waiting' || loginJob.phase === 'starting')
                  ? h('button', {
                      type: 'button',
                      style: S.buttonGhost,
                      onClick: function () { cancelLogin(active.provider) },
                    }, bind(t, 'loginCancel'))
                  : null),
          h('ul', { key: 'list', style: S.modelList }, accountItems),
          // 桌面 provider 的新增账号只有「浏览器登录」这一条路 —— 手动填登录文件
          // 路径既容易和本机自动发现重复，也会让用户以为需要自己找文件。
          // Qoder 没有浏览器登录，仍然保留「名称 + PAT」的手动添加。
          isPatProvider
            ? h('div', { key: 'add', style: S.stack },
                h('div', { key: 'row', style: S.row },
                  h('input', {
                    style: Object.assign({}, S.input, { flex: '1 1 140px', width: 'auto' }),
                    type: 'text',
                    'aria-label': bind(t, 'accountLabel'),
                    value: accLabel,
                    placeholder: bind(t, 'accountLabel'),
                    onChange: function (event) { setAccLabel(event.target.value) },
                  }),
                  h('button', {
                    type: 'button',
                    style: S.button,
                    disabled: isBusy('save') || accSecret.trim() === '',
                    onClick: addAccount,
                  }, bind(t, 'addAccount'))),
                h('input', {
                  key: 'secret',
                  style: S.input,
                  type: 'password',
                  'aria-label': bind(t, 'accountPat'),
                  value: accSecret,
                  placeholder: bind(t, 'accountPat'),
                  onChange: function (event) { setAccSecret(event.target.value) },
                }),
                h('span', { key: 'sec', style: S.hintTiny }, bind(t, 'accountSecretHint')))
            : null,
        ),
      )

      // ── 积分 ────────────────────────────────────────────────────
      var credits = active.credits || { state: 'none' }
      var creditsLow = creditsWarning(credits, active.provider, alertRatio, alertsEnabled)
      var qoderFreePlan = isQoderFreePlan(active.provider, credits)
      var creditsHead = h('div', { key: 'h', style: S.sectionHead },
        h('span', { style: S.sectionTitle }, bind(t, 'credits')),
        h('span', { style: S.grow }),
        h('button', {
          key: 'b',
          type: 'button',
          style: S.buttonGhost,
          onClick: refreshCredits,
          disabled: isBusy('credits'),
        }, isBusy('credits') ? bind(t, 'creditsRefreshing') : bind(t, 'creditsRefresh')))

      var creditsBody = []
      if (credits.state === 'ok') {
        var creditsRatio = credits.unlimited === true || !(credits.total > 0)
          || !Number.isFinite(credits.remain)
          ? undefined
          : Math.max(0, Math.min(1, credits.remain / credits.total))
        creditsBody.push(
          h('div', { key: 'stat', style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
            h('span', {
              style: {
                fontSize: 23,
                lineHeight: '28px',
                fontWeight: 600,
                letterSpacing: '-.01em',
                fontVariantNumeric: 'tabular-nums',
                color: creditsLow ? 'var(--dsh-rpc-warn, #9d5c00)' : 'var(--dsw-alias-label-primary)',
                opacity: credits.stale === true ? 0.65 : 1,
              },
            }, credits.unlimited === true ? '∞' : formatNumber(credits.remain)),
            credits.total > 0
              ? h('span', { style: { fontSize: TEXT.body, color: 'var(--dsw-alias-label-secondary)' } },
                  '/ ' + formatNumber(credits.total) + ' ' + bind(t, 'creditsUnit'))
              : h('span', { style: { fontSize: TEXT.body, color: 'var(--dsw-alias-label-secondary)' } }, bind(t, 'creditsUnit')),
            credits.planName ? h('span', { style: S.badge }, credits.planName) : null,
            credits.exceeded ? h('span', { style: S.badgeWarn }, bind(t, qoderFreePlan ? 'creditsFreeQueue' : 'creditsExhausted')) : null,
            credits.stale === true ? h('span', { style: S.badgeSoft }, bind(t, 'creditsStale')) : null),
        )
        if (creditsRatio !== undefined) {
          creditsBody.push(
            h('div', {
              key: 'bar',
              style: {
                height: 5,
                borderRadius: 999,
                background: 'var(--dsh-rpc-fill, rgba(127,127,127,.16))',
                overflow: 'hidden',
                maxWidth: 420,
              },
            },
            h('div', {
              style: {
                width: Math.round(creditsRatio * 100) + '%',
                height: '100%',
                borderRadius: 999,
                background: creditsLow
                  ? 'var(--dsh-rpc-warn, #9d5c00)'
                  : 'var(--dsw-alias-state-business-primary, #2f6fed)',
                opacity: 0.9,
              },
            })),
          )
        }
        if (credits.resetAtMs > 0) {
          creditsBody.push(h('p', { key: 'reset', style: S.hintTiny }, bind(t, 'creditsReset') + ' ' + formatTime(credits.resetAtMs)))
        }
        if (qoderFreePlan) {
          creditsBody.push(h('p', { key: 'freehint', style: S.hintTiny }, bind(t, 'freeModelHint')))
        }

        // 额度趋势：今日/7 天花费、消耗速度与耗尽预估。
        var trend = credits.trend
        if (trend !== null && typeof trend === 'object' && (trend.sampleCount > 0 || safeArray(trend.points).length > 1)) {
          var trendChips = []
          trendChips.push(h('span', { key: 'td', style: microChip() }, bind(t, 'trendToday', { value: formatNumber(trend.spentToday || 0) })))
          if (trend.spent7d > 0) {
            trendChips.push(h('span', { key: 'tw', style: microChip() }, bind(t, 'trendWeek', { value: formatNumber(trend.spent7d) })))
          }
          if (trend.topupToday > 0) {
            trendChips.push(h('span', { key: 'tu', style: microChip() }, bind(t, 'trendTopup', { value: formatNumber(trend.topupToday) })))
          }
          if (typeof trend.burnPerHour === 'number' && trend.burnPerHour > 0) {
            trendChips.push(h('span', { key: 'tr', style: microChip() }, bind(t, 'trendRate', { value: formatNumber(trend.burnPerHour) })))
          }
          if (typeof trend.etaMs === 'number' && trend.etaMs > 0) {
            trendChips.push(h('span', { key: 'te', style: microChip(creditsLow ? 'var(--dsh-rpc-warn, #9d5c00)' : undefined) }, bind(t, 'trendEta', { duration: formatCompactDuration(trend.etaMs) })))
          }
          creditsBody.push(
            h('div', { key: 'trend', style: { display: 'flex', flexDirection: 'column', gap: 5, paddingTop: 7, borderTop: '0.5px solid var(--dsw-alias-border-l2)' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h('span', { style: S.label }, bind(t, 'trend')),
                h('span', { style: S.grow }),
                ...trendChips),
              sparkline(trend.points, creditsLow ? 'var(--dsh-rpc-warn, #9d5c00)' : (PROVIDER_ACCENT[active.provider] || 'currentColor')),
              typeof trend.etaMs !== 'number'
                ? h('span', { style: { fontSize: TEXT.tiny, color: 'var(--dsw-alias-label-secondary)' } }, bind(t, 'trendEtaUnknown'))
                : null),
          )
        }
      } else if (credits.state === 'error') {
        creditsBody.push(h('p', { key: 'flat', style: S.hintError }, creditsText(credits)))
        // 原因字段可能是 `message`（上游原始响应）或 `error`（runtime 折过的那份）。
        var creditError = typeof credits.message === 'string' && credits.message !== ''
          ? credits.message
          : typeof credits.error === 'string' && credits.error !== '' ? credits.error : undefined
        if (creditError !== undefined) {
          creditsBody.push(h('p', { key: 'err', style: S.hintWarn }, bind(t, 'creditsFailed', { message: creditError })))
        }
      } else {
        // `state: 'none'` 是「没有可读的额度端点 / 还没配凭证」：正文只写「未读取」，
        // 原因放在第二行（超长就截断），完整文案进悬停提示 —— 与侧栏面板同一套规则。
        creditsBody.push(h('p', { key: 'flat', style: S.hint }, creditsText(credits)))
        var creditNoneReason = typeof credits.error === 'string' && credits.error !== ''
          ? credits.error
          : typeof credits.message === 'string' && credits.message !== '' ? credits.message : undefined
        if (creditNoneReason !== undefined) {
          creditsBody.push(h('p', {
            key: 'why',
            style: S.hintTiny,
            title: creditNoneReason,
          }, creditNoneReason.length > 60 ? creditNoneReason.slice(0, 60) + '…' : creditNoneReason))
        }
      }

      var creditItems = safeArray(credits.items)
      if (creditItems.length > 0) {
        creditsBody.push(
          h('details', { key: 'pkgs' },
            h('summary', { style: Object.assign({}, S.hintTiny, { cursor: 'pointer' }) },
              bind(t, 'creditsPackages', { count: creditItems.length })),
            h('ul', {
              style: Object.assign({}, S.modelList, { marginTop: 6 }),
            },
            creditItems.map(function (item, index) {
              return h('li', {
                key: 'pkg' + index,
                style: Object.assign({}, S.modelRow, index > 0 ? S.modelRowDivider : {}),
              },
              h('span', { style: S.modelName }, typeof item.name === 'string' && item.name !== '' ? item.name : bind(t, 'creditsPackageFallback')),
              item.expired ? h('span', { style: S.badge }, bind(t, 'creditsExhausted')) : null,
              h('span', { style: S.grow }),
              h('span', { style: S.modelMeta }, formatNumber(item.remain) + ' / ' + formatNumber(item.total)),
              h('span', { style: S.modelId }, item.endAtMs ? formatTime(item.endAtMs) : ''))
            })),
          ),
        )
      }
      if (credits.fetchedAt > 0) {
        creditsBody.push(h('p', { key: 'at', style: S.hintTiny }, bind(t, 'creditsFetchedAt', { time: formatTime(credits.fetchedAt) })))
      }

      sections.push(h('div', { key: 'credits', style: S.section }, creditsHead, ...creditsBody))

      // ── 用量 ────────────────────────────────────────────────────
      //
      // 这是 1.0.0 新增的一块：之前只有「还剩多少」，没有「用掉多少」。
      // 数据由宿主在每次请求结束时写入 stats.json，失败与取消分开计数，
      // 所以「今天 12 次请求、成功率 91%」这类问题是能直接回答的。
      var statsDoc = status.stats || {}
      var providerUsage = active.usage || {}
      var usageToday = providerUsage.today || {}
      // 1.3.0 起 stats 按 provider 分开记「当前会话」；老宿主没有这两个字段时
      // 才退回全局值，避免把另一个 provider 的会话数字挂在当前标签页上。
      var providerSession = statsDoc.providerCurrentSession !== undefined && statsDoc.providerCurrentSession !== null
        ? statsDoc.providerCurrentSession[active.provider]
        : statsDoc.currentSession
      var recentRequests = safeArray(statsDoc.recent).filter(function (entry) {
        return entry.provider === active.provider
      }).slice(0, 6)

      // 表格基础样式：描边、表头底色、行分隔线全部显式给出。
      // 之前的「一堆没有线的数字」看起来像排版事故，问题就在没有表格约束。
      var usageBorder = 'var(--dsw-alias-border-l2)'
      var usageCell = {
        padding: '6px 9px',
        fontSize: TEXT.body,
        lineHeight: '18px',
        minWidth: 0,
        boxSizing: 'border-box',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }
      var usageHeadCell = Object.assign({}, usageCell, {
        fontSize: TEXT.tiny,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsh-rpc-fill, rgba(127,127,127,.06))',
      })
      var usageNumberCell = Object.assign({}, usageCell, {
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-primary)',
      })
      var usageLabelCell = Object.assign({}, usageCell, {
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 500,
      })
      var usageTableFrame = {
        border: '0.5px solid ' + usageBorder,
        borderRadius: 8,
        overflowX: 'auto',
        overflowY: 'hidden',
      }
      var usageRowLine = { borderTop: '0.5px solid ' + usageBorder }
      var recentColumns = 'minmax(84px, 1.1fr) minmax(84px, 1.4fr) minmax(58px, .8fr) minmax(52px, .8fr) minmax(60px, .8fr)'

      var usageHead = function (key, label, alignRight) {
        return h('span', { key: key, style: Object.assign({}, usageHeadCell, alignRight === true ? { textAlign: 'right' } : {}) }, label)
      }

      var usageBody = []
      if (statsDoc.enabled === false) {
        usageBody.push(h('p', { key: 'off', style: S.hintTiny }, bind(t, 'usageDisabled')))
      } else {
        var rateOf = function (counters) {
          return typeof counters.successRate === 'number' ? String(Math.round(counters.successRate * 100)) + '%' : '—'
        }
        /**
         * KPI 卡片底部的一行「标签 / 数值」。
         *
         * 用两列 grid 而不是 `文本 · 文本 · 文本`：后者在窄卡片里会在
         * 分隔点前换行，第二行以「·」开头，看起来像排版坏了。
         */
        var usageMetric = function (key, label, value, title) {
          return [
            h('span', {
              key: key + '-l',
              style: {
                color: 'var(--dsw-alias-label-secondary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            }, label),
            h('span', {
              key: key + '-v',
              title: title === undefined ? '' : title,
              style: {
                color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            }, value),
          ]
        }
        var usageCard = function (key, label, counters, present) {
          var data = counters !== null && typeof counters === 'object' ? counters : {}
          return h('div', {
            key: key,
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              minWidth: 0,
              padding: '9px 11px 8px',
              borderRadius: 10,
              border: '0.5px solid ' + usageBorder,
              background: 'var(--dsh-rpc-fill, rgba(127,127,127,.06))',
              boxSizing: 'border-box',
            },
          },
          h('span', {
            style: { fontSize: TEXT.tiny, fontWeight: 600, letterSpacing: '.06em', color: 'var(--dsw-alias-label-secondary)' },
          }, label),
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 } },
            h('span', {
              style: {
                fontSize: 22,
                lineHeight: '27px',
                fontWeight: 650,
                letterSpacing: '-.015em',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--dsw-alias-label-primary)',
              },
            }, present === false ? '—' : formatNumber(data.requests || 0)),
            present === false
              ? null
              : h('span', { style: { fontSize: TEXT.tiny, color: 'var(--dsw-alias-label-secondary)' } }, bind(t, 'usageCalls'))),
          h('div', {
            style: {
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0, 1fr)',
              columnGap: 10,
              rowGap: 1,
              marginTop: 5,
              paddingTop: 6,
              borderTop: '0.5px solid var(--dsw-alias-border-l2)',
              minWidth: 0,
              fontSize: TEXT.tiny,
              lineHeight: LINE.dense,
            },
          },
          ...usageMetric('rate', bind(t, 'usageRate'), present === false ? '—' : rateOf(data)),
          ...usageMetric('avg', bind(t, 'usageAvg'), present === false ? '—' : formatDuration(data.avgDurationMs)),
          ...usageMetric(
            'tokens',
            bind(t, 'usageTokenShort'),
            present === false ? '—' : compactTokens(data.totalTokens || 0),
            bind(t, 'usageTokenShort') + ' ' + formatNumber(data.totalTokens || 0),
          )))
        }
        var sessionPresent = typeof providerSession === 'object' && providerSession !== null && providerSession.requests > 0
        usageBody.push(
          h('div', {
            key: 'summary',
            style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: 8 },
          },
          usageCard('today', bind(t, 'usageToday'), usageToday, true),
          usageCard('all', bind(t, 'usageTotal'), providerUsage, true),
          usageCard('session', bind(t, 'usageSession'), providerSession, sessionPresent)),
        )
        if (active.provider.indexOf('qoder') === 0 && (usageToday.requests || 0) > 0 && (usageToday.totalTokens || 0) === 0) {
          usageBody.push(h('p', { key: 'noUsage', style: S.hintTiny }, bind(t, 'usageNoUsage')))
        }
        usageBody.push(
          h('div', { key: 'resetrow', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('label', { style: Object.assign({}, S.row, { cursor: 'pointer' }) },
              h('input', {
                type: 'checkbox',
                checked: !(status.settings && status.settings.showUsageInSidebar === false),
                onChange: function () {
                  var on = !(status.settings && status.settings.showUsageInSidebar === false)
                  mutate({ display: { showUsageInSidebar: !on } })
                },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'usageShowInSidebar'))),
            h('span', { style: S.grow }),
            h('button', {
              type: 'button',
              style: S.buttonGhost,
              onClick: resetStats,
              disabled: isBusy('stats'),
            }, isBusy('stats') ? bind(t, 'usageResetting') : bind(t, 'usageReset'))),
        )
        if (statsDoc.since > 0) {
          usageBody.push(h('p', { key: 'since', style: S.hintTiny }, bind(t, 'usageSince', { time: formatTime(statsDoc.since) })))
        }

        // 最近 14 天用量：固定 14 个槽位，缺的日期补 0。
        // 旧实现直接用「有数据的日期」画柱状图：只有一天数据时那一根会占满
        // 整行，看起来像一条加载进度条，而不是 14 天趋势。
        var providerDaily = statsDoc.providerDaily !== undefined && statsDoc.providerDaily !== null
          ? statsDoc.providerDaily[active.provider]
          : undefined
        var hasProviderDaily = statsDoc.providerDaily !== undefined && statsDoc.providerDaily !== null
        var daily = hasProviderDaily
          ? safeArray(providerDaily).slice(-14)
          : safeArray(statsDoc.daily).slice(-14)
        var validDaily = daily.filter(function (day) {
          return day !== null && typeof day === 'object' && typeof day.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date)
        })
        if (validDaily.length > 0) {
          var dailyByDate = {}
          validDaily.forEach(function (day) { dailyByDate[day.date] = day })
          var anchored = new Date(
            Number(validDaily[validDaily.length - 1].date.slice(0, 4)),
            Number(validDaily[validDaily.length - 1].date.slice(5, 7)) - 1,
            Number(validDaily[validDaily.length - 1].date.slice(8, 10)),
          )
          var buckets = []
          for (var offset = 13; offset >= 0; offset--) {
            var cursor = new Date(anchored.getFullYear(), anchored.getMonth(), anchored.getDate() - offset)
            var pad = function (value) { return String(value).padStart(2, '0') }
            var key = String(cursor.getFullYear()) + '-' + pad(cursor.getMonth() + 1) + '-' + pad(cursor.getDate())
            buckets.push({
              date: key,
              requests: dailyByDate[key]?.requests,
              totalTokens: dailyByDate[key]?.totalTokens,
            })
          }
          var maxDailyTokens = 1
          buckets.forEach(function (day) {
            if (typeof day.totalTokens === 'number' && day.totalTokens > maxDailyTokens) maxDailyTokens = day.totalTokens
          })
          usageBody.push(
            h('div', { key: 'heat', style: { display: 'flex', flexDirection: 'column', gap: 5, paddingTop: 2 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: S.sectionTitle }, bind(t, 'usageHeatmap')),
                h('span', { style: S.grow }),
                h('span', { style: S.hintTiny }, '14d')),
              h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 34, paddingTop: 2 } },
                buckets.map(function (day) {
                  var tokens = typeof day.totalTokens === 'number' ? day.totalTokens : 0
                  var height = tokens > 0 ? Math.max(4, Math.round((tokens / maxDailyTokens) * 28)) : 3
                  return h('div', {
                    key: 'd' + day.date,
                    title: bind(t, 'usageHeatCell', { date: day.date, requests: formatNumber(day.requests || 0), tokens: formatNumber(tokens) }),
                    style: {
                      flex: '1 1 0',
                      minWidth: 3,
                      maxWidth: 44,
                      height: 32,
                      display: 'flex',
                      alignItems: 'flex-end',
                      borderRadius: 3,
                      background: 'var(--dsh-rpc-fill, rgba(127,127,127,.05))',
                      overflow: 'hidden',
                    },
                  },
                  h('div', {
                    style: {
                      width: '100%',
                      height: height,
                      borderRadius: 3,
                      background: tokens > 0
                        ? (PROVIDER_ACCENT[active.provider] || 'var(--dsw-alias-state-business-primary, #2f6fed)')
                        : 'var(--dsw-alias-border-l2)',
                      opacity: tokens > 0 ? 0.55 + Math.min(0.45, tokens / maxDailyTokens / 2) : 0.35,
                      transition: 'height .2s ease',
                    },
                  }))
                })),
              h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } },
                h('span', {}, buckets[0].date.slice(5)),
                h('span', {}, buckets[buckets.length - 1].date.slice(5)))),
          )
        }

        // 模型用量：stats.models 的键是 `provider::model`。
        var modelStats = []
        if (statsDoc.models !== null && typeof statsDoc.models === 'object') {
          Object.keys(statsDoc.models).forEach(function (key) {
            if (key.indexOf(active.provider + '::') !== 0) return
            var counters = statsDoc.models[key]
            if (counters === null || typeof counters !== 'object' || !(counters.requests > 0)) return
            modelStats.push({ model: key.slice(active.provider.length + 2), counters: counters })
          })
        }
        modelStats.sort(function (a, b) { return b.counters.requests - a.counters.requests })
        modelStats = modelStats.slice(0, 5)
        if (modelStats.length > 0) {
          var modelColumns = 'minmax(110px, 1.6fr) minmax(46px, .7fr) minmax(68px, .9fr) minmax(56px, .8fr)'
          usageBody.push(
            h('div', { key: 'topmodels', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('span', { style: S.sectionTitle }, bind(t, 'usageTopModels')),
              h('div', { style: usageTableFrame },
                h('div', { style: { display: 'grid', gridTemplateColumns: modelColumns, minWidth: 360 } },
                  usageHead('m0', bind(t, 'usageModel')),
                  usageHead('m1', bind(t, 'usageModelCalls'), true),
                  usageHead('m2', bind(t, 'usageModelTokens'), true),
                  usageHead('m3', bind(t, 'usageAvg'), true)),
                modelStats.map(function (entry, index) {
                  return h('div', {
                    key: 'm' + index,
                    style: Object.assign({ display: 'grid', gridTemplateColumns: modelColumns, alignItems: 'center' }, index > 0 ? usageRowLine : {}),
                  },
                  h('span', { style: Object.assign({}, usageCell, { color: 'var(--dsw-alias-label-primary)' }), title: entry.model }, entry.model || '—'),
                  h('span', { style: usageNumberCell }, formatNumber(entry.counters.requests || 0)),
                  h('span', { style: usageNumberCell }, formatNumber(entry.counters.totalTokens || 0)),
                  h('span', { style: Object.assign({}, usageNumberCell, { color: 'var(--dsw-alias-label-secondary)' }) }, formatDuration(entry.counters.avgDurationMs)))
                }))),
          )
        }

        // 账号 × 模型：stats.accountModels / accountModelToday 是 v4 新增的交叉维度。
        //
        // 为什么需要它：`models` 只回答「这个模型一共花了多少」，`accounts` 只回答
        // 「这个账号一共花了多少」；两个账号都用同一个模型时，用户真正想知道的是
        // 「到底是哪个账号在烧 token」，这两份独立计数都答不了。
        //
        // **默认显示「今日」**：卡片上方写的就是「今日 1,159 次 / 366M tokens」，
        // 交叉表如果默认给累计，两处数字永远对不上 —— 交叉维度是升级后才开始累积的，
        // 累计值天然小于历史总量。用户看到「今日 176M，表里只有 10M」会以为坏了。
        //
        // 只在「该 provider 下账号数 > 1」时显示：单账号时这一栏和模型用量完全
        // 重复，白白多一张表。
        //
        // 老宿主（1.9.0 之前）只下发 `accountModels`，没有今日那一份。这时不要把
        // 「今日」按钮画成选中却显示累计数据 —— 那正是这版要消灭的「数字对不上」。
        // 没有今日数据就只显示「累计」，也不渲染切换按钮。
        //
        // 2.1.2：今日桶可能只是**暂时为空**（例如刚升级、或今天还没发过请求），
        // 但累计桶里已经有数据。旧判断只看「accountModelToday 是不是对象」，
        // 一个空对象也会被当成有今日口径 → 选中今日 → 0 行 → 整张表消失。
        // 现在按「该 provider 是否真的有今日行」决定默认口径。
        var accountModelAllSource = statsDoc.accountModels
        var accountModelTodaySource = statsDoc.accountModelToday
        var hasProviderPairs = function (source) {
          if (source === null || typeof source !== 'object' || Array.isArray(source)) return false
          return Object.keys(source).some(function (key) {
            var counters = source[key]
            return counters !== null && typeof counters === 'object'
              && counters.provider === active.provider
              && typeof counters.accountId === 'string'
              && typeof counters.model === 'string'
              && counters.requests > 0
          })
        }
        var hasAllPairs = hasProviderPairs(accountModelAllSource)
        var hasTodayPairs = hasProviderPairs(accountModelTodaySource)
        var showRangeToggle = hasTodayPairs && hasAllPairs
        var effectiveAccountModelRange = hasTodayPairs && accountModelRange === 'all' ? 'all' : hasTodayPairs ? 'today' : 'all'
        var accountModelSource = effectiveAccountModelRange === 'all'
          ? accountModelAllSource
          : accountModelTodaySource
        var accountModelFallback = effectiveAccountModelRange === 'all' && !hasTodayPairs && hasAllPairs
        var accountModelRows = []
        // 交叉维度只从 1.9.x 开始累积。历史请求拆不出来，所以这里的次数
        // **一定**小于卡片上方的总量 —— 不写清楚，用户只会觉得「数字不对」。
        // 把「已覆盖 X / 共 Y 次」显式摆出来，缺口就是解释而不是 bug。
        var accountModelCovered = 0
        if (Array.isArray(active.accounts) && active.accounts.length > 1
          && accountModelSource !== null && typeof accountModelSource === 'object') {
          var labelOfAccount = {}
          safeArray(active.accounts).forEach(function (account) {
            if (account !== null && typeof account.id === 'string') labelOfAccount[account.id] = account.label
          })
          Object.keys(accountModelSource).forEach(function (key) {
            var counters = accountModelSource[key]
            if (counters === null || typeof counters !== 'object') return
            // 快照里已经拆好三段（provider / accountId / model），不再自己拆键。
            if (counters.provider !== active.provider) return
            if (typeof counters.accountId !== 'string' || typeof counters.model !== 'string') return
            if (!(counters.requests > 0)) return
            accountModelCovered += counters.requests
            accountModelRows.push({
              accountId: counters.accountId,
              label: labelOfAccount[counters.accountId] || counters.accountId,
              model: counters.model,
              counters: counters,
            })
          })
          accountModelRows.sort(function (a, b) {
            return (Number(b.counters.totalTokens) || 0) - (Number(a.counters.totalTokens) || 0)
          })
          accountModelRows = accountModelRows.slice(0, 8)
        }
        // 上方那张汇总表用的是同一个口径（今日 / 累计），直接拿来当分母。
        var accountModelTotal = effectiveAccountModelRange === 'all'
          ? (typeof providerUsage.requests === 'number' ? providerUsage.requests : 0)
          : (typeof usageToday.requests === 'number' ? usageToday.requests : 0)
        var accountModelCoverage = accountModelRows.length > 0 && accountModelTotal > 0 && accountModelCovered < accountModelTotal
          ? bind(t, 'usageAccountModelCoverage', {
            covered: formatNumber(accountModelCovered),
            total: formatNumber(accountModelTotal),
            percent: String(Math.min(99, Math.max(1, Math.round((accountModelCovered / accountModelTotal) * 100)))),
          })
          : undefined
        if (accountModelRows.length > 0) {
          var accountModelColumns = 'minmax(78px, 1fr) minmax(92px, 1.3fr) minmax(40px, .55fr) minmax(60px, .8fr) minmax(50px, .65fr) minmax(104px, 1.15fr)'
          var accountById = {}
          safeArray(active.accounts).forEach(function (account) {
            if (account !== null && typeof account === 'object' && typeof account.id === 'string') accountById[account.id] = account
          })
          var limitCodes = { RATE_LIMIT: true, QUOTA: true }
          var recentLimitFor = function (accountId, modelId) {
            var list = safeArray(statsDoc.recent)
            for (var index = 0; index < list.length; index++) {
              var item = list[index]
              if (item === null || typeof item !== 'object') continue
              if (item.provider !== active.provider || item.accountId !== accountId || item.model !== modelId) continue
              if (item.kind !== 'error' || limitCodes[item.code] !== true) continue
              return item
            }
            return undefined
          }
          var modelTestCell = function (entry) {
            var account = accountById[entry.accountId]
            var test = account !== undefined && account.modelTests !== null && typeof account.modelTests === 'object'
              ? account.modelTests[entry.model]
              : undefined
            var recent = test === undefined ? recentLimitFor(entry.accountId, entry.model) : undefined
            var badge = null
            if (test !== undefined && typeof test === 'object') {
              if (test.ok === true) {
                badge = h('span', {
                  style: S.badgeSoft,
                  title: bind(t, 'testOk', { ms: String(test.latencyMs ?? 0) + 'ms' }),
                }, bind(t, 'modelTestOk'))
              } else if (limitCodes[test.code] === true) {
                badge = h('span', {
                  style: S.badgeWarn,
                  title: [
                    bind(t, 'limitUntil', { time: test.resetHint === undefined ? '—' : test.resetHint }),
                    test.error,
                  ].filter(function (value) { return typeof value === 'string' && value !== '' }).join(' · '),
                }, bind(t, 'limitBadge'))
              } else if (test.code === 'AUTH') {
                badge = h('span', { style: S.badgeWarn, title: test.error ?? '' }, bind(t, 'authBadge'))
              } else {
                badge = h('span', {
                  style: S.badgeWarn,
                  title: [test.code, test.error].filter(function (value) { return typeof value === 'string' && value !== '' }).join(' · '),
                }, bind(t, 'modelTestFailed'))
              }
            } else if (recent !== undefined) {
              // 没手动测过，但最近一次真实请求已经被上游限额：同样打徽章。
              badge = h('span', {
                style: S.badgeWarn,
                title: [
                  bind(t, 'recentLimitHint', { code: recent.code }),
                  formatTime(recent.at),
                  recent.message,
                ].filter(function (value) { return typeof value === 'string' && value !== '' }).join(' · '),
              }, bind(t, 'limitBadge'))
            }
            var busyKey = 'model-test:' + entry.accountId + ':' + entry.model
            return h('div', {
              style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, flexWrap: 'wrap', minWidth: 0 },
            },
            badge,
            h('button', {
              type: 'button',
              style: S.buttonGhost,
              disabled: isBusy(busyKey),
              title: bind(t, 'modelTest'),
              onClick: function () { testAccountModel(active.provider, entry.accountId, entry.model) },
            }, isBusy(busyKey) ? bind(t, 'modelTesting') : bind(t, 'modelTest')))
          }
          // 切换按钮：两个口径的起点不同（今日 vs 累计），必须让用户能选，
          // 而不是只能看一个然后怀疑数字。老宿主没有今日数据时渲染按钮会把
          // 「今日」画成选中却显示累计，所以干脆不渲染。
          var rangeButton = function (key, label, value) {
            return h('button', {
              key: 'r' + key,
              type: 'button',
              onClick: function () { setAccountModelRange(value) },
              style: {
                font: 'inherit',
                fontSize: TEXT.tiny,
                lineHeight: '16px',
                padding: '0 7px',
                borderRadius: 999,
                cursor: 'pointer',
                border: '0.5px solid ' + (effectiveAccountModelRange === value
                  ? 'var(--dsw-alias-state-business-primary, #2f6fed)'
                  : 'var(--dsw-alias-border-l2)'),
                background: effectiveAccountModelRange === value
                  ? 'var(--dsh-rpc-fill, rgba(127,127,127,.10))'
                  : 'transparent',
                color: effectiveAccountModelRange === value
                  ? 'var(--dsw-alias-label-primary)'
                  : 'var(--dsw-alias-label-secondary)',
                whiteSpace: 'nowrap',
                flex: '0 0 auto',
              },
            }, label)
          }
          usageBody.push(
            h('div', { key: 'accountmodels', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h('span', { style: S.sectionTitle }, bind(t, 'usageAccountModels')),
                showRangeToggle ? rangeButton('today', bind(t, 'usageToday'), 'today') : null,
                showRangeToggle ? rangeButton('all', bind(t, 'usageTotal'), 'all') : null,
                showRangeToggle
                  ? null
                  : h('span', { style: S.badgeSoft }, bind(t, effectiveAccountModelRange === 'all' ? 'usageTotal' : 'usageToday')),
                // 覆盖率：这批数字只覆盖升级之后的请求，缺口要写明。
                // 不写的话，用户拿它和上方的「今日 N 次」对比只会觉得坏了。
                accountModelCoverage === undefined
                  ? null
                  : h('span', {
                      title: bind(t, 'usageAccountModelsHint'),
                      style: {
                        fontSize: TEXT.tiny,
                        lineHeight: '16px',
                        color: 'var(--dsh-rpc-warn, #9d5c00)',
                        whiteSpace: 'nowrap',
                        flex: '0 0 auto',
                      },
                    }, accountModelCoverage),
                h('span', { style: S.grow }),
                h('span', { style: { fontSize: TEXT.tiny, color: 'var(--dsw-alias-label-secondary)' }, title: bind(t, 'usageAccountModelsHint') }, bind(t, 'usageAccountModelsHint'))),
              accountModelFallback
                ? h('p', { key: 'fallback', style: S.hintTiny }, bind(t, 'usageAccountModelTodayEmpty'))
                : null,
              h('div', { style: usageTableFrame },
                h('div', { style: { display: 'grid', gridTemplateColumns: accountModelColumns, minWidth: 540 } },
                  usageHead('a0', bind(t, 'usageAccountCol')),
                  usageHead('a1', bind(t, 'usageModel')),
                  usageHead('a2', bind(t, 'usageModelCalls'), true),
                  usageHead('a3', bind(t, 'usageModelTokens'), true),
                  usageHead('a4', bind(t, 'usageAvg'), true),
                  usageHead('a5', bind(t, 'usageAccountModelStatus'), true)),
                accountModelRows.map(function (entry, index) {
                  return h('div', {
                    key: 'am' + index,
                    style: Object.assign({ display: 'grid', gridTemplateColumns: accountModelColumns, alignItems: 'center' }, index > 0 ? usageRowLine : {}),
                  },
                  h('span', { style: Object.assign({}, usageCell, { color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))' }), title: entry.label }, entry.label || '—'),
                  h('span', { style: Object.assign({}, usageCell, { color: 'var(--dsw-alias-label-primary)' }), title: entry.model }, entry.model || '—'),
                  h('span', { style: usageNumberCell }, formatNumber(entry.counters.requests || 0)),
                  h('span', { style: usageNumberCell }, formatNumber(entry.counters.totalTokens || 0)),
                  h('span', { style: Object.assign({}, usageNumberCell, { color: 'var(--dsw-alias-label-secondary)' }) }, formatDuration(entry.counters.avgDurationMs)),
                  modelTestCell(entry))
                }))),
          )
        }

        // 最近请求默认折叠：它是排障信息，不该占用卡片主视线。
        usageBody.push(
          h('details', { key: 'recentbox', style: { marginTop: 2 } },
            h('summary', {
              style: Object.assign({}, S.sectionTitle, { cursor: 'pointer', userSelect: 'none' }),
            }, bind(t, 'usageRecent') + ' · ' + String(recentRequests.length)),
            recentRequests.length === 0
              ? h('p', { key: 'empty', style: Object.assign({}, S.hintTiny, { marginTop: 6 }) }, bind(t, 'usageEmpty'))
              : h('div', { key: 'recent', style: Object.assign({}, usageTableFrame, { marginTop: 6 }) },
                  h('div', { style: { display: 'grid', gridTemplateColumns: recentColumns, minWidth: 380 } },
                    usageHead('r0', bind(t, 'usageTime')),
                    usageHead('r1', bind(t, 'usageModel')),
                    usageHead('r2', bind(t, 'usageOutcome'), true),
                    usageHead('r3', bind(t, 'usageDuration'), true),
                    usageHead('r4', bind(t, 'usageTokenShort'), true)),
                  recentRequests.map(function (entry, index) {
                    var failed = entry.kind === 'error'
                    return h(
                      'div',
                      {
                        key: 'req' + index,
                        style: Object.assign({ display: 'grid', gridTemplateColumns: recentColumns, alignItems: 'center' }, index > 0 ? usageRowLine : {}),
                      },
                      h('span', { style: Object.assign({}, usageCell, { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' }), title: formatTime(entry.at) }, formatShortTime(entry.at)),
                      h('span', { style: Object.assign({}, usageCell, { color: 'var(--dsw-alias-label-primary)' }), title: entry.model || '' }, entry.model || '—'),
                      h('span', { style: Object.assign({}, usageCell, { textAlign: 'right' }) },
                        h('span', {
                          style: failed || entry.kind === 'incomplete' ? S.badgeWarn : S.badgeSoft,
                          title: [entry.code, entry.message].filter(function (value) { return typeof value === 'string' && value !== '' }).join(' · '),
                        }, bind(t, kindTextKey(entry.kind)))),
                      h('span', { style: Object.assign({}, usageNumberCell, { color: 'var(--dsw-alias-label-secondary)' }) }, formatDuration(entry.durationMs)),
                      h('span', { style: Object.assign({}, usageNumberCell, { color: 'var(--dsw-alias-label-secondary)' }) }, formatNumber(entry.totalTokens || 0)),
                    )
                  }))),
        )
      }
      sections.push(
        h('div', { key: 'usage', style: S.section },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, bind(t, 'usage')),
            h('span', { style: S.sectionCount }, String(usageToday.requests || 0))),
          ...usageBody),
      )

      // ── 连接设置 ────────────────────────────────────────────────
      var connectionBody = []
      if (active.kind === 'pat') {
        var configured = status.settings && status.settings.qoder && status.settings.qoder[active.provider] && status.settings.qoder[active.provider].configured
        connectionBody.push(
          h('div', { key: 'f', style: S.field },
            h('span', { style: S.label }, bind(t, 'pat')),
            h('input', {
              style: S.input,
              type: 'password',
              'aria-label': bind(t, 'pat'),
              value: patDraft,
              placeholder: configured ? bind(t, 'patConfigured', { tail: (credential.patTail || '…') }) : bind(t, 'patPlaceholder'),
              onChange: function (event) { setPatDraft(event.target.value) },
            })),
          h('p', { key: 'h', style: S.hintTiny }, bind(t, 'patHint')),
          h('p', { key: 'link', style: S.hintTiny },
            bind(t, 'patLinkHint') + ' ',
            h('a', {
              href: PAT_PAGE[active.provider] || PAT_PAGE.qoder,
              target: '_blank',
              rel: 'noreferrer',
              style: { color: 'var(--dsw-alias-link, var(--dsw-alias-state-business-primary, #2f6fed))' },
            }, bind(t, 'patOpen'))),
          h('div', { key: 'btns', style: S.row },
            h('button', { type: 'button', style: S.buttonPrimary, onClick: savePat, disabled: isBusy('save') || patDraft.trim() === '' },
              isBusy('save') ? bind(t, 'saving') : bind(t, 'save')),
            h('button', { type: 'button', style: S.button, onClick: clearPat, disabled: isBusy('save') || !configured },
              bind(t, 'clear'))),
        )
      } else if (active.kind === 'desktop-auth') {
        // Trae：不需要 PAT，也不需要找 App 可执行文件 —— 凭证就在客户端的
        // `storage.json` 里。能填的只有一个可选的路径覆盖。
        var traeConfigured = status.settings && status.settings.trae && status.settings.trae[active.provider] && status.settings.trae[active.provider].configured
        connectionBody.push(
          h('div', { key: 'st', style: S.field },
            h('span', { style: S.label }, bind(t, 'traeStorageFile')),
            h('input', {
              style: S.input,
              type: 'text',
              'aria-label': bind(t, 'traeStorageFile'),
              value: authFileDraft,
              placeholder: credential.file || '%APPDATA%\\Trae CN\\User\\globalStorage\\storage.json',
              onChange: function (event) { setAuthFileDraft(event.target.value) },
            }),
            h('span', { style: S.hintTiny }, bind(t, 'traeStorageFileHint'))),
          h('p', { key: 'h', style: S.hintTiny },
            traeConfigured ? bind(t, 'traeSignedIn', { name: credential.name || credential.userId || '—' }) : bind(t, 'traeSignInHint')),
          h('div', { key: 'btns', style: S.row },
            h('button', { type: 'button', style: S.buttonPrimary, onClick: saveTrae, disabled: isBusy('save') },
              isBusy('save') ? bind(t, 'saving') : bind(t, 'save'))),
        )
      } else {
        connectionBody.push(
          h('div', { key: 'appf', style: S.field },
            h('span', { style: S.label }, bind(t, 'appPath')),
            h('input', {
              style: S.input,
              type: 'text',
              'aria-label': bind(t, 'appPath'),
              value: appPathDraft,
              placeholder: 'D:\\WorkBuddy\\WorkBuddy.exe',
              onChange: function (event) { setAppPathDraft(event.target.value) },
            }),
            h('span', { style: S.hintTiny }, bind(t, 'appPathHint'))),
          h('div', { key: 'authf', style: S.field },
            h('span', { style: S.label }, bind(t, 'authFile')),
            h('input', {
              style: S.input,
              type: 'text',
              'aria-label': bind(t, 'authFile'),
              value: authFileDraft,
              placeholder: credential.file || '%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth',
              onChange: function (event) { setAuthFileDraft(event.target.value) },
            }),
            h('span', { style: S.hintTiny }, bind(t, 'authFileHint'))),
          h('div', { key: 'btns', style: S.row },
            h('button', { type: 'button', style: S.buttonPrimary, onClick: saveDesktop, disabled: isBusy('save') },
              isBusy('save') ? bind(t, 'saving') : bind(t, 'save'))),
        )
      }

      sections.push(
        h('div', { key: 'connection', style: S.section },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, bind(t, 'secConnection'))),
          ...connectionBody),
      )

      // ── 高级 ────────────────────────────────────────────────────
      //
      // 默认折叠：这些都是「装好就不用再碰」的参数，但必须给一个入口 ——
      // 旧版本把它们写死在代码里，用户遇到长回答被切断时只能改源码。
      var advErrors = advancedFieldErrors()
      var advErrorText = function (key) {
        var limit = ADVANCED_LIMITS[key]
        return bind(t, 'advancedInvalid', { min: limit.min, max: limit.max })
      }
      sections.push(
        h('div', { key: 'advanced', style: S.section },
          h('details', {},
            h('summary', {
              style: { cursor: 'pointer', fontSize: TEXT.tiny, fontWeight: 600, letterSpacing: '.08em', color: 'var(--dsw-alias-label-secondary)' },
            }, bind(t, 'advanced')),
            h('p', { style: Object.assign({}, S.hintTiny, { marginTop: 8 }) }, bind(t, 'advancedHint')),
            h('div', { key: 'idle', style: S.field },
              h('span', { style: S.label }, bind(t, 'advancedIdle')),
              h('input', {
                style: S.input,
                type: 'number',
                'aria-label': bind(t, 'advancedIdle'),
                'aria-invalid': advErrors.idle !== '' ? true : undefined,
                min: 15,
                max: 900,
                value: advIdle,
                onChange: function (event) { setAdvIdle(event.target.value) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'advancedIdleHint')),
              advErrors.idle !== ''
                ? h('span', { key: 'idle-err', role: 'alert', style: S.hintWarn }, advErrorText('idle'))
                : null),
            h('div', { key: 'intervals', style: S.row },
              h('div', { style: Object.assign({}, S.field, { flex: '1 1 140px' }) },
                h('span', { style: S.label }, bind(t, 'advancedCatalog')),
                h('input', {
                  style: S.input,
                  type: 'number',
                  'aria-label': bind(t, 'advancedCatalog'),
                  'aria-invalid': advErrors.catalog !== '' ? true : undefined,
                  min: 120,
                  max: 86400,
                  value: advCatalog,
                  onChange: function (event) { setAdvCatalog(event.target.value) },
                }),
                advErrors.catalog !== ''
                  ? h('span', { key: 'catalog-err', role: 'alert', style: S.hintWarn }, advErrorText('catalog'))
                  : null),
              h('div', { style: Object.assign({}, S.field, { flex: '1 1 140px' }) },
                h('span', { style: S.label }, bind(t, 'advancedCredits')),
                h('input', {
                  style: S.input,
                  type: 'number',
                  'aria-label': bind(t, 'advancedCredits'),
                  'aria-invalid': advErrors.credits !== '' ? true : undefined,
                  min: 30,
                  max: 21600,
                  value: advCredits,
                  onChange: function (event) { setAdvCredits(event.target.value) },
                }),
                advErrors.credits !== ''
                  ? h('span', { key: 'credits-err', role: 'alert', style: S.hintWarn }, advErrorText('credits'))
                  : null)),
            h('div', { key: 'thresholds', style: S.row },
              h('div', { style: Object.assign({}, S.field, { flex: '1 1 140px' }) },
                h('span', { style: S.label }, bind(t, 'advancedAlert')),
                h('input', {
                  style: S.input,
                  type: 'number',
                  'aria-label': bind(t, 'advancedAlert'),
                  'aria-invalid': advErrors.alert !== '' ? true : undefined,
                  min: 1,
                  max: 95,
                  value: advAlert,
                  onChange: function (event) { setAdvAlert(event.target.value) },
                }),
                h('span', { style: S.hintTiny }, bind(t, 'advancedAlertHint')),
                advErrors.alert !== ''
                  ? h('span', { key: 'alert-err', role: 'alert', style: S.hintWarn }, advErrorText('alert'))
                  : null),
              h('div', { style: Object.assign({}, S.field, { flex: '1 1 140px' }) },
                h('span', { style: S.label }, bind(t, 'advancedSwitch')),
                h('input', {
                  style: S.input,
                  type: 'number',
                  'aria-label': bind(t, 'advancedSwitch'),
                  'aria-invalid': advErrors.switchRatio !== '' ? true : undefined,
                  min: 0,
                  max: 50,
                  value: advSwitch,
                  onChange: function (event) { setAdvSwitch(event.target.value) },
                }),
                h('span', { style: S.hintTiny }, bind(t, 'advancedSwitchHint')),
                advErrors.switchRatio !== ''
                  ? h('span', { key: 'switch-err', role: 'alert', style: S.hintWarn }, advErrorText('switchRatio'))
                  : null)),
            h('div', { key: 'queue', style: S.field },
              h('span', { style: S.label }, bind(t, 'advancedQueue')),
              h('input', {
                style: S.input,
                type: 'number',
                'aria-label': bind(t, 'advancedQueue'),
                'aria-invalid': advErrors.queue !== '' ? true : undefined,
                min: 15,
                max: 180,
                value: advQueue,
                onChange: function (event) { setAdvQueue(event.target.value) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'advancedQueueHint')),
              advErrors.queue !== ''
                ? h('span', { key: 'queue-err', role: 'alert', style: S.hintWarn }, advErrorText('queue'))
                : null),
            h('label', { key: 'stats', style: Object.assign({}, S.row, { cursor: 'pointer' }) },
              h('input', {
                type: 'checkbox',
                checked: advStats !== false,
                onChange: function () { setAdvStats(!(advStats !== false)) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'advancedStats'))),
            h('label', { key: 'cache', style: Object.assign({}, S.row, { cursor: 'pointer' }) },
              h('input', {
                type: 'checkbox',
                checked: advCache !== false,
                onChange: function () { setAdvCache(!(advCache !== false)) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'advancedCache'))),
            h('label', { key: 'alerts', style: Object.assign({}, S.row, { cursor: 'pointer' }) },
              h('input', {
                type: 'checkbox',
                checked: advAlertsEnabled !== false,
                onChange: function () { setAdvAlertsEnabled(!(advAlertsEnabled !== false)) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'advancedAlertsEnabled'))),
            h('label', { key: 'probe', style: Object.assign({}, S.row, { cursor: 'pointer' }) },
              h('input', {
                type: 'checkbox',
                checked: advProbeEnabled !== false,
                onChange: function () { setAdvProbeEnabled(!(advProbeEnabled !== false)) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'advancedProbe'))),
            h('div', { key: 'btn', style: S.row },
              h('button', {
                type: 'button',
                style: S.button,
                // 有非法字段时直接禁用保存：宁可让用户先改对，也不要静默回退旧值。
                disabled: isBusy('advanced') || advancedSaveBlocked(),
                onClick: saveAdvanced,
              }, isBusy('advanced') ? bind(t, 'saving') : bind(t, 'advancedSave')),
              advSaved ? h('span', { style: S.hintTiny }, bind(t, 'advancedSaved')) : null,
              advNotice !== '' ? h('span', { role: 'status', style: S.hintWarn }, advNotice) : null)),
        ),
      )

      // ── 模型 ────────────────────────────────────────────────────
      var models = safeArray(active.models)
      // 可用列表**不再**包含 forced 的「账号不支持」模型：那个勾选框代表
      // 「启用/停用」，而 forced 是另一件事。把 forced 行放回下方折叠区，
      // 勾选态 = 是否强制显示，语义才一致（见 2.0.0 修复）。
      var available = models.filter(function (row) { return !row.unavailable })
      var unavailable = models.filter(function (row) { return row.unavailable })
      var probe = status.probe || {}
      var query = searchDraft.trim().toLowerCase()
      var matches = function (row) {
        if (query === '') return true
        // 坏缓存里 name/id 可能缺失或不是字符串；搜索框只有在模型多于 6 个时
        // 才出现，这里一抛异常整张卡片都会被宿主的错误边界替换掉。
        var name = typeof row.name === 'string' ? row.name : ''
        var id = typeof row.id === 'string' ? row.id : ''
        return name.toLowerCase().indexOf(query) !== -1 || id.toLowerCase().indexOf(query) !== -1
      }
      var shown = available.filter(matches)
      // 搜索词可能只命中「账号不支持」的模型：这时不能说「没有匹配」，否则和下方
      // 不可用列表自相矛盾。分开统计，给不同的空状态文案。
      var unavailableMatches = query === '' ? [] : unavailable.filter(matches)

      var modelMetaText = function (model) {
        var parts = [formatWindow(model.contextWindow)]
        parts.push(Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0
          ? model.reasoningEfforts.join('/')
          : bind(t, 'noReasoning'))
        if (model.supportsImages) parts.push(bind(t, 'imagesShort'))
        if (model.credits) parts.push(model.credits)
        return parts.join(' · ')
      }

      sections.push(
        h('div', { key: 'models', style: S.section },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, bind(t, 'models')),
            h('span', { style: S.sectionCount }, String(models.length)),
            h('span', { style: S.grow }),
            models.length === 0
              ? null
              : h('button', { type: 'button', style: S.buttonGhost, onClick: function () { setAllModels(active, false) }, disabled: isBusy('save') }, bind(t, 'showAll')),
            models.length === 0
              ? null
              : h('button', { type: 'button', style: S.buttonGhost, onClick: function () { setAllModels(active, true) }, disabled: isBusy('save') }, bind(t, 'hideAll'))),
          models.length > 6
            ? h('input', {
                style: S.input,
                type: 'search',
                'aria-label': bind(t, 'searchPlaceholder'),
                value: searchDraft,
                placeholder: bind(t, 'searchPlaceholder'),
                onChange: function (event) { setSearchDraft(event.target.value) },
              })
            : null,
          h('div', { key: 'probe', style: S.row },
            h('button', { type: 'button', style: S.button, onClick: runProbeNow, disabled: isBusy('probe') || models.length === 0 },
              isBusy('probe') ? bind(t, 'probing') : bind(t, 'probe')),
            h('span', { style: S.modelMeta },
              probe.lastRunAt > 0
                ? bind(t, 'probeLast', { time: formatTime(probe.lastRunAt) })
                : bind(t, 'probeNever'))),
          h('p', { key: 'probehint', style: S.hintTiny }, bind(t, 'probeHint')),
          models.length === 0
            ? h('p', { key: 'nomodels', style: S.hint }, bind(t, 'noModels'))
            : shown.length === 0
              ? (unavailableMatches.length > 0
                  ? h('p', { key: 'nomatch-unavailable', style: S.hintWarn }, bind(t, 'searchOnlyUnavailable', { count: unavailableMatches.length }))
                  : h('p', { key: 'nomatch', style: S.hint }, bind(t, 'searchEmpty')))
              : h('ul', { key: 'list', style: S.modelList },
                shown.map(function (model, index) {
                  return h('li', {
                    key: model.id,
                    style: Object.assign({}, S.modelRow, index > 0 ? S.modelRowDivider : {}),
                  },
                  h('input', {
                    type: 'checkbox',
                    // 勾选态要带上「还没落盘的本地改动」，否则连点时界面会闪回旧值。
                    checked: pendingModelToggles.current[active.provider + '::disabled'] !== undefined
                      && pendingModelToggles.current[active.provider + '::disabled'][model.id] !== undefined
                      ? !pendingModelToggles.current[active.provider + '::disabled'][model.id]
                      : !model.disabled,
                    'aria-label': model.name,
                    onChange: function () { toggleModel(active, model) },
                  }),
                  h('span', { style: S.modelName, title: model.name }, model.name),
                  h('span', { style: S.modelMeta }, modelMetaText(model)),
                  h('span', { style: S.grow }),
                  h('span', { style: S.modelId }, model.id))
                })),
          h('label', { key: 'rate', style: Object.assign({}, S.row, { cursor: 'pointer' }) },
            h('input', {
              type: 'checkbox',
              checked: status.settings && status.settings.showRateInModelName !== false,
              onChange: function () {
                mutate({ display: { showRateInModelName: !(status.settings && status.settings.showRateInModelName !== false) } })
              },
            }),
            h('span', { style: S.label }, bind(t, 'modelRateToggle'))),
          h('p', { key: 'ratehint', style: S.hintTiny }, bind(t, 'modelRateHint'))),
      )

      if (unavailable.length > 0) {
        sections.push(
          h('details', { key: 'unavail' },
            h('summary', { style: Object.assign({}, S.hintWarn, { cursor: 'pointer' }) },
              bind(t, 'unavailableCount', { count: unavailable.length })),
            h('p', { style: S.hintTiny }, bind(t, 'unavailableHint')),
            h('ul', { style: Object.assign({}, S.modelList, { marginTop: 6 }) },
              unavailable.map(function (model, index) {
                return h('li', {
                  key: model.id,
                  style: Object.assign({}, S.modelRow, index > 0 ? S.modelRowDivider : {}),
                },
                h('input', {
                  type: 'checkbox',
                  checked: model.forced === true,
                  'aria-label': model.name,
                  title: bind(t, 'forceShow'),
                  onChange: function () { toggleModel(active, model) },
                }),
                h('span', { style: S.modelMeta }, model.name),
                h('span', { style: S.badge }, bind(t, 'unavailable')),
                model.forced === true ? h('span', { style: S.badgeSoft }, bind(t, 'forced')) : null,
                h('span', { style: S.grow }),
                h('span', { style: S.modelId }, model.id))
              })),
          ),
        )
      }

      if (forcedCount(active) > 0) {
        sections.push(h('p', { key: 'forced', style: S.hintTiny }, bind(t, 'forced') + ': ' + forcedCount(active)))
      }

      // ── 最近事件 ────────────────────────────────────────────────
      //
      // 2.0.0：换号、令牌续期、目录/额度降级、签到与探测以前只进宿主日志。
      // 用户看到的是结果（「怎么换账号了」「额度怎么又读不到」），原因已经
      // 随着日志轮转消失。事件账本把这些元数据做成可筛选的时间线。
      //
      // 老宿主（status v7 之前）没有 `events`，整块直接不渲染。
      var eventDoc = status.events
      if (eventDoc !== null && typeof eventDoc === 'object' && Array.isArray(eventDoc.items)) {
        var allEvents = eventDoc.items.filter(function (event) {
          return event !== null && typeof event === 'object'
            && typeof event.at === 'number' && typeof event.type === 'string'
        })
        var eventFilters = [
          { id: 'all', label: 'eventAll', count: allEvents.length },
          { id: 'switch', label: 'eventSwitchFilter', count: allEvents.filter(function (event) { return event.type === 'account-switch' }).length },
          { id: 'problem', label: 'eventProblemFilter', count: allEvents.filter(function (event) { return event.level === 'warn' || event.level === 'error' }).length },
          { id: 'credential', label: 'eventCredentialFilter', count: allEvents.filter(function (event) { return event.type === 'credential' || event.type === 'credential-refresh' || event.type === 'login' }).length },
        ]
        var matchesEventFilter = function (event) {
          if (eventFilter === 'switch') return event.type === 'account-switch'
          if (eventFilter === 'problem') return event.level === 'warn' || event.level === 'error'
          if (eventFilter === 'credential') return event.type === 'credential' || event.type === 'credential-refresh' || event.type === 'login'
          return true
        }
        var filteredEvents = allEvents.filter(matchesEventFilter)
        // 展开即渲染全部筛选结果：宿主已把 items 截到 events.limit（默认 50），
        // 不再用 30 这种「看起来是全部、其实不是」的隐性上限。
        var visibleEvents = eventsExpanded === true ? filteredEvents : filteredEvents.slice(0, 6)
        var eventFilterButton = function (filter) {
          var selected = eventFilter === filter.id
          return h('button', {
            key: 'ef' + filter.id,
            type: 'button',
            'aria-pressed': selected,
            onClick: function () {
              setEventFilter(filter.id)
              setEventsExpanded(false)
            },
            style: {
              font: 'inherit',
              fontSize: TEXT.tiny,
              lineHeight: '16px',
              padding: '0 7px',
              borderRadius: 999,
              cursor: 'pointer',
              border: '0.5px solid ' + (selected
                ? 'var(--dsw-alias-state-business-primary, #2f6fed)'
                : 'var(--dsw-alias-border-l2)'),
              background: selected ? 'var(--dsh-rpc-fill, rgba(127,127,127,.10))' : 'transparent',
              color: selected ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
              whiteSpace: 'nowrap',
              flex: '0 0 auto',
            },
          }, bind(t, filter.label) + (filter.count > 0 ? ' ' + String(filter.count) : ''))
        }
        var eventRows = visibleEvents.map(function (event, index) {
          var typeLabel = bind(t, eventTextKey(event.type))
          var rawMessage = typeof event.message === 'string' ? event.message : ''
          var message = rawMessage === '' || rawMessage === event.type ? typeLabel : rawMessage
          var scope = typeof event.provider === 'string' ? shortProviderName(event.provider) : ''
          return h('li', {
            key: typeof event.id === 'string' ? event.id : 'ev' + String(index),
            style: Object.assign({}, S.modelRow, {
              flexWrap: 'wrap',
              alignItems: 'baseline',
              gap: 6,
            }, index > 0 ? S.modelRowDivider : {}),
          },
          h('span', { style: Object.assign({}, dot(eventColor(event.level)), { alignSelf: 'center' }) }),
          h('span', {
            style: Object.assign({}, S.modelMeta, { fontVariantNumeric: 'tabular-nums' }),
            title: formatTime(event.at),
          }, formatShortTime(event.at)),
          h('span', { style: S.badgeSoft }, typeLabel),
          scope === '' ? null : h('span', { style: S.modelId }, scope),
          h('span', {
            style: Object.assign({}, S.modelName, {
              flex: '1 1 200px',
              whiteSpace: 'normal',
              overflow: 'visible',
              textOverflow: 'clip',
            }),
            title: rawMessage,
          }, message))
        })
        var eventsFooter = filteredEvents.length > 6
          ? h('button', {
              key: 'more',
              type: 'button',
              style: S.buttonGhost,
              'aria-expanded': eventsExpanded === true,
              onClick: function () { setEventsExpanded(!eventsExpanded) },
            }, eventsExpanded === true
              ? bind(t, 'eventLess')
              : bind(t, 'eventMore', { count: filteredEvents.length }))
          : null
        sections.push(
          h('div', { key: 'events', style: S.section },
            h('div', { key: 'h', style: S.sectionHead },
              h('span', { style: S.sectionTitle }, bind(t, 'eventTitle')),
              h('span', { style: S.sectionCount }, String(allEvents.length)),
              h('span', { style: S.grow }),
              allEvents.length === 0
                ? null
                : h('button', {
                    type: 'button',
                    style: S.buttonGhost,
                    disabled: isBusy('events'),
                    onClick: clearEvents,
                  }, bind(t, 'eventClear'))),
            h('p', { key: 'hint', style: S.hintTiny }, bind(t, 'eventHint')),
            // count 是历史总数、items 是宿主真实保留的条数：两者不同时明确告诉用户，
            // 避免「标题写 63、列表只有 50」看起来像丢事件。
            typeof eventDoc.count === 'number' && eventDoc.count > allEvents.length
              ? h('p', { key: 'retained', style: S.hintTiny }, bind(t, 'eventRetained', { count: allEvents.length }))
              : null,
            h('div', { key: 'filters', style: Object.assign({}, S.row, { flexWrap: 'wrap' }) }, eventFilters.map(eventFilterButton)),
            allEvents.length === 0
              ? h('p', { key: 'empty', style: S.hint }, bind(t, 'eventEmpty'))
              : filteredEvents.length === 0
                ? h('p', { key: 'nomatch', style: S.hint }, bind(t, 'eventNoMatch'))
                : h('ul', { key: 'list', style: S.modelList }, eventRows),
            eventsFooter),
        )
      }

      // ── 诊断 ────────────────────────────────────────────────────
      sections.push(
        h('div', { key: 'diag', style: S.section },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, bind(t, 'diagnostics')),
            h('span', { style: S.grow }),
            h('button', { type: 'button', style: S.buttonGhost, 'aria-expanded': showDiag, 'aria-controls': showDiag ? 'dsh-reverse-proxy-diagnostics' : undefined, onClick: function () { setShowDiag(!showDiag) } },
              showDiag ? bind(t, 'hide') : bind(t, 'show')),
            h('button', {
              type: 'button',
              style: Object.assign({}, S.buttonGhost, copyFailed ? { color: 'var(--dsw-alias-state-error-primary)' } : {}),
              title: copyFailed ? bind(t, 'copyFallbackHint') : undefined,
              onClick: copyDiagnostics,
            },
              copied ? bind(t, 'copied') : copyFailed ? bind(t, 'copyFailed') : bind(t, 'copyDiagnostics'))),
          copyFallback !== ''
            ? h('div', { key: 'copy-fallback', role: 'status', style: S.field },
                h('span', { style: S.hintTiny }, bind(t, 'copyFallbackHint')),
                h('textarea', {
                  style: Object.assign({}, S.pre, { width: '100%', boxSizing: 'border-box', minHeight: 72, resize: 'vertical' }),
                  readOnly: true,
                  value: copyFallback,
                  onFocus: function (event) {
                    if (event !== undefined && event.target !== undefined && typeof event.target.select === 'function') event.target.select()
                  },
                }))
            : null,
          showDiag ? h('pre', { key: 'pre', id: 'dsh-reverse-proxy-diagnostics', style: S.pre }, diagnosticsJson) : null),
      )

      return h('div', { style: S.card }, sections)
    }


    /**
     * 共享的《插件设置》区块的容器。三个 connect 类插件共用同一套 id：
     * 第一个到的注册容器（并声明子槽位），后到的检测到就挂自己的条目。
     */
    function PluginSettingsSection(props) {
      return h(
        'ul',
        { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 0, margin: 0, listStyle: 'none' } },
        props.renderSlot(SHARED_ITEM_SLOT, {}),
      )
    }

    function apply(ctx) {
      ensureThemeStyles()
      var NS = 'settings.reverse-proxy'
      try {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en })
        }, 'dsh-reverse-proxy-connect: 文案')
      } catch (failure) {
        console.error('[dsh-reverse-proxy-connect] locale.register 失败', failure)
      }
      var t = ctx.locale.bind(NS)

      var joinSharedSettings = function () {
        ctx.slots.inject(SHARED_SECTION_SLOT, function () {
          var disposeContainer
          var existing = ctx.slots.entries(SHARED_SECTION_SLOT).some(function (entry) {
            return entry.options && entry.options.id === SHARED_SECTION_ID
          })
          if (!existing) {
            try {
              disposeContainer = ctx.slots.register(
                {
                  name: SHARED_SECTION_SLOT,
                  id: SHARED_SECTION_ID,
                  order: SHARED_SECTION_ORDER,
                  label: function () { return t('nav') },
                  children: (function () {
                    var children = {}
                    children[SHARED_ITEM_SLOT] = { kind: 'list', scope: 'root' }
                    return children
                  })(),
                },
                PluginSettingsSection,
              )
            } catch (failure) {
              console.error('[dsh-reverse-proxy-connect] 共享设置区块竞争失败，挂到已存在的那一个上', failure)
            }
          }
          var disposeItem = ctx.slots.register(
            {
              name: SHARED_ITEM_SLOT,
              id: SHARED_ITEM_ID,
              order: 30,
              inject: function () { return { t: t } },
            },
            ConnectorCard,
          )
          return function () {
            disposeItem()
            if (disposeContainer) disposeContainer()
          }
        })
      }

      var attachToPluginPanel = function () {
        ctx.slots.inject(PLUGIN_MANAGER_SLOT, function () {
          return ctx.slots.register(
            {
              name: PLUGIN_MANAGER_SLOT,
              key: PLUGIN_MANAGER_KEY,
              inject: function () { return { t: t } },
            },
            ConnectorCard,
          )
        })
      }

      /**
       * 侧栏积分小卡 + 内嵌面板。
       *
       * 为什么不用悬浮气泡：气泡在 `shell.overlay` 里，宽度只能靠「量侧栏」估算，
       * 侧栏一窄就压到对话区（0.4.6 就是这么翻车的）。而 `sidebar.footer.action`
       * 的容器本身就是侧栏底部的纵向 flex（`flex:none` + `width:100%`），
       * 把面板直接放进去，宽度天然等于侧栏 —— 结构上就不可能横向溢出。
       *
       * 交互：点胶囊展开／收起；面板占满侧栏宽度并向上生长（把会话列表往上挤，
       * 而不是盖住它）；点面板外面或按 Esc 收起。
       */
      var CreditsPill = function (props) {
        var useState = React.useState
        var useEffect = React.useEffect
        var useRef = React.useRef

        var statusState = useState(undefined)
        var status = statusState[0]
        var setStatus = statusState[1]
        // 与卡片同名：写入点统一走这里（侧栏没有竞态，只起可读性作用）。
        var applyStatus = function (document) { setStatus(document) }
        var busyState = useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]
        var failedState = useState(false)
        var failed = failedState[0]
        var setFailed = failedState[1]
        var expandedState = useState(false)
        var expanded = expandedState[0]
        var setExpanded = expandedState[1]
        // 悬停态：宿主里可点的行（会话、账号）悬停都会浮一层底色，
        // 胶囊也得跟上，否则用户根本看不出它能点。
        var hoverState = useState(false)
        var hovered = hoverState[0]
        var setHovered = hoverState[1]
        var rootRef = useRef(undefined)
        // 失败提示的 5s 自动清除用序号防竞态：成功刷新要立刻清掉失败态，
        // 旧定时器也不能清掉之后新产生的失败。
        var failedSeq = useRef(0)

        useEffect(function () {
          var disposed = false
          var handles = []
          var interval
          var loading = false
          var lastAt = 0

          /** 这份状态里有没有可用的额度数字。 */
          var hasCredits = function (document) {
            var list = safeArray(document && document.providers)
            for (var index = 0; index < list.length; index++) {
              var snapshot = list[index].credits
              if (snapshot !== undefined && snapshot !== null && snapshot.state === 'ok') return true
            }
            return false
          }

          var load = function () {
            // 与卡片同一类保护：冷启动重试、定时轮询与「回到前台」可能
            // 同时触发，不能让两个 /status?light=1 互相覆盖。
            if (loading || disposed) return
            loading = true
            fetchStatus(true)
              .then(function (document) {
                loading = false
                if (disposed) return
                lastAt = Date.now()
                applyStatus(document)
                if (hasCredits(document)) settle()
              }, function () {
                loading = false
                /* 侧栏小卡不该弹错误；读不到就保持原样 */
              })
          }

          /** 进入常态轮询（只进一次）。 */
          var settle = function () {
            if (interval !== undefined || disposed) return
            interval = setInterval(function () {
              if (disposed) return
              // 后台标签页不轮询；回到前台时由 visibilitychange 补一次。
              if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
              load()
            }, 120000)
            handles.push(interval)
          }

          // 冷启动时宿主可能还没抓完额度（凭证解密 + 上游请求几秒）。
          var retries = [0, 600, 1400, 2600, 4200, 7000, 10000].map(function (delay) {
            return setTimeout(function () {
              if (!disposed && interval === undefined) load()
            }, delay)
          })
          handles = handles.concat(retries)
          handles.push(setTimeout(settle, 12000))

          var onVisibility = function () {
            if (disposed) return
            if (typeof document === 'undefined' || document.visibilityState === 'hidden') return
            if (Date.now() - lastAt >= 30000) load()
          }
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisibility)
          }

          return function () {
            disposed = true
            if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
              document.removeEventListener('visibilitychange', onVisibility)
            }
            handles.forEach(function (handle) {
              clearTimeout(handle)
              clearInterval(handle)
            })
          }
        }, [])

        // 展开时：点面板外面或按 Esc 收起。
        useEffect(function () {
          if (expanded !== true) return undefined
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          var onPointerDown = function (event) {
            var root = rootRef.current
            if (root !== undefined && root !== null && typeof root.contains === 'function' && event.target !== null && root.contains(event.target)) return
            setExpanded(false)
          }
          var onKeyDown = function (event) {
            if (event !== undefined && event.key === 'Escape') setExpanded(false)
          }
          document.addEventListener('mousedown', onPointerDown)
          document.addEventListener('keydown', onKeyDown)
          return function () {
            document.removeEventListener('mousedown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [expanded])

        var refresh = function (event) {
          if (event !== undefined && event.preventDefault !== undefined) event.preventDefault()
          if (status === undefined || busy === true) return
          setBusy(true)
          setFailed(false)
          postJson(ACTION_PATH, { action: 'credits' }, status.key)
            .then(function (document) {
              applyStatus(document)
              setBusy(false)
              // 失败后 5 秒内又刷新成功：必须立刻清掉失败提示，否则旧定时器
              // 未到点前界面仍挂着「刷新失败」，看起来像失败但其实成功。
              failedSeq.current += 1
              setFailed(false)
            })
            .catch(function (failure) {
              setBusy(false)
              // 刷新失败不能只靠 1.6 秒描边变色：面板底部给一条 5 秒的
              // role=status 文案（原因放 title），色盲/读屏用户也能感知。
              var seq = failedSeq.current + 1
              failedSeq.current = seq
              setFailed(String(failure && failure.message ? failure.message : failure))
              setTimeout(function () {
                if (failedSeq.current === seq) setFailed(false)
              }, 5000)
            })
        }

        var providers = safeArray(status && status.providers)
        var sidebarAlertSettings = (status && status.settings && status.settings.alerts) || {}
        var sidebarAlertRatio = typeof sidebarAlertSettings.lowRatio === 'number' ? sidebarAlertSettings.lowRatio : LOW_CREDITS_RATIO
        var sidebarAlertsEnabled = sidebarAlertSettings.enabled !== false
        var sidebarShowUsage = !(status && status.settings && status.settings.showUsageInSidebar === false)
        var rows = []
        for (var index = 0; index < providers.length; index++) {
          var entry = providers[index]
          if (entry.enabled === false) continue
          var credits = entry.credits
          if (credits === undefined || credits === null || credits.state !== 'ok') continue
          rows.push({ entry: entry, credits: credits })
        }
        if (rows.length === 0) {
          // 已经拿到状态、但没有任何可显示额度时，仍然留一个极淡的入口：
          // 完全消失会让用户以为插件没装，反而更困惑。
          if (providers.length === 0) return null
          // 末尾那句要说清楚「为什么没有数字」：一个 provider 都没有额度端点
          // 时说「未读取」，全都读失败时说「读取失败」——两者不是同一件事。
          var emptyLabel = providers.every(function (item) {
            return item.credits !== undefined && item.credits !== null && item.credits.state === 'error'
          })
            ? bind(t, 'creditsUnreadable')
            : bind(t, 'creditsNone')
          return h(
            'div',
            { style: { display: 'flex', width: '100%', minWidth: 0, boxSizing: 'border-box', margin: '0 0 4px' } },
            h(
              'button',
              {
                type: 'button',
                onClick: refresh,
                style: {
                  font: 'inherit',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '4px 11px',
                  lineHeight: '18px',
                  cursor: 'pointer',
                  borderRadius: 999,
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: 12,
                },
              },
              h('span', {}, bind(t, 'summary') + ' —'),
              h('span', {}, emptyLabel),
            ),
          )
        }

        var wide = props.wide !== false

        var toggle = function (event) {
          if (event !== undefined && event.preventDefault !== undefined) event.preventDefault()
          // 收起成 56px 轨道时没有横向空间，点一下只刷新。
          if (!wide) {
            refresh(event)
            return
          }
          var next = !expanded
          setExpanded(next)
          // 展开时如果还是缓存数据，顺手拉一次；面板会立刻显示「刷新中」。
          if (next && busy !== true && rows.some(function (row) { return row.credits.stale === true })) {
            setTimeout(function () { refresh() }, 0)
          }
        }

        // 一行放不下就换行，宽度不够就降成一列。
        //
        // 六家 provider 之后，`WB 775 | WBAI 57 | QDG 0 | TRAE 197` 在窄侧栏里
        // 会直接把最后一个数字挤成半个（截图里就是「197」被裁掉一截）。原来的
        // 做法是 `nowrap` + `overflow:hidden`：内容不换行、超出的部分静默剪掉，
        // 用户看到的是一个残缺的数字，比看不到更糟。
        //
        // 现在的规则：
        // - 够宽 → 两列；
        // - 不够宽 → 自动降成一列，每个 provider 独占一行、完整显示；
        // - 无论几列，所有格都**左对齐**（左列 `flex-start`、右列 `flex-end`
        //   会让右列像浮在半空，两列起点对不齐）。
        var visibleRows = wide ? rows : rows.slice(0, 1)
        var segmentNodes = visibleRows.map(function (row, position) {
          var snapshot = row.credits
          var accent = PROVIDER_ACCENT[row.entry.provider] || 'currentColor'
          var warn = creditsWarning(snapshot, row.entry.provider, sidebarAlertRatio, sidebarAlertsEnabled)
          var stale = snapshot.stale === true
          // Qoder Free：窄胶囊里显示短版「免费」，完整额度仍在 title / aria-label 里。
          var freePlan = isQoderFreePlan(row.entry.provider, snapshot)
          var dotColor = warn ? 'var(--dsh-rpc-warn, #9d5c00)' : accent
          var label = row.entry.displayName + ' ' + formatCreditsText(snapshot, t) + (stale ? ' · ' + bind(t, 'creditsCached') : '')
          return h(
            'span',
            {
              key: row.entry.provider,
              title: label,
              style: {
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: 4,
                minWidth: 0,
                // 两列**都左对齐**。
                //
                // 之前左列 `flex-start`、右列 `flex-end`：左列从固定位置起排，
                // 右列却贴着右边缘排。两列的起点不一致，右列看起来就像「浮在
                // 半空」—— 尤其是名字长度不同时（WBAI / TRAE）参差不齐。
                // 统一左对齐后，每列的「圆点 + 名字 + 数字」都从同一条竖线起排，
                // 两行扫下来是齐的。
                justifyContent: 'flex-start',
                // 不写 gridColumn / gridRow：`auto-fit` 只对**自动放置**生效，
                // 显式定位会让它退化回固定两列，窄侧栏里就又开始挤压。
                // 分隔线也一并去掉：自动排布时无法预先知道哪一格会落到行首，
                // 猜错就会出现「行首凭空多一条竖线」。用列间距区分两列已经够了。
              },
            },
            position === 0 || wide
              ? h('span', {
                  style: Object.assign({
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    alignSelf: 'center',
                    background: dotColor,
                    opacity: 0.9,
                    flex: '0 0 auto',
                  }, stale
                    ? { background: 'transparent', boxShadow: 'inset 0 0 0 1.5px ' + dotColor }
                    : {}),
                })
              : null,
            // 名字可以被压缩（省略号），数字**永远不缩**。
            //
            // 反过来试过：让数字省略，结果 `197.1` 变成 `19…` —— 那看起来
            // 就像另一个数字，比「名字短一截」误导得多。额度是这个胶囊唯一
            // 要传达的信息，宁可牺牲标签。
            h('span', {
              style: {
                fontSize: 10.5,
                letterSpacing: '.02em',
                opacity: stale ? 0.8 : 1,
                minWidth: 0,
                flex: '0 1 auto',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            }, shortProviderName(row.entry.provider)),
            h(
              'span',
              {
                style: {
                  fontWeight: 650,
                  fontSize: 13,
                  fontVariantNumeric: 'tabular-nums',
                  color: warn
                    ? 'var(--dsh-rpc-warn, #9d5c00)'
                    : 'var(--dsw-alias-label-primary, inherit)',
                  opacity: stale ? 0.65 : 1,
                  flex: '0 0 auto',
                  whiteSpace: 'nowrap',
                },
              },
              snapshot.unlimited === true ? '∞' : freePlan ? bind(t, 'creditsFreeShort') : compactNumber(snapshot.remain),
            ),
          )
        })

        // 展开指示箭头：常显，悬停时更明显 —— 这是「能点」最直接的暗示。
        //
        // 用内联 SVG 而不是 `▾` 字符：9px 的字形在侧栏里几乎看不见，
        // 而且不同字体的三角形状差别很大。SVG 用描边画折线，尺寸和粗细都可控。
        var caret = wide
          ? h('svg', {
              key: 'caret',
              width: 14,
              height: 14,
              viewBox: '0 0 14 14',
              fill: 'none',
              'aria-hidden': 'true',
              focusable: 'false',
              style: {
                flex: '0 0 auto',
                opacity: hovered || expanded === true ? 0.9 : 0.5,
                transform: expanded === true ? 'rotate(180deg)' : 'none',
                transition: 'transform .15s ease, opacity .12s ease',
              },
            },
            h('path', {
              d: 'M3.5 5.5 L7 9 L10.5 5.5',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }))
          : null

        var pill = h(
          'button',
          {
            type: 'button',
            onClick: toggle,
            onMouseEnter: function () { setHovered(true) },
            onMouseLeave: function () { setHovered(false) },
            onFocus: function () { setHovered(true) },
            onBlur: function () { setHovered(false) },
            'aria-expanded': expanded === true,
            // 面板只在展开（且宽侧栏）时才渲染；折叠态不要留下悬空引用。
            'aria-controls': expanded === true && wide ? PANEL_ID : undefined,
            'aria-label': rows
              .map(function (row) {
                return row.entry.displayName + ' ' + formatCreditsText(row.credits, t)
              })
              .join(bind(t, 'listSeparator')),
            style: {
              font: 'inherit',
              display: 'flex',
              alignItems: 'center',
              // 满宽：把侧栏底部这块横向用满，和展开后的面板对齐。
              // 收起时也走外层容器（见下方 return），否则按钮会缩成内容宽度。
              width: wide ? '100%' : 'auto',
              justifyContent: wide ? 'space-between' : 'center',
              gap: wide ? 6 : 10,
              boxSizing: 'border-box',
              maxWidth: '100%',
              minWidth: 0,
              padding: wide ? '4px 10px' : '4px 7px',
              lineHeight: '18px',
              cursor: 'pointer',
              // 六家之后可能折成两行，圆角改成「大一点但不是胶囊」：
              // 999px 在单行时是胶囊，两行时会变成半个椭圆，看起来像渲染坏了。
              borderRadius: wide ? 14 : 999,
              border: '0.5px solid ' + (
                failed
                  ? 'var(--dsw-alias-state-error-primary, #b3261e)'
                  : expanded === true || hovered
                    ? 'var(--dsw-alias-border-l3, var(--dsw-alias-border-l2))'
                    : 'var(--dsw-alias-border-l2)'
              ),
              background: expanded === true
                ? 'var(--dsh-rpc-fill, rgba(127,127,127,.10))'
                : hovered
                  ? 'var(--dsh-rpc-fill, rgba(127,127,127,.08))'
                  : 'var(--dsw-alias-bg-layer-1, transparent)',
              boxShadow: hovered && expanded !== true ? '0 1px 4px rgba(0,0,0,.08)' : 'none',
              color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-secondary))',
              transition: 'background .12s ease, border-color .12s ease, box-shadow .12s ease',
              opacity: busy ? 0.72 : 1,
              // 这里**不能**再 `overflow:hidden` + `nowrap`：那会把放不下的
              // provider 静默剪掉，用户看到的是一个残缺的数字（比看不到更糟）。
              overflow: 'visible',
              whiteSpace: 'normal',
            },
          },
          // 数字区：**自适应列数**的栅格。
          //
          // `auto-fit` + `minmax(96px, 1fr)`：宽度够就两列，不够自动降到一列，
          // 每个 provider 独占一行、都能完整显示。
          //
          // 96px 是实测出来的，不是估的：236px 的侧栏减去内边距与箭头后，
          // 栅格可用宽度约 200px。阈值 ≤96px 时 2×96+8=200 恰好放得下（两列），
          // ≥100px 就直接降成一列。取 96 能在常规侧栏里保住两列。
          //
          // 为什么不用固定两列：侧栏可以被拖到 180px 出头。固定两列时每列只剩
          // 80px，「TRAE 197.1」根本放不下 —— 要么数字被切成「197.」，
          // 要么名字被省略成「T…」，两种都像数据错了。
          //
          // 也不能用 `1fr auto`：`auto` 会按内容最大宽度撑开轨道，等于换个
          // 方式溢出。
          h(
            'span',
            {
              style: {
                display: 'grid',
                gridTemplateColumns: wide ? 'repeat(auto-fit, minmax(88px, 1fr))' : 'minmax(0, 1fr)',
                alignItems: 'baseline',
                columnGap: 8,
                rowGap: 1,
                flex: '1 1 auto',
                minWidth: 0,
              },
            },
            segmentNodes,
          ),
          caret,
        )

        // 收起时也套一层满宽容器：直接在 `footerActions`（横向 flex）里返回按钮，
        // 按钮会缩成内容宽度，看起来就比展开时窄一截。
        var latestFetched = 0
        var anyStale = false
        rows.forEach(function (row) {
          if (typeof row.credits.fetchedAt === 'number' && row.credits.fetchedAt > latestFetched) latestFetched = row.credits.fetchedAt
          if (row.credits.stale === true) anyStale = true
        })

        var panel = (expanded !== true || !wide) ? null : h(
          'div',
          {
            id: PANEL_ID,
            role: 'region',
            'aria-label': bind(t, 'credits'),
            style: {
              // 宽度 100% 是重点：容器就是侧栏底部那一列，永远不会横向溢出。
              width: '100%',
              boxSizing: 'border-box',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              borderRadius: 10,
              padding: '10px 12px 9px',
              background: 'var(--dsw-alias-bg-layer-1, transparent)',
              boxShadow: '0 8px 24px rgba(0,0,0,.10)',
              maxHeight: '48vh',
              overflowY: 'auto',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 13,
              lineHeight: '20px',
            },
          },
          // 头部：标题 + provider 数量 + 最近更新时间。
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 6, borderBottom: '0.5px solid var(--dsw-alias-border-l2)' } },
            h('span', { style: { fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', color: 'var(--dsw-alias-label-secondary)' } }, bind(t, 'credits')),
            h('span', { style: microChip() }, bind(t, 'creditsSources', { count: rows.length })),
            h('span', { style: { flex: 1 } }),
            latestFetched > 0
              ? h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, bind(t, 'creditsFetchedAt', { time: formatShortTime(latestFetched) }))
              : null,
          ),
          rows.map(function (row, index) {
            var snapshot = row.credits
            var warn = creditsWarning(snapshot, row.entry.provider, sidebarAlertRatio, sidebarAlertsEnabled)
            var alert = alertOfCredits(snapshot, sidebarAlertRatio, row.entry.provider, sidebarAlertsEnabled)
            var qoderFree = isQoderFreePlan(row.entry.provider, snapshot)
            var exhausted = snapshot.state === 'ok' && (snapshot.exceeded === true || (typeof snapshot.remain === 'number' && snapshot.remain <= 0))
            var accent = PROVIDER_ACCENT[row.entry.provider] || 'currentColor'
            var percent = creditsPercentOf(snapshot)
            var parts = creditsValueParts(snapshot, t)
            var ratio
            if (snapshot.unlimited !== true && Number.isFinite(snapshot.total) && snapshot.total > 0 && Number.isFinite(snapshot.remain)) {
              ratio = Math.max(0, Math.min(1, snapshot.remain / snapshot.total))
            }
            var todayUsage = row.entry.usage && row.entry.usage.today
            var activeAccount = safeArray(row.entry.accounts).filter(function (account) { return account.active === true })[0]
            // 小面板只显示「未登录 / 读取失败」两个词；完整原因放 title，卡片里仍然是全文。
            var credential = row.entry.credential || {}
            var authProblem = credential.status !== undefined && credential.status !== 'signed-in'
            var problem = authProblem
              ? bind(t, 'creditsNeedLogin')
              : typeof snapshot.error === 'string' ? bind(t, 'creditsUnreadable') : undefined
            var problemDetail = authProblem && typeof credential.message === 'string'
              ? credential.message
              : typeof snapshot.error === 'string' ? snapshot.error : ''
            var meta = []
            if (problem !== undefined) meta.push(h('span', { key: 'problem', style: microChip('var(--dsh-rpc-warn, #9d5c00)'), title: problemDetail }, problem))
            if (snapshot.planName !== undefined && snapshot.planName !== '') meta.push(h('span', { key: 'plan', style: microChip() }, snapshot.planName))
            if (percent !== undefined) meta.push(h('span', { key: 'pct', style: microChip(warn ? 'var(--dsh-rpc-warn, #9d5c00)' : accent) }, bind(t, 'creditsPercent', { percent: percent })))
            if (activeAccount !== undefined && problem === undefined) meta.push(h('span', { key: 'acc', style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', maxWidth: 108, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bind(t, 'creditsCurrent', { label: activeAccount.label })))
            if (snapshot.resetAtMs > 0) meta.push(h('span', { key: 'reset', style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, bind(t, 'creditsResetShort', { date: formatShortDate(snapshot.resetAtMs) })))
            if (sidebarShowUsage && todayUsage !== undefined && todayUsage.requests > 0) meta.push(h('span', { key: 'today', style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, bind(t, 'creditsToday', { count: todayUsage.requests, tokens: formatNumber(todayUsage.totalTokens || 0) })))
            if (snapshot.stale === true) meta.push(h('span', { key: 'cached', style: microChip() }, bind(t, 'creditsCached')))
            var trend = snapshot.trend
            var hasTrend = trend !== null && typeof trend === 'object' && trend.sampleCount > 0
            var trendLine = hasTrend
              ? h('div', { key: 'trend', style: { display: 'flex', alignItems: 'center', gap: 7, marginTop: 5, minWidth: 0 } },
                  h('span', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, bind(t, 'trendToday', { value: formatNumber(trend.spentToday || 0) })),
                  typeof trend.etaMs === 'number' && trend.etaMs > 0
                    ? h('span', { style: { fontSize: 10.5, color: warn ? 'var(--dsh-rpc-warn, #9d5c00)' : 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, bind(t, 'trendEta', { duration: formatCompactDuration(trend.etaMs) }))
                    : null,
                  h('span', { style: { flex: '1 1 40px', minWidth: 24, display: 'flex', alignItems: 'center' } },
                    sparkline(trend.points, warn ? 'var(--dsh-rpc-warn, #9d5c00)' : accent)))
              : null
            return h(
              'div',
              {
                key: row.entry.provider,
                style: {
                  padding: '9px 0',
                  borderTop: index > 0 ? '0.5px solid var(--dsw-alias-border-l2)' : 'none',
                  opacity: problem !== undefined ? 0.7 : snapshot.stale === true ? 0.82 : 1,
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                h('span', {
                  style: Object.assign({
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    flex: '0 0 auto',
                    background: warn ? 'var(--dsh-rpc-warn, #9d5c00)' : accent,
                  }, snapshot.stale === true
                    ? { background: 'transparent', boxShadow: 'inset 0 0 0 1.5px ' + (warn ? 'var(--dsh-rpc-warn, #9d5c00)' : accent) }
                    : {}),
                }),
                h('span', { style: { fontSize: 12, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.entry.displayName),
                exhausted ? h('span', { style: microChip('var(--dsh-rpc-warn, #9d5c00)') }, bind(t, qoderFree ? 'creditsFreeQueue' : 'creditsExhausted')) : null,
                alert === 'low' ? h('span', { style: microChip('var(--dsh-rpc-warn, #9d5c00)') }, bind(t, 'alertLow')) : null,
                h('span', { style: { flex: 1, minWidth: 4 } }),
                h(
                  'span',
                  {
                    title: formatCreditsText(snapshot, t),
                    style: { display: 'inline-flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap', flex: '0 0 auto' },
                  },
                  h('span', { style: { fontSize: 19, lineHeight: '22px', fontWeight: 650, fontVariantNumeric: 'tabular-nums', color: warn ? 'var(--dsh-rpc-warn, #9d5c00)' : 'var(--dsw-alias-label-primary)' } }, parts.big),
                  parts.small !== '' ? h('span', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' } }, parts.small) : null,
                  parts.unit !== '' ? h('span', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' } }, parts.unit) : null,
                ),
              ),
              ratio === undefined
                ? null
                : h(
                    'div',
                    { style: { marginTop: 6, height: 4, borderRadius: 999, background: 'var(--dsh-rpc-fill, rgba(127,127,127,.16))', overflow: 'hidden' } },
                    h('div', {
                      style: {
                        width: Math.round(ratio * 100) + '%',
                        height: '100%',
                        borderRadius: 999,
                        background: warn ? 'var(--dsh-rpc-warn, #9d5c00)' : accent,
                        opacity: 0.9,
                        transition: 'width .3s ease',
                      },
                    }),
                  ),
              meta.length === 0
                ? null
                : h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5, marginTop: 5 } }, ...meta),
              trendLine,
            )
          }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, borderTop: '0.5px solid var(--dsw-alias-border-l2)', paddingTop: 7, marginTop: 2 } },
            h('span', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              anyStale ? bind(t, 'creditsCachedHint') : bind(t, 'pillHint')),
            h('span', { style: { flex: 1 } }),
            failed
              ? h('span', { key: 'refresh-failed', role: 'status', title: String(failed), style: S.hintWarn }, bind(t, 'refreshFailed'))
              : null,
            h('button', {
              type: 'button',
              onClick: refresh,
              disabled: busy === true,
              style: {
                font: 'inherit',
                fontSize: 11,
                padding: '2px 9px',
                borderRadius: 999,
                cursor: 'pointer',
                border: '0.5px solid var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                whiteSpace: 'nowrap',
                flex: '0 0 auto',
              },
            }, busy ? bind(t, 'refreshing') : bind(t, 'creditsRefresh')),
          ),
        )

        return h(
          'div',
          {
            ref: rootRef,
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              width: '100%',
              minWidth: 0,
              boxSizing: 'border-box',
              margin: '0 0 4px',
            },
          },
          panel,
          pill,
        )
      }

      var attachSidebarPill = function () {
        ctx.slots.inject(SIDEBAR_FOOTER_SLOT, function () {
          return ctx.slots.register(
            {
              name: SIDEBAR_FOOTER_SLOT,
              id: 'reverse-proxy-credits',
              order: 10,
              inject: function () { return { t: t } },
            },
            CreditsPill,
          )
        })
      }

      try {
        joinSharedSettings()
      } catch (failure) {
        console.error('[dsh-reverse-proxy-connect] 挂载设置卡片失败', failure)
      }
      try {
        attachToPluginPanel()
      } catch (failure) {
        console.error('[dsh-reverse-proxy-connect] 挂载插件面板卡片失败', failure)
      }
      try {
        attachSidebarPill()
      } catch (failure) {
        console.error('[dsh-reverse-proxy-connect] 挂载侧栏积分卡失败', failure)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

