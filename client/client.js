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

    /** 页面级浮层（根作用域），用来画悬停气泡，避开侧栏的裁剪。 */
    var OVERLAY_SLOT = 'shell.overlay'

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

    /**
     * 侧栏小卡的悬停气泡状态。
     *
     * 为什么用模块级 store + `shell.overlay`，而不是在小卡里直接渲染一个绝对定位的面板：
     * 侧栏在收起时会做位移与裁剪（`overflow: hidden`），`absolute` 面板会被切掉；
     * `fixed` 又会被祖先的 transform 改变定位基准。宿主的 overlay 是页面级根作用域，
     * 放那里才稳。这也是本机 dsh-balance-pill 处理同类问题的做法。
     *
     * 状态只存「已格式化的行」，overlay 组件不依赖小卡的闭包。
     */
    var pillHover = {
      visible: false,
      rect: undefined,
      /** 侧栏（气泡可用宽度）的边界，`{left, right, width}`；量不到时为 undefined。 */
      bounds: undefined,
      rows: [],
      hint: '',
      listeners: new Set(),
      /** 由小卡每次渲染时挂上：气泡里的「刷新额度」按钮要能触发它。 */
      onRefresh: undefined,
    }

    /** 气泡延迟关闭的句柄。 */
    var pillHideTimer

    /** 立刻收起气泡。 */
    function hidePillHoverNow() {
      if (pillHideTimer !== undefined) {
        clearTimeout(pillHideTimer)
        pillHideTimer = undefined
      }
      setPillHover({ visible: false, rows: [], hint: '' })
    }

    /**
     * 延迟关闭。
     *
     * 为什么需要：气泡在胶囊上方、中间隔着 8px 空隙。鼠标从胶囊移向气泡时会先触发
     * `mouseleave` —— 立刻关闭的话，用户永远够不到气泡里的按钮（这正是「根本没法点」
     * 的原因）。留 160ms 的窗口让鼠标走进气泡，进去后 `mouseenter` 会取消这个计时。
     */
    function schedulePillHide(delay) {
      if (pillHideTimer !== undefined) clearTimeout(pillHideTimer)
      pillHideTimer = setTimeout(hidePillHoverNow, delay === undefined ? 160 : delay)
    }

    /** 取消待执行的关闭。 */
    function cancelPillHide() {
      if (pillHideTimer !== undefined) {
        clearTimeout(pillHideTimer)
        pillHideTimer = undefined
      }
    }

    /** 更新气泡状态并通知订阅者。 */
    function setPillHover(next) {
      pillHover.visible = next.visible === true
      pillHover.rect = next.rect
      pillHover.bounds = next.bounds
      pillHover.rows = next.rows === undefined ? [] : next.rows
      pillHover.hint = next.hint === undefined ? '' : next.hint
      pillHover.listeners.forEach(function (listener) {
        try {
          listener()
        } catch (failure) {
          console.error('[dsh-reverse-proxy-connect] 气泡订阅者报错', failure)
        }
      })
    }

    /** 气泡偏好的宽度；侧栏更窄时会自动收敛到侧栏宽度。 */
    var PREFERRED_BUBBLE_WIDTH = 300

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
    var S = {
      card: {
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: 'var(--dsw-alias-bg-l1, transparent)',
      },
      header: { display: 'flex', alignItems: 'center', gap: 8 },
      title: { margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      badge: {
        fontSize: 11.5,
        lineHeight: '17px',
        padding: '0 6px',
        borderRadius: 999,
        border: '0.5px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      badgeWarn: {
        fontSize: 11.5,
        lineHeight: '17px',
        padding: '0 6px',
        borderRadius: 999,
        border: '0.5px solid var(--dsw-alias-state-warning-primary, #b26b00)',
        color: 'var(--dsw-alias-state-warning-primary, #b26b00)',
      },
      version: {
        marginLeft: 'auto',
        fontSize: 11.5,
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-tertiary)',
        opacity: 0.8,
        userSelect: 'text',
      },
      creditsValue: {
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      grow: { flex: 1, minWidth: 0 },
      hint: { margin: 0, fontSize: 12.5, lineHeight: '19px', color: 'var(--dsw-alias-label-tertiary)' },
      hintWarn: { margin: 0, fontSize: 12.5, lineHeight: '19px', color: 'var(--dsw-alias-state-warning-primary, #b26b00)' },
      hintError: { margin: 0, fontSize: 12.5, lineHeight: '19px', color: 'var(--dsw-alias-state-error-primary, #b3261e)' },
      button: {
        font: 'inherit',
        fontSize: 12.5,
        padding: '3px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      },
      buttonPrimary: {
        font: 'inherit',
        fontSize: 12.5,
        padding: '3px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        border: '0.5px solid var(--dsw-alias-state-business-primary, #2f6fed)',
        background: 'var(--dsw-alias-state-business-primary, #2f6fed)',
        color: '#fff',
      },
      input: {
        font: 'inherit',
        fontSize: 12.5,
        padding: '4px 8px',
        borderRadius: 6,
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-l2, transparent)',
        color: 'var(--dsw-alias-label-primary)',
        width: '100%',
        boxSizing: 'border-box',
      },
      modelList: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        maxHeight: 280,
        overflowY: 'auto',
        margin: 0,
        padding: 0,
        listStyle: 'none',
      },
      modelRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, lineHeight: '21px' },
      modelName: { color: 'var(--dsw-alias-label-primary)' },
      modelMeta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5 },
      divider: { height: 0, borderTop: '0.5px solid var(--dsw-alias-border-l2)', margin: '2px 0' },
      tabs: { display: 'flex', gap: 14, borderBottom: '0.5px solid var(--dsw-alias-border-l2)' },
      pre: {
        margin: 0,
        padding: 8,
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-l2, rgba(0,0,0,.04))',
        fontSize: 11.5,
        lineHeight: '17px',
        maxHeight: 220,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
    }

    function tabStyle(active) {
      return {
        font: 'inherit',
        fontSize: 12,
        padding: '5px 1px 7px',
        background: 'none',
        border: 0,
        cursor: 'pointer',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
        borderBottom: active ? '2px solid var(--dsw-alias-label-primary)' : '2px solid transparent',
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
        return h('div', { style: S.card }, h('p', { style: error === undefined ? S.hint : S.hintError }, error === undefined ? bind(t, 'loading') : bind(t, 'error') + '：' + error))
      }

      var tabs = providers.map(function (entry) {
        return h(
          'button',
          {
            key: entry.provider,
            type: 'button',
            style: tabStyle(entry.provider === activeTab),
            onClick: function () { setActiveTab(entry.provider) },
          },
          entry.displayName,
          entry.credential && entry.credential.status === 'signed-in' ? '' : ' ·',
        )
      })

      var sections = [
        h('div', { key: 'head', style: S.header },
          h('h3', { style: S.title }, bind(t, 'title')),
          // 版本号：排查问题时第一件要问的就是「你装的是哪一版」。
          h('span', { style: S.version }, 'v' + (status.plugin && status.plugin.version ? status.plugin.version : '?'))),
        h('p', { key: 'intro', style: S.hint }, bind(t, 'intro')),
        h('div', { key: 'row', style: S.row },
          h('button', { type: 'button', style: S.button, onClick: refresh, disabled: busy === 'refresh' },
            busy === 'refresh' ? bind(t, 'refreshing') : bind(t, 'refresh')),
          status.proxy && status.proxy.mode === 'in-process'
            ? h('span', { style: S.badge }, 'in-process')
            : null),
        // 全账号总览：不用切标签就能看到四家各自还剩多少。
        (function () {
          var rows = []
          for (var index = 0; index < providers.length; index++) {
            var entry = providers[index]
            if (entry.enabled === false) continue
            var snapshot = entry.credits
            if (snapshot === undefined || snapshot.state !== 'ok') continue
            rows.push(h('span', { key: entry.provider, style: S.badge },
              entry.displayName + ' ' + (snapshot.unlimited === true ? bind(t, 'creditsUnlimited') : formatNumber(snapshot.remain))))
          }
          if (rows.length === 0) return null
          return h('div', { key: 'summary', style: S.row },
            h('span', { style: S.modelMeta }, bind(t, 'summary')),
            ...rows)
        })(),
        error === undefined ? null : h('p', { key: 'err', style: S.hintError }, bind(t, 'error') + '：' + error),
        h('div', { key: 'tabs', style: S.tabs }, tabs),
      ]

      if (active === undefined) {
        sections.push(h('p', { key: 'empty', style: S.hint }, bind(t, 'noModels')))
        return h('div', { style: S.card }, sections)
      }

      // 服务状态：登录 + 目录来源
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
        h('div', { key: 'svc', style: S.row },
          h('label', { style: Object.assign({}, S.row, { cursor: 'pointer' }) },
            h('input', {
              type: 'checkbox',
              checked: active.enabled !== false,
              onChange: function () { toggleProvider(active) },
            }),
            h('span', { style: { fontSize: 12 } }, bind(t, 'enabled'))),
          h('span', { style: S.badge }, active.kind === 'desktop' ? bind(t, 'kindDesktop') : bind(t, 'kindPat')),
          h('span', {
            style: credential.status === 'signed-in'
              ? S.badge
              : Object.assign({}, S.badge, { color: 'var(--dsw-alias-state-warning-primary, #b26b00)' }),
          }, credential.status === 'signed-in' ? bind(t, 'signedIn') : bind(t, 'signedOut'))),
        h('p', { key: 'cat', style: S.hint }, catalogText),
        credential.status === 'signed-in' && credential.email
          ? h('p', { key: 'who', style: S.hint }, credential.email)
          : null,
        credential.status !== 'signed-in' && credential.message
          ? h('p', { key: 'why', style: S.hintWarn }, credential.message)
          : null,
        active.message ? h('p', { key: 'msg', style: S.hintWarn }, active.message) : null,
      )

      // ── 积分 ──────────────────────────────────────────────────
      var credits = active.credits || { state: 'none' }
      var creditsLine = []
      if (credits.state === 'ok') {
        creditsLine.push(h('span', { key: 'v', style: S.creditsValue }, creditsText(credits)))
        if (credits.planName) creditsLine.push(h('span', { key: 'p', style: S.badge }, credits.planName))
        if (credits.exceeded) creditsLine.push(h('span', { key: 'e', style: S.badgeWarn }, bind(t, 'creditsExhausted')))
        if (credits.resetAtMs) creditsLine.push(h('span', { key: 'r', style: S.modelMeta }, bind(t, 'creditsReset') + ' ' + formatTime(credits.resetAtMs)))
      } else if (credits.state === 'error') {
        creditsLine.push(h('span', { key: 'v', style: S.hintError }, creditsText(credits)))
      } else {
        creditsLine.push(h('span', { key: 'v', style: S.modelMeta }, creditsText(credits)))
      }
      creditsLine.push(h('span', { key: 'g', style: S.grow }))
      creditsLine.push(
        h('button', { key: 'b', type: 'button', style: S.button, onClick: refreshCredits, disabled: busy === 'credits' },
          busy === 'credits' ? bind(t, 'creditsRefreshing') : bind(t, 'creditsRefresh')),
      )
      sections.push(
        h('div', { key: 'credits', style: S.row },
          h('span', { style: S.title }, bind(t, 'credits')),
          ...creditsLine),
      )
      if (credits.state === 'error' && credits.message) {
        sections.push(h('p', { key: 'creditserr', style: S.hintWarn }, bind(t, 'creditsFailed', { message: credits.message })))
      }
      if (Array.isArray(credits.items) && credits.items.length > 0) {
        sections.push(
          h('details', { key: 'creditpkgs' },
            h('summary', { style: Object.assign({}, S.hint, { cursor: 'pointer' }) },
              bind(t, 'creditsPackages', { count: credits.items.length })),
            h('ul', { style: S.modelList },
              credits.items.map(function (item, index) {
                return h('li', { key: 'pkg' + index, style: S.modelRow },
                  h('span', { style: S.modelName }, item.name),
                  h('span', { style: S.modelMeta }, formatNumber(item.remain) + ' / ' + formatNumber(item.total)),
                  item.expired ? h('span', { style: S.badge }, bind(t, 'creditsExhausted')) : null,
                  h('span', { style: S.grow }),
                  h('span', { style: S.modelMeta }, item.endAtMs ? formatTime(item.endAtMs) : ''))
              }))),
        )
      }
      if (credits.fetchedAt > 0) {
        sections.push(h('p', { key: 'creditsat', style: S.hint }, bind(t, 'creditsFetchedAt', { time: formatTime(credits.fetchedAt) })))
      }

      // 凭证配置区
      if (active.kind === 'pat') {
        var configured = status.settings && status.settings.qoder && status.settings.qoder[active.provider] && status.settings.qoder[active.provider].configured
        sections.push(
          h('div', { key: 'dv', style: S.divider }),
          h('p', { key: 'path', style: S.hint }, bind(t, 'pat')),
          h('input', {
            key: 'patinput',
            style: S.input,
            type: 'password',
            value: patDraft,
            placeholder: configured ? bind(t, 'patConfigured', { tail: (credential.patTail || '…') }) : bind(t, 'patPlaceholder'),
            onChange: function (event) { setPatDraft(event.target.value) },
          }),
          h('p', { key: 'pathhint', style: S.hint }, bind(t, 'patHint')),
          h('div', { key: 'patbtn', style: S.row },
            h('button', { type: 'button', style: S.buttonPrimary, onClick: savePat, disabled: busy === 'save' || patDraft.trim() === '' },
              busy === 'save' ? bind(t, 'saving') : bind(t, 'save')),
            h('button', { type: 'button', style: S.button, onClick: clearPat, disabled: busy === 'save' || !configured },
              bind(t, 'clear'))),
        )
      } else {
        sections.push(
          h('div', { key: 'dv', style: S.divider }),
          h('p', { key: 'app', style: S.hint }, bind(t, 'appPath')),
          h('input', {
            key: 'appinput',
            style: S.input,
            type: 'text',
            value: appPathDraft,
            placeholder: 'D:\\WorkBuddy\\WorkBuddy.exe',
            onChange: function (event) { setAppPathDraft(event.target.value) },
          }),
          h('p', { key: 'apphint', style: S.hint }, bind(t, 'appPathHint')),
          h('p', { key: 'auth', style: S.hint }, bind(t, 'authFile')),
          h('input', {
            key: 'authinput',
            style: S.input,
            type: 'text',
            value: authFileDraft,
            placeholder: credential.file || '%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth',
            onChange: function (event) { setAuthFileDraft(event.target.value) },
          }),
          h('p', { key: 'authhint', style: S.hint }, bind(t, 'authFileHint')),
          h('div', { key: 'deskbtn', style: S.row },
            h('button', { type: 'button', style: S.buttonPrimary, onClick: saveDesktop, disabled: busy === 'save' },
              busy === 'save' ? bind(t, 'saving') : bind(t, 'save'))),
        )
      }

      // 模型清单
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
      sections.push(
        h('div', { key: 'dv2', style: S.divider }),
        h('div', { key: 'mh', style: S.row },
          h('span', { style: S.title }, bind(t, 'models') + '（' + models.length + '）'),
          models.length === 0
            ? null
            : h('span', { style: S.grow }),
          models.length === 0
            ? null
            : h('button', { type: 'button', style: S.button, onClick: function () { setAllModels(active, false) }, disabled: busy === 'save' }, bind(t, 'showAll')),
          models.length === 0
            ? null
            : h('button', { type: 'button', style: S.button, onClick: function () { setAllModels(active, true) }, disabled: busy === 'save' }, bind(t, 'hideAll'))),
        models.length > 6
          ? h('input', {
              key: 'search',
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
        h('p', { key: 'probehint', style: S.hint }, bind(t, 'probeHint')),
        h('label', { key: 'rate', style: Object.assign({}, S.row, { cursor: 'pointer' }) },
          h('input', {
            type: 'checkbox',
            checked: status.settings && status.settings.showRateInModelName !== false,
            onChange: function () {
              mutate({ display: { showRateInModelName: !(status.settings && status.settings.showRateInModelName !== false) } })
            },
          }),
          h('span', { style: { fontSize: 12 } }, bind(t, 'modelRateToggle'))),
        h('p', { key: 'ratehint', style: S.hint }, bind(t, 'modelRateHint')),
        models.length === 0
          ? h('p', { key: 'nomodels', style: S.hint }, bind(t, 'noModels'))
          : shown.length === 0
            ? h('p', { key: 'nomatch', style: S.hint }, bind(t, 'searchEmpty'))
            : h('ul', { key: 'list', style: S.modelList },
              shown.map(function (model) {
                return h('li', { key: model.id, style: S.modelRow },
                  h('input', {
                    type: 'checkbox',
                    checked: !model.disabled,
                    onChange: function () { toggleModel(active, model) },
                  }),
                  h('span', { style: S.modelName }, model.name),
                  h('span', { style: S.modelMeta },
                    formatWindow(model.contextWindow) + ' · ' +
                    (model.reasoningEfforts && model.reasoningEfforts.length > 0
                      ? model.reasoningEfforts.join('/')
                      : bind(t, 'noReasoning')) +
                    (model.supportsImages ? ' · 图' : '') +
                    (model.credits ? ' · ' + model.credits : '')),
                  h('span', { style: S.grow }),
                  h('span', { style: S.modelMeta }, model.id),
                )
              })),
      )

      if (unavailable.length > 0) {
        sections.push(
          h('details', { key: 'unavail' },
            h('summary', { style: Object.assign({}, S.hintWarn, { cursor: 'pointer' }) },
              bind(t, 'unavailableCount', { count: unavailable.length })),
            h('p', { style: S.hint }, bind(t, 'unavailableHint')),
            h('ul', { style: S.modelList },
              unavailable.map(function (model) {
                return h('li', { key: model.id, style: S.modelRow },
                  h('input', {
                    type: 'checkbox',
                    checked: false,
                    onChange: function () { toggleModel(active, model) },
                  }),
                  h('span', { style: S.modelMeta }, model.name),
                  h('span', { style: S.badge }, bind(t, 'unavailable')),
                  h('span', { style: S.grow }),
                  h('span', { style: S.modelMeta }, model.id),
                )
              }))),
        )
      }

      if (forcedCount(active) > 0) {
        sections.push(h('p', { key: 'forced', style: S.hint }, bind(t, 'forced') + '：' + forcedCount(active)))
      }

      // 诊断
      sections.push(
        h('div', { key: 'dv3', style: S.divider }),
        h('div', { key: 'diagbtn', style: S.row },
          h('button', { type: 'button', style: S.button, onClick: function () { setShowDiag(!showDiag) } }, bind(t, 'diagnostics')),
          h('button', { type: 'button', style: S.button, onClick: copyDiagnostics }, copied ? bind(t, 'copied') : bind(t, 'copyDiagnostics'))),
        showDiag ? h('pre', { key: 'diag', style: S.pre }, JSON.stringify(status, null, 2)) : null,
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
       * 侧栏常驻积分卡。
       *
       * 挂 `sidebar.footer.action`（宿主侧栏底部那一排），不用开设置就能看到
       * 各账号还剩多少。点击立刻重读一次额度。
       *
       * 视觉上刻意做成「分段胶囊」：每个账号一枚小圆点 + 短名 + 数字，
       * 而不是一整行纯文本 —— 侧栏底部空间窄，纯文本读起来是一团。
       * 数字用主文本色加粗，短名用弱化小字，扫一眼先看到钱再看到是谁。
       */
      var CreditsPill = function (props) {
        var useState = React.useState
        var useEffect = React.useEffect

        var statusState = useState(undefined)
        var status = statusState[0]
        var setStatus = statusState[1]
        var busyState = useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]
        var hoverState = useState(false)
        var hovered = hoverState[0]
        var setHovered = hoverState[1]
        var failedState = useState(false)
        var failed = failedState[0]
        var setFailed = failedState[1]

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
                // 拿到数字就切回 60 秒常态轮询，不再高频打接口。
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
          // 前 10 秒快速重试，避免「DSH 开了十秒积分才出现」那种空窗。
          var retries = [0, 600, 1400, 2600, 4200, 7000, 10000].map(function (delay) {
            return setTimeout(function () {
              if (!disposed && interval === undefined) load()
            }, delay)
          })
          handles = handles.concat(retries)

          // 兜底：12 秒后无论有没有数据都转常态轮询。
          handles.push(setTimeout(settle, 12000))

          return function () {
            disposed = true
            handles.forEach(function (handle) {
              clearTimeout(handle)
              clearInterval(handle)
            })
          }
        }, [])

        // 卸载时把气泡收掉，否则会留在屏幕上没人管。
        useEffect(function () {
          return function () {
            setPillHover({ visible: false, rows: [], hint: '' })
          }
        }, [])

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
              // 静默失败最气人：点了没反应，也不知道是失败还是没变化。
              // 用描边闪一下提示，1.6 秒后自动复原。
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

        /**
         * 鼠标进/出：把锚点矩形与格式化好的行放进模块级 store，
         * 由 overlay 里的组件画气泡（侧栏自身会裁剪，画在这里会被切掉）。
         */
        var showBubble = function (event) {
          cancelPillHide()
          setHovered(true)
          var node = event !== undefined ? event.currentTarget : undefined
          var rect
          var bounds
          if (node !== undefined && typeof node.getBoundingClientRect === 'function') {
            var box = node.getBoundingClientRect()
            rect = { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width }
            // 侧栏有多宽？往上找一层有实际宽度的祖先量出来。
            //
            // 这一步是为了让气泡**不越出侧栏**：早先把宽度写死 296px，
            // 在窄侧栏（实测约 290px）里直接压到对话区去了。
            var ancestor = node.parentElement
            for (var depth = 0; depth < 4 && ancestor !== null && ancestor !== undefined; depth++) {
              if (typeof ancestor.getBoundingClientRect !== 'function') break
              var outer = ancestor.getBoundingClientRect()
              if (outer.width > 60) {
                bounds = { left: outer.left, right: outer.right, width: outer.width }
                break
              }
              ancestor = ancestor.parentElement
            }
          }
          setPillHover({
            visible: true,
            rect: rect,
            bounds: bounds,
            rows: rows.map(function (row) {
              var snapshot = row.credits
              var ratio
              if (snapshot.unlimited === true) ratio = undefined
              else if (typeof snapshot.total === 'number' && snapshot.total > 0) {
                ratio = Math.max(0, Math.min(1, snapshot.remain / snapshot.total))
              }
              return {
                name: row.entry.displayName,
                provider: row.entry.provider,
                accent: PROVIDER_ACCENT[row.entry.provider],
                value: formatCreditsText(snapshot, t),
                remain: snapshot.remain,
                total: snapshot.total,
                ratio: ratio,
                warn: isCreditsLow(snapshot),
                note: snapshot.planName === undefined ? '' : snapshot.planName,
                reset: snapshot.resetAtMs > 0 ? formatTime(snapshot.resetAtMs) : '',
              }
            }),
            hint: rows.some(function (row) { return row.credits.stale === true }) ? bind(t, 'creditsStale') : bind(t, 'pillHint'),
          })
        }

        var hideBubble = function () {
          setHovered(false)
          // 延迟关闭，给鼠标从胶囊挪进气泡留出时间。
          schedulePillHide(160)
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
                  // 磁盘缓存恢复的数字先弱化显示，等新数值到了再转为正常不透明度。
                  opacity: snapshot.stale === true ? 0.6 : 1,
                },
              },
              snapshot.unlimited === true ? '∞' : compactNumber(snapshot.remain),
            ),
          )
        })

        var visible = wide ? segments : segments.slice(0, 1)

        // 气泡里的「刷新额度」按钮要能触发小卡的刷新：把回调挂到 store 上。
        pillHover.onRefresh = refresh

        return h(
          'button',
          {
            type: 'button',
            onClick: refresh,
            onMouseEnter: showBubble,
            onMouseLeave: hideBubble,
            onFocus: showBubble,
            onBlur: hideBubble,
            'aria-label': rows
              .map(function (row) {
                return row.entry.displayName + ' ' + formatCreditsText(row.credits, t)
              })
              .join('，'),
            style: {
              font: 'inherit',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              // 关键：默认 content-box 时 padding 会把宽度撑出容器，
              // 侧栏里就表现为「胶囊往左溢出去」。border-box + minWidth:0 才收得住。
              boxSizing: 'border-box',
              maxWidth: '100%',
              minWidth: 0,
              margin: '0 0 4px',
              padding: wide ? '4px 11px' : '4px 7px',
              lineHeight: '18px',
              cursor: 'pointer',
              borderRadius: 999,
              border: '0.5px solid ' + (
                failed
                  ? 'var(--dsw-alias-state-error-primary, #b3261e)'
                  : hovered
                    ? 'var(--dsw-alias-border-l3, var(--dsw-alias-border-l2))'
                    : 'var(--dsw-alias-border-l2)'
              ),
              background: hovered
                ? 'var(--dsw-alias-bg-l2, rgba(127,127,127,.10))'
                : 'var(--dsw-alias-bg-l1, transparent)',
              boxShadow: hovered ? '0 1px 4px rgba(0,0,0,.10)' : 'none',
              color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary))',
              transition: 'background .12s ease, border-color .12s ease, box-shadow .12s ease',
              opacity: busy ? 0.72 : 1,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
            },
          },
          visible,
        )
      }

      /**
       * 气泡本体，挂在 `shell.overlay`（页面级根作用域）。
       *
       * 用 `fixed` 定位并贴着触发它的胶囊向上展开 —— 侧栏在底部，向下会出屏。
       * 没有 `window` 时（比如单测/SSR）直接不渲染。
       */
      var CreditsBubble = function () {
        var useEffect = React.useEffect

        // 订阅模块级 store。这里的重渲染只为了「可见性变了」——
        // 注意必须取 `useState` 的**第二个**元素（setter）；写成 `[0]` 拿到的是
        // 值本身，`bump` 会是 undefined，悬停时静默失败、气泡永远不出现。
        var bump = React.useState(0)[1]

        useEffect(function () {
          var listener = function () { bump(function (value) { return value + 1 }) }
          pillHover.listeners.add(listener)
          return function () {
            pillHover.listeners.delete(listener)
          }
        }, [])

        if (pillHover.visible !== true) return null
        if (typeof window === 'undefined' || typeof document === 'undefined') return null
        var rect = pillHover.rect
        if (rect === undefined) return null
        var rows = pillHover.rows

        // 先按侧栏实际宽度收敛：气泡绝不能越到对话区去。
        // 量不到侧栏（没有 DOM 的近似环境）就退回视口。
        var bounds = pillHover.bounds
        var limitLeft = bounds === undefined ? 8 : Math.max(8, bounds.left + 8)
        var limitRight = bounds === undefined
          ? (typeof window.innerWidth === 'number' ? window.innerWidth : 1024) - 8
          : bounds.right - 8

        var available = Math.max(180, limitRight - limitLeft)
        var width = Math.min(PREFERRED_BUBBLE_WIDTH, available)
        var left = Math.min(Math.max(rect.left, limitLeft), Math.max(limitLeft, limitRight - width))

        return h(
          'div',
          {
            role: 'dialog',
            'aria-label': bind(t, 'credits'),
            // 可交互：鼠标能从胶囊移进来点「刷新额度」。
            // 关闭由 mouseleave 的延迟计时负责，移进来时取消它。
            onMouseEnter: cancelPillHide,
            onMouseLeave: function () { schedulePillHide(160) },
            style: {
              position: 'fixed',
              left: left,
              // 向上展开：胶囊底边离视口底部还有多少，再抬 8px。
              bottom: Math.max(8, (window.innerHeight || 0) - rect.top + 8),
              width: width,
              zIndex: 2147483000,
              pointerEvents: 'auto',
              borderRadius: 10,
              padding: '12px 14px',
              background: 'var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-l1, #fff))',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              boxShadow: '0 8px 24px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.10)',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 13,
              lineHeight: '20px',
            },
          },
          h('div', {
            style: {
              fontSize: 11.5,
              opacity: 0.6,
              marginBottom: 7,
              letterSpacing: '.02em',
            },
          }, bind(t, 'credits')),
          rows.map(function (row) {
            return h(
              'div',
              { key: row.provider, style: { marginBottom: 10 } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: 7 } },
                h('span', {
                  style: {
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: row.warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : row.accent,
                    alignSelf: 'center',
                    flex: '0 0 auto',
                  },
                }),
                h('span', { style: { fontSize: 12.5, opacity: 0.72 } }, row.name),
                h('span', { style: { flex: 1 } }),
                h('span', {
                  style: {
                    fontWeight: 600,
                    fontSize: 13,
                    fontVariantNumeric: 'tabular-nums',
                    color: row.warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : 'var(--dsw-alias-label-primary)',
                  },
                }, row.value),
              ),
              row.ratio === undefined
                ? null
                : h(
                    'div',
                    {
                      style: {
                        marginTop: 5,
                        height: 4,
                        borderRadius: 999,
                        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.16))',
                        overflow: 'hidden',
                      },
                    },
                    h('div', {
                      style: {
                        width: Math.round(row.ratio * 100) + '%',
                        height: '100%',
                        borderRadius: 999,
                        background: row.warn ? 'var(--dsw-alias-state-warning-primary, #b26b00)' : row.accent,
                        opacity: 0.85,
                      },
                    }),
                  ),
              row.note === '' && row.reset === ''
                ? null
                : h('div', { style: { fontSize: 11.5, opacity: 0.55, marginTop: 3 } },
                    [row.note, row.reset === '' ? '' : bind(t, 'creditsReset') + ' ' + row.reset]
                      .filter(function (part) { return part !== '' })
                      .join(' · ')),
            )
          }),
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              borderTop: '0.5px solid var(--dsw-alias-border-l2)',
              paddingTop: 8,
              marginTop: 2,
            },
          },
          h('span', { style: { fontSize: 11.5, opacity: 0.5 } }, pillHover.hint),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            onClick: function (event) {
              if (event !== undefined && event.preventDefault !== undefined) event.preventDefault()
              if (typeof pillHover.onRefresh === 'function') pillHover.onRefresh(event)
            },
            style: {
              font: 'inherit',
              fontSize: 11.5,
              padding: '2px 9px',
              borderRadius: 999,
              cursor: 'pointer',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
            },
          }, bind(t, 'creditsRefresh'))),
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

      var attachCreditsBubble = function () {
        ctx.slots.inject(OVERLAY_SLOT, function () {
          return ctx.slots.register(
            {
              name: OVERLAY_SLOT,
              id: 'reverse-proxy-credits-bubble',
              order: 90,
              inject: function () { return { t: t } },
            },
            CreditsBubble,
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
      try {
        attachCreditsBubble()
      } catch (failure) {
        console.error('[dsh-reverse-proxy-connect] 挂载积分气泡失败', failure)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

