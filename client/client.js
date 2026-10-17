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

    var SHARED_SECTION_SLOT = 'settings.section'
    var SHARED_SECTION_ID = 'plugin-settings'
    var SHARED_SECTION_ORDER = 900
    var SHARED_SECTION_LABEL = '插件设置'
    var SHARED_ITEM_SLOT = 'plugin-settings.item'
    var SHARED_ITEM_ID = 'dsh-reverse-proxy-connect'
    var PLUGIN_MANAGER_SLOT = 'plugins.bundle.config'
    var PLUGIN_MANAGER_KEY = 'dsh-reverse-proxy-connect'

    var inject = ['slots', 'locale']

    var POLL_MS = 20000

    /** 侧栏底部那一排（宿主 `dsh-client-ui-sidebar` 声明）。 */
    var SIDEBAR_FOOTER_SLOT = 'sidebar.footer.action'

    /** 内嵌面板的 id（给 aria-controls 用）。 */
    var PANEL_ID = 'dsh-reverse-proxy-connect-credits-panel'

    // ── 文案 ────────────────────────────────────────────────────────
    var zh = {
      nav: '反代连接器',
      title: '反代连接器',
      intro: '把 WorkBuddy（国内版 / 国际版）与 Qoder（全球版 / 国内版）账号里的模型接进 DSH。',
      service: '服务',
      refresh: '刷新',
      refreshing: '刷新中…',
      enabled: '接入',
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
      maxContext: '使用上游声明的最大上下文窗口',
      diagnostics: '诊断',
      copyDiagnostics: '复制诊断',
      copied: '已复制',
      kindDesktop: '读取桌面端登录',
      kindPat: '使用个人访问令牌',
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
      creditsPackages: '{count} 个套餐包',
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
      advancedSave: '保存高级设置',
      advancedSaved: '已保存',
      imagesOn: '图片输入已启用',
      imagesOff: '宿主未提供附件服务，图片输入不可用',
      catalogDisk: '已缓存（启动时恢复）',
      patOpen: '打开 PAT 页面',
      patLinkHint: '还没有令牌？',
      usageInSidebar: '侧栏显示今日用量',
      summaryProviders: '四个 provider',
      accountSourceBrowser: '浏览器登录',
      accountSourceDesktop: '桌面登录',
      accountSourcePat: 'PAT',
      lastErrorAt: '最近失败 {time}',
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
    }
    var en = {
      nav: 'Reverse proxy',
      title: 'Reverse proxy connector',
      intro: 'Bring WorkBuddy (CN / international) and Qoder (global / CN) account models into DSH.',
      service: 'Service',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      enabled: 'Enabled',
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
      maxContext: 'Use the upstream maximum context window',
      diagnostics: 'Diagnostics',
      copyDiagnostics: 'Copy diagnostics',
      copied: 'Copied',
      kindDesktop: 'Reads the desktop sign-in',
      kindPat: 'Uses a personal access token',
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
      creditsPackages: '{count} packages',
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
      advancedSave: 'Save advanced settings',
      advancedSaved: 'Saved',
      imagesOn: 'Image input enabled',
      imagesOff: 'The host exposes no attachment service, so image input is unavailable',
      catalogDisk: 'Cached (restored at startup)',
      patOpen: 'Open the PAT page',
      patLinkHint: 'Need a token first?',
      usageInSidebar: 'Show today’s usage in the sidebar',
      summaryProviders: 'Four providers',
      accountSourceBrowser: 'Browser login',
      accountSourceDesktop: 'Desktop login',
      accountSourcePat: 'PAT',
      lastErrorAt: 'Last failure {time}',
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
    }

    function bind(t, key, vars) {
      var text = t(key)
      if (vars === undefined) return text
      return String(text).replace(/\{(\w+)\}/g, function (_, name) {
        return vars[name] === undefined ? '' : String(vars[name])
      })
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
    }

    /** 短名，给小卡用。 */
    function shortProviderName(provider) {
      if (provider === 'workbuddy') return 'WB'
      if (provider === 'workbuddy-ai') return 'WBAI'
      if (provider === 'qoder') return 'QD'
      if (provider === 'qoder-global') return 'QDG'
      return provider.slice(0, 4).toUpperCase()
    }

    /** 紧凑数字：上万折成 k。 */
    function compactNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value >= 10000) return String(Math.round(value / 100) / 10) + 'k'
      return String(Math.round(value * 10) / 10)
    }

    /** 低于这个比例就提前提醒，别等到真的见底。 */
    var LOW_CREDITS_RATIO = 0.15

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
     */
    function isQoderFreePlan(provider, credits) {
      if (typeof provider !== 'string' || provider.indexOf('qoder') !== 0) return false
      if (credits === undefined || credits === null) return false
      return credits.planName === 'Free' && !(typeof credits.total === 'number' && credits.total > 0)
    }

    /** 额度预警等级：优先用宿主算好的，老宿主没有就按同一套规则补。 */
    function alertOfCredits(credits, ratio, provider) {
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

    /** 额度百分比（读不到 / 不限量 / 没有总量时返回 undefined）。 */
    function creditsPercentOf(credits) {
      if (credits === undefined || credits.state !== 'ok') return undefined
      if (credits.unlimited === true) return undefined
      if (!(credits.total > 0)) return undefined
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
        color: color === undefined ? 'var(--dsw-alias-label-tertiary)' : color,
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.10))',
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
      if (state === 'degraded') return 'var(--dsw-alias-state-warning-primary, #b26b00)'
      if (state === 'down') return 'var(--dsw-alias-state-error-primary, #b3261e)'
      return 'var(--dsw-alias-label-tertiary)'
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

    var S = {
      card: {
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        padding: '18px 20px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        background: 'var(--dsw-alias-bg-l1, transparent)',
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
        color: 'var(--dsw-alias-label-tertiary)',
        opacity: 0.75,
        userSelect: 'text',
      },
      intro: { margin: 0, fontSize: TEXT.body, lineHeight: LINE.body, color: 'var(--dsw-alias-label-tertiary)', maxWidth: 620 },

      // 分组：统一用一条极淡的上边线分隔，省掉原来三种不同的 divider
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingTop: 14,
        borderTop: '0.5px solid var(--dsw-alias-border-l2)',
      },
      sectionHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      sectionTitle: {
        margin: 0,
        fontSize: TEXT.tiny,
        fontWeight: 600,
        letterSpacing: '.08em',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      sectionCount: {
        fontSize: TEXT.tiny,
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-tertiary)',
        opacity: 0.8,
      },

      // 胶囊徽标
      badge: {
        fontSize: TEXT.tiny,
        lineHeight: '18px',
        padding: '0 7px',
        borderRadius: 999,
        border: '0.5px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-tertiary)',
        whiteSpace: 'nowrap',
      },
      badgeWarn: {
        fontSize: TEXT.tiny,
        lineHeight: '18px',
        padding: '0 7px',
        borderRadius: 999,
        border: '0.5px solid var(--dsw-alias-state-warning-primary, #b26b00)',
        color: 'var(--dsw-alias-state-warning-primary, #b26b00)',
        whiteSpace: 'nowrap',
      },
      badgeSoft: {
        fontSize: TEXT.tiny,
        lineHeight: '18px',
        padding: '0 7px',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.10))',
        color: 'var(--dsw-alias-label-tertiary)',
        whiteSpace: 'nowrap',
      },

      // 通用行
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      stack: { display: 'flex', flexDirection: 'column', gap: 6 },
      grow: { flex: 1, minWidth: 0 },
      divider: { height: 0, borderTop: '0.5px solid var(--dsw-alias-border-l2)', margin: '2px 0' },
      hint: { margin: 0, fontSize: TEXT.body, lineHeight: LINE.body, color: 'var(--dsw-alias-label-tertiary)' },
      hintTiny: { margin: 0, fontSize: TEXT.tiny, lineHeight: LINE.dense, color: 'var(--dsw-alias-label-tertiary)', opacity: 0.85 },
      hintWarn: { margin: 0, fontSize: TEXT.body, lineHeight: LINE.body, color: 'var(--dsw-alias-state-warning-primary, #b26b00)' },
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
        color: 'var(--dsw-alias-label-tertiary)',
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
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.06))',
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
      modelMeta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: TEXT.tiny, whiteSpace: 'nowrap' },
      modelId: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: TEXT.tiny,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        opacity: 0.8,
        whiteSpace: 'nowrap',
      },

      // 标签页：改成胶囊分段，比下划线更贴合宿主的圆角风格
      tabs: { display: 'flex', gap: 4, flexWrap: 'wrap' },

      pre: {
        margin: 0,
        padding: '10px 12px',
        borderRadius: 8,
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-l2, rgba(0,0,0,.04))',
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
    var DOT_OFF = 'var(--dsw-alias-state-warning-primary, #b26b00)'

    function tabStyle(active) {
      return {
        font: 'inherit',
        fontSize: TEXT.body,
        fontWeight: active ? 600 : 500,
        padding: '5px 11px',
        borderRadius: 8,
        cursor: 'pointer',
        border: '0.5px solid ' + (active ? 'var(--dsw-alias-border-l2)' : 'transparent'),
        background: active ? 'var(--dsw-alias-bg-l2, rgba(127,127,127,.10))' : 'transparent',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
        whiteSpace: 'nowrap',
      }
    }

    // ── 网络 ────────────────────────────────────────────────────────
    function fetchStatus(light) {
      var url = light === true ? STATUS_PATH + '?light=1' : STATUS_PATH
      return fetch(url, { headers: { Accept: 'application/json' } }).then(function (response) {
        if (!response.ok) throw new Error('status ' + response.status)
        return response.json()
      })
    }

    function postJson(path, body, key) {
      return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RPC-Key': key === undefined ? '' : key },
        body: JSON.stringify(body === undefined ? {} : body),
      }).then(function (response) {
        return response.json().then(function (document) {
          if (!response.ok) throw new Error(document && document.error ? document.error : 'http ' + response.status)
          return document
        })
      })
    }

    /** 拉取脱敏后的诊断文本；失败时由调用方回退。 */
    function fetchDiagnosticsText() {
      return fetch(DIAGNOSTICS_PATH + '?format=text', { headers: { Accept: 'text/plain' } }).then(function (response) {
        if (!response.ok) throw new Error('diagnostics ' + response.status)
        return response.text()
      })
    }

    function formatTime(ms) {
      if (ms === undefined || ms === null || ms === 0) return '—'
      try {
        return new Date(ms).toLocaleString()
      } catch (_) {
        return String(ms)
      }
    }

    /** 表格里的紧凑时间：今天只显示时分秒，跨天再带日期。 */
    function formatShortTime(ms) {
      if (ms === undefined || ms === null || ms === 0) return '—'
      try {
        var date = new Date(ms)
        var now = new Date()
        var sameDay = date.getFullYear() === now.getFullYear()
          && date.getMonth() === now.getMonth()
          && date.getDate() === now.getDate()
        return sameDay ? date.toLocaleTimeString() : date.toLocaleString()
      } catch (_) {
        return String(ms)
      }
    }

    /** 侧栏面板用的短日期：同一年只显示 M/D。 */
    function formatShortDate(ms) {
      if (ms === undefined || ms === null || ms === 0) return '—'
      try {
        var date = new Date(ms)
        var now = new Date()
        var prefix = date.getFullYear() === now.getFullYear() ? '' : String(date.getFullYear()) + '/'
        return prefix + String(date.getMonth() + 1) + '/' + String(date.getDate())
      } catch (_) {
        return '—'
      }
    }

    function formatWindow(tokens) {
      if (typeof tokens !== 'number' || tokens <= 0) return '—'
      if (tokens >= 1000000) return String(Math.round((tokens / 1000000) * 10) / 10) + 'M'
      if (tokens >= 1000) return String(Math.round(tokens / 1000)) + 'K'
      return String(tokens)
    }

    // ── 卡片 ────────────────────────────────────────────────────────
    function ConnectorCard(props) {
      var t = props.t
      var useState = React.useState
      var useEffect = React.useEffect
      var useCallback = React.useCallback

      var statusState = useState(undefined)
      var status = statusState[0]
      var setStatus = statusState[1]
      var errorState = useState(undefined)
      var error = errorState[0]
      var setError = errorState[1]
      var busyState = useState(undefined)
      var busy = busyState[0]
      var setBusy = busyState[1]
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
      var searchState = useState('')
      var searchDraft = searchState[0]
      var setSearchDraft = searchState[1]
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

      var load = useCallback(
        function () {
          return fetchStatus()
            .then(function (document) {
              setStatus(document)
              setError(undefined)
              return document
            })
            .catch(function (failure) {
              setError(String(failure && failure.message ? failure.message : failure))
            })
        },
        [setStatus, setError],
      )

      useEffect(function () {
        var disposed = false
        load()
        var timer = setInterval(function () {
          if (!disposed) load()
        }, POLL_MS)
        return function () {
          disposed = true
          clearInterval(timer)
        }
      }, [load])

      var providers = status && Array.isArray(status.providers) ? status.providers : []
      var active = providers.filter(function (entry) {
        return entry.provider === activeTab
      })[0]

      useEffect(function () {
        if (active === undefined) return
        if (status && status.settings) {
          var desktop = status.settings.workbuddy && status.settings.workbuddy[active.provider]
          if (desktop) {
            setAppPathDraft(desktop.electronPath || '')
            setAuthFileDraft(desktop.authFile || '')
          }
          var advanced = status.settings.advanced || {}
          if (typeof advanced.idleTimeoutMs === 'number') setAdvIdle(String(Math.round(advanced.idleTimeoutMs / 1000)))
          if (typeof advanced.catalogRefreshMs === 'number') setAdvCatalog(String(Math.round(advanced.catalogRefreshMs / 1000)))
          if (typeof advanced.creditsRefreshMs === 'number') setAdvCredits(String(Math.round(advanced.creditsRefreshMs / 1000)))
          setAdvStats(advanced.stats !== false)
          setAdvCache(advanced.catalogCache !== false)
          var alerts = status.settings.alerts || {}
          setAdvAlert(typeof alerts.lowRatio === 'number' ? String(Math.round(alerts.lowRatio * 100)) : '15')
          var auto = status.settings.autoSwitch
          var switchRatio = auto !== null && typeof auto === 'object' && typeof auto.thresholdRatio === 'number'
            ? auto.thresholdRatio
            : 0
          setAdvSwitch(String(Math.round(switchRatio * 100)))
          if (typeof advanced.qoderQueueWaitMs === 'number') setAdvQueue(String(Math.round(advanced.qoderQueueWaitMs / 1000)))
        }
        setPatDraft('')
      }, [activeTab, status === undefined])

      var mutate = function (patch) {
        if (status === undefined) return Promise.resolve()
        setBusy('save')
        return postJson(SETTINGS_PATH, patch, status.key)
          .then(function (document) {
            setStatus(document)
            setError(undefined)
            setBusy(undefined)
            setPatDraft('')
          })
          .catch(function (failure) {
            setBusy(undefined)
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      var refresh = function () {
        if (status === undefined) return
        setBusy('refresh')
        postJson(ACTION_PATH, { action: 'refresh' }, status.key)
          .then(function (document) {
            setStatus(document)
            setBusy(undefined)
            setError(undefined)
          })
          .catch(function (failure) {
            setBusy(undefined)
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
          var forced = (entry.models || [])
            .filter(function (row) {
              return row.id !== model.id && row.forced
            })
            .map(function (row) {
              return row.id
            })
          if (!model.forced) forced.push(model.id)
          var forcePatch = { forcedModels: {} }
          forcePatch.forcedModels[entry.provider] = forced
          mutate(forcePatch)
          return
        }
        var disabled = (entry.models || [])
          .filter(function (row) {
            return row.id !== model.id && row.disabled
          })
          .map(function (row) {
            return row.id
          })
        if (!model.disabled) disabled.push(model.id)
        var providersPatch = {}
        providersPatch[entry.provider] = { disabledModels: disabled }
        mutate({ providers: providersPatch })
      }

      var setAllModels = function (entry, hidden) {
        var providersPatch = {}
        providersPatch[entry.provider] = {
          // 「全部关闭」只处理账号本来就可用的那些；本来就不支持的保持原样。
          disabledModels: hidden
            ? (entry.models || []).filter(function (row) { return !row.unavailable }).map(function (row) { return row.id })
            : [],
        }
        mutate({ providers: providersPatch })
      }

      /**
       * 打开 App 登录并导入账号。
       *
       * 宿主那边会拉起 WorkBuddy 窗口并轮询登录文件；导入完成后 `/status` 里
       * 就多了一个账号。所以这里只负责「发一次请求 + 轮询状态」。
       */
      var startLogin = function (provider) {
        if (status === undefined) return
        setBusy('login')
        postJson(ACTION_PATH, { action: 'login-start', provider: provider }, status.key)
          .then(function (document) {
            setBusy(undefined)
            if (document.status !== undefined) setStatus(document.status)
            setError(undefined)
            pollLogin(provider, 0)
          })
          .catch(function (failure) {
            setBusy(undefined)
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 轮询登录进度，直到 done / failed / cancelled。 */
      var pollLogin = function (provider, attempt) {
        if (status === undefined || attempt > 150) return
        setTimeout(function () {
          fetchStatus()
            .then(function (document) {
              setStatus(document)
              var entry = (document.providers || []).find(function (item) { return item.provider === provider })
              var job = entry === undefined ? undefined : entry.login
              if (job === undefined) return
              if (job.phase === 'waiting' || job.phase === 'starting') {
                pollLogin(provider, attempt + 1)
              }
            })
            .catch(function () {})
        }, 2000)
      }

      var cancelLogin = function (provider) {
        if (status === undefined) return
        postJson(ACTION_PATH, { action: 'login-cancel', provider: provider }, status.key)
          .then(function (document) { setStatus(document) })
          .catch(function () {})
      }

      /** 手动签到：只跑当前 provider，避免一次点全平台。 */      var runCheckin = function (provider) {
        if (status === undefined) return
        setBusy('checkin')
        postJson(ACTION_PATH, { action: 'checkin', provider: provider }, status.key)
          .then(function (document) {
            setStatus(document)
            setBusy(undefined)
            setError(undefined)
          })
          .catch(function (failure) {
            setBusy(undefined)
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      var runProbeNow = function () {
        if (status === undefined) return
        setBusy('probe')
        postJson(ACTION_PATH, { action: 'probe' }, status.key)
          .then(function (document) {
            setStatus(document)
            setBusy(undefined)
            setError(undefined)
          })
          .catch(function (failure) {
            setBusy(undefined)
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 真发一次 1-token 请求，验证某个账号现在能不能用。 */
      var testAccount = function (provider, accountId) {
        if (status === undefined) return
        setBusy('test:' + accountId)
        postJson(ACTION_PATH, { action: 'test-account', provider: provider, accountId: accountId }, status.key)
          .then(function (document) {
            setStatus(document.status !== undefined ? document.status : document)
            setBusy(undefined)
            setError(undefined)
          })
          .catch(function (failure) {
            setBusy(undefined)
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 清除一个账号的失败冷却。 */
      var resetCooldown = function (provider, accountId) {
        if (status === undefined) return
        setBusy('reset:' + accountId)
        postJson(ACTION_PATH, { action: 'reset-account', provider: provider, accountId: accountId }, status.key)
          .then(function (document) {
            setStatus(document)
            setBusy(undefined)
            setError(undefined)
          })
          .catch(function (failure) {
            setBusy(undefined)
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 被用户强制显示的模型数量。 */
      var forcedCount = function (entry) {
        return (entry.models || []).filter(function (row) {
          return row.forced
        }).length
      }

      /** 刷新额度（强制绕过缓存）。 */
      var refreshCredits = function () {
        if (status === undefined) return
        setBusy('credits')
        postJson(ACTION_PATH, { action: 'credits' }, status.key)
          .then(function (document) {
            setStatus(document)
            setBusy(undefined)
            setError(undefined)
          })
          .catch(function (failure) {
            setBusy(undefined)
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 保存高级设置：秒 → 毫秒，非法输入交给宿主夹取。 */
      var saveAdvanced = function () {
        if (status === undefined) return
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
        setBusy('advanced')
        postJson(SETTINGS_PATH, {
          advanced: {
            idleTimeoutMs: toMs(advIdle, current.idleTimeoutMs || 180000),
            catalogRefreshMs: toMs(advCatalog, current.catalogRefreshMs || 600000),
            creditsRefreshMs: toMs(advCredits, current.creditsRefreshMs || 120000),
            qoderQueueWaitMs: toMs(advQueue, current.qoderQueueWaitMs || 60000),
            stats: advStats !== false,
            catalogCache: advCache !== false,
          },
          alerts: { lowRatio: toPercent(advAlert, 0.15) },
          autoSwitch: {
            enabled: (status.settings && status.settings.autoSwitch && typeof status.settings.autoSwitch === 'object')
              ? status.settings.autoSwitch.enabled !== false
              : true,
            thresholdRatio: toPercent(advSwitch, 0),
          },
        }, status.key)
          .then(function (document) {
            setStatus(document)
            setBusy(undefined)
            setError(undefined)
            setAdvSaved(true)
            setTimeout(function () { setAdvSaved(false) }, 1600)
          })
          .catch(function (failure) {
            setBusy(undefined)
            setError(String(failure && failure.message ? failure.message : failure))
          })
      }

      /** 重置用量统计。 */
      var resetStats = function () {
        if (status === undefined) return
        setBusy('stats')
        postJson(ACTION_PATH, { action: 'stats-reset' }, status.key)
          .then(function (document) {
            setStatus(document)
            setBusy(undefined)
            setError(undefined)
          })
          .catch(function (failure) {
            setBusy(undefined)
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
      var accountRows = Array.isArray(active && active.accounts) ? active.accounts : []
      var plainAccounts = function (extra) {
        return accountRows.map(function (row) {
          var next = {
            id: row.id,
            label: row.label,
            enabled: row.enabled !== false,
          }
          if (row.authFile !== undefined && row.authFile !== '') next.authFile = row.authFile
          if (extra !== undefined && extra.id === row.id) {
            if (extra.pat !== undefined) next.pat = extra.pat
            if (extra.forget === true) next.forget = true
          }
          return next
        })
      }

      var activeRow = accountRows.filter(function (row) { return row.active })[0]

      var savePat = function () {
        if (active === undefined) return
        var pat = patDraft.trim()
        if (pat === '') return
        // 账号池存在时必须写进「当前账号」，否则写的是被忽略的旧字段，
        // 用户会看到「保存成功但状态没变」。
        if (accountRows.length > 0 && activeRow !== undefined) {
          mutate({ accounts: plainAccounts({ id: activeRow.id, pat: pat }) })
          return
        }
        var patch = { qoder: {} }
        patch.qoder[active.provider] = { pat: pat }
        mutate(patch)
      }

      var clearPat = function () {
        if (active === undefined) return
        if (accountRows.length > 0 && activeRow !== undefined) {
          mutate({ accounts: plainAccounts({ id: activeRow.id, forget: true }) })
          return
        }
        var patch = { qoder: {} }
        patch.qoder[active.provider] = { pat: '' }
        mutate(patch)
      }

      var saveDesktop = function () {
        if (active === undefined) return
        var patch = { workbuddy: {} }
        patch.workbuddy[active.provider] = { electronPath: appPathDraft.trim(), authFile: authFileDraft.trim() }
        mutate(patch)
      }

      var copyDiagnostics = function () {
        var write = function (text) {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
              setCopied(true)
              setTimeout(function () { setCopied(false) }, 1500)
            }, function () {})
          }
        }
        if (status !== undefined) {
          // 新版宿主提供脱敏后的纯文本诊断；旧宿主没有这条路由时退回精简 JSON
          // （至少先删掉控制密钥，不能把写接口的钥匙复制出去）。
          fetchDiagnosticsText().then(write, function () {
            var safe = Object.assign({}, status)
            delete safe.key
            write(JSON.stringify(safe, null, 2))
          })
          return
        }
        write(JSON.stringify({ error: error }, null, 2))
      }

      if (status === undefined) {
        return h(
          'div',
          { style: S.card },
          h('p', { style: error === undefined ? S.hint : S.hintError }, error === undefined ? bind(t, 'loading') : bind(t, 'error') + '：' + error),
        )
      }

      // 预警阈值由宿主下发；老宿主没有 alerts 时沿用 15%。
      var alertSettings = (status.settings && status.settings.alerts) || {}
      var alertRatio = typeof alertSettings.lowRatio === 'number' ? alertSettings.lowRatio : LOW_CREDITS_RATIO
      var alertsEnabled = alertSettings.enabled !== false

      var tabs = providers.map(function (entry) {
        var signed = entry.credential !== undefined && entry.credential !== null && entry.credential.status === 'signed-in'
        var tabHealth = entry.health || { state: 'unknown' }
        return h(
          'button',
          {
            key: entry.provider,
            type: 'button',
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

      // 账号总览：四张可点的卡片。比原来一行小胶囊多三样东西：
      // 健康圆点、今日用量、当前账号名 —— 不切标签就能判断「该不该点进去」。
      var summaryCards = providers.map(function (entry) {
        var health = entry.health || { state: 'unknown' }
        var signed = entry.credential !== undefined && entry.credential !== null && entry.credential.status === 'signed-in'
        var credits = entry.credits || { state: 'none' }
        var today = (entry.usage && entry.usage.today) || {}
        var selected = entry.provider === activeTab
        var accent = PROVIDER_ACCENT[entry.provider] || 'currentColor'
        var low = credits.state === 'ok' && isCreditsLow(credits, alertRatio)
        var valueText = credits.state === 'ok'
          ? credits.unlimited === true ? '∞' : compactNumber(credits.remain)
          : '—'
        var metaParts = [String(entry.modelCount !== undefined ? entry.modelCount : (entry.models || []).length) + ' ' + bind(t, 'models')]
        if (today.requests > 0) metaParts.push(compactNumber(today.totalTokens || 0) + ' tok')
        var activeRow = (entry.accounts || []).filter(function (row) { return row.active })[0]
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
                ? 'var(--dsw-alias-bg-l2, rgba(127,127,127,.10))'
                : 'var(--dsw-alias-bg-l1, transparent)',
              color: 'var(--dsw-alias-label-primary)',
              minWidth: 0,
              opacity: entry.enabled === false ? 0.55 : 1,
            },
          },
          h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            h('span', { title: bind(t, healthTextKey(health.state)), style: Object.assign({}, dot(signed ? healthColor(health.state) : DOT_OFF)) }),
            h('span', { style: { fontSize: TEXT.tiny, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.displayName),
            h('span', { style: S.grow }),
            h('span', {
              style: {
                fontSize: TEXT.tiny,
                color: healthColor(health.state),
                opacity: health.state === 'unknown' ? 0.6 : 1,
                whiteSpace: 'nowrap',
              },
            }, bind(t, healthTextKey(health.state)))),
          h('span', {
            style: {
              fontSize: 20,
              lineHeight: '24px',
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              color: low ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : accent,
            },
          }, valueText),
          h('span', {
            style: { fontSize: TEXT.tiny, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, metaParts.join(' · ')),
        )
      })

      // 额度预警：只提醒，不改变行为。真正换号由 autoSwitch.thresholdRatio 控制。
      var alertProviders = alertsEnabled
        ? providers.filter(function (entry) {
            return entry.enabled !== false && alertOfCredits(entry.credits, alertRatio, entry.provider) !== undefined
          })
        : []
      var exhaustedNames = alertProviders
        .filter(function (entry) { return alertOfCredits(entry.credits, alertRatio, entry.provider) === 'exhausted' })
        .map(function (entry) { return entry.displayName })
      var lowNames = alertProviders
        .filter(function (entry) { return alertOfCredits(entry.credits, alertRatio, entry.provider) === 'low' })
        .map(function (entry) { return entry.displayName })
      var alertLines = []
      if (exhaustedNames.length > 0) alertLines.push(bind(t, 'alertBannerExhausted', { names: exhaustedNames.join('、') }))
      if (lowNames.length > 0) alertLines.push(bind(t, 'alertBannerLow', { names: lowNames.join('、') }))
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
              border: '0.5px solid var(--dsw-alias-state-warning-primary, #b26b00)',
              background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary, #b26b00) 9%, transparent)',
              color: 'var(--dsw-alias-state-warning-primary, #b26b00)',
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
          }, status.host && status.host.images === true ? 'IMG' : 'TXT')),
        h('p', { key: 'intro', style: S.intro }, bind(t, 'intro')),
        h('div', { key: 'toolbar', style: S.row },
          h('button', { type: 'button', style: S.buttonPrimary, onClick: refresh, disabled: busy === 'refresh' },
            busy === 'refresh' ? bind(t, 'refreshing') : bind(t, 'refresh')),
          h('span', { style: S.grow }),
          h('button', {
            type: 'button',
            style: S.buttonGhost,
            onClick: function () { setShowDiag(!showDiag) },
          }, bind(t, 'diagnostics'))),
        error === undefined ? null : h('p', { key: 'err', style: S.hintError }, bind(t, 'error') + '：' + error),
        alertBanner,
        summaryCards.length === 0
          ? null
          : h('div', { key: 'summary', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 } }, summaryCards),
        h('div', { key: 'tabs', style: S.tabs }, tabs),
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
        && typeof credential.message === 'string' && credential.message !== ''
        ? credential.message
        : undefined
      var extraMessage = typeof active.message === 'string' && active.message !== ''
        && !isSameMessage(credentialMessage, active.message)
        ? active.message
        : undefined

      sections.push(
        h('div', { key: 'status', style: S.section },
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
            h('span', { style: S.badgeSoft }, active.kind === 'desktop' ? bind(t, 'kindDesktop') : bind(t, 'kindPat')),
            h('span', {
              style: credential.status === 'signed-in' ? S.badge : S.badgeWarn,
            }, credential.status === 'signed-in' ? bind(t, 'signedIn') : bind(t, 'signedOut')),
            h('span', {
              title: activeHealth.consecutiveFailures > 0 ? String(activeHealth.consecutiveFailures) + ' 连败' : '',
              style: Object.assign({}, S.badgeSoft, { color: healthColor(activeHealth.state) }),
            }, bind(t, healthTextKey(activeHealth.state))),
            h('span', {
              style: S.badgeSoft,
              title: active.images === true ? bind(t, 'imagesOn') : bind(t, 'imagesOff'),
            }, 'IMG')),
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
          extraMessage !== undefined ? h('p', { key: 'msg', style: S.hintWarn }, extraMessage) : null),
      )

      // ── 账号 ────────────────────────────────────────────────────
      //
      // 多账号的意义：一个账号的积分用完了，自动/手动切到另一个还能用的账号。
      // 这里只做「增删与选定」，PAT 本身从不回传给浏览器（状态文档里没有）。
      accountRows = Array.isArray(active && active.accounts) ? active.accounts : []
      var isPatProvider = active.kind === 'pat'
      var loginJob = active.login
      var accountItems = accountRows.map(function (account, index) {
        var snapshot = account.credits || { state: 'none' }
        var cooling = typeof account.cooldownUntil === 'number' && account.cooldownUntil > Date.now()
        var lastTest = account.lastTest
        var testKey = 'test:' + account.id
        var resetKey = 'reset:' + account.id
        return h('li', {
          key: account.id,
          style: Object.assign({}, S.modelRow, index > 0 ? S.modelRowDivider : {}),
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
              disabled: busy === resetKey,
              onClick: function () { resetCooldown(active.provider, account.id) },
            }, bind(t, 'resetCooldown'))
          : null,
        h('button', {
          type: 'button',
          style: S.buttonGhost,
          disabled: busy === testKey,
          title: bind(t, 'testAccount'),
          onClick: function () { testAccount(active.provider, account.id) },
        }, busy === testKey ? bind(t, 'testing') : bind(t, 'testAccount')),
        account.active
          ? null
          : h('button', {
              type: 'button',
              style: S.buttonGhost,
              disabled: busy === 'accounts',
              onClick: function () {
                var patch = { activeAccount: {} }
                patch.activeAccount[active.provider] = account.id
                mutate(patch)
              },
            }, bind(t, 'useAccount')),
        accountRows.length > 1
          ? h('button', {
              type: 'button',
              style: S.buttonGhost,
              disabled: busy === 'accounts',
              onClick: function () {
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
            }, bind(t, 'removeAccount'))
          : null)
      })

      var addAccount = function () {
        var secret = accSecret.trim()
        var label = accLabel.trim() === '' ? bind(t, 'accountDefaultLabel') : accLabel.trim()
        var next = { id: 'acc-' + String(Date.now()), label: label, enabled: true }
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
        mutate(patch)
        setAccLabel('')
        setAccSecret('')
      }

      // 签到状态：优先显示「今日已签 / 可领 N 分 / 无活动 / 失败原因」。
      var checkin = active.checkin || {}
      var checkinResult = checkin.result
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
        var kinds = (checkinResult.outcomes || []).map(function (item) { return item.kind })
        if (claimedCount > 0) {
          checkinLabel = bind(t, 'checkinClaimed', { count: claimedCount, credit: claimedCredit })
        } else if (kinds.indexOf('already') !== -1) {
          checkinLabel = bind(t, 'checkinAlready')
        } else if (kinds.indexOf('inactive') !== -1) {
          checkinLabel = bind(t, 'checkinInactive')
        } else if (kinds.indexOf('failed') !== -1) {
          checkinFailureRaw = (checkinResult.outcomes.find(function (item) { return item.kind === 'failed' }) || {}).message || '—'
          checkinLabel = bind(t, 'checkinFailed', { reason: shortErrorMessage(checkinFailureRaw, t) })
          checkinTone = 'hintWarn'
        } else {
          checkinLabel = checkin.completedToday === true ? bind(t, 'checkinAutoDone') : bind(t, 'checkinNever')
        }
      }
      var checkinFailed = checkinTone === 'hintWarn' && checkin.enabled !== false

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
              disabled: busy === 'checkin',
              onClick: function () { runCheckin(active.provider) },
            }, busy === 'checkin' ? bind(t, 'checkinRunning') : bind(t, 'checkinNow')),
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
                  disabled: busy === 'login',
                  onClick: function () { startLogin(active.provider) },
                }, busy === 'login' ? bind(t, 'loginOpening') : bind(t, 'loginAdd')),
                loginJob === undefined
                  ? null
                  : h('span', {
                      style: loginJob.phase === 'failed' ? S.hintWarn : S.hintTiny,
                    }, loginJob.message),
                loginJob !== undefined && typeof loginJob.authUrl === 'string'
                  ? h('a', {
                      href: loginJob.authUrl,
                      target: '_blank',
                      rel: 'noreferrer',
                      style: { fontSize: 11.5, color: 'var(--dsw-alias-label-link, var(--dsw-alias-state-business-primary, #2f6fed))' },
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
                    value: accLabel,
                    placeholder: bind(t, 'accountLabel'),
                    onChange: function (event) { setAccLabel(event.target.value) },
                  }),
                  h('button', {
                    type: 'button',
                    style: S.button,
                    disabled: busy === 'accounts' || accSecret.trim() === '',
                    onClick: addAccount,
                  }, bind(t, 'addAccount'))),
                h('input', {
                  key: 'secret',
                  style: S.input,
                  type: 'password',
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
      var creditsLow = credits.state === 'ok' && isCreditsLow(credits, alertRatio)
      var qoderFreePlan = isQoderFreePlan(active.provider, credits)
      var creditsHead = h('div', { key: 'h', style: S.sectionHead },
        h('span', { style: S.sectionTitle }, bind(t, 'credits')),
        h('span', { style: S.grow }),
        h('button', {
          key: 'b',
          type: 'button',
          style: S.buttonGhost,
          onClick: refreshCredits,
          disabled: busy === 'credits',
        }, busy === 'credits' ? bind(t, 'creditsRefreshing') : bind(t, 'creditsRefresh')))

      var creditsBody = []
      if (credits.state === 'ok') {
        var creditsRatio = credits.unlimited === true || !(credits.total > 0)
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
                color: creditsLow ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : 'var(--dsw-alias-label-primary)',
                opacity: credits.stale === true ? 0.65 : 1,
              },
            }, credits.unlimited === true ? '∞' : formatNumber(credits.remain)),
            credits.total > 0
              ? h('span', { style: { fontSize: TEXT.body, color: 'var(--dsw-alias-label-tertiary)' } },
                  '/ ' + formatNumber(credits.total) + ' ' + bind(t, 'creditsUnit'))
              : h('span', { style: { fontSize: TEXT.body, color: 'var(--dsw-alias-label-tertiary)' } }, bind(t, 'creditsUnit')),
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
                background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.16))',
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
                  ? 'var(--dsw-alias-state-warning-primary, #b26b00)'
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
        if (trend !== null && typeof trend === 'object' && (trend.sampleCount > 0 || (trend.points || []).length > 1)) {
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
            trendChips.push(h('span', { key: 'te', style: microChip(creditsLow ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : undefined) }, bind(t, 'trendEta', { duration: formatCompactDuration(trend.etaMs) })))
          }
          creditsBody.push(
            h('div', { key: 'trend', style: { display: 'flex', flexDirection: 'column', gap: 5, paddingTop: 7, borderTop: '0.5px solid var(--dsw-alias-border-l2)' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h('span', { style: S.label }, bind(t, 'trend')),
                h('span', { style: S.grow }),
                ...trendChips),
              sparkline(trend.points, creditsLow ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : (PROVIDER_ACCENT[active.provider] || 'currentColor')),
              typeof trend.etaMs !== 'number'
                ? h('span', { style: { fontSize: TEXT.tiny, color: 'var(--dsw-alias-label-tertiary)' } }, bind(t, 'trendEtaUnknown'))
                : null),
          )
        }
      } else if (credits.state === 'error') {
        creditsBody.push(h('p', { key: 'flat', style: S.hintError }, creditsText(credits)))
        if (credits.message) {
          creditsBody.push(h('p', { key: 'err', style: S.hintWarn }, bind(t, 'creditsFailed', { message: credits.message })))
        }
      } else {
        creditsBody.push(h('p', { key: 'flat', style: S.hint }, creditsText(credits)))
      }

      if (Array.isArray(credits.items) && credits.items.length > 0) {
        creditsBody.push(
          h('details', { key: 'pkgs' },
            h('summary', { style: Object.assign({}, S.hintTiny, { cursor: 'pointer' }) },
              bind(t, 'creditsPackages', { count: credits.items.length })),
            h('ul', {
              style: Object.assign({}, S.modelList, { marginTop: 6 }),
            },
            credits.items.map(function (item, index) {
              return h('li', {
                key: 'pkg' + index,
                style: Object.assign({}, S.modelRow, index > 0 ? S.modelRowDivider : {}),
              },
              h('span', { style: S.modelName }, item.name),
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
      var recentRequests = (statsDoc.recent || []).filter(function (entry) {
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
        color: 'var(--dsw-alias-label-tertiary)',
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.06))',
      })
      var usageNumberCell = Object.assign({}, usageCell, {
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-primary)',
      })
      var usageLabelCell = Object.assign({}, usageCell, {
        color: 'var(--dsw-alias-label-tertiary)',
        fontWeight: 500,
      })
      var usageTableFrame = {
        border: '0.5px solid ' + usageBorder,
        borderRadius: 8,
        overflow: 'hidden',
      }
      var usageRowLine = { borderTop: '0.5px solid ' + usageBorder }
      var summaryColumns = '52px minmax(48px, 1fr) minmax(56px, 1fr) minmax(62px, 1fr) minmax(58px, 1fr)'
      var recentColumns = 'minmax(84px, 1.1fr) minmax(84px, 1.4fr) minmax(58px, .8fr) minmax(52px, .8fr) minmax(60px, .8fr)'

      var usageHead = function (key, label, alignRight) {
        return h('span', { key: key, style: Object.assign({}, usageHeadCell, alignRight === true ? { textAlign: 'right' } : {}) }, label)
      }
      var usageRow = function (key, label, values, top) {
        return h(
          'div',
          { key: key, style: Object.assign({ display: 'grid', gridTemplateColumns: summaryColumns }, top === true ? usageRowLine : {}) },
          h('span', { style: usageLabelCell }, label),
          ...values.map(function (value, index) {
            return h('span', { key: 'v' + index, style: usageNumberCell }, value)
          }),
        )
      }

      var usageBody = []
      if (statsDoc.enabled === false) {
        usageBody.push(h('p', { key: 'off', style: S.hintTiny }, bind(t, 'usageDisabled')))
      } else {
        var rateOf = function (counters) {
          return typeof counters.successRate === 'number' ? String(Math.round(counters.successRate * 100)) + '%' : '—'
        }
        usageBody.push(
          h('div', { key: 'summary', style: usageTableFrame },
            h('div', { style: { display: 'grid', gridTemplateColumns: summaryColumns } },
              usageHead('h0', ''),
              usageHead('h1', bind(t, 'usageCalls'), true),
              usageHead('h2', bind(t, 'usageRate'), true),
              usageHead('h3', bind(t, 'usageAvg'), true),
              usageHead('h4', bind(t, 'usageTokenShort'), true)),
            usageRow('today', bind(t, 'usageToday'), [
              formatNumber(usageToday.requests || 0),
              rateOf(usageToday),
              formatDuration(usageToday.avgDurationMs),
              formatNumber(usageToday.totalTokens || 0),
            ], true),
            usageRow('all', bind(t, 'usageTotal'), [
              formatNumber(providerUsage.requests || 0),
              rateOf(providerUsage),
              formatDuration(providerUsage.avgDurationMs),
              formatNumber(providerUsage.totalTokens || 0),
            ], true),
            typeof statsDoc.currentSession === 'object' && statsDoc.currentSession !== null && statsDoc.currentSession.requests > 0
              ? usageRow('session', bind(t, 'usageSession'), [
                  formatNumber(statsDoc.currentSession.requests || 0),
                  rateOf(statsDoc.currentSession),
                  formatDuration(statsDoc.currentSession.avgDurationMs),
                  formatNumber(statsDoc.currentSession.totalTokens || 0),
                ], true)
              : null),
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
              disabled: busy === 'stats',
            }, busy === 'stats' ? bind(t, 'refreshing') : bind(t, 'usageReset'))),
        )
        if (statsDoc.since > 0) {
          usageBody.push(h('p', { key: 'since', style: S.hintTiny }, bind(t, 'usageSince', { time: formatTime(statsDoc.since) })))
        }

        // 最近 14 天用量：14 根柱子，高度按当天 token 归一化。
        // 不画坐标轴 —— 它回答的是「哪天用得猛」，不是精确读数。
        var daily = Array.isArray(statsDoc.daily) ? statsDoc.daily.slice(-14) : []
        if (daily.length > 0) {
          var maxDailyTokens = 1
          daily.forEach(function (day) {
            if (typeof day.totalTokens === 'number' && day.totalTokens > maxDailyTokens) maxDailyTokens = day.totalTokens
          })
          usageBody.push(
            h('div', { key: 'heat', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: S.sectionTitle }, bind(t, 'usageHeatmap')),
                h('span', { style: S.grow }),
                h('span', { style: S.hintTiny }, daily.length + 'd')),
              h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 28 } },
                daily.map(function (day) {
                  var tokens = typeof day.totalTokens === 'number' ? day.totalTokens : 0
                  var height = Math.max(3, Math.round((tokens / maxDailyTokens) * 26))
                  return h('div', {
                    key: 'd' + day.date,
                    title: day.date + ' · ' + formatNumber(day.requests || 0) + ' 次 · ' + formatNumber(tokens) + ' tok',
                    style: {
                      flex: '1 1 0',
                      minWidth: 2,
                      height: height,
                      borderRadius: 2,
                      background: tokens > 0
                        ? (PROVIDER_ACCENT[active.provider] || 'var(--dsw-alias-state-business-primary, #2f6fed)')
                        : 'var(--dsw-alias-border-l2)',
                      opacity: tokens > 0 ? 0.5 + Math.min(0.5, tokens / maxDailyTokens / 2) : 0.5,
                    },
                  })
                }))),
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
                h('div', { style: { display: 'grid', gridTemplateColumns: modelColumns } },
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
                  h('span', { style: Object.assign({}, usageNumberCell, { color: 'var(--dsw-alias-label-tertiary)' }) }, formatDuration(entry.counters.avgDurationMs)))
                }))),
          )
        }

        usageBody.push(h('div', { key: 'recenthead', style: Object.assign({}, S.sectionTitle, { marginTop: 2 }) }, bind(t, 'usageRecent')))
        if (recentRequests.length === 0) {
          usageBody.push(h('p', { key: 'empty', style: S.hintTiny }, bind(t, 'usageEmpty')))
        } else {
          usageBody.push(
            h('div', { key: 'recent', style: usageTableFrame },
              h('div', { style: { display: 'grid', gridTemplateColumns: recentColumns } },
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
                  h('span', { style: Object.assign({}, usageCell, { color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' }), title: formatTime(entry.at) }, formatShortTime(entry.at)),
                  h('span', { style: Object.assign({}, usageCell, { color: 'var(--dsw-alias-label-primary)' }), title: entry.model || '' }, entry.model || '—'),
                  h('span', { style: Object.assign({}, usageCell, { textAlign: 'right' }) },
                    h('span', {
                      style: failed || entry.kind === 'incomplete' ? S.badgeWarn : S.badgeSoft,
                      title: entry.code || '',
                    }, bind(t, kindTextKey(entry.kind)))),
                  h('span', { style: Object.assign({}, usageNumberCell, { color: 'var(--dsw-alias-label-tertiary)' }) }, formatDuration(entry.durationMs)),
                  h('span', { style: Object.assign({}, usageNumberCell, { color: 'var(--dsw-alias-label-tertiary)' }) }, formatNumber(entry.totalTokens || 0)),
                )
              })),
          )
        }
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
              style: { color: 'var(--dsw-alias-label-link, var(--dsw-alias-state-business-primary, #2f6fed))' },
            }, bind(t, 'patOpen'))),
          h('div', { key: 'btns', style: S.row },
            h('button', { type: 'button', style: S.buttonPrimary, onClick: savePat, disabled: busy === 'save' || patDraft.trim() === '' },
              busy === 'save' ? bind(t, 'saving') : bind(t, 'save')),
            h('button', { type: 'button', style: S.button, onClick: clearPat, disabled: busy === 'save' || !configured },
              bind(t, 'clear'))),
        )
      } else {
        connectionBody.push(
          h('div', { key: 'appf', style: S.field },
            h('span', { style: S.label }, bind(t, 'appPath')),
            h('input', {
              style: S.input,
              type: 'text',
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
              value: authFileDraft,
              placeholder: credential.file || '%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth',
              onChange: function (event) { setAuthFileDraft(event.target.value) },
            }),
            h('span', { style: S.hintTiny }, bind(t, 'authFileHint'))),
          h('div', { key: 'btns', style: S.row },
            h('button', { type: 'button', style: S.buttonPrimary, onClick: saveDesktop, disabled: busy === 'save' },
              busy === 'save' ? bind(t, 'saving') : bind(t, 'save'))),
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
      sections.push(
        h('div', { key: 'advanced', style: S.section },
          h('details', {},
            h('summary', {
              style: { cursor: 'pointer', fontSize: TEXT.tiny, fontWeight: 600, letterSpacing: '.08em', color: 'var(--dsw-alias-label-tertiary)' },
            }, bind(t, 'advanced')),
            h('p', { style: Object.assign({}, S.hintTiny, { marginTop: 8 }) }, bind(t, 'advancedHint')),
            h('div', { key: 'idle', style: S.field },
              h('span', { style: S.label }, bind(t, 'advancedIdle')),
              h('input', {
                style: S.input,
                type: 'number',
                min: 15,
                max: 900,
                value: advIdle,
                onChange: function (event) { setAdvIdle(event.target.value) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'advancedIdleHint'))),
            h('div', { key: 'intervals', style: S.row },
              h('div', { style: Object.assign({}, S.field, { flex: '1 1 140px' }) },
                h('span', { style: S.label }, bind(t, 'advancedCatalog')),
                h('input', {
                  style: S.input,
                  type: 'number',
                  min: 120,
                  max: 86400,
                  value: advCatalog,
                  onChange: function (event) { setAdvCatalog(event.target.value) },
                })),
              h('div', { style: Object.assign({}, S.field, { flex: '1 1 140px' }) },
                h('span', { style: S.label }, bind(t, 'advancedCredits')),
                h('input', {
                  style: S.input,
                  type: 'number',
                  min: 30,
                  max: 21600,
                  value: advCredits,
                  onChange: function (event) { setAdvCredits(event.target.value) },
                }))),
            h('div', { key: 'thresholds', style: S.row },
              h('div', { style: Object.assign({}, S.field, { flex: '1 1 140px' }) },
                h('span', { style: S.label }, bind(t, 'advancedAlert')),
                h('input', {
                  style: S.input,
                  type: 'number',
                  min: 1,
                  max: 95,
                  value: advAlert,
                  onChange: function (event) { setAdvAlert(event.target.value) },
                }),
                h('span', { style: S.hintTiny }, bind(t, 'advancedAlertHint'))),
              h('div', { style: Object.assign({}, S.field, { flex: '1 1 140px' }) },
                h('span', { style: S.label }, bind(t, 'advancedSwitch')),
                h('input', {
                  style: S.input,
                  type: 'number',
                  min: 0,
                  max: 50,
                  value: advSwitch,
                  onChange: function (event) { setAdvSwitch(event.target.value) },
                }),
                h('span', { style: S.hintTiny }, bind(t, 'advancedSwitchHint')))),
            h('div', { key: 'queue', style: S.field },
              h('span', { style: S.label }, bind(t, 'advancedQueue')),
              h('input', {
                style: S.input,
                type: 'number',
                min: 15,
                max: 180,
                value: advQueue,
                onChange: function (event) { setAdvQueue(event.target.value) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'advancedQueueHint'))),
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
            h('div', { key: 'btn', style: S.row },
              h('button', {
                type: 'button',
                style: S.button,
                disabled: busy === 'advanced',
                onClick: saveAdvanced,
              }, busy === 'advanced' ? bind(t, 'saving') : bind(t, 'advancedSave')),
              advSaved ? h('span', { style: S.hintTiny }, bind(t, 'advancedSaved')) : null)),
        ),
      )

      // ── 模型 ────────────────────────────────────────────────────
      var models = active.models || []
      var available = models.filter(function (row) { return !row.unavailable || row.forced })
      var unavailable = models.filter(function (row) { return row.unavailable && !row.forced })
      var probe = status.probe || {}
      var query = searchDraft.trim().toLowerCase()
      var matches = function (row) {
        if (query === '') return true
        return row.name.toLowerCase().indexOf(query) !== -1 || row.id.toLowerCase().indexOf(query) !== -1
      }
      var shown = available.filter(matches)

      var modelMetaText = function (model) {
        var parts = [formatWindow(model.contextWindow)]
        parts.push(model.reasoningEfforts && model.reasoningEfforts.length > 0
          ? model.reasoningEfforts.join('/')
          : bind(t, 'noReasoning'))
        if (model.supportsImages) parts.push('图')
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
              : h('button', { type: 'button', style: S.buttonGhost, onClick: function () { setAllModels(active, false) }, disabled: busy === 'save' }, bind(t, 'showAll')),
            models.length === 0
              ? null
              : h('button', { type: 'button', style: S.buttonGhost, onClick: function () { setAllModels(active, true) }, disabled: busy === 'save' }, bind(t, 'hideAll'))),
          models.length > 6
            ? h('input', {
                style: S.input,
                type: 'search',
                value: searchDraft,
                placeholder: bind(t, 'searchPlaceholder'),
                onChange: function (event) { setSearchDraft(event.target.value) },
              })
            : null,
          h('div', { key: 'probe', style: S.row },
            h('button', { type: 'button', style: S.button, onClick: runProbeNow, disabled: busy === 'probe' || models.length === 0 },
              busy === 'probe' ? bind(t, 'probing') : bind(t, 'probe')),
            h('span', { style: S.modelMeta },
              probe.lastRunAt > 0
                ? bind(t, 'probeLast', { time: formatTime(probe.lastRunAt) })
                : bind(t, 'probeNever'))),
          h('p', { key: 'probehint', style: S.hintTiny }, bind(t, 'probeHint')),
          models.length === 0
            ? h('p', { key: 'nomodels', style: S.hint }, bind(t, 'noModels'))
            : shown.length === 0
              ? h('p', { key: 'nomatch', style: S.hint }, bind(t, 'searchEmpty'))
              : h('ul', { key: 'list', style: S.modelList },
                shown.map(function (model, index) {
                  return h('li', {
                    key: model.id,
                    style: Object.assign({}, S.modelRow, index > 0 ? S.modelRowDivider : {}),
                  },
                  h('input', {
                    type: 'checkbox',
                    checked: !model.disabled,
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
                  checked: false,
                  onChange: function () { toggleModel(active, model) },
                }),
                h('span', { style: S.modelMeta }, model.name),
                h('span', { style: S.badge }, bind(t, 'unavailable')),
                h('span', { style: S.grow }),
                h('span', { style: S.modelId }, model.id))
              })),
          ),
        )
      }

      if (forcedCount(active) > 0) {
        sections.push(h('p', { key: 'forced', style: S.hintTiny }, bind(t, 'forced') + '：' + forcedCount(active)))
      }

      // ── 诊断 ────────────────────────────────────────────────────
      sections.push(
        h('div', { key: 'diag', style: S.section },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, bind(t, 'diagnostics')),
            h('span', { style: S.grow }),
            h('button', { type: 'button', style: S.buttonGhost, onClick: function () { setShowDiag(!showDiag) } },
              showDiag ? bind(t, 'hide') : bind(t, 'show')),
            h('button', { type: 'button', style: S.buttonGhost, onClick: copyDiagnostics },
              copied ? bind(t, 'copied') : bind(t, 'copyDiagnostics'))),
          showDiag ? h('pre', { key: 'pre', style: S.pre }, JSON.stringify(status, null, 2)) : null),
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
                  label: function () { return SHARED_SECTION_LABEL },
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

        useEffect(function () {
          var disposed = false
          var handles = []
          var interval

          /** 这份状态里有没有可用的额度数字。 */
          var hasCredits = function (document) {
            var list = document && Array.isArray(document.providers) ? document.providers : []
            for (var index = 0; index < list.length; index++) {
              var snapshot = list[index].credits
              if (snapshot !== undefined && snapshot.state === 'ok') return true
            }
            return false
          }

          var load = function () {
            fetchStatus(true)
              .then(function (document) {
                if (disposed) return
                setStatus(document)
                if (hasCredits(document)) settle()
              })
              .catch(function () {
                /* 侧栏小卡不该弹错误；读不到就保持原样 */
              })
          }

          /** 进入常态轮询（只进一次）。 */
          var settle = function () {
            if (interval !== undefined || disposed) return
            interval = setInterval(load, 60000)
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

          return function () {
            disposed = true
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
              setStatus(document)
              setBusy(false)
            })
            .catch(function () {
              setBusy(false)
              setFailed(true)
              setTimeout(function () { setFailed(false) }, 1600)
            })
        }

        var providers = status && Array.isArray(status.providers) ? status.providers : []
        var sidebarAlertSettings = (status && status.settings && status.settings.alerts) || {}
        var sidebarAlertRatio = typeof sidebarAlertSettings.lowRatio === 'number' ? sidebarAlertSettings.lowRatio : LOW_CREDITS_RATIO
        var sidebarShowUsage = !(status && status.settings && status.settings.showUsageInSidebar === false)
        var rows = []
        for (var index = 0; index < providers.length; index++) {
          var entry = providers[index]
          if (entry.enabled === false) continue
          var credits = entry.credits
          if (credits === undefined || credits.state !== 'ok') continue
          rows.push({ entry: entry, credits: credits })
        }
        if (rows.length === 0) {
          // 已经拿到状态、但没有任何可用额度时，仍然留一个极淡的入口：
          // 完全消失会让用户以为插件没装，反而更困惑。
          if (providers.length === 0) return null
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
                  color: 'var(--dsw-alias-label-tertiary)',
                  fontSize: 12,
                  opacity: 0.75,
                },
              },
              h('span', {}, bind(t, 'summary') + ' —'),
              h('span', {}, bind(t, 'creditsNone')),
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

        var segments = rows.map(function (row, position) {
          var snapshot = row.credits
          var accent = PROVIDER_ACCENT[row.entry.provider] || 'currentColor'
          var warn = isCreditsLow(snapshot, sidebarAlertRatio)
          var stale = snapshot.stale === true
          var dotColor = warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : accent
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
                paddingLeft: position > 0 ? 8 : 0,
                borderLeft: position > 0 ? '0.5px solid var(--dsw-alias-border-l2)' : 'none',
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
            h('span', { style: { fontSize: 10.5, letterSpacing: '.02em', opacity: stale ? 0.45 : 0.62 } }, shortProviderName(row.entry.provider)),
            h(
              'span',
              {
                style: {
                  fontWeight: 650,
                  fontSize: 13,
                  fontVariantNumeric: 'tabular-nums',
                  color: warn
                    ? 'var(--dsw-alias-state-warning-primary, #b26b00)'
                    : 'var(--dsw-alias-label-primary, inherit)',
                  opacity: stale ? 0.65 : 1,
                },
              },
              snapshot.unlimited === true ? '∞' : compactNumber(snapshot.remain),
            ),
          )
        })

        var visibleSegments = wide ? segments : segments.slice(0, 1)

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
            'aria-controls': PANEL_ID,
            'aria-label': rows
              .map(function (row) {
                return row.entry.displayName + ' ' + formatCreditsText(row.credits, t)
              })
              .join('，'),
            style: {
              font: 'inherit',
              display: 'inline-flex',
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
              borderRadius: 999,
              border: '0.5px solid ' + (
                failed
                  ? 'var(--dsw-alias-state-error-primary, #b3261e)'
                  : expanded === true || hovered
                    ? 'var(--dsw-alias-border-l3, var(--dsw-alias-border-l2))'
                    : 'var(--dsw-alias-border-l2)'
              ),
              background: expanded === true
                ? 'var(--dsw-alias-bg-l2, rgba(127,127,127,.10))'
                : hovered
                  ? 'var(--dsw-alias-bg-l2, rgba(127,127,127,.08))'
                  : 'var(--dsw-alias-bg-l1, transparent)',
              boxShadow: hovered && expanded !== true ? '0 1px 4px rgba(0,0,0,.08)' : 'none',
              color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary))',
              transition: 'background .12s ease, border-color .12s ease, box-shadow .12s ease',
              opacity: busy ? 0.72 : 1,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
            },
          },
          visibleSegments,
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
              background: 'var(--dsw-alias-bg-l1, transparent)',
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
            h('span', { style: { fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', opacity: 0.6 } }, bind(t, 'credits')),
            h('span', { style: microChip() }, bind(t, 'creditsSources', { count: rows.length })),
            h('span', { style: { flex: 1 } }),
            latestFetched > 0
              ? h('span', { style: { fontSize: 10, opacity: 0.45, whiteSpace: 'nowrap' } }, bind(t, 'creditsFetchedAt', { time: formatShortTime(latestFetched) }))
              : null,
          ),
          rows.map(function (row, index) {
            var snapshot = row.credits
            var warn = isCreditsLow(snapshot, sidebarAlertRatio)
            var alert = alertOfCredits(snapshot, sidebarAlertRatio, row.entry.provider)
            var qoderFree = isQoderFreePlan(row.entry.provider, snapshot)
            var exhausted = snapshot.state === 'ok' && (snapshot.exceeded === true || (typeof snapshot.remain === 'number' && snapshot.remain <= 0))
            var accent = PROVIDER_ACCENT[row.entry.provider] || 'currentColor'
            var percent = creditsPercentOf(snapshot)
            var parts = creditsValueParts(snapshot, t)
            var ratio
            if (snapshot.unlimited !== true && typeof snapshot.total === 'number' && snapshot.total > 0 && typeof snapshot.remain === 'number') {
              ratio = Math.max(0, Math.min(1, snapshot.remain / snapshot.total))
            }
            var todayUsage = row.entry.usage && row.entry.usage.today
            var activeAccount = (row.entry.accounts || []).filter(function (account) { return account.active === true })[0]
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
            if (problem !== undefined) meta.push(h('span', { key: 'problem', style: microChip('var(--dsw-alias-state-warning-primary, #b26b00)'), title: problemDetail }, problem))
            if (snapshot.planName !== undefined && snapshot.planName !== '') meta.push(h('span', { key: 'plan', style: microChip() }, snapshot.planName))
            if (percent !== undefined) meta.push(h('span', { key: 'pct', style: microChip(warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : accent) }, bind(t, 'creditsPercent', { percent: percent })))
            if (activeAccount !== undefined && problem === undefined) meta.push(h('span', { key: 'acc', style: { fontSize: 10.5, opacity: 0.6, maxWidth: 108, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bind(t, 'creditsCurrent', { label: activeAccount.label })))
            if (snapshot.resetAtMs > 0) meta.push(h('span', { key: 'reset', style: { fontSize: 10.5, opacity: 0.55, whiteSpace: 'nowrap' } }, bind(t, 'creditsResetShort', { date: formatShortDate(snapshot.resetAtMs) })))
            if (sidebarShowUsage && todayUsage !== undefined && todayUsage.requests > 0) meta.push(h('span', { key: 'today', style: { fontSize: 10.5, opacity: 0.55, whiteSpace: 'nowrap' } }, bind(t, 'creditsToday', { count: todayUsage.requests, tokens: formatNumber(todayUsage.totalTokens || 0) })))
            if (snapshot.stale === true) meta.push(h('span', { key: 'cached', style: microChip() }, bind(t, 'creditsCached')))
            var trend = snapshot.trend
            var hasTrend = trend !== null && typeof trend === 'object' && trend.sampleCount > 0
            var trendLine = hasTrend
              ? h('div', { key: 'trend', style: { display: 'flex', alignItems: 'center', gap: 7, marginTop: 5, minWidth: 0 } },
                  h('span', { style: { fontSize: 10.5, opacity: 0.6, whiteSpace: 'nowrap' } }, bind(t, 'trendToday', { value: formatNumber(trend.spentToday || 0) })),
                  typeof trend.etaMs === 'number' && trend.etaMs > 0
                    ? h('span', { style: { fontSize: 10.5, opacity: 0.6, whiteSpace: 'nowrap', color: warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : undefined } }, bind(t, 'trendEta', { duration: formatCompactDuration(trend.etaMs) }))
                    : null,
                  h('span', { style: { flex: '1 1 40px', minWidth: 24, display: 'flex', alignItems: 'center' } },
                    sparkline(trend.points, warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : accent)))
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
                    background: warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : accent,
                  }, snapshot.stale === true
                    ? { background: 'transparent', boxShadow: 'inset 0 0 0 1.5px ' + (warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : accent) }
                    : {}),
                }),
                h('span', { style: { fontSize: 12, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.entry.displayName),
                exhausted ? h('span', { style: microChip('var(--dsw-alias-state-warning-primary, #b26b00)') }, bind(t, qoderFree ? 'creditsFreeQueue' : 'creditsExhausted')) : null,
                alert === 'low' ? h('span', { style: microChip('var(--dsw-alias-state-warning-primary, #b26b00)') }, bind(t, 'alertLow')) : null,
                h('span', { style: { flex: 1, minWidth: 4 } }),
                h(
                  'span',
                  {
                    title: formatCreditsText(snapshot, t),
                    style: { display: 'inline-flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap', flex: '0 0 auto' },
                  },
                  h('span', { style: { fontSize: 19, lineHeight: '22px', fontWeight: 650, fontVariantNumeric: 'tabular-nums', color: warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : 'var(--dsw-alias-label-primary)' } }, parts.big),
                  parts.small !== '' ? h('span', { style: { fontSize: 10.5, opacity: 0.55 } }, parts.small) : null,
                  parts.unit !== '' ? h('span', { style: { fontSize: 10.5, opacity: 0.55 } }, parts.unit) : null,
                ),
              ),
              ratio === undefined
                ? null
                : h(
                    'div',
                    { style: { marginTop: 6, height: 4, borderRadius: 999, background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.16))', overflow: 'hidden' } },
                    h('div', {
                      style: {
                        width: Math.round(ratio * 100) + '%',
                        height: '100%',
                        borderRadius: 999,
                        background: warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : accent,
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
            h('span', { style: { fontSize: 10.5, opacity: 0.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              anyStale ? bind(t, 'creditsCachedHint') : bind(t, 'pillHint')),
            h('span', { style: { flex: 1 } }),
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

