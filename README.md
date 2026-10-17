# dsh-reverse-proxy-connect

把 **WorkBuddy**（国内版 / 国际版）与 **Qoder**（全球版 / 国内版）账号里的模型接进
**DeepSeek Harness 0.2.1-rc.1**。一个插件、四个 provider、一张设置卡片。

| provider id | 显示名 | 凭证来源 | 实测模型数 | 积分 |
|---|---|---|---|---|
| `workbuddy` | WorkBuddy | 读取本机 WorkBuddy 桌面端登录 | 18 | 675 / 1200 |
| `workbuddy-ai` | WorkBuddy AI | 读取本机 WorkBuddy AI 桌面端登录 | 27（本账号可用 14） | 99 / 100 |
| `qoder` | Qoder | 个人访问令牌（PAT，qoder.com.cn） | 视账号 | — |
| `qoder-global` | Qoder Global | 个人访问令牌（PAT，qoder.com） | 视账号 | 0（Free） |

> **0.5.2 重点**：展开箭头从 9px 的 `▾` 字符换成 14px 内联 SVG 折线，侧栏里一眼可见。
>
> **0.5.1 重点**：侧栏胶囊补上悬停反馈（底色 + 描边 + 阴影）与展开箭头，
> 让「能点」这件事一眼可见。
>
> **0.5.0 重点**：设置卡片整体重排 —— 4px 栅格、四档字号、三种按钮、
> 状态/积分/连接设置/模型四个分组；标签页改成带状态圆点的胶囊分段；
> 积分数字放大成视觉锚点并配进度条。
>
> **0.4.8 重点**：胶囊铺满侧栏底部宽度（收起与展开一致），三个账号两端对齐铺开。
>
> **0.4.7 重点**：积分改成**侧栏内嵌面板** —— 点胶囊在侧栏底部展开，宽度天然等于侧栏，
> 结构上不可能溢出，也不再遮挡会话列表。悬浮气泡整套移除。
>
> **0.4.5 重点**：气泡可以点进去刷新了（延迟关闭 + 真正的「刷新额度」按钮）；
> 修掉胶囊在侧栏里横向溢出（缺 `box-sizing: border-box`）。
>
> **0.4.4 重点**：积分冷启动不再空十秒 —— 额度快照落盘并在启动时恢复，
> 目录与额度并行抓取，小卡前 10 秒快速重试。旧数字会弱化显示并标注「正在刷新」。
>
> **0.4.3 重点**：字体整体调大（胶囊 13px、气泡 13px）；设置卡片显示插件版本号；
> 余额低于 15% 就提前转警示色；刷新失败不再静默。
>
> **0.4.0 重点**：侧栏常驻积分小卡（`WB 675 · QDG 0 · WBAI 99`），一眼看到各账号余额；
> 模型一多可以搜索；上游全挂时用内置兜底清单，模型组不再凭空消失。
>
> **0.3.0 重点**：每个账号的积分/额度现在直接显示在卡片上（含套餐包明细与到期时间），
> 模型名后也会带上倍率（`GLM-5.3 · x0.79`）。
>
> **0.2.0 重点**：国内版模型从 10 个修正为 18 个（此前取错了花名册）；新增
> 账号能力探测，把「产品里有但你的账号用不了」的模型自动隐藏。详见下方
> 「模型清单为什么会变」。

---

## 积分是怎么算的

三家上游各有一套账目，口径不同，混着算就会给出误导性的数字。

### WorkBuddy：套餐包列表

`POST {billing}/v2/billing/meter/get-user-resource` 返回一串套餐包，
每个包同时有「周期额度」与「一次性余额」两组字段：

- **周期优先**：`CycleCapacitySize > 0` 时只能看 `CycleCapacityRemain`。
  否则会把已过期周期里的一次性余额算成可用。
- **已耗尽的包不进分母**：国内版账上有 5000 和 1000 两个早已耗尽的包，
  算进去会显示成「675 / 7700」，看着像额度快见底了；实际可用的是 675 / 1200。
- 企业账号走另一条端点（`get-enterprise-user-usage`），只有一个总量，
  `limitNum === -1` 表示不限量。

### Qoder：单一额度 + 套餐

`GET /api/v2/quota/usage` 给 `userQuota{total,used,remaining}`，
`/api/v2/user/plan` 给套餐名（Free / Pro…），`/api/v3/user/status` 给重置时间。
免费套餐的 `total` 就是 0，此时显示 `0 credits` 并标注「额度已用尽」，
而不是笼统地显示一个空白。

### 三条设计原则

1. **「读不到」≠「0」**。额度读取失败时保留上一次成功值并标出错误，
   否则用户会以为额度被清零。
2. **额度与目录分开取**。目录失败不影响额度，反之亦然。
3. **缓存 2 分钟**。卡片每 20 秒轮询一次状态，不设缓存会每 20 秒打一次上游；
   「刷新积分」按钮强制绕过缓存。

### 模型倍率

DSH 的模型选择器只渲染 `name`，所以倍率只有拼进名字才看得见：

```
GLM-5.3 · x0.79        Hy3 · 免费        Kimi-K3 · x1.62
```

倍率会归一化（`x0.79 credits` / `0.79` 都变成 `x0.79`，`0` 显示为「免费」），
认不出的保持原名 —— 错误的倍率比没有倍率更误导。卡片里可关掉。

---

## 为什么是「反代」而不是「直连」

两家的上游都不是公开 API：

- **WorkBuddy** 的 `POST /v2/chat/completions` 就是 OpenAI 形状，但它要求浏览器身份头
  （`X-IDE-*`、`X-Conversation-*` 三件套）、不接受 `role:"developer"`、不接受非流式、
  不接受 `reasoning_effort:"off"`。插件把这些修好，再把 SSE 原样翻译成 DSH 的 chunk。
- **Qoder** 完全没有 OpenAI 兼容端点：请求要重新封装成它自己的 envelope，body 还要经
  WAF 编码（base64 → 三分重排 → 自定义字母表），签名用 COSY（AES-128-CBC + RSA + MD5），
  响应是「外层 SSE 包着内层 SSE」两层结构。

所以插件在进程内做翻译，把两家的流归一化成同一组事件，再交给 DSH。

## 和上游两个社区插件的区别

`dsh-workbuddy-connect` 和 `dsh-qoder-connect` 是各做一个插件、各起一个
`127.0.0.1` 回环 HTTP 服务、各自 `import "@earendil-works/pi-ai"`。本插件：

- **不导入 pi-ai**。pi-ai 是 DSH 的传递依赖（在 `app.asar` 里），profile 的
  `node_modules` 顶层没有它；插件自己声明它就会装出第二份副本 —— 上游
  workbuddy-connect 现在正是把 pi-ai **0.87.1** 钉成普通依赖，而宿主跑的是
  **1.1.0**，跨大版本的词表错配。本插件直接实现 DSH 公开的 `LlmAdapter`。
- **不起回环 HTTP 服务**。上游请求直接从宿主进程发出，少一层本地 socket、少一个
  需要守的端口。
- **四个 provider 共享一份运行时**：一个适配器实例、一份目录缓存、一张卡片。
- 只依赖 `node:` 内建模块，没有任何 npm 依赖。

## 安装

```powershell
# 预览（默认不写盘）
node scripts/install.mjs

# 安装
node scripts/install.mjs --apply

# 卸载
node scripts/install.mjs --apply --uninstall
```

脚本会复制插件到 profile 的 `node_modules`，并把包名写进 profile `package.json` 的
`dependencies` 与 `dsh.profile.bundles`；落盘前先备份到
`<DSH_HOME>/dsh-reverse-proxy-connect-backup-<时间戳>/`，并附一份 `restore.ps1`。

装完**完全退出并重启 DeepSeek Harness**（宿主半边需要重新加载），再刷新页面。

## 模型清单为什么会变

### 0.2.0：国内版从 10 个修正到 18 个

`/v3/config` 的返回**由 User-Agent 决定**，实测三种身份拿到三份不同的花名册：

| 请求身份 | `agents[]` | 结果 |
|---|---|---|
| 纯 App：`WorkBuddy/5.5.6` | 只有 `craft` / `ask` / `plan`，**没有 `cli`** | 早先误把 `agents[0]` 当花名册 → 10 个假清单 |
| 纯 CLI：`CLI/2.63.2 CodeBuddy/2.63.2` | `cli` 有 18 个 | 18 个，但**缺 `auto`** |
| 桌面端复合身份：`WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.63.2` | `cli` 有 18 个 | **18 个 + `auto` = 19**，`models[]` 也最全（60 条） |

0.2.0 改用桌面端自己的复合身份（目录与聊天统一），并且**没有 `cli` 花名册时直接报错**
而不是退到 `agents[0]` —— 后者会悄悄给出假目录，是最难发现的那类错。

同时修了两个会让模型「看得见但用不了」的问题：

- **`auto` 是虚拟 id**：在花名册里但不在 `models[]` 里，此前因为查不到元数据被丢弃。
  它确实能聊天，现在按保守默认值（128K 上下文 / 32K 输出）保留。
- **隐含思考档位**：`glm-5.1` 这类模型的 `reasoning` 只有 `{effort:"medium"}`、
  没有 `supportedEfforts`，此时**省略** `reasoning_effort` 会被判「不支持的思考强度」
  并 400，显式发 `medium` 反而正常。现在目录解析会把隐含档位收敛成唯一可选档位，
  聊天时自动补上。

### 0.2.0：账号能力探测

花名册是**产品级**的（这个客户端能提供什么），不是**账号级**的（你买了什么）。
实测国际版免费账号能列出 27 个模型，其中 **13 个**（GPT / Grok / Gemini 全家）
一聊就回「当前账号类型暂不支持该模型」。

0.2.0 在后台逐个探测（每个模型一次 `max_tokens: 1` 的极短请求，并发 4 路，
27 个模型约 10 秒），把账号用不了的模型记进 `unavailableModels` 并从选择器隐藏。
卡片里它们收在「N 个模型账号不支持」折叠区，**勾选即可强制显示**（写 `forcedModels`）。

判据刻意很严 —— **只认 400 + 明确的档位文案**。原因是误判会藏起能用的模型，
比多显示几个不能用的糟得多：

- 单模型的每日频率限制（实测 429「使用量已超出频率限制，将在 … 重置」）→ 视为可用。
  这是配额问题且有重置时间，不是能力问题。
- 401 / 403 / 5xx / 网络超时 → 视为可用。

实测收敛结果：国内版 18 个 **0 误判**；国际版 27 个准确挑出 13 个。
探测每 6 小时最多一次（省额度），卡片上有「检测账号可用模型」可手动重跑。

## 使用

### WorkBuddy 两版

插件读取桌面端自己的登录文件：

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info
```

5.6 之后这两个文件里的 token 是 `{$wbEncrypted:1, envelope}` 包着的 AES-256-GCM 信封。
解密密钥只能从应用自身拿：用它自己的 Electron 二进制以 `ELECTRON_RUN_AS_NODE=1` 跑
`process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()`，得到
`{version:1, atRestSecretKey}`，再 `sha256(那个 base64 字符串)`。

所以插件会**短暂启动一次对应 App 的可执行文件**（无窗口、只跑一句、约 1 秒）。
这一步只在你登录信息是加密格式时发生；老版本写明文 token 的完全不会触发子进程。

App 的位置按这个顺序找：设置里手填的路径 → `WORKBUDDY_ELECTRON_BIN` /
`WORKBUDDY_AI_ELECTRON_BIN` → 默认安装路径 → Windows「添加/删除程序」注册表。
**注册表里会同时看 `DisplayName`**，所以国内版与国际版装在同一台机器上也能区分
（两者 exe 布局完全一样，只有产品名不同）。

绑定关系是严格的：拿国内版的登录去配 `workbuddy-ai` 会被拒绝并说明原因。

### Qoder 两版

在设置卡片里粘贴 PAT：

- 国内版：<https://qoder.cn/account/integrations>
- 国际版：<https://qoder.com/account/integrations>

保存时会先真的换一次 job token 与读一次用户信息来验证，通过了才落盘。
也支持环境变量 `QODER_CN_PERSONAL_ACCESS_TOKEN` / `QODER_PERSONAL_ACCESS_TOKEN`。

Qoder 免费额度在高峰期会排队（上游把排队回成 403 + `isQueued` + `retryAfterSeconds`）。
插件会**在本地按上游建议等一次再重开**，只要还没吐过一个字节，重试就是无损的；
真正的限流（已吐出内容之后失败）才交给 DSH 的重试执行器。

### 设置卡片与侧栏小卡

`设置 → 插件设置 → 反代连接器`（与另外几个 connect 插件共用同一个「插件设置」区块），
`侧栏 → 插件 → 反代连接器` 详情页里也有同一张卡片。

卡片能做：

- 顶部一行**全账号总览**：所有已登录账号的剩余额度并排；
- 看四个 provider 的登录状态、目录来源（`已从上游拉取` / `上游不可达，显示上次结果` /
  `内置兜底列表`）；
- 积分行 + 套餐名 + 到期时间 + 可展开的套餐包明细；
- 逐 provider 开关（关掉的 provider 直接不出现在模型选择器里）；
- 逐模型开关，以及「全部开启 / 全部关闭」；
- 模型数超过 6 时出现**搜索框**，按名字或 id 过滤；
- 「检测账号可用模型」：重跑能力探测，把账号用不了的模型收起来；
- 「N 个模型账号不支持」折叠区：勾选可强制显示某个用不了的模型；
- 填 Qoder PAT；
- 填 WorkBuddy 的 App 路径与登录文件路径（留空自动找）；
- 「刷新」立刻重拉目录与额度；「诊断」打出完整状态 JSON，可一键复制。

**侧栏底部**还有一枚常驻小卡，不用打开设置就能看到余额：

```
● WB 675   ● QDG 0   ● WBAI 99
```

每个账号自带一枚强调色圆点，数字加粗；余额为 0 或超额时变琥珀色。
胶囊铺满侧栏底部整条宽度，三个账号两端对齐铺开。

**点这枚胶囊**会在它上方展开一块内嵌面板（不是悬浮气泡）：逐账号列出
「剩余 / 总量」、额度进度条、套餐名与到期时间，底部还有「刷新积分」按钮。
面板宽度就是侧栏宽度，所以不会越界，也不会盖住会话列表 —— 它把列表往上挤。
点面板外面或按 `Esc` 收起；侧栏收成窄轨道时点一下只刷新、不展开。

写操作走 `POST`，必须带 `X-RPC-Key`（进程内一次性密钥，卡片从 `GET /status` 拿到）；
读操作只接受回环 `Host`（含 DNS-rebinding 防护）。

## CLI

```powershell
node lib/bin.js status                 # 四个 provider 的登录、模型数与积分
node lib/bin.js models [provider]      # 列模型
node lib/bin.js credits [provider]     # 列积分与套餐包明细
node lib/bin.js ask <provider> <model> "提示词"   # 真发一次，打印流
```

`ask` 是最快的排障手段：它跳过 GUI，直接走运行时，能看到正文、工具调用与 usage。
思考内容默认折叠成字数（`ASK_SHOW_REASONING=1` 可展开）。

`credits` 会把每个套餐包列出来，方便核对「为什么剩余是这个数」：

```
[workbuddy] 675 / 1200 credits  最近到期 2026/11/3 15:33:01
    - CodeBuddy个人版国内运营裂变包  100 / 100  至 2026/11/7
    - CodeBuddy个人版国内运营裂变包  75 / 100  至 2026/11/3
    - CodeBuddy个人体验版  0 / 500  至 2026/10/31
    - CodeBuddy个人版国内运营裂变包  0 / 100  [已耗尽]  至 2026/10/18
```

## 数据与隐私

全部自有文件在 `<profile>/.dsh-reverse-proxy-connect/`：

```
settings.json          # PAT、模型开关、探测结果、路径覆盖（0600）
.qoder-machine-id      # Qoder 设备标识种子（优先复用 ~/.qoder/.auth/machine_id）
```

插件不写 `~/.qoder`、不改桌面 App 的任何文件、不上报任何东西。
凭证只在内存里用于签名，不落盘（Qoder PAT 除外，它是用户自己填的配置）。

## 兼容性说明（DSH 0.2.1-rc.1）

对照宿主实际产物核对过的点：

| 项 | 状态 |
|---|---|
| `ctx.llm.registerAdapter([...ids], adapter)` | 签名未变，四个路由一次注册 |
| `LlmAdapter` 的 `providerInfo` / `listModels` / `resolveModel` / `prepareCall` / `stream` | 全部实现 |
| 终态 `finish` chunk（`stop` / `tool-calls` / `max-tokens` / `error` / `aborted`） | 每条流恰好一个 |
| `usage` 先于 `finish` | 遵守 |
| `ctx.webServer.register({kind:'exact', path, handler})` | 未变；重复路径会抛 |
| `ctx.effect` 立即执行并把返回值当 disposer | 遵守 |
| `settings.installSection` / `settings.update` | **已从 0.2.1 移除**，所以本插件不用它，自己管 `settings.json` |

刻意**没有**做的事：

- 不调 `registerConfigurableProviders`：那会把 provider 也塞进「模型设置」页的目录里，
  与卡片的单点真相冲突。
- 不实现 `imageRequestPricing`：订阅制没有 per-image 计价，DSH 会退回中性估算。
- 不支持 `GenerateOptions.stop`：两个上游都不保证 stop 序列语义，明确拒绝而不是悄悄忽略。

## 开发

```powershell
node --test tests/*.test.mjs      # 15 条纯逻辑用例（签名/编码/翻译/解析/设置）
```

想验证真实链路：

```powershell
$env:DSH_PROFILE_DIR="C:\Users\<you>\.dsh\profiles\desktop"
node lib/bin.js status
node lib/bin.js ask workbuddy auto "用一句话介绍你自己"
```

## 免责声明

WorkBuddy 与 Qoder 的接口来自上游客户端，随时可能改动、限流或封禁。
本插件供个人学习研究，用你自己的账号、走你自己的额度；请遵守两家的服务条款。
WorkBuddy、Qoder、DeepSeek 等名称与商标归各自权利人所有，此处仅作兼容性说明。
