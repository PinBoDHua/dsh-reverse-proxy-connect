# dsh-reverse-proxy-connect

把 **WorkBuddy**（国内版 / 国际版）与 **Qoder**（全球版 / 国内版）账号里的模型接进
**DeepSeek Harness**。一个插件、四个 provider、一张设置卡片、一套账号池。

> **1.0.0 是第一个正式版**。它修掉了一个会让 0.9.0 的浏览器登录「看起来成功、
> 实际聊不了天」的凭证分裂问题，并补上图片输入、用量统计、请求级自动换号、
> 真正的空闲超时、目录磁盘缓存与一套 CLI 体检工具。
>
> **1.0.1** 修正了两处实际使用中发现的问题：用量区改成带表头与行线的表格；
> 自动签到从「20 小时节流」改为「按本地自然日」，不会因为昨天签得晚而漏掉今天，
> 并在账号区加了可见的「自动签到」开关与失败重试提示。
>
> **1.0.2** 打磨了侧栏积分面板与胶囊：大号剩余数 + 小号分母、完成百分比/套餐/
> 当前账号/到期/今日用量徽标、缓存与已用尽状态、展开时自动刷新，以及更清晰的
> 行分隔与胶囊分隔线。
>
> **1.0.3** 把小面板里的错误信息收成短状态：只显示「未登录 / 读取失败」，
> 完整原因放进 `title` 悬停查看；设置卡片仍保留全文。到期时间在小面板里简写为
> `到期 M/D`，「缓存数据」移到元信息行，provider 名不再被挤掉。
>
> **1.0.4** 删掉 WorkBuddy 账号区里「手动填名称 + 登录文件路径」的添加框：
> 桌面 provider 的新增账号现在只有「浏览器登录」一条路；本机已有登录仍会自动读取。
> Qoder 没有浏览器登录，继续保留「名称 + PAT」的手动添加。

| provider id | 显示名 | 凭证来源 | 实测模型数量级 |
|---|---|---|---|
| `workbuddy` | WorkBuddy | 本机登录文件，或浏览器登录 | 18 |
| `workbuddy-ai` | WorkBuddy AI | 本机登录文件，或浏览器登录 | 27（本账号可用 14） |
| `qoder` | Qoder | 个人访问令牌（PAT，qoder.cn） | 视账号 |
| `qoder-global` | Qoder Global | 个人访问令牌（PAT，qoder.com） | 视账号 |

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

- 请求因为 `AUTH` 或 `QUOTA` 失败，且**还没吐出任何内容**时，自动换下一个账号重开；
- 换号成功后写回 `activeAccount`，下一次请求直接用新账号；
- 刚失败的账号进入冷却（认证/额度 2 分钟、限流 30 秒、服务端 15 秒），不会被反复选中；
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

四个 provider 共享一份运行时：

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
- **四个 provider 共享一份运行时**：一个适配器实例、一份目录缓存、一张卡片。

---

## 安装 / 升级

```powershell
# 预览（默认不写盘）
node scripts/install.mjs

# 安装或升级
node scripts/install.mjs --apply

# 卸载
node scripts/install.mjs --apply --uninstall
```

脚本会复制插件到 profile 的 `node_modules`，并把包名写进 profile `package.json` 的
`dependencies` 与 `dsh.profile.bundles`；落盘前先备份到
`<DSH_HOME>/dsh-reverse-proxy-connect-backup-<时间戳>/`，并附一份 `restore.ps1`。

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
`retryAfterSeconds`）。插件现在**首包与流中**都会按上游建议在本地等一次再重开；
只要还没吐过一个字节，重试就是无损的。

### 多账号与自动切换

同一个 provider 可以挂多个账号：

- Qoder：可以粘贴多个 PAT；
- WorkBuddy：用「浏览器登录新增账号」多次登录即可（同一个 uid 不会重复添加）；
  本机已有的桌面端登录会自动作为默认账号读取。

当前账号的积分用完后自动切到下一个还有余额的账号（可在账号区关掉）。
请求级 `AUTH` / `QUOTA` 失败也会触发一次就地换号（前提是还没输出内容）。

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
`0 credits` 并标注「额度已用尽」，而不是留一个空白。

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
- 最近 40 条请求：时间、模型、结果、耗时、token、失败码；
- 健康状态：连续 2 次失败 = 降级，连续 3 次 = 不可用；一次成功立即恢复。

命令行也能看：

```powershell
node lib/bin.js usage
node lib/bin.js usage workbuddy
```

## 图片输入

- 支持的源格式由宿主决定（PNG / JPEG / WebP / GIF），插件只负责把宿主归一化后的
  请求版本转成 data URL；
- 每张图默认压到约 4M 像素、4MB 以内，保持宽高比、不放大；
- user / system 消息里的图片：说明文本 + `image_url`；
- tool 结果里的图片：工具消息保持纯文本，图片放进紧随其后的 user 消息；
- 纯文本模型或宿主没有附件服务时，宿主会把图片换成稳定占位符；
- 订阅制没有按图计价，所以不实现 `imageRequestPricing`，DSH 会退回中性估算。

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

- 顶部四张**provider 总览卡**：健康圆点、剩余额度、模型数、今日 token、当前账号；
- 四个 provider 的登录状态、目录来源（`已从上游拉取` / `上游不可达，显示上次结果` /
  `已缓存` / `内置兜底列表`）、健康状态；
- 积分行 + 套餐名 + 到期时间 + 可展开的套餐包明细；
- 逐 provider 开关、逐模型开关、「全部开启 / 全部关闭」；
- 模型数超过 6 时出现**搜索框**；
- 「检测账号可用模型」与「N 个模型账号不支持」折叠区（勾选可强制显示）；
- 账号池：WorkBuddy 只通过浏览器登录新增；Qoder 用「名称 + PAT」新增；两者都支持删除 / 切换；
- 今日与累计用量、最近请求、重置统计；
- 填 Qoder PAT（带官方 PAT 页面链接）、填 WorkBuddy 的 App 路径与登录文件路径；
- 高级设置（超时 / 刷新间隔 / 统计 / 目录缓存）；
- 「刷新」立刻重拉目录与额度；「诊断」打出完整状态 JSON，可一键复制。

**侧栏底部**还有一枚常驻小卡：

```
● WB 675   ● QDG 0   ● WBAI 99
```

每个账号自带强调色圆点，余额为 0 或低于 15% 时变琥珀色；缓存数据的圆点会变成空心环。
点胶囊会在它上方展开内嵌面板：

- 头部显示 provider 数量与最近更新时间；
- 每行是「大号剩余数 + 小号分母/单位 + 4px 进度条」；
- 元信息用小徽标铺开：完成百分比、套餐、当前账号、到期时间、今日用量；
- 已用尽 / 缓存数据各有独立徽标；读不到时显示 `—` 与 **简短状态**（未登录 / 读取失败），
  完整错误原因放在悬停提示里，设置卡片中仍是全文；
- 到期时间在小面板里简写为 `到期 M/D`；
- 展开时如果还是缓存数据，会自动刷新一次；
- 底部有「刷新积分」，面板宽度就是侧栏宽度，不会越界，也不会盖住会话列表。

点面板外面或按 `Esc` 收起。

写操作走 `POST`，必须带 `X-RPC-Key`（进程内一次性密钥，卡片从 `GET /status` 拿到）；
读操作只接受回环 `Host`（含 DNS-rebinding 防护），响应带 `Cache-Control: no-store`。

## CLI

```powershell
node lib/bin.js status                 # 四个 provider 的登录、目录、额度、健康与今日用量
node lib/bin.js doctor [--strict]      # 逐项体检；--strict 有问题时退出码 1
node lib/bin.js models [provider]      # 列模型
node lib/bin.js credits [provider]     # 列积分与套餐包明细
node lib/bin.js usage [provider]       # 今日/累计用量与最近请求
node lib/bin.js probe [provider]       # 重跑能力探测
node lib/bin.js checkin [provider]     # 立即签到
node lib/bin.js login workbuddy        # 浏览器登录并写入账号池
node lib/bin.js stats-reset            # 清空用量统计
node lib/bin.js ask <provider> <model> "提示词"   # 真发一次，打印流
```

`ask` 是最快的排障手段：它跳过 GUI，直接走运行时，能看到正文、工具调用与 usage。
思考内容默认折叠成字数（`ASK_SHOW_REASONING=1` 可展开）。

## 数据与隐私

全部自有文件在 `<profile>/.dsh-reverse-proxy-connect/`：

```
settings.json          # PAT、账号池、模型开关、探测结果、路径覆盖、高级参数（0600）
credits-cache.json     # 上一次成功的额度快照（启动秒显）
catalog-cache.json     # 最后一次成功的模型目录（按 provider::账号）
stats.json             # 用量统计（不含请求内容）
.qoder-machine-id      # Qoder 设备标识种子（优先复用 ~/.qoder/.auth/machine_id）
```

插件不写 `~/.qoder`、不改桌面 App 的任何文件、不上报任何东西。
凭证只在内存里用于签名，不落盘（Qoder PAT 与浏览器登录令牌除外，它们是用户自己的
账号配置）。

## 兼容性说明（DSH 0.2.1-rc.1 / rc.2）

| 项 | 状态 |
|---|---|
| `ctx.llm.registerAdapter([...ids], adapter)` | 签名未变，四个路由一次注册 |
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
- 不支持 `GenerateOptions.stop`：两个上游都不保证 stop 序列语义，明确拒绝而不是悄悄忽略。

## 开发

```powershell
node --test tests/*.test.mjs      # 99 条纯逻辑 / 集成用例
node tests/client-credits.mjs     # 设置卡片与侧栏小卡的渲染 / 交互用例
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

## 免责声明

WorkBuddy 与 Qoder 的接口来自上游客户端，随时可能改动、限流或封禁。
本插件供个人学习研究，用你自己的账号、走你自己的额度；请遵守两家的服务条款。
WorkBuddy、Qoder、DeepSeek 等名称与商标归各自权利人所有，此处仅作兼容性说明。
