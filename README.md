# dsh-reverse-proxy-connect

把 **WorkBuddy**（国内版 / 国际版）、**Qoder**（全球版 / 国内版）与
**Trae**（国内版 / 国际版）账号里的模型接进 **DeepSeek Harness**。
一个插件、六个 provider、一张设置卡片、一套账号池。

> **2.1.0 修设置卡片的用量表截断**。旧汇总表用 `52px` 固定标签列，中文
> 「当前会话」被裁成「当…」。现在今日 / 累计 / 当前会话是并排的 KPI 卡片，
> 长标签不再省略；近 14 天固定 14 个槽位（只有一天数据时不再画成一根占满
> 整行的柱子），最近请求默认折叠，表格在窄窗口改为横向滚动。纯前端改动，
> 状态接口仍是 v8。
>
> **2.0.0 新增「事件账本」，并修掉一批会静默丢账号/丢统计/丢回答的问题**。
> 换号、令牌续期、目录/额度降级、签到与探测不再只写宿主日志，而是进入一张
> 可筛选、可清空、可导出的时间线（`events.json`，最多 100 条元数据）；
> `node lib/bin.js events` 与「复制诊断」也能看到。同时：settings.json 暂时
> 读不到时**拒绝写盘**，不再拿默认值把 PAT 与账号池覆盖；统计在两个进程
> 同时写入时按 max 合并，只读命令不再重写文件；Qoder 排队不再换号；空回答
> 报 `EMPTY_RESPONSE` 而不是记成成功。状态接口升到 **v8**。
>
> **1.8.0 修「读不到被显示成 0」**。额度有四种状态（读到了 / 有旧数字但这次读失败 /
> 没有额度端点 / 读失败），1.7.x 把它们混成了两种，于是没配 PAT 的 Qoder 与没有
> 额度端点的 Trae 国际版在诊断里写作「0 / 0 credits · 缓存」—— 那个 0 是占位值。
> 现在四种状态在卡片、侧栏、CLI、诊断里都分开显示；侧栏胶囊也只列出真正有数字的
> provider（见「读不到与真的是 0」）。同时把耗尽预估从「363476 分钟」改成
> 「252 天」，并把轻量状态的趋势点从 60 个裁到 20 个（侧栏每 60 秒轮询的那份
> 响应少了 5.4KB，画出来的折线看不出区别）。
>
> **1.7.0 新增 Trae 与 Trae Global 两家**。它们的凭证不是 PAT，也不像 WorkBuddy
> 那样有一个可以直接指定的登录文件：登录态藏在客户端 `storage.json` 的
> `tc` 加密信封里。插件解出它、按客户端自己的请求头调 `llm_utils_chat`，
> 并把事件流翻成与另外两家一致的形状 —— 顺带避开了「`GenerateTempToken`
> 换出来的令牌其实不能聊天」这个最容易踩的坑（详见 CHANGELOG）。
>
> **1.5.3** 修手动「立即签到」被正在跑的自动签到静默跳过（与 1.5.1 的探测同一类
> 问题），并把侧栏轮询的轻量状态瘦身：账号级额度/用量明细不再随每次轮询下发，
> 实测体积 −41%。

| provider id | 显示名 | 凭证来源 | 实测模型数量级 |
|---|---|---|---|
| `workbuddy` | WorkBuddy | 本机登录文件，或浏览器登录 | 18 |
| `workbuddy-ai` | WorkBuddy AI | 本机登录文件，或浏览器登录 | 27（本账号可用 14） |
| `qoder` | Qoder | 个人访问令牌（PAT，qoder.cn） | 视账号 |
| `qoder-global` | Qoder Global | 个人访问令牌（PAT，qoder.com） | 视账号 |
| `trae` | Trae | 本机 `storage.json`（`tc` 加密登录态） | 20 |
| `trae-global` | Trae Global | 本机 `storage.json`（同上，国际版目录） | 视账号 |

---

## 2.1.0 设置界面重排

用量区不再是一张五列小表，而是三张 KPI 卡片：

```text
今日                累计                当前会话
1,229 请求          1,229 请求          634 请求
成功率 100% ·       成功率 100% ·       成功率 100% ·
平均耗时 5s ·       平均耗时 5s ·       平均耗时 5.4s ·
tokens 400.3M       tokens 400.3M       tokens 200M
```

- 标签不再固定 52px，「当前会话」不会再变成「当…」；窄窗口自动降成一列；
- tokens 用 `K/M/B` 缩写，完整数字在悬停提示里；
- 近 14 天固定 14 个槽位（缺的日期是浅色空槽），只有一天数据时不会画成一根
  占满整行的柱子；底部标出起止日期；
- 最近请求默认折叠，模型用量 / 账号 × 模型保留表格但可横向滚动；
- 卡片内边距与分组间距略微收紧，顶部介绍缩成一句。

## 2.0.0 事件账本与可靠性

后台一直在做事，但以前只写宿主日志：令牌快到期自动续期、额度耗尽自动换号、
目录拉取失败退回磁盘缓存、签到失败 10 分钟后重试…… 出问题时用户只看到结果，
原因已经随日志轮转消失。

**事件账本**把这些元数据留下来：

```text
14:02:11  换号      账号「本机登录」请求失败（RATE_LIMIT），切换到「备用账号」
13:40:05  额度      额度读取失败（默认令牌）：HTTP 503
12:30:00  令牌续期  登录令牌已自动续期（本机登录）
09:00:02  签到      签到：2 个账号，本次领到 100 分
```

- 卡片底部「最近事件」可筛 **全部 / 换号 / 异常 / 凭证**，可展开 30 条、
  可一键清空；只清账本，不动账号与设置；
- `node lib/bin.js events --limit 50 --type credits`（加 `--json` 输出机器可读）；
- 「复制诊断」带最近 12 条，路径与令牌仍按既有规则脱敏；
- 只记类型/级别/provider/账号/一句人话/少量数字，**不记请求内容、不记令牌**；
  消息里的 `Bearer …`、JWT、`pt-…` 还会再兜底替换；
- 内存 200 条、磁盘 100 条，重复事件按时间窗去重。

同一个版本还修了三类「静默丢东西」：

1. **settings.json 暂时读不到时拒绝写盘**。旧实现把 EBUSY/EPERM 也当坏文件，
   30 秒后的自动签到 patch 会把默认值写回去 —— PAT 与账号池被无人值守地清空。
   现在区分「不存在 / 读不出来 / 确实是坏文件」；读不出来时只读运行并重试，
   坏文件先备份，备份失败则禁止写盘。
2. **统计不再互相覆盖**。宿主与 CLI（或两个窗口）同时写入时按字段 max 合并；
   只读命令不再重写 `stats.json`；不认识的更高版本拒绝写回。
3. **空回答不再算成功**。终态 `stop` 却没有任何正文/思考/工具时抛
   `EMPTY_RESPONSE`（宿主会重试）；200 的 HTML 登录页/JSON 网关错误直接报
   `MALFORMED_RESPONSE`；网络断开归为 `TRANSPORT`；`content_filter` 带
   `CONTENT_FILTER` 原因。

升级注意：状态接口升到 **v8**（新增 `events`），旧浏览器 bundle 会在卡片顶部
提示版本不一致；新增 `events.json`；空回答、Qoder 排队换号、forced 模型位置
等行为有变化，详见 CHANGELOG。

## 1.8.0 读不到就该说读不到

1.7.x 的额度只有两种显示：有数字，或者「0 / 0 credits · 缓存」。后者其实是把
**四种不同的事**压成了一句 —— 其中两种（「这个账号没有额度端点」「还没配凭证」）
根本没有数字，那个 0 只是 `emptyCredits()` 的占位值。

三条改动（完整状态表见「读不到与真的是 0」一节）：

1. **`creditsFor()` 只在「手里真有一个 `ok` 快照」时标 `stale`**，占位的空快照
   不再被伪装成「缓存的上次结果」。
2. **卡片、胶囊、CLI、诊断共用同一套状态文案**：`未读取（原因）` /
   `读取失败（原因）` / `… · 上次结果`。胶囊只列真正有数字的 provider，全部读不到
   时缩成一行淡入口。
3. **耗尽预估用人话时长**：`45m` / `3h 20m` / `252d`。以前直接打印
   `Math.round(ms / 60000)`，252 天会写成「预计可用 363476 分钟」。

顺带把轻量状态（`/status?light=1`，侧栏每 60 秒轮询一次）的趋势点从 60 个裁到
20 个：侧栏画的是 100×24 的迷你折线，形状看不出区别，而 6 家 × 60 个点占了整份
响应将近一半（实测省 5.4KB / 25KB）。完整状态仍然保留整段历史，卡片不受影响。

## 1.7.0 新增：Trae / Trae Global

### 为什么它比另外两家难接

Trae 的协议本身不复杂（事件流 + 一组请求头），难的是三处「看起来能用、
其实不能用」的地方：

1. **凭证是加密的**。`%APPDATA%\Trae CN\User\globalStorage\storage.json` 里的
   `iCubeAuthInfo://icube.cloudide` 是 `tc` 信封：
   `[6B 头][32B 随机数][密文]`，密文解出来是 `[64B SHA-512 校验][明文 JSON]`，
   密钥由「随机数 + 固定盐」两次 SHA-512 派生。解错一个字节就是乱码，
   界面上看起来像「未登录」。插件按上游两种信封头各用一组盐，**校验不过就
   明确报错**，绝不拿乱码当账号名。

2. **`GenerateTempToken` 换出来的令牌不能聊天**。这条最容易踩 —— 名字叫
   「换临时令牌」，看起来完全合理。但实测：

   | 令牌来源 | claims | `llm_utils_chat` |
   |---|---|---|
   | `storage.json` 里的 `token` | `source: "refresh_token"` | **200** |
   | `/cloudide/api/v3/trae/GenerateTempToken` | `type: "user"` | **401 `code 1001`** |

   所以插件**不做**临时令牌交换：那等于把能用的令牌换成不能用的。过期时用
   `refreshToken` 走 `ExchangeToken`，它返回的令牌与登录文件里同一形态。

3. **认证头是一组，不是一枚 token**。除了 `Authorization: Cloud-IDE-JWT …`，
   还要 `X-Cloudide-Token` / `X-Ide-Token` / `X-Uid` / `X-App-Id` /
   `X-Ide-Version(-Code)` / `X-Device-*` / `Request-Traffic-Type`。少任何一个
   都是 401「not able to authenticate you」—— 文案完全看不出缺了哪个。

### 用起来是什么样

- **不用粘贴任何令牌**：在 Trae 客户端里登录一次，插件直接读本机登录态。
  卡片里只有一个可选的 `storage.json` 路径（给便携版 / 非默认安装位置留口子）。
- **模型目录**：`/api/ide/v1/get_detail_param`（`model_list` 对 SOLO 客户端直接
  400）。实测本账号 46 条配置里筛出 **20 个可聊模型**，带展示名、上下文窗口、
  多模态与倍率；内部 agent（`browser_use_subagent`）与 `custom_model_*` 空槽位
  会被跳过，不会在选择器里出现一个点了就 400 的空行。
- **聊天**：`/api/agent/v3/llm_utils_chat` 的事件流（`event: output` +
  `{response, reasoning_content, tool_calls}`），正文 / 思考 / 工具调用 / usage
  都翻成与另外两家一致的事件。
- **工具调用**：Trae 要求 `parameters` 是**字符串**（上游是 Go 的
  `FunctionDefinition.parameters string`），传对象会 400。插件自动序列化；
  工具分片按 `index` 累积，且**首片等 `name` 到位再发**（与 1.4.0 给 WorkBuddy
  修的是同一类问题）。
- **图片输入**：多模态模型（Seed-2.1 系、Kimi、MiMo、Qwen 等）按 OpenAI 形状的
  `{type:'image_url', image_url:{url}}` 发送，实测能正常识别。
- **额度**：`/trae/api/v2/pay/ide_user_ent_usage`，按「总额 − 已消耗」算，
  不用上游那个带四舍五入的 `consumption_ratio`。总额为 0 时按 Free 处理，
  不标「已用尽」。
- **签到**：`/trae/api/v2/ug/checkin_credits/{status,claim}`，每天 100 + 额外奖励。
- **国际版**：同一个 `tc` 格式、同一个 `storage.json` 结构，只有端点不同
  （`api.trae.ai` + `a0ai-api-sg.byteintlapi.com`）。国际版**没有**额度查询与
  签到端点（404），插件会明确写「请在 Trae 客户端里查看额度」而不是编一个数字。

### 升级前请确认

1. 状态文档升到 **v7**：新增 `providers[]` 里的 `trae` / `trae-global` 与
   `settings.trae`。按 v6 硬编码的第三方消费者需要同步。
2. `settings.json` 新增 `trae` 字段，旧文件自动补齐，不需要迁移。
3. `credentialKind` 多了一个取值 `desktop-auth`（Trae 专用）。按 `desktop` /
   `pat` 二值判断的外部脚本需要把第三类也算进去。
4. 注册的 provider 从 4 个变成 6 个：模型选择器里会多出 `Trae` 与
   `Trae Global` 两组，可以在卡片里单独关掉。

## 1.5.3 新增与修复

### 手动「立即签到」不再被自动签到吞掉

`runCheckin()` 原来的并发保护是 `if (checkinRunning) return []`。定时器每 30 秒
会尝试一次自动签到，用户这时点「立即签到」，`force` 请求仍然直接返回空数组，
随后照样刷新额度、返回 200 —— 界面看起来执行了，其实一次都没跑。

现在与目录/额度/探测刷新一致：自动调度跳过，**`force` 请求等前一轮结束后补跑**。

### 侧栏轮询瘦身 41%

`/status?light=1` 只服务于侧栏小卡，它读账号只用 `label` 与 `active`，但响应里
还带着每个账号的 `credits`（含 50+ 个趋势点）、`usage`、`cooldownUntil`、`lastTest`。
现在轻量状态只保留 `{id, label, enabled, kind, active}`；完整 `/status` 不变。

真实数据副本 A/B：轻量 **26,084 B → 15,257 B**，完整 52,919 B 不变。

## 1.5.2 新增与修复

### 连点模型开关不再互相覆盖

`toggleModel()` 每次回传完整的 `disabledModels`，而这份列表来自上一次 `/status`。
两次点击之间第一个请求还没回来时，第二次仍从旧 status 出发：

```
关闭 m1 → { disabledModels: ["m1"] }
关闭 m2 → { disabledModels: ["m2"] }   ← m1 没了
```

界面上表现为「勾了又自己弹回去」。加上响应序号也救不了 —— 两次补丁的内容本身
就都是错的。现在客户端维护一份「本轮用户改过的模型」（`pendingModelToggles`），
补丁与复选框状态都以「服务端现状 + 本地改动」为准；写失败会清空这份猜测。

「全部关闭」同理：之后单独开一个模型不会再丢掉整批改动。

## 1.5.1 新增与修复

### 保活帧不再阻止排队重开

`retryQueued()` 用「这一轮有没有事件产出」判断能否无损重开。1.5.0 引入的内部
`heartbeat` 被同一个 `emitted = true` 误置位（心跳既不是内容、也不会转给调用方），
于是「上游先发几帧保活、随后以 `isQueued` 拒绝」会直接失败、不再按建议等几秒重开 ——
免费模型在高峰期恰好最需要重开。现在只有非心跳事件才算已输出内容。

### 手动探测不再被后台探测吞掉

`runProbe()` 原来是 `if (probeRunning) return`：启动 6 秒后就会有一轮后台探测，
用户此时点「检测账号可用模型」会**什么都不发生**（界面不刷新、时间不变、没有提示）。
现在与目录/额度刷新同一套并发语义：普通定时触发跳过，`force` 请求等前一轮结束后补跑。

## 1.5.0 新增与修复

### 保活帧不再让空闲超时误杀长思考

空闲超时的语义是「多久没收到任何数据就认定卡死」，但两个 SSE 解析器会**静默跳过**
没有内容产出的帧：`: keep-alive` 注释、空 `data:` 行、只带 `finish_reason` 的帧、
只带 `usage` 的帧。上游在长思考/排队时正是用这些帧保活 —— 连接活着、字节一直在流动，
本地却在 180 秒后把请求 abort 掉。

现在解析器在「这一批字节没有产出内容事件」时 yield 一个内部 `{type:'heartbeat'}`，
`withIdleTimeout()` 见到心跳会重置计时器**但不转发**（心跳不进适配器、不进统计）。
一个字节都不来的真正卡死仍然照常超时。

### `withTimeout()`：外部取消与单请求超时取并集

```js
// 之前：调用方传了 signal 就永远不会有超时
signal: signal ?? AbortSignal.timeout(20_000)
// 现在：两者都生效
signal: withTimeout(signal, 20_000)
```

全仓 10 处同一写法已统一。这一条在线上表现为「签到中」永远不结束、
额度卡片永远停在「读取中」、登录卡在「读取账号信息」。

### 其余

- 额度缓存的顶层数字/布尔/字符串按类型收敛，坏值不再让卡片显示 NaN；
- Qoder 的 429 在 body 没有 `retryAfterSeconds` 时读 `Retry-After` 头。

## 1.4.0 新增与修复

### 工具调用的首片等到 `name` 到位再发

OpenAI 兼容上游给 `tool_calls` 分片时，`id`、`name`、`arguments` 谁先到没有保证，
常见顺序是「先给一段 `arguments`，下一片才补 `name`」。宿主按 `id + name` 认工具块：
`name` 为空的那一片会被当成普通 chunk，补到 `name` 时又另起一段 —— 一次正常的工具
调用就被拆成两截，前面那段参数直接丢掉。

现在适配器把「首片」压在手里，等 `name` 到位再一次性吐出（先到的参数一起带上）；
`name` 永远不到（残缺响应）时，在终态/中断前也会兜底补一片，保证 `block-end` 找得到
对应的开始。首片之后的空分片不再发给宿主。

### 断流时的 usage 合计补上缓存 token

正常终态的 `totalTokens` 一直是 input + output + cacheRead + cacheWrite，但「上游没给
终态就断流」那条分支只加了 input + output。DeepSeek 系上游的 `inputTokens` 已经把
缓存命中量扣掉，漏掉 cache 会让断流那几次请求的「今日 token」凭空少一大截。

### 宿主运行期间的 `stats-reset` 不再被旧快照覆盖

以前只有设置文件做了跨进程先读后写。`stats.json` 是「进程内快照 + 定期全量落盘」，
所以在 DSH 开着的时候执行 `node lib/bin.js stats-reset`，宿主的下一次去抖 flush 会把
旧数字整份写回去 —— 用户点了「重置统计」，一分钟后数字自己回来了。

现在 `flush()` 前会先比对磁盘的 mtime/size；只有「磁盘上的 `since` 比内存里的新」
（也就是另一个进程刚做过重置）才采纳磁盘那份。正常写入不会改 `since`，所以自有
写入不会被误判成重置。

### 能力探测的结论按账号生效

花名册是产品级的，能不能用是账号级的：免费账号看不到付费模型，企业账号又可能多一批。
1.3.x 把探测结论按 provider 存，切到另一个账号后仍按旧结论隐藏 —— 表现是「明明能用
却从选择器里消失了」。现在探测结果里记下 `accountId`，只有「当前账号 == 探测账号」
时才应用 `unavailable`；老设置没有这个字段时保留旧行为，不会因为升级突然多出一堆
用不了的模型。

### 客户端最后几处硬编码中文改走 locale

套餐包兜底名（`额度包`）与热力图格子的悬停提示（`N 次 · N tok`）以前是写死在渲染
代码里的，英文界面下会混出中文。现在分别走 `creditsPackageFallback` 与
`usageHeatCell`，两份字典 key 完全对齐（209 ↔ 209）。

### 坏数据不再把整张卡片打崩

状态文档里的字段源头可能是上一版写下的磁盘缓存、被手改过的 JSON，或者旧宿主缺字段。
客户端原先的兜底只挡住了「不是数组」，挡不住「数组里混了 `null`」与「`credits` 是
null」：一个坏行就会让宿主的 `SlotErrorBoundary` 把整个插件设置区块换成一条错误。
现在统一走 `safeArray()`（只保留对象元素），并对 `credits` 的 `null` 单独判空；
`tests/client-credits.mjs` 里有一条「null / 错类型 / 缺字段混在一起仍能渲染」的用例。

### 清理

- 删掉从未被使用的 `PROXY_PREFIX`（「不起回环服务」之后就没有本地反代前缀了）与
  `CREDENTIAL_POLL_MS`；
- 写接口的请求体上限从 `readBody()` 里的魔法数字提成 `REQUEST_BODY_LIMIT`
  （1 MB：20 个账号 × 几千字的 PAT 也够用）。

## 1.3.0 新增与修复

### Qoder Free 的 0 在所有位置都按 Free 处理

`fetchQoderCredits()` 现在会写 `freePlan: true`，服务端与客户端共用同一套
判定（老缓存仍可看 `planName` / `paid` 兜底）：

- 卡片数字、账号总览、侧栏圆点/进度条不再亮琥珀色；
- 自动换号不会为了 Free 的 0 切到付费账号；
- CLI 与诊断文本显示「Free 套餐：付费额度为 0，免费模型仍可用」；
- 付费套餐的 0 仍然是「额度已用尽」。

### 流式终态与统计

- **Qoder usage 不再丢**：`finish_reason` 只记终态，`[DONE]`/EOF 才发 finish；
- **取消不再伪装成功**：两个 SSE 解析器 abort 时抛 `CancelledError`；
- **中途失败会关块**：适配器在失败前补齐文本/工具块的 `block-end`；
- **统计 kind 正确**：`stop` / `tool-calls` / `max-tokens` / `error` 与最近失败原因
  都会进 `stats.json`；
- **末行无换行也处理**：EOF 时 flush decoder 并解析尾包；
- **坏 JSON 帧明确报错**：不再静默丢一段后仍报 `stop`。

### 并行工具里的图片顺序

一次 assistant 发起多个 tool_call、且非最后一个 tool 结果带图时，图片会等
**所有**连续 tool 消息发完才提升成一条 user 消息，不再插在 tool1 与 tool2
之间破坏配对。

### 多账号与凭证

- Qoder PAT 失效显式归为 `AUTH`，坏 PAT 会换号并按 2 分钟冷却；
- Qoder 普通 429/402 按 `RATE_LIMIT` / `QUOTA` 处理；
- 凭证续期按账号单飞，只有 token 真变化才写回，避免并发旧值覆盖新值；
- `isAccountUsable()` 按桌面/PAT 分开判断，不再把空 PAT 的 Qoder 账号选成
  换号候选；
- 浏览器登录取消后不会再写入账号；`authUrl` 只接受 https；
- 插件卸载会取消进行中的登录与签到。

### 设置与数据更安全

- 读设置兼容 UTF-8 BOM / UTF-16LE/BE；
- 坏文件先备份成 `settings.json.corrupt-<时间戳>`，状态/诊断显示错误与备份路径；
- 原子写在 Windows 的 EPERM/EBUSY 会有限重试；写失败会抛错并回滚内存值，
  `POST /settings` 返回 500；
- patch 前检查磁盘 mtime/size，宿主与 CLI 同时改设置时先重读再合并。

### 统计与界面

- `stats.json` 升到 v3：`providerDaily` / `providerSessions`，热力图与「当前会话」
  不再跨 provider 串台；
- 午夜后没有新请求，`/status` 的「今日」也会归零；
- 额度历史按本地整点分桶，非整小时时区不再把午夜消耗记到昨天；
- 高级里新增「启用额度预警」「自动检测账号可用模型」两个开关；
- 诊断面板与复制诊断都会脱敏控制密钥、用户目录与登录 state；
- 所有 fetch 有超时；登录轮询可取消；高级设置保存后用服务端夹取值回填；
- PAT 保存只回传当前账号一行，不会用旧快照复活已删账号；
- 账号/PAT 草稿按 provider 隔离，保存成功才清空；
- 模型复选框、provider 标签、诊断按钮补了 aria 属性；共享设置区块标题走
  locale。

### 行为变更

1. 状态文档升到 **v6**（`storage`、`credits.freePlan`、
   `stats.providerDaily` / `providerCurrentSession`、`checkin.accountIds`）。
2. `stats.json` 升到 **v3**，v1/v2 自动迁移；更早的按 provider 每日历史无法反推。
3. 设置文件仍是 v2，没有新增必填字段；坏文件会先备份。
4. Qoder Free 的 0 不再触发自动换号；付费套餐的 0 仍然会。
5. 签到按「provider + 启用账号集合」判断，当天新增账号会补签一次。

---

## 1.2.0 新增与修复

### Qoder 排队等待可配置

「高级」里新增 `Qoder 排队等待上限（秒）`，默认 60，范围 15–180：

- 首包阶段仍受 60 秒连接死线约束；
- 流中排队按该上限累计重开，不再固定 4 次；
- 调到 180 秒可以覆盖 Qoder 常见的 4–6 轮 30 秒排队；
- 超时仍然是 `RATE_LIMIT`，文案写明实际等待秒数与上限。

### Qoder Free 的额度语义

`userQuota.total=0` + `isQuotaExceeded=true` 只表示**付费额度为 0**，不代表
免费模型不可用。现在 Qoder Free：

- 不再触发顶部「额度已用尽」横幅；
- 卡片/侧栏显示 **「免费模型排队」**；
- 保留「Free 套餐的付费额度为 0；免费模型不扣积分但会排队」说明。

真正低额度账号（例如 WorkBuddy 剩余 5%）仍会正常触发橙色预警。

### Qoder 0 token 说明

上游没有返回 token usage 时，用量表下会提示「这里显示 0 不代表没有消耗」。

---

## 1.1.0 新增与修复

### 额度趋势与耗尽预测

每次成功读取额度都会记一个样本（`credits-history.json`，每个 `provider::账号`
最多 60 个原始点 + 168 个小时桶）。卡片与侧栏因此能显示：

- 今日消耗 / 近 7 天消耗（逐段累加下降量，充值不会被算成负消耗）；
- 最近约 6 小时的消耗速度（至少 10 分钟样本才给结论）；
- 按该速度还能用多久（超过一年不显示）。

### 额度预警与提前换号

- `alerts.lowRatio`（默认 15%）：低于比例时卡片顶部出现预警横幅，侧栏数字转琥珀色；
- `autoSwitch.thresholdRatio`（默认 0）：大于 0 时低于比例就切到另一个同样高于
  阈值的账号；两个阈值都在「高级」里改。

### 429 限流也换号

1.0.x 只对 `AUTH` / `QUOTA` 换号，WorkBuddy 的每日频率限制与 Qoder 的高峰排队
（429）会直接失败。现在 `RATE_LIMIT` 也会在**还没输出内容**时换下一个账号；
上游给了 `Retry-After`（秒数或 HTTP 日期）就按它设置冷却，最多 10 分钟。
单账号时保留原始 429 错误，不伪造成功。

### 用量历史、当前会话与模型榜

`stats.json` v2（v1 自动迁移）：

- 每日历史保留 30 天，卡片显示最近 14 天柱状图；
- 当前会话单独计数，用量表多一行；
- 按请求数排序的前 5 个模型，带 tokens 与平均耗时；
- 最近请求也带 `sessionId`。

### 账号测试与冷却

每个账号一行「测试」：真发一次 1-token 请求走完整凭证/目录/上游链路，
显示 `✓ 正常 120ms` 或失败原因；冷却中的账号显示截止时间，可一键解除。
测试使用该账号自己的目录，且不计入用量统计。

### 脱敏诊断

新增 `GET /plugins/dsh-reverse-proxy-connect/diagnostics`：不含控制密钥，
令牌字段一律 `[redacted]`，路径缩成 `%LOCALAPPDATA%` / `%APPDATA%` / `~`。
「复制诊断」复制的是这份纯文本，不再是整份 `/status`。

### 1.0.6 遗留问题的修复

- **SSE usage 在 finish 之后会丢**：现在先记终态，收到 `[DONE]` 或流结束才发 finish；
- **签到异常每 30 秒重撞上游**：异常也写 `lastAttemptAt`，按 10 分钟退避；
- **额度刷新重复请求**：按 provider 合并 in-flight，force 刷新在当前轮后补跑；
- **探测/签到重叠执行**：两者都有互斥保护；
- **诊断泄露控制密钥**、**`showUsageInSidebar` 是死设置**：都已修复。

### 行为变更

1. 状态文档升到 **v5**（`credits.trend`、`settings.alerts`、
   `settings.autoSwitch` 变成 `{enabled, thresholdRatio}`、`accounts[].cooldownUntil` /
   `lastTest`、`stats.daily` / `currentSession`）。
2. `settings.json` 新增 `alerts` 与 `autoSwitch.thresholdRatio`，旧文件自动补齐。
3. 新增 `credits-history.json`；`stats.json` 升到 v2。删除它们只丢历史，不影响聊天。
4. 多账号遇到 429 现在会换号，单账号行为不变。

---

## 1.0.0 新增与修复

### 修复：浏览器登录的账号现在真的能聊天

0.9.0 的「浏览器登录」只把令牌写进了账号，但目录与聊天仍然走
`readDesktopCredential()` —— 也就是去找本机桌面端的登录文件。于是登录成功、
卡片显示已登录、额度也能读，**但一发消息就报「没有找到登录文件」**。

1.0.0 把凭证解析收敛成**唯一入口** `credentialForAccount()`，目录、聊天、额度、
签到四处共用：

```text
账号.token（浏览器登录）  →  否则本机登录文件  →  需要时续期  →  写回
```

### 新增：图片输入

宿主（DSH 0.2.1-rc.2）会把图片以 `ImageBlock` + 持久引用交给适配器。插件现在通过
`ctx.attachments.readImageRequest()` 把引用读成请求版本，再以 data URL 发给视觉模型：

- 请求预算：约 4M 像素 / 4MB 字节，按宽高比缩放，不放大；
- 图片旁带一段说明文本（附件 id、请求尺寸、可读的只读路径），与 DSH 自己的措辞一致；
- **tool 结果里的图片**会提升成紧随其后的一条 user 消息 —— OpenAI 形状的 tool 消息
  只接受文本，硬塞图片会被上游 400；
- 宿主没有挂载附件服务时，模型只声明 `inputModalities: ['text']`，宿主会把图换成
  文本占位符。**任何情况下都不会静默丢图**。

### 新增：用量统计与健康状态

每次请求结束都会记一条统计（provider / 账号 / 模型 / 结果 / token / 耗时），落盘到
`stats.json`：

- 「今日」与「累计」分开；日切按本机时区；
- 成功、失败、取消、中断分开计数；
- 连续失败会算出 `ok / degraded / down` 健康状态，卡片上用圆点与文案显示；
- 最近 40 条请求可查，失败带稳定错误码（`AUTH` / `QUOTA` / `RATE_LIMIT` / …）；
- 设置卡片里可「重置统计」，也可以在高级设置里整体关掉；
- 统计**不记录任何请求内容**。

### 新增：请求级自动换号

额度刷新时的「用完再切」只能防患于未然。1.0.0 增加了请求级救援：

- 请求因为 `AUTH` / `QUOTA` / `RATE_LIMIT` 失败，且**还没吐出任何内容**时，自动换下一个账号重开；
- 换号成功后写回 `activeAccount`，下一次请求直接用新账号；
- 刚失败的账号进入冷却（认证/额度 2 分钟、限流 30 秒或按 `Retry-After`、服务端 15 秒），不会被反复选中；
- 已经吐过内容之后失败**不换号**，交给 DSH 的重试执行器，避免重复输出。

### 新增：真正的空闲超时

旧实现把 `AbortSignal.timeout(300_000)` 当整条流的总超时 —— 一个持续 5 分钟以上的
正常长回答会被直接切断。现在超时分成两层：

| 阶段 | 默认 | 行为 |
|---|---|---|
| 打开连接（等响应头） | 60 秒 | 超时即失败，不重试 |
| 流已建立后的**空闲** | 180 秒 | 只有连续 180 秒没有事件才 abort；持续出字永远不打断 |

两个值都可以在「高级」里改。

### 新增：模型目录磁盘缓存

目录以前只在内存里。重启时上游不可达，选择器就退化到每边 4 个的内置兜底清单。
现在最后一份**成功**目录按 `provider::账号` 落盘（30 天有效期），重启第一帧就是完整
清单，卡片来源显示「已缓存（启动时恢复）」。内置兜底清单**不会**被当成缓存写盘，
所以「缓存」和「兜底」永远不会混。

### 新增：轻量状态接口

侧栏小卡每 60 秒轮询一次。以前拿的是整份 `/status`（含所有模型清单，几十 KB）。
现在小卡走 `GET /status?light=1`：只有额度、账号、健康与今日用量，体量降到几 KB。

### 新增：高级设置

以前写死在代码里的参数现在可以调：

- 流空闲超时；
- 目录刷新间隔、额度刷新间隔；
- 是否记录用量统计；
- 是否把目录缓存到磁盘。

所有数字都会被夹到安全区间（例如空闲超时 15 秒 – 15 分钟），手改错不会把插件弄坏。

### 修复与打磨（完整列表见 CHANGELOG）

- Qoder「首包就排队」以前不会本地重试，现在按上游建议等一次再重开；
- 有账号池时，Qoder 的 PAT 保存/清除以前写的是被忽略的旧字段，现在写进当前账号；
- `refresh_token` 续期后的凭证没有更新内存缓存，导致每个请求都续期一次 —— 已修；
- WorkBuddy 两个变体共用一份 UA 版本号缓存，第二个变体会带错身份请求目录 —— 已修；
- 设置、额度、目录、统计四份 JSON 全部改成原子写（临时文件 + rename，0600）；
- 被关闭的 provider 不再每 20 秒做凭证探测（桌面端探测可能起子进程）；
- 上游请求追加 `x-dsh-attribution` 头，标明流量来自 DSH 插件（见「兼容性」）。

---

## 它做了什么

六个 provider 共享一份运行时：

- **不起本地回环 HTTP 服务**：上游请求直接从宿主进程发出，少一层 socket、少一个端口；
- **不导入 pi-ai**：直接实现 DSH 公开的 `LlmAdapter`，不会出现插件自带 pi-ai 与宿主
  版本并存的词表错配；
- **只依赖 `node:` 内建模块**，没有任何 npm 运行时依赖；
- 一条适配器、一份目录缓存、一张卡片、一套账号池。

## 为什么是「反代」而不是「直连」

两家的上游都不是公开 API：

- **WorkBuddy** 的 `POST /v2/chat/completions` 是 OpenAI 形状，但它要求浏览器身份头
  （`X-IDE-*`、`X-Conversation-*`）、不接受 `role:"developer"`、不接受非流式、
  不接受 `reasoning_effort:"off"`。插件把这些修好，再把 SSE 翻译成 DSH 的 chunk。
- **Qoder** 完全没有 OpenAI 兼容端点：请求要重新封装成它自己的 envelope，body 还要经
  WAF 编码（base64 → 三分重排 → 自定义字母表），签名用 COSY（AES-128-CBC + RSA + MD5），
  响应是「外层 SSE 包着内层 SSE」两层结构。

所以插件在进程内做翻译，把两家的流归一化成同一组事件，再交给 DSH。

## 和上游两个社区插件的区别

`dsh-workbuddy-connect` 和 `dsh-qoder-connect` 各做一个插件、各起一个 `127.0.0.1`
回环服务、各自 `import "@earendil-works/pi-ai"`。本插件：

- **不导入 pi-ai**。pi-ai 是 DSH 的传递依赖（在 `app.asar` 里），profile 的
  `node_modules` 顶层没有它；插件自己声明它就会装出第二份副本。本插件直接实现
  DSH 公开的 `LlmAdapter`。
- **不起回环 HTTP 服务**，少一层本地 socket、少一个需要守的端口。
- **六个 provider 共享一份运行时**：一个适配器实例、一份目录缓存、一张卡片。

---

## 安装 / 升级

```powershell
# 预览（默认不写盘）
node scripts/install.mjs

# 安装或升级（可加 --profile <dir> 指定非默认 profile）
node scripts/install.mjs --apply

# 卸载
node scripts/install.mjs --apply --uninstall
```

脚本会复制插件到 profile 的 `node_modules`，并把包名写进 profile `package.json` 的
`dependencies` 与 `dsh.profile.bundles`；落盘前先备份到
`<DSH_HOME>/dsh-reverse-proxy-connect-backup-<时间戳>/`（含旧插件目录），并附一份
`restore.ps1`。安装先复制到临时目录再换名，复制或写清单失败会自动恢复上一版，
不会留下「清单还在、目录已空」的状态；`.env`、日志与 `_` 开头的本地草稿不会
被复制进 profile。

装完**完全退出并重启 DeepSeek Harness**（宿主半边需要重新加载），再刷新页面。

从 0.9.x 升级不需要迁移设置：`settings.json` 会在读入时自动补成 v2（新增 `advanced`
与展示偏好，旧字段原样保留）。

## 使用

### WorkBuddy 两个版本

两种凭证来源都支持：

1. **浏览器登录**（推荐）：设置卡片里点「浏览器登录新增账号」。插件申请
   `state + authUrl` → 用系统浏览器打开 WorkBuddy 官方登录页 → 轮询换取令牌 →
   读回昵称与 uid → 写进账号池并设为当前。全程不需要安装或打开桌面 App。
2. **本机桌面端登录文件**：

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info
```

5.6 之后这两个文件里的 token 是加密信封（AES-256-GCM）。解密密钥只能从应用自身拿：
用它的 Electron 二进制以 `ELECTRON_RUN_AS_NODE=1` 跑一句
`process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()`。
所以插件会在必要时**短暂启动一次对应 App 的可执行文件**（无窗口、约 1 秒）；老版本
写明文 token 的文件完全不会触发子进程。

App 的位置按这个顺序找：设置里手填的路径 → 环境变量
`WORKBUDDY_ELECTRON_BIN` / `WORKBUDDY_AI_ELECTRON_BIN` → 默认安装路径 →
Windows「添加/删除程序」注册表（同时读 `DisplayName`，所以两个版本装在同一台机器上
也能区分）。绑定关系是严格的：拿国内版的登录去配 `workbuddy-ai` 会被拒绝并说明原因。

### Qoder 两个版本

在设置卡片里粘贴 PAT：

- 国内版：<https://qoder.cn/account/integrations>
- 国际版：<https://qoder.com/account/integrations>

保存时会先真的换一次 job token 与读一次用户信息来验证，通过了才落盘。
也支持环境变量 `QODER_CN_PERSONAL_ACCESS_TOKEN` / `QODER_PERSONAL_ACCESS_TOKEN`
（只对隐式默认账号生效，不猜用户手动添加的账号）。

Qoder 免费额度在高峰期会排队（上游把排队回成 403/429 + `isQueued` +
`retryAfterSeconds`）。插件**首包与流中**都会按上游建议在本地等一次再重开；
只要还没吐过一个字节，重试就是无损的。

排队等待有明确预算：**首包 45 秒、流中默认 60 秒**；流中预算可在「高级」里
调到 15–180 秒。超过预算不再无限重开，而是直接报一条 `RATE_LIMIT`：

```text
Qoder 免费模型正在排队（已等待 60 秒，超过本地 60 秒上限）。
这不是令牌失效或模型下线；请稍后重试，避开高峰期。
```

Qoder Free 的 `userQuota.total` 本来就是 0，上游也会回 `isQuotaExceeded=true`；
`qfmodel`（Qwen3.8-Flash）是 `x0` 免费模型，仍可用，只是高峰期排队。
卡片会明确写出「付费额度为 0；免费模型不扣积分但会排队」，避免把它误解成
「免费模型坏了」。

### Trae 两个版本

**不需要粘贴任何令牌。** 在 Trae 客户端里登录一次就够了，插件直接读本机登录态：

```
%APPDATA%\Trae CN\User\globalStorage\storage.json     # 国内版
%APPDATA%\Trae\User\globalStorage\storage.json        # 国际版
```

这个文件里 `iCubeAuthInfo://icube.cloudide` 的值是 `tc` 加密信封（AES-128-CBC +
SHA-512 校验，密钥由「随机数 + 固定盐」派生）。插件解出它，取里面的 `token`
直接当 `Cloud-IDE-JWT` 用。

有两件事值得写下来，因为都很容易踩：

1. **不要用 `GenerateTempToken` 换令牌**。名字看起来正合适，但换出来的令牌
   （claims 带 `type: "user"`）发给聊天端点会被 401 `code 1001`；
   登录文件里那枚（claims 带 `source: "refresh_token"`）才是能用的。
2. **令牌 7 天过期**。插件在余量不足 1 天时用 `refreshToken` 走
   `/cloudide/api/v3/trae/oauth/ExchangeToken` 续期，并把新令牌写回账号，
   不会每个请求都重刷。

卡片里的「Trae 登录文件」是**可选项**：留空自动查找上面两个位置；装在非默认
目录或便携版时再手填。国际版没有额度查询与签到端点（上游 404），卡片会明确
写「请在 Trae 客户端里查看额度」，不编一个数字。

### 多账号与自动切换

同一个 provider 可以挂多个账号：

- Qoder：可以粘贴多个 PAT；
- WorkBuddy：用「浏览器登录新增账号」多次登录即可（同一个 uid 不会重复添加）；
  本机已有的桌面端登录会自动作为默认账号读取。

当前账号的积分用完后自动切到下一个还有余额的账号（可在账号区关掉）。
也可以在「高级」里把 `低于该比例自动换号` 设成 5–50%，提前换到一个同样高于
阈值的账号。请求级 `AUTH` / `QUOTA` / `RATE_LIMIT` 失败也会触发一次就地换号
（前提是还没输出内容）。

### 每日签到 / 领取积分

WorkBuddy 国内版每天 100 积分（走 Web 计费端点）：

```
POST {endpoint}/v2/billing/meter/checkin-activity-status   # 先查状态
POST {endpoint}/v2/billing/meter/daily-checkin             # 需要时再领取
```

- 启动时自动跑一次，之后由调度器每 30 秒检查；**按本地自然日**判断，跨过午夜就会重新尝试；
- 每个 provider 独立记录完成日期；今天已完成（已签 / 无活动 / 没有可签账号）就不再打上游；
- 失败后 10 分钟重试，不会因为一次临时失败放弃当天；
- 多账号一起签；一个账号失败不影响其他账号；
- 响应码按上游语义映射：`0` 成功、`10001/1001` 今天已领、`1002` 无资格、
  `1003` 活动结束 —— 后两者算「无活动」而不是失败；
- 账号区有「自动签到」开关与「立即签到」按钮；关闭自动后只能手动点。

## 积分是怎么算的

三家上游各有一套账目，口径不同，混着算就会给出误导性的数字。

### WorkBuddy：套餐包列表

`POST {billing}/v2/billing/meter/get-user-resource` 返回一串套餐包，每个包同时有
「周期额度」与「一次性余额」两组字段：

- **周期优先**：`CycleCapacitySize > 0` 时只能看 `CycleCapacityRemain`，否则会把
  已过期周期里的一次性余额算成可用；
- **已耗尽的包不进分母**：国内版账上有 5000 和 1000 两个早已耗尽的包，算进去会显示成
  「675 / 7700」，看着像额度快见底了；
- 企业账号走另一条端点（`get-enterprise-user-usage`），`limitNum === -1` 表示不限量。

### Qoder：单一额度 + 套餐

`GET /api/v2/quota/usage` 给 `userQuota{total,used,remaining}`，`/api/v2/user/plan`
给套餐名，`/api/v3/user/status` 给重置时间。免费套餐的 `total` 就是 0，此时显示
`0 credits` 并标注「免费模型排队」，而不是留一个空白或报「额度已用尽」。

### 三条设计原则

1. **「读不到」≠「0」**：额度读取失败时保留上一次成功值并标出错误。
2. **额度与目录分开取**：目录失败不影响额度，反之亦然。
3. **缓存 2 分钟**：卡片轮询不会每 20 秒打一次上游；「刷新积分」强制绕过缓存。

### 模型倍率

DSH 的模型选择器只渲染 `name`，所以倍率只有拼进名字才看得见：

```
GLM-5.3 · x0.79        Hy3 · 免费        Kimi-K3 · x1.62
```

倍率会归一化（`x0.79 credits` / `0.79` 都变成 `x0.79`，`0` 显示为「免费」），
认不出的保持原名 —— 错误的倍率比没有倍率更误导。卡片里可关掉。

## 用量统计

每次请求结束（成功、失败、取消、中断）都会记进 `stats.json`：

- 今日 / 累计的请求数、token 数、成功率、平均耗时；
- 每个 provider、每个账号、每个模型各一份；
- **账号 × 模型**交叉一份：回答「哪个账号、用了哪个模型、花了多少 token」——
  两个账号都用过同一个模型时，账号维度和模型维度都只给得出合计。
  这一栏有**今日**与**累计**两个口径，卡片默认今日（与上方「今日 N 次」对齐）；
- **每日历史保留 30 天**（卡片显示最近 14 天柱状图）；
- **当前会话**单独计数（DSH 的 `sessionId`），卡片里多一行；
- 模型用量榜（按请求数取前 5）、账号 × 模型表（按 token 取前 8，账号数 > 1 时才显示）
  与最近 40 条请求；
- 健康状态：连续 2 次失败 = 降级，连续 3 次 = 不可用；一次成功立即恢复。

`stats.json` 从 v1/v2/v3 升级到 v4 时会保留累计、今日、每日历史与账号/模型维度，
不会清零。但 `accountModels` / `accountModelToday` **不做回填**：两份独立计数
推不出交叉值，老数据没有这一栏，从升级后的下一次请求开始累积。

因此卡片与 CLI 会在这一栏的标题上标明覆盖率 —— 例如
`已记录 71 / 1,230 次（6%）：历史请求拆不出账号`。覆盖率到 100% 时提示自动消失。

命令行也能看：

```powershell
node lib/bin.js usage
node lib/bin.js usage workbuddy
```

`usage` 末尾会多出两段按 token 倒序的账号 × 模型明细（今日 / 累计），
并在标题里标出覆盖率：

```text
  账号 × 模型（今日）（已记录 1 / 1230 次，1%；历史请求拆不出账号）：
    - 风雪  auto  1 次  575 tokens
  账号 × 模型（累计）（已记录 71 / 1230 次，6%；历史请求拆不出账号）：
    - 本机登录  deepseek-v4.1-flash  69 次  34,022,016 tokens
```

## 图片输入

- 支持的源格式由宿主决定（PNG / JPEG / WebP / GIF），插件只负责把宿主归一化后的
  请求版本转成 data URL；
- 每张图默认压到约 4M 像素、4MB 以内，保持宽高比、不放大；
- user / system 消息里的图片：说明文本 + `image_url`；
- tool 结果里的图片：工具消息保持纯文本，图片放进紧随其后的 user 消息；
- 纯文本模型或宿主没有附件服务时，宿主会把图片换成稳定占位符；
- 订阅制没有按图计价，所以不实现 `imageRequestPricing`，DSH 会退回中性估算。

## 「读不到」与「真的是 0」

额度有四种状态，插件在**所有**出口（卡片、侧栏、CLI、诊断）都按同一套规则显示，
因为把这四种混在一起最容易让人做出错误决定：

| 状态 | 含义 | 卡片 / 侧栏 | CLI / 诊断 |
|---|---|---|---|
| `ok` | 读到了数字 | `675 / 1,200 积分` | `675 / 1200 credits` |
| `ok` + `stale` | 有旧数字，这一轮读失败 | 数字变淡 +「缓存数据」徽标 | `… · 上次结果` |
| `none` | 没有可读的额度端点 / 还没配凭证 | `未读取` + 原因 | `未读取（原因）` |
| `error` | 有端点但这次失败 | `读取失败` + 原因 | `读取失败（原因）` |

三条由踩坑得来的规则：

1. **`none` 不是 `stale`**。1.7.x 只要缓存条目带 `error` 就标 `stale`，于是没有额度
   端点的 Trae 国际版、还没配 PAT 的 Qoder 会被诊断写成「0 / 0 credits · 缓存」——
   那个 0 是 `emptyCredits()` 的占位值，不是余额。现在只有「手里真有一个 `ok`
   快照」才算缓存。
2. **读失败不进胶囊**。侧栏那一排只列有数字的 provider：一个红着亮 `0` 的格子会被
   读成「这家额度用完了」，而真实情况常常是「这次没读到」。
3. **耗尽预估用人话时长**。`3h 20m` / `252d`，不再是「预计可用 363476 分钟」。

## 模型清单为什么会变

### 国内版从 10 个修正到 18 个

`/v3/config` 的返回**由 User-Agent 决定**，实测三种身份拿到三份不同的花名册：

| 请求身份 | `agents[]` | 结果 |
|---|---|---|
| 纯 App：`WorkBuddy/5.5.6` | 只有 `craft` / `ask` / `plan`，**没有 `cli`** | 早先误把 `agents[0]` 当花名册 → 10 个假清单 |
| 纯 CLI：`CLI/2.63.2 CodeBuddy/2.63.2` | `cli` 有 18 个 | 18 个，但**缺 `auto`** |
| 桌面端复合身份：`WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.63.2` | `cli` 有 18 个 | **18 个 + `auto` = 19**，`models[]` 也最全 |

插件使用桌面端自己的复合身份（目录与聊天统一），并且**没有 `cli` 花名册时直接报错**，
而不是退到 `agents[0]` —— 后者会悄悄给出假目录，是最难发现的那类错。

同时处理了两个会让模型「看得见但用不了」的问题：

- **`auto` 是虚拟 id**：在花名册里但不在 `models[]` 里，确实能聊天，按保守默认值保留；
- **隐含思考档位**：`glm-5.1` 这类模型只有 `{effort:"medium"}`、没有
  `supportedEfforts`，此时省略 `reasoning_effort` 会被判 400，显式发 `medium` 反而正常。
  目录解析会把隐含档位收敛成唯一可选档位，聊天时自动补上。

### 账号能力探测

花名册是**产品级**的，不是**账号级**的。实测国际版免费账号能列出 27 个模型，其中 13 个
（GPT / Grok / Gemini 全家）一聊就回「当前账号类型暂不支持该模型」。

插件在后台逐个探测（每个模型一次 `max_tokens: 1` 的极短请求，并发 4 路），把账号用不了
的模型记进 `unavailableModels` 并从选择器隐藏。判据刻意很严 —— **只认 400 + 明确的档位
文案**：429 单模型频率限制、401/403、5xx、网络超时都视为可用。误判会藏起能用的模型，
比多显示几个不能用的糟得多。

探测每 6 小时最多一次（省额度），卡片上有「检测账号可用模型」可手动重跑。探测请求不会
写进用量统计，也不会触发自动换号。

## 设置卡片与侧栏小卡

`设置 → 插件设置 → 反代连接器`，`侧栏 → 插件 → 反代连接器` 详情页里也有同一张卡片。

卡片能做：

- 顶部每家 provider 一张**总览卡**（六张，栅格自动换行）：健康圆点、剩余额度、模型数、今日 token、当前账号；
- 六个 provider 的登录状态、目录来源（`已从上游拉取` / `上游不可达，显示上次结果` /
  `已缓存` / `内置兜底列表`）、健康状态；
- 积分行 + 套餐名 + 到期时间 + 可展开的套餐包明细；
- **额度趋势**：今日/7 天消耗、消耗速度、耗尽预估、折线图；
- **额度预警横幅**（低于阈值时）；
- 逐 provider 开关、逐模型开关、「全部开启 / 全部关闭」；
- 模型数超过 6 时出现**搜索框**；
- 「检测账号可用模型」与「N 个模型账号不支持」折叠区（勾选可强制显示）；
- 账号池：WorkBuddy 只通过浏览器登录新增；Qoder 用「名称 + PAT」新增；两者都支持删除 / 切换；
- **每个账号一行「测试」**（真发 1-token 请求）、最近测试结果、冷却截止与「解除冷却」；
- 今日与累计用量、当前会话、最近 14 天柱状图、模型用量榜、最近请求、重置统计；
- 填 Qoder PAT（带官方 PAT 页面链接）、填 WorkBuddy 的 App 路径与登录文件路径；
- 高级设置（超时 / 刷新间隔 / 统计 / 目录缓存 / 预警阈值与开关 / 提前换号阈值 / 自动探测开关 / Qoder 排队等待）；
- 「最近事件」时间线：全部 / 换号 / 异常 / 凭证筛选，可展开、可清空（只清账本）；
- 「刷新」立刻重拉目录与额度；「诊断」与「复制诊断」输出脱敏文本（含最近 12 条事件）。

**侧栏底部**还有一枚常驻小卡：

```
● WB 675   ● QDG 0   ● WBAI 99
```

每个账号自带强调色圆点，余额为 0 或低于预警阈值（默认 15%，可调）时变琥珀色；
缓存数据的圆点会变成空心环。**读失败 / 未读取的 provider 不占格子** ——
一个亮着 `0` 的格子会被读成「这家额度用完了」，而真实情况常常是「这次没读到」
（见上一节）。全部读不到时，胶囊会缩成一行「账号 — 读取失败」的淡入口。
点胶囊会在它上方展开内嵌面板：

- 头部显示 provider 数量与最近更新时间；
- 每行是「大号剩余数 + 小号分母/单位 + 4px 进度条」；
- 元信息用小徽标铺开：完成百分比、套餐、当前账号、到期时间、今日用量；
- **今日消耗 / 预计还能用 / 趋势折线**（有历史样本时）；
- 已用尽 / 额度偏低 / 缓存数据各有独立徽标；读不到时显示 `—` 与 **简短状态**
  （未登录 / 读取失败），完整错误原因放在悬停提示里，设置卡片中仍是全文；
- 到期时间在小面板里简写为 `到期 M/D`；
- 展开时如果还是缓存数据，会自动刷新一次；
- 底部有「刷新积分」，面板宽度就是侧栏宽度，不会越界，也不会盖住会话列表。

点面板外面或按 `Esc` 收起。

写操作走 `POST`，必须带 `X-RPC-Key`（进程内一次性密钥，卡片从 `GET /status` 拿到）；
读操作只接受回环 `Host`（含 DNS-rebinding 防护），响应带 `Cache-Control: no-store`。
`GET /diagnostics` 额外做脱敏：不含控制密钥、令牌字段一律 `[redacted]`、用户目录缩写。

## CLI

```powershell
node lib/bin.js status                 # 六个 provider 的登录、目录、额度、健康与今日用量
node lib/bin.js doctor [--strict]      # 逐项体检；--strict 有问题时退出码 1
node lib/bin.js models [provider]      # 列模型
node lib/bin.js credits [provider]     # 列积分与套餐包明细
node lib/bin.js usage [provider]       # 今日/累计/当前会话/每日历史与最近请求
node lib/bin.js events [--limit N] [--type T] [--json]  # 最近事件（换号/续期/降级/签到/探测）
node lib/bin.js probe [provider]       # 重跑能力探测
node lib/bin.js test [provider] [accountId]  # 真发一次 1-token 请求验证账号
node lib/bin.js checkin [provider]     # 立即签到
node lib/bin.js login workbuddy        # 浏览器登录并写入账号池
node lib/bin.js stats-reset            # 清空用量统计
node lib/bin.js ask <provider> <model> "提示词"   # 真发一次，打印流
```

`ask` 是最快的排障手段：它跳过 GUI，直接走运行时，能看到正文、工具调用与 usage。
思考内容默认折叠成字数（`ASK_SHOW_REASONING=1` 可展开）。

所有命令都接受 `--profile <dir>`（等价于设置 `DSH_PROFILE_DIR`），并优先使用
`$DSH_HOME/profiles/desktop`；找不到 profile 时会直接报错，而不是悄悄读
`~/.dsh` 下的另一份空设置。

## 数据与隐私

全部自有文件在 `<profile>/.dsh-reverse-proxy-connect/`：

```
settings.json          # PAT、账号池、模型开关、探测结果、路径覆盖、高级参数（0600）
events.json            # 最近事件账本 v1：类型/级别/provider/账号/一句人话（最多 100 条，不含请求内容）
credits-cache.json     # 上一次成功的额度快照（启动秒显）
credits-history.json   # 额度历史：今日/7 天消耗、速度与耗尽预估（按 provider::账号）
catalog-cache.json     # 最后一次成功的模型目录（按 provider::账号）
stats.json             # 用量统计 v4：今日/累计/每日 30 天/按 provider 的每日与会话/模型/账号×模型（今日+累计，不含请求内容）
.qoder-machine-id      # Qoder 设备标识种子（优先复用 ~/.qoder/.auth/machine_id）
```

插件不写 `~/.qoder`、不改桌面 App 的任何文件、不上报任何东西。
凭证只在内存里用于签名，不落盘（Qoder PAT 与浏览器登录令牌除外，它们是用户自己的
账号配置）。

## 兼容性说明（DSH 0.2.1-rc.1 / rc.2）

| 项 | 状态 |
|---|---|
| `ctx.llm.registerAdapter([...ids], adapter)` | 签名未变，六个路由一次注册 |
| `LlmAdapter` 的 `providerInfo` / `listModels` / `resolveModel` / `prepareCall` / `stream` | 全部实现 |
| `imageRequestTarget` / `inputModalities` | 实现；仅在宿主挂载附件服务时声明 image |
| `imageRequestPricing` | 不实现（订阅制无单图计价），宿主用中性估算 |
| 终态 `finish` chunk（`stop` / `tool-calls` / `max-tokens` / `error` / `aborted`） | 每条流恰好一个 |
| `usage` 先于 `finish` | 遵守 |
| `ctx.webServer.register({kind:'exact', path, handler})` | 未变；重复路径会抛 |
| `ctx.effect` 立即执行并把返回值当 disposer | 遵守 |
| `ctx.attachments.readImageRequest()` / `imageHostPath()` | 可选注入；缺失时图片退回文本占位 |
| `settings.installSection` / `settings.update` | **已从 0.2.1 移除**，所以本插件不用它，自己管 `settings.json` |
| 请求归因 | WorkBuddy 的目录按 UA 分流，不能替换 UA；改为追加 `x-dsh-attribution` 头 |

刻意**没有**做的事：

- 不调 `registerConfigurableProviders`：那会把 provider 也塞进「模型设置」页的目录里，
  与卡片的单点真相冲突。
- 不支持 `GenerateOptions.stop`：三家上游都不保证 stop 序列语义，明确拒绝而不是悄悄忽略。

## 开发

```powershell
node --test tests/*.test.mjs      # 257 条纯逻辑 / 集成用例
node tests/client-credits.mjs     # 设置卡片与侧栏小卡的渲染 / 交互用例（46 项）
npm run verify                    # 两套一起跑
```

想验证真实链路：

```powershell
$env:DSH_PROFILE_DIR="C:\Users\<you>\.dsh\profiles\desktop"
node lib/bin.js doctor
node lib/bin.js ask workbuddy auto "用一句话介绍你自己"
```

## 已知限制

- 图片输入依赖宿主挂载 `attachments` 服务；自行组合的部署如果没有它，图片会变成文本占位符。
- Qoder 的 tool 消息不接受图片，插件把工具结果里的图片提升成后续 user 消息；这是兼容性
  折中，不是上游的原生语义。
- 能力探测是启发式的，只认「400 + 档位文案」；若上游改了文案，可能需要更新判据。
- 免费账号的排队/限流行为由上游决定，插件只能按上游给的秒数重试，不能保证一定成功。
- 订阅制的积分与 token 不是一一对应关系，插件不提供「花了多少钱」的估算。
- **额度读不到时不显示 0**：`未读取` / `读取失败` / `上次结果` 三种状态分开显示
  （见「读不到与真的是 0」一节）。旧版本会把占位的 0 写成真实余额。
- **Trae 国际版没有额度查询与签到端点**（上游直接 404），额度只能去客户端里看；
  卡片会明确写出来，不会编一个数字。另外免费套餐对多数模型回 `code 1005`
  （「当前套餐不能使用这个模型」），插件会把它翻成人话，而不是原样透传空消息。
- **Trae 的 `tc` 加密格式是逆向出来的**。上游一旦换盐或换信封头，插件会明确报
  「未知的加密格式」而不是静默失败；届时需要更新 `lib/trae/credential.js` 里的盐。

## 免责声明

WorkBuddy、Qoder 与 Trae 的接口来自上游客户端，随时可能改动、限流或封禁。
本插件供个人学习研究，用你自己的账号、走你自己的额度；请遵守各家的服务条款。
WorkBuddy、Qoder、Trae、DeepSeek 等名称与商标归各自权利人所有，此处仅作兼容性说明。
