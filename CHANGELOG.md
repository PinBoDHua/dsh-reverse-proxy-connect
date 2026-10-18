# 更新记录

## 1.8.1 — 2026-10-18

这一版修的是 `node lib/bin.js test` 里一条**看起来像「账号坏了」**的输出：

```text
[qoder-global] 默认令牌  ✗ ABORTED  45013ms  aborted
```

账号其实是好的。同一条命令重跑，有时 36 秒成功。三层原因叠在一起，每一层
都会把下一层的解释吃掉。

### 原因一：测试死线与排队预算都是 45 秒

`testAccount()` 与 `#probeOne()` 各自 `setTimeout(() => controller.abort(), 45_000)`，
而 `QODER_OPEN_QUEUE_BUDGET_MS` 也是 45 秒。两个计时器同时到期，先跑的是
看门狗 —— 于是「免费模型正在排队」那句解释永远轮不到。

现在死线抽成 `TEST_DEADLINE_MS = 60_000`，比 `QODER_OPEN_QUEUE_BUDGET_MS`
（45 秒）多 15 秒余量：排队预算先到，给出明确结论；死线只在「上游连响应头
都不给」时兜底。

### 原因二：`abort()` 不带 reason，超时与「用户取消」同形

`AbortController.abort()` 不带参数时 `signal.reason` 是 `AbortError`；用户按
Esc 取消也是同一个形状。于是「等了 60 秒」被上报成 `ABORTED` + `aborted`，
既不像超时，也不说明做了什么。

新增 `DeadlineError`（继承 `IdleTimeoutError`，带 `kind/code = 'timeout'`）：

- 内部看门狗用 `abort(new DeadlineError(...))`；
- `#openUpstream` 的 catch 先看 `deadline.signal.reason`，再认调用方 signal
  的 reason（宿主的取消不带 reason，走 `CancelledError`），最后才兜底取消。

### 原因三：`sleep()` 把 reason 抹掉了

看门狗 abort 之后，`await sleep(waitMs, signal)` 抛的是 `CancelledError` ——
上层只看到「取消」，60 秒的 `DeadlineError` 反而被吞掉。现在 `sleep()` 与
`abortReasonOf()` 一起，把 signal 自带的 reason 原样上抛。

### 原因四：首包排队预算被夹到了死线本身

`openQueueBudgetMs = min(userSetting, 45_000, OPEN_TIMEOUT − 已用 − 2)`。
最后那一项让预算永远等于 60 秒死线：用户把「Qoder 排队等待」调到 30 秒也不
生效，报错写的是「超过本地 **60** 秒上限」—— 而 60 秒是死线，不是排队预算。
现在只取 `min(userSetting, QODER_OPEN_QUEUE_BUDGET_MS)`。

### 顺带：排队预算现在也约束「等响应头」那一刻

`#openQoderQueued` 原来只在**两次重试之间**检查预算。一次挂住不返回的尝试会
让整轮等到外层死线。现在每次尝试都用
`AbortSignal.any([signal, budget.signal])` 包住，到点立刻结束并按排队报告。

### 实测

同一条命令，修复前稳定 `ABORTED 60002ms / aborted`；修复后：

```text
[qoder-global] 默认令牌  ✓ 正常  36262ms
[qoder-global] 默认令牌  ✗ RATE_LIMIT  60008ms  Qoder 免费模型正在排队
                                 （已等待 60 秒，超过本地 60 秒上限）。
                                 这不是令牌失效或模型下线；请稍后重试，避开高峰期。
```

`ABORTED` → `TIMEOUT`/`RATE_LIMIT`，且都带得出原因；排队结束时请求正常成功。

### 测试

- `node --test tests/*.test.mjs`：**210 条**（新增 3 条：死线只覆盖等响应头、
  `DeadlineError` 语义、`sleep()` 保留 reason）；
- `node tests/client-credits.mjs`：35 项，全部通过。

## 1.8.0 — 2026-10-18

这一版只做一件事：**把「读不到额度」和「额度是 0」彻底分开**。
起因是一次体检输出：`trae-global` 与未配 PAT 的 `qoder` 都被写成
「0 / 0 credits · 缓存」。那两个 0 是 `emptyCredits()` 的占位值，不是余额 ——
用户看到「0 分 + 缓存」，会以为这家额度用完了、只是显示的是上次的数据。

### 修复：`stale` 只在「手里真有一个数字」时出现

`creditsFor()` 原来的规则是「条目带 `error` 就标 `stale`」。但读失败的条目
可能压根没有成功过快照（`#refreshCreditsOnce` 会把失败折成
`emptyCredits()` + `error`），于是占位的 0 被伪装成「缓存的上次结果」。

现在只有 `entry.data.state === 'ok'` 才会标 `stale`：有旧数字 → 「上次结果」，
从没读到过 → 「未读取 / 读取失败」，不再冒充余额。

### 修复：四种状态在四个出口说同一句话

| 情况 | 卡片 / 侧栏 | CLI / 诊断 |
|---|---|---|
| 读到了 | `675 / 1,200 积分` | `675 / 1200 credits` |
| 有旧数字、这次失败 | 数字变淡 +「缓存数据」 | `… · 上次结果` |
| 没有额度端点 / 没配凭证 | `未读取` + 原因 | `未读取（原因）` |
| 有端点但这次失败 | `读取失败` + 原因 | `读取失败（原因）` |

- 侧栏胶囊**只列真正有数字的 provider**：一个亮着 `0` 的格子会被读成「这家额度
  用完了」，而真实情况常常是「这次没读到」。全部读不到时缩成一行淡入口，
  文案按「全部读失败 → 读取失败」「其余 → 未读取」区分。
- 卡片的 `state:'error'` 以前也走「大号 0 积分」分支，现在改走错误文案；原因字段
  `error` 与 `message` 都认（两者来自不同层）。
- 诊断与 CLI 以前把 `state:'none'` 渲染成 `0 / 0 credits`，现在带原因；
  `state:'error'` 的 provider 也不再打印一行「今日消耗 0 / 近 7 天 0」的噪音。

### 修复：耗尽预估不再摊成六位数分钟

`bin.js` 与 `diagnostics.js` 各自用 `Math.round(ms / 60000)` 拼时长，于是
「还能用 252 天」写成「预计可用 363476 分钟」。新增 `lib/format.js`：

- `formatCompactDuration(ms)` → `45m` / `3h 20m` / `252d`（与浏览器半边同规则）；
- `formatDurationZh(ms)` → `45 分钟` / `3 小时 20 分` / `252 天`。

### 性能：轻量状态的趋势点从 60 裁到 20

侧栏每 60 秒轮询一次 `/status?light=1`。这份响应 25.7KB 里有 11KB 是
6 个 provider 各 60 个趋势点，而侧栏画的是 100×24 的迷你折线 —— 后 20 个点
已经能画出同样的形状。`thinTrend()` 只裁 `light` 那一份，实测省 5.4KB（−21%）；
卡片与诊断拿到的仍是完整历史。

### 顺带：过期的「四家 / 两个上游」注释

1.7.0 把 provider 从四家加到六家，但 `adapter.js` / `index.js` / `bin.js` /
`cordis.patch.yml` / `accounts.js` 里还留着「四个 provider」「两个上游」。
这类注释不影响行为，却会让下一个改代码的人以为只有四家。一并改成「六家 /
三家上游」。客户端总览区的注释也同步（**没有**改文案键 `summaryProviders`
的行为，只把值从「四个 provider」改成「六个 provider」）。

### 测试

- `node --test tests/*.test.mjs`：**207 条**（新增 `tests/credits-state.test.mjs`
  5 条、诊断 2 条、`thinTrend` 纯函数若干断言）。其中一条把服务端的
  `formatCompactDuration()` 与浏览器半边逐字对比：两边是手抄的同一套规则，
  漂移了就会出现「卡片 3h 20m、侧栏 200m」那种都对不上号的显示。
- `node tests/client-credits.mjs`：**35 项**（新增「读失败显示『读取失败』」
  与「全部读失败时胶囊说明『读取失败』」）。

## 1.7.2 — 2026-10-18

1.7.1 把胶囊改成了两列，但**两列的对齐方式不一样**：左列 `flex-start`（靠左），
右列 `flex-end`（靠右）。左列从固定位置起排、右列贴着右边缘，两列起点对不上，
右列看起来像「浮在半空」—— 名字长短不同时（WBAI / TRAE）尤其明显。

### 修复：两列统一左对齐

现在每一格都是 `justify-content: flex-start`：圆点、名字、数字都从同一条竖线起排，
两行扫下来是齐的。没有选「居中」—— 数字是等宽数字（`tabular-nums`），
居中对齐会让不同位数的数字左右跳动，左对齐反而更稳。

### 修复：窄侧栏里数字被切成「197.」

固定两列时，侧栏拖到 180px 出头每列只剩 80px，`TRAE 197.1` 放不下。
先试过「让数字省略」，结果 `197.1` 变成 `19…` —— 那看起来像另一个数字，
比标签短一截误导得多。

最终改成 **`repeat(auto-fit, minmax(88px, 1fr))`**：宽度够就两列，
不够自动降成一列、每个 provider 独占一行完整显示。

88px 是实测出来的，不是估的 —— 用 headless 浏览器量了六种侧栏宽度：

| 侧栏宽度 | 栅格可用宽度 | 列数 |
|---|---|---|
| 180px | 138px | 1 |
| 196px | 154px | 1 |
| 210px | 168px | 1 |
| 236px | 194px | **2** |
| 260px | 218px | **2** |
| 300px | 258px | **2** |

阈值取 100px 时，236px 的常规侧栏会掉成一列（五家竖成五行更占地方）；
取 88px 才能保住两列。

另外数字改为 `flex: 0 0 auto` **永不压缩**：额度是这个胶囊唯一要传达的信息，
宁可牺牲标签（`TRAE` → `T…`）也不让数字变成一个看起来像真值的残缺值。

### 顺带：预览脚本自身的两个 bug

排查时先怀疑组件，最后发现是预览脚本画错了 —— 会让人对着错误截图改代码：

1. 生成 HTML 时没输出 SVG 的 `width`/`height`，`<svg>` 按默认 300×150 撑开，
   把栅格挤扁（表现是「屏幕上只剩两个数字」）；
2. 预览列是 flex 子项，没写 `min-width: 0`，被内容顶宽。

### 测试

- `node tests/client-credits.mjs`：**33 项**，「胶囊可折行」加严为：
  栅格必须 `auto-fit`、每格必须左对齐、**不得**写 `gridColumn`（会让
  `auto-fit` 失效）、数字必须 `flex: 0 0 auto` 且不能带省略号；
- `node --test tests/*.test.mjs`：**200 条**全部通过。

## 1.7.1 — 2026-10-18

1.7.0 把 provider 从四家加到六家，侧栏胶囊立刻装不下了：
`WB 775 | WBAI 57 | QDG 0 | TRAE 197` 在 236px 的侧栏里**最后一个数字被裁成半个**。

### 修复：胶囊改为两列折行，不再裁掉最后一个 provider

原来的胶囊是 `white-space: nowrap` + `overflow: hidden`：放不下的部分被**静默剪掉**。
截图里 TRAE 的 197 就只剩「197」的前一截 —— 一个残缺的数字比看不到更糟，
因为它看起来像是真的只有那么多。

现在数字区是两列栅格：

- 每个 provider 显式占一格（`grid-column` / `grid-row` 由位置算出），放不下就折到第二行；
- 两列都用 `minmax(0, 1fr)`：数字再长也只是自己省略，不会把整格顶出容器
  （用 `1fr auto` 时 `auto` 会按内容最大宽度撑开轨道，等于换了个方式溢出）；
- 分隔线只在「同一行的非首格」上画，折行后行首不会凭空多一条竖线；
- 圆角从 `999px` 改成 `14px`：999 在单行时是胶囊，折成两行后会变成半个椭圆，
  看起来像渲染坏了。

效果（236px 侧栏）：

```text
● WB 775      │  ● WBAI 57
● QDG 0       │  ● TRAE 197.1
● TRAEG 42
```

### 顺带：预览脚本自己的两个 bug

排查过程中先怀疑是组件的问题，最后发现是预览脚本把布局画错了。两个都不是插件代码，
但会让人对着错误的截图改代码，所以一并修掉：

1. 生成 HTML 时没输出 SVG 的 `width` / `height`，`<svg>` 于是按默认 300×150 撑开，
   把旁边的栅格挤扁 —— 表现是「屏幕上只剩两个数字」；
2. 预览列是 flex 子项，没写 `min-width: 0`，默认 `min-width: auto` 会被内容顶宽。

现在 `_pill-preview.html` 能真实反映布局，可以直接截图核对。

### 测试

- `node tests/client-credits.mjs`：**33 项**，新增「胶囊可折行」：
  断言数字区是栅格、不是 `nowrap` / `hidden`、每格列号与行号正确、行首无左侧分隔线；
- `node --test tests/*.test.mjs`：**200 条**全部通过。

## 1.7.0 — 2026-10-18

这一版是**新增两家 provider**：Trae（国内版）与 Trae Global（国际版）。
插件从「四家」变成「六家」，但仍然只有一张卡片、一套账号池、一份运行时。

### 新增：Trae / Trae Global

Trae 的接入难度不在协议，而在**三处「看起来能用、其实不能用」的坑**：

1. **凭证是加密的**。`%APPDATA%\Trae CN\User\globalStorage\storage.json` 里的
   `iCubeAuthInfo://icube.cloudide` 是 `tc` 信封：
   `[6B 头][32B 随机数][密文]`，密文解出来是 `[64B SHA-512 校验][明文 JSON]`，
   密钥由「随机数 + 固定盐」两次 SHA-512 派生。解错一个字节就得到乱码，
   而且看起来像「未登录」。插件按上游两种信封头（`tc` / `AES_PRIVATE`）
   各用一组盐，并且**校验不过就明确报错**，不拿乱码当账号名。
2. **`GenerateTempToken` 换出来的令牌不能聊天**。这条最容易踩：名字叫
   「换临时令牌」，看起来很合理，但实测登录文件里那枚令牌（claims 带
   `source: "refresh_token"`）直接发 `llm_utils_chat` 就是 200；而
   `GenerateTempToken` 换来的那枚（claims 带 `type: "user"`）会被 401
   `code 1001`。所以插件**不做**临时令牌交换 —— 那等于把能用的令牌换成不能用的。
3. **认证头是一组，不是一枚 token**。除了 `Authorization: Cloud-IDE-JWT …`，
   还要 `X-Cloudide-Token` / `X-Ide-Token` / `X-Uid` / `X-App-Id` /
   `X-Ide-Version(-Code)` / `X-Device-*` / `Request-Traffic-Type`。
   少任何一个都是 401「not able to authenticate you」—— 文案完全看不出缺了哪个。

接入后能做到：

- **模型目录**：`/api/ide/v1/get_detail_param`（`model_list` 对 SOLO 客户端直接
  400）。实测本账号 46 条配置里筛出 **20 个可聊模型**，带展示名、上下文窗口、
  多模态与倍率；内部 agent（`browser_use_subagent` 等）与 `custom_model_*`
  空槽位会被跳过，不会在选择器里出现一个点了就 400 的空行。
- **聊天**：`/api/agent/v3/llm_utils_chat` 的事件流（`event: output` +
  `{response, reasoning_content, tool_calls}`），正文 / 思考 / 工具调用 / usage
  都翻成与另外两家一致的事件。
- **工具调用**：Trae 的工具定义要求 `parameters` 是**字符串**（上游是 Go 的
  `FunctionDefinition.parameters string`），传对象会 400。插件自动序列化。
  工具分片按 `index` 累积，并且**首片等 `name` 到位再发**（与 1.4.0 给
  WorkBuddy 修的是同一类问题）。
- **图片输入**：多模态模型（Seed-2.1 系、Kimi、MiMo、Qwen 等）按 OpenAI 形状
  的 `{type:'image_url', image_url:{url}}` 发送，实测能正常识别。
- **额度**：`/trae/api/v2/pay/ide_user_ent_usage`，按「总额 − 已消耗」算，
  不用上游那个带四舍五入的 `consumption_ratio`。总额为 0 时按 Free 处理，
  不标「已用尽」。
- **签到**：`/trae/api/v2/ug/checkin_credits/{status,claim}`，每天 100 + 额外奖励。
- **续期**：`refreshToken` 走 `/cloudide/api/v3/trae/oauth/ExchangeToken`，
  要求 `ClientID` 与 `ClientSecret`（缺一个就是 400「无效参数」）。
  续期后的令牌写回账号，不会每个请求都重刷。

### 新增：`desktop-auth` 凭证类型

Trae 既不是 PAT（用户没有令牌可粘贴），也不是 WorkBuddy 那种「路径指向一个
登录文件」的形态。所以新增第三类 `desktop-auth`：

- 卡片里只显示**一个可选的 `storage.json` 路径**，没有 PAT 输入框、没有 App 路径；
- 留空自动查找 `%APPDATA%\Trae CN\User\globalStorage\storage.json`
  （国际版 `Trae\User\globalStorage\storage.json`）；
- 设置里存到 `settings.trae[provider].storageFile`（与 `settings.qoder` /
  `settings.workbuddy` 分开，不会互相覆盖）；
- 「浏览器登录」对 Trae 明确拒绝并说明原因：它的登录是客户端自己的 OAuth，
  带设备指纹与签名，插件不重放它 —— 用户只要在 Trae 里登录过就够了。

### 行为变更（升级前请确认）

1. **状态文档升到 v7**：新增 `providers[]` 里的 `trae` / `trae-global`，
   以及 `settings.trae`。按 v6 硬编码的第三方消费者需要同步；本插件客户端
   对缺失字段都有 fallback。
2. **`settings.json` 新增 `trae` 字段**，旧文件读入时自动补齐，不需要迁移。
3. **`credentialKind` 多了一个取值 `desktop-auth`**。按 `desktop` / `pat`
   二值判断的外部脚本需要把第三类也算进去。
4. **注册的 provider 从 4 个变成 6 个**：模型选择器里会多出 `Trae` 与
   `Trae Global` 两组（可以在卡片里单独关掉）。

### 测试

- `node --test tests/*.test.mjs`：**200 条**（新增 29 条 Trae 用例：`tc` 信封
  解密与校验、两种信封头、路径发现、续期请求形状、请求头三件套、工具
  `parameters` 序列化、目录过滤、流解析（正文/思考/工具/usage/终态）、
  name 晚到与 name 缺失兜底、`event: error` 分类、额度口径、签到码、状态映射）；
- `node tests/client-credits.mjs`：**32 项**（新增「Trae 用登录文件而不是 PAT，
  路径写进 `settings.trae`」）；
- 真实链路已实测：解密 → 目录 20 个模型 → 聊天 200 → 工具调用 `tool-calls`
  → 额度 `199.46 / 800` → 签到状态读取。

## 1.5.3 — 2026-10-18

两处遗留：手动签到与自动签到的并发（和 1.5.1 修探测时是同一类问题），
以及侧栏轮询里三分之一用不上的数据。

### 修复：手动「立即签到」撞上正在跑的自动签到时静默跳过

`runCheckin()` 开头是 `if (checkinRunning) return []`，而定时器每 30 秒就会尝试一次
自动签到。用户这时点「立即签到」，`action=checkin` 带 `force: true` 进来，仍然
**直接返回空数组**，然后照样刷新额度、返回 200 —— 界面看起来「点了、也刷新了」，
但一次签到都没有跑，也没有任何提示。

这与 1.5.1 修的「手动探测被后台吞掉」是同一个模式。现在与它一致：

- 自动调度撞上正在跑的一轮 → 直接跳过（保持原来的互斥语义）；
- **`force` 请求** → 等这一轮结束后**补跑一轮**。

`48-checkin-race.mjs` 复现：1.5.2 手动签到期间签到请求数 **0**；1.5.3 变成 **2**
（先等自动那轮结束，再补跑），并且手动请求会明确等待而不是提前返回。

### 优化：轻量状态不再携带账号级明细（侧栏轮询体积 −41%）

`/status?light=1` 是侧栏小卡每 60 秒轮询一次的接口。它其实只读「哪个账号是当前
账号」和 `label`，但响应里仍然为每个账号带上了 `credits`（含 50+ 个趋势点）、
`usage`、`cooldownUntil`、`lastTest` —— 这些全是设置卡片才用的。

现在 `light=1` 的账号只保留 `{id, label, enabled, kind, active}`；完整状态的
`/status` 完全不变（卡片仍能显示每个账号的额度与测试结果）。

用真实 profile 数据的副本 A/B 实测：

| | 轻量响应 | 完整响应 |
|---|---|---|
| 1.5.2 | 26,084 B | 52,919 B |
| 1.5.3 | **15,257 B** | 52,919 B（不变） |

侧栏每次轮询少传约 10.6 KB，解析成本也随之下降。

### 测试

- `node --test tests/*.test.mjs`：**171 条**（新增「手动签到不被自动签到跳过」，
  以及轻量状态的账号字段断言：`credits`/`usage`/`lastTest` 必须缺席、完整状态必须保留）；
- `node tests/client-credits.mjs`：**31 项**全部通过。

新用例在旧代码上确实会失败（手动签到期间签到请求数为 0）。

## 1.5.2 — 2026-10-18

一处用户天天会碰到、但很难复述的丢失更新：连点两个模型开关，第一个改动会自己弹回去。

### 修复：连点模型开关时后一次请求覆盖前一次

`toggleModel()` 每次都回传**完整的** `disabledModels` 列表，而这份列表是从上一次
`/status` 算出来的。两次点击之间如果第一个 POST 还没回来（本地网络正常时也只要
几十毫秒，但连续勾选时必然撞上），第二次仍然从旧 status 出发：

```
点「关闭 m1」 → 补丁 { disabledModels: ["m1"] }
点「关闭 m2」 → 补丁 { disabledModels: ["m2"] }   ← m1 的改动没了
```

界面上还会出现更难懂的现象：第一个复选框短暂打勾、随后自己弹回。带上响应序号的
防护也救不了 —— 问题不在「谁覆盖谁」，而在**两次补丁的内容本身就都是错的**。

修法：客户端记下「这一轮用户改过哪些模型」（`pendingModelToggles`），计算补丁时
以「服务端现状 + 本地未落盘改动」为准；复选框的勾选态也读同一份数据，因此不会再闪回。
凡是失败的写请求都会清空这份本地猜测，让界面回到服务端真实值。

同一类问题在「全部关闭」上更明显：`setAllModels()` 之后紧接着单独开一个模型，
第二次补丁只会包含那一个 id，其余模型全部复活成「开启」—— 现在「全部关闭/开启」
也会写成一组本地意图。

### 顺带修正测试 harness

`tests/client-credits.mjs` 里的 `useRef` 之前是 `(value) => ({ current: value })`，
**每次渲染都返回新对象**，`pending` 这类靠 ref 保存的状态在测试里永远是空的 ——
于是这类竞态在测试里根本复现不出来。现在 `useRef` 按 hook 序号跨渲染保留，
并在每次 mount 时重置。

### 测试

- `node tests/client-credits.mjs`：**31 项**（新增「连点两个模型不会互相覆盖」，
  同时覆盖「全关后单独开启」）；
- `node --test tests/*.test.mjs`：**170 条**全部通过。

新用例在旧代码上确实会失败（`[["t1"],["t2"]]`），修复后是 `[["t1"],["t1","t2"]]`。

## 1.5.1 — 2026-10-18

两处「点了没反应 / 该重开却不重开」，都属于 1.5.0 改动引出的连带问题或长期存在
的静默丢弃。

### 修复：只有保活帧时，排队重开被跳过（1.5.0 回归）

1.5.0 给解析器加了内部 `heartbeat` 事件，但 `retryQueued()` 里判断「是否可以无损
重开」的写法是：

```js
for await (const event of parseQoderStream(body, signal)) {
  emitted = true          // ← 任何事件都算「已经吐过内容」
  yield event
}
```

心跳不是内容、也不会转给调用方，却把 `emitted` 置了位。于是「上游先发几帧保活、
随后以 `isQueued` 拒绝」这种再常见不过的排队形态，会直接失败而不是按建议等几秒
重开 —— 免费模型在高峰期恰好是最需要重开的时候。

现在只有**非 heartbeat** 事件才算「已输出内容」。
`38-queue-requeue-heartbeat.mjs` 复现：1.5.0 只发 1 个请求就抛
「Qoder 正在排队」；1.5.1 发 2 个请求并拿到正文。

### 修复：手动「检测账号可用模型」被正在跑的后台探测静默吞掉

`runProbe()` 开头是 `if (probeRunning) return`。启动 6 秒后就会有一轮后台探测，
用户这时点「检测账号可用模型」，`action=probe` 虽然清了时间戳、带着 `force: true`
调进来，仍然**直接返回 undefined**：界面不刷新、时间不变、也没有任何提示，
看起来就是「按钮坏了」。

现在与目录/额度刷新同一套并发语义：

- 后台那一轮在跑时，**普通定时触发**直接跳过（`return false`）；
- **`force` 请求**等这一轮结束后**补跑一轮**（`await probeTask` 后再跑）。

`41-probe-coalesce.mjs` 验证：手动请求会等待而不是提前返回，放行后总探测请求数
从 1 变成 2。

### 测试

- `node --test tests/*.test.mjs`：**170 条**（新增「保活帧后仍可重开」与
  「手动探测不被后台吞掉」）；
- `node tests/client-credits.mjs`：**30 项**全部通过。

## 1.5.0 — 2026-10-18

三条「平时看不出来、出问题时很难查」的修复：保活帧下的空闲超时、被 `??` 吃掉
的单请求超时、以及额度缓存里的坏数字。

### 修复：上游发保活帧时，长思考仍会被空闲超时切断

`withIdleTimeout()` 只在「下一个事件到达」时重置计时器，而两个 SSE 解析器会**静默
跳过**所有没有内容产出的帧：`: keep-alive` 注释行、空 `data:` 行、只带 `finish_reason`
的帧、只带 `usage` 的帧。

上游在长思考/排队时正是用这类帧保活。于是「连接明明活着、字节一直在流动」，本地却在
空闲超时（默认 180 秒）到了以后把一条完全正常的请求 abort 掉 —— 用户看到的是
「思考了三分钟突然失败」，日志里只有一句「上游已经 180 秒没有返回任何数据」。

现在两个解析器在「这一批字节没有产出任何内容事件」时 yield 一个内部
`{type:'heartbeat'}`；`withIdleTimeout()` 见到心跳会**重置计时器但不转发**，
所以心跳既不会进适配器、也不会进统计。真正卡死（一个字节都不来）仍然照常超时。

`_dsh-reverse-proxy-scratch/30-keepalive-idle.mjs` 复现：8 个保活帧 + 正文，
`idleMs: 120` 时 1.5.0 之前报 `IdleTimeoutError`，之后正常完成。

### 修复：`signal ?? AbortSignal.timeout(...)` 让单请求超时永远不会生效

`a ?? b` 的语义是「a 为 null/undefined 才用 b」。而这些调用点的 `signal` 来自
runtime，**几乎永远不是 undefined**（签到的 `checkinAbort`、额度/目录刷新的取消信号、
插件卸载信号……）。于是那句「请求超时」注释下的代码从来没有执行过：

- 签到的计费端点挂死 → `checkinRunning` 一直被占住，30 秒调度器整轮空转；
- 额度请求挂死 → 卡片永远停在「读取中」；
- 换 token 挂死 → 登录流程卡在「读取账号信息」。

全仓 10 处同一写法（`checkin.js` ×3、`credits.js` ×2、`workbuddy/upstream.js`、
`workbuddy/credentials.js`、`qoder/transport.js` ×3）统一改为新的
`withTimeout(signal, ms)`：外部取消与单请求超时取**并集**，两者都生效。

### 修复：额度缓存里的坏数字会让卡片算出 NaN

`normalizeCachedCredits()` 之前只清洗 `items[]`。顶层字段是 `{...data}` 直接展开，
所以手改或旧版本写下的 `remain: "x"` / `total: null` / `exceeded: "true"` 会原样进
`/status`，卡片渲染成「NaN / NaN」、进度条宽度变成非法 CSS，`paid: "false"` 还会骗过
「是不是 Free 套餐」的判定。现在数字/布尔/字符串字段都按类型收敛，认不出的一律丢掉。

### 修复：Qoder 限流只读响应体，不读 `Retry-After` 头

Qoder 把排队建议写在 body 的 `retryAfterSeconds` 里，但网关/WAF 层的普通 429 只有
标准 `Retry-After` 头。之前这种情况拿不到等待时间，本地只能退到默认值。现在
`classifyUpstreamBody()` 接受第三个参数并优先用 body，body 没有时才读头
（秒数与 HTTP 日期都支持，夹到 10 分钟）。WorkBuddy 侧本来就有这套解析，这次把
Qoder 补齐。

### 测试

- `node --test tests/*.test.mjs`：**168 条**（新增心跳重置/心跳不泄漏/只有心跳仍超时、
  `withTimeout` 并集、`Retry-After` 头、额度缓存坏值归一化）；
- `node tests/client-credits.mjs`：**30 项**全部通过。

## 1.4.0 — 2026-10-18

一轮「流式与工具调用健壮性 + 账号语义」的打磨，没有新增依赖。

### 修复：工具调用的首片在 `name` 缺失时被宿主拆成两段

OpenAI 兼容上游给 `tool_calls` 分片时，`id` / `name` / `arguments` 的到达顺序没有保证，
常见的是「先给一段 arguments，下一片才补 name」。宿主按 `id + name` 认工具块：name 为空
的那一片会被当成普通 chunk，补到 name 时又另起一段 —— 一次正常调用的前半段参数直接
丢掉，工具调用看起来「只传了一半」。现在适配器把首片压到 name 到位再发（先到的参数
一并带上）；name 永远不到时在终态/中断前兜底补一片；首片之后的空分片不再发给宿主。

### 修复：断流时 usage 合计漏掉缓存 token

正常终态用 input + output + cacheRead + cacheWrite，但「上游没给终态就断流」那条分支
只加了 input + output。DeepSeek 系上游的 `inputTokens` 已扣掉缓存命中量，漏掉 cache 会让
断流那几次请求的今日 token 少一大截。

### 修复：宿主运行期间的外部 `stats-reset` 被旧快照覆盖

`stats.json` 是「进程内快照 + 定期全量落盘」。DSH 开着时执行 `node lib/bin.js stats-reset`，
宿主的下一次去抖 flush 会把旧数字整份写回去 —— 重置后一分钟数字又回来了。
现在 `flush()` 先用 mtime/size 判断磁盘是否被改过，并且只在「磁盘的 `since` 比内存里
更新」时采纳磁盘那份（正常写入不改 `since`，自有写入不会被误判）。

### 修复：能力探测结论按 provider 存，切号后会误藏模型

花名册是产品级的、可用性是账号级的。切到另一个账号后旧结论仍在生效，「明明能用却从
选择器里消失」。现在探测结果记 `accountId`，只有当前账号等于探测账号时才应用
`unavailable`；老设置没有该字段时保留旧行为。

### 修复：客户端两处硬编码中文

套餐包兜底名与热力图悬停提示改走 locale（`creditsPackageFallback` / `usageHeatCell`），
中英文案字典保持 209 个 key 一一对应。

### 修复：手改 / 损坏的状态文档会让整张卡片崩掉

`/status` 是「宿主拼出来的文档」，但字段源头可能是上一版写下的磁盘缓存、被手改过的
JSON，或者旧宿主缺字段。客户端里有十几处 `(entry.models || [])`、`Array.isArray(x) ? x : []`
这样的兜底，只挡住了「不是数组」，挡不住「数组里混了 `null`」与「`credits` 是 null」：

- `providers` 里出现一个 `null` → 汇总卡与标签页在 `entry.provider` 上抛错；
- `accounts` / `models` 里出现 `null` → 账号行与模型列表在 `row.active` / `row.id` 上抛错；
- `credits: null` → 侧栏在 `credits.state` 上抛错。

宿主用 `SlotErrorBoundary` 兜这类异常，表现是「整个插件设置区块被换成一条错误」。
现在统一走 `safeArray()`（只保留对象元素），并对 `credits` 的 `null` 单独判空。
`tests/client-credits.mjs` 新增一条「坏数据」用例：`null` / 错类型 / 缺字段混在一起时，
卡片、四个标签页与侧栏小卡都必须能渲染。

### 清理

- 删除未使用的 `PROXY_PREFIX`、`CREDENTIAL_POLL_MS`；
- 写接口请求体上限提成 `REQUEST_BODY_LIMIT`（1 MB），`readBody()` 不再散落魔法数字。

### 测试

- `node --test tests/*.test.mjs`：**163 条**，新增工具首片顺序、残缺 name 兜底、
  断流 usage 缓存、外部重置采纳、自有写入不误判、探测结论按账号生效等用例；
- `node tests/client-credits.mjs`：**30 项**全部通过（新增「坏数据仍能渲染」，
  热力图断言同时兼容 locale 模板）。

## 1.3.1 — 2026-10-18

两处回归修复，没有新增依赖。

### 修复：正常完成的请求被统计成「中断」

`runtime.openStream()` 之前把 `#record()` 写在 `yield finish` 之后。宿主收到
finish 就停止拉取，生成器在 `yield` 处被 `return()`，后面的记录代码不会执行，
`finally` 便按「没记过」补记 `incomplete`。于是每一次正常回答都会在设置卡片
的「最近请求」里显示「中断」，尽管回复已经完整到达。现在先记录终态再
`yield`。

### 修复：WorkBuddy / Qoder 模型无法接收图片

`lib/index.js` 传给 `ReverseProxyAdapter` 的 runtime 门面漏了
`canAcceptImages`，适配器因此永远把 `inputModalities` 声明成 `['text']`。
DSH 在附件准入阶段就会以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝图片（界面提示
「当前模型不支持图片」）—— 即使附件服务已经接上、上游目录也标了
`supportsImages: true`。现在门面转发 `runtime.canAcceptImages()`。

## 1.3.0 — 2026-10-18

这一版的主题是「把 1.2.0 的 Qoder Free 修复补完整，并修掉流式终态、统计串台、
设置落盘与刷新竞态」。没有引入新的外部依赖。

### 修复：Qoder Free 的 0 付费额度在所有位置都按 Free 处理

1.2.0 只改了顶部横幅与卡片徽标，颜色、自动换号、CLI 仍然把 Free 当成「额度用尽」。
现在统一到一个判定（`lib/quota.js`）：

- `fetchQoderCredits()` 写入 `freePlan: true`，老缓存由 `planName` / `paid` 兜底；
- 卡片、账号总览、侧栏数字/圆点/进度条都不再亮琥珀色；
- `autoSwitch` 不会为了 Free 的 0 切到付费账号；
- `node lib/bin.js credits|doctor` 显示「Free 套餐：付费额度为 0，免费模型仍可用」；
- 诊断文本不再把 Free 写成「已用尽」；付费套餐的 0 仍然算用尽。

### 修复：Qoder 流式 usage 落在 finish 之后会丢失

与 1.1.0 修 WorkBuddy SSE 的问题相同，Qoder 的 `parseStream()` 之前一看到
`finish_reason` 就 `yield finish`，调用方收到 finish 立即收流，后面单独到达的
usage chunk 永远到不了统计。现在只记终态，等 `[DONE]` / EOF 再发 finish，
并保证 finish 只出现一次。

### 修复：取消被记成「正常完成」

两个 SSE 解析器在 `signal.aborted` 时直接 `return`，adapter 会补一个
`kind: stop` 的 finish，DSH 与统计都会把用户主动取消当成成功。现在抛
`CancelledError`，终态是 `aborted`。

### 修复：流中途失败留下没有结尾的文本/工具块

适配器在 `catch` 里会先 `block-end` 已打开的文本/推理块与工具块，再发失败
finish。之前只发 finish，渲染器会留下一个永远不结束的块。

### 修复：统计 kind 永远记成 stop

运行时从解析器拿到的是 `event.kind`（`stop` / `tool-calls` / `max-tokens` /
`error`），1.2.0 却只读 `event.reason?.kind`，导致所有 WorkBuddy 成功请求都
被记成 `stop`。现在以 `event.kind` 为准，并把失败的 `message` 一并记进
`stats.json`，卡片状态区多了「最近一次失败：CODE · 模型 · 时间」（悬停看全文）。

### 修复：工具结果里的图片插在并行 tool 消息中间

一次 assistant 发起多个 tool_call、且**非最后一个** tool 结果带图时，旧实现
会在 tool1 和 tool2 之间插一条 user 消息，破坏「assistant 的每个 tool_call
必须被连续 tool 响应」的结构。现在先收齐同一轮连续 tool 结果的图片，在最后
一条 tool 之后只插一条 user 消息；单 tool 场景行为不变。

### 修复：SSE 末行没有换行时丢最后一段

两个解析器都在 `reader.read()` 返回 `done` 时直接退出，没有处理 buffer 里
残留的最后一行。现在 EOF 时 flush decoder，并把尾包补成完整 data 行再解析；
最后一段正文、`finish_reason=length` 都不会再丢。

### 修复：损坏的 SSE JSON 帧被静默丢弃

`data:` 行 JSON 解析失败时旧实现直接 `continue`，回答会中间缺一段、最后
仍然报 `stop`。现在只要 payload 看起来像 JSON（以 `{` / `[` 开头）就抛
`malformed`，由 DSH 明确报错；上游的注释/心跳行仍然安静忽略。

### 修复：Qoder PAT 失效不会触发换号

`resolveIdentity()` 的 PAT 无效错误只带了 `code: pat-invalid`，`kind` 用了
构造函数默认的 `server`；`failureCodeOf()` 先看 kind，于是多账号救援在最常见
的「PAT 过期」场景完全不触发。现在：

- Qoder 令牌交换 / 身份缺失显式抛 `kind: 'auth'`；
- `failureCodeOf()` 让凭证类 code 优先于默认 kind；
- 坏 PAT 冷却按 AUTH 的 2 分钟，而不是 SERVER 的 15 秒。

### 修复：Qoder 普通 429 / 402 被归类成 malformed

只有带 `isQueued` / `code:10605` / `code:110` 的响应才会被识别，普通网关
429/402（空 body 或一句 Too Many Requests）落到 `malformed`，既不换号也不按
限流/额度退避。现在状态码兜底：429 → `soft-rate`，402 → `quota`，
408/504/5xx → `server`。

### 修复：Qoder 排队等待上限对流阶段不生效

1.2.0 把首包预算（45 秒）复用到了流阶段的 `reopen()`，所以高级里调到
60–180 秒对流中排队没用。现在首包仍受 60 秒连接死线约束（实际等待
`min(上限, 45s)`），流阶段重开按 `qoderQueueWaitMs` 剩余预算执行。
「重开次数用尽」与「等待时间用尽」也拆成两种文案，不再出现
「已等待 2 秒，超过 45 秒上限」。

### 修复：凭证续期并发时旧 token 覆盖新 token

同一账号两个并发请求同时命中 5 分钟续期余量时，会各打一次 refresh；后一次
若失败会回退旧凭证，而旧实现仍无条件写回 settings，覆盖前一次刚拿到的新
令牌。现在按 `provider::账号` 单飞（single-flight），并且只有 accessToken /
refreshToken / 过期时间**真的变化**时才写回。

### 修复：设置文件坏掉会静默丢 PAT，写盘失败仍返回 200

- 读设置时兼容 UTF-8 BOM 与 PowerShell 的 UTF-16LE/BE；
- 解析失败先把原文件复制成 `settings.json.corrupt-<时间戳>`，并在状态/诊断
  里报告 `loadError` 与备份路径；
- `writeTextAtomic()` 对 Windows 的 EPERM/EBUSY/EACCES 做有限重试；
- `SettingsStore.patch()` 写失败会抛错并回滚内存值，`POST /settings` 返回
  500，不再「界面显示已保存、重启后丢失」；
- 每次 patch 前检查磁盘 mtime/size：CLI 或另一个进程刚写过设置时，先重读
  再合并，宿主不会用旧快照覆盖 CLI 新登录的账号。

### 修复：目录刷新与凭证续期的竞态

- 目录刷新按 provider 单飞；带 `force` 的请求遇到后台轮询时会等它结束后
  补跑一轮，不再被静默吞掉（与额度刷新同一套语义）；
- 能力探测的每一条请求都接上整轮探测的取消信号，插件卸载后不会继续白跑
  45 秒；
- 插件卸载时取消进行中的浏览器登录与签到；登录成功回调也会检查
  `runtime.stopped`，不会在卸载后写账号池。

### 修复：浏览器登录取消后仍会写入账号

1.2.0 的「取消」只关闭轮询；如果令牌刚好换到，`result.then` 仍会把账号写进
设置。现在取消会设置 `cancelled`，登录回调和 CLI/GUI 轮询都以此为准；
`authUrl` 必须是 https 才会被用于打开浏览器或 href。

### 修复：签到完成状态只按 provider 记，新账号当天漏签

现在 `checkin.completedOn` 之外还记录该 provider 的启用账号集合
（`checkin.accountIds`）。当天新增 / 新启用的账号会让 `checkinDue()` 重新
返回 true；已签的账号会返回 `already`，不会重复领取。浏览器登录成功后会
立即触发一次该 provider 的签到。老设置没有账号集合时，1.3.0 会先补跑一次
（幂等）。

### 修复：PAT 账号之间的可用性判断

`isAccountUsable()` 之前不知道 provider 类型：Qoder 的空 `pat` 因为
`authFile === undefined` 被误判为可用，请求失败换号时可能选到一个没配令牌
的账号。现在按桌面 / PAT 分开判断；隐式默认账号仍然允许环境变量 PAT 兜底。

### 修复：WorkBuddy 目录把 disabled 模型复活成 virtual

上游把模型标 `disabled:true` 但仍留在 cli 花名册时，旧实现给它补一份
128K/32K、`supportsImages:true` 的 virtual 元数据。现在 disabled 与元数据
非法的 id 都直接跳过，只有「models[] 里完全没有」的虚拟 id（如 `auto`）才
使用默认值。

### 修复：侧栏与卡片的状态串台

- `stats.json` 升到 v3：新增 `providerDaily` / `providerSessions`；
  热力图和「当前会话」按 provider 取数，不再把 WorkBuddy 的会话挂到 Qoder；
- 午夜后即使没有新请求，`/status` 的「今日」也会归零；跨日启动不会再从旧
  文件把 `providerToday` 读回来；
- 额度历史的小时桶按**本地**整点对齐，非整小时时区（如 +05:30）的午夜消耗
  不再记到昨天；
- 额度缓存里的坏 `items`（null / 非对象）在读取时就被丢掉，不会让整张设置
  卡片被宿主的 SlotErrorBoundary 替换。

### 修复：客户端可靠性

- 诊断面板的原始 JSON 会脱敏控制密钥、用户目录与登录 state（复制诊断也走
  同一份脱敏逻辑）；
- 所有 fetch 加超时（状态 15s / 写操作 60s / 诊断 20s），不会永久卡在
  「保存中…」；
- 浏览器登录轮询有取消令牌与卸载清理，等待期间「新增账号」按钮保持禁用；
- 高级设置保存后用服务端夹取后的值回填草稿，不再显示 9999 秒却提示已保存；
- 账号/PAT 草稿切换标签时清空，添加账号只在保存成功后清空，失败保留；
  保存/清除 PAT 只回传当前账号一行，不会用旧快照把已删账号复活；
- 模型、预警、探测、用量等嵌套数组统一做安全过滤，手改坏的 JSON 不会让
  卡片崩掉；
- 共享设置区块的标题走 `locale`，英文界面不再显示中文；模型复选框、provider
  标签、诊断按钮补了 aria 属性。

### 新增：高级里可以关掉预警与自动探测

1.1.0 的后端已经支持 `alerts.enabled` / `probe.enabled`，但 1.2.0 的界面没有
入口，而且预警开关只关横幅、不关颜色。现在高级里有两个复选框：

- **启用额度预警（横幅与琥珀色）**：关掉后横幅、卡片数字、侧栏颜色一起关；
- **自动检测账号可用模型**：关掉后不再每 6 小时自动探测；「检测账号可用模型」
  按钮仍然可以手动跑一次（`action=probe` 会强制探测）。

### 行为变更（升级前请确认）

1. **状态文档升到 v6**：新增 `storage`、`credits.freePlan`、
   `stats.providerDaily` / `stats.providerCurrentSession`、`checkin.accountIds`。
   客户端对缺失字段都有 fallback；按 v5 硬编码的第三方消费者需要同步。
2. **`stats.json` 升到 v3**：v1/v2 自动迁移，保留累计与今日；更早的按 provider
   每日历史无法反推，首次升级只补今天的 `providerToday`。
3. **设置文件仍然兼容 v2**，没有新增必填字段；坏文件会先备份再使用默认值。
4. **Qoder Free 不再触发自动换号**；付费套餐的 0 仍然会。
5. **签到按账号集合判断**：当天新增/新启用账号会补签一次，已签账号幂等。
6. **流阶段 Qoder 排队真正按 `qoderQueueWaitMs` 生效**；首包仍最多等 45 秒。

### 测试

- `node --test tests/*.test.mjs`：**156 条**，新增设置文件 BOM/坏文件/写失败/
  跨进程合并、Qoder Free 语义、Qoder 429/402、坏 PAT 换号、SSE 末行无换行、
  取消不伪装成功、多 tool 图片顺序、disabled 模型、statistics v3、跨午夜、
  provider 维度、签到账号集合、macOS/Linux 布局等用例。
- `node tests/client-credits.mjs`：**29 项**全部通过，新增 Qoder Free 不亮警示色、
  关闭预警后不亮色、provider 维度用量/会话、诊断不泄露密钥、设置损坏提示、
  多 tool/图片等检查。

## 1.2.0 — 2026-10-18


### 新增：Qoder 排队等待时间可配置

1.1.2 把免费模型排队从「无限等」改成「60 秒后明确报错」，但 60 秒对
「Qoder 再过一分钟就放行」的场景仍然太短。现在「高级」里新增：

```text
Qoder 排队等待上限（秒）    默认 60，范围 15–180
```

- 首包阶段仍受 60 秒连接死线约束；
- 流中排队按该上限累计重开，不再受固定 4 次上限限制；
- 调到 180 秒可以覆盖 Qoder 常见的 4–6 轮 30 秒排队；
- 超时文案会写明实际等待秒数与上限，仍然是 `RATE_LIMIT`，不会伪装成成功。

### 改进：Qoder Free 不再被标成「额度已用尽」

Qoder Free 的 `userQuota.total` 本来就是 0，`isQuotaExceeded=true` 只表示
付费额度为 0；`qfmodel` 免费模型仍可用，只是排队。现在：

- 顶部预警横幅不再对 Qoder Free 报「额度已用尽」；
- 卡片与侧栏徽标改为 **「免费模型排队」**；
- 保留「Free 套餐的付费额度为 0」说明，并提示可以在高级里延长等待。

真正低额度（例如 WorkBuddy 剩余 5%）仍然会正常触发橙色预警横幅。

### 改进：Qoder 的 0 token 有了解释

Qoder 流没有返回 token usage 时，用量表下会提示
「上游没有返回 token 统计；这里显示 0 不代表没有消耗」，不再让人以为统计坏了。

### 测试

- 设置/补丁测试覆盖 `qoderQueueWaitMs` 的默认值与 15–180 秒夹取；
- 客户端测试新增「低额度仍触发横幅」与「Qoder Free 不误报已用尽」；
- 共 **125 条** `node --test` 用例，**27 项**客户端检查。

## 1.1.2 — 2026-10-18

### 修复：Qoder 免费模型排队时卡两分钟

Qoder Global 的 `qfmodel`（Qwen3.8-Flash）是 `x0` 免费模型，但免费套餐在高峰
会返回 `isQueued` / `retryAfterSeconds`。旧实现会在本地连续等 4 轮（约 2 分钟）
才把错误交给 DSH，用户看到的是「转了很久，最后失败」，用量里还留下
`incomplete / 0 tokens`。

现在给排队加了明确预算：

- 首包阶段最多等 **45 秒**，流中排队总预算 **60 秒**；
- 超过预算直接抛 `RATE_LIMIT`，文案明确写「Qoder 免费模型正在排队（已等待 N 秒）」，
  并说明**不是令牌失效、不是模型下线**；
- 不再无限重开，也不会在失败后留下一个看似成功的空回答。

实测同一条 `qfmodel` 请求：旧实现 121.6 秒后才失败；新实现 **60.2 秒**
返回明确的排队提示。

### 改进：Qoder Free 的额度显示不再误导

Qoder 的 `userQuota.total` 对 Free 套餐本来就是 0，上游也会回
`isQuotaExceeded=true`；但 `qfmodel` 是免费模型，仍可排队使用。卡片现在增加一行：

```text
Free 套餐的付费额度为 0；免费模型不扣积分，但高峰期会排队。
```

同时，Qoder 的用量表在「有请求但上游没返回 token 统计」时显示说明，不再让
`tokens 0` 看起来像统计坏了。

### 修复：Qoder PAT 区同一句说明出现两次

截图里两行都以「在账号设置 → 个人访问令牌里生成」开头：一行来自 `patHint`，
一行来自 `patLinkHint`，后者本来只是为了给「打开 PAT 页面」链接做前缀。

现在第二行只保留「还没有令牌？」+「打开 PAT 页面」，生成方式只在第一行出现一次。

### 测试

- 新增 `qoderQueueFailure` 单测：kind / status / retryAfter / 文案；
- 客户端新增 Qoder Free 提示渲染检查；
- 共 **125 条** `node --test` 用例，**26 项**客户端检查。

## 1.1.1 — 2026-10-18

### 修复：浏览器登录页提示「登录链接不完整」

这不是登录接口的问题，而是**打开浏览器的方式**把 URL 截断了。

`authUrl` 形如：

```text
https://www.codebuddy.cn/login?platform=ide&state=39479458-…
```

1.1.0 的 `openInBrowser()` 走的是：

```js
spawn('cmd', ['/c', 'start', '', url])
```

Node 在 Windows 上只给**含空格**的参数加引号，URL 没有空格，于是 `cmd` 收到的
命令是未加引号的 `start "" https://…/login?platform=ide&state=…`。`&` 在 `cmd`
里是命令分隔符 —— 浏览器只拿到 `https://…/login?platform=ide`，`state` 被当成
第二条命令。登录页收不到 `state`，就显示「登录链接不完整，请返回客户端点击
『复制登录链接』后粘贴到浏览器打开」。

现在改成显式引号 + `windowsVerbatimArguments`：

```js
spawn('cmd', ['/d', '/s', '/c', 'start', '""', `"${url}"`], {
  windowsVerbatimArguments: true,
  detached: true,
})
```

同时给自动打开的 URL 加了白名单：只接受 `https:`，拒绝引号与换行。

实测：用同样的 `authUrl` 打开后，Edge 地址栏保留完整的
`?platform=ide&state=…`，页面进入「选择账号」而不是错误页。

### 测试

- `tests/browser-login.test.mjs` 改为断言 URL 必须整体带引号且
  `windowsVerbatimArguments === true`，并新增 URL 白名单用例；
- 共 **124 条** `node --test` 用例，**25 项**客户端检查。

## 1.1.0 — 2026-10-18

这一版不再只是「把模型接进来」，而是回答三个使用中真正会问的问题：
**额度还剩多久、今天到底用了多少、这个账号现在还能不能用。**
同时修掉 1.0.6 遗留的五处可靠性问题。

### 新增：429 限流也自动换号

1.0.x 的请求级换号只认 `AUTH` 与 `QUOTA`。但 WorkBuddy 的每日频率限制、
Qoder 的高峰排队都会回 `429`，旧实现会直接把错误抛给用户 —— 而另一个账号
明明还能用。现在：

- `RATE_LIMIT` 与 `AUTH` / `QUOTA` 一样，在**还没吐出任何内容**时换下一个账号重开；
- 上游给了 `Retry-After` 就按它设置冷却（秒数与 HTTP 日期都支持，最多 10 分钟）；
- 失败账号进入冷却，后续请求不会再先撞它；
- 只有一个账号时保留上游原始错误，不伪造成功；
- 已经吐过内容之后失败仍然不换号，避免重复输出。

### 新增：额度趋势、消耗速度与耗尽预测

以前卡片只有「现在剩 675」，没有「今天用掉多少、还能用多久」。现在每次成功
读取额度都会记一个样本（`credits-history.json`）：

- **今日消耗 / 近 7 天消耗**：逐段累加下降量，充值那一跳不会被算成负消耗；
- **消耗速度**：最近 6 小时内的下降量 / 时间跨度，至少 10 分钟样本才给结论；
- **耗尽预估**：剩余额度 ÷ 速度；超过一年不显示，避免拿两个抖动样本吓人；
- 卡片里有折线图与徽标，侧栏面板里有「今日消耗 + 预计还能用」一行；
- 账号切换、充值、重置都不会把历史清零；每个 `provider::账号` 独立记账。

### 新增：额度预警与按比例自动换号

- `alerts.lowRatio`（默认 15%）：低于该比例时卡片顶部出现预警横幅，侧栏圆点
  与数字转琥珀色；
- `autoSwitch.thresholdRatio`（默认 0 = 只在耗尽时切）：低于该比例就提前换到
  另一个**同样高于阈值**的账号；不会从 10% 切到一个 12% 的账号；
- 两个阈值都在「高级」里改，0–95% 之外的值会被夹回安全区间；
- `alerts.enabled` / `autoSwitch.enabled` 仍然可以单独关闭。

### 新增：用量历史、当前会话与模型榜

`stats.json` 升到 v2（v1 自动迁移，累计与今日不丢）：

- **每日历史保留 30 天**，卡片显示最近 14 天的柱状图；
- **当前会话**单独计数（DSH 的 `sessionId`），用量表多一行「当前会话」；
- **模型用量榜**：按请求数排序的前 5 个模型，带 tokens 与平均耗时；
- 最近请求记录里也带 `sessionId`，便于把一次失败对回具体会话；
- 侧栏「显示今日用量」开关现在**真的生效**（1.0.x 里这个设置只存在于状态文档，
  界面上既没有入口也没有读取）。

### 新增：账号测试与冷却管理

- 每个账号一行「测试」：真发一次 1-token 请求走完整凭证/目录/上游链路，
  返回 `✓ 正常 120ms` 或失败原因；探测请求不计入用量统计；
- 显示最近一次测试结果与失败原因（悬停看全文）；
- 进入冷却的账号显示「冷却至 HH:MM」，可一键「解除冷却」；
- 测试使用该账号自己的目录，不会拿当前账号的模型清单去测别人；
- 新增 CLI：`node lib/bin.js test [provider] [accountId]`。

### 新增：脱敏诊断导出

1.0.x 的「复制诊断」复制的是整份 `/status`，里面有**控制密钥**和
`C:\Users\<用户名>\...` 的登录文件路径。现在：

- 新增 `GET /plugins/dsh-reverse-proxy-connect/diagnostics`（只读、回环）；
- 控制密钥、`pat` / `token` 类字段一律 `[redacted]`；
- 路径缩成 `%LOCALAPPDATA%` / `%APPDATA%` / `~` / `%USERPROFILE%`；
- 「复制诊断」优先复制脱敏后的纯文本；旧宿主没有该路由时退回删掉 `key` 的精简 JSON。

### 修复

- **SSE 的 usage 落在 finish 之后会丢失**：OpenAI 的 `include_usage` 会先发
  `finish_reason`、再发一个只带 usage 的 chunk。1.0.x 在 finish_reason 处立刻
  结束流，导致统计里的 token 恒为 0。现在先记下终态，收到 `[DONE]` 或流结束
  才发 `finish`，usage 一定会先到。
- **签到异常每 30 秒重撞上游**：`runtime.runCheckin()` 抛错时旧实现只记日志、
  不写 `lastAttemptAt`，而调度器 30 秒一拍，结果既不是「10 分钟后重试」，也会
  把上游日志刷满。现在异常也写失败结果与尝试时间，按 10 分钟退避。
- **额度刷新重复打上游**：卡片 20 秒轮询、侧栏 60 秒轮询、30 秒调度器与手动
  刷新会同时触发同一个 provider 的额度读取。现在按 provider 合并 in-flight
  请求；带 `force` 的手动刷新在当前轮结束后补跑一次。
- **能力探测与签到可以重叠执行**：启动探测、手动重探、30 秒签到节拍现在都有
  互斥保护，不会两轮交错写 `unavailableModels` / `checkin.results`。
- **诊断泄露控制密钥**（见上）。
- **`showUsageInSidebar` 是死设置**（见上）。

### 行为变更（升级前请确认）

1. **状态文档升到 v5**：新增 `credits.trend`、`settings.alerts`、
   `settings.autoSwitch`（从布尔改成 `{enabled, thresholdRatio}`）、
   `accounts[].cooldownUntil` / `lastTest`、`stats.daily` / `currentSession`。
   按 v4 硬编码的第三方消费者需要同步；本插件客户端已兼容旧宿主。
2. **`settings.json` 新增 `alerts`，`autoSwitch` 多一个 `thresholdRatio`**。
   旧文件读入时自动补齐，默认值保持 1.0.6 的行为（只在耗尽时切、15% 预警）。
3. **新增数据文件 `credits-history.json`**（额度历史）与 **`stats.json` v2**
   （每日/会话历史）。都可以直接删除，删除后只是丢历史，不影响聊天。
4. **429 现在会触发换号**：多账号时一次限流不再直接失败，而是可能换到另一个
   账号；单账号行为不变。

### 测试

- `node --test tests/*.test.mjs`：**123 条**（新增额度历史 8 条、诊断 4 条、
  429 换号/账号测试 3 条、每日/会话统计 3 条、阈值 2 条、Retry-After 1 条等）。
- `node tests/client-credits.mjs`：**25 项**（新增趋势/预警/测试按钮/用量历史/
  侧栏开关 5 项）。
- 新增 `tests/credit-history.test.mjs`、`tests/diagnostics.test.mjs`、
  `tests/runtime-failover.test.mjs`。

## 1.0.6 — 2026-10-18

### 修复：凭证错误里同一个文件名出现两次

截图里那条「已找：`C:\Users\…\Local\…\workbuddy-desktop-ai.info` /
`C:\Users\…\Roaming\…\workbuddy-desktop-ai.info`」并不是重复渲染，而是
WorkBuddy 会同时查 `%LOCALAPPDATA%` 与 `%APPDATA%` 两个目录，两个候选文件名相同。
但把两条完整绝对路径并排放在界面里，看起来就是复制了一遍。

现在：

- 错误文案只展示**主路径**，后面跟「等 N 个位置」；
- 路径用 `%LOCALAPPDATA%` / `%APPDATA%` / `~` 缩写，不再展开完整用户目录；
- 结尾补一句「或在连接设置里指定登录文件」，给出手动兜底；
- 诊断 JSON / 日志里仍然是原始路径，排障信息没有丢。

展示示例：

```text
没有找到 workbuddy-ai 的登录文件（已查找
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info 等 2 个位置）。
请先打开 WorkBuddy AI 并登录，或在连接设置里指定登录文件。
```

### 测试

- 新增 `tests/credentials-message.test.mjs`（2 条）：环境变量缩写、主路径 +
  「等 N 个位置」、只传一个候选时不加后缀、空输入返回空串。
- 共 101 条 `node --test` 用例。

## 1.0.5 — 2026-10-18

### 修复：同一段凭证错误在卡片里显示两次

目录刷新失败与凭证读取失败经常是**同一个原因**（例如没有登录文件）。旧实现把
`credential.message` 和 `active.message` 各渲染了一遍，于是状态区出现两段一模一样
的橙色长文案，每段还带两三个绝对路径。

现在状态区做一次归一化去重：

- 凭证错误只显示一次；
- 目录错误只有在「与凭证错误不是同一件事」时才额外显示；
- 比较时会把空白归一化，并允许一方包含另一方，避免措辞略有差异时漏判。

### 修复：签到失败把完整凭证错误又抄了一遍

签到结果里的 `failed.message` 就是同一个凭证错误。旧实现原样塞进「签到失败：…」，
结果账号区又出现一段三行的绝对路径。

现在：

- 签到行只显示短原因：未登录 / 读取失败 / `HTTP 4xx` / 截断到 48 字；
- 完整原因放进该行的 `title`，悬停仍可查看；
- 状态区仍然保留一次完整说明，排障信息没有丢。

### 测试

- `tests/client-credits.mjs` 增加到 20 项：构造「凭证错误 = 目录错误 = 签到失败」
  的场景，断言长文案只出现一次，且签到行仍保留完整 `title`。

## 1.0.4 — 2026-10-18

### 优化：WorkBuddy 账号区不再显示手动添加框

浏览器登录已经能覆盖新增账号的完整流程，再摆一个「账号名称 + 登录文件路径」的
添加框只会制造三个问题：

1. 用户会以为必须自己去找 `workbuddy-desktop-ai.info`；
2. 留空添加会复制出第二个「本机登录」；
3. 与上面的「浏览器登录新增账号」重复，不知道点哪个。

现在：

- WorkBuddy / WorkBuddy AI 的账号区只保留「浏览器登录新增账号」+ 账号列表；
- 本机已有的桌面端登录仍会作为默认账号自动读取，不需要用户填路径；
- 提示改成「桌面账号用上面的浏览器登录添加；本机已有登录会自动读取」；
- Qoder 没有浏览器登录，继续保留「名称 + PAT」的手动添加；
- 后端能力没有删除：设置文件 / CLI / 接口仍然支持带 `authFile` 的账号，
  只是默认 UI 不再引导用户手填。

### 测试

- `tests/client-credits.mjs` 增加断言：WorkBuddy 标签页没有手动添加账号输入框；
  切到 Qoder 后仍有「名称 + PAT」添加框。

## 1.0.3 — 2026-10-18

### 优化：小面板不再展开完整凭证错误

侧栏面板只有 300 多像素宽，之前把「没有找到 workbuddy-ai 的登录文件（已找：
C:\\Users\\…\\workbuddy-desktop-ai.info / …）。请先打开 WorkBuddy AI 并登录。」
整段塞进行内，把一行撑成六行，还挤掉了 provider 名。

现在：

- 面板只显示短状态：未登录 → 「未登录」，读取失败 → 「读取失败」；
- 完整原因放在徽标的 `title` 里，悬停可看；
- **设置卡片仍然保留全文**，那里宽度足够，也是排障时真正需要它的地方；
- 「缓存数据」徽标从标题行移到元信息行，provider 名不再被挤成 `WorkBud…`；
- 到期时间在面板里简写成 `到期 M/D`，完整时间仍在卡片里；
- 有凭证问题时不再同时显示「当前 本机登录」，避免「未登录 + 当前本机登录」自相矛盾。

### 测试

- `tests/client-credits.mjs` 增加到 19 项：新增长错误文案场景，断言面板只出现
  「未登录」、不出现完整路径，并且保留「缓存数据」标记。

## 1.0.2 — 2026-10-18

### 打磨：侧栏积分面板

按实际截图重做了信息层级，不再是一行「provider + 一大串数字」：

- 头部：`积分` + provider 数量 + 最近更新时间；
- 每行：彩色圆点 + provider 名 + 状态徽标（已用尽 / 缓存）+ **大号剩余数** +
  小号分母与单位；
- 进度条改为 4px、按 provider 强调色、宽度变化带过渡；
- 元信息拆成小徽标：完成百分比、套餐名、当前账号、到期时间、今日用量；
- 读不到时显示 `— / 读取失败`，并在行内给出失败原因；
- 「缓存数据」单独成徽标，行整体降透明；底部文案不再谎称「正在刷新」，
  而是「显示上次结果 · 可手动刷新」；
- 展开面板时如果仍是缓存数据，会自动拉一次额度；
- 面板增加轻微阴影与 48vh 上限，行间用 0.5px 分隔线约束。

### 打磨：侧栏胶囊

- 每个 provider 段加 `title`，悬停能看到完整额度与缓存状态；
- 缓存数据的圆点改成空心环，数字降透明；
- 段之间加 0.5px 分隔线，间距收紧，避免侧栏窄时被裁切；
- 数字统一 `tabular-nums`，字号/字重固定，切换数值不跳动。

### 测试

- `tests/client-credits.mjs` 的面板断言扩展到 provider 数量、百分比、今日用量、
  已用尽徽标与更新时间；共 18 项检查（原断言基础上加严）。

## 1.0.1 — 2026-10-18

1.0.0 发布后根据实际界面反馈做的两处修正：用量区排版与自动签到的调度。

### 修复：自动签到按「20 小时」节流，会漏掉第二天

旧实现用 `lastRunAt` 做「一天最多一次」判断：

```text
if (Date.now() - lastRunAt < 20 * 3600_000) return []
```

它的问题在跨天时暴露：如果昨天 23:00 签过，今天要等到 19:00 才满 20 小时 ——
**今天一整天都不会自动签**。用户看到的就是「没有自动签到功能」。

现在改成按**本地自然日**判断，并且按 provider 独立记录：

- `checkin.completedOn[provider]`：这个 provider 已经完成签到的本地日期；
- 跨过午夜（日期变了）立即重新尝试；
- `claimed` / `already` / `inactive` / 没有可签账号 → 今天结束；
- 失败 → 10 分钟后重试，不会因为一次失败放弃当天；
- 多账号里只要还有一个失败就继续重试，已签的账号会返回 `already`，不会重复领取。

旧设置不需要迁移：`completedOn` 为空时第一次自动运行会先读上游签到状态，
今天已签会得到 `already` 并记为完成，不会重复领取。

### 新增：自动签到开关与状态

- 账号区新增「自动签到」复选框，直接写 `checkin.enabled`；
- 下方说明「每天自动检查一次；失败 10 分钟后重试」；
- 状态文案区分「今日已完成 / 今日已签到 / 本次签到成功 / 无活动 / 失败 + 10 分钟后重试」；
- 「上次尝试」时间保留，便于判断自动任务有没有跑。

### 修复：用量区没有表格约束，读起来像排版事故

- 今日/累计改成真正的表格：表头底色、列对齐、行分隔线、圆角描边；
- 「请求 / 成功率 / 平均耗时 / tokens」四列固定栅格；
- 最近请求也改成表格（时间 / 模型 / 结果 / 耗时 / tokens），沿用同一套行线；
- 今日平均耗时改用**今日**数据，不再复用累计平均；
- 修正「用量 18」—— 那个数字原本是模型数，现在显示今日请求数；
- 修正「平均 1.4sms」—— `formatDuration()` 已经带单位，模板里又拼了一次 `ms`；
- 最近请求的时间在当天只显示时分秒，悬停可看完整时间。

### 测试

- 共 99 条 `node --test` 用例。
- `tests/checkin-schedule.test.mjs`（6 条）：关闭、当天已完成、跨午夜、失败退避、
  昨天失败今天立即重试、多账号终态判断。
- 设置归一化测试补上 `completedOn` / `lastAttemptAt` 的坏值丢弃。
- `tests/client-credits.mjs` 增加到 18 项检查：用量表格栅格/表头、自动签到开关与补丁。

## 1.0.0 — 2026-10-18

第一个正式版。重点不是「再加一个功能」，而是把 0.9.0 里那套「各条链路各读各的
凭证」的结构拆掉，再在统一运行时上补齐图片、用量、换号与可观测性。

### 修复：浏览器登录的账号不能聊天

**这是 0.9.0 最严重的问题。** 浏览器登录只把令牌写进账号（`account.token`），
而目录与聊天仍然调用 `readDesktopCredential()` 去找本机登录文件。结果是：

- 卡片显示「已登录」；
- 额度能正常读取（额度路径用了 `credentialForAccount()`）；
- 一发消息就报「没有找到 WorkBuddy 的登录文件」。

1.0.0 把凭证解析收敛成 `Runtime.credentialForAccount()` 一个入口，目录、聊天、
额度、签到全部走它：`account.token` → 本机登录文件 → 续期 → 写回。浏览器登录
从此是真的可用，而不是「只在额度面板里可用」。

### 修复：长回答被 5 分钟总超时切断

旧代码用 `AbortSignal.timeout(300_000)` 当整条流的总超时，并且注释写的是「空闲超时」。
实际行为是：任何持续超过 5 分钟的正常长回答都会在 5 分钟处被 abort。

现在拆成两层：

- 打开连接（等响应头）60 秒；
- 流建立后**空闲** 180 秒（只有连续没有事件才 abort，持续出字永不打断）。

两个值都可以在「高级」里改，并被夹到安全区间。

### 修复：Qoder 首包排队不会本地重试

旧实现只在流已经建立之后处理 `isQueued`（`retryQueued`）。如果上游在**打开阶段**
就回 403 + `isQueued`，错误直接抛给宿主。现在打开阶段也会按 `retryAfterSeconds`
等一次再重开（最多 3 次，可取消）。

### 修复：多账号下 PAT 保存/清除写到了被忽略的字段

有账号池时，卡片上的「保存 PAT」写的是 `qoder[provider].pat`，而 `accountsFor()`
在账号池非空时根本不会读这个字段 —— 用户看到「已保存」但状态没变。

现在：

- 有账号池 → 写进**当前账号**；
- 没有账号池 → 仍写旧字段，保持老设置兼容；
- 「清除」通过 `forget: true` 显式告诉服务端不要沿用旧密钥（空字符串在归一化时会被
  丢掉，没有这个标记就清不掉）。

### 修复：续期后的凭证没有更新内存缓存

`refreshDesktopCredential()` 返回新 token，但 `credentials.js` 里按
「文件 + mtime + size」做的缓存仍是旧对象。于是下一次读文件又拿到过期 token，
每个请求都续期一次。现在续期成功后同步更新缓存，并把新的
`refreshExpiresAtMs` 一起带回。

### 修复：两个 WorkBuddy 变体共用一份 UA 版本号

`readAppVersion()` 用一个全局变量缓存版本，第二个变体会沿用第一个的值。而
`/v3/config` 是按 User-Agent 分流花名册的 —— 错配会拿到另一份目录。现在按变体
分别缓存，并且会从已解析的 App 路径读 `version`。

### 修复：内置兜底目录被当成真实目录缓存

目录磁盘缓存最初会把 `builtin` 的 4 个兜底模型也写进去，下次启动就会以「已缓存」
的身份展示。现在只缓存 `live` / `saved` / 已有磁盘条目，`builtin` 永不落盘。

### 新增：图片输入

- 通过 `ctx.attachments.readImageRequest()` 把持久引用读成请求版本；
- 默认预算约 4M 像素 / 4MB，保持宽高比、不放大；
- user / system 图片 → 说明文本 + `image_url` data URL；
- tool 结果图片 → 工具消息保持纯文本，图片提升成紧随其后的 user 消息
  （OpenAI 的 tool 消息只接受文本）；
- 没有附件服务时 `inputModalities` 只声明 `text`，由宿主换成占位符；
- 适配器实现 `imageRequestTarget()`，与运行时使用同一套几何计算。

### 新增：用量统计

`lib/stats.js` + `stats.json`：

- 每次请求记录 provider / 账号 / 模型 / 结果 / token / 耗时；
- 今日与累计分开，日切按本机时区；
- 成功、失败、取消、中断分开计数；
- 连续失败算出 `ok / degraded / down` 健康状态；
- 最近 40 条请求，失败带稳定 code；
- 支持重置、关闭；写盘原子化且失败不影响聊天。

设置卡片新增「用量」区块，侧栏面板增加「今日请求 / token」，CLI 新增 `usage`。

### 新增：请求级自动换号

- `AUTH` / `QUOTA` 失败且尚未产出内容 → 换下一个账号重开；
- 换号结果写回 `activeAccount`；
- 失败账号进入冷却（认证/额度 2 分钟、限流 30 秒、服务端 15 秒）；
- 已产出内容后失败不换号，避免重复输出；
- 探测请求不参与换号。

### 新增：目录磁盘缓存

- 按 `provider::账号` 保存最后一份成功目录（30 天有效）；
- 启动时恢复，卡片来源显示「已缓存」；
- 手动刷新/定时刷新成功后替换；
- 可在高级设置里关闭。

### 新增：轻量状态接口

`GET /status?light=1` 只返回额度、账号、健康与今日用量，供侧栏小卡每 60 秒轮询；
完整卡片仍走 `/status`。侧栏轮询的响应体从几十 KB 降到几 KB。

### 新增：健康状态

每个 provider 根据最近请求计算健康状态，卡片总览、标签页圆点、状态区都有展示。
连续 2 次失败为降级、3 次为不可用、一次成功立即恢复。自动目录刷新在 `down` 时
会短暂熔断 2 分钟（手动刷新不受影响）。

### 新增：高级设置

`settings.advanced`：

| 字段 | 默认 | 区间 |
|---|---|---|
| `idleTimeoutMs` | 180000 | 15s – 15min |
| `catalogRefreshMs` | 600000 | 2min – 24h |
| `creditsRefreshMs` | 120000 | 30s – 6h |
| `stats` | true | 布尔 |
| `catalogCache` | true | 布尔 |

调度器改成 30 秒节拍检查「到点没有」，改设置立刻生效，不需要重启插件。

### 新增：CLI 工具

```text
node lib/bin.js doctor [--strict]
node lib/bin.js usage [provider]
node lib/bin.js probe [provider]
node lib/bin.js checkin [provider]
node lib/bin.js login workbuddy
node lib/bin.js stats-reset
```

`doctor` 会检查 Node 版本、设置版本、数据目录、四个 provider 的登录/目录/额度/健康，
`--strict` 时有问题退出码为 1。

### 其他修复与打磨

- 设置、额度、目录、统计四份 JSON 统一改成原子写（临时文件 + rename，0600）；
- **账号池改成增量 upsert**：`accounts` 补丁只更新提到的账号，删除必须走
  `removedAccounts`。旧版整表覆盖，浏览器拿着旧快照点一次「使用 / 删除」就会把刚
  登录的账号整条冲掉（令牌永久丢失）；
- 设置结构升到 v2，读入时自动升级，旧设置不需要手动迁移；
- `sanitizePatch` 从 `index.js` 抽到 `lib/patch.js`，新增 `advanced`、`checkin`、
  `display.showUsageInSidebar` 等字段，未知字段一律丢弃；
- 被关闭的 provider 不再做凭证探测（桌面端探测可能起子进程、Qoder 探测要网络）；
- 关闭的 provider 也不刷新目录与额度；
- `activeAccount` 钉住的账号被禁用时，改为让位给第一个启用的账号
  （禁用是更强的信号）；
- 失败凭证探测缓存 60 秒，坏 PAT 不会被设置卡片每 20 秒重打一次；
- 状态响应加 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`；
- 状态接口只接受 GET；
- 删除无用的 `describeVariant`、`CLIENT_UA_BASE`、`accountOf` 等死代码；
- 上游请求追加 `x-dsh-attribution` 头（WorkBuddy 的 UA 不能替换，见 README）。

### 测试

- 93 条 `node --test` 用例，新增：
  - `tests/stats.test.mjs`（用量、健康、日切、持久化、开关）；
  - `tests/catalog-cache.test.mjs`（按账号、过期、坏行、内置不落盘）；
  - `tests/patch.test.mjs`（补丁白名单、夹取、刷新判定、设置 v2）；
  - `tests/runtime-images.test.mjs`（图片收集、请求预算、消息翻译、tool 图片提升、
    失败分类、空闲超时）；
  - `tests/host.test.mjs`（用假 Cordis 上下文跑 `apply()`，验证路由、status v4、
    轻量状态、统计重置、设置补丁与密钥校验）；
  - `tests/runtime-browser-token.test.mjs`（桩掉 fetch，证明浏览器登录令牌真的被
    聊天请求使用，而不是回落到本机登录文件）。
- `tests/client-credits.mjs` 扩到 18 项检查，新增健康/用量渲染、重置统计、高级保存、
  账号池 PAT 保存、删除账号走 removedAccounts、侧栏轻量接口。

### 行为变更（升级前请确认）

1. **设置升级到 v2**。旧文件会在读入时补齐 `advanced` 与展示偏好；写回时版本号变 2。
2. **状态文档升级到 v4**。按 `version === 3` 硬编码的第三方消费者需要更新；本插件客户端已同步。
3. **「钉住的账号被禁用」的行为变了**：以前仍会使用该账号，现在会退回第一个启用的账号。
4. **内置兜底目录不再写入磁盘缓存**；离线首启仍会显示兜底，但不会被标成「已缓存」。
5. **状态接口不再接受 HEAD**（只接受 GET）。
6. **关闭的 provider 不再刷新目录/额度/凭证**；重新打开后由设置补丁触发刷新。

## 0.9.0 — 2026-10-17

### 重做：改成真正的浏览器登录

0.8.0 做的是「拉起桌面 App 让你在里面登录」。方向错了 —— 那要靠 App 自己写文件，
既慢又容易失效（App 已在运行、文件被占用、用户根本没装 App，都会失败）。

参考插件里用的其实是 WorkBuddy 自己的**插件登录**端点，全程不需要 App：

```
POST /v2/plugin/auth/state?platform=ide
  → { state, authUrl: "https://www.codebuddy.cn/login?platform=ide&state=…" }
GET  /v2/plugin/auth/token?state=…
  → { accessToken, refreshToken, expiresIn, domain }
GET  /v2/plugin/login/account?state=…
  → { uid, nickname, enterpriseId }
```

实测两个版本都能拿到登录地址：

```
workbuddy      → https://www.codebuddy.cn/login?platform=ide&state=a645a4cb…
workbuddy-ai   → https://www.workbuddy.ai/login?platform=workbuddy-ai&state=605798ae…
```

所以流程改成：

1. 点「浏览器登录新增账号」→ 申请 `state` + `authUrl`；
2. **用系统浏览器打开该地址**（`cmd /c start "" <url>`，这样带 `&` 的 URL 不会被拆开）；
3. 后台每秒轮询 `auth/token`（`11217` = 还没登录完，继续等）；
4. 拿到令牌后读 `login/account` 拿昵称与 uid；
5. 把令牌写进账号池并设为当前，立刻刷新模型与额度。

### 令牌怎么存

浏览器登录的令牌直接存进账号（`accounts[provider][n].token`），
不再依赖任何本机文件；过期时用已有的 `refreshDesktopCredential` 续期，
**续期成功后由宿主写回账号**，不会每次请求都重刷。

界面上仍然只显示「是否已配置」，令牌不会回传给浏览器。

### 界面

「浏览器登录新增账号」按钮 + 实时状态（`正在申请登录地址…` / `已在浏览器打开…` /
`登录成功：昵称`），旁边始终有一个「没有自动打开？点这里」的链接兜底，
以及「取消」。

### 测试

`tests/browser-login.test.mjs`（6 条）：登录目标参数、token 归一化（绝对/相对/JWT 三种
过期时间）、`openInBrowser` 的参数、`11217` 未就绪的轮询、以及完整的
「申请 → 打开 → 换 token → 读账号」链路（桩掉 fetch 与 spawn，不会真的开浏览器）。

旧的 `login-flow.js`（拉起 App 那套）已删除。

## 0.8.0 — 2026-10-17

### 新增：打开 App 登录即可添加账号

之前加 WorkBuddy 账号要手动填登录文件路径 —— 这对普通用户基本等于「不可用」。
现在点一下「打开 WorkBuddy 登录新增账号」，插件会把 App 拉起来，你在里面登录
（或切换）账号，登录成功后新账号自动出现在列表里并设为当前。

为什么是「打开 App」而不是「打开网页」：

- WorkBuddy 没有面向第三方的 OAuth 回调，我们也没有自己的网关可以中转登录，
  所以没法像某些插件那样「打开网页 → 轮询网关拿 token」；
- 但它的桌面端登录成功后会把令牌写进本机 JSON，**盯住 `account.uid` 变化**
  就能知道「刚登录了一个新账号」—— 这条路完全本地、不需要任何服务器。

实现要点（`lib/workbuddy/login-flow.js`）：

- 轮询只读 `account.uid`（明文），**不解密**，所以等待期间零开销、不启子进程；
- 登录会连续写几次文件，所以等 mtime 稳定 ≥1 秒再抓，避免拿到半截文件；
- 抓到新 uid 后**立刻快照**到 `<数据目录>/accounts/<变体>-<uid>.info` ——
  因为那个文件里只有「当前账号」的令牌，不快照就会被下一次登录覆盖；
- 同一个 uid 重复登录 = 刷新同一份快照，不会重复添加账号；
- 5 分钟超时、可取消、失败原因直接显示在卡片上。

### 界面

桌面 provider 的「账号」分组里多了一个按钮「打开 WorkBuddy 登录新增账号」，
点完就地显示进度（`正在打开…` / `请在 WorkBuddy 里登录…` / `登录成功，账号已添加`），
等待中可取消。

### 测试

`tests/login-flow.test.mjs`（5 条）：明文 uid 读取、坏文件兜底、快照命名与覆盖、
显式路径优先，以及一条完整状态机用例 —— 注入 `spawn`（不真的开窗口），
模拟 uid 变化后断言自动快照、`onDone` 被调用、快照内容正确。

## 0.7.0 — 2026-10-17

### 更正：签到是存在的

0.6.0 里我写过「上游没有签到接口」——**那个结论是错的**。当时只拆了桌面端
`app.asar`，而签到走的是 Web 计费端点，不在客户端代码里。参考
`dsh-our-free-model` 的实现后确认了真实协议，并逐条实测：

```
POST https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status
→ {"active":true,"today_checked_in":true,"streak_days":8,"daily_credit":100,
   "total_credits":800,"activity_name":"Buddy应用","end_time":"2026-10-31 23:59:59",…}
```

- **WorkBuddy 国内版**：活动进行中，每天 100 积分（本机连续 8 天、累计 800）；
- **WorkBuddy 国际版**：该账号 `active:false`，没有活动；
- **Qoder**：`/sash/api/v1/me/campaigns` 返回空，无活动可领。

### 新增：每日签到 / 领取

- `POST {endpoint}/v2/billing/meter/daily-checkin` 领取；额外头
  `X-Domain` / `X-Product: SaaS` / `X-Product-Code`；
- 响应码按上游语义映射：`0` 成功、`10001/1001` 今天已领、
  `1002` 无资格、`1003` 活动结束 —— 后两者算「无活动」而不是失败；
- **先查状态再领取**：只有「活动进行中且今天没签」才发写请求；
- **多账号一起签**：一个账号失败不影响其他账号；
- **自动跑**：启动时与每 10 分钟的定时任务里各试一次，内部按 `lastRunAt`
  做 20 小时节流，所以一天最多跑一次；
- **手动跑**：卡片「账号」分组里有「立即签到」按钮，只跑当前 provider；
- 领完自动刷新额度，数字立刻变。

### 界面

「账号」分组顶部多了一行签到状态：`今天已签到` / `本次签到成功：N 个账号，
+X 积分` / `当前账号没有签到活动` / `签到失败：…`，右侧还有「上次 …」时间。

### 测试

- `tests/checkin.test.mjs`（9 条）：状态与领取响应的全部码路径、非 JSON 兜底、
  「没给积分数就不编造」；
- `tests/client-credits.mjs` 增加：卡片有「立即签到」按钮，点了发
  `action=checkin` 且带 provider。

## 0.6.0 — 2026-10-17

### 新增：多账号

同一个 provider 现在可以挂多个账号。默认仍然是「一个账号」（WorkBuddy 读本机
登录、Qoder 用原来那个 PAT），所以升级后行为不变；额外账号是可选的。

- **Qoder**：可以加多个 PAT，各起名字；
- **WorkBuddy**：可以填多个登录文件路径（把另一台机器上的
  `workbuddy-desktop.info` 拷过来即可），第一个留空 = 读本机登录；
- 卡片里有「账号」分组：列出每个账号的额度、当前是哪个，可以「使用 / 删除」；
- **额度用完自动切换**：当前账号额度归零或上游标记超额时，自动切到下一个
  还有余额的账号，并把结果写回设置（重启后仍然生效）。开关在账号分组右上角。

设计上的几个取舍：

- **账号不是新 provider**。DSH 的模型选择器按 provider 分组，多开 provider 会让
  同一批模型出现好几组。所以账号只在内部切换，对外仍是 4 个 provider。
- **PAT 不回传浏览器**。状态文档里只有「是否已配置」，密钥始终只在本机
  `settings.json`。卡片保存账号列表时服务端按 id 合并旧密钥，不会因为
  「设为当前」这种操作把别的账号令牌抹掉。
- **切换判据是额度而不是报错**。等请求失败再切，用户已经白等一次；
  额度归零时提前切更顺。

### 关于「自动签到领积分」

**没有做，因为上游没有这个能力。** 我把两个 App 的 `app.asar` 都拆开扫过：

- **WorkBuddy**：业务代码里没有任何签到/领取相关接口（命中的全是内嵌的飞书 SDK
  与 MCP 库的噪音）；
- **Qoder**：只有 `getCampaignStatus` 这类**埋点名**，接口
  `/sash/api/v1/me/campaigns` 对本机账号返回 `{"claimable":false,"campaigns":[]}`，
  也没有可用的领取端点。

编一个假接口出来只会让按钮点了没反应，所以这一版把力气放在能真正跑通的
「多账号 + 自动切换」上。

### 测试

- `tests/accounts.test.mjs`（8 条）：隐式默认账号、去重、钉住账号、可用性、
  耗尽判定、切换目标挑选、id 生成、字段清洗；
- `tests/client-credits.mjs` 增加：账号分组渲染、点「使用」发出 activeAccount 补丁；
- `tests/credits-cache.test.mjs` 增加老格式（纯 provider 键）到
  `provider::账号` 的迁移用例。

## 0.5.3 — 2026-10-17

### 去掉「in-process」这个内部术语

那颗徽标来自 `status.proxy.mode`，意思是「反代跑在 DSH 宿主进程内，没有另起本地
HTTP 服务」。这是我实现方式的说明，对用户没有意义 —— 界面上冒出一个英文技术词，
只会让人怀疑是不是哪里没配好。

- 从工具条移除；
- 信息本身仍然保留在「诊断」的 JSON 里（`proxy: { mode, prefix }`），
  真需要排障时能看到。

## 0.5.2 — 2026-10-17

### 修复：展开箭头太小

0.5.1 用 `▾` 字符做展开箭头，字号 9px —— 在侧栏里几乎看不见，而且三角形状
随字体变化，Windows 上渲染出来就是一粒小点。

改成内联 SVG 折线：

- 14×14 画布、`stroke-width: 2`、圆头圆角，比同尺寸字形清晰得多；
- `stroke: currentColor`，颜色跟随胶囊文字，不用维护第二处色值；
- 不透明度 0.5 → 悬停/展开 0.9，展开后旋转 180°，过渡仍然走 `transform`。

### 测试

`tests/client-credits.mjs` 的箭头断言从「文本含 `▾`」改成结构性检查：
必须是 `svg`、宽高 ≥ 12、含 `path`、`strokeWidth ≥ 1.5`、`stroke` 为 `currentColor`。
这样以后谁换回小字符或漏掉描边，测试会直接拦下。

## 0.5.1 — 2026-10-17

### 修复：胶囊看不出「可以点」

0.4.7 把悬浮气泡换成内嵌面板时，顺手把悬停高亮也删掉了 —— 于是这枚胶囊
在视觉上和一块静态文本没有区别。旁边那条账号行悬停还会浮一层底色，
对比之下更显得它「不可点」。

补上三件事：

- **悬停底色**：复用宿主的 `--dsw-alias-bg-l2`，与账号行、会话行同一套视觉语言；
  同时描边加到 `border-l3`、加 1px 阴影，移开即恢复。
- **展开箭头**：胶囊右端常显一枚 `▾`；平时 45% 不透明度，悬停 / 展开时提到 85%，
  展开后旋转 180°。这是「点了会展开」最直接的暗示。
- **键盘可达**：`onFocus` / `onBlur` 走同一套高亮，Tab 到它时也有反馈。

### 测试

`tests/client-credits.mjs` 增加三条：

- 胶囊上必须有展开箭头；
- `mouseenter` 后底色要变成 `bg-l2`、描边要变 `border-l3`、阴影不能为空；
- `mouseleave` 之后必须恢复原样。

## 0.5.0 — 2026-10-17

### 设置卡片整体重排

之前那张卡片是「一列东西往下堆」：字号随手写（11 / 11.5 / 12 / 12.5 / 13 混用）、
分隔线有三种、按钮四种尺寸、同类信息（「已从上游拉取」「更新于」「上次检测」）
行高各不相同。功能都在，但没有层次，看久了累。

这次先把**排版规则**定下来，再照着排：

- **4px 栅格**：间距只用 4 / 6 / 8 / 10 / 14 / 16 / 18。
- **四档字号**：11.5（辅助）/ 12.5（正文）/ 13（强调）/ 16（标题）；
  行高固定 17 / 20 / 22。原来那堆 11.5 与 12 混排的说明文字全部归到 11.5。
- **三种按钮**：`buttonPrimary`（主操作，实心蓝）、`button`（次操作，描边）、
  `buttonGhost`（微操作，胶囊形小按钮）。尺寸各自唯一，不再每处现写。

### 结构

- **页头**：标题 + 右侧版本号；简介限制到 620px 行宽，避免一行拉太长。
- **工具条**：主「刷新」按钮 + `in-process` 标记 + 右对齐的「展开诊断」，
  把原来散在底部的诊断入口收到一眼能看到的位置。
- **账号总览**：一排带边框的小胶囊，`名称 + 数字`，余额低的直接标琥珀色。
- **标签页**：从下划线改成胶囊分段（圆角背景），选中态加粗；
  每个标签前面加一枚状态圆点（已登录绿 / 未登录琥珀），不用点进去也知道谁断了。
- **四个分组**：状态 / 积分 / 连接设置 / 模型，统一用一条极淡的上边线分隔，
  分组标题是小号、加字距的灰字（`状态`、`积分`、`连接设置`、`模型`）。
- **积分组**：数字放大到 23px 作视觉锚点，右边跟 `/ 总量 积分`、套餐、超额标记；
  下面一条 5px 进度条（低额度转琥珀），再下面才是到期时间与套餐明细。
  原来这些全挤在一行里。
- **连接设置**：路径输入改成「标签 + 输入框 + 说明」的竖排 field，说明紧贴输入框，
  不再和输入框隔着一行。
- **模型组**：标题右侧显示数量，搜索框、探测按钮、开关依次排开；
  模型列表套上边框与圆角，行与行之间用极淡分隔线，行高加到 21px，
  id 用等宽字体弱化显示。
- **诊断**：折叠按钮放在分组标题右侧（「展开 / 收起」+「复制」），
  展开后在下方显示格式化 JSON。

### 测试

`tests/client-credits.mjs` 的卡片用例加强：一次校验版本号、四个分组标题、
账号总览里的两家余额、以及模型列表确实渲染出了模型行。

## 0.4.8 — 2026-10-17

### 胶囊铺满侧栏底部宽度

收起状态下，组件直接返回按钮，而 `sidebar.footer.action` 的容器是**横向** flex，
按钮作为 flex item 会缩成内容宽度 —— 于是出现「展开时满宽、收起时窄一截」的割裂。

改法：

- 无论展开与否，都走同一层满宽容器（`width:100%` + 纵向 flex）；
- 胶囊本身改成 `width:100%` + `justify-content: space-between`，
  三个账号在整条底栏上均匀铺开；
- 侧栏收成 56px 轨道时仍用 `width:auto` + 居中，那个宽度铺开没意义。

### 测试

`tests/client-credits.mjs` 增加一条：收起时胶囊必须是 `width:'100%'`
且 `justify-content:'space-between'`。

## 0.4.7 — 2026-10-17

### 重做：积分改成侧栏内嵌面板（不再悬浮）

0.4.4 ～ 0.4.6 一直在跟「悬浮气泡」较劲：宽度靠 `getBoundingClientRect` 估算，
侧栏一窄就压到对话区。连续两版都只是把它往回收一点，本质是**结构选错了** ——
气泡挂在页面根作用域，天生不知道侧栏有多宽。

这次换成内嵌面板：

- 面板直接渲染在 `sidebar.footer.action` 的容器里。宿主的 CSS 是
  `._footArea{flex-direction:column;flex:none}` + `._footerActions{width:100%;min-width:0}`，
  所以面板 `width:100%` 就等于侧栏宽度 —— **结构上不可能横向溢出**，也不用再量任何东西。
- 点胶囊展开／收起；展开时面板在胶囊上方、向上生长，把会话列表往上挤而不是盖住它。
- 面板超过 `46vh` 时内部滚动，窗口再矮也不会顶出屏幕。
- 点面板外面或按 `Esc` 收起；`aria-expanded` / `aria-controls` 跟着状态走。
- 刷新按钮移进面板底部，旁边是「数据每 2 分钟自动刷新」/「上次结果，正在刷新…」。
- 侧栏收成 56px 轨道时点一下只刷新，不展开（那个宽度放不下内容）。

同时删掉了整套悬浮气泡机制：`shell.overlay` 注册、`pillHover` store、
延迟关闭计时器、宽度夹紧逻辑，一共约 480 行 —— 问题既然出在结构上，
就不该继续给它打补丁。

### 测试

`tests/client-hover.mjs` → `tests/client-credits.mjs`，验证的问题换成用户真正遇到的：

1. 卡片显示版本号；
2. 胶囊默认收起，只显示 `WB 675 · WBAI 99 · QDG 0`；
3. 余额 0 的账号亮警示色（675 / 99 不亮）；
4. 点胶囊展开面板；
5. **面板必须是 `width:100%` 且不是 `position:fixed`**（注入 fixed 会立刻失败）；
6. 面板里的刷新按钮真的发出 `POST /action`；
7. 再点一次收起。

```
node tests/client-credits.mjs          # 通过
BUG=1 node tests/client-credits.mjs    # 失败：面板用了 position:fixed
```

## 0.4.6 — 2026-10-17

### 修复：气泡越出侧栏盖到对话区

气泡宽度原先写死 `296px`。本机侧栏实测只有约 **289px** 宽，于是气泡直接压到右边
的对话区，看着像「飘到界面外面」。

改成先量侧栏再收敛：

- 从胶囊往上找一层有实际宽度的祖先（最多 4 层），拿到 `{left, right, width}`；
- 气泡宽度 = `min(300, 侧栏宽 - 16)`，本机就是 **273px**；
- 左边距夹在 `[侧栏左边+8, 侧栏右边-8-宽度]` 之间，宁可靠左也不越界；
- 量不到侧栏（比如没有 DOM 的近似环境）时退回视口约束。

### 测试

`tests/client-hover.mjs` 增加一条几何断言：在「侧栏 0–289」的夹具下，
气泡必须满足 `left >= 8` 且 `left + width <= 281`。当前实测 `left=8, width=273`。

## 0.4.5 — 2026-10-17

### 修复：气泡里的按钮够不到

气泡原先 `pointer-events: none`，而小卡在 `mouseleave` 时立刻关闭气泡。鼠标从胶囊
往气泡方向挪，必然先触发 `mouseleave` —— 气泡当场消失，里面那句「点击重新读取额度」
永远点不到。

三处一起改：

- **延迟关闭**：离开胶囊后等 160ms 再关（`schedulePillHide`），鼠标走进气泡
  时 `mouseenter` 取消这个计时；真正移开则照常关闭。
- **气泡可交互**：`pointerEvents: 'auto'`，并且真的放了一个「刷新额度」按钮，
  通过模块级 store 上挂的 `onRefresh` 调用小卡的刷新逻辑。
- **语义**：`role` 从 `tooltip` 改成 `dialog`（里面现在有可点的按钮，不再是纯提示）。
- 提示文案从「点击重新读取额度」改成「数据每 2 分钟自动刷新」—— 原来那句话
  容易被读成「这段文字可以点」，其实该点的是按钮。

### 修复：胶囊横向溢出侧栏

胶囊是 `display: inline-flex` + 左右各 11px 内边距，却没设 `box-sizing`。
默认 `content-box` 下 `maxWidth: 100%` 只约束内容宽度，加上内边距与边框后
总宽度超出容器，侧栏里就表现为**往左溢出去**。

改成 `boxSizing: 'border-box'` 并补 `minWidth: 0`，宽度从此把内边距算在内。

### 测试

`tests/client-hover.mjs` 增加四条，全部对应用户实际踩到的问题：

- 胶囊必须是 `border-box`（否则横向溢出）；
- 气泡必须可交互且带可点按钮；
- 离开胶囊后把鼠标移进气泡，气泡**不能**消失；
- 真正离开后必须自行关闭（不能一直挡着界面）。

## 0.4.4 — 2026-10-17

### 修复：积分要等十秒才出现

三个原因叠在一起，冷启动必然有一段空窗：

1. **额度刷新排在目录刷新之后** —— 明明互不依赖，却被 `refreshAll().then(...)` 串起来了，
   等于把两段网络延迟相加。
2. **额度快照只在内存里** —— 进程一起来就是空的，必须等网络请求回来才有数字。
3. **侧栏小卡只在挂载时取一次，然后等 60 秒** —— 如果首次取的时候宿主还没抓完，
   就只能干等下一轮。

分别改掉：

- **并行起步**：`Promise.allSettled([refreshAll(), refreshAllCredits()])`，两条路同时发车。
- **落盘 + 启动恢复**：新增 `lib/credits-cache.js`，成功的额度快照写到
  `<数据目录>/credits-cache.json`，启动时 `loadCreditsCache()` 直接灌进内存。
  这样第一帧就有上次的数字（标为 `stale`，界面弱化显示），后台再刷新成新值。
  只存成功快照；坏文件、缺字段、超过一周的缓存都安静忽略。
- **前 10 秒快速重试**：小卡在 0/0.6/1.4/2.6/4.2/7/10 秒各拉一次，拿到数字就切回
  60 秒常态轮询；12 秒兜底无论如何转常态。

实测：

```
[冷启动] 第一帧 0ms → 三个 provider 都是 none（无缓存时确实没数字）
[冷启动] 首轮抓取完成 1179ms
[有缓存] 第一帧 1ms → 675/1200、99/100、0（均 stale=true）
```

也就是说：**第一次装完之后，之后每次启动都是「瞬间有数、随后刷新」**。

### 附带：`stale` 的界面语义

- 胶囊里的数字用 60% 不透明度显示（「这是上次的数，正在刷新」）；
- 气泡底部提示改成「上次结果，正在刷新…」；
- 换成新值后自动恢复正常。

## 0.4.3 — 2026-10-17

### 字体整体调大

上一版在真实侧栏里偏小，尤其是 `WB 675` 那一行。这次分级调整：

| 位置 | 原 | 现 |
|---|---|---|
| 胶囊短名 | 9.5px | 11px |
| 胶囊数字 | 11px | 13px |
| 气泡标题 | 11px | 11.5px |
| 气泡账号名 | 11px | 12.5px |
| 气泡数值 | 12px | 13px |
| 气泡套餐/到期 | 10.5px | 11.5px |
| 卡片正文/按钮/输入框 | 12px | 12.5px |
| 卡片标题 | 14px | 15px |
| 模型行 | 12px | 12.5px |

配套：胶囊内边距 3×9 → 4×11、圆点 5px → 6px、气泡宽度 268 → 296、
进度条 3px → 4px、模型列表可视高度 260 → 280。

### 新增：设置卡片显示插件版本号

标题右侧一行 `v0.4.3`。版本从插件自己的 `package.json` 读（不写死），
所以发布时只改一处，卡片和诊断 JSON 都会跟着变。

顺带也是个排障信号：如果卡片上完全没有版本号，说明页面跑的是 0.4.2 之前的
客户端 bundle —— 那就不必再猜「为什么新功能没出现」。

### 改进：额度告警提前

原来只有余额归零才变警示色，等到那时候已经晚了。现在剩余低于 **15%** 也转琥珀色
（`isCreditsLow`）。675/1200（56%）和 99/100（99%）不会误报。

### 改进：刷新失败不再静默

点击胶囊刷新时如果请求失败，之前只是悄悄恢复原样，用户分不清「失败」和
「数字没变化」。现在描边闪红 1.6 秒再复原。

### 测试

- `tests/version.test.mjs`：断言 `pluginVersion` 与 `package.json` 一致。
- `tests/client-hover.mjs` 增加两条：卡片渲染出 `v<version>`；只有余额为 0
  的账号亮警示色（同时确认 675 / 99 没有误报）。
- 进度条识别改成「厚度 2–6px 且圆角 999」，避免调视觉尺寸时测试无故变红。

## 0.4.2 — 2026-10-17

### 紧急修复：悬停不再显示明细

0.4.1 的气泡组件把 `useState` 的**值**当成了 setter：

```js
var versionState = useState(0)
var setVersion = versionState[0]   // 取到的是值 0，不是 setter
var bump = setVersion[1]           // (0)[1] === undefined
```

于是悬停时订阅回调一执行就抛 `TypeError: bump is not a function`，
又被 `setPillHover` 里那层「不让订阅者把整个 UI 拖垮」的 `try/catch` 吞掉了 ——
表现就是**鼠标悬停毫无反应**，控制台里只有一行不起眼的报错。

改为直接取 setter：`var bump = React.useState(0)[1]`。

### 为什么 0.4.1 的冒烟测试没抓住

当时的测试只做了「模拟悬停 → 渲染气泡」，而那一刻 `visible` 已经是 `true`，
首次渲染就能出结果，**根本没走到订阅重渲染那条路径**。

新加的 `tests/client-hover.mjs` 按真实顺序来：

1. 先渲染一次气泡（`visible=false` → `null`），让订阅 effect 跑起来；
2. 再模拟 `mouseenter`；
3. 断言**气泡自己**收到了重渲染通知。

第 3 步比较的是「每个 hook 槽属于哪个组件挂载」——不能用全局的 dirty 标志，
因为悬停同时会点亮胶囊自己的 `setHovered`，会把气泡订阅坏掉这件事盖住
（第一版测试就是这么误判成通过的）。

这条测试自带 bug 注入模式，可以自证有效性：

```
node tests/client-hover.mjs          # 通过
BUG=1 node tests/client-hover.mjs    # 失败：悬停后气泡没有收到重渲染通知
```

`package.json` 增加 `npm run test`（单元）与 `npm run test:client`（组件）两条脚本，
`npm run verify` 跑全部。

## 0.4.1 — 2026-10-17

### 重做侧栏积分小卡的显示

0.4.0 的样式是「一行纯文本 + 浏览器原生 `title` 提示」，实际看下来有两处不行：
原生提示是一块没有样式的灰框、位置跟着光标乱飘，小卡本身也只是把三个数字串在一起，
扫一眼分不清哪个是哪个账号。

**小卡改成「分段胶囊」**：

- 每个账号一枚 5px 圆点（各自有强调色）+ 弱化的短名 + 加粗的数字；
- 数字用主文本色，短名用 9.5px 半透明——先看到钱，再看到是谁；
- 余额为 0 或已超额的账号，圆点与数字一起变琥珀色；
- 悬停时整枚胶囊轻微提亮、描边加深并投 1px 阴影，给出可点的反馈；
- 侧栏收起时只保留第一段，不再硬塞三段进 56px 轨道。

**原生提示换成宿主内自绘气泡**：

- 挂在 `shell.overlay`（页面级根作用域）而不是小卡内部 —— 侧栏收起时有
  `overflow: hidden` 与位移动画，`absolute` 会被裁掉、`fixed` 又会被祖先 transform
  改掉定位基准，只有根作用域稳。
- 每个账号一行：圆点 + 全名 + `剩余 / 总量`，下面一条 3px 的额度进度条；
  再下面一行小字给套餐名与到期时间。
- 贴着胶囊向上展开（侧栏在底部，向下会出屏），并按视口宽度左右夹紧。
- `pointer-events: none`，不会挡住点击；`role="tooltip"`，键盘聚焦也能触发。

实测渲染：

```
胶囊: WB 675 · QDG 0 · WBAI 99
气泡: WorkBuddy      675 / 1,200   套餐 · 到期 2026/11/6
      Qoder Global    0           Free · 到期 2026/11/16
      WorkBuddy AI   99 / 100      到期 2026/11/1
```

顺带修掉一个会被裁剪的问题：气泡的定位依赖 `getBoundingClientRect`，
拿不到（没有 DOM 的环境）时直接不渲染，不会在页面左上角糊一块。

## 0.4.0 — 2026-10-17

### 新增：侧栏积分常驻小卡

挂在宿主侧栏底部（`sidebar.footer.action`），不用打开设置就能看到各账号剩余：

```
WB 675 · QDG 0 · WBAI 99
```

- 收起侧栏时只显示第一项，避免挤爆 56px 轨道。
- 鼠标悬停给出完整明细（每个账号一行），点击立刻重读额度。
- 自带 60 秒轮询；与设置卡片的 20 秒轮询彼此独立 —— 服务端那侧现在零成本
  （凭证与额度都有缓存），没必要为此把两个组件耦合成共享 store。

### 新增：离线兜底目录（live → saved → builtin）

此前上游一次都没成功、本地又没有存档时，模型组会直接消失，看着像插件坏了。
现在第三级兜底用内置的一小组长期在架模型，卡片上标为「内置兜底列表」。

兜底清单故意小（每个 provider 2–4 个），名字用 id 本身，不编造展示名。

### 新增：卡片内模型搜索

模型一多（国内 18、国际 27）翻起来累。模型数超过 6 时出现搜索框，
按名字或 id 过滤，即时生效。

### 新增：全账号总览

卡片顶部一行汇总所有已登录账号的剩余额度，不用切标签就能对比。

### 打磨

- 侧栏小卡与设置卡片共用模块级的额度口径（`formatCreditsText` / `formatNumber`），
  避免两处对「读不到」与「0」的显示不一致。
- 卡片新增 `builtin` 目录来源的说明文案。

### 仓库

初始化 git 仓库并推送到
<https://github.com/PinBoDHua/dsh-reverse-proxy-connect>，补齐
`repository` / `homepage` / `bugs` / `LICENSE` / `.gitignore`。

## 0.3.0 — 2026-10-17

### 新增：各账号积分 / 额度

设置卡片里每个 provider 现在显示自己的账目，三家各按自己的口径算：

| provider | 上游 | 口径 |
|---|---|---|
| `workbuddy` | `POST codebuddy.cn/v2/billing/meter/get-user-resource` | 套餐包列表，周期额度优先 |
| `workbuddy-ai` | 同上（workbuddy.ai） | 同上 |
| `qoder` / `qoder-global` | `GET openapi/api/v2/quota/usage` + `/user/plan` + `/user/status` | 单一额度 + 套餐名 + 重置时间 |

实测：

```
[workbuddy]      675 / 1200 credits  最近到期 2026/11/3 15:33:01
[workbuddy-ai]   99 / 100 credits    最近到期 2026/10/31 23:59:59
[qoder-global]   0 credits  套餐 Free  [额度已用尽]  最近到期 2026/11/16 12:32:48
```

几个刻意的取舍：

- **周期额度优先**：套餐包同时有 `CycleCapacityRemain` 与 `CapacityRemain`，
  只看后者会把已过期周期里的一次性余额算成可用。
- **已耗尽的包不计入分母**：国内版有 5000 与 1000 两个早已耗尽的包，
  算进去会显示成「675 / 7700」，看着像额度快没了。
- **「读不到」不等于「0」**：额度读取失败时保留上一次成功值并标注错误，
  而不是把数字清成 0 —— 否则用户会以为额度被清零。
- **额度与目录分开取**：目录失败不影响额度，反之亦然。

### 新增：模型名后显示倍率

DSH 的模型选择器只渲染 `name`，所以倍率只有拼进名字才看得见：

```
GLM-5.3 · x0.79        Hy3 · 免费        Kimi-K3 · x1.62
```

倍率做归一化（`x0.79 credits` / `0.79` / `x0.79` 都收敛成 `x0.79`，`0` 显示为「免费」），
认不出的保持原名、绝不凭空补数字。设置卡片里可关掉。

### 新增：CLI `credits` 命令

```
node lib/bin.js credits [provider]
```

`status` 也会顺带打印每个 provider 的积分。

### 改进

- 额度缓存 2 分钟，卡片 20 秒轮询不会把上游打爆；「刷新积分」按钮强制绕过缓存。
- 状态文档升到 `version: 3`，每个 provider 新增 `credits`，`settings` 新增 `showRateInModelName`。
- 设置卡片：额度行 + 套餐名 + 到期时间 + 可展开的套餐包明细（含已耗尽标记）。

### 修复：状态轮询每次都在重启 WorkBuddy

卡片每 20 秒拉一次 `/status`，而状态里要显示登录情况 —— 原实现每次都重新
spawn 一次 App 的 Electron 取解密密钥。实测单次约 260ms，两个变体就是
**每 20 秒起两个 WorkBuddy 进程**，既费 CPU 又会跟真正的聊天请求抢资源。

现在两层缓存：

- at-rest 保护密钥按 exe 缓存在进程内（只在 App 重装/重新登录后才变）；
  万一真变了，解密失败会自动清缓存重取一次。
- 解析后的凭证按「文件 + mtime + size」缓存，App 重写登录文件时才失效。

实测凭证读取：**626ms → 0.05ms**；额度快照读取：0ms。

## 0.2.0 — 2026-10-17

### 修复：国内版模型清单少了一大半（10 → 18）

`/v3/config` 的返回**由 User-Agent 决定**。0.1.0 用的是纯 App 身份
（`WorkBuddy/5.5.6`），该身份的响应里**根本没有 `cli` agent**，只有 craft/ask/plan
等桌面端内部花名册；而解析器当时退到了 `agents[0]`，于是把一个 10 条的假清单当成了
真实可聊模型列表。

现在改用桌面端自己的复合身份（`WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.63.2`），
目录与聊天统一用它：

| 身份 | 结果 |
|---|---|
| 纯 App | 无 `cli` agent（旧行为在此误取） |
| 纯 CLI | 18 个，缺 `auto` |
| 桌面端复合 | **18 个 + `auto` = 19**，`models[]` 最全 |

并且**没有 `cli` 花名册时直接报错**，不再退到 `agents[0]` —— 悄悄给假目录是最难发现的错。

实测：国内版 18 个模型全部真发请求成功（`✓ 18 / ✗ 0`）。

### 修复：`auto` 被丢弃、`glm-5.1` 一律 400

- **`auto` 是虚拟 id**：在花名册里但不在 `models[]` 里，此前因查不到元数据被丢弃。
  实测它能正常聊天，现在按保守默认值（128K / 32K）保留。
- **隐含思考档位**：`glm-5.1` 的 `reasoning` 只有 `{effort:"medium"}`、没有
  `supportedEfforts`。这种模型**省略** `reasoning_effort` 会被判「不支持的思考强度」
  并 400，显式发 `medium` 反而正常。现在解析时把隐含档位收敛成唯一可选档位，
  聊天时自动补上；`hy3` 那种完全没有 `reasoning` 字段的模型不受影响。

### 新增：账号能力探测

花名册是**产品级**的，不是**账号级**的。国际版免费账号能列出 27 个模型，
其中 13 个（GPT / Grok / Gemini 全家）一聊就回「当前账号类型暂不支持该模型」。

- 后台逐个探测（每模型一次 `max_tokens: 1`，并发 4 路，27 个约 10 秒）。
- 结果写入 `unavailableModels`，从模型选择器隐藏；卡片里收在
  「N 个模型账号不支持」折叠区，**勾选可强制显示**（写 `forcedModels`）。
- 每 6 小时最多一次；卡片上有「检测账号可用模型」可手动重跑。
- 判据只认 **400 + 明确的档位文案**。429（单模型每日频率限制）、401/403、5xx、
  网络超时一律视为可用 —— 误判会藏起能用的模型，代价远大于多显示几个不能用的。
- 实测：国内版 18 个 **0 误判**；国际版 27 个准确挑出 13 个（与手动逐个验证一致）。

### 改进

- 状态文档升到 `version: 2`，新增 `probe`、每模型的 `unavailable` / `forced` / `virtual`。
- CLI 的 `ask` 不再把思考流刷到终端（默认折叠成字数，`ASK_SHOW_REASONING=1` 展开），
  避免与正文交错。
- 「全部关闭」只作用于账号本来可用的模型，不会把「不支持」的一并写进屏蔽列表。

## 0.1.0 — 2026-10-17

首个版本，面向 DeepSeek Harness **0.2.1-rc.1**。

### 四个 provider

- `workbuddy` — WorkBuddy 国内版（`copilot.tencent.com`）
- `workbuddy-ai` — WorkBuddy 国际版（`www.workbuddy.ai`）
- `qoder` — Qoder 国内版（`gateway.qoder.com.cn`）
- `qoder-global` — Qoder 全球版（`api3.qoder.sh`）

### 接入方式

- 直接实现 DSH 的 `LlmAdapter`，**不导入 `@earendil-works/pi-ai`**。
  该包是 DSH 的传递依赖（在 `app.asar` 内），插件自行声明会装出第二份副本；
  上游 `dsh-workbuddy-connect` 正因此让 pi-ai 0.87.1 与宿主的 1.1.0 并存。
- **不起回环 HTTP 服务**：上游请求直接从宿主进程发出，少一层本地 socket 与一个待守端口。
- 零 npm 依赖，只用 `node:` 内建。

### WorkBuddy

- 读取桌面端登录文件；支持 5.6+ 的 `{$wbEncrypted:1}` AES-256-GCM 信封。
- 解密密钥通过对应 App 自己的 Electron 二进制取得（`ELECTRON_RUN_AS_NODE=1` +
  `electron_browser_workbuddy_storage.loggerGet`），只在遇到加密字段时才触发。
- Windows 安装位置探测同时匹配 `DisplayName`，因此国内版与国际版可共存且不混淆。
- 请求体按上游要求修正：强制流式、`developer`→`system`、删掉 `reasoning_effort:"off"`、
  首条补 system、`tool_choice` 扁平化；补齐 `X-Conversation-*` 三件套。
- 支持 access/refresh token 自动刷新；刷新失败但旧 token 未过期时继续使用。

### Qoder

- PAT → job token → 用户身份，带进程内缓存与单飞。
- 实现 COSY 签名（AES-128-CBC + RSA PKCS#1 v1.5 + MD5，五个字段四个 `\n`、无尾随换行）
  与 WAF body 编码（base64 → 三分重排 → 自定义字母表）。
- 解析两层 SSE（外层 `{statusCodeValue, body}` 包内层 `chat.completion.chunk`）。
- 把排队（403 + `isQueued` + `10605`）与额度耗尽（`110`）从 HTTP 状态里**按 body 重新分类**，
  否则 DSH 会把限流当成认证失败而不再重试。
- 未吐出任何内容前遇到排队，会在本地按上游建议等待后重开（最多 4 次）。

### 设置与运维

- 四个 provider 共用一张设置卡片（`设置 → 插件设置`，与其它 connect 插件同一个区块），
  也出现在侧栏插件详情页。
- 卡片支持：登录状态、目录来源、逐 provider 开关、逐模型开关、Qoder PAT、
  WorkBuddy 路径覆盖、手动刷新、诊断 JSON 复制。
- 写接口要求进程内一次性密钥；读接口只接受回环 Host（含 DNS-rebinding 防护）。
- `lib/bin.js` 提供 `status` / `models` / `ask` 三个排障命令。
- `scripts/install.mjs` 默认 dry-run，落盘前备份并生成 `restore.ps1`。

### 已知限制

- 不支持 `GenerateOptions.stop`（两个上游都不保证 stop 语义），显式返回 `UNSUPPORTED_OPTION`。
- 未实现 `imageRequestPricing`，DSH 退回中性估算。
- Qoder 的思考档位不可关闭（上游 `canDisableThinking` 恒为 false），卡片不提供 `off`。
- WorkBuddy 国际版的目录按 App 身份拉取，与桌面端自身的选择器一致；若上游改分群规则会漂移。
