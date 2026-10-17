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
      catalogBuiltin: '内置兜底列表（上游不可达且没有存档）',
      summary: '账号总览',
      secStatus: '状态',
      secConnection: '连接设置',
      show: '展开',
      hide: '收起',
      secAccounts: '账号',
      autoSwitch: '额度用完自动切换',
      accountsHintPat: '可以为同一个 provider 添加多个 PAT；当前账号积分用完后会按上面的开关自动切换。',
      accountsHintDesktop: '桌面账号从本机登录文件读取。多个账号请填各自的登录文件路径。',
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
      checkinOff: '签到已关闭',
      checkinNever: '还没有签到记录',
      checkinClaimed: '本次签到成功：{count} 个账号，+{credit} 积分',
      checkinAlready: '今天已签到',
      checkinInactive: '当前账号没有签到活动',
      checkinFailed: '签到失败：{reason}',
      checkinLastAt: '上次 {time}',
      loginAdd: '浏览器登录新增账号',
      loginOpening: '正在打开…',
      loginCancel: '取消',
      loginOpenManually: '没有自动打开？点这里',
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
      catalogBuiltin: 'Built-in fallback list (upstream unreachable, no saved catalog)',
      summary: 'Accounts',
      secStatus: 'Status',
      secConnection: 'Connection',
      show: 'Expand',
      hide: 'Collapse',
      secAccounts: 'Accounts',
      autoSwitch: 'Switch when out of credits',
      accountsHintPat: 'Add more than one PAT per provider; when the current account runs out, it switches automatically.',
      accountsHintDesktop: 'Desktop accounts are read from local sign-in files; give each extra account its own file path.',
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
      checkinOff: 'Daily check-in is off',
      checkinNever: 'No check-in yet',
      checkinClaimed: 'Checked in: {count} account(s), +{credit} credits',
      checkinAlready: 'Already checked in today',
      checkinInactive: 'No check-in activity for this account',
      checkinFailed: 'Check-in failed: {reason}',
      checkinLastAt: 'Last run {time}',
      loginAdd: 'Add account via browser login',
      loginOpening: 'Opening…',
      loginCancel: 'Cancel',
      loginOpenManually: 'Not opened? Click here',
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
    function isCreditsLow(credits) {
      if (credits.unlimited === true) return false
      if (credits.exceeded === true) return true
      if (typeof credits.remain === 'number' && credits.remain <= 0) return true
      if (typeof credits.total === 'number' && credits.total > 0 && typeof credits.remain === 'number') {
        return credits.remain / credits.total < LOW_CREDITS_RATIO
      }
      return false
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
    function fetchStatus() {
      return fetch(STATUS_PATH, { headers: { Accept: 'application/json' } }).then(function (response) {
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

    function formatTime(ms) {
      if (ms === undefined || ms === null || ms === 0) return '—'
      try {
        return new Date(ms).toLocaleString()
      } catch (_) {
        return String(ms)
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

      var savePat = function () {
        if (active === undefined) return
        var patch = { qoder: {} }
        patch.qoder[active.provider] = { pat: patDraft.trim() }
        mutate(patch)
      }

      var clearPat = function () {
        if (active === undefined) return
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
        var text = JSON.stringify(status === undefined ? { error: error } : status, null, 2)
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            setCopied(true)
            setTimeout(function () { setCopied(false) }, 1500)
          }, function () {})
        }
      }

      if (status === undefined) {
        return h(
          'div',
          { style: S.card },
          h('p', { style: error === undefined ? S.hint : S.hintError }, error === undefined ? bind(t, 'loading') : bind(t, 'error') + '：' + error),
        )
      }

      var tabs = providers.map(function (entry) {
        var signed = entry.credential !== undefined && entry.credential !== null && entry.credential.status === 'signed-in'
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
            h('span', { style: dot(signed ? DOT_OK : DOT_OFF) }),
            entry.displayName,
          ),
        )
      })

      // 账号总览：一行小胶囊，不用切标签就能横向对比四家余额。
      var overview = []
      for (var overviewIndex = 0; overviewIndex < providers.length; overviewIndex++) {
        var overviewEntry = providers[overviewIndex]
        if (overviewEntry.enabled === false) continue
        var overviewCredits = overviewEntry.credits
        if (overviewCredits === undefined || overviewCredits.state !== 'ok') continue
        overview.push(h(
          'span',
          {
            key: overviewEntry.provider,
            style: {
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 6,
              padding: '3px 10px',
              borderRadius: 999,
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.06))',
            },
          },
          h('span', { style: { fontSize: TEXT.tiny, color: 'var(--dsw-alias-label-tertiary)' } }, overviewEntry.displayName),
          h('span', {
            style: {
              fontSize: TEXT.strong,
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              color: isCreditsLow(overviewCredits)
                ? 'var(--dsw-alias-state-warning-primary, #b26b00)'
                : 'var(--dsw-alias-label-primary)',
            },
          }, overviewCredits.unlimited === true ? bind(t, 'creditsUnlimited') : formatNumber(overviewCredits.remain)),
        ))
      }

      var sections = [
        h('div', { key: 'head', style: S.header },
          h('h3', { style: S.title }, bind(t, 'title')),
          // 版本号：排查问题时第一件要问的就是「你装的是哪一版」。
          h('span', { style: S.version }, 'v' + (status.plugin && status.plugin.version ? status.plugin.version : '?'))),
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
        overview.length === 0
          ? null
          : h('div', { key: 'overview', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: S.sectionTitle }, bind(t, 'summary')),
              ...overview),
        h('div', { key: 'tabs', style: S.tabs }, tabs),
      ]

      if (active === undefined) {
        sections.push(h('p', { key: 'empty', style: S.hint }, bind(t, 'noModels')))
        return h('div', { style: S.card }, sections)
      }

      // ── 状态 ────────────────────────────────────────────────────
      var credential = active.credential || {}
      var catalogText =
        active.catalogSource === 'live'
          ? bind(t, 'catalogLive') + ' · ' + formatTime(active.fetchedAt)
          : active.catalogSource === 'saved'
            ? bind(t, 'catalogSaved') + ' · ' + formatTime(active.fetchedAt)
            : active.catalogSource === 'builtin'
              ? bind(t, 'catalogBuiltin')
              : bind(t, 'catalogNone')

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
            }, credential.status === 'signed-in' ? bind(t, 'signedIn') : bind(t, 'signedOut'))),
          h('p', { key: 'cat', style: S.hintTiny }, catalogText),
          credential.status === 'signed-in' && credential.email
            ? h('p', { key: 'who', style: S.hintTiny }, credential.email)
            : null,
          credential.status !== 'signed-in' && credential.message
            ? h('p', { key: 'why', style: S.hintWarn }, credential.message)
            : null,
          active.message ? h('p', { key: 'msg', style: S.hintWarn }, active.message) : null),
      )

      // ── 账号 ────────────────────────────────────────────────────
      //
      // 多账号的意义：一个账号的积分用完了，自动/手动切到另一个还能用的账号。
      // 这里只做「增删与选定」，PAT 本身从不回传给浏览器（状态文档里没有）。
      var accountRows = Array.isArray(active.accounts) ? active.accounts : []
      var isPatProvider = active.kind === 'pat'
      var loginJob = active.login
      var accountItems = accountRows.map(function (account, index) {
        var snapshot = account.credits || { state: 'none' }
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
        h('span', { style: S.grow }),
        h('span', { style: S.modelMeta }, creditsText(snapshot)),
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
                var list = accountRows
                  .filter(function (row) { return row.id !== account.id })
                  .map(function (row) {
                    return {
                      id: row.id,
                      label: row.label,
                      enabled: row.enabled !== false,
                      ...(row.authFile === undefined || row.authFile === '' ? {} : { authFile: row.authFile }),
                    }
                  })
                var patch = { accounts: {} }
                patch.accounts[active.provider] = list
                mutate(patch)
              },
            }, bind(t, 'removeAccount'))
          : null)
      })

      var addAccount = function () {
        var secret = accSecret.trim()
        var label = accLabel.trim() === '' ? bind(t, 'accountDefaultLabel') : accLabel.trim()
        var list = accountRows.map(function (row) {
          return {
            id: row.id,
            label: row.label,
            enabled: row.enabled !== false,
            ...(row.authFile === undefined || row.authFile === '' ? {} : { authFile: row.authFile }),
          }
        })
        var next = { id: 'acc-' + String(Date.now()), label: label, enabled: true }
        if (isPatProvider) {
          if (secret === '') return
          next.pat = secret
        } else if (secret !== '') {
          next.authFile = secret
        }
        list.push(next)
        var patch = { accounts: {}, activeAccount: {} }
        patch.accounts[active.provider] = list
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
      if (checkin.enabled === false) {
        checkinLabel = bind(t, 'checkinOff')
      } else if (checkinResult === undefined) {
        checkinLabel = bind(t, 'checkinNever')
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
          checkinLabel = bind(t, 'checkinFailed', {
            reason: (checkinResult.outcomes.find(function (item) { return item.kind === 'failed' }) || {}).message || '—',
          })
          checkinTone = 'hintWarn'
        } else {
          checkinLabel = bind(t, 'checkinNever')
        }
      }

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
            h('span', { style: S[checkinTone] }, checkinLabel),
            checkin.lastRunAt > 0
              ? h('span', { style: S.modelMeta }, bind(t, 'checkinLastAt', { time: formatTime(checkin.lastRunAt) }))
              : null),
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
          h('div', { key: 'add', style: S.stack },
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
                disabled: busy === 'accounts' || (isPatProvider && accSecret.trim() === ''),
                onClick: addAccount,
              }, bind(t, 'addAccount'))),
            h('input', {
              key: 'secret',
              style: S.input,
              type: isPatProvider ? 'password' : 'text',
              value: accSecret,
              placeholder: bind(t, isPatProvider ? 'accountPat' : 'accountAuthFile'),
              onChange: function (event) { setAccSecret(event.target.value) },
            }),
            h('span', { key: 'sec', style: S.hintTiny }, bind(t, 'accountSecretHint'))),
        ),
      )

      // ── 积分 ────────────────────────────────────────────────────
      var credits = active.credits || { state: 'none' }
      var creditsLow = credits.state === 'ok' && isCreditsLow(credits)
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
            credits.exceeded ? h('span', { style: S.badgeWarn }, bind(t, 'creditsExhausted')) : null,
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
            fetchStatus()
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
        var rows = []
        for (var index = 0; index < providers.length; index++) {
          var entry = providers[index]
          if (entry.enabled === false) continue
          var credits = entry.credits
          if (credits === undefined || credits.state !== 'ok') continue
          rows.push({ entry: entry, credits: credits })
        }
        if (rows.length === 0) return null

        var wide = props.wide !== false

        var toggle = function (event) {
          if (event !== undefined && event.preventDefault !== undefined) event.preventDefault()
          // 收起成 56px 轨道时没有横向空间，点一下只刷新。
          if (!wide) {
            refresh(event)
            return
          }
          setExpanded(!expanded)
        }

        var segments = rows.map(function (row, position) {
          var snapshot = row.credits
          var accent = PROVIDER_ACCENT[row.entry.provider] || 'currentColor'
          var warn = isCreditsLow(snapshot)
          return h(
            'span',
            {
              key: row.entry.provider,
              style: { display: 'inline-flex', alignItems: 'baseline', gap: 4 },
            },
            position === 0 || wide
              ? h('span', {
                  style: {
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    alignSelf: 'center',
                    background: warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : accent,
                    opacity: 0.9,
                    flex: '0 0 auto',
                  },
                })
              : null,
            h('span', { style: { fontSize: 11, letterSpacing: '.02em', opacity: 0.62 } }, shortProviderName(row.entry.provider)),
            h(
              'span',
              {
                style: {
                  fontWeight: 600,
                  fontSize: 13,
                  color: warn
                    ? 'var(--dsw-alias-state-warning-primary, #b26b00)'
                    : 'var(--dsw-alias-label-primary, inherit)',
                  opacity: snapshot.stale === true ? 0.6 : 1,
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
              gap: 10,
              boxSizing: 'border-box',
              maxWidth: '100%',
              minWidth: 0,
              padding: wide ? '4px 11px' : '4px 7px',
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
              padding: '10px 12px',
              background: 'var(--dsw-alias-bg-l1, transparent)',
              maxHeight: '46vh',
              overflowY: 'auto',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 13,
              lineHeight: '20px',
            },
          },
          h('div', { style: { fontSize: 11.5, opacity: 0.6, marginBottom: 6 } }, bind(t, 'credits')),
          rows.map(function (row) {
            var snapshot = row.credits
            var warn = isCreditsLow(snapshot)
            var ratio
            if (snapshot.unlimited === true) ratio = undefined
            else if (typeof snapshot.total === 'number' && snapshot.total > 0) {
              ratio = Math.max(0, Math.min(1, snapshot.remain / snapshot.total))
            }
            var note = []
            if (snapshot.planName !== undefined && snapshot.planName !== '') note.push(snapshot.planName)
            if (snapshot.resetAtMs > 0) note.push(bind(t, 'creditsReset') + ' ' + formatTime(snapshot.resetAtMs))
            return h(
              'div',
              { key: row.entry.provider, style: { marginBottom: 8 } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                h('span', {
                  style: {
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    alignSelf: 'center',
                    flex: '0 0 auto',
                    background: warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : (PROVIDER_ACCENT[row.entry.provider] || 'currentColor'),
                  },
                }),
                h('span', { style: { fontSize: 11.5, opacity: 0.7, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.entry.displayName),
                h('span', { style: { flex: 1, minWidth: 4 } }),
                h('span', {
                  style: {
                    fontWeight: 600,
                    fontSize: 12.5,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                    color: warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : 'var(--dsw-alias-label-primary)',
                    opacity: snapshot.stale === true ? 0.7 : 1,
                  },
                }, formatCreditsText(snapshot, t)),
              ),
              ratio === undefined
                ? null
                : h(
                    'div',
                    {
                      style: {
                        marginTop: 4,
                        height: 3,
                        borderRadius: 999,
                        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.16))',
                        overflow: 'hidden',
                      },
                    },
                    h('div', {
                      style: {
                        width: Math.round(ratio * 100) + '%',
                        height: '100%',
                        borderRadius: 999,
                        background: warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : (PROVIDER_ACCENT[row.entry.provider] || 'currentColor'),
                        opacity: 0.85,
                      },
                    }),
                  ),
              note.length === 0
                ? null
                : h('div', { style: { fontSize: 11, opacity: 0.55, marginTop: 2 } }, note.join(' · ')),
            )
          }),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                borderTop: '0.5px solid var(--dsw-alias-border-l2)',
                paddingTop: 7,
                marginTop: 2,
              },
            },
            h('span', { style: { fontSize: 11, opacity: 0.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              rows.some(function (row) { return row.credits.stale === true }) ? bind(t, 'creditsStale') : bind(t, 'pillHint')),
            h('span', { style: { flex: 1 } }),
            h('button', {
              type: 'button',
              onClick: refresh,
              style: {
                font: 'inherit',
                fontSize: 11.5,
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

