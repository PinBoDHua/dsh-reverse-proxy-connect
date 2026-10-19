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
     * 「账号测试」是**当时**的快照，不是持续状态：一个 2 小时前的 429 早就
     * 可能恢复了，继续把「被限流」当当前可用性会误导。超过这个时长只保留
     * 「上次测试失败」的时间线，不再决定状态列的颜色与标签。
     */
    var TEST_RESULT_TTL_MS = 30 * 60 * 1000

    /**
     * 健康状态同样会「过期」：连续失败 3 次会一直保持 down，直到下一次成功。
     * 一个 22 小时前的 429 不能证明账号现在不可用；超过这个时长只显示
     * 「待验证」，提示用户发一次消息或点账号测试重新确认。
     */
    var HEALTH_EVIDENCE_TTL_MS = 30 * 60 * 1000

    /**
     * 「账号 × 模型」表默认渲染的行数。
     *
     * 一个账号几十个模型、多家账号时这张表能到上百行，全画出来会把整页拉长；
     * 但**不能静默截断** —— 折叠时必须给出「还有 N 行」并留展开入口。
     */
    var ACCOUNT_MODEL_ROWS = 8

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
        style.textContent = [
          ':root{--dsh-rpc-warn:#9d5c00;--dsh-rpc-fill:rgba(20,28,45,.06)}',
          'body[data-ds-dark-theme]{--dsh-rpc-warn:#f0a63c;--dsh-rpc-fill:rgba(255,255,255,.08)}',

          /* ── 反代连接器 3.0 视觉系统 ─────────────────────────────────
             单一根容器 .dsh-rpc 提供全部设计变量；卡片、按钮、输入等
             只用 class，主题切换只改变量，不再在每处内联兜底。 */
          '.dsh-rpc{',
          '--rpc-accent:#2154ce;--rpc-accent-soft:color-mix(in srgb,var(--rpc-accent) 9%,transparent);',
          '--rpc-bg:var(--dsw-alias-bg-layer-1,#fff);',
          '--rpc-bg-base:var(--dsw-alias-bg-base,#f6f8fc);',
          '--rpc-surface:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 70%,var(--dsw-alias-bg-base,#f6f8fc));',
          '--rpc-surface-2:color-mix(in srgb,var(--dsw-alias-bg-base,#f6f8fc) 78%,var(--dsw-alias-bg-layer-1,#fff));',
          '--rpc-border:var(--dsw-alias-border-l2,#1b2a4a1a);',
          '--rpc-border-strong:var(--dsw-alias-border-l3,#1b2a4a24);',
          '--rpc-text:var(--dsw-alias-label-primary,#0e1626);',
          '--rpc-muted:var(--dsw-alias-label-secondary,#45526a);',
          '--rpc-faint:var(--dsw-alias-label-caption,#6c7b94);',
          '--rpc-success:var(--dsw-alias-state-success-primary,#137036);',
          '--rpc-danger:var(--dsw-alias-state-error-primary,#bf0f0f);',
          '--rpc-warn:var(--dsh-rpc-warn,#9d5c00);',
          '--rpc-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(16,29,54,.06));',
          '--rpc-shadow-sm:var(--dsw-shadow-lv1,0 1px 2px rgba(16,29,54,.04));',
          '--rpc-radius:18px;',
          'display:flex;flex-direction:column;min-width:0;max-width:100%;box-sizing:border-box;',
          'flex:0 0 auto;',
          'border:1px solid var(--rpc-border);border-radius:var(--rpc-radius);',
          'background:var(--rpc-bg);color:var(--rpc-text);overflow:hidden;',
          'container-type:inline-size;',
          '}',
          'body[data-ds-dark-theme] .dsh-rpc{',
          '--rpc-bg:var(--dsw-alias-bg-layer-1,#232324);',
          '--rpc-bg-base:var(--dsw-alias-bg-base,#151517);',
          '--rpc-border:var(--dsw-alias-border-l2,rgba(255,255,255,.12));',
          '--rpc-border-strong:var(--dsw-alias-border-l3,rgba(255,255,255,.18));',
          '--rpc-text:var(--dsw-alias-label-primary,#ebeef2);',
          '--rpc-muted:var(--dsw-alias-label-secondary,#cfd3d6);',
          '--rpc-faint:var(--dsw-alias-label-caption,#adb2b8);',
          '--rpc-shadow:0 6px 20px rgba(0,0,0,.30);--rpc-shadow-sm:0 1px 2px rgba(0,0,0,.24);',
          '}',

          /* 页头 */
          '.rpc-hero{position:relative;display:flex;align-items:flex-start;gap:13px;padding:18px 20px 16px;',
          'border-bottom:1px solid var(--rpc-border);',
          'background:radial-gradient(120% 160% at 100% 0%,color-mix(in srgb,var(--rpc-accent) 10%,transparent),transparent 58%),',
          'linear-gradient(180deg,var(--rpc-bg),var(--rpc-surface));}',
          '.rpc-hero-icon{width:38px;height:38px;flex:0 0 auto;border-radius:11px;display:grid;place-items:center;color:#fff;',
          'background:linear-gradient(145deg,color-mix(in srgb,var(--rpc-accent) 82%,#fff),var(--rpc-accent));',
          'box-shadow:0 6px 16px color-mix(in srgb,var(--rpc-accent) 30%,transparent);}',
          '.rpc-hero-main{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:4px}',
          '.rpc-hero-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
          '.rpc-hero-title h3{margin:0;font-size:19px;line-height:26px;font-weight:650;letter-spacing:-.01em;color:var(--rpc-text)}',
          '.rpc-hero-sub{margin:0;font-size:13px;line-height:20px;color:var(--rpc-muted);max-width:640px}',
          '.rpc-hero-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px}',
          '.rpc-hero-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end;padding-left:8px}',

          /* 服务商选择条（同时是 provider tablist）
             用 auto-fit 栅格而不是横向滚动：设置弹窗只有 ~560px 宽时，
             六家会排成 3+3，Trae / Trae Global 不会被裁到屏幕外。宽屏
             时 auto-fit 自然回到一行六张。 */
          '.rpc-rail{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));align-items:stretch;gap:8px;',
          'padding:12px 20px 13px;border-bottom:1px solid var(--rpc-border);background:var(--rpc-bg);overflow:visible}',
          '.rpc-provider{position:relative;appearance:none;font:inherit;text-align:left;display:flex;flex-direction:column;gap:5px;',
          'min-width:0;max-width:none;width:100%;padding:9px 11px 8px;border:1px solid var(--rpc-border);border-radius:12px;background:var(--rpc-bg);',
          'color:var(--rpc-text);cursor:pointer;overflow:hidden;transition:background .14s ease,border-color .14s ease,box-shadow .14s ease,transform .14s ease}',
          '.rpc-provider::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;',
          'background:var(--rpc-provider-accent,var(--rpc-accent));opacity:0;transition:opacity .14s ease}',
          '.rpc-provider:hover{background:var(--rpc-surface);border-color:var(--rpc-border-strong);transform:translateY(-1px);box-shadow:var(--rpc-shadow-sm)}',
          '.rpc-provider:focus-visible{outline:2px solid color-mix(in srgb,var(--rpc-accent) 55%,transparent);outline-offset:1px}',
          '.rpc-provider[aria-selected="true"]{background:color-mix(in srgb,var(--rpc-provider-accent,var(--rpc-accent)) 7%,var(--rpc-bg));',
          'border-color:color-mix(in srgb,var(--rpc-provider-accent,var(--rpc-accent)) 46%,var(--rpc-border));box-shadow:var(--rpc-shadow-sm)}',
          '.rpc-provider[aria-selected="true"]::before{opacity:1}',
          '.rpc-provider-top{display:flex;align-items:center;gap:5px;min-width:0}',
          '.rpc-provider-dot{width:6px;height:6px;border-radius:999px;flex:0 0 auto;background:var(--rpc-provider-accent,var(--rpc-accent))}',
          '.rpc-provider-name{font-size:12px;font-weight:600;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 auto}',
          '.rpc-provider-health{font-size:10.5px;line-height:14px;white-space:nowrap;color:var(--rpc-muted);flex:0 0 auto}',
          '.rpc-provider-value{display:flex;align-items:baseline;gap:4px;min-width:0}',
          '.rpc-provider-meta{font-size:10.5px;line-height:15px;color:var(--rpc-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
          '.rpc-provider-bar{height:3px;border-radius:999px;background:var(--rpc-surface-2);overflow:hidden;margin-top:1px}',
          '.rpc-provider-bar>i{display:block;height:100%;border-radius:inherit;background:var(--rpc-provider-accent,var(--rpc-accent));opacity:.85}',

          /* 通用卡片与分区 */
          '.rpc-page{display:flex;flex-direction:column;gap:12px;padding:14px 20px 20px;min-width:0;flex:0 0 auto;animation:rpc-fade .16s ease}',
          '.rpc-overview{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(0,1fr);gap:12px;align-items:start}',
          '.rpc-overview-main,.rpc-overview-side{display:flex;flex-direction:column;gap:12px;min-width:0;flex:0 0 auto}',
          '.rpc-section{display:flex;flex-direction:column;gap:11px;min-width:0;flex:0 0 auto;padding:14px 16px 15px;',
          'border:1px solid var(--rpc-border);border-radius:14px;background:var(--rpc-bg);',
          'box-shadow:var(--rpc-shadow-sm);box-sizing:border-box}',
          '.rpc-section.flush{padding:0;overflow:hidden}',
          '.rpc-section-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:22px;min-width:0}',
          '.rpc-section-title{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;line-height:19px;font-weight:650;letter-spacing:.02em;color:var(--rpc-muted)}',
          '.rpc-section-count{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;',
          'background:var(--rpc-surface-2);color:var(--rpc-muted);font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap}',

          /* 按钮 */
          '.rpc-btn{font:inherit;font-size:13px;line-height:1;height:31px;padding:0 12px;border-radius:8px;',
          'border:1px solid var(--rpc-border);background:var(--rpc-bg);color:var(--rpc-text);cursor:pointer;',
          'display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;flex:0 0 auto;',
          'transition:background .12s ease,border-color .12s ease,box-shadow .12s ease,transform .12s ease}',
          '.rpc-btn:hover:not(:disabled){background:var(--rpc-surface);border-color:var(--rpc-border-strong)}',
          '.rpc-btn:active:not(:disabled){transform:translateY(.5px)}',
          '.rpc-btn:focus-visible{outline:2px solid color-mix(in srgb,var(--rpc-accent) 60%,transparent);outline-offset:1px}',
          '.rpc-btn[disabled]{opacity:.48;cursor:not-allowed}',
          '.rpc-btn-primary{border-color:transparent;background:var(--rpc-accent);color:#fff;font-weight:600;',
          'box-shadow:0 1px 2px color-mix(in srgb,var(--rpc-accent) 35%,transparent)}',
          '.rpc-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--rpc-accent) 87%,#000);border-color:transparent}',
          '.rpc-btn-ghost{border-color:transparent;background:transparent;color:var(--rpc-muted);padding:0 8px}',
          '.rpc-btn-ghost:hover:not(:disabled){background:var(--rpc-surface-2);color:var(--rpc-text)}',
          '.rpc-btn-sm{height:26px;font-size:11.5px;padding:0 9px;border-radius:7px;gap:5px}',
          '.rpc-btn-danger{color:var(--rpc-danger);border-color:color-mix(in srgb,var(--rpc-danger) 32%,var(--rpc-border));background:transparent}',
          '.rpc-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--rpc-danger) 8%,transparent);border-color:color-mix(in srgb,var(--rpc-danger) 48%,var(--rpc-border))}',
          '.rpc-btn-link{border:0;background:transparent;height:auto;padding:0;color:var(--rpc-accent);font-size:11.5px;text-decoration:underline;text-underline-offset:2px}',

          /* 胶囊 / 徽标 */
          '.rpc-chip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:6px;',
          'border:1px solid transparent;background:var(--rpc-surface-2);color:var(--rpc-muted);font-size:10.5px;line-height:1;',
          'white-space:nowrap;font-variant-numeric:tabular-nums;flex:0 0 auto}',
          '.rpc-chip-ok{background:color-mix(in srgb,var(--rpc-success) 9%,transparent);border-color:color-mix(in srgb,var(--rpc-success) 18%,transparent);color:var(--rpc-success)}',
          '.rpc-chip-warn{background:color-mix(in srgb,var(--rpc-warn) 10%,transparent);border-color:color-mix(in srgb,var(--rpc-warn) 22%,transparent);color:var(--rpc-warn)}',
          '.rpc-chip-error{background:color-mix(in srgb,var(--rpc-danger) 9%,transparent);border-color:color-mix(in srgb,var(--rpc-danger) 20%,transparent);color:var(--rpc-danger)}',
          '.rpc-chip-accent{background:color-mix(in srgb,var(--rpc-accent) 8%,transparent);border-color:color-mix(in srgb,var(--rpc-accent) 18%,transparent);color:var(--rpc-accent)}',
          /* 页头「六家一览」：一条六段小条 + 正常家数。段色与 provider 卡同一套。 */
          '.rpc-fleet{gap:6px;padding-left:5px}',
          '.rpc-fleet-bars{display:inline-flex;align-items:center;gap:2px}',
          '.rpc-fleet-seg{display:block;width:10px;height:6px;border-radius:2px;background:var(--rpc-faint);opacity:.4}',
          '.rpc-fleet-seg[data-tone="ok"]{background:var(--rpc-success);opacity:.95}',
          '.rpc-fleet-seg[data-tone="warn"]{background:var(--rpc-warn);opacity:.95}',
          '.rpc-fleet-seg[data-tone="error"]{background:var(--rpc-danger);opacity:.95}',
          '.rpc-fleet-seg[data-tone="idle"]{background:var(--rpc-faint);opacity:.5}',
          '.rpc-fleet-seg[data-tone="off"]{background:var(--rpc-border-strong);opacity:.9}',

          /* 文本 / 通用行 */
          '.rpc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
          '.rpc-stack{display:flex;flex-direction:column;gap:6px;min-width:0}',
          '.rpc-grow{flex:1 1 auto;min-width:0}',
          '.rpc-tiny{font-size:12px;line-height:18px;color:var(--rpc-muted);margin:0}',
          '.rpc-body{font-size:13px;line-height:20px;color:var(--rpc-muted);margin:0}',
          '.rpc-label{font-size:12px;font-weight:600;line-height:18px;color:var(--rpc-muted)}',
          '.rpc-warn-text{font-size:12px;line-height:18px;color:var(--rpc-warn);margin:0}',
          '.rpc-error-text{font-size:12px;line-height:18px;color:var(--rpc-danger);margin:0}',
          '.rpc-divider{height:1px;background:var(--rpc-border);border:0;margin:0}',

          /* 表单 */
          '.rpc-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
          '.rpc-input{font:inherit;font-size:13px;height:33px;padding:0 10px;border-radius:8px;box-sizing:border-box;width:100%;',
          'border:1px solid var(--rpc-border);background:var(--rpc-surface-2);color:var(--rpc-text);transition:border-color .12s,box-shadow .12s,background .12s}',
          '.rpc-input::placeholder{color:var(--rpc-faint)}',
          '.rpc-input:hover{border-color:var(--rpc-border-strong)}',
          '.rpc-input:focus{outline:none;border-color:var(--rpc-accent);background:var(--rpc-bg);box-shadow:0 0 0 3px color-mix(in srgb,var(--rpc-accent) 14%,transparent)}',
          '.rpc-input[aria-invalid="true"]{border-color:var(--rpc-danger);box-shadow:0 0 0 3px color-mix(in srgb,var(--rpc-danger) 12%,transparent)}',
          '.rpc-check{width:14px;height:14px;margin:0;accent-color:var(--rpc-accent);cursor:pointer;flex:0 0 auto}',
          '.rpc-check-label{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;line-height:19px;color:var(--rpc-muted);cursor:pointer;white-space:nowrap}',
          '.rpc-check-label:hover{color:var(--rpc-text)}',
          /* 即时生效的开关（provider 接入 / 自动签到 …）：原生 checkbox 保留键盘与读屏，
             视觉上换成 32×18 的轨道 + 滑块，状态用底色而不用文字。 */
          '.rpc-switch{display:inline-flex;align-items:center;gap:7px;cursor:pointer;user-select:none;flex:0 0 auto}',
          '.rpc-switch-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}',
          '.rpc-switch-track{position:relative;width:32px;height:18px;border-radius:999px;background:var(--rpc-surface-2);',
          'border:1px solid var(--rpc-border-strong);transition:background .16s ease,border-color .16s ease;flex:0 0 auto}',
          '.rpc-switch-track::after{content:"";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:999px;',
          'background:var(--rpc-faint);transition:transform .16s ease,background .16s ease}',
          '.rpc-switch-input:checked+.rpc-switch-track{background:color-mix(in srgb,var(--rpc-accent) 88%,#000);border-color:transparent}',
          '.rpc-switch-input:checked+.rpc-switch-track::after{transform:translateX(14px);background:#fff}',
          '.rpc-switch-input:focus-visible+.rpc-switch-track{outline:2px solid color-mix(in srgb,var(--rpc-accent) 55%,transparent);outline-offset:2px}',
          '.rpc-switch-text{font-size:12.5px;line-height:19px;color:var(--rpc-muted)}',
          '.rpc-switch:hover .rpc-switch-text{color:var(--rpc-text)}',

          /* 服务商详情头 */
          '.rpc-detail{display:flex;flex-direction:column;min-width:0;flex:0 0 auto}',
          '.rpc-detail-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:16px 20px 0;min-width:0}',
          '.rpc-detail-main{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1 1 320px}',
          '.rpc-detail-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
          '.rpc-detail-title h4{margin:0;font-size:17px;line-height:24px;font-weight:650;letter-spacing:-.01em;color:var(--rpc-text)}',
          '.rpc-detail-meta{display:flex;align-items:center;gap:5px 8px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--rpc-muted);min-width:0}',
          '.rpc-detail-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}',

          /* 页内导航 */
          '.rpc-pagenav{display:flex;align-items:center;gap:2px;padding:4px;margin:13px 20px 0;overflow-x:auto;',
          'background:var(--rpc-surface-2);border:1px solid var(--rpc-border);border-radius:11px;width:fit-content;max-width:calc(100% - 40px);',
          'scrollbar-width:none;box-sizing:border-box}',
          '.rpc-pagenav::-webkit-scrollbar{display:none}',
          '.rpc-pagetab{font:inherit;font-size:12.5px;line-height:1;height:29px;padding:0 10px;border:0;border-radius:8px;',
          'background:transparent;color:var(--rpc-muted);cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;flex:0 0 auto;',
          'transition:background .12s,color .12s,box-shadow .12s}',
          '.rpc-pagetab:hover{color:var(--rpc-text);background:color-mix(in srgb,var(--rpc-bg) 55%,transparent)}',
          '.rpc-pagetab:focus-visible{outline:2px solid color-mix(in srgb,var(--rpc-accent) 55%,transparent);outline-offset:1px}',
          '.rpc-pagetab[aria-current="page"]{background:var(--rpc-bg);color:var(--rpc-text);font-weight:600;box-shadow:var(--rpc-shadow-sm)}',
          '.rpc-pagetab-count{font-size:10px;line-height:1;padding:2px 5px;border-radius:999px;background:var(--rpc-surface-2);color:var(--rpc-muted);font-variant-numeric:tabular-nums}',
          '.rpc-pagetab[aria-current="page"] .rpc-pagetab-count{background:color-mix(in srgb,var(--rpc-accent) 9%,transparent);color:var(--rpc-accent)}',

          /* 服务状态 KV */
          '.rpc-kv{display:grid;grid-template-columns:100px minmax(0,1fr);gap:8px 12px;align-items:baseline;font-size:13px;line-height:20px}',
          '.rpc-kv>dt{color:var(--rpc-muted);font-weight:500;margin:0}',
          '.rpc-kv>dd{margin:0;color:var(--rpc-text);min-width:0;overflow-wrap:anywhere}',
          '.rpc-kv-note{grid-column:2;margin:-3px 0 2px;font-size:11.5px;line-height:17px;color:var(--rpc-muted)}',

          /* 额度 */
          '.rpc-credit-line{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;min-width:0}',
          '.rpc-credit-value{font-size:38px;line-height:40px;font-weight:650;letter-spacing:-.025em;font-variant-numeric:tabular-nums;color:var(--rpc-text)}',
          '.rpc-credit-unit{font-size:12.5px;line-height:19px;color:var(--rpc-muted);padding-bottom:5px}',
          '.rpc-progress{height:8px;border-radius:999px;background:var(--rpc-surface-2);overflow:hidden;max-width:520px}',
          '.rpc-progress>i{display:block;height:100%;border-radius:inherit;background:var(--rpc-accent);transition:width .35s ease}',
          '.rpc-trend{display:flex;flex-direction:column;gap:7px;padding-top:10px;border-top:1px solid var(--rpc-border);min-width:0}',
          '.rpc-trend-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
          '.rpc-spark{display:block;width:100%;height:30px}',

          /* 账号表 */
          '.rpc-table{border:1px solid var(--rpc-border);border-radius:12px;overflow:hidden;background:var(--rpc-bg);min-width:0}',
          '.rpc-table-scroll{overflow-x:auto;max-width:100%}',
          '.rpc-table-head{display:grid;align-items:center;gap:10px;padding:9px 13px;background:var(--rpc-surface-2);',
          'border-bottom:1px solid var(--rpc-border);font-size:11px;font-weight:650;letter-spacing:.045em;color:var(--rpc-muted)}',
          '.rpc-table-row{display:grid;align-items:start;gap:10px;padding:12px 13px;min-width:0;transition:background .12s ease}',
          '.rpc-table-row:hover{background:var(--rpc-surface)}',
          '.rpc-table-row[data-active="true"]{background:color-mix(in srgb,var(--rpc-accent) 5%,transparent);box-shadow:inset 3px 0 0 var(--rpc-accent)}',
          '.rpc-cell{display:flex;flex-direction:column;gap:2px;min-width:0}',
          '.rpc-cell-actions{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex-wrap:wrap}',
          '.rpc-mini-bar{display:block;height:3px;width:100%;max-width:104px;border-radius:999px;background:var(--rpc-surface-2);overflow:hidden;margin-top:3px}',
          '.rpc-mini-bar>i{display:block;height:100%;border-radius:inherit;opacity:.85}',

          /* 列表 / 模型 / 事件 */
          '.rpc-list{border:1px solid var(--rpc-border);border-radius:12px;overflow:hidden;background:var(--rpc-bg);min-width:0}',
          '.rpc-list-row{display:flex;align-items:center;gap:9px;padding:9px 12px;min-width:0;font-size:13px;line-height:20px;',
          'border-top:1px solid var(--rpc-border);transition:background .12s ease}',
          '.rpc-list-row:first-child{border-top:0}',
          '.rpc-model-list{max-height:460px;overflow-y:auto;overscroll-behavior:contain}',
          '.rpc-model-list::-webkit-scrollbar{width:8px}',
          '.rpc-model-row{position:relative}',
          '.rpc-list-row:hover{background:var(--rpc-surface)}',
          '.rpc-model-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--rpc-text);font-weight:500}',
          '.rpc-model-meta{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0;color:var(--rpc-muted);font-size:11px;line-height:17px}',
          '.rpc-model-id{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11px;line-height:17px;color:var(--rpc-faint);white-space:nowrap}',
          '.rpc-event-list{display:flex;flex-direction:column;min-width:0}',
          '.rpc-event{display:flex;align-items:flex-start;gap:9px;padding:11px 12px;border-top:1px solid var(--rpc-border);min-width:0;font-size:13px;line-height:20px}',
          '.rpc-event:first-child{border-top:0}',
          '.rpc-event:hover{background:var(--rpc-surface)}',
          '.rpc-event-dot{width:7px;height:7px;border-radius:999px;flex:0 0 auto;margin-top:6px}',
          '.rpc-event-time{font-size:11px;line-height:17px;color:var(--rpc-faint);font-variant-numeric:tabular-nums;white-space:nowrap;flex:0 0 auto;margin-top:1px}',
          '.rpc-event-msg{flex:1 1 200px;min-width:0;color:var(--rpc-text);overflow-wrap:anywhere}',
          '.rpc-filters{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
          '.rpc-filter{font:inherit;font-size:11.5px;line-height:1;height:25px;padding:0 9px;border-radius:999px;',
          'border:1px solid var(--rpc-border);background:transparent;color:var(--rpc-muted);cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease,border-color .12s ease}',
          '.rpc-filter:hover{background:var(--rpc-surface-2);color:var(--rpc-text)}',
          '.rpc-filter[aria-pressed="true"]{background:color-mix(in srgb,var(--rpc-accent) 9%,transparent);border-color:color-mix(in srgb,var(--rpc-accent) 32%,var(--rpc-border));color:var(--rpc-text);font-weight:600}',

          /* 提示条 / 空状态 */
          '.rpc-banner{display:flex;align-items:flex-start;gap:8px;margin:0 20px;padding:9px 11px;border-radius:10px;',
          'font-size:12px;line-height:18px;border:1px solid var(--rpc-border);background:var(--rpc-surface)}',
          '.rpc-banner-warn{border-color:color-mix(in srgb,var(--rpc-warn) 30%,var(--rpc-border));',
          'background:color-mix(in srgb,var(--rpc-warn) 8%,transparent);color:var(--rpc-warn)}',
          '.rpc-banner-error{border-color:color-mix(in srgb,var(--rpc-danger) 28%,var(--rpc-border));',
          'background:color-mix(in srgb,var(--rpc-danger) 7%,transparent);color:var(--rpc-danger)}',
          '.rpc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:28px 18px;text-align:center;',
          'border:1px dashed var(--rpc-border-strong);border-radius:12px;color:var(--rpc-muted);font-size:12.5px;line-height:19px}',
          '.rpc-empty-icon{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:var(--rpc-surface-2);color:var(--rpc-muted)}',
          '.rpc-banners{display:flex;flex-direction:column;gap:7px;padding:10px 0 0}',
          '.rpc-checkin{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-radius:10px;',
          'border:1px solid var(--rpc-border);background:var(--rpc-surface-2);font-size:12px;line-height:18px;min-width:0}',
          '.rpc-subcard{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;',
          'border:1px dashed var(--rpc-border-strong);background:var(--rpc-surface);min-width:0}',
          '.rpc-testgrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr) auto;gap:8px;align-items:end;min-width:0}',
          '.rpc-testfield{display:flex;flex-direction:column;gap:4px;min-width:0}',
          '.rpc-testfield>span{font-size:11px;line-height:16px;font-weight:600;color:var(--rpc-muted)}',
          '.rpc-select{font:inherit;font-size:12.5px;height:32px;padding:0 8px;border-radius:8px;box-sizing:border-box;width:100%;min-width:0;',
          'border:1px solid var(--rpc-border);background:var(--rpc-surface-2);color:var(--rpc-text);cursor:pointer;transition:border-color .12s,box-shadow .12s}',
          '.rpc-select:hover{border-color:var(--rpc-border-strong)}',
          '.rpc-select:focus{outline:none;border-color:var(--rpc-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--rpc-accent) 14%,transparent)}',
          '.rpc-select:disabled{opacity:.55;cursor:not-allowed}',
          '.rpc-testresult{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0;font-size:11.5px;line-height:17px;color:var(--rpc-muted)}',
          '.rpc-inline-note{display:flex;align-items:flex-start;gap:6px;font-size:11.5px;line-height:17px;color:var(--rpc-muted);margin:0}',
          '.rpc-kpi{position:relative;display:flex;flex-direction:column;gap:2px;min-width:0;padding:13px 14px 11px;',
          'border:1px solid var(--rpc-border);border-radius:13px;overflow:hidden;',
          'background:linear-gradient(180deg,var(--rpc-bg),var(--rpc-surface-2));box-shadow:var(--rpc-shadow-sm)}',
          '.rpc-kpi::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:var(--rpc-accent);opacity:.45}',
          '.rpc-kpi-label{font-size:10.5px;line-height:16px;font-weight:650;letter-spacing:.05em;color:var(--rpc-muted)}',
          '.rpc-kpi-value{font-size:26px;line-height:32px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--rpc-text)}',
          '.rpc-kpi-metrics{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:10px;row-gap:1px;margin-top:6px;',
          'padding-top:7px;border-top:1px solid var(--rpc-border);min-width:0;font-size:11px;line-height:16px;color:var(--rpc-muted)}',
          '.rpc-heat{display:flex;align-items:flex-end;gap:4px;height:44px;padding-top:4px;min-width:0}',
          '.rpc-heat-cell{flex:1 1 0;min-width:4px;max-width:56px;height:38px;display:flex;align-items:flex-end;border-radius:4px 4px 0 0;',
          'background:transparent;border-bottom:2px solid var(--rpc-surface-2);overflow:hidden}',
          '.rpc-heat-fill{width:100%;border-radius:4px;background:var(--rpc-accent);transition:height .2s ease,opacity .2s ease}',
          /* 近 14 天用量：等宽 14 列 + 基线 + 今天高亮。
             旧版每列 max-width:56px，宽卡片里右半边留白、只剩两根孤零零的柱子；
             现在整行铺满，并给出峰值与日期轴，扫一眼就知道量级和趋势。 */
          '.rpc-chart{display:flex;flex-direction:column;gap:6px;min-width:0}',
          '.rpc-chart-plot{position:relative;display:grid;grid-template-columns:repeat(14,minmax(0,1fr));gap:4px;',
          'align-items:end;height:64px;padding:6px 0 0;min-width:0;',
          'background:linear-gradient(to top,color-mix(in srgb,var(--rpc-border) 55%,transparent) 0 1px,transparent 1px);',
          'background-size:100% 50%;background-position:0 100%;background-repeat:no-repeat}',
          '.rpc-chart-col{display:flex;align-items:flex-end;justify-content:center;height:100%;min-width:0;border-radius:4px;',
          'transition:background .12s ease}',
          '.rpc-chart-col:hover{background:color-mix(in srgb,var(--rpc-accent) 6%,transparent)}',
          '.rpc-chart-bar{width:100%;max-width:34px;border-radius:3px 3px 1px 1px;transition:height .25s ease,opacity .2s ease}',
          '.rpc-chart-col[data-today="true"] .rpc-chart-bar{box-shadow:0 0 0 1px color-mix(in srgb,var(--rpc-accent) 26%,transparent)}',
          '.rpc-chart-axis{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;line-height:14px;color:var(--rpc-faint)}',
          '.rpc-chart-axis>span{white-space:nowrap}',
          '.rpc-chart-today{display:inline-flex;align-items:center;gap:4px}',
          '.rpc-chart-today::before{content:"";width:4px;height:4px;border-radius:999px;background:var(--rpc-accent)}',
          '.rpc-chart-empty{display:flex;align-items:center;gap:6px;margin:0;font-size:11.5px;line-height:17px;color:var(--rpc-faint)}',
          '.rpc-subsection{display:flex;flex-direction:column;gap:7px;min-width:0}',
          '.rpc-table-frame{border:1px solid var(--rpc-border);border-radius:10px;overflow-x:auto;background:var(--rpc-bg);min-width:0}',

          /* 页脚 / 诊断 */
          '.rpc-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 20px 13px;border-top:1px solid var(--rpc-border);',
          'font-size:10.5px;line-height:16px;color:var(--rpc-faint);background:var(--rpc-bg)}',
          '.rpc-pre{margin:0;padding:11px 12px;border-radius:10px;border:1px solid var(--rpc-border);background:var(--rpc-surface-2);',
          'font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11px;line-height:16px;',
          'max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:var(--rpc-text)}',
          '.rpc-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',

          /* 动效 / 响应式 */
          '@keyframes rpc-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}',
          '@container (max-width:760px){.rpc-overview{grid-template-columns:1fr}.rpc-detail-head{padding-top:14px}.rpc-provider-health{display:none}}',
          '@container (max-width:820px){.rpc-rail{grid-template-columns:repeat(3,minmax(0,1fr))}}',
          '@container (max-width:480px){.rpc-rail{grid-template-columns:repeat(2,minmax(0,1fr))}}',
          '@container (max-width:620px){.rpc-testgrid{grid-template-columns:1fr 1fr}.rpc-testgrid>.rpc-btn{grid-column:1/-1;justify-self:start}}',
          '@container (max-width:560px){.rpc-hero{flex-wrap:wrap;padding:15px 16px 13px}.rpc-hero-actions{width:100%;justify-content:flex-start;padding-left:0}',
          '.rpc-rail{padding:10px 14px 11px}',
          '.rpc-pagenav{margin:12px 14px 0;max-width:calc(100% - 28px)}',
          '.rpc-page{padding:12px 14px 16px}.rpc-detail-head{padding:14px 14px 0}.rpc-banner{margin:0 14px}.rpc-footer{padding:9px 14px 12px}',
          '.rpc-kv{grid-template-columns:84px minmax(0,1fr)}}',
          '@media (prefers-reduced-motion:reduce){.dsh-rpc *{animation:none!important;transition:none!important}}',
          '.dsh-rpc *::-webkit-scrollbar{width:8px;height:8px}',
          '.dsh-rpc *::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--rpc-faint) 35%,transparent);border-radius:999px}',
          '.dsh-rpc *::-webkit-scrollbar-track{background:transparent}',
        ].join('')
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
      providersAllDisabled: '全部已关闭',
      providersAllDisabledHint: '所有 provider 都在设置里关闭了，插件不会出现在模型选择器里；重新启用任意一家即可恢复。',
      navProviders: '服务商',
      navSections: '详情分区',
      navOverview: '概览',
      navAccounts: '账号',
      navUsage: '用量',
      navModels: '模型',
      navSettings: '设置',
      navActivity: '动态',
      providersEnabled: '已接入 {count}/{total}',
      fleetHealthy: '{count} 家正常',
      providersCredits: '{count} 家额度可读',
      updatedAt: '更新于 {time}',
      autoRefreshHint: '每 20 秒自动刷新',
      footerHint: '数据来自本机宿主',
      manageAccounts: '管理账号',
      displaySettings: '显示',
      displaySettingsHint: '这些选项只影响 DSH 里的展示，不改变上游账号行为；修改后立即生效。',
      loginAddTitle: '浏览器登录',
      statusAccount: '账号凭证',
      catalogSource: '模型目录',
      emailLabel: '邮箱',
      secStatus: '状态',
      secConnection: '连接设置',
      show: '展开',
      hide: '收起',
      secAccounts: '账号',
      autoSwitch: '额度用完自动切换',
      accountsHintPat: '可以为同一个 provider 添加多个 PAT；当前账号积分用完后会按上面的开关自动切换。',
      accountsHintDesktop: '桌面账号用「浏览器登录新增账号」添加；本机已有登录会自动读取。',
      accountLabel: '账号名称',
      accountPat: '粘贴个人访问令牌（PAT）',
      accountAuthFile: '登录文件路径（留空 = 读本机登录）',
      accountSecretHint: '令牌只保存在本机设置里，不会回传到浏览器。',
      accountDefaultLabel: '新账号',
      // 隐式默认账号的名字由插件生成（服务端下发 `labelKey`），按当前语言显示。
      accountDefaultDesktop: '本机登录',
      accountDefaultPat: '默认令牌',
      // 账号表格：让「还剩多少 / 现在能不能用 / 今天签没签」第一眼可见
      accountColAccount: '账号',
      accountColCredits: '积分',
      accountColStatus: '状态 / 模型',
      accountColCheckin: '签到',
      accountColActions: '操作',
      accountTableAria: '账号额度、状态与签到',
      accountsEmpty: '还没有账号。用下面的方式添加一个。',
      accountFallback: '未命名账号',
      accountDisabled: '已禁用',
      accountNoRequests: '还没有请求记录',
      accountModelShort: '模型 {model}',
      accountCooldownHint: '约 {duration} 后恢复',
      accountCreditsExpiry: '到期 {date}',
      accountNoExpiry: '无到期时间',
      accountRateLimited: '被限流',
      accountAuthFailed: '凭证失效',
      accountTestFailed: '测试失败',
      accountCreditsExhausted: '额度用尽',
      accountAvailable: '可用',
      accountCheckinOff: '已关闭',
      accountCheckinNone: '—',
      accountCheckinFailed: '失败',
      accountCheckinSkipped: '未登录',
      accountCheckinNoActivity: '无活动',
      accountCheckinDone: '已签到',
      accountCheckinCredit: '+{credit}',
      accountCheckinStreak: '连续 {days} 天',
      agoJustNow: '刚刚',
      agoMinutes: '{count} 分钟前',
      agoHours: '{count} 小时前',
      agoDays: '{count} 天前',
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
      healthDegraded: '近期波动',
      healthDown: '连续失败',
      healthStale: '待验证',
      healthUnknown: '无记录',
      healthStaleHint: '最后一次请求失败已超过 30 分钟，之后没有成功记录；在下方「可用性测试」里选模型验证，或发一次消息自动更新。',
      healthStaleTestOkHint: '最近一次模型测试已通过（{model}，{time}）；真实请求成功后历史健康状态会自动更新。',
      healthStaleTestLimitHint: '最近一次模型测试显示该模型被限额（{model}，{time}；{reset}）。',
      testedAvailableShort: '刚测可用',
      testedLimitedShort: '刚测限额',
      testedAuthShort: '刚测失效',
      testedFailedShort: '刚测失败',
      lastFailureAt: '最近失败',
      lastSuccessAtLabel: '最近成功',
      neverSucceeded: '还没有成功记录',
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
      resetCooldownShort: '解除',
      usageSession: '当前会话',
      usageHeatmap: '近 14 天',
      usageHeatPeak: '峰值 {value}',
      usageHeatPeakHint: '{date} 是这 14 天里用量最高的一天',
      usageHeatAria: '近 {days} 天每日 token 用量柱状图',
      usageHeatToday: '今天',
      usageHeatEmpty: '这 14 天还没有用量记录；发起一次对话后就会出现在这里。',
      usageTopModels: '模型用量',
      usageAccountModels: '账号 × 模型用量',
      usageAccountModelsHint: '同一模型可能被多个账号使用；按账号拆分 token。',
      usageAccountModelCoverage: '覆盖 {percent}%（{covered}/{total} 次）',
      usageAccountModelCoverageHint: '账号 × 模型交叉维度从 1.9.x 起累积，历史请求拆不出账号；覆盖率因此小于 100%。',
      usageAccountModelTodayEmpty: '今天暂无新请求，下表为累计数据。',
      usageAccountModelStatus: '状态',
      modelTest: '检测',
      modelTesting: '检测中…',
      modelTestOk: '可用',
      modelTestFailed: '失败',
      limitBadge: '限额',
      authBadge: '失效',
      limitUntil: '限额至 {time}',
      recentLimitHint: '最近一次请求被上游限额（{code}）',
      availabilityTest: '可用性测试',
      availabilityTestHint: '选一个账号和模型，发一次 1 token 请求，确认当前是否可用、是否被限额；不消耗对话额度。',
      testModelAccount: '账号',
      testModelModel: '模型',
      testModelStart: '开始测试',
      testModelNever: '这个模型还没有测试记录',
      testModelResultAt: '测试于 {time}',
      testModelNoAccounts: '还没有可测试的账号',
      testModelNoModels: '没有可测试的模型',
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
      eventHint: '记录换号、令牌续期、目录/额度降级、签到与探测；只保留最近 200 条元数据，重复事件合并为一行。',
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
      // 服务端下发的事件文案（`event.messageKey`）。没有对应键时回落到
      // `event.message`（中文原文），所以老账本仍然能看。
      eventStartupDetail: '插件 v{version} 已启动，{providers} 个 provider{swept}',
      eventStartupSwept: '，清理 {count} 个中断写入的临时文件',
      eventCreditsFailed: '额度读取失败（{account}）：{reason}',
      eventCreditsRecovered: '额度读取已恢复（{account}）',
      eventSwitchByCredits: '额度{reason}，自动切换到「{to}」',
      eventSwitchReasonExhausted: '已用尽',
      eventSwitchReasonLow: '低于阈值',
      eventCredentialRefreshed: '登录令牌已自动续期（{account}）',
      eventCatalogUpdated: '模型目录已更新（{count} 个模型）',
      eventCatalogFallback: '模型目录拉取失败，回退到 {source}（{reason}）',
      eventProbeDone: '能力探测完成：{models} 个模型，{unavailable} 个账号不支持',
      eventCheckinSummary: '签到：{accounts} 个账号{suffix}',
      eventCheckinSkippedSuffix: '，{skipped} 个账号未登录，已跳过',
      eventCheckinFailedSuffix: '，{failed} 个失败',
      eventCheckinCreditSuffix: '，本次领到 {credit} 分',
      eventFailover: '账号「{from}」请求失败（{code}），切换到「{to}」',
      eventAccountForgotten: '账号已删除，相关缓存与历史已清理',
      eventLoginStarted: '已开始浏览器登录',
      eventLoginImported: '浏览器登录成功，已导入账号「{label}」',
      eventLoginSaveFailed: '保存账号失败：{reason}',
      eventLoginFailed: '浏览器登录失败：{reason}',
      eventLoginCancelled: '已取消浏览器登录',
      eventManualRefresh: '已手动刷新模型目录与额度',
      eventManualCredits: '已手动刷新额度',
      eventStatsReset: '用量统计已重置',
      eventCleared: '事件账本已清空',
      eventRetained: '仅保留最近 {count} 条，更早的事件已轮转。',
      eventRepeat: '×{count}',
      eventRepeatHint: '同一事件共 {count} 次；最早 {first}，最新 {last}',
      searchOnlyUnavailable: '没有可用的匹配模型；{count} 个「账号不支持」的模型匹配，可在下方勾选强制显示。',
      searchAllUnavailable: '全部 {count} 个模型都被判定为「账号不支持」；可在下方勾选强制显示，或点「检测」重新探测。',
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
      providersAllDisabled: 'All disabled',
      providersAllDisabledHint: 'Every provider is turned off, so the plugin does not appear in the model picker. Re-enable any provider to restore it.',
      navProviders: 'Providers',
      navSections: 'Sections',
      navOverview: 'Overview',
      navAccounts: 'Accounts',
      navUsage: 'Usage',
      navModels: 'Models',
      navSettings: 'Settings',
      navActivity: 'Activity',
      providersEnabled: '{count}/{total} connected',
      fleetHealthy: '{count} healthy',
      providersCredits: '{count} with readable credits',
      updatedAt: 'Updated {time}',
      autoRefreshHint: 'Auto-refresh every 20s',
      footerHint: 'Data comes from the local host',
      manageAccounts: 'Manage accounts',
      displaySettings: 'Display',
      displaySettingsHint: 'These options only change how DSH shows data; upstream account behaviour is unchanged. Changes apply immediately.',
      loginAddTitle: 'Browser sign-in',
      statusAccount: 'Account & credential',
      catalogSource: 'Model catalog',
      emailLabel: 'Email',
      secStatus: 'Status',
      secConnection: 'Connection',
      show: 'Expand',
      hide: 'Collapse',
      secAccounts: 'Accounts',
      autoSwitch: 'Switch when out of credits',
      accountsHintPat: 'Add more than one PAT per provider; when the current account runs out, it switches automatically.',
      accountsHintDesktop: 'Add desktop accounts with “Add account via browser login”; an existing local sign-in is picked up automatically.',
      accountLabel: 'Account name',
      accountPat: 'Paste a personal access token',
      accountAuthFile: 'Sign-in file path (blank = local sign-in)',
      accountSecretHint: 'Tokens stay in the local settings file and are never sent back to the browser.',
      accountDefaultLabel: 'New account',
      // Implicit default accounts are named by the plugin (server sends `labelKey`).
      accountDefaultDesktop: 'This machine',
      accountDefaultPat: 'Default token',
      accountColAccount: 'Account',
      accountColCredits: 'Credits',
      accountColStatus: 'Status / model',
      accountColCheckin: 'Check-in',
      accountColActions: 'Actions',
      accountTableAria: 'Account credits, status and check-in',
      accountsEmpty: 'No accounts yet. Add one below.',
      accountFallback: 'Unnamed account',
      accountDisabled: 'Disabled',
      accountNoRequests: 'No requests yet',
      accountModelShort: 'model {model}',
      accountCooldownHint: 'back in ~{duration}',
      accountCreditsExpiry: 'expires {date}',
      accountNoExpiry: 'no expiry',
      accountRateLimited: 'Rate limited',
      accountAuthFailed: 'Sign-in expired',
      accountTestFailed: 'Test failed',
      accountCreditsExhausted: 'Out of credits',
      accountAvailable: 'Available',
      accountCheckinOff: 'Off',
      accountCheckinNone: '—',
      accountCheckinFailed: 'Failed',
      accountCheckinSkipped: 'Signed out',
      accountCheckinNoActivity: 'No activity',
      accountCheckinDone: 'Checked in',
      accountCheckinCredit: '+{credit}',
      accountCheckinStreak: '{days}-day streak',
      agoJustNow: 'just now',
      agoMinutes: '{count}m ago',
      agoHours: '{count}h ago',
      agoDays: '{count}d ago',
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
      healthDegraded: 'Flaky',
      healthDown: 'Failing',
      healthStale: 'Needs check',
      healthUnknown: 'No data',
      healthStaleHint: 'The last request failed more than 30 minutes ago and no success has been recorded since. Verify with a model in Availability test below, or send a message to refresh.',
      healthStaleTestOkHint: 'The latest model test passed ({model}, {time}); a successful real request will refresh the historical health status.',
      healthStaleTestLimitHint: 'The latest model test shows this model is rate limited ({model}, {time}; {reset}).',
      testedAvailableShort: 'Tested OK',
      testedLimitedShort: 'Tested limited',
      testedAuthShort: 'Tested auth fail',
      testedFailedShort: 'Tested failed',
      lastFailureAt: 'Last failure',
      lastSuccessAtLabel: 'Last success',
      neverSucceeded: 'No success recorded yet',
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
      resetCooldownShort: 'Clear',
      usageSession: 'This session',
      usageHeatmap: 'Last 14 days',
      usageHeatPeak: 'Peak {value}',
      usageHeatPeakHint: '{date} had the highest usage in this window',
      usageHeatAria: 'Daily token usage for the last {days} days',
      usageHeatToday: 'Today',
      usageHeatEmpty: 'No usage in the last 14 days yet; it shows up here after your first request.',
      usageTopModels: 'Model usage',
      usageAccountModels: 'Account × model usage',
      usageAccountModelsHint: 'One model can be shared by several accounts; tokens are split per account.',
      usageAccountModelCoverage: 'Coverage {percent}% ({covered}/{total} requests)',
      usageAccountModelCoverageHint: 'The account × model split only accumulates from 1.9.x; older requests carry no account data, so coverage is below 100%.',
      usageAccountModelTodayEmpty: 'No new requests today; showing cumulative data.',
      usageAccountModelStatus: 'Status',
      modelTest: 'Test',
      modelTesting: 'Testing…',
      modelTestOk: 'OK',
      modelTestFailed: 'Failed',
      limitBadge: 'Limited',
      authBadge: 'Auth',
      limitUntil: 'Limited until {time}',
      recentLimitHint: 'The latest request was limited upstream ({code})',
      availabilityTest: 'Availability test',
      availabilityTestHint: 'Pick an account and a model, then send one 1-token request to check availability or rate limiting. It does not consume chat credits.',
      testModelAccount: 'Account',
      testModelModel: 'Model',
      testModelStart: 'Run test',
      testModelNever: 'No test recorded for this model yet',
      testModelResultAt: 'Tested {time}',
      testModelNoAccounts: 'No account to test yet',
      testModelNoModels: 'No model to test',
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
      eventHint: 'Account switches, token refreshes, catalog/credit fallbacks, check-ins and probes; only the latest 200 metadata entries are kept. Repeated events are merged into one row.',
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
      // Server-provided event text (`event.messageKey`); falls back to the
      // Chinese `event.message` when a key is missing (older journals).
      eventStartupDetail: 'Plugin v{version} started with {providers} providers{swept}',
      eventStartupSwept: ', cleaned up {count} temp files left by interrupted writes',
      eventCreditsFailed: 'Credit read failed ({account}): {reason}',
      eventCreditsRecovered: 'Credit read recovered ({account})',
      eventSwitchByCredits: 'Credits {reason}; switched to “{to}” automatically',
      eventSwitchReasonExhausted: 'exhausted',
      eventSwitchReasonLow: 'below the threshold',
      eventCredentialRefreshed: 'Login token refreshed automatically ({account})',
      eventCatalogUpdated: 'Model catalog updated ({count} models)',
      eventCatalogFallback: 'Model catalog fetch failed; fell back to {source} ({reason})',
      eventProbeDone: 'Probe finished: {models} models, {unavailable} unsupported by this account',
      eventCheckinSummary: 'Check-in: {accounts} accounts{suffix}',
      eventCheckinSkippedSuffix: ', {skipped} not signed in, skipped',
      eventCheckinFailedSuffix: ', {failed} failed',
      eventCheckinCreditSuffix: ', {credit} credits claimed',
      eventFailover: 'Account “{from}” failed ({code}); switched to “{to}”',
      eventAccountForgotten: 'Account deleted; its caches and history were cleaned up',
      eventLoginStarted: 'Browser login started',
      eventLoginImported: 'Browser login succeeded; imported account “{label}”',
      eventLoginSaveFailed: 'Saving the account failed: {reason}',
      eventLoginFailed: 'Browser login failed: {reason}',
      eventLoginCancelled: 'Browser login cancelled',
      eventManualRefresh: 'Model catalog and credits refreshed manually',
      eventManualCredits: 'Credits refreshed manually',
      eventStatsReset: 'Usage statistics reset',
      eventCleared: 'Event journal cleared',
      eventRetained: 'Only the latest {count} events are kept; older entries have rotated out.',
      eventRepeat: '×{count}',
      eventRepeatHint: 'Same event {count} times; first {first}, latest {last}',
      searchOnlyUnavailable: 'No available model matches; {count} model(s) not in this plan match — expand the list below to force-show one.',
      searchAllUnavailable: 'All {count} models are flagged as not supported by this account. Force-show one below, or run Probe again to re-check.',
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

    /** 是否为可用于计算与展示的有限数字。 */
    function isFiniteNumber(value) {
      return typeof value === 'number' && Number.isFinite(value)
    }

    /**
     * 数字千分位（模块级，卡片与侧栏小卡共用）。
     *
     * 注意 `value * 10` 本身也能溢出：`formatNumber(1e308)` 会先算出
     * `Infinity`，再被 String 成字面「Infinity」——输入明明是有限数。
     * 只有缩放结果仍有限时才做一位小数舍入，否则原样显示（科学计数法）。
     */
    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      var scaled = value * 10
      var rounded = Number.isFinite(scaled) ? Math.round(scaled) / 10 : value
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
     * 账号的显示名。
     *
     * 隐式默认账号（`id === 'default'`）的名字是**插件生成的**（「本机登录」/
     * 「默认令牌」），服务端会带 `labelKey`；英文界面用键本地化，中文界面与
     * 老宿主没有键时回落到 `label` 本身。用户自己命名的账号永远没有键，
     * 原样显示 —— 不能把用户起的名字翻译掉。
     *
     * @param account - 账号（可能来自 `/status`，也可能是本地构造的）。
     * @param t - 当前语言的绑定函数。
     * @returns 显示名。
     */
    function accountNameOf(account, t) {
      var label = account !== null && typeof account === 'object' && typeof account.label === 'string' ? account.label : ''
      var key = account !== null && typeof account === 'object' && typeof account.labelKey === 'string' ? account.labelKey : ''
      if (key !== '') {
        var localized = bind(t, key)
        // 未知键会回显键名本身：那比中文原文更糟，回落 label。
        if (typeof localized === 'string' && localized !== '' && localized !== key) return localized
      }
      return label === '' ? bind(t, 'accountFallback') : label
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
      // 先按单位换算再四舍五入，但边界上要进位：999,999,999 / 1e6 舍入后是
      // 1000，继续写 "1000M" 很难看。换算值 ≥ 1000 时升一级单位再算。
      var scaled = function (divisor) { return Math.round((value / divisor) * 10) / 10 }
      if (value >= 1e9) return String(scaled(1e9)) + 'B'
      if (value >= 1e6) {
        var millions = scaled(1e6)
        return millions >= 1000 ? String(scaled(1e9)) + 'B' : String(millions) + 'M'
      }
      if (value >= 1e3) {
        var thousands = scaled(1e3)
        return thousands >= 1000 ? String(scaled(1e6)) + 'M' : String(thousands) + 'K'
      }
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

    /** 毫秒值 → 高级设置里的「秒」输入框文本；非有限/非正回落到 fallback。 */
    function secondsInputOf(value, fallback) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
      return String(Math.round(value / 1000))
    }

    /** 0–1 比例 → 高级设置里的百分数输入框文本；非有限/越界回落到 fallback。 */
    function percentInputOf(value, fallback) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return fallback
      return String(Math.round(value * 100))
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
      var threshold = isFiniteNumber(ratio) && ratio > 0 && ratio < 1 ? ratio : LOW_CREDITS_RATIO
      if (credits.unlimited === true) return false
      if (credits.exceeded === true) return true
      if (isFiniteNumber(credits.remain) && credits.remain <= 0) return true
      if (isFiniteNumber(credits.total) && credits.total > 0 && isFiniteNumber(credits.remain)) {
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
      if (isFiniteNumber(credits.total) && credits.total > 0) return false
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
      if (credits.exceeded === true || (isFiniteNumber(credits.remain) && credits.remain <= 0)) return 'exhausted'
      if (isFiniteNumber(credits.total) && credits.total > 0 && isFiniteNumber(credits.remain)) {
        var threshold = isFiniteNumber(ratio) && ratio > 0 && ratio < 1 ? ratio : LOW_CREDITS_RATIO
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
      if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) return '—'
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
        return point !== null && typeof point === 'object' && isFiniteNumber(point.remain)
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
        style: { display: 'block', width: '100%', height: 26, overflow: 'visible' },
      },
      h('polygon', {
        points: '0,24 ' + coordinates.join(' ') + ' 100,24',
        fill: color === undefined ? 'currentColor' : color,
        stroke: 'none',
        opacity: 0.10,
      }),
      h('polyline', {
        points: coordinates.join(' '),
        fill: 'none',
        stroke: color === undefined ? 'currentColor' : color,
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        vectorEffect: 'non-scaling-stroke',
      }))
    }

    /** 额度百分比（读不到 / 不限量 / 没有总量 / 余额或总量非有限时返回 undefined）。 */
    function creditsPercentOf(credits) {
      if (credits === undefined || credits.state !== 'ok') return undefined
      if (credits.unlimited === true) return undefined
      if (typeof credits.total !== 'number' || !Number.isFinite(credits.total) || !(credits.total > 0)) return undefined
      if (typeof credits.remain !== 'number' || !Number.isFinite(credits.remain)) return undefined
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
        small: isFiniteNumber(credits.total) && credits.total > 0 ? '/ ' + formatNumber(credits.total) : '',
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
      var total = isFiniteNumber(credits.total) && credits.total > 0 ? ' / ' + formatNumber(credits.total) : ''
      var unit = credits.unit === 'credits' ? bind(t, 'creditsUnit') : ''
      return remain + total + ' ' + unit
    }

    /** 健康状态的文案键。 */
    function healthTextKey(state) {
      if (state === 'ok') return 'healthOk'
      if (state === 'degraded') return 'healthDegraded'
      if (state === 'down') return 'healthDown'
      if (state === 'stale') return 'healthStale'
      if (state === 'testedOk') return 'testedAvailableShort'
      if (state === 'testedLimited') return 'testedLimitedShort'
      if (state === 'testedAuth') return 'testedAuthShort'
      if (state === 'testedFailed') return 'testedFailedShort'
      return 'healthUnknown'
    }

    /** 一次模型测试结果 → 展示状态。 */
    function testedHealthState(result) {
      if (result === null || typeof result !== 'object') return undefined
      if (result.ok === true) return 'testedOk'
      if (result.code === 'RATE_LIMIT' || result.code === 'QUOTA') return 'testedLimited'
      if (result.code === 'AUTH') return 'testedAuth'
      return 'testedFailed'
    }

    /**
     * 找一个 provider 下最近一次「账号 × 模型」测试。
     * 返回 {result, modelId, modelName, accountId, accountLabel, state}；
     * 只作为展示证据，不写回 provider 历史 health。
     */
    function latestModelTestOf(entry) {
      var latest
      safeArray(entry && entry.accounts).forEach(function (account) {
        var tests = account.modelTests
        if (tests === null || typeof tests !== 'object') return
        Object.keys(tests).forEach(function (modelId) {
          var result = tests[modelId]
          if (result === null || typeof result !== 'object' || !isFiniteNumber(result.at)) return
          if (latest === undefined || result.at > latest.result.at) {
            var model = safeArray(entry.models).filter(function (item) { return item.id === modelId })[0]
            latest = {
              result: result,
              modelId: modelId,
              modelName: model !== undefined && (model.name || model.id) ? (model.name || model.id) : modelId,
              accountId: typeof account.id === 'string' ? account.id : undefined,
              accountLabel: typeof account.label === 'string' && account.label !== '' ? account.label : '',
              state: testedHealthState(result),
            }
          }
        })
      })
      return latest
    }

    /** 最近测试是否仍可作为当前证据（30 分钟内）。 */
    function freshModelTestOf(entry) {
      var latest = latestModelTestOf(entry)
      if (latest === undefined) return undefined
      if (!(latest.result.at > 0)) return undefined
      if (Date.now() - latest.result.at >= TEST_RESULT_TTL_MS) return undefined
      return latest
    }

    /**
     * 展示用健康状态：失败证据超过 30 分钟就不再断言「不可用」，
     * 改为 stale（待验证）。健康状态本身仍保留，供 title/账号测试使用。
     */
    function displayHealthState(health) {
      if (health === null || typeof health !== 'object') return 'unknown'
      var state = typeof health.state === 'string' ? health.state : 'unknown'
      if (state !== 'down' && state !== 'degraded') return state
      var lastErrorAt = health.lastErrorAt
      if (isFiniteNumber(lastErrorAt) && lastErrorAt > 0 && Date.now() - lastErrorAt > HEALTH_EVIDENCE_TTL_MS) return 'stale'
      return state
    }

    /** 健康状态的颜色。 */
    function healthColor(state) {
      if (state === 'ok' || state === 'testedOk') return 'var(--dsw-alias-state-success-primary, #1a8f5f)'
      if (state === 'degraded' || state === 'stale' || state === 'testedLimited' || state === 'testedAuth' || state === 'testedFailed') return 'var(--dsh-rpc-warn, #9d5c00)'
      if (state === 'down') return 'var(--dsw-alias-state-error-primary, #b3261e)'
      return 'var(--dsw-alias-label-secondary)'
    }

    /** 健康状态 → chip 色调（down 用错误色，degraded/stale/最近测试失败用警告色）。 */
    function rpcHealthTone(state) {
      if (state === 'ok' || state === 'testedOk') return 'ok'
      if (state === 'down') return 'error'
      if (state === 'degraded' || state === 'stale' || state === 'testedLimited' || state === 'testedAuth' || state === 'testedFailed') return 'warn'
      return 'muted'
    }

    /** 毫秒 → 人话。 */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
      if (ms < 1000) return String(Math.round(ms)) + 'ms'
      return String(Math.round(ms / 100) / 10) + 's'
    }

    /** 测试延迟：缺省按 0ms，非有限/负数回 —，绝不让 NaNms 进悬停提示。 */
    function formatLatency(ms) {
      if (ms === undefined) return '0ms'
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
      return String(Math.round(ms)) + 'ms'
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

    /**
     * 把服务端的 `messageKey` 渲染成当前语言的一句话。
     *
     * 服务端在记录事件时会同时写中文 `message`（CLI 与老客户端直接读它）和
     * `messageKey: {key, params}`。这里优先用后者：同一个账本在中文与英文界面
     * 下都能正确显示。没有对应键（老账本、新增事件还没加键）时回落到
     * `message`，绝不因为缺一个翻译就把整行渲染成空白。
     *
     * 参数里混着两类值：
     * - **账号名**（`account` / `from` / `to` / `label`）：隐式默认账号的名字是
     *   插件生成的，服务端会给 `*LabelKey`；这里用同样的 `labelKey` 规则本地化，
     *   用户自己起的名字保持原样。
     * - **原因/来源/代码**：上游原文，不翻译。
     *
     * 少数键带一个「条件片段」参数（签到摘要的 skipped / failed / credit，
     * 启动事件的临时文件清理），这里先拼好片段再交给 `bind()` 插值。
     *
     * @param event - 账本事件。
     * @param t - 当前语言的绑定函数。
     * @param fallback - 没有可用键时的文本。
     * @returns 显示用文本。
     */
    function eventMessageOf(event, t, fallback) {
      var spec = event !== null && typeof event === 'object' ? event.messageKey : undefined
      if (spec === null || typeof spec !== 'object' || typeof spec.key !== 'string' || spec.key === '') return fallback
      var params = spec.params !== null && typeof spec.params === 'object' ? spec.params : {}
      var values = {}
      var keys = Object.keys(params)
      for (var index = 0; index < keys.length; index++) values[keys[index]] = params[keys[index]]
      // 账号名参数：服务端同时给了 `accountLabelKey` / `fromLabelKey` /
      // `toLabelKey` / `labelKey`，命中就换成当前语言的名字。
      var namePairs = [['account', 'accountLabelKey'], ['from', 'fromLabelKey'], ['to', 'toLabelKey'], ['label', 'labelKey']]
      for (var pair = 0; pair < namePairs.length; pair++) {
        var valueField = namePairs[pair][0]
        var keyField = namePairs[pair][1]
        var labelKey = params[keyField]
        if (typeof params[valueField] !== 'string' || typeof labelKey !== 'string' || labelKey === '') continue
        var localized = bind(t, labelKey)
        if (typeof localized === 'string' && localized !== '' && localized !== labelKey) values[valueField] = localized
      }
      if (spec.key === 'eventStartup') {
        var swept = typeof params.swept === 'number' && params.swept > 0 ? params.swept : 0
        values.swept = swept > 0 ? bind(t, 'eventStartupSwept', { count: swept }) : ''
        return bind(t, 'eventStartupDetail', values)
      }
      if (spec.key === 'eventCheckinSummary') {
        var suffix = ''
        if (typeof params.skipped === 'number' && params.skipped > 0) {
          suffix += bind(t, 'eventCheckinSkippedSuffix', { skipped: params.skipped })
        }
        if (typeof params.failed === 'number' && params.failed > 0) suffix += bind(t, 'eventCheckinFailedSuffix', { failed: params.failed })
        suffix += bind(t, 'eventCheckinCreditSuffix', { credit: typeof params.credit === 'number' ? params.credit : 0 })
        values.suffix = suffix
        return bind(t, 'eventCheckinSummary', values)
      }
      if (spec.key === 'eventSwitchByCredits') {
        values.reason = params.reason === 'exhausted'
          ? bind(t, 'eventSwitchReasonExhausted')
          : bind(t, 'eventSwitchReasonLow')
        return bind(t, 'eventSwitchByCredits', values)
      }
      // 其余键都是「同名文案键 + 直接插值」。
      var text = bind(t, spec.key, values)
      // bind 对未知键会回显键名本身（`eventFoo`）：那比中文原文更糟，回落。
      if (typeof text !== 'string' || text === '' || text === spec.key) return fallback
      return text
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
      tiny: 12,
      body: 13,
      strong: 13.5,
      title: 17,
    }

    var LINE = {
      dense: '18px',
      body: '21px',
      loose: '23px',
    }

    // 小字可读性：≤12.5px 的说明文字统一用 label-secondary（亮色 #61666b ≈ 5.9:1），
    // 不再用 label-tertiary（亮色 #81858c ≈ 3.6:1）叠 opacity —— 后者在亮色主题下
    // 连 4.5:1 都不到，叠到 .5 只有 2~3:1。层级靠 secondary vs primary 区分。
    /** 账号表格列宽：账号 / 积分 / 状态 / 签到 / 操作。 */
    var ACCOUNT_COLUMNS = 'minmax(108px, 1.2fr) 96px minmax(136px, 1.5fr) 78px auto'
    var S = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        maxWidth: '100%',
        boxSizing: 'border-box',
        border: '1px solid var(--rpc-border, var(--dsw-alias-border-l2))',
        borderRadius: 18,
        background: 'var(--rpc-bg, var(--dsw-alias-bg-layer-1))',
        color: 'var(--rpc-text, var(--dsw-alias-label-primary))',
      },

      // 页头（保留给首屏加载 / 失败态，正式页头用 .rpc-hero）
      header: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: TEXT.title, fontWeight: 650, letterSpacing: '-.01em', color: 'var(--rpc-text, var(--dsw-alias-label-primary))' },
      version: {
        fontSize: TEXT.tiny,
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--rpc-muted, var(--dsw-alias-label-secondary))',
        userSelect: 'text',
      },
      intro: { margin: 0, fontSize: TEXT.body, lineHeight: LINE.body, color: 'var(--rpc-muted, var(--dsw-alias-label-secondary))', maxWidth: 620 },

      // 分区卡片：页内每一块都是独立卡片，不再用一条条上边线切碎
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 11,
        minWidth: 0,
        padding: '14px 16px 15px',
        border: '1px solid var(--rpc-border, var(--dsw-alias-border-l2))',
        borderRadius: 14,
        background: 'var(--rpc-bg, var(--dsw-alias-bg-layer-1))',
        boxShadow: 'var(--rpc-shadow-sm, none)',
        boxSizing: 'border-box',
      },
      sectionHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 22, minWidth: 0 },
      sectionTitle: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        margin: 0,
        fontSize: 12.5,
        lineHeight: '19px',
        fontWeight: 650,
        letterSpacing: '.02em',
        color: 'var(--rpc-muted, var(--dsw-alias-label-secondary))',
      },
      sectionCount: {
        display: 'inline-flex',
        alignItems: 'center',
        height: 19,
        padding: '0 7px',
        borderRadius: 999,
        background: 'var(--rpc-surface-2, var(--dsh-rpc-fill))',
        color: 'var(--rpc-muted, var(--dsw-alias-label-secondary))',
        fontSize: 10.5,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },

      // 胶囊徽标
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 20,
        padding: '0 7px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'var(--rpc-surface-2, var(--dsh-rpc-fill))',
        color: 'var(--rpc-muted, var(--dsw-alias-label-secondary))',
        fontSize: 10.5,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      },
      badgeWarn: {
        display: 'inline-flex',
        alignItems: 'center',
        height: 20,
        padding: '0 7px',
        borderRadius: 6,
        border: '1px solid color-mix(in srgb, var(--rpc-warn, #9d5c00) 22%, transparent)',
        background: 'color-mix(in srgb, var(--rpc-warn, #9d5c00) 10%, transparent)',
        color: 'var(--rpc-warn, #9d5c00)',
        fontSize: 10.5,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      },
      badgeError: {
        display: 'inline-flex',
        alignItems: 'center',
        height: 20,
        padding: '0 7px',
        borderRadius: 6,
        border: '1px solid color-mix(in srgb, var(--rpc-danger, #bf0f0f) 20%, transparent)',
        background: 'color-mix(in srgb, var(--rpc-danger, #bf0f0f) 9%, transparent)',
        color: 'var(--rpc-danger, #bf0f0f)',
        fontSize: 10.5,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      },
      badgeSoft: {
        display: 'inline-flex',
        alignItems: 'center',
        height: 20,
        padding: '0 7px',
        borderRadius: 6,
        background: 'var(--rpc-surface-2, var(--dsh-rpc-fill))',
        color: 'var(--rpc-muted, var(--dsw-alias-label-secondary))',
        fontSize: 10.5,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      },

      // 通用行
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
      stack: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      grow: { flex: 1, minWidth: 0 },
      divider: { height: 0, borderTop: '1px solid var(--rpc-border, var(--dsw-alias-border-l2))', margin: '2px 0' },
      hint: { margin: 0, fontSize: TEXT.body, lineHeight: LINE.body, color: 'var(--rpc-muted, var(--dsw-alias-label-secondary))' },
      hintTiny: { margin: 0, fontSize: TEXT.tiny, lineHeight: LINE.dense, color: 'var(--rpc-muted, var(--dsw-alias-label-secondary))' },
      hintWarn: { margin: 0, fontSize: TEXT.body, lineHeight: LINE.body, color: 'var(--rpc-warn, #9d5c00)' },
      hintError: { margin: 0, fontSize: TEXT.body, lineHeight: LINE.body, color: 'var(--rpc-danger, var(--dsw-alias-state-error-primary, #b3261e))' },
      label: { fontSize: TEXT.body, color: 'var(--rpc-muted, var(--dsw-alias-label-secondary))', fontWeight: 600 },

      // 按钮：主 / 次 / 幽灵 / 危险
      button: {
        font: 'inherit',
        fontSize: TEXT.body,
        lineHeight: 1,
        height: 31,
        padding: '0 12px',
        borderRadius: 8,
        cursor: 'pointer',
        border: '1px solid var(--rpc-border, var(--dsw-alias-border-l2))',
        background: 'var(--rpc-bg, transparent)',
        color: 'var(--rpc-text, var(--dsw-alias-label-primary))',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
      },
      buttonPrimary: {
        font: 'inherit',
        fontSize: TEXT.body,
        lineHeight: 1,
        height: 31,
        padding: '0 12px',
        borderRadius: 8,
        cursor: 'pointer',
        border: '1px solid transparent',
        background: 'var(--rpc-accent, var(--dsw-alias-state-business-primary, #2154ce))',
        color: '#fff',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        boxShadow: '0 1px 2px color-mix(in srgb, var(--rpc-accent, #2154ce) 35%, transparent)',
      },
      buttonGhost: {
        font: 'inherit',
        fontSize: TEXT.tiny,
        lineHeight: 1,
        height: 26,
        padding: '0 8px',
        borderRadius: 7,
        cursor: 'pointer',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--rpc-muted, var(--dsw-alias-label-secondary))',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
      },
      linkButton: {
        font: 'inherit',
        fontSize: TEXT.tiny,
        lineHeight: '16px',
        padding: 0,
        border: 0,
        background: 'transparent',
        cursor: 'pointer',
        color: 'var(--rpc-accent, var(--dsw-alias-link, #2154ce))',
        textDecoration: 'underline',
        textUnderlineOffset: 2,
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      },

      // 输入
      field: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 },
      input: {
        font: 'inherit',
        fontSize: TEXT.body,
        lineHeight: '20px',
        height: 33,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--rpc-border, var(--dsw-alias-border-l2))',
        background: 'var(--rpc-surface-2, var(--dsh-rpc-fill))',
        color: 'var(--rpc-text, var(--dsw-alias-label-primary))',
        width: '100%',
        boxSizing: 'border-box',
      },

      // 模型列表
      modelList: {
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        margin: 0,
        padding: 0,
        listStyle: 'none',
        borderRadius: 12,
        border: '1px solid var(--rpc-border, var(--dsw-alias-border-l2))',
        background: 'var(--rpc-bg, transparent)',
      },
      modelRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        fontSize: TEXT.body,
        lineHeight: '21px',
        padding: '8px 12px',
        minWidth: 0,
      },
      modelRowDivider: { borderTop: '1px solid var(--rpc-border, var(--dsw-alias-border-l2))' },
      modelName: { color: 'var(--rpc-text, var(--dsw-alias-label-primary))', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 },
      modelMeta: { color: 'var(--rpc-muted, var(--dsw-alias-label-secondary))', fontSize: 11.5, whiteSpace: 'nowrap' },
      modelId: {
        color: 'var(--rpc-faint, var(--dsw-alias-label-secondary))',
        fontSize: 11,
        fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
        whiteSpace: 'nowrap',
      },

      // 账号表格：固定列宽让「积分 / 状态 / 签到」在纵向对齐，扫一眼就能比较。
      accountTableScroll: { overflowX: 'auto', maxWidth: '100%' },
      accountTable: {
        minWidth: 600,
        border: '1px solid var(--rpc-border, var(--dsw-alias-border-l2))',
        borderRadius: 12,
        overflow: 'hidden',
        background: 'var(--rpc-bg, transparent)',
      },
      accountTableHead: {
        display: 'grid',
        gridTemplateColumns: ACCOUNT_COLUMNS,
        alignItems: 'center',
        gap: 10,
        padding: '8px 13px',
        background: 'var(--rpc-surface-2, rgba(127,127,127,.08))',
        borderBottom: '1px solid var(--rpc-border, var(--dsw-alias-border-l2))',
        fontSize: 11,
        fontWeight: 650,
        letterSpacing: '.045em',
        color: 'var(--rpc-muted, var(--dsw-alias-label-secondary))',
      },
      accountRow: {
        display: 'grid',
        gridTemplateColumns: ACCOUNT_COLUMNS,
        alignItems: 'start',
        gap: 10,
        padding: '12px 13px',
        minWidth: 0,
      },
      accountRowDivider: { borderTop: '1px solid var(--rpc-border, var(--dsw-alias-border-l2))' },
      accountRowActive: {
        background: 'color-mix(in srgb, var(--rpc-accent, #2154ce) 5%, transparent)',
        boxShadow: 'inset 3px 0 0 var(--rpc-accent, #2154ce)',
      },
      accountCell: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      accountNameRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      accountActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, flexWrap: 'wrap' },

      // 标签页（新页内导航用 .rpc-pagenav）
      tabs: { display: 'flex', gap: 4, flexWrap: 'wrap' },

      pre: {
        margin: 0,
        padding: '11px 12px',
        borderRadius: 10,
        border: '1px solid var(--rpc-border, var(--dsw-alias-border-l2))',
        background: 'var(--rpc-surface-2, var(--dsh-rpc-fill))',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace)',
        fontSize: 11,
        lineHeight: 1.5,
        maxHeight: 260,
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
    // 账号表里的「非当前账号」不是警告：用中性灰，避免整列看起来都在出问题。
    var DOT_IDLE = 'var(--dsw-alias-label-secondary)'

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
      }).then(function (document) {
        // 200 但 body 是 `null` / 数组 / 字符串：宿主出错或中间的代理返回了别的东西。
        // 旧代码只拦 `undefined`，`null` 会一路走到 `status.settings` 抛 TypeError，
        // 宿主的错误边界把整张卡片替换成空白。文档形状在这里一次性把关。
        if (document === null || typeof document !== 'object' || Array.isArray(document)) {
          throw new Error('status payload is not an object')
        }
        return document
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

    /** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前；超过一周回短日期。 */
    function formatAgo(ms, t) {
      if (!isFiniteNumber(ms) || ms <= 0) return '—'
      var diff = Date.now() - ms
      if (!Number.isFinite(diff)) return '—'
      if (diff < 0) diff = 0
      var minute = 60_000
      var hour = 60 * minute
      var day = 24 * hour
      if (diff < minute) return bind(t, 'agoJustNow')
      if (diff < hour) return bind(t, 'agoMinutes', { count: Math.max(1, Math.floor(diff / minute)) })
      if (diff < day) return bind(t, 'agoHours', { count: Math.max(1, Math.floor(diff / hour)) })
      if (diff < 7 * day) return bind(t, 'agoDays', { count: Math.max(1, Math.floor(diff / day)) })
      return formatShortDate(ms)
    }

    /** 额度到期：M/D HH:mm（额度通常在本年内到期，跨年不额外带年份）。 */
    function formatMonthDayTime(ms) {
      var full = formatTime(ms)
      if (full === '—') return '—'
      return full.slice(5, 10).replace('-', '/') + ' ' + full.slice(11, 16)
    }

    /** 状态色调：成功 / 警示 / 失败 / 中性。 */
    function toneColor(tone) {
      if (tone === 'ok') return 'var(--dsw-alias-state-success-primary, #1a8f5f)'
      if (tone === 'warn') return 'var(--dsh-rpc-warn, #9d5c00)'
      if (tone === 'error') return 'var(--dsw-alias-state-error-primary, #b3261e)'
      return 'var(--dsw-alias-label-secondary)'
    }

    /** 账号来源的短文案（表格第二行没有用量时用它填位）。 */
    function accountSourceText(account, t) {
      var source = typeof account.source === 'string' ? account.source : ''
      if (source === 'browser-login') return bind(t, 'accountSourceBrowser')
      if (source === 'pat') return bind(t, 'accountSourcePat')
      if (source === 'desktop') return bind(t, 'accountSourceDesktop')
      return ''
    }

    /**
     * 账号行的「状态 / 模型」列。
     *
     * 判断顺序与真实使用一致：未启用 → 未登录 → 冷却中 → 最近测试失败 →
     * 额度用尽 → 可用。冷却中的账号即使 lastTest 成功也先显示冷却，因为
     * 自动换号会跳过它。
     */
    function accountStatusOf(account, provider, t) {
      var now = Date.now()
      var lastTest = account.lastTest !== null && typeof account.lastTest === 'object' ? account.lastTest : undefined
      // 没有 at 的旧宿主按「新」处理，不能因为字段缺失就把失败结论藏掉。
      var testFresh = lastTest !== undefined
        && (!isFiniteNumber(lastTest.at) || now - lastTest.at < TEST_RESULT_TTL_MS)
      var code = lastTest !== undefined && typeof lastTest.code === 'string' ? lastTest.code : ''
      var model = lastTest !== undefined && typeof lastTest.model === 'string' && lastTest.model !== ''
        ? lastTest.model
        : (account.active === true && provider.usage !== null && typeof provider.usage === 'object'
          && provider.usage.last !== null && typeof provider.usage.last === 'object'
          // 最近一次请求是 provider 级的：切号后它可能属于另一个账号，
          // 不能把别的账号的模型拼到这个账号的相对时间后面。
          && provider.usage.last.accountId === account.id
          && typeof provider.usage.last.model === 'string' && provider.usage.last.model !== ''
          ? provider.usage.last.model
          : undefined)
      var usageAt = account.usage !== null && typeof account.usage === 'object'
        && isFiniteNumber(account.usage.lastAt) && account.usage.lastAt > 0
        ? account.usage.lastAt
        : undefined
      var at = lastTest !== undefined && isFiniteNumber(lastTest.at) && lastTest.at > 0 ? lastTest.at : usageAt
      var detailParts = []
      if (at !== undefined) detailParts.push(formatAgo(at, t))
      if (model !== undefined) detailParts.push(bind(t, 'accountModelShort', { model: model }))
      var detail = detailParts.length > 0 ? detailParts.join(' · ') : bind(t, 'accountNoRequests')
      var title = lastTest !== undefined && typeof lastTest.error === 'string' ? lastTest.error : ''

      if (account.enabled === false) {
        return { label: bind(t, 'accountDisabled'), tone: 'muted', detail: detail, title: title }
      }
      if (account.configured === false) {
        return { label: bind(t, 'accountCheckinSkipped'), tone: 'muted', detail: detail, title: title }
      }
      if (isFiniteNumber(account.cooldownUntil) && account.cooldownUntil > now) {
        var left = account.cooldownUntil - now
        var limitCode = code === 'RATE_LIMIT' || code === 'QUOTA'
        return {
          label: bind(t, 'cooldown', { time: formatShortTime(account.cooldownUntil) }),
          tone: 'warn',
          badge: limitCode ? bind(t, 'limitBadge') : undefined,
          detail: bind(t, 'accountCooldownHint', { duration: formatCompactDuration(left) })
            + (model === undefined ? '' : ' · ' + model),
          title: title,
        }
      }
      // 当前账号的凭证状态是 provider 级探测出来的；只有「当前账号」能套用它。
      // 否则会出现状态区写着「未登录」、账号表格却是绿色「可用」的矛盾
      // （桌面账号的 configured 恒为 true，不能代表真的登录成功）。
      var credential = provider.credential
      if (account.active === true && credential !== null && typeof credential === 'object'
        && typeof credential.status === 'string'
        && credential.status !== 'signed-in' && credential.status !== 'disabled') {
        var reason = typeof credential.reason === 'string' ? credential.reason : ''
        var unconfigured = reason === 'no-credential' || reason === 'app-not-found'
          || reason === 'app-ambiguous' || reason === 'app-path-invalid' || reason === 'region-mismatch'
        return {
          label: bind(t, unconfigured ? 'signedOut' : 'accountAuthFailed'),
          tone: unconfigured ? 'muted' : 'error',
          badge: unconfigured ? undefined : bind(t, 'authBadge'),
          detail: detail,
          title: typeof credential.message === 'string' && credential.message !== '' ? credential.message : title,
        }
      }
      if (testFresh && lastTest !== undefined && lastTest.ok === false) {
        var limit = code === 'RATE_LIMIT' || code === 'QUOTA'
        var auth = code === 'AUTH' || code === 'NO_ACCOUNT'
        return {
          label: bind(t, limit ? 'accountRateLimited' : auth ? 'accountAuthFailed' : 'accountTestFailed'),
          tone: limit ? 'warn' : 'error',
          badge: limit ? bind(t, 'limitBadge') : auth ? bind(t, 'authBadge') : undefined,
          detail: detail,
          title: title,
        }
      }
      var credits = account.credits
      if (credits !== undefined && credits !== null && credits.state === 'ok'
        && credits.unlimited !== true && isFiniteNumber(credits.remain) && credits.remain <= 0
        && !isQoderFreePlan(provider.provider, credits)) {
        return {
          label: bind(t, 'accountCreditsExhausted'),
          tone: 'error',
          detail: detail,
          title: isFiniteNumber(credits.resetAtMs) && credits.resetAtMs > 0
            ? bind(t, 'accountCreditsExpiry', { date: formatMonthDayTime(credits.resetAtMs) })
            : '',
        }
      }
      return { label: bind(t, 'accountAvailable'), tone: 'ok', detail: detail, title: title }
    }

    /** 账号行的签到单元格：优先按 accountId 对上本次签到结果。 */
    function accountCheckinOf(account, provider, t) {
      var checkin = provider.checkin
      if (checkin === null || checkin === undefined || typeof checkin !== 'object') {
        return { label: bind(t, 'accountCheckinNone'), tone: 'muted' }
      }
      if (checkin.enabled === false) return { label: bind(t, 'accountCheckinOff'), tone: 'muted' }
      var result = checkin.result !== null && typeof checkin.result === 'object' ? checkin.result : undefined
      var outcomes = result === undefined ? [] : safeArray(result.outcomes)
      var outcome = outcomes.find(function (item) { return item.accountId === account.id })
        || outcomes.find(function (item) { return item.accountId === undefined && item.label === account.label })
      if (outcome === undefined) {
        return {
          label: bind(t, account.configured === false ? 'accountCheckinSkipped' : 'accountCheckinNone'),
          tone: 'muted',
        }
      }
      var title = typeof outcome.message === 'string' && outcome.message !== '' ? outcome.message : ''
      if (typeof outcome.activityName === 'string' && outcome.activityName !== '') {
        title = title === '' ? outcome.activityName : title + ' · ' + outcome.activityName
      }
      if (outcome.kind === 'claimed') {
        return {
          label: bind(t, 'accountCheckinDone'),
          tone: 'ok',
          detail: isFiniteNumber(outcome.credit) && outcome.credit > 0
            ? bind(t, 'accountCheckinCredit', { credit: formatNumber(outcome.credit) })
            : undefined,
          title: title,
        }
      }
      if (outcome.kind === 'already') {
        return {
          label: bind(t, 'accountCheckinDone'),
          tone: 'ok',
          detail: isFiniteNumber(outcome.streakDays) && outcome.streakDays > 0
            ? bind(t, 'accountCheckinStreak', { days: formatNumber(outcome.streakDays) })
            : undefined,
          title: title,
        }
      }
      if (outcome.kind === 'inactive') return { label: bind(t, 'accountCheckinNoActivity'), tone: 'muted', title: title }
      if (outcome.kind === 'failed') return { label: bind(t, 'accountCheckinFailed'), tone: 'error', title: title }
      if (outcome.kind === 'unconfigured') return { label: bind(t, 'accountCheckinSkipped'), tone: 'muted', title: title }
      return { label: bind(t, 'accountCheckinNone'), tone: 'muted', title: title }
    }

    function formatWindow(tokens) {
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return '—'
      // 999,999 会舍入成 1000K：边界上直接进位成 1M，别输出「1000K」。
      if (tokens >= 1000000) return String(Math.round((tokens / 1000000) * 10) / 10) + 'M'
      if (tokens >= 999500) return '1M'
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

    // ── 图标与页签元数据 ────────────────────────────────────────────
    //
    // 全部用内联 SVG：插件不能假设宿主提供图标库，也不能加载外部资源。
    var RPC_ICON_PATHS = {
      logo: 'M9 3v4M15 3v4M7 7h10v3a5 5 0 0 1-10 0zM12 15v6',
      refresh: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4',
      pulse: 'M3 12h4l2.5-6 4 12 2.5-6h5',
      users: 'M16 19v-1.5a4.5 4.5 0 0 0-4.5-4.5h-3A4.5 4.5 0 0 0 4 17.5V19M10 9a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M16 3.5a3.5 3.5 0 0 1 0 7M20 19v-1.5a4.5 4.5 0 0 0-3-4.2',
      chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
      cube: 'm12 3 8 4.5v9L12 21l-8-4.5v-9L12 3M4 7.5l8 4.5 8-4.5M12 12v9',
      sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M7 14v6',
      grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
      check: 'M20 6 9 17l-5-5',
      alert: 'M12 3 2 21h20L12 3M12 9v5M12 18h.01',
      clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2',
      key: 'M14 10a4 4 0 1 0-4-4 4 4 0 0 0 4 4M10.5 10.5 3 18v3h3v-2h2v-2h2l2.5-2.5',
      image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9h.01',
      display: 'M3 5h18v12H3zM8 21h8M12 17v4',
      copy: 'M9 9h10v10H9zM5 15V5h10',
      external: 'M14 4h6v6M20 4l-9 9M20 14v6H4V4h6',
      trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5',
      play: 'm8 5 11 7-11 7z',
      plus: 'M12 5v14M5 12h14',
      x: 'M6 6l12 12M18 6 6 18',
      chevron: 'm6 9 6 6 6-6',
      shield: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z',
      link: 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1',
      spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8',
      search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3',
      wallet: 'M4 7h16v12H4zM4 7V5h13v2M16 13h2',
    }

    /** 统一尺寸 / 描边的内联图标。 */
    function rpcIcon(name, size, style) {
      return h('svg', {
        width: size === undefined ? 16 : size,
        height: size === undefined ? 16 : size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: Object.assign({ flex: '0 0 auto' }, style || {}),
      }, h('path', { d: RPC_ICON_PATHS[name] || RPC_ICON_PATHS.spark }))
    }

    /** 详情页的分区导航。 */
    var RPC_PAGES = [
      { id: 'overview', label: 'navOverview', icon: 'grid' },
      { id: 'accounts', label: 'navAccounts', icon: 'users' },
      { id: 'usage', label: 'navUsage', icon: 'chart' },
      { id: 'models', label: 'navModels', icon: 'cube' },
      { id: 'settings', label: 'navSettings', icon: 'sliders' },
      { id: 'activity', label: 'navActivity', icon: 'pulse' },
    ]

    /** 现有 section key → 详情页 id。 */
    var RPC_SECTION_PAGE = {
      status: 'overview',
      'overview-accounts': 'overview',
      'availability-test': 'overview',
      credits: 'overview',
      accounts: 'accounts',
      usage: 'usage',
      models: 'models',
      unavail: 'models',
      forced: 'models',
      connection: 'settings',
      display: 'settings',
      advanced: 'settings',
      events: 'activity',
      diag: 'activity',
    }

    /** chip 色调 → class 后缀。 */
    function rpcChipClass(tone) {
      if (tone === 'ok') return 'rpc-chip rpc-chip-ok'
      if (tone === 'warn') return 'rpc-chip rpc-chip-warn'
      if (tone === 'error') return 'rpc-chip rpc-chip-error'
      if (tone === 'accent') return 'rpc-chip rpc-chip-accent'
      return 'rpc-chip'
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
      // 详情页分区。所有分区保持挂载（切换只改 display），既保留本地草稿，
      // 也让状态轮询不会因为切页而重置滚动位置。
      var pageState = useState('overview')
      var activePage = pageState[0]
      var setActivePage = pageState[1]
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
      // 「账号 × 模型」表默认只画前若干行（避免 50+ 行把整页拉长），但必须
      // 给出「还有 N 行」与展开入口 —— 静默截断会让人以为那就是全部数据。
      var accountModelExpandedState = useState(false)
      var accountModelExpanded = accountModelExpandedState[0]
      var setAccountModelExpanded = accountModelExpandedState[1]
      // 可用性测试的账号 / 模型选择，按 provider 记住，切服务商不丢。
      var testPickState = useState({})
      var testPicks = testPickState[0]
      var setTestPicks = testPickState[1]
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
        // 只接受对象文档：`/action` 的响应也会走这里，宿主或中间代理出错时
        // 可能是 `null` / 数组 / 字符串，直接塞进 state 会让下一次渲染抛错。
        if (document === null || typeof document !== 'object' || Array.isArray(document)) return
        statusEpoch.current += 1
        setStatus(document)
      }

      /**
       * 组件内的一次性反馈定时器（「已复制 / 已保存 / 复制失败」这类几秒后
       * 自动消失的提示）。
       *
       * 为什么需要集中管理：这些 `setTimeout` 以前散落在事件处理里，组件卸载
       * （切侧栏、切会话、关设置弹窗）后仍会到点执行 `setState` —— React 会对
       * 已卸载组件报警，反复挂载/卸载时还会累积。这里统一记句柄，卸载时清空。
       *
       * 只用于「fire-and-forget」的 UI 反馈；轮询与登录轮询有自己的生命周期，
       * 不要混进来。
       */
      var feedbackTimers = useRef([])
      var later = function (fn, ms) {
        var handle = setTimeout(function () {
          feedbackTimers.current = feedbackTimers.current.filter(function (item) { return item !== handle })
          fn()
        }, ms)
        feedbackTimers.current.push(handle)
        return handle
      }
      useEffect(function () {
        return function () {
          feedbackTimers.current.forEach(function (handle) { clearTimeout(handle) })
          feedbackTimers.current = []
        }
      }, [])

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

      /**
       * 选择服务商：同时回到该服务商的「概览」，避免停留在上一家的设置页。
       *
       * 顺带清空模型搜索词：搜索框只在模型多于 6 个时才渲染，切成一家模型少的
       * provider 后输入框会消失、但**过滤词还在**，列表被上一个 provider 的搜索词
       * 静默过滤 —— 界面显示「没有匹配的模型」，却没有任何地方能清除它。
       * 放在这里（而不是 effect 里）是因为它必须跟着「用户真的切了服务商」，
       * 而不是跟着每次状态轮询。
       *
       * @param provider - provider id。
       */
      var selectProvider = function (provider) {
        setActiveTab(provider)
        setActivePage('overview')
        setSearchDraft('')
        // 删除确认态只对「当前正在看的这一屏」有意义：确认键里带了 provider，
        // 切走再切回来时旧确认态会原样复活 —— 用户看到一个自己几十秒前点开、
        // 早已忘掉的「再次点击确认删除」，下一次点击就直接删账号了。这里同步
        // 清掉（放在 selectProvider 而不是 effect 里，是因为它必须跟着「用户
        // 真的切了服务商」，而且要在同一次事件里就生效）。
        if (deleteConfirmTimer.current !== undefined) {
          clearTimeout(deleteConfirmTimer.current)
          deleteConfirmTimer.current = undefined
        }
        setDeleteConfirm(undefined)
      }

      var currentTestPick = active === undefined ? {} : (testPicks[active.provider] || {})
      var setTestPick = function (field, value) {
        if (active === undefined) return
        var next = Object.assign({}, testPicks)
        next[active.provider] = Object.assign({}, next[active.provider] || {})
        next[active.provider][field] = value
        setTestPicks(next)
      }

      // 页头摘要：接入数量 / 可读额度数量 / 最近更新时间。
      var enabledCount = providers.filter(function (entry) { return entry.enabled !== false }).length
      var readableCount = providers.filter(function (entry) {
        return entry.credits !== undefined && entry.credits !== null && entry.credits.state === 'ok'
      }).length
      var latestUpdate = 0
      providers.forEach(function (entry) {
        if (isFiniteNumber(entry.fetchedAt) && entry.fetchedAt > latestUpdate) latestUpdate = entry.fetchedAt
        var snapshot = entry.credits
        if (snapshot !== null && typeof snapshot === 'object' && isFiniteNumber(snapshot.fetchedAt) && snapshot.fetchedAt > latestUpdate) latestUpdate = snapshot.fetchedAt
      })

      // 切换标签只重置「这个 provider 的路径草稿」；高级设置是全局的，
      // 不能因为切标签就把用户还没保存的输入清掉。
      //
      // 但「重置」不等于「丢弃」：用户可能已经粘贴了 PAT 或填了登录文件路径，
      // 只是先去另一家看一眼状态。旧实现每次切 provider 都把草稿清空，切回来
      // 就得回上游页面重新复制一遍令牌。这里按 provider 记住草稿，切回来时原样
      // 恢复；只有保存成功才清掉（见 savePat / addAccount 的 onSuccess）。
      var providerDrafts = useRef({})
      /** 把当前 provider 的某个草稿字段记进 per-provider 草稿表。 */
      var rememberDraft = function (field, value) {
        if (active === undefined) return
        var bucket = providerDrafts.current[active.provider]
        if (bucket === undefined) bucket = providerDrafts.current[active.provider] = {}
        bucket[field] = value
      }
      /** 忘掉当前 provider 的某个草稿字段（保存成功后调用）。 */
      var forgetDraft = function (field) {
        if (active === undefined) return
        var bucket = providerDrafts.current[active.provider]
        if (bucket !== undefined) delete bucket[field]
      }
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
        var saved = providerDrafts.current[activeTab] || {}
        // 服务端值是「没有草稿」时的默认显示；有草稿就优先显示草稿，否则用户
        // 切走再切回来会看到自己刚粘贴的内容被服务端旧值覆盖掉。
        var serverAuthFile = desktop !== undefined && desktop !== null && (desktop.authFile || '') !== ''
          ? desktop.authFile
          : trae !== undefined && trae !== null ? trae.storageFile || '' : ''
        setAppPathDraft(saved.appPath !== undefined
          ? saved.appPath
          : (desktop !== undefined && desktop !== null ? desktop.electronPath || '' : ''))
        setAuthFileDraft(saved.authFile !== undefined ? saved.authFile : serverAuthFile)
        setPatDraft(saved.pat !== undefined ? saved.pat : '')
        setAccLabel(saved.accLabel !== undefined ? saved.accLabel : '')
        setAccSecret(saved.accSecret !== undefined ? saved.accSecret : '')
      }, [activeTab, active === undefined])

      /**
       * 高级设置是否被用户改过但还没保存。
       *
       * 有它才能兼顾两件互相冲突的事：
       * - 用户在输入框里改了一半，下一次 /status 轮询不能把草稿冲掉；
       * - 用户在**另一个窗口 / CLI**改了高级设置，本卡片要能同步过来，
       *   而不是停在旧值直到整页刷新。
       */
      var advDirty = useRef(false)

      // 高级设置：只要用户没在编辑，就跟随宿主每次下发的值（含外部修改）。
      useEffect(function () {
        if (status === undefined || !status.settings) return
        // 新一轮状态已到（无论是保存回读还是轮询）：把 provider 开关的本地意图
        // 交还给服务端值。否则一次失败的保存会让开关永远停在用户点出来的值上。
        pendingProviderEnabled.current = {}
        if (advDirty.current === true) return
        var advanced = status.settings.advanced || {}
        // 非有限值不能进输入框：`NaN / 1000` 会显示字面「NaN」，`Infinity * 100`
        // 会显示「Infinity」。统一走 secondsInputOf / percentInputOf 回落默认值。
        setAdvIdle(secondsInputOf(advanced.idleTimeoutMs, '180'))
        setAdvCatalog(secondsInputOf(advanced.catalogRefreshMs, '600'))
        setAdvCredits(secondsInputOf(advanced.creditsRefreshMs, '120'))
        setAdvStats(advanced.stats !== false)
        setAdvCache(advanced.catalogCache !== false)
        var alerts = status.settings.alerts || {}
        setAdvAlert(percentInputOf(alerts.lowRatio, '15'))
        setAdvAlertsEnabled(alerts.enabled !== false)
        setAdvProbeEnabled(status.settings.probe !== false)
        var auto = status.settings.autoSwitch
        var switchRatio = auto !== null && typeof auto === 'object' && isFiniteNumber(auto.thresholdRatio)
          ? auto.thresholdRatio
          : 0
        setAdvSwitch(percentInputOf(switchRatio, '0'))
        setAdvQueue(secondsInputOf(advanced.qoderQueueWaitMs, '60'))
      }, [status])

      /**
       * 切换服务商 / 卸载时清掉「删除确认」态。
       *
       * 确认键里带了 provider，切走再切回来时旧确认态会原样复活 —— 用户看到
       * 一个自己几十秒前点开、早已忘掉的「再次点击确认删除」，下一次点击就
       * 直接删账号了。
       *
       * **必须放在 `if (active === undefined) return …` 之前**：这个组件在
       * 首帧（status 还没回来）会提前 return，hook 数量比后续渲染少；把任何
       * hook 写在提前 return 之后，状态一到 React 就会抛
       * 「Rendered more hooks than during the previous render」，整张卡片被
       * 宿主的错误边界替换成空白。
       */
      useEffect(function () {
        return function () {
          if (deleteConfirmTimer.current !== undefined) {
            clearTimeout(deleteConfirmTimer.current)
            deleteConfirmTimer.current = undefined
          }
          setDeleteConfirm(undefined)
        }
      }, [activeTab])

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

      /**
       * 写一次设置并合并返回的状态。
       *
       * 失败时**不 rethrow**：这个函数被 14 处 UI 事件直接调用，全部是
       * `mutate(patch)` 这种「发出去就不管」的写法。旧实现末尾 `throw failure`
       * 会让每一次保存失败都变成一次 UnhandledPromiseRejection —— 用户看到的是
       * 错误横幅（正确），但宿主控制台同时多一条未处理拒绝（噪声，且会干扰
       * 真正的异常排查）。失败信息已经通过 `setError()` 呈现在界面上，调用方
       * 需要「成功后做点什么」时用 `options.onSuccess`，需要「失败后做点什么」
       * 时用 `options.onError`。
       *
       * @param patch - 设置补丁。
       * @param options - `{ clearPatDraft?, onSuccess?, onError? }`。
       * @returns 最新的状态文档（失败时为 undefined）。
       */
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
            if (options !== undefined && typeof options.onError === 'function') {
              try {
                options.onError(failure)
              } catch (_) {
                /* 回调失败不该再产生一个未处理拒绝 */
              }
            }
            return undefined
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

      // provider 接入开关的本地意图：/settings 会等一轮目录 + 额度刷新才回，
      // 期间连点两次都从旧 status 的 `!entry.enabled` 出发会发同一个值，
      // 「关掉再打开」最后仍停在关闭。这里按 provider 记住最后一次意图。
      var pendingProviderEnabled = useRef({})
      var toggleProvider = function (entry) {
        if (busyNow('save')) return
        var pending = pendingProviderEnabled.current[entry.provider]
        var next = pending === undefined ? !(entry.enabled !== false) : !pending
        pendingProviderEnabled.current[entry.provider] = next
        var providersPatch = {}
        providersPatch[entry.provider] = { enabled: next }
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
        // busy 键必须带 provider：不同 provider 的默认账号 id 都叫 `default`，
        // 只用 accountId 会让 A 家正在测试时 B 家同 id 账号也显示「测试中…」
        // 并被禁用（用户从没在 B 家点过测试）。
        var key = 'test:' + provider + ':' + accountId
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
        // 与 testAccount 同一套规则：busy 键必须带 provider。
        var key = 'model-test:' + provider + ':' + accountId + ':' + modelId
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
        // 与测试按钮同一套规则：busy 键必须带 provider。
        var key = 'reset:' + provider + ':' + accountId
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
            // 保存成功：草稿已经落到服务端，从此重新跟随宿主下发值。
            advDirty.current = false
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
            if (isFiniteNumber(savedAdvanced.idleTimeoutMs) && savedAdvanced.idleTimeoutMs !== sent.idleTimeoutMs) clampLabels.push(bind(t, 'advancedIdle'))
            if (isFiniteNumber(savedAdvanced.catalogRefreshMs) && savedAdvanced.catalogRefreshMs !== sent.catalogRefreshMs) clampLabels.push(bind(t, 'advancedCatalog'))
            if (isFiniteNumber(savedAdvanced.creditsRefreshMs) && savedAdvanced.creditsRefreshMs !== sent.creditsRefreshMs) clampLabels.push(bind(t, 'advancedCredits'))
            if (isFiniteNumber(savedAdvanced.qoderQueueWaitMs) && savedAdvanced.qoderQueueWaitMs !== sent.qoderQueueWaitMs) clampLabels.push(bind(t, 'advancedQueue'))
            if (savedAlertsForClamp && isFiniteNumber(savedAlertsForClamp.lowRatio) && Math.abs(savedAlertsForClamp.lowRatio - sent.lowRatio) > 1e-9) clampLabels.push(bind(t, 'advancedAlert'))
            if (savedAutoForClamp && isFiniteNumber(savedAutoForClamp.thresholdRatio) && Math.abs(savedAutoForClamp.thresholdRatio - sent.thresholdRatio) > 1e-9) clampLabels.push(bind(t, 'advancedSwitch'))
            if (clampLabels.length > 0) {
              setAdvNotice(bind(t, 'advancedClamped', { fields: clampLabels.join(bind(t, 'listSeparator')) }))
              later(function () { setAdvNotice('') }, 6000)
            }
            setAdvIdle(secondsInputOf(savedAdvanced.idleTimeoutMs, advIdle))
            setAdvCatalog(secondsInputOf(savedAdvanced.catalogRefreshMs, advCatalog))
            setAdvCredits(secondsInputOf(savedAdvanced.creditsRefreshMs, advCredits))
            setAdvQueue(secondsInputOf(savedAdvanced.qoderQueueWaitMs, advQueue))
            var savedAlerts = document && document.settings && document.settings.alerts
            if (savedAlerts) setAdvAlert(percentInputOf(savedAlerts.lowRatio, advAlert))
            if (savedAlerts) setAdvAlertsEnabled(savedAlerts.enabled !== false)
            if (document && document.settings) setAdvProbeEnabled(document.settings.probe !== false)
            var savedAuto = document && document.settings && document.settings.autoSwitch
            if (savedAuto) setAdvSwitch(percentInputOf(savedAuto.thresholdRatio, advSwitch))
            setAdvStats(savedAdvanced.stats !== false)
            setAdvCache(savedAdvanced.catalogCache !== false)
            later(function () { setAdvSaved(false) }, 1600)
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
          mutate(activeAccountPatch({ pat: pat }), { clearPatDraft: true, onSuccess: function () { forgetDraft('pat') } })
          return
        }
        var patch = { qoder: {} }
        patch.qoder[active.provider] = { pat: pat }
        mutate(patch, { clearPatDraft: true, onSuccess: function () { forgetDraft('pat') } })
      }

      var clearPat = function () {
        if (active === undefined) return
        if (accountRows.length > 0 && activeRow !== undefined) {
          // 清空草稿必须同时丢掉「按 provider 记住的草稿」：只清可见输入框的话，
          // 切走再切回会由草稿恢复 effect 把那串刚被清除的 PAT 重新填回来。
          mutate(activeAccountPatch({ forget: true }), {
            clearPatDraft: true,
            onSuccess: function () { forgetDraft('pat') },
          })
          return
        }
        var patch = { qoder: {} }
        patch.qoder[active.provider] = { pat: '' }
        mutate(patch, { clearPatDraft: true, onSuccess: function () { forgetDraft('pat') } })
      }

      var saveDesktop = function () {
        if (active === undefined) return
        var patch = { workbuddy: {} }
        patch.workbuddy[active.provider] = { electronPath: appPathDraft.trim(), authFile: authFileDraft.trim() }
        mutate(patch, { onSuccess: function () { forgetDraft('authFile'); forgetDraft('appPath') } })
      }

      /** Trae 只保存 storage.json 的路径覆盖（凭证本身由客户端维护）。 */
      var saveTrae = function () {
        if (active === undefined) return
        var patch = { trae: {} }
        patch.trae[active.provider] = { storageFile: authFileDraft.trim() }
        mutate(patch, { onSuccess: function () { forgetDraft('authFile') } })
      }

      var copyDiagnostics = function () {
        // 自动复制失败（无剪贴板权限 / 非安全上下文 / 写入被拒）不能静默：
        // 按钮临时变「复制失败」，并渲染可手动全选的 textarea 兜底。
        var showFallback = function (text) {
          setCopyFallback(String(text === undefined || text === null ? '' : text))
          setCopyFailed(true)
          later(function () { setCopyFailed(false) }, 6000)
        }
        var write = function (text) {
          if (typeof navigator !== 'undefined' && navigator !== null && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(function () {
              setCopied(true)
              later(function () { setCopied(false) }, 1500)
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

      if (status === undefined || status === null) {
        // 首屏读取失败时不能再只留一行裸英文错误：给完整卡片外壳 + 本地化说明 +
        // 可点的「重试」，否则用户只能等 20 秒轮询或重开设置页。
        return h(
          'div',
          { className: 'dsh-rpc' },
          h('header', { className: 'rpc-hero' },
            h('div', { className: 'rpc-hero-icon' }, rpcIcon('logo', 20)),
            h('div', { className: 'rpc-hero-main' },
              h('div', { className: 'rpc-hero-title' }, h('h3', {}, bind(t, 'title'))),
              h('p', { className: 'rpc-hero-sub' }, bind(t, 'intro'))),
            h('div', { className: 'rpc-hero-actions' },
              h('button', {
                type: 'button',
                className: 'rpc-btn rpc-btn-primary',
                onClick: retryLoad,
                disabled: isBusy('reload'),
              }, rpcIcon('refresh', 15), isBusy('reload') ? bind(t, 'retrying') : bind(t, 'retry')))),
          h('div', { className: 'rpc-page' },
            error === undefined
              ? h('div', { className: 'rpc-empty', role: 'status' },
                  h('span', { className: 'rpc-empty-icon' }, rpcIcon('refresh', 18)),
                  h('span', {}, bind(t, 'loading')))
              : h('div', { key: 'load-fail', className: 'rpc-empty', role: 'status' },
                  h('span', { className: 'rpc-empty-icon' }, rpcIcon('alert', 18)),
                  h('span', { style: { fontWeight: 600, color: 'var(--rpc-text)' }, title: error }, bind(t, 'statusLoadFailed')),
                  h('span', {}, bind(t, 'statusLoadFailedHint')))),
        )
      }

      // 预警阈值由宿主下发；老宿主没有 alerts 时沿用 15%。
      var alertSettings = (status.settings && status.settings.alerts) || {}
      var alertRatio = isFiniteNumber(alertSettings.lowRatio) && alertSettings.lowRatio > 0 && alertSettings.lowRatio < 1
        ? alertSettings.lowRatio
        : LOW_CREDITS_RATIO
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
            host: isFiniteNumber(status.version) ? String(status.version) : '?',
            client: String(EXPECTED_STATUS_VERSION),
          }))
        : null

      // ── 服务商选择条 ─────────────────────────────────────────────
      //
      // 概览卡和标签页原本是两套并行的选择器（上面一排卡片 + 下面一排胶囊），
      // 同一件事画了两遍，视觉噪音主要来自这里。现在只有一套：每张卡既是
      // 概览，也是 provider tab。
      var providerCards = providers.map(function (entry) {
        var health = entry.health || { state: 'unknown' }
        // 最近一次模型测试比历史 health 更及时；有 30 分钟内的结果时，
        // provider 卡也显示「刚测可用 / 刚测限额」，而不是继续挂「待验证」。
        var cardTest = freshModelTestOf(entry)
        var healthState = cardTest !== undefined && cardTest.state !== undefined
          ? cardTest.state
          : displayHealthState(health)
        var disabled = entry.enabled === false
        var signed = entry.credential !== undefined && entry.credential !== null && entry.credential.status === 'signed-in'
        var credits = entry.credits || { state: 'none' }
        var today = (entry.usage && entry.usage.today) || {}
        var selected = entry.provider === activeTab
        var accent = PROVIDER_ACCENT[entry.provider] || 'currentColor'
        var low = creditsWarning(credits, entry.provider, alertRatio, alertsEnabled)
        var freePlan = isQoderFreePlan(entry.provider, credits)
        // 读失败与「真的是 0」必须长得不一样：前者给 `—`，后者才显示 0。
        var valueText = credits.state === 'ok'
          ? credits.unlimited === true ? '∞' : freePlan ? bind(t, 'creditsFree') : compactNumber(credits.remain)
          : '—'
        var valueTitle = credits.state === 'ok'
          ? formatCreditsText(credits, t)
          : typeof credits.error === 'string' && credits.error !== ''
            ? bind(t, credits.state === 'error' ? 'creditsUnreadable' : 'creditsNone') + ': ' + credits.error
            : bind(t, credits.state === 'none' ? 'creditsNone' : 'creditsUnreadable')
        var modelCount = isFiniteNumber(entry.modelCount) ? entry.modelCount : safeArray(entry.models).length
        var metaParts = [String(modelCount) + ' ' + bind(t, 'models')]
        if (isFiniteNumber(today.requests) && today.requests > 0) metaParts.push(formatNumber(today.requests) + ' ' + bind(t, 'usageCalls'))
        var ratio
        if (credits.state === 'ok' && credits.unlimited !== true && isFiniteNumber(credits.total) && credits.total > 0 && isFiniteNumber(credits.remain)) {
          ratio = Math.max(0, Math.min(1, credits.remain / credits.total))
        }
        // 关闭的服务商不能继续挂「无记录」/「正常」：那会被读成「配置有问题」，
        // 而真实原因是「你把它关了」。颜色也退回中性灰。
        var healthTone = disabled ? DOT_IDLE : signed ? healthColor(healthState) : DOT_OFF
        return h(
          'button',
          {
            key: entry.provider,
            id: 'dsh-rpc-tab-' + entry.provider,
            type: 'button',
            role: 'tab',
            'aria-selected': selected,
            'aria-controls': 'dsh-rpc-detail',
            // 标准 tabs 模式：只有当前 tab 进 Tab 键序列，方向键在 tab 间移动。
            tabIndex: selected ? 0 : -1,
            className: 'rpc-provider',
            style: {
              '--rpc-provider-accent': accent,
              opacity: entry.enabled === false ? 0.62 : 1,
            },
            title: entry.displayName + ' · ' + valueTitle,
            onClick: function () { selectProvider(entry.provider) },
          },
          h('span', { className: 'rpc-provider-top' },
            h('span', {
              className: 'rpc-provider-dot',
              style: { background: healthTone },
              title: disabled ? bind(t, 'disabled') : bind(t, healthTextKey(healthState)),
            }),
            h('span', { className: 'rpc-provider-name' }, entry.displayName),
            h('span', {
              className: 'rpc-provider-health',
              style: { color: disabled ? 'var(--rpc-faint)' : healthColor(healthState) },
            }, disabled ? bind(t, 'disabled') : bind(t, healthTextKey(healthState)))),
          h('span', { className: 'rpc-provider-value' },
            h('span', {
              // 读不到额度时不要用品牌色画「—」：中性色 + 悬停原因。
              // 字号 20 是设计基准（测试也用它识别汇总值），保持不换行。
              title: valueTitle,
              'aria-label': valueTitle,
              style: {
                fontSize: 20,
                lineHeight: '24px',
                fontWeight: 650,
                letterSpacing: '-.01em',
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
                color: credits.state !== 'ok'
                  ? 'var(--dsw-alias-label-tertiary, #81858c)'
                  : low ? 'var(--dsh-rpc-warn, #9d5c00)' : accent,
              },
            }, valueText)),
          h('span', { className: 'rpc-provider-meta' }, metaParts.join(' · ')),
          ratio === undefined
            ? null
            : h('span', { className: 'rpc-provider-bar' },
                h('i', {
                  style: {
                    width: Math.round(ratio * 100) + '%',
                    background: low ? 'var(--rpc-warn)' : accent,
                  },
                })),
        )
      })

      // 六家的健康一览：把「几家正常 / 几家异常 / 几家没接入」压成一条六段小条，
      // 比三个数字更容易一眼扫完；段色与 provider 卡上的状态点同一套。
      var fleet = providers.map(function (entry) {
        var health = entry.health || { state: 'unknown' }
        var cardTest = freshModelTestOf(entry)
        var state = cardTest !== undefined && cardTest.state !== undefined ? cardTest.state : displayHealthState(health)
        var signed = entry.credential !== undefined && entry.credential !== null && entry.credential.status === 'signed-in'
        var tone = entry.enabled === false
          ? 'off'
          : !signed
            ? 'idle'
            : state === 'ok' ? 'ok' : state === 'down' ? 'error' : state === 'unknown' ? 'idle' : 'warn'
        return {
          provider: entry.provider,
          name: entry.displayName,
          tone: tone,
          text: entry.enabled === false ? bind(t, 'disabled') : bind(t, healthTextKey(state)),
        }
      })
      var fleetOk = fleet.filter(function (item) { return item.tone === 'ok' }).length

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
            className: 'rpc-banner rpc-banner-warn',
          },
          rpcIcon('alert', 15),
          h('span', { style: { minWidth: 0 } }, alertLines.join(' ')))

      var hero = h('header', { className: 'rpc-hero' },
        h('div', { className: 'rpc-hero-icon' }, rpcIcon('logo', 20)),
        h('div', { className: 'rpc-hero-main' },
          h('div', { className: 'rpc-hero-title' },
            h('h3', {}, bind(t, 'title')),
            h('span', { className: 'rpc-chip' }, 'v' + (status.plugin && status.plugin.version ? status.plugin.version : '?')),
            h('span', {
              className: 'rpc-chip ' + (status.host && status.host.images === true ? 'rpc-chip-ok' : 'rpc-chip-warn'),
              title: status.host && status.host.images === true ? bind(t, 'imagesOn') : bind(t, 'imagesOff'),
            }, rpcIcon('image', 12), status.host && status.host.images === true ? bind(t, 'imagesShort') : bind(t, 'imagesShortOff'))),
          h('p', { className: 'rpc-hero-sub' }, bind(t, 'intro')),
          h('div', { className: 'rpc-hero-meta' },
            h('span', { className: 'rpc-chip' }, rpcIcon('users', 12), bind(t, 'providersEnabled', { count: enabledCount, total: providers.length })),
            fleet.length === 0
              ? null
              : h('span', {
                  key: 'fleet',
                  className: 'rpc-chip rpc-fleet',
                  title: fleet.map(function (item) { return item.name + ' · ' + item.text }).join('\n'),
                },
                h('span', { className: 'rpc-fleet-bars', 'aria-hidden': 'true' },
                  fleet.map(function (item) {
                    return h('i', { key: item.provider, className: 'rpc-fleet-seg', 'data-tone': item.tone })
                  })),
                bind(t, 'fleetHealthy', { count: fleetOk })),
            h('span', { className: 'rpc-chip' }, rpcIcon('wallet', 12), bind(t, 'providersCredits', { count: readableCount })),
            latestUpdate > 0
              ? h('span', { className: 'rpc-chip', title: formatTime(latestUpdate) }, rpcIcon('clock', 12), bind(t, 'updatedAt', { time: formatShortTime(latestUpdate) }))
              : null)),
        h('div', { className: 'rpc-hero-actions' },
          h('button', {
            type: 'button',
            className: 'rpc-btn rpc-btn-primary',
            onClick: refresh,
            disabled: isBusy('refresh'),
          }, rpcIcon('refresh', 15), isBusy('refresh') ? bind(t, 'refreshing') : bind(t, 'refresh')),
          h('button', {
            type: 'button',
            className: 'rpc-btn',
            'aria-expanded': showDiag,
            'aria-controls': showDiag ? 'dsh-reverse-proxy-diagnostics' : undefined,
            onClick: function () {
              setActivePage('activity')
              setShowDiag(!showDiag)
            },
          }, rpcIcon('pulse', 15), bind(t, 'diagnostics'))))

      var providerRail = providers.length === 0
        ? null
        : h('div', {
            className: 'rpc-rail',
            role: 'tablist',
            'aria-label': bind(t, 'navProviders'),
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
              selectProvider(providers[next].provider)
              // WAI-ARIA tabs 要求方向键移动后**焦点跟着走**：只改 aria-selected
              // 会把焦点留在旧 tab 上，而旧 tab 的 tabIndex 已变成 -1，键盘/读屏
              // 用户再也回不来。等 React 提交 DOM 后再聚焦新 tab。
              var targetId = 'dsh-rpc-tab-' + providers[next].provider
              var focusNext = function () {
                if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return
                var element = document.getElementById(targetId)
                if (element !== null && element !== undefined && typeof element.focus === 'function') element.focus()
              }
              if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusNext)
              else setTimeout(focusNext, 0)
            },
          }, providerCards)

      // 顶部横幅（错误 / 设置损坏 / 版本漂移 / 低额度）保持常驻，
      // 不随详情页切换而消失。
      var banners = h('div', { className: 'rpc-banners' },
        error === undefined
          ? null
          : h('div', { key: 'err', className: 'rpc-banner rpc-banner-error', role: 'status' },
              rpcIcon('alert', 15),
              h('span', {}, bind(t, 'error') + ': ' + error)),
        settingsCorrupt === null
          ? null
          : h('div', { key: 'settings-corrupt', className: 'rpc-banner rpc-banner-warn' }, rpcIcon('alert', 15), settingsCorrupt),
        versionMismatch === null
          ? null
          : h('div', { key: 'version-mismatch', className: 'rpc-banner rpc-banner-warn' }, rpcIcon('alert', 15), versionMismatch),
        alertBanner)

      var sections = []

      if (active === undefined) {
        return h('div', { className: 'dsh-rpc' },
          hero,
          providerRail,
          banners,
          h('div', { className: 'rpc-page' },
            h('div', { className: 'rpc-empty' },
              h('span', { className: 'rpc-empty-icon' }, rpcIcon('cube', 18)),
              h('span', {}, bind(t, 'noModels')))))
      }

      // ── 状态 ────────────────────────────────────────────────────
      var credential = active.credential || {}
      var activeHealth = active.health || { state: 'unknown' }
      var activeHealthState = displayHealthState(activeHealth)
      var healthLastErrorAt = isFiniteNumber(activeHealth.lastErrorAt) ? activeHealth.lastErrorAt : 0
      var healthLastSuccessAt = isFiniteNumber(activeHealth.lastSuccessAt) ? activeHealth.lastSuccessAt : 0
      // 只有「最后一次失败之后还没成功过」时才需要把上次成功也摆出来；
      // 正常 provider 的最近成功时间对排障没有帮助，反而增加一行噪音。
      var showLastSuccess = healthLastErrorAt > 0 && !(healthLastSuccessAt > healthLastErrorAt)
      // 最近一次「账号 × 模型」可用性测试（可能来自任意账号/模型）。
      // 它比历史健康更及时：状态卡只显示一个当前 chip —— 有 30 分钟内的测试
      // 结果就以「刚测可用/限额/失效/失败」为准，否则退回历史「待验证/连续失败」。
      // 历史 health 仍保留在下方「最近成功/最近失败」里，不丢信息。
      var latestModelTestEvidence = freshModelTestOf(active)
      var latestModelTestFresh = latestModelTestEvidence !== undefined
      var latestModelTestResult = latestModelTestFresh ? latestModelTestEvidence.result : undefined
      var latestModelTestOk = latestModelTestFresh && latestModelTestResult.ok === true
      var latestModelTestLimit = latestModelTestFresh
        && (latestModelTestResult.code === 'RATE_LIMIT' || latestModelTestResult.code === 'QUOTA')
      var latestModelTestTitle = latestModelTestFresh
        ? [
            latestModelTestEvidence.modelName,
            latestModelTestEvidence.accountLabel || bind(t, 'accountFallback'),
            formatTime(latestModelTestResult.at),
            latestModelTestResult.code,
            latestModelTestResult.error,
          ].filter(function (value) { return typeof value === 'string' && value !== '' }).join(' · ')
        : ''
      var statusChipState = latestModelTestFresh && latestModelTestEvidence.state !== undefined
        ? latestModelTestEvidence.state
        : activeHealthState
      var latestTestStaleHint
      if (activeHealthState === 'stale' && latestModelTestFresh) {
        if (latestModelTestOk) {
          latestTestStaleHint = bind(t, 'healthStaleTestOkHint', {
            model: latestModelTestEvidence.modelName,
            time: formatAgo(latestModelTestResult.at, t),
          })
        } else if (latestModelTestLimit) {
          latestTestStaleHint = bind(t, 'healthStaleTestLimitHint', {
            model: latestModelTestEvidence.modelName,
            time: formatAgo(latestModelTestResult.at, t),
            reset: typeof latestModelTestResult.resetHint === 'string' && latestModelTestResult.resetHint !== ''
              ? latestModelTestResult.resetHint
              : '—',
          })
        }
      }
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

      var kindLabel = active.kind === 'desktop'
        ? bind(t, 'kindDesktop')
        : active.kind === 'desktop-auth' ? bind(t, 'kindDesktopAuth') : bind(t, 'kindPat')
      var credentialTone = credential.status === 'signed-in'
        ? 'ok'
        : credential.status === 'disabled' ? 'muted' : 'warn'
      var credentialLabel = credential.status === 'signed-in'
        ? bind(t, 'signedIn')
        : credential.status === 'disabled' ? bind(t, 'disabled') : bind(t, 'signedOut')
      var activeAccountLabel = safeArray(active.accounts).filter(function (row) { return row.active })[0]
      var modelTotal = isFiniteNumber(active.modelCount) ? active.modelCount : safeArray(active.models).length

      // 详情页头：只放「这家是谁、现在能不能用」，操作按钮留给各自分区，
      // 避免同一个动作在页头和分区里出现两次。
      var detailHeader = h('div', { className: 'rpc-detail-head' },
        h('div', { className: 'rpc-detail-main' },
          h('div', { className: 'rpc-detail-title' },
            h('h4', {}, active.displayName),
            h('span', { className: 'rpc-chip' }, kindLabel),
            h('span', { className: rpcChipClass(credentialTone) }, credentialLabel)),
          h('div', { className: 'rpc-detail-meta' },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 } }, rpcIcon('clock', 12), catalogText),
            credential.status === 'signed-in' && credential.email
              ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 } }, rpcIcon('key', 12), credential.email)
              : null,
            activeAccountLabel !== undefined
              ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 } }, rpcIcon('users', 12), bind(t, 'creditsCurrent', { label: accountNameOf(activeAccountLabel, t) }))
              : null,
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, rpcIcon('cube', 12), String(modelTotal) + ' ' + bind(t, 'models')))),
        h('div', { className: 'rpc-detail-actions' },
          // 开关而不是复选框：这里控制的是「这个 provider 参不参与请求」，
          // 是即时生效的模式开关，不是表单里的多选项；开关的语义与状态色都更直接。
          h('label', {
            className: 'rpc-switch',
            title: bind(t, 'enabled'),
          },
          h('input', {
            type: 'checkbox',
            className: 'rpc-switch-input',
            checked: pendingProviderEnabled.current[active.provider] !== undefined
              ? pendingProviderEnabled.current[active.provider] === true
              : active.enabled !== false,
            disabled: isBusy('save'),
            onChange: function () { toggleProvider(active) },
          }),
          h('span', { className: 'rpc-switch-track', 'aria-hidden': 'true' }),
          h('span', { className: 'rpc-switch-text' }, bind(t, 'enabled')))))

      sections.push(
        h('div', {
          key: 'status',
          id: 'dsh-rpc-status-panel',
          style: S.section,
        },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, rpcIcon('shield', 14), bind(t, 'secStatus')),
            h('span', {
              className: rpcChipClass(rpcHealthTone(statusChipState)),
              title: latestModelTestFresh
                ? latestModelTestTitle
                : isFiniteNumber(activeHealth.consecutiveFailures) && activeHealth.consecutiveFailures > 0
                  ? bind(t, 'consecutiveFailures', { count: activeHealth.consecutiveFailures })
                  : '',
            }, bind(t, healthTextKey(statusChipState))),
            h('span', { style: S.grow }),
            h('span', { className: 'rpc-chip' }, active.images === true ? bind(t, 'imagesShort') : bind(t, 'imagesShortOff'))),
          h('dl', { className: 'rpc-kv' },
            h('dt', {}, bind(t, 'statusAccount')),
            h('dd', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              h('span', { className: 'rpc-chip' }, kindLabel),
              h('span', { className: rpcChipClass(credentialTone) }, credentialLabel)),
            h('dt', {}, bind(t, 'catalogSource')),
            h('dd', {}, catalogText),
            credential.status === 'signed-in' && credential.email
              ? h('dt', {}, bind(t, 'emailLabel'))
              : null,
            credential.status === 'signed-in' && credential.email
              ? h('dd', {}, credential.email)
              : null,
            showLastSuccess
              ? h('dt', {}, bind(t, 'lastSuccessAtLabel'))
              : null,
            showLastSuccess
              ? h('dd', {}, healthLastSuccessAt > 0
                  ? formatTime(healthLastSuccessAt) + ' · ' + formatAgo(healthLastSuccessAt, t)
                  : bind(t, 'neverSucceeded'))
              : null),
          credentialMessage !== undefined
            ? h('p', { key: 'why', className: 'rpc-warn-text' }, credentialMessage)
            : null,
          lastFailure === undefined && isFiniteNumber(activeHealth.lastErrorAt) && activeHealth.lastErrorAt > 0 && activeHealth.state !== 'ok'
            ? h('p', { key: 'last', className: 'rpc-warn-text' }, bind(t, 'lastErrorAt', { time: formatTime(activeHealth.lastErrorAt) }))
            : null,
          lastFailure !== undefined
            ? h('p', {
                key: 'lastfail',
                className: 'rpc-warn-text',
                title: typeof lastFailure.message === 'string' ? lastFailure.message : '',
              }, bind(t, 'lastFailure', {
                code: lastFailure.code || 'ERROR',
                time: formatTime(lastFailure.at),
                model: lastFailure.model || '—',
              }))
            : null,
          activeHealthState === 'stale'
            ? h('p', { key: 'stale', className: 'rpc-inline-note' }, rpcIcon('clock', 13),
                latestTestStaleHint !== undefined ? latestTestStaleHint : bind(t, 'healthStaleHint'))
            : null,
          extraMessage !== undefined ? h('p', { key: 'msg', className: 'rpc-warn-text' }, extraMessage) : null),
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
        // 走 later()：这个 3 秒复位定时器也必须在组件卸载时清掉，否则会向
        // 已卸载组件 setState（切侧栏 / 关设置弹窗时反复发生）。
        deleteConfirmTimer.current = later(function () {
          deleteConfirmTimer.current = undefined
          setDeleteConfirm(undefined)
        }, 3000)
      }
      var accountItems = accountRows.map(function (account, index) {
        var snapshot = account.credits || { state: 'none' }
        var cooling = isFiniteNumber(account.cooldownUntil) && account.cooldownUntil > Date.now()
        var testKey = 'test:' + active.provider + ':' + account.id
        var resetKey = 'reset:' + active.provider + ':' + account.id
        var status = accountStatusOf(account, active, t)
        var checkinCell = accountCheckinOf(account, active, t)
        var parts = creditsValueParts(snapshot, t)
        var freePlan = isQoderFreePlan(active.provider, snapshot)
        var creditsBig = freePlan ? bind(t, 'creditsFree') : parts.big
        var creditsSub = freePlan ? '' : parts.small
        var creditsExpiry = ''
        if (freePlan) {
          creditsExpiry = bind(t, 'creditsFreeQueue')
        } else if (snapshot.state === 'ok') {
          creditsExpiry = isFiniteNumber(snapshot.resetAtMs) && snapshot.resetAtMs > 0
            ? bind(t, 'accountCreditsExpiry', { date: formatMonthDayTime(snapshot.resetAtMs) })
            : bind(t, 'accountNoExpiry')
        }
        var creditsAlert = alertOfCredits(snapshot, alertRatio, active.provider, alertsEnabled)
        var creditsColor = freePlan
          ? toneColor('ok')
          : snapshot.state === 'none'
            ? 'var(--dsw-alias-label-secondary)'
            : snapshot.state === 'error'
              ? toneColor('error')
              : creditsAlert === undefined
                ? 'var(--dsw-alias-label-primary)'
                : toneColor(creditsAlert === 'exhausted' ? 'error' : 'warn')
        var accountLabel = accountNameOf(account, t)
        // 删除确认必须带 provider：不同 provider 的默认账号 id 都叫 `default`，
        // 只比 id 会让「在 WorkBuddy 点删除」把另一个标签页的同 id 账号也武装起来。
        var deleteConfirmKey = active.provider + '::' + account.id
        var usage = account.usage !== null && typeof account.usage === 'object' ? account.usage : undefined
        var usageMeta = usage !== undefined && (usage.requests || 0) > 0
          ? formatNumber(usage.requests || 0) + ' ' + bind(t, 'usageCalls') + ' · '
            + compactTokens(usage.totalTokens || 0)
          : accountSourceText(account, t)
        var accountCell = h('div', { key: 'who', role: 'cell', className: 'rpc-cell', style: S.accountCell },
          h('div', { key: 'name', className: 'rpc-account-name', style: S.accountNameRow },
            h('span', {
              className: 'rpc-account-dot',
              style: dot(account.active ? DOT_OK : DOT_IDLE),
              title: account.active ? bind(t, 'currentAccount') : '',
            }),
            h('span', {
              style: Object.assign({}, S.modelName, { fontWeight: account.active ? 600 : 500 }),
              title: accountLabel,
            }, accountLabel),
            account.active ? h('span', { key: 'current', className: 'rpc-chip rpc-chip-accent' }, bind(t, 'currentAccount')) : null),
          usageMeta === ''
            ? null
            : h('span', {
                key: 'usage',
                className: 'rpc-tiny',
                style: Object.assign({}, S.modelMeta, { overflow: 'hidden', textOverflow: 'ellipsis' }),
                title: usage !== undefined && (usage.requests || 0) > 0
                  ? bind(t, 'usageTokenShort') + ' ' + formatNumber(usage.totalTokens || 0)
                  : usageMeta,
              }, usageMeta))

        var creditsCell = h('div', {
          key: 'credits',
          role: 'cell',
          className: 'rpc-cell',
          style: S.accountCell,
          title: freePlan ? bind(t, 'creditsFreeQueue') : formatCreditsText(snapshot, t),
        },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0 } },
          h('span', {
            style: {
              fontSize: 18,
              lineHeight: '22px',
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              color: creditsColor,
              opacity: snapshot.stale === true ? 0.65 : 1,
            },
          }, creditsBig),
          creditsSub === ''
            ? null
            : h('span', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, creditsSub)),
        creditsExpiry === ''
          ? null
          : h('span', {
              style: {
                fontSize: 10.5,
                lineHeight: '15px',
                color: 'var(--dsw-alias-label-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              title: creditsExpiry,
            }, creditsExpiry),
        // 每行给一条 3px 的额度条：多账号并排时，谁快见底一眼就能比出来，
        // 不用在脑子里算 735/1300 与 52/1300。
        (function () {
          if (snapshot.state !== 'ok' || snapshot.unlimited === true) return null
          if (!isFiniteNumber(snapshot.total) || !(snapshot.total > 0) || !isFiniteNumber(snapshot.remain)) return null
          var share = Math.max(0, Math.min(1, snapshot.remain / snapshot.total))
          return h('span', {
            key: 'bar',
            className: 'rpc-mini-bar',
            'aria-hidden': 'true',
          }, h('i', {
            style: {
              width: Math.round(share * 100) + '%',
              background: freePlan ? toneColor('ok') : creditsAlert === undefined ? 'var(--rpc-accent)' : toneColor(creditsAlert === 'exhausted' ? 'error' : 'warn'),
            },
          }))
        })())

        var statusCell = h('div', {
          key: 'status',
          role: 'cell',
          className: 'rpc-cell',
          style: S.accountCell,
          title: status.title === '' ? undefined : status.title,
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, flexWrap: 'wrap' } },
          h('span', {
            style: { fontSize: TEXT.body, fontWeight: 500, color: toneColor(status.tone), whiteSpace: 'nowrap' },
          }, status.label),
          status.badge === undefined
            ? null
            : h('span', {
                key: 'badge',
                style: status.tone === 'error' ? S.badgeError : S.badgeWarn,
              }, status.badge),
          cooling
            ? h('button', {
                key: 'reset',
                type: 'button',
                style: S.linkButton,
                disabled: isBusy(resetKey),
                onClick: function () { resetCooldown(active.provider, account.id) },
              }, bind(t, 'resetCooldownShort'))
            : null),
        h('span', {
          style: {
            fontSize: 10.5,
            lineHeight: '15px',
            color: 'var(--dsw-alias-label-secondary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
          title: status.detail,
        }, status.detail))

        var checkinTone = checkinCell.tone
        var checkinCellNode = h('div', {
          key: 'checkin',
          role: 'cell',
          className: 'rpc-cell',
          style: S.accountCell,
          title: checkinCell.title === undefined || checkinCell.title === '' ? undefined : checkinCell.title,
        },
        h('span', {
          style: {
            fontSize: TEXT.body,
            color: toneColor(checkinTone),
            fontWeight: checkinTone === 'ok' ? 500 : 400,
            whiteSpace: 'nowrap',
          },
        }, checkinCell.label),
        checkinCell.detail === undefined
          ? null
          : h('span', {
              style: { fontSize: 10.5, lineHeight: '15px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
            }, checkinCell.detail))

        var actionButtons = []
        if (account.active !== true) {
          actionButtons.push(h('button', {
            key: 'use',
            type: 'button',
            style: Object.assign({}, S.buttonGhost, {
              color: 'var(--dsw-alias-state-business-primary, #2f6fed)',
              borderColor: 'var(--dsw-alias-state-business-primary, #2f6fed)',
            }, account.configured === false ? { opacity: 0.55 } : {}),
            disabled: isBusy('save') || account.configured === false,
            title: account.configured === false ? bind(t, 'creditsNeedLogin') : undefined,
            onClick: function () {
              var patch = { activeAccount: {} }
              patch.activeAccount[active.provider] = account.id
              mutate(patch)
            },
          }, bind(t, 'useAccount')))
        }
        actionButtons.push(h('button', {
          key: 'test',
          type: 'button',
          style: S.buttonGhost,
          disabled: isBusy(testKey),
          title: bind(t, 'testAccount'),
          onClick: function () { testAccount(active.provider, account.id) },
        }, isBusy(testKey) ? bind(t, 'testing') : bind(t, 'testAccount')))
        if (accountRows.length > 1) {
          actionButtons.push(h('button', {
            key: 'remove',
            type: 'button',
            style: Object.assign({}, S.buttonGhost, deleteConfirm === deleteConfirmKey
              ? { color: 'var(--dsw-alias-state-error-primary, #b3261e)', borderColor: 'var(--dsw-alias-state-error-primary, #b3261e)' }
              : {}),
            disabled: isBusy('save'),
            // 多账号时多个按钮都叫「删除」，用 aria-label/title 带上账号名，读屏与悬停都不混淆。
            'aria-label': bind(t, 'removeAccountAria', { name: accountLabel }),
            title: bind(t, 'removeAccountAria', { name: accountLabel }),
            onClick: function () {
              if (deleteConfirm !== deleteConfirmKey) {
                armDeleteConfirm(deleteConfirmKey)
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
          }, deleteConfirm === deleteConfirmKey ? bind(t, 'removeConfirm') : bind(t, 'removeAccount')))
        }
        var actionsCell = h('div', { key: 'actions', role: 'cell', className: 'rpc-cell-actions', style: S.accountActions }, ...actionButtons)

        return h('div', {
          key: account.id,
          role: 'row',
          className: 'rpc-table-row',
          'data-active': account.active === true ? 'true' : 'false',
          style: Object.assign({}, S.accountRow, index > 0 ? S.accountRowDivider : {}, account.active === true ? S.accountRowActive : {}),
        }, accountCell, creditsCell, statusCell, checkinCellNode, actionsCell)
      })

      var accountTableHead = h('div', { key: 'head', role: 'row', className: 'rpc-table-head', style: S.accountTableHead },
        h('span', { role: 'columnheader' }, bind(t, 'accountColAccount')),
        h('span', { role: 'columnheader' }, bind(t, 'accountColCredits')),
        h('span', { role: 'columnheader' }, bind(t, 'accountColStatus')),
        h('span', { role: 'columnheader' }, bind(t, 'accountColCheckin')),
        h('span', { role: 'columnheader', style: { textAlign: 'right' } }, bind(t, 'accountColActions')))
      var accountTable = accountRows.length === 0
        ? h('p', { key: 'empty', className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'accountsEmpty'))
        : h('div', { key: 'scroll', className: 'rpc-table-scroll', style: S.accountTableScroll },
            h('div', {
              role: 'table',
              'aria-label': bind(t, 'accountTableAria'),
              className: 'rpc-table',
              style: S.accountTable,
            }, accountTableHead, ...accountItems))

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
            forgetDraft('accLabel')
            forgetDraft('accSecret')
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
        var claimedCount = isFiniteNumber(checkinResult.claimed) ? checkinResult.claimed : 0
        var claimedCredit = isFiniteNumber(checkinResult.credit) ? checkinResult.credit : 0
        var kinds = safeArray(checkinResult.outcomes).map(function (item) { return item.kind })
        // 失败优先于「已签到 / 无活动」。
        //
        // 多账号时很常见：default 今天已签、acc-2 签到失败（HTTP 500）。旧实现
        // 先判 `already`，于是整个 provider 显示绿色的「今天已签到」，失败被完全
        // 吞掉 —— 用户既看不到失败原因，也没有「10 分钟后重试」的提示，那一个
        // 账号的每日奖励就静默丢了。签到汇总是给人看「今天到底签成了没有」的，
        // 只要有账号失败就必须显性说出来。
        if (kinds.indexOf('failed') !== -1) {
          checkinFailureRaw = (safeArray(checkinResult.outcomes).find(function (item) { return item.kind === 'failed' }) || {}).message || '—'
          checkinLabel = bind(t, 'checkinFailed', { reason: shortErrorMessage(checkinFailureRaw, t) })
          checkinTone = 'hintWarn'
        } else if (claimedCount > 0) {
          checkinLabel = bind(t, 'checkinClaimed', { count: claimedCount, credit: claimedCredit })
        } else if (kinds.indexOf('already') !== -1) {
          checkinLabel = bind(t, 'checkinAlready')
        } else if (kinds.indexOf('inactive') !== -1) {
          checkinLabel = bind(t, 'checkinInactive')
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
      // 签到徽标的色调：成功/已签为绿，失败为橙，其余（未开始/无活动/未配置）保持中性。
      var checkinPositive = false
      if (checkin.enabled !== false) {
        if (checkin.completedToday === true) checkinPositive = true
        if (checkinResult !== undefined) {
          var checkinKinds = safeArray(checkinResult.outcomes).map(function (item) { return item.kind })
          if (checkinKinds.indexOf('already') !== -1) checkinPositive = true
          if (isFiniteNumber(checkinResult.claimed) && checkinResult.claimed > 0) checkinPositive = true
        }
      }
      var overviewCheckinTone = checkinTone === 'hintWarn'
        ? 'warn'
        : checkinPositive ? 'ok' : 'muted'

      sections.push(
        h('div', { key: 'accounts', style: S.section },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, rpcIcon('users', 14), bind(t, 'secAccounts')),
            h('span', { style: S.sectionCount }, String(accountRows.length)),
            h('span', { style: S.grow }),
            h('label', { className: 'rpc-check-label' },
              h('input', {
                type: 'checkbox',
                className: 'rpc-check',
                checked: active.autoSwitch !== false,
                // 保存期间禁用：/settings 要等一轮目录 + 额度刷新，连点两次会
                // 用同一份旧 status 算出同一个值，第二次（想撤销的那次）丢失。
                disabled: isBusy('save'),
                onChange: function () { mutate({ autoSwitch: { enabled: active.autoSwitch === false } }) },
              }),
              bind(t, 'autoSwitch'))),
          h('div', { key: 'checkin', className: 'rpc-checkin' },
            h('button', {
              type: 'button',
              className: 'rpc-btn rpc-btn-sm',
              disabled: isBusy('checkin') || checkinBlocked,
              title: checkinBlocked ? bind(t, 'checkinNeedLogin') : undefined,
              onClick: function () {
                if (checkinBlocked) return
                runCheckin(active.provider)
              },
            }, rpcIcon('check', 13), isBusy('checkin') ? bind(t, 'checkinRunning') : bind(t, 'checkinNow')),
            h('label', { className: 'rpc-check-label' },
              h('input', {
                type: 'checkbox',
                className: 'rpc-check',
                checked: checkin.enabled !== false,
                onChange: function () { mutate({ checkin: { enabled: checkin.enabled === false } }) },
              }),
              bind(t, 'checkinAuto')),
            h('span', { style: S[checkinTone], title: checkinFailureRaw !== '' ? checkinFailureRaw : '' }, checkinLabel),
            checkinFailed ? h('span', { style: S.hintTiny }, bind(t, 'checkinRetryHint')) : null,
            h('span', { style: S.grow }),
            isFiniteNumber(checkin.lastRunAt) && checkin.lastRunAt > 0
              ? h('span', { style: S.modelMeta }, bind(t, 'checkinLastAt', { time: formatTime(checkin.lastRunAt) }))
              : null),
          h('p', { key: 'checkinhint', className: 'rpc-inline-note' }, rpcIcon('clock', 13), bind(t, 'checkinAutoHint')),
          accountTable,
          h('p', { key: 'hint', className: 'rpc-inline-note' }, rpcIcon('shield', 13), bind(t, isPatProvider ? 'accountsHintPat' : 'accountsHintDesktop')),
          // 桌面 provider：一键打开 App 登录，登录成功后自动导入账号。
          isPatProvider
            ? null
            : h('div', { key: 'login', className: 'rpc-subcard' },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h('span', { className: 'rpc-label' }, bind(t, 'loginAddTitle')),
                  h('span', { style: S.grow }),
                  h('button', {
                    type: 'button',
                    className: 'rpc-btn rpc-btn-sm',
                    disabled: loginBusy,
                    onClick: function () { startLogin(active.provider) },
                  }, rpcIcon('external', 13), loginBusy ? bind(t, 'loginOpening') : bind(t, 'loginAdd'))),
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
                      className: 'rpc-btn-link',
                    }, bind(t, 'loginOpenManually'))
                  : null,
                loginJob !== undefined && (loginJob.phase === 'waiting' || loginJob.phase === 'starting')
                  ? h('button', {
                      type: 'button',
                      className: 'rpc-btn rpc-btn-sm',
                      onClick: function () { cancelLogin(active.provider) },
                    }, bind(t, 'loginCancel'))
                  : null),
          // 桌面 provider 的新增账号只有「浏览器登录」这一条路 —— 手动填登录文件
          // 路径既容易和本机自动发现重复，也会让用户以为需要自己找文件。
          // Qoder 没有浏览器登录，仍然保留「名称 + PAT」的手动添加。
          isPatProvider
            ? h('div', { key: 'add', className: 'rpc-subcard' },
                h('span', { className: 'rpc-label' }, bind(t, 'addAccount')),
                h('div', { key: 'row', style: S.row },
                  h('input', {
                    className: 'rpc-input',
                    style: Object.assign({}, S.input, { flex: '1 1 160px', width: 'auto' }),
                    type: 'text',
                    'aria-label': bind(t, 'accountLabel'),
                    value: accLabel,
                    placeholder: bind(t, 'accountLabel'),
                    onChange: function (event) { setAccLabel(event.target.value); rememberDraft('accLabel', event.target.value) },
                  }),
                  h('button', {
                    type: 'button',
                    className: 'rpc-btn rpc-btn-primary rpc-btn-sm',
                    disabled: isBusy('save') || accSecret.trim() === '',
                    onClick: addAccount,
                  }, rpcIcon('plus', 13), bind(t, 'addAccount'))),
                h('input', {
                  key: 'secret',
                  className: 'rpc-input',
                  style: S.input,
                  type: 'password',
                  'aria-label': bind(t, 'accountPat'),
                  value: accSecret,
                  placeholder: bind(t, 'accountPat'),
                  onChange: function (event) { setAccSecret(event.target.value); rememberDraft('accSecret', event.target.value) },
                }),
                h('span', { key: 'sec', className: 'rpc-inline-note' }, rpcIcon('key', 13), bind(t, 'accountSecretHint')))
            : null,
        ),
      )

      // 可用性测试：账号 + 模型都由用户选，发一次 1 token 请求确认
      // 「当前能不能用 / 有没有被限额」。结果同时写进 account.modelTests，
      // 所以账号 × 模型表和这里看到的是同一份证据。
      //
      // 与上方「可用模型」列表同一套过滤：探测判定「账号不支持」的模型不列进来。
      // 否则用户能选中一个已知用不了的模型并发起测试，既浪费一次上游请求，也让
      // 下面「账号不支持」折叠区的徽章自相矛盾（列表说不支持、下拉框却可选）。
      var testModelOptions = safeArray(active.models).filter(function (model) {
        if (typeof model.id !== 'string' || model.id === '') return false
        return model.unavailable !== true || model.forced === true
      }).slice()
      var testAccountOptions = accountRows.filter(function (account) {
        return typeof account.id === 'string' && account.id !== ''
      })
      testModelOptions.sort(function (a, b) {
        if (a.id === 'auto') return -1
        if (b.id === 'auto') return 1
        if ((a.unavailable === true) !== (b.unavailable === true)) return a.unavailable === true ? 1 : -1
        return 0
      })
      var latestTestModelOption = latestModelTestEvidence !== undefined
        ? testModelOptions.filter(function (model) { return model.id === latestModelTestEvidence.modelId })[0]
        : undefined
      var defaultTestModel = latestTestModelOption
        || testModelOptions.filter(function (model) { return model.id === 'auto' })[0]
        || testModelOptions.filter(function (model) { return model.unavailable !== true })[0]
        || testModelOptions[0]
      var chosenTestModel = testModelOptions.filter(function (model) { return model.id === currentTestPick.model })[0] || defaultTestModel
      var chosenTestAccount = testAccountOptions.filter(function (account) { return account.id === currentTestPick.account })[0]
        || (latestModelTestEvidence !== undefined
          ? testAccountOptions.filter(function (account) { return account.id === latestModelTestEvidence.accountId })[0]
          : undefined)
        || testAccountOptions.filter(function (account) { return account.active === true })[0]
        || testAccountOptions[0]
      var testModelResult = chosenTestAccount !== undefined && chosenTestModel !== undefined
        && chosenTestAccount.modelTests !== null && typeof chosenTestAccount.modelTests === 'object'
        ? chosenTestAccount.modelTests[chosenTestModel.id]
        : undefined
      var testModelBusyKey = chosenTestAccount !== undefined && chosenTestModel !== undefined
        ? 'model-test:' + active.provider + ':' + chosenTestAccount.id + ':' + chosenTestModel.id
        : undefined
      var testModelResultNode = null
      if (chosenTestAccount === undefined) {
        testModelResultNode = h('span', { key: 'no-acc', className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'testModelNoAccounts'))
      } else if (chosenTestModel === undefined) {
        testModelResultNode = h('span', { key: 'no-model', className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'testModelNoModels'))
      } else if (testModelResult === null || typeof testModelResult !== 'object') {
        testModelResultNode = h('div', { key: 'never', className: 'rpc-testresult' },
          h('span', { className: 'rpc-chip' }, bind(t, 'testModelNever')),
          h('span', { style: S.grow }),
          h('span', { style: S.modelMeta }, chosenTestModel.name || chosenTestModel.id))
      } else {
        var testLimitCodes = { RATE_LIMIT: true, QUOTA: true }
        var testOk = testModelResult.ok === true
        var testLimit = testLimitCodes[testModelResult.code] === true
        var testAuth = testModelResult.code === 'AUTH'
        var testAgo = isFiniteNumber(testModelResult.at) && testModelResult.at > 0
          ? bind(t, 'testModelResultAt', { time: formatAgo(testModelResult.at, t) })
          : ''
        var testDetail
        if (testOk) {
          testDetail = bind(t, 'testOk', { ms: formatLatency(testModelResult.latencyMs) }) + (testAgo === '' ? '' : ' · ' + testAgo)
        } else if (testLimit) {
          testDetail = (typeof testModelResult.resetHint === 'string' && testModelResult.resetHint !== ''
            ? bind(t, 'limitUntil', { time: testModelResult.resetHint })
            : shortErrorMessage(testModelResult.error, t)) + (testAgo === '' ? '' : ' · ' + testAgo)
        } else {
          testDetail = shortErrorMessage(testModelResult.error, t) + (testAgo === '' ? '' : ' · ' + testAgo)
        }
        testModelResultNode = h('div', {
          key: 'result',
          className: 'rpc-testresult',
          title: typeof testModelResult.error === 'string' ? testModelResult.error : '',
        },
        h('span', {
          className: testOk ? 'rpc-chip rpc-chip-ok' : 'rpc-chip rpc-chip-warn',
        }, testOk ? bind(t, 'modelTestOk') : testLimit ? bind(t, 'limitBadge') : testAuth ? bind(t, 'authBadge') : bind(t, 'modelTestFailed')),
        h('span', { style: { minWidth: 0 } }, testDetail),
        h('span', { style: S.grow }),
        h('span', { style: S.modelMeta }, chosenTestModel.name || chosenTestModel.id))
      }

      sections.push(
        h('div', { key: 'availability-test', className: 'rpc-section rpc-testcard', style: S.section },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, rpcIcon('pulse', 14), bind(t, 'availabilityTest'))),
          h('p', { key: 'hint', className: 'rpc-inline-note', style: S.hintTiny }, rpcIcon('shield', 13), bind(t, 'availabilityTestHint')),
          chosenTestAccount === undefined || chosenTestModel === undefined
            ? null
            : h('div', { key: 'controls', className: 'rpc-testgrid' },
                h('label', { className: 'rpc-testfield' },
                  h('span', {}, bind(t, 'testModelAccount')),
                  h('select', {
                    className: 'rpc-select',
                    'aria-label': bind(t, 'testModelAccount'),
                    value: chosenTestAccount.id,
                    onChange: function (event) { setTestPick('account', event.target.value) },
                  },
                  testAccountOptions.map(function (account, index) {
                    return h('option', {
                      key: 'a' + index,
                      value: account.id,
                    }, accountNameOf(account, t)
                      + (account.active === true ? ' · ' + bind(t, 'currentAccount') : ''))
                  }))),
                h('label', { className: 'rpc-testfield' },
                  h('span', {}, bind(t, 'testModelModel')),
                  h('select', {
                    className: 'rpc-select',
                    'aria-label': bind(t, 'testModelModel'),
                    value: chosenTestModel.id,
                    onChange: function (event) { setTestPick('model', event.target.value) },
                  },
                  testModelOptions.map(function (model, index) {
                    return h('option', {
                      key: 'm' + index,
                      value: model.id,
                    }, (model.name || model.id) + (model.unavailable === true ? ' · ' + bind(t, 'unavailable') : ''))
                  }))),
                h('button', {
                  type: 'button',
                  className: 'rpc-btn rpc-btn-primary',
                  style: { height: 32 },
                  disabled: isBusy(testModelBusyKey),
                  onClick: function () {
                    testAccountModel(active.provider, chosenTestAccount.id, chosenTestModel.id)
                  },
                }, rpcIcon('pulse', 14),
                  isBusy(testModelBusyKey) ? bind(t, 'modelTesting') : bind(t, 'testModelStart'))),
          testModelResultNode),
      )

      // 概览右栏的账号摘要：只读，点「管理账号」进入账号页。
      // 它回答的是「现在是哪个账号、今天签到了没有」，不重复表格里的操作。
      if (accountRows.length > 0) {
        var overviewRow = activeRow
        sections.push(
          h('div', { key: 'overview-accounts', style: S.section },
            h('div', { key: 'h', style: S.sectionHead },
              h('span', { style: S.sectionTitle }, rpcIcon('users', 14), bind(t, 'secAccounts')),
              h('span', { style: S.sectionCount }, String(accountRows.length)),
              h('span', { style: S.grow }),
              h('button', {
                type: 'button',
                className: 'rpc-btn rpc-btn-sm',
                onClick: function () { setActivePage('accounts') },
              }, bind(t, 'manageAccounts'), rpcIcon('chevron', 12))),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
              h('span', { style: dot(DOT_OK) }),
              h('span', { style: Object.assign({}, S.modelName, { fontWeight: 600 }), title: overviewRow !== undefined ? accountNameOf(overviewRow, t) : '' },
                overviewRow !== undefined ? accountNameOf(overviewRow, t) : bind(t, 'accountFallback')),
              overviewRow !== undefined ? h('span', { className: 'rpc-chip rpc-chip-accent' }, bind(t, 'currentAccount')) : null,
              h('span', { style: S.grow }),
              h('span', { className: rpcChipClass(overviewCheckinTone), title: checkinFailureRaw !== '' ? checkinFailureRaw : '' }, checkinLabel)),
            isFiniteNumber(checkin.lastRunAt) && checkin.lastRunAt > 0
              ? h('p', { className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'checkinLastAt', { time: formatTime(checkin.lastRunAt) }))
              : null,
            h('label', { className: 'rpc-check-label', style: { cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                className: 'rpc-check',
                checked: checkin.enabled !== false,
                onChange: function () { mutate({ checkin: { enabled: checkin.enabled === false } }) },
              }),
              bind(t, 'checkinAuto'))),
        )
      }

      // ── 积分 ────────────────────────────────────────────────────
      var credits = active.credits || { state: 'none' }
      var creditsLow = creditsWarning(credits, active.provider, alertRatio, alertsEnabled)
      var qoderFreePlan = isQoderFreePlan(active.provider, credits)
      var creditsHead = h('div', { key: 'h', style: S.sectionHead },
        h('span', { style: S.sectionTitle }, rpcIcon('wallet', 14), bind(t, 'credits')),
        h('span', { style: S.grow }),
        h('button', {
          key: 'b',
          type: 'button',
          className: 'rpc-btn rpc-btn-sm',
          onClick: refreshCredits,
          disabled: isBusy('credits'),
        }, rpcIcon('refresh', 13), isBusy('credits') ? bind(t, 'creditsRefreshing') : bind(t, 'creditsRefresh')))

      var creditsBody = []
      if (credits.state === 'ok') {
        var creditsRatio = credits.unlimited === true || !isFiniteNumber(credits.total) || !(credits.total > 0)
          || !isFiniteNumber(credits.remain)
          ? undefined
          : Math.max(0, Math.min(1, credits.remain / credits.total))
        creditsBody.push(
          h('div', { key: 'stat', className: 'rpc-credit-line' },
            h('span', {
              className: 'rpc-credit-value',
              style: {
                fontSize: 38,
                lineHeight: '40px',
                color: creditsLow ? 'var(--dsh-rpc-warn, #9d5c00)' : 'var(--rpc-text)',
                opacity: credits.stale === true ? 0.68 : 1,
              },
            }, credits.unlimited === true ? '∞' : formatNumber(credits.remain)),
            isFiniteNumber(credits.total) && credits.total > 0
              ? h('span', { className: 'rpc-credit-unit' }, '/ ' + formatNumber(credits.total) + ' ' + bind(t, 'creditsUnit'))
              : h('span', { className: 'rpc-credit-unit' }, bind(t, 'creditsUnit')),
            credits.planName ? h('span', { className: 'rpc-chip' }, credits.planName) : null,
            credits.exceeded ? h('span', { className: 'rpc-chip rpc-chip-warn' }, bind(t, qoderFreePlan ? 'creditsFreeQueue' : 'creditsExhausted')) : null,
            credits.stale === true ? h('span', { className: 'rpc-chip' }, bind(t, 'creditsStale')) : null),
        )
        if (creditsRatio !== undefined) {
          creditsBody.push(
            h('div', {
              key: 'bar',
              className: 'rpc-progress',
            },
            h('i', {
              style: {
                width: Math.round(creditsRatio * 100) + '%',
                background: creditsLow ? 'var(--rpc-warn, #9d5c00)' : 'var(--rpc-accent)',
              },
            })),
          )
        }
        if (isFiniteNumber(credits.resetAtMs) && credits.resetAtMs > 0) {
          creditsBody.push(h('p', { key: 'reset', className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'creditsReset') + ' ' + formatTime(credits.resetAtMs)))
        }
        if (qoderFreePlan) {
          creditsBody.push(h('p', { key: 'freehint', className: 'rpc-inline-note' }, rpcIcon('spark', 13), bind(t, 'freeModelHint')))
        }

        // 额度趋势：今日/7 天花费、消耗速度与耗尽预估。
        var trend = credits.trend
        if (trend !== null && typeof trend === 'object' && (trend.sampleCount > 0 || safeArray(trend.points).length > 1)) {
          var trendChips = []
          trendChips.push(h('span', { key: 'td', className: 'rpc-chip' }, bind(t, 'trendToday', { value: formatNumber(trend.spentToday || 0) })))
          if (isFiniteNumber(trend.spent7d) && trend.spent7d > 0) {
            trendChips.push(h('span', { key: 'tw', className: 'rpc-chip' }, bind(t, 'trendWeek', { value: formatNumber(trend.spent7d) })))
          }
          if (isFiniteNumber(trend.topupToday) && trend.topupToday > 0) {
            trendChips.push(h('span', { key: 'tu', className: 'rpc-chip' }, bind(t, 'trendTopup', { value: formatNumber(trend.topupToday) })))
          }
          if (isFiniteNumber(trend.burnPerHour) && trend.burnPerHour > 0) {
            trendChips.push(h('span', { key: 'tr', className: 'rpc-chip' }, bind(t, 'trendRate', { value: formatNumber(trend.burnPerHour) })))
          }
          if (isFiniteNumber(trend.etaMs) && trend.etaMs > 0) {
            trendChips.push(h('span', { key: 'te', className: 'rpc-chip rpc-chip-warn' }, bind(t, 'trendEta', { duration: formatCompactDuration(trend.etaMs) })))
          }
          creditsBody.push(
            h('div', { key: 'trend', className: 'rpc-trend' },
              h('div', { className: 'rpc-trend-head' },
                h('span', { className: 'rpc-label' }, bind(t, 'trend')),
                h('span', { style: S.grow }),
                ...trendChips),
              h('div', { className: 'rpc-spark' },
                sparkline(trend.points, creditsLow ? 'var(--dsh-rpc-warn, #9d5c00)' : (PROVIDER_ACCENT[active.provider] || 'currentColor'))),
              typeof trend.etaMs !== 'number'
                ? h('span', { className: 'rpc-tiny' }, bind(t, 'trendEtaUnknown'))
                : null),
          )
        }
      } else if (credits.state === 'error') {
        creditsBody.push(h('div', { key: 'flat', className: 'rpc-empty' },
          h('span', { className: 'rpc-empty-icon' }, rpcIcon('alert', 18)),
          h('span', { style: { color: 'var(--rpc-danger)' } }, creditsText(credits))))
        // 原因字段可能是 `message`（上游原始响应）或 `error`（runtime 折过的那份）。
        var creditError = typeof credits.message === 'string' && credits.message !== ''
          ? credits.message
          : typeof credits.error === 'string' && credits.error !== '' ? credits.error : undefined
        if (creditError !== undefined) {
          creditsBody.push(h('p', { key: 'err', className: 'rpc-warn-text', style: S.hintWarn }, bind(t, 'creditsFailed', { message: creditError })))
        }
      } else {
        // `state: 'none'` 是「没有可读的额度端点 / 还没配凭证」：正文只写「未读取」，
        // 原因放在第二行（超长就截断），完整文案进悬停提示 —— 与侧栏面板同一套规则。
        creditsBody.push(h('div', { key: 'flat', className: 'rpc-empty' },
          h('span', { className: 'rpc-empty-icon' }, rpcIcon('wallet', 18)),
          h('span', {}, creditsText(credits))))
        var creditNoneReason = typeof credits.error === 'string' && credits.error !== ''
          ? credits.error
          : typeof credits.message === 'string' && credits.message !== '' ? credits.message : undefined
        if (creditNoneReason !== undefined) {
          creditsBody.push(h('p', {
            key: 'why',
            className: 'rpc-tiny',
            style: S.hintTiny,
            title: creditNoneReason,
          }, creditNoneReason.length > 60 ? creditNoneReason.slice(0, 60) + '…' : creditNoneReason))
        }
      }

      var creditItems = safeArray(credits.items)
      if (creditItems.length > 0) {
        creditsBody.push(
          h('details', { key: 'pkgs' },
            h('summary', { className: 'rpc-label', style: Object.assign({}, S.hintTiny, { cursor: 'pointer' }) },
              bind(t, 'creditsPackages', { count: creditItems.length })),
            h('ul', {
              className: 'rpc-list',
              style: Object.assign({}, S.modelList, { marginTop: 6 }),
            },
            creditItems.map(function (item, index) {
              return h('li', {
                key: 'pkg' + index,
                className: 'rpc-list-row',
                style: Object.assign({}, S.modelRow, index > 0 ? S.modelRowDivider : {}),
              },
              h('span', { style: S.modelName }, typeof item.name === 'string' && item.name !== '' ? item.name : bind(t, 'creditsPackageFallback')),
              item.expired ? h('span', { className: 'rpc-chip rpc-chip-warn' }, bind(t, 'creditsExhausted')) : null,
              h('span', { style: S.grow }),
              h('span', { className: 'rpc-model-meta' }, formatNumber(item.remain) + ' / ' + formatNumber(item.total)),
              h('span', { style: S.modelId }, isFiniteNumber(item.endAtMs) && item.endAtMs > 0 ? formatTime(item.endAtMs) : ''))
            })),
          ),
        )
      }
      if (isFiniteNumber(credits.fetchedAt) && credits.fetchedAt > 0) {
        creditsBody.push(h('p', { key: 'at', className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'creditsFetchedAt', { time: formatTime(credits.fetchedAt) })))
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
          var rate = counters.successRate
          // 成功率是 0–1 的比例：非有限值、或有限但越界（含 1e308 * 100 溢出），
          // 都不能拼成「NaN% / Infinity% / 12000%」。
          if (!isFiniteNumber(rate) || rate < 0 || rate > 1) return '—'
          return String(Math.round(rate * 100)) + '%'
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
                color: 'var(--rpc-muted)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            }, label),
            h('span', {
              key: key + '-v',
              title: title === undefined ? '' : title,
              style: {
                color: 'var(--rpc-text)',
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
                fontWeight: 600,
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
            className: 'rpc-kpi',
          },
          h('span', {
            className: 'rpc-kpi-label',
            style: { fontSize: 10.5, fontWeight: 650, letterSpacing: '.05em', color: 'var(--rpc-muted)' },
          }, label),
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 } },
            h('span', {
              className: 'rpc-kpi-value',
              style: {
                fontSize: 26,
                lineHeight: '32px',
                fontWeight: 650,
                letterSpacing: '-.02em',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--rpc-text)',
              },
            }, present === false ? '—' : formatNumber(data.requests || 0)),
            present === false
              ? null
              : h('span', { style: { fontSize: 11, color: 'var(--rpc-muted)' } }, bind(t, 'usageCalls'))),
          h('div', {
            className: 'rpc-kpi-metrics',
            style: {
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0, 1fr)',
              columnGap: 10,
              rowGap: 1,
              marginTop: 6,
              paddingTop: 7,
              borderTop: '1px solid var(--rpc-border)',
              minWidth: 0,
              fontSize: 11,
              lineHeight: '16px',
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
        var sessionPresent = typeof providerSession === 'object' && providerSession !== null && isFiniteNumber(providerSession.requests) && providerSession.requests > 0
        usageBody.push(
          h('div', {
            key: 'summary',
            className: 'rpc-usage-grid',
            style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(172px, 1fr))', gap: 10 },
          },
          usageCard('today', bind(t, 'usageToday'), usageToday, true),
          usageCard('all', bind(t, 'usageTotal'), providerUsage, true),
          usageCard('session', bind(t, 'usageSession'), providerSession, sessionPresent)),
        )
        if (active.provider.indexOf('qoder') === 0 && (usageToday.requests || 0) > 0 && (usageToday.totalTokens || 0) === 0) {
          usageBody.push(h('p', { key: 'noUsage', className: 'rpc-inline-note', style: S.hintTiny }, rpcIcon('alert', 13), bind(t, 'usageNoUsage')))
        }
        usageBody.push(
          h('div', { key: 'resetrow', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: S.grow }),
            h('button', {
              type: 'button',
              className: 'rpc-btn rpc-btn-sm',
              onClick: resetStats,
              disabled: isBusy('stats'),
            }, rpcIcon('refresh', 13), isBusy('stats') ? bind(t, 'usageResetting') : bind(t, 'usageReset'))),
        )
        if (isFiniteNumber(statsDoc.since) && statsDoc.since > 0) {
          usageBody.push(h('p', { key: 'since', className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'usageSince', { time: formatTime(statsDoc.since) })))
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
          // 窗口必须锚定在**今天**，不能锚在「最后一条有数据的日期」。
          //
          // 旧实现拿 `validDaily.at(-1).date` 当锚点：用户三天没用这一家时，
          // 14 格窗口整体左移到三天前，最右一格既不是今天、也不是任何有意义的
          // 边界 —— 用户看到「今天没用量」，其实今天那一格根本没画出来。
          // 缺的日期由下面的补 0 逻辑兜住（窗口内没有数据 = 0）。
          var now = new Date()
          var anchored = new Date(now.getFullYear(), now.getMonth(), now.getDate())
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
          var peakDate = buckets[buckets.length - 1].date
          var anyDailyTokens = false
          buckets.forEach(function (day) {
            if (isFiniteNumber(day.totalTokens) && day.totalTokens > 0) anyDailyTokens = true
            if (isFiniteNumber(day.totalTokens) && day.totalTokens > maxDailyTokens) {
              maxDailyTokens = day.totalTokens
              peakDate = day.date
            }
          })
          var todayKey = buckets[buckets.length - 1].date
          usageBody.push(
            h('div', { key: 'heat', className: 'rpc-subsection' },
              h('div', { className: 'rpc-section-head' },
                h('span', { style: S.sectionTitle }, rpcIcon('chart', 13), bind(t, 'usageHeatmap')),
                h('span', { style: S.grow }),
                anyDailyTokens
                  ? h('span', {
                      key: 'peak',
                      className: 'rpc-chip',
                      title: bind(t, 'usageHeatPeakHint', { date: peakDate }),
                    }, bind(t, 'usageHeatPeak', { value: compactTokens(maxDailyTokens) }))
                  : null,
                h('span', { key: 'window', className: 'rpc-chip' }, '14d')),
              h('div', {
                className: 'rpc-chart',
                role: 'img',
                'aria-label': bind(t, 'usageHeatAria', { days: buckets.length }),
              },
              h('div', { className: 'rpc-chart-plot' },
                buckets.map(function (day) {
                  var tokens = isFiniteNumber(day.totalTokens) ? day.totalTokens : 0
                  var height = tokens > 0 ? Math.max(4, Math.round((tokens / maxDailyTokens) * 52)) : 3
                  return h('div', {
                    key: 'd' + day.date,
                    className: 'rpc-chart-col',
                    'data-today': day.date === todayKey ? 'true' : undefined,
                    title: bind(t, 'usageHeatCell', { date: day.date, requests: formatNumber(day.requests || 0), tokens: formatNumber(tokens) }),
                  },
                  h('div', {
                    className: 'rpc-chart-bar',
                    style: {
                      height: height,
                      background: tokens > 0
                        ? (PROVIDER_ACCENT[active.provider] || 'var(--rpc-accent)')
                        : 'var(--rpc-border)',
                      opacity: tokens > 0 ? 0.55 + Math.min(0.45, tokens / maxDailyTokens / 2) : 0.35,
                    },
                  }))
                })),
              h('div', { className: 'rpc-chart-axis' },
                h('span', {}, buckets[0].date.slice(5)),
                h('span', {}, buckets[Math.floor(buckets.length / 2)].date.slice(5)),
                h('span', { className: 'rpc-chart-today' }, bind(t, 'usageHeatToday')))),
              anyDailyTokens
                ? null
                : h('p', { className: 'rpc-chart-empty' }, rpcIcon('chart', 12), bind(t, 'usageHeatEmpty'))),
          )
        }

        // 模型用量：stats.models 的键是 `provider::model`。
        var modelStats = []
        if (statsDoc.models !== null && typeof statsDoc.models === 'object') {
          Object.keys(statsDoc.models).forEach(function (key) {
            if (key.indexOf(active.provider + '::') !== 0) return
            var counters = statsDoc.models[key]
            if (counters === null || typeof counters !== 'object' || !isFiniteNumber(counters.requests) || !(counters.requests > 0)) return
            modelStats.push({ model: key.slice(active.provider.length + 2), counters: counters })
          })
        }
        modelStats.sort(function (a, b) { return b.counters.requests - a.counters.requests })
        modelStats = modelStats.slice(0, 5)
        if (modelStats.length > 0) {
          var modelColumns = 'minmax(110px, 1.6fr) minmax(46px, .7fr) minmax(68px, .9fr) minmax(56px, .8fr)'
          usageBody.push(
            h('div', { key: 'topmodels', className: 'rpc-subsection' },
              h('span', { style: S.sectionTitle }, rpcIcon('cube', 13), bind(t, 'usageTopModels')),
              h('div', { className: 'rpc-table-frame', style: usageTableFrame },
                h('div', { style: { display: 'grid', gridTemplateColumns: modelColumns, minWidth: 360, background: 'var(--rpc-surface-2)' } },
                  usageHead('m0', bind(t, 'usageModel')),
                  usageHead('m1', bind(t, 'usageModelCalls'), true),
                  usageHead('m2', bind(t, 'usageModelTokens'), true),
                  usageHead('m3', bind(t, 'usageAvg'), true)),
                modelStats.map(function (entry, index) {
                  return h('div', {
                    key: 'm' + index,
                    style: Object.assign({ display: 'grid', gridTemplateColumns: modelColumns, alignItems: 'center' }, index > 0 ? usageRowLine : {}),
                  },
                  h('span', { style: Object.assign({}, usageCell, { color: 'var(--rpc-text)', fontWeight: 500 }), title: entry.model }, entry.model || '—'),
                  h('span', { style: usageNumberCell }, formatNumber(entry.counters.requests || 0)),
                  h('span', { style: usageNumberCell }, formatNumber(entry.counters.totalTokens || 0)),
                  h('span', { style: Object.assign({}, usageNumberCell, { color: 'var(--rpc-muted)' }) }, formatDuration(entry.counters.avgDurationMs)))
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
              && isFiniteNumber(counters.requests) && counters.requests > 0
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
            // 默认账号的名字由插件生成：这里也要本地化，否则英文界面的
            // 账号 × 模型表会混着中文。「账号 id」作为最后的兜底。
            if (account !== null && typeof account.id === 'string') labelOfAccount[account.id] = accountNameOf(account, t)
          })
          Object.keys(accountModelSource).forEach(function (key) {
            var counters = accountModelSource[key]
            if (counters === null || typeof counters !== 'object') return
            // 快照里已经拆好三段（provider / accountId / model），不再自己拆键。
            if (counters.provider !== active.provider) return
            if (typeof counters.accountId !== 'string' || typeof counters.model !== 'string') return
            if (!isFiniteNumber(counters.requests) || !(counters.requests > 0)) return
            accountModelCovered += counters.requests
            accountModelRows.push({
              accountId: counters.accountId,
              label: labelOfAccount[counters.accountId] || counters.accountId,
              model: counters.model,
              counters: counters,
            })
          })
          accountModelRows.sort(function (a, b) {
            // token 相同（很常见：两条都只有 1-2 次请求）时按「账号 + 模型」再排一次，
            // 避免行序依赖 Object.keys 的插入顺序 —— 否则同一份数据在不同窗口里
            // 可能排出不同顺序，看起来像刷新出了不同结果。
            var byTokens = (Number(b.counters.totalTokens) || 0) - (Number(a.counters.totalTokens) || 0)
            if (byTokens !== 0) return byTokens
            var byAccount = String(a.label).localeCompare(String(b.label))
            if (byAccount !== 0) return byAccount
            return String(a.model).localeCompare(String(b.model))
          })
        }
        // 上方那张汇总表用的是同一个口径（今日 / 累计），直接拿来当分母。
        var accountModelTotal = effectiveAccountModelRange === 'all'
          ? (isFiniteNumber(providerUsage.requests) ? providerUsage.requests : 0)
          : (isFiniteNumber(usageToday.requests) ? usageToday.requests : 0)
        var accountModelCoverage = accountModelRows.length > 0 && accountModelTotal > 0 && accountModelCovered < accountModelTotal
          ? bind(t, 'usageAccountModelCoverage', {
            covered: formatNumber(accountModelCovered),
            total: formatNumber(accountModelTotal),
            percent: String(Math.min(99, Math.max(1, Math.round((accountModelCovered / accountModelTotal) * 100)))),
          })
          : undefined
        if (accountModelRows.length > 0) {
          var accountModelColumns = 'minmax(78px, .9fr) minmax(126px, 1.8fr) minmax(40px, .55fr) minmax(60px, .8fr) minmax(50px, .65fr) minmax(104px, 1.1fr)'
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
            // `typeof null === 'object'`：坏缓存里 `modelTests: { auto: null }` 会
            // 通过上一行的判据，然后 `test.ok` 直接抛 TypeError，整张卡片变空白。
            if (test === null) test = undefined
            var recent = test === undefined ? recentLimitFor(entry.accountId, entry.model) : undefined
            var badge = null
            if (test !== undefined && typeof test === 'object') {
              if (test.ok === true) {
                badge = h('span', {
                  className: 'rpc-chip rpc-chip-ok',
                  title: bind(t, 'testOk', { ms: formatLatency(test.latencyMs) }),
                }, bind(t, 'modelTestOk'))
              } else if (limitCodes[test.code] === true) {
                badge = h('span', {
                  className: 'rpc-chip rpc-chip-warn',
                  title: [
                    bind(t, 'limitUntil', { time: test.resetHint === undefined ? '—' : test.resetHint }),
                    test.error,
                  ].filter(function (value) { return typeof value === 'string' && value !== '' }).join(' · '),
                }, bind(t, 'limitBadge'))
              } else if (test.code === 'AUTH') {
                badge = h('span', { className: 'rpc-chip rpc-chip-warn', title: test.error ?? '' }, bind(t, 'authBadge'))
              } else {
                badge = h('span', {
                  className: 'rpc-chip rpc-chip-warn',
                  title: [test.code, test.error].filter(function (value) { return typeof value === 'string' && value !== '' }).join(' · '),
                }, bind(t, 'modelTestFailed'))
              }
            } else if (recent !== undefined) {
              // 没手动测过，但最近一次真实请求已经被上游限额：同样打徽章。
              badge = h('span', {
                className: 'rpc-chip rpc-chip-warn',
                title: [
                  bind(t, 'recentLimitHint', { code: recent.code }),
                  formatTime(recent.at),
                  recent.message,
                ].filter(function (value) { return typeof value === 'string' && value !== '' }).join(' · '),
              }, bind(t, 'limitBadge'))
            }
            // 这里只展示最近一次测试/真实请求的结论。手动「检测」按钮已移除：
            // 概览的「可用性测试」可以选择任意账号和模型，功能更完整，避免两处重复。
            return h('div', {
              style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, flexWrap: 'wrap', minWidth: 0 },
            }, badge)
          }
          // 切换按钮：两个口径的起点不同（今日 vs 累计），必须让用户能选，
          // 而不是只能看一个然后怀疑数字。老宿主没有今日数据时渲染按钮会把
          // 「今日」画成选中却显示累计，所以干脆不渲染。
          var rangeButton = function (key, label, value) {
            return h('button', {
              key: 'r' + key,
              type: 'button',
              className: 'rpc-filter',
              'aria-pressed': effectiveAccountModelRange === value,
              onClick: function () { setAccountModelRange(value) },
            }, label)
          }
          usageBody.push(
            h('div', { key: 'accountmodels', className: 'rpc-subsection' },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h('span', { style: S.sectionTitle, title: bind(t, 'usageAccountModelsHint') }, rpcIcon('users', 13), bind(t, 'usageAccountModels')),
                showRangeToggle ? rangeButton('today', bind(t, 'usageToday'), 'today') : null,
                showRangeToggle ? rangeButton('all', bind(t, 'usageTotal'), 'all') : null,
                showRangeToggle
                  ? null
                  : h('span', { className: 'rpc-chip' }, bind(t, effectiveAccountModelRange === 'all' ? 'usageTotal' : 'usageToday')),
                // 覆盖率：短 chip + 悬停完整解释，避免把两行长文案塞进表头。
                accountModelCoverage === undefined
                  ? null
                  : h('span', {
                      title: bind(t, 'usageAccountModelCoverageHint'),
                      className: 'rpc-chip rpc-chip-warn',
                    }, accountModelCoverage),
                h('span', { style: S.grow })),
              h('p', { key: 'accountmodelshint', className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'usageAccountModelsHint')),
              accountModelFallback
                ? h('p', { key: 'fallback', className: 'rpc-tiny', style: S.hintTiny, title: bind(t, 'usageAccountModelCoverageHint') }, bind(t, 'usageAccountModelTodayEmpty'))
                : null,
              h('div', { className: 'rpc-table-frame', style: usageTableFrame },
                h('div', { style: { display: 'grid', gridTemplateColumns: accountModelColumns, minWidth: 540, background: 'var(--rpc-surface-2)' } },
                  usageHead('a0', bind(t, 'usageAccountCol')),
                  usageHead('a1', bind(t, 'usageModel')),
                  usageHead('a2', bind(t, 'usageModelCalls'), true),
                  usageHead('a3', bind(t, 'usageModelTokens'), true),
                  usageHead('a4', bind(t, 'usageAvg'), true),
                  usageHead('a5', bind(t, 'usageAccountModelStatus'), true)),
                accountModelRows.map(function (entry, index) {
                  if (accountModelExpanded !== true && index >= ACCOUNT_MODEL_ROWS) return null
                  return h('div', {
                    key: 'am' + index,
                    'data-pair-row': 'true',
                    style: Object.assign({ display: 'grid', gridTemplateColumns: accountModelColumns, alignItems: 'center' }, index > 0 ? usageRowLine : {}),
                  },
                  h('span', { style: Object.assign({}, usageCell, { color: 'var(--rpc-muted)' }), title: entry.label }, entry.label || '—'),
                  h('span', { style: Object.assign({}, usageCell, { color: 'var(--rpc-text)', fontWeight: 500 }), title: entry.model }, entry.model || '—'),
                  h('span', { style: usageNumberCell }, formatNumber(entry.counters.requests || 0)),
                  h('span', { style: usageNumberCell }, formatNumber(entry.counters.totalTokens || 0)),
                  h('span', { style: Object.assign({}, usageNumberCell, { color: 'var(--rpc-muted)' }) }, formatDuration(entry.counters.avgDurationMs)),
                  modelTestCell(entry))
                })),
              // 折叠时明确说出「还有多少行」并给一个展开入口。旧实现直接
              // `slice(0, 8)`：15 行数据只画 8 行，另外 7 行**没有任何提示**，
              // 用户会以为这张表就是全部。
              accountModelRows.length > ACCOUNT_MODEL_ROWS
                ? h('div', { key: 'more', style: { display: 'flex', justifyContent: 'flex-end', marginTop: 4 } },
                    h('button', {
                      type: 'button',
                      className: 'rpc-btn rpc-btn-sm',
                      'aria-expanded': accountModelExpanded === true,
                      onClick: function () { setAccountModelExpanded(!accountModelExpanded) },
                    }, accountModelExpanded === true
                      ? bind(t, 'eventLess')
                      : bind(t, 'eventMore', { count: accountModelRows.length })))
                : null),
          )
        }

        // 最近请求默认折叠：它是排障信息，不该占用卡片主视线。
        usageBody.push(
          h('details', { key: 'recentbox', style: { marginTop: 2 } },
            h('summary', {
              style: Object.assign({}, S.sectionTitle, { cursor: 'pointer', userSelect: 'none' }),
            }, rpcIcon('clock', 13), bind(t, 'usageRecent') + ' · ' + String(recentRequests.length)),
            recentRequests.length === 0
              ? h('p', { key: 'empty', className: 'rpc-tiny', style: Object.assign({}, S.hintTiny, { marginTop: 6 }) }, bind(t, 'usageEmpty'))
              : h('div', { key: 'recent', className: 'rpc-table-frame', style: Object.assign({}, usageTableFrame, { marginTop: 6 }) },
                  h('div', { style: { display: 'grid', gridTemplateColumns: recentColumns, minWidth: 380, background: 'var(--rpc-surface-2)' } },
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
                      h('span', { style: Object.assign({}, usageCell, { color: 'var(--rpc-muted)', fontVariantNumeric: 'tabular-nums' }), title: formatTime(entry.at) }, formatShortTime(entry.at)),
                      h('span', { style: Object.assign({}, usageCell, { color: 'var(--rpc-text)' }), title: entry.model || '' }, entry.model || '—'),
                      h('span', { style: Object.assign({}, usageCell, { textAlign: 'right' }) },
                        h('span', {
                          className: failed || entry.kind === 'incomplete' ? 'rpc-chip rpc-chip-warn' : 'rpc-chip',
                          title: [entry.code, entry.message].filter(function (value) { return typeof value === 'string' && value !== '' }).join(' · '),
                        }, bind(t, kindTextKey(entry.kind)))),
                      h('span', { style: Object.assign({}, usageNumberCell, { color: 'var(--rpc-muted)' }) }, formatDuration(entry.durationMs)),
                      h('span', { style: Object.assign({}, usageNumberCell, { color: 'var(--rpc-muted)' }) }, formatNumber(entry.totalTokens || 0)),
                    )
                  }))),
        )
      }
      sections.push(
        h('div', { key: 'usage', style: S.section },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, rpcIcon('chart', 14), bind(t, 'usage')),
            h('span', { style: S.sectionCount }, formatNumber(usageToday.requests || 0))),
          ...usageBody),
      )

      // ── 连接设置 ────────────────────────────────────────────────
      var connectionBody = []
      if (active.kind === 'pat') {
        var configured = status.settings && status.settings.qoder && status.settings.qoder[active.provider] && status.settings.qoder[active.provider].configured
        connectionBody.push(
          h('div', { key: 'f', style: S.field },
            h('span', { className: 'rpc-label', style: S.label }, bind(t, 'pat')),
            h('input', {
              className: 'rpc-input',
              style: S.input,
              type: 'password',
              'aria-label': bind(t, 'pat'),
              value: patDraft,
              placeholder: configured ? bind(t, 'patConfigured', { tail: (credential.patTail || '…') }) : bind(t, 'patPlaceholder'),
              onChange: function (event) { setPatDraft(event.target.value); rememberDraft('pat', event.target.value) },
            })),
          h('p', { key: 'h', className: 'rpc-inline-note', style: S.hintTiny }, rpcIcon('shield', 13), bind(t, 'patHint')),
          h('p', { key: 'link', className: 'rpc-inline-note', style: S.hintTiny },
            rpcIcon('external', 13),
            bind(t, 'patLinkHint') + ' ',
            h('a', {
              href: PAT_PAGE[active.provider] || PAT_PAGE.qoder,
              target: '_blank',
              rel: 'noreferrer',
              className: 'rpc-btn-link',
            }, bind(t, 'patOpen'))),
          h('div', { key: 'btns', style: S.row },
            h('button', { type: 'button', className: 'rpc-btn rpc-btn-primary', style: S.buttonPrimary, onClick: savePat, disabled: isBusy('save') || patDraft.trim() === '' },
              rpcIcon('check', 14), isBusy('save') ? bind(t, 'saving') : bind(t, 'save')),
            h('button', { type: 'button', className: 'rpc-btn', style: S.button, onClick: clearPat, disabled: isBusy('save') || !configured },
              bind(t, 'clear'))),
        )
      } else if (active.kind === 'desktop-auth') {
        // Trae：不需要 PAT，也不需要找 App 可执行文件 —— 凭证就在客户端的
        // `storage.json` 里。能填的只有一个可选的路径覆盖。
        var traeConfigured = status.settings && status.settings.trae && status.settings.trae[active.provider] && status.settings.trae[active.provider].configured
        connectionBody.push(
          h('div', { key: 'st', style: S.field },
            h('span', { className: 'rpc-label', style: S.label }, bind(t, 'traeStorageFile')),
            h('input', {
              className: 'rpc-input',
              style: S.input,
              type: 'text',
              'aria-label': bind(t, 'traeStorageFile'),
              value: authFileDraft,
              placeholder: credential.file || '%APPDATA%\\Trae CN\\User\\globalStorage\\storage.json',
              onChange: function (event) { setAuthFileDraft(event.target.value); rememberDraft('authFile', event.target.value) },
            }),
            h('span', { className: 'rpc-inline-note', style: S.hintTiny }, rpcIcon('key', 13), bind(t, 'traeStorageFileHint'))),
          h('p', { key: 'h', className: 'rpc-inline-note', style: S.hintTiny },
            rpcIcon(traeConfigured ? 'check' : 'alert', 13),
            traeConfigured ? bind(t, 'traeSignedIn', { name: credential.name || credential.userId || '—' }) : bind(t, 'traeSignInHint')),
          h('div', { key: 'btns', style: S.row },
            h('button', { type: 'button', className: 'rpc-btn rpc-btn-primary', style: S.buttonPrimary, onClick: saveTrae, disabled: isBusy('save') },
              rpcIcon('check', 14), isBusy('save') ? bind(t, 'saving') : bind(t, 'save'))),
        )
      } else {
        connectionBody.push(
          h('div', { key: 'appf', style: S.field },
            h('span', { className: 'rpc-label', style: S.label }, bind(t, 'appPath')),
            h('input', {
              className: 'rpc-input',
              style: S.input,
              type: 'text',
              'aria-label': bind(t, 'appPath'),
              value: appPathDraft,
              placeholder: 'D:\\WorkBuddy\\WorkBuddy.exe',
              onChange: function (event) { setAppPathDraft(event.target.value); rememberDraft('appPath', event.target.value) },
            }),
            h('span', { className: 'rpc-inline-note', style: S.hintTiny }, rpcIcon('external', 13), bind(t, 'appPathHint'))),
          h('div', { key: 'authf', style: S.field },
            h('span', { className: 'rpc-label', style: S.label }, bind(t, 'authFile')),
            h('input', {
              className: 'rpc-input',
              style: S.input,
              type: 'text',
              'aria-label': bind(t, 'authFile'),
              value: authFileDraft,
              placeholder: credential.file || '%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth',
              onChange: function (event) { setAuthFileDraft(event.target.value); rememberDraft('authFile', event.target.value) },
            }),
            h('span', { className: 'rpc-inline-note', style: S.hintTiny }, rpcIcon('key', 13), bind(t, 'authFileHint'))),
          h('div', { key: 'btns', style: S.row },
            h('button', { type: 'button', className: 'rpc-btn rpc-btn-primary', style: S.buttonPrimary, onClick: saveDesktop, disabled: isBusy('save') },
              rpcIcon('check', 14), isBusy('save') ? bind(t, 'saving') : bind(t, 'save'))),
        )
      }

      sections.push(
        h('div', { key: 'connection', style: S.section },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, rpcIcon('key', 14), bind(t, 'secConnection'))),
          ...connectionBody),
      )

      // ── 显示偏好 ────────────────────────────────────────────────
      sections.push(
        h('div', { key: 'display', style: S.section },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, rpcIcon('display', 14), bind(t, 'displaySettings'))),
          h('p', { className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'displaySettingsHint')),
          h('label', { className: 'rpc-check-label', style: { cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              className: 'rpc-check',
              checked: status.settings && status.settings.showRateInModelName !== false,
              onChange: function () {
                mutate({ display: { showRateInModelName: !(status.settings && status.settings.showRateInModelName !== false) } })
              },
            }),
            h('span', { style: S.label }, bind(t, 'modelRateToggle'))),
          h('p', { className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'modelRateHint')),
          h('label', { className: 'rpc-check-label', style: { cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              className: 'rpc-check',
              checked: !(status.settings && status.settings.showUsageInSidebar === false),
              onChange: function () {
                var on = !(status.settings && status.settings.showUsageInSidebar === false)
                mutate({ display: { showUsageInSidebar: !on } })
              },
            }),
            h('span', { style: S.label }, bind(t, 'usageShowInSidebar')))),
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
          h('details', { className: 'rpc-details' },
            h('summary', {
              className: 'rpc-section-title',
              style: { cursor: 'pointer', fontSize: 12, fontWeight: 650, letterSpacing: '.02em', color: 'var(--rpc-muted)' },
            }, rpcIcon('sliders', 14), bind(t, 'advanced')),
            h('p', { className: 'rpc-inline-note', style: Object.assign({}, S.hintTiny, { marginTop: 8 }) }, rpcIcon('alert', 13), bind(t, 'advancedHint')),
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
                onChange: function (event) { advDirty.current = true; setAdvIdle(event.target.value) },
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
                  onChange: function (event) { advDirty.current = true; setAdvCatalog(event.target.value) },
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
                  onChange: function (event) { advDirty.current = true; setAdvCredits(event.target.value) },
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
                  onChange: function (event) { advDirty.current = true; setAdvAlert(event.target.value) },
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
                  onChange: function (event) { advDirty.current = true; setAdvSwitch(event.target.value) },
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
                onChange: function (event) { advDirty.current = true; setAdvQueue(event.target.value) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'advancedQueueHint')),
              advErrors.queue !== ''
                ? h('span', { key: 'queue-err', role: 'alert', style: S.hintWarn }, advErrorText('queue'))
                : null),
            h('label', { key: 'stats', className: 'rpc-check-label', style: { cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                className: 'rpc-check',
                checked: advStats !== false,
                onChange: function () { advDirty.current = true; setAdvStats(!(advStats !== false)) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'advancedStats'))),
            h('label', { key: 'cache', className: 'rpc-check-label', style: { cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                className: 'rpc-check',
                checked: advCache !== false,
                onChange: function () { advDirty.current = true; setAdvCache(!(advCache !== false)) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'advancedCache'))),
            h('label', { key: 'alerts', className: 'rpc-check-label', style: { cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                className: 'rpc-check',
                checked: advAlertsEnabled !== false,
                onChange: function () { advDirty.current = true; setAdvAlertsEnabled(!(advAlertsEnabled !== false)) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'advancedAlertsEnabled'))),
            h('label', { key: 'probe', className: 'rpc-check-label', style: { cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                className: 'rpc-check',
                checked: advProbeEnabled !== false,
                onChange: function () { advDirty.current = true; setAdvProbeEnabled(!(advProbeEnabled !== false)) },
              }),
              h('span', { style: S.hintTiny }, bind(t, 'advancedProbe'))),
            h('div', { key: 'btn', style: S.row },
              h('button', {
                type: 'button',
                className: 'rpc-btn rpc-btn-primary',
                style: S.button,
                // 有非法字段时直接禁用保存：宁可让用户先改对，也不要静默回退旧值。
                disabled: isBusy('advanced') || advancedSaveBlocked(),
                onClick: saveAdvanced,
              }, rpcIcon('check', 14), isBusy('advanced') ? bind(t, 'saving') : bind(t, 'advancedSave')),
              advSaved ? h('span', { className: 'rpc-chip rpc-chip-ok' }, bind(t, 'advancedSaved')) : null,
              advNotice !== '' ? h('span', { role: 'status', className: 'rpc-chip rpc-chip-warn' }, advNotice) : null)),
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
      // 搜索框只在模型多于 6 个时才渲染；列表如果缩小到 ≤6，输入框消失但
      // searchDraft 还在 —— 继续用它过滤会让列表看起来「没有匹配的模型」，
      // 而界面上已经没有能清掉这个条件的控件。计数降下来就当作没搜索。
      var searchable = models.length > 6
      var query = searchable ? searchDraft.trim().toLowerCase() : ''
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

      // 坏缓存里 name 可能缺失、甚至不是字符串（对象会被 React 当成 child 抛错），
      // 而 aria-label 缺失会让复选框变成没有名字的控件。统一取可显示的标签。
      var modelLabelOf = function (model) {
        if (typeof model.name === 'string' && model.name !== '') return model.name
        if (typeof model.id === 'string' && model.id !== '') return model.id
        return 'model'
      }

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
            h('span', { style: S.sectionTitle }, rpcIcon('cube', 14), bind(t, 'models')),
            h('span', { style: S.sectionCount }, String(models.length)),
            h('span', { style: S.grow }),
            models.length === 0
              ? null
              : h('button', { type: 'button', className: 'rpc-btn rpc-btn-sm', onClick: function () { setAllModels(active, false) }, disabled: isBusy('save') }, rpcIcon('check', 13), bind(t, 'showAll')),
            models.length === 0
              ? null
              : h('button', { type: 'button', className: 'rpc-btn rpc-btn-sm', onClick: function () { setAllModels(active, true) }, disabled: isBusy('save') }, bind(t, 'hideAll'))),
          models.length > 6
            ? h('input', {
                className: 'rpc-input',
                style: S.input,
                type: 'search',
                'aria-label': bind(t, 'searchPlaceholder'),
                value: searchDraft,
                placeholder: bind(t, 'searchPlaceholder'),
                onChange: function (event) { setSearchDraft(event.target.value) },
              })
            : null,
          h('div', { key: 'probe', style: S.row },
            h('button', { type: 'button', className: 'rpc-btn rpc-btn-sm', onClick: runProbeNow, disabled: isBusy('probe') || models.length === 0 },
              rpcIcon('pulse', 13), isBusy('probe') ? bind(t, 'probing') : bind(t, 'probe')),
            h('span', { className: 'rpc-tiny', style: S.modelMeta },
              isFiniteNumber(probe.lastRunAt) && probe.lastRunAt > 0
                ? bind(t, 'probeLast', { time: formatTime(probe.lastRunAt) })
                : bind(t, 'probeNever'))),
          h('p', { key: 'probehint', className: 'rpc-inline-note', style: S.hintTiny }, rpcIcon('shield', 13), bind(t, 'probeHint')),
          models.length === 0
            ? h('div', { key: 'nomodels', className: 'rpc-empty' },
                h('span', { className: 'rpc-empty-icon' }, rpcIcon('cube', 18)),
                h('span', {}, bind(t, 'noModels')))
            : shown.length === 0
              ? (unavailableMatches.length > 0
                  ? h('p', { key: 'nomatch-unavailable', className: 'rpc-warn-text', style: S.hintWarn }, bind(t, 'searchOnlyUnavailable', { count: unavailableMatches.length }))
                  : (query === '' && available.length === 0 && unavailable.length > 0
                    // 所有模型都被探测判定为「账号不支持」：这不是「搜索无匹配」。
                    // 旧实现落进 searchEmpty，用户会以为自己搜错了，而搜索框根本
                    // 没渲染（模型数 ≤ 6），无处可清。
                    ? h('p', { key: 'nomatch-allunavailable', className: 'rpc-warn-text', style: S.hintWarn },
                        bind(t, 'searchAllUnavailable', { count: unavailable.length }))
                    : h('p', { key: 'nomatch', className: 'rpc-tiny', style: S.hint }, bind(t, 'searchEmpty'))))
              : h('ul', { key: 'list', className: 'rpc-list rpc-model-list', style: S.modelList },
                shown.map(function (model, index) {
                  return h('li', {
                    key: model.id,
                    className: 'rpc-list-row rpc-model-row',
                    style: Object.assign({}, S.modelRow, index > 0 ? S.modelRowDivider : {}),
                  },
                  h('input', {
                    type: 'checkbox',
                    className: 'rpc-check',
                    // 勾选态要带上「还没落盘的本地改动」，否则连点时界面会闪回旧值。
                    checked: pendingModelToggles.current[active.provider + '::disabled'] !== undefined
                      && pendingModelToggles.current[active.provider + '::disabled'][model.id] !== undefined
                      ? !pendingModelToggles.current[active.provider + '::disabled'][model.id]
                      : !model.disabled,
                    'aria-label': modelLabelOf(model),
                    onChange: function () { toggleModel(active, model) },
                  }),
                  h('span', { className: 'rpc-model-name', style: S.modelName, title: modelLabelOf(model) }, modelLabelOf(model)),
                  h('span', { className: 'rpc-model-meta', style: S.modelMeta }, modelMetaText(model)),
                  h('span', { style: S.grow }),
                  h('span', { className: 'rpc-model-id', style: S.modelId }, model.id))
                })),
        ),
      )

      if (unavailable.length > 0) {
        sections.push(
          h('details', { key: 'unavail', className: 'rpc-details' },
            h('summary', { className: 'rpc-label', style: Object.assign({}, S.hintWarn, { cursor: 'pointer', color: 'var(--rpc-warn)' }) },
              rpcIcon('alert', 13), bind(t, 'unavailableCount', { count: unavailable.length })),
            h('p', { className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'unavailableHint')),
            h('ul', { className: 'rpc-list', style: Object.assign({}, S.modelList, { marginTop: 6 }) },
              unavailable.map(function (model, index) {
                return h('li', {
                  key: model.id,
                  className: 'rpc-list-row',
                  style: Object.assign({}, S.modelRow, index > 0 ? S.modelRowDivider : {}),
                },
                h('input', {
                  type: 'checkbox',
                  className: 'rpc-check',
                  // 与可用模型同一套「本地意图」：POST 没回来之前用
                  // pendingModelToggles 的值，否则连点两次都从旧的 forced === false
                  // 出发，两次都发「强制显示」，第二次无法撤销第一次。
                  checked: pendingModelToggles.current[active.provider + '::forced'] !== undefined
                    && pendingModelToggles.current[active.provider + '::forced'][model.id] !== undefined
                    ? pendingModelToggles.current[active.provider + '::forced'][model.id] === true
                    : model.forced === true,
                  'aria-label': modelLabelOf(model),
                  title: bind(t, 'forceShow'),
                  onChange: function () { toggleModel(active, model) },
                }),
                h('span', { style: S.modelMeta }, modelLabelOf(model)),
                h('span', { className: 'rpc-chip rpc-chip-warn' }, bind(t, 'unavailable')),
                model.forced === true ? h('span', { className: 'rpc-chip' }, bind(t, 'forced')) : null,
                h('span', { style: S.grow }),
                h('span', { style: S.modelId }, model.id))
              })),
          ),
        )
      }

      if (forcedCount(active) > 0) {
        sections.push(h('p', { key: 'forced', className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'forced') + ': ' + forcedCount(active)))
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
            && isFiniteNumber(event.at) && typeof event.type === 'string'
        })
        // 同一个后台失败会每轮刷新重复一次（实测「Trae 国际版没有额度端点」15 小时
        // 记了 14 条、「还没配 PAT」12 条）。同一 type/provider/账号/级别/消息合并
        // 成一行并标 ×N：既保留「还在发生」的信息，又不会把其它事件挤到下面。
        // 时间取最新一次，悬停里给出首次时间。
        var groupRepeatedEvents = function (list) {
          var groups = []
          var byKey = Object.create(null)
          for (var index = 0; index < list.length; index++) {
            var event = list[index]
            var key = [
              event.type,
              event.level,
              event.provider || '',
              event.accountId || '',
              event.message || '',
            ].join('\u0000')
            var group = byKey[key]
            if (group === undefined) {
              group = { event: event, count: 1, firstAt: event.at, lastAt: event.at }
              byKey[key] = group
              groups.push(group)
              continue
            }
            group.count += 1
            if (event.at < group.firstAt) group.firstAt = event.at
            if (event.at > group.lastAt) group.lastAt = event.at
          }
          return groups
        }
        // 筛选按钮上的数字用**合并后的行数**：表格里只画 4 行，却写「异常 34」
        // 会让人以为列表被截断了。区块标题的 34 仍然是真实事件条数。
        var matchesEventFilter = function (event, filter) {
          if (filter === 'switch') return event.type === 'account-switch'
          if (filter === 'problem') return event.level === 'warn' || event.level === 'error'
          if (filter === 'credential') return event.type === 'credential' || event.type === 'credential-refresh' || event.type === 'login'
          return true
        }
        var groupedCountOf = function (filter) {
          return groupRepeatedEvents(allEvents.filter(function (event) { return matchesEventFilter(event, filter) })).length
        }
        var eventFilters = [
          { id: 'all', label: 'eventAll', count: groupedCountOf('all') },
          { id: 'switch', label: 'eventSwitchFilter', count: groupedCountOf('switch') },
          { id: 'problem', label: 'eventProblemFilter', count: groupedCountOf('problem') },
          { id: 'credential', label: 'eventCredentialFilter', count: groupedCountOf('credential') },
        ]
        var filteredEvents = allEvents.filter(function (event) { return matchesEventFilter(event, eventFilter) })
        var groupedEvents = groupRepeatedEvents(filteredEvents)
        // 展开即渲染全部筛选结果（重复事件已合并）：宿主已把 items 截到
        // events.limit（默认 50），不再用 30 这种「看起来是全部、其实不是」的隐性上限。
        var visibleGroups = eventsExpanded === true ? groupedEvents : groupedEvents.slice(0, 6)
        var eventFilterButton = function (filter) {
          var selected = eventFilter === filter.id
          return h('button', {
            key: 'ef' + filter.id,
            type: 'button',
            className: 'rpc-filter',
            'aria-pressed': selected,
            onClick: function () {
              setEventFilter(filter.id)
              setEventsExpanded(false)
            },
          }, bind(t, filter.label) + (filter.count > 0 ? ' ' + String(filter.count) : ''))
        }
        var eventRows = visibleGroups.map(function (group, index) {
          var event = group.event
          var typeLabel = bind(t, eventTextKey(event.type))
          var rawMessage = typeof event.message === 'string' ? event.message : ''
          // 服务端会同时写 `messageKey`（结构化）与 `message`（中文原文）：
          // 有键就本地化，没有就退回中文，老账本照样能看。
          var message = rawMessage === '' || rawMessage === event.type
            ? typeLabel
            : eventMessageOf(event, t, rawMessage)
          var scope = typeof event.provider === 'string' ? shortProviderName(event.provider) : ''
          var repeatHint = group.count > 1
            ? bind(t, 'eventRepeatHint', {
                count: formatNumber(group.count),
                first: formatTime(group.firstAt),
                last: formatTime(group.lastAt),
              })
            : ''
          return h('li', {
            key: typeof event.id === 'string' ? event.id : 'ev' + String(index),
            className: 'rpc-event',
          },
          h('span', { className: 'rpc-event-dot', style: { background: eventColor(event.level) } }),
          h('span', {
            className: 'rpc-event-time',
            title: formatTime(event.at),
          }, formatShortTime(group.lastAt)),
          h('span', { className: 'rpc-chip' }, typeLabel),
          scope === '' ? null : h('span', { className: 'rpc-model-id' }, scope),
          // tooltip 也走本地化文本：悬停时显示中文原文会让英文界面显得两套语言。
          // 本地化失败（没有键）时 message 就是原文，行为不变。
          h('span', {
            className: 'rpc-event-msg',
            title: message,
          }, message),
          group.count > 1
            ? h('span', {
                key: 'repeat',
                className: 'rpc-chip',
                title: repeatHint,
                'aria-label': repeatHint,
              }, bind(t, 'eventRepeat', { count: formatNumber(group.count) }))
            : null)
        })
        var eventsFooter = groupedEvents.length > 6
          ? h('button', {
              key: 'more',
              type: 'button',
              className: 'rpc-btn rpc-btn-sm',
              'aria-expanded': eventsExpanded === true,
              onClick: function () { setEventsExpanded(!eventsExpanded) },
            }, rpcIcon(eventsExpanded === true ? 'chevron' : 'chevron', 13), eventsExpanded === true
              ? bind(t, 'eventLess')
              : bind(t, 'eventMore', { count: groupedEvents.length }))
          : null
        sections.push(
          h('div', { key: 'events', style: S.section },
            h('div', { key: 'h', style: S.sectionHead },
              h('span', { style: S.sectionTitle }, rpcIcon('pulse', 14), bind(t, 'eventTitle')),
              h('span', { style: S.sectionCount }, String(allEvents.length)),
              h('span', { style: S.grow }),
              allEvents.length === 0
                ? null
                : h('button', {
                    type: 'button',
                    className: 'rpc-btn rpc-btn-sm',
                    disabled: isBusy('events'),
                    onClick: clearEvents,
                  }, rpcIcon('trash', 13), bind(t, 'eventClear'))),
            h('p', { key: 'hint', className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'eventHint')),
            // count 是历史总数、items 是宿主真实保留的条数：两者不同时明确告诉用户，
            // 避免「标题写 63、列表只有 50」看起来像丢事件。
            isFiniteNumber(eventDoc.count) && eventDoc.count > allEvents.length
              ? h('p', { key: 'retained', className: 'rpc-tiny', style: S.hintTiny }, bind(t, 'eventRetained', { count: allEvents.length }))
              : null,
            h('div', { key: 'filters', className: 'rpc-filters', style: Object.assign({}, S.row, { flexWrap: 'wrap' }) }, eventFilters.map(eventFilterButton)),
            allEvents.length === 0
              ? h('div', { key: 'empty', className: 'rpc-empty' },
                  h('span', { className: 'rpc-empty-icon' }, rpcIcon('pulse', 18)),
                  h('span', {}, bind(t, 'eventEmpty')))
              : filteredEvents.length === 0
                ? h('div', { key: 'nomatch', className: 'rpc-empty' },
                    h('span', { className: 'rpc-empty-icon' }, rpcIcon('search', 18)),
                    h('span', {}, bind(t, 'eventNoMatch')))
                : h('ul', { key: 'list', className: 'rpc-event-list' }, eventRows),
            eventsFooter),
        )
      }

      // ── 诊断 ────────────────────────────────────────────────────
      sections.push(
        h('div', { key: 'diag', style: S.section },
          h('div', { key: 'h', style: S.sectionHead },
            h('span', { style: S.sectionTitle }, rpcIcon('pulse', 14), bind(t, 'diagnostics')),
            h('span', { style: S.grow }),
            h('button', { type: 'button', className: 'rpc-btn rpc-btn-sm', 'aria-expanded': showDiag, 'aria-controls': showDiag ? 'dsh-reverse-proxy-diagnostics' : undefined, onClick: function () { setShowDiag(!showDiag) } },
              showDiag ? bind(t, 'hide') : bind(t, 'show')),
            h('button', {
              type: 'button',
              className: 'rpc-btn rpc-btn-sm',
              style: copyFailed ? { color: 'var(--rpc-danger)' } : undefined,
              title: copyFailed ? bind(t, 'copyFallbackHint') : undefined,
              onClick: copyDiagnostics,
            }, rpcIcon('copy', 13),
              copied ? bind(t, 'copied') : copyFailed ? bind(t, 'copyFailed') : bind(t, 'copyDiagnostics'))),
          copyFallback !== ''
            ? h('div', { key: 'copy-fallback', role: 'status', style: S.field },
                h('span', { className: 'rpc-inline-note', style: S.hintTiny }, bind(t, 'copyFallbackHint')),
                h('textarea', {
                  className: 'rpc-pre',
                  style: Object.assign({}, S.pre, { width: '100%', boxSizing: 'border-box', minHeight: 72, resize: 'vertical' }),
                  readOnly: true,
                  value: copyFallback,
                  onFocus: function (event) {
                    if (event !== undefined && event.target !== undefined && typeof event.target.select === 'function') event.target.select()
                  },
                }))
            : null,
          showDiag ? h('pre', { key: 'pre', id: 'dsh-reverse-proxy-diagnostics', className: 'rpc-pre', style: S.pre }, diagnosticsJson) : null),
      )

      // React 会把 `key` 从 props 里摘掉，挂到 element.key 上；测试/预览的
      // 迷你 createElement 则保留在 props.key。两处都读，分区才不会在真实
      // React 里全部落到默认页。
      var sectionKeyOf = function (node) {
        if (node === null || node === undefined) return undefined
        if (node.key !== undefined && node.key !== null) return node.key
        return node.props !== undefined ? node.props.key : undefined
      }

      // ── 把各分区装进详情页 ──────────────────────────────────────
      var pages = { overview: [], accounts: [], usage: [], models: [], settings: [], activity: [] }
      sections.forEach(function (node) {
        var key = sectionKeyOf(node)
        var pageId = RPC_SECTION_PAGE[key] || 'overview'
        if (pages[pageId] === undefined) return
        pages[pageId].push(node)
      })
      // 概览：额度在左、状态在右，符合「还剩多少 → 能不能用」的阅读顺序。
      var overviewRank = { credits: 0, status: 1, 'overview-accounts': 2, 'availability-test': 3 }
      pages.overview.sort(function (a, b) {
        return (overviewRank[sectionKeyOf(a)] ?? 9) - (overviewRank[sectionKeyOf(b)] ?? 9)
      })

      var pageCountFor = function (pageId) {
        if (pageId === 'accounts') return accountRows.length
        if (pageId === 'models') return modelTotal
        if (pageId === 'activity' && status.events !== null && typeof status.events === 'object' && Array.isArray(status.events.items)) return status.events.items.length
        return undefined
      }

      var pageNav = h('div', {
        className: 'rpc-pagenav',
        role: 'navigation',
        'aria-label': bind(t, 'navSections'),
      }, RPC_PAGES.map(function (page) {
        var selected = activePage === page.id
        var count = pageCountFor(page.id)
        return h('button', {
          key: page.id,
          type: 'button',
          className: 'rpc-pagetab',
          'aria-current': selected ? 'page' : undefined,
          onClick: function () { setActivePage(page.id) },
        },
        rpcIcon(page.icon, 14),
        bind(t, page.label),
        count === undefined ? null : h('span', { className: 'rpc-pagetab-count' }, formatNumber(count)))
      }))

      var pagePanels = RPC_PAGES.map(function (page) {
        var content = pages[page.id]
        return h('div', {
          key: page.id,
          id: 'dsh-rpc-page-' + page.id,
          role: 'tabpanel',
          'aria-labelledby': 'dsh-rpc-tab-' + active.provider,
          className: 'rpc-page',
          style: { display: activePage === page.id ? 'flex' : 'none' },
        }, page.id === 'overview'
          ? (function () {
              var grid = content.filter(function (node) { return sectionKeyOf(node) !== 'availability-test' })
              var below = content.filter(function (node) { return sectionKeyOf(node) === 'availability-test' })
              return [
                h('div', { className: 'rpc-overview' },
                  h('div', { className: 'rpc-overview-main' }, grid.filter(function (node) { return sectionKeyOf(node) === 'credits' })),
                  h('div', { className: 'rpc-overview-side' }, grid.filter(function (node) { return sectionKeyOf(node) !== 'credits' }))),
                ...below,
              ]
            })()
          : content)
      })

      var providerAccent = PROVIDER_ACCENT[active.provider] || '#2154ce'

      return h('div', {
        className: 'dsh-rpc',
        style: { '--rpc-accent': providerAccent },
      },
      hero,
      providerRail,
      banners,
      h('div', {
        id: 'dsh-rpc-detail',
        className: 'rpc-detail',
      },
        detailHeader,
        pageNav,
        ...pagePanels),
      h('div', { className: 'rpc-footer' },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
          rpcIcon('refresh', 11), bind(t, 'autoRefreshHint')),
        h('span', { style: { flex: 1 } }),
        h('span', {}, 'v' + (status.plugin && status.plugin.version ? status.plugin.version : '?')),
        h('span', { 'aria-hidden': 'true' }, '·'),
        h('span', {}, bind(t, 'footerHint'))))
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
        var applyStatus = function (document) {
          if (document === null || typeof document !== 'object' || Array.isArray(document)) return
          setStatus(document)
        }
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
        // 轻量 GET 与「刷新积分」的 POST 是两个独立请求：POST 之后才回来的旧 GET
        // 会把刚刷新的额度盖回旧快照。与卡片同款：每次写入递增代数，晚到的响应
        // 发现代数变了就丢弃。busyRef 管的是「同一 tick 里连点两次」的情况 ——
        // 只靠 state 的话两次点击都读到 busy === false，会发两个 POST。
        var statusEpoch = useRef(0)
        var busyRef = useRef(false)
        // 失败提示的 5s 自动清除用序号防竞态：成功刷新要立刻清掉失败态，
        // 旧定时器也不能清掉之后新产生的失败。
        var failedSeq = useRef(0)
        /** 那个 5s 定时器的句柄：卸载时要清掉，否则会在已卸载组件上 setState。 */
        var failedTimer = useRef(undefined)

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
            var epoch = statusEpoch.current
            fetchStatus(true)
              .then(function (document) {
                loading = false
                if (disposed) return
                lastAt = Date.now()
                // 请求期间发生过手动刷新：这份是旧快照，丢掉，别把新额度盖回去。
                if (epoch === statusEpoch.current) applyStatus(document)
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
            // 刷新失败那条 5 秒提示的定时器：卸载时必须清掉，否则侧栏反复
            // 挂载/卸载会累积一堆到点后 setState 的定时器。
            if (failedTimer.current !== undefined) {
              clearTimeout(failedTimer.current)
              failedTimer.current = undefined
            }
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
          if (status === undefined || busyRef.current === true) return
          busyRef.current = true
          // 记下发起时的代数：刷新结果与「刷新前就发出、刷新后才回来」的旧 GET
          // 都靠它排序 —— 只有代数没变（中间没有别的写入）的结果才落地。
          statusEpoch.current += 1
          var epoch = statusEpoch.current
          setBusy(true)
          setFailed(false)
          postJson(ACTION_PATH, { action: 'credits' }, status.key)
            .then(function (document) {
              if (epoch === statusEpoch.current) applyStatus(document)
              busyRef.current = false
              setBusy(false)
              // 失败后 5 秒内又刷新成功：必须立刻清掉失败提示，否则旧定时器
              // 未到点前界面仍挂着「刷新失败」，看起来像失败但其实成功。
              failedSeq.current += 1
              setFailed(false)
            })
            .catch(function (failure) {
              busyRef.current = false
              setBusy(false)
              // 刷新失败不能只靠 1.6 秒描边变色：面板底部给一条 5 秒的
              // role=status 文案（原因放 title），色盲/读屏用户也能感知。
              var seq = failedSeq.current + 1
              failedSeq.current = seq
              setFailed(String(failure && failure.message ? failure.message : failure))
              // 这个 5 秒提示定时器必须记句柄并在卸载时清掉：侧栏会随会话切换
              // 反复挂载/卸载，旧实现每次都留一个到点后 setState 的定时器。
              if (failedTimer.current !== undefined) clearTimeout(failedTimer.current)
              failedTimer.current = setTimeout(function () {
                failedTimer.current = undefined
                if (failedSeq.current === seq) setFailed(false)
              }, 5000)
            })
        }

        var providers = safeArray(status && status.providers)
        var sidebarAlertSettings = (status && status.settings && status.settings.alerts) || {}
        var sidebarAlertRatio = isFiniteNumber(sidebarAlertSettings.lowRatio) && sidebarAlertSettings.lowRatio > 0 && sidebarAlertSettings.lowRatio < 1
          ? sidebarAlertSettings.lowRatio
          : LOW_CREDITS_RATIO
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
          if (providers.length === 0) {
            // 状态还没回来（冷启动 / 宿主迟迟不就绪）时也要有东西可看：
            // 旧实现直接 return null，侧栏底部整块空白，和卡片的「读取中…」
            // 行为不一致，用户分不清「插件没装」还是「还没加载完」。
            return h(
              'div',
              { style: { display: 'flex', width: '100%', minWidth: 0, boxSizing: 'border-box', margin: '0 0 4px' } },
              h(
                'button',
                {
                  type: 'button',
                  disabled: true,
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
                    cursor: 'default',
                    borderRadius: 999,
                    border: '0.5px solid var(--dsw-alias-border-l2)',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary)',
                    fontSize: 12,
                  },
                },
                h('span', { role: 'status' }, bind(t, 'summary') + ' —'),
                h('span', {}, bind(t, 'loading')),
              ),
            )
          }
          // 所有 provider 都被用户关闭时，说「未读取」会误导（数字不是读不到，
          // 是根本没有启用的来源）。单独给一句「provider 已全部关闭」。
          var allDisabled = providers.every(function (item) { return item.enabled === false })
          if (allDisabled) {
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
                h('span', { title: bind(t, 'providersAllDisabledHint') }, bind(t, 'providersAllDisabled')),
              ),
            )
          }
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
          if (isFiniteNumber(row.credits.fetchedAt) && row.credits.fetchedAt > latestFetched) latestFetched = row.credits.fetchedAt
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
            var exhausted = snapshot.state === 'ok' && (snapshot.exceeded === true || (isFiniteNumber(snapshot.remain) && snapshot.remain <= 0))
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
            if (activeAccount !== undefined && problem === undefined) meta.push(h('span', { key: 'acc', style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', maxWidth: 108, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bind(t, 'creditsCurrent', { label: accountNameOf(activeAccount, t) })))
            if (isFiniteNumber(snapshot.resetAtMs) && snapshot.resetAtMs > 0) meta.push(h('span', { key: 'reset', style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, bind(t, 'creditsResetShort', { date: formatShortDate(snapshot.resetAtMs) })))
            if (sidebarShowUsage && todayUsage !== undefined && isFiniteNumber(todayUsage.requests) && todayUsage.requests > 0) meta.push(h('span', { key: 'today', style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, bind(t, 'creditsToday', { count: formatNumber(todayUsage.requests), tokens: formatNumber(todayUsage.totalTokens || 0) })))
            if (snapshot.stale === true) meta.push(h('span', { key: 'cached', style: microChip() }, bind(t, 'creditsCached')))
            var trend = snapshot.trend
            var hasTrend = trend !== null && typeof trend === 'object' && trend.sampleCount > 0
            var trendLine = hasTrend
              ? h('div', { key: 'trend', style: { display: 'flex', alignItems: 'center', gap: 7, marginTop: 5, minWidth: 0 } },
                  h('span', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, bind(t, 'trendToday', { value: formatNumber(trend.spentToday || 0) })),
                  isFiniteNumber(trend.etaMs) && trend.etaMs > 0
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

