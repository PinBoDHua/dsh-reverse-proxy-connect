# 更新记录

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
