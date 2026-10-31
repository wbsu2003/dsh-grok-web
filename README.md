# dsh-grok-web

把 **grok.com 网页端**（免费额度）接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 DSH LLM provider 插件，路由 id 为 `grok-web`。

- 通过浏览器登录一次，插件保存 grok.com 的 Cookie，然后在 Node 里直连 mgw WebSocket 收发对话。
- 文本输入、流式输出。
- 工具调用走**提示词协议**（网页端没有原生 function calling）：模型输出 ` ```dsh-tool ` 围栏 JSON，插件在流式过程中解析成标准的 `tool-call` 块。

> **非官方项目**：与 xAI、Grok 没有任何关联，也未获其认可或赞助。"Grok" 是其权利人的商标。
> 本项目不包含任何官方客户端代码；协议行为来自对网页端公开流量的观察（见「致谢」）。
> 使用自己的账号，自行承担账号被限流/临时封禁的风险，并遵守 grok.com 的服务条款。

## 工作原理

```text
DSH agent
   │  GenerateOptions（system / messages / tools）
   ▼
dsh-grok-web adapter
   │  serializePromptParts：系统头 + 工具目录 + 历史转写
   ▼
wss://grok.com/ws/mgw/?uid=<x-userid>
   │  session.create → session.created → response.create
   │  ← response.chunk（只取 CHANNEL_ASSISTANT_RESPONSE）
   ▼
ToolCallStreamFilter ──► StreamChunk：text / tool-call
   │
   ▼
DSH agent（执行工具，把结果作为下一轮消息返回）
```

要点：

1. **登录捕获**：`scripts/login.mjs` 拉起一个独立的 Chrome/Edge profile（不碰日常浏览器），通过 CDP `Storage.getCookies` 读取 grok.com 的 Cookie；再用一次 `session.create → session.created` 握手验证，通过后写入本机 `auth.json`。握手不提问，不消耗生成额度。
2. **每轮全量重发**：mgw 每轮都创建临时会话，插件把 DSH 的完整历史序列化成一段 prompt。网页端不保留上下文，因此不会出现「服务端历史 + 重发历史」两份上下文打架。
3. **工具桥**：插件在系统头里注入 `dsh-tool` 协议说明与工具目录；模型按协议输出调用，过滤器识别围栏、配平 JSON、生成 `tool-call` 块。默认**一次只执行一个调用**（串行），可用 `serialToolCalls: false` 放宽到最多 3 个批量。
4. **不做静默降级**：登录失效、代理不可用、上游限流、调用格式坏掉都会映射成带稳定 `code` 的错误；可重试的错误交给 DSH 的 retry 机制。

## 环境要求

- DSH Desktop 0.2.x（或支持 `dsh.bundle.patch` 装配的 DSH CLI）。
- Chrome 或 Edge（仅登录捕获需要）。
- 能访问 `grok.com`；中国大陆通常需要代理。
- 代理只支持 **http:// / https://**（wss 走 HTTP CONNECT）。SOCKS 会明确报错，不会静默直连。
- 自带脚本需要 Node `^22.18.0 || >=24.11.0`；DSH 应用内运行使用它自己的 Node 运行时。

## 安装

> 安装会改动你的 DSH profile（`%USERPROFILE%\.dsh\profiles\desktop`）。介意的话先备份
> `package.json` 与 `cordis.patch.yml`；卸载用 `dsh plugin --profile desktop remove dsh-grok-web`。

### 方式 A：本地目录（开发/试用）

```cmd
dsh plugin --profile desktop add "C:\path\to\dsh-grok-web"
```

命令会把包加进 profile。安装后检查 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的
`dsh.profile.bundles` 是否包含 `dsh-grok-web`；若没有，手动加一行（与其它 bundle 名并列）：

```json
"bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-grok-web"
]
```

然后**重启 DSH Desktop**。

### 方式 B：打成 tgz 再装

```cmd
cd /d "C:\path\to\dsh-grok-web"
npm pack
dsh plugin --profile desktop add ".\dsh-grok-web-0.1.0.tgz"
```

重启 DSH Desktop 生效。插件是纯 ESM，不需要构建步骤；唯一的运行时依赖是 `@deepseek-ai/schemastery`
（DSH 宿主 profile 自带）。注意用 `link:` 方式装到本地目录时，Node 会按**真实路径**解析依赖，
所以在插件目录的上层也要能解析到它（本机做法：在 `DSH-plugin\node_modules` 放一份）。

## 在 DSH 界面里用

装好并重启后有三个入口：

1. **模型 → 添加提供商**：出现 `Grok 网页版`（无 API Key 输入框，因为走浏览器登录态）。
   登录态缺失时这一项会带一行错误说明，点进去就是下面的设置节。
2. **设置 → Grok 网页版**（面板，来自 client 包 `lib/client.js`）：
   - **用 Microsoft Edge 登录 / 用 Google Chrome 登录**：按本机实际装了哪些浏览器各出一个按钮。
     拉起的是**独立 profile**（不是你的日常浏览器），进度实时显示在面板下方；等待期间如果登录页
     （grok.com 或 X 的核验页）在页面上写了原因，面板会把页面原文复述出来，连续三次命中同一类
     拒绝文案就早停报 `AUTH`；
   - **用我的默认浏览器登录**：只在你日常使用的浏览器里打开 grok.com —— 这条路**抓不到 Cookie**
     （Chrome/Edge 136 起在默认 profile 上直接忽略 `--remote-debugging-port`），点开之后按面板
     提示从 F12 → 网络 里复制 `cookie` 请求头，粘到面板下方的「Cookie」框。日常浏览器有账号信誉，
     独立 profile 被 X 要求核验账户时走这条最省事；
   - **Cookie 框 + 保存并验证**：把上面复制到的整行 `cookie` 粘进去（密码框，界面上显示成点），
     点「保存并验证」= 写入 `auth.json` + 一次 mgw 握手。这是浏览器登录走不完时的兜底入口。
     注意 **先落盘、再握手**：握手失败（比如代理不通）时登录态也已经存好，面板会把原因原样列出来；
     设置节里的 `cookie` 字段非空时会**优先于**这个文件，要用面板粘贴就把那个字段清空（面板会提醒你）；
   - **从调试端口导入**：不弹新窗口，直接连一个已经带 `--remote-debugging-port=<端口>` 启动、
     且已登录 grok.com 的浏览器（默认填 9222）。这种模式**只读 Cookie，绝不关闭你的浏览器**；
   - **探活**：用现有登录态做一次 mgw 握手，不提问、不消耗额度。
   面板只显示掩码后的 `x-userid`、来源、抓取时间与文件路径，任何路由都不返回 Cookie 明文。
3. **设置 → 插件 → dsh-grok-web**：下面「配置」表里的全部字段，保存后立即生效（配置项都是
   volatile 活引用，不需要重启）。

## 登录一次

```cmd
cd /d "C:\path\to\dsh-grok-web"
node scripts/login.mjs
```

- 会打开一个**独立 profile** 的 Chrome/Edge 窗口（默认 `<DSH_HOME>\grok-web\browser-profile`），在其中正常登录 grok.com 即可；已有登录态会自动复用。
- 检测到 `x-userid` 与 `sso` / `sso-rw` 后，先做 mgw 握手验证，再保存到：
  `%USERPROFILE%\.dsh\grok-web\auth.json`（可用 `DSH_HOME` 改根目录，用 `--auth-file` 改文件）。
- 常用参数：

| 参数 | 作用 |
|---|---|
| `--status` | 只检查现有登录态并握手验证，不打开浏览器 |
| `--keep-open` | 捕获完成后保留浏览器窗口 |
| `--cookie "<Cookie 头>"` | 手动粘贴 Cookie（需含 `x-userid`）；也可配 `--user-id` |
| `--browser <edge\|chrome\|路径>` | 用哪个浏览器登录（默认 Edge 优先），或直接给可执行文件路径 |
| `--profile <目录>` | 指定登录用的独立 profile |
| `--proxy <url\|auto\|off>` | Node 侧握手使用的代理；默认 `auto`（环境变量 → Windows 系统代理） |
| `--no-verify` | 跳过握手验证（不推荐） |

手动取 Cookie：在已登录的 grok.com 按 F12 → Network → 任一请求 → 复制完整 `Cookie` 请求头，
再执行 `node scripts/login.mjs --cookie "..."`。**不要**把 Cookie 贴进 issue、聊天或仓库。
（必须走 Network 面板：`sso` / `sso-rw` 是 httpOnly，控制台里的 `document.cookie` 看不到它们。）

Edge 与 Chrome 各用一份独立 profile（`browser-profile-edge` / `browser-profile`）：同一个
user-data-dir 只能被一个浏览器实例占住，共用只会让第二个把手上的窗口交给第一个。

## 验证

不经过 DSH，直接验证登录态与网络：

```cmd
node scripts/probe.mjs "用一句话介绍你自己"
node scripts/probe.mjs --status
```

`probe.mjs` 会流式打印正文、耗时与结束原因；`--json` 输出 NDJSON 事件。它和插件共用同一套
认证/代理/mgw 代码，适合在接入 DSH 前排错。

然后在 DSH 模型选择器里选择：

- provider：`Grok 网页版（免费）`
- model：`Grok 网页版 · Fast` / `· Auto` / `· Build`（见「档位」一节）

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（该文件在 bundle 之后应用）：

```yaml
- id: dsh-grok-web
  name: dsh-grok-web
  config:
    proxy: auto
    model: fast
    serialToolCalls: true
    maxPromptChars: 200000
    idleTimeoutMs: 15000
    totalTimeoutMs: 300000
    debug: false
```

| 键 | 默认 | 说明 |
|---|---|---|
| `authFile` | `<DSH_HOME>/grok-web/auth.json` | 登录态文件位置 |
| `cookie` | 空 | 直接给 Cookie 头（**优先于** `authFile`，也优先于面板「Cookie」框写入的登录态）；必须含 `x-userid` |
| `userId` | 空 | 手动指定 uid（Cookie 里没有 `x-userid` 时用） |
| `userAgent` | Chrome 152 Windows | 请求头 UA；默认已足够 |
| `proxy` | `auto` | `auto` = 环境变量 → Windows 系统代理；`off`/`direct`/`false` = 直连；也可写 `http://127.0.0.1:2081` |
| `model` | `fast` | **mgw 服务端**档位名，不是 DSH 的 model id。网页端选择器有 Fast / Build / Auto / Expert / Heavy 五档，本插件实测过的见下表 |
| `contextWindow` | `131072` | 展示/预算用的上下文窗口 |
| `defaultMaxTokens` | `16384` | 展示用的默认输出上限 |
| `maxPromptChars` | `200000` | 单次 prompt 字符上限；固定头必须完整放得下，历史从中间截断 |
| `idleTimeoutMs` | `15000` | 有正文后，静默多久视为回答结束 |
| `totalTimeoutMs` | `300000` | 单轮总超时；无正文时超时会报 TIMEOUT |
| `heartbeatMs` | `30000` | 应用层 ping 间隔 |
| `connectTimeoutMs` | `20000` | DNS/TCP/TLS/握手超时 |
| `serialToolCalls` | `true` | 一次一个工具调用；`false` 允许最多 3 个批量 |
| `debug` | `false` | 输出 prompt 长度、代理来源等诊断日志（不打印 Cookie） |

数值会被钳制在安全区间（例如 `maxPromptChars` 20k–1.5M）。

### 档位（DSH 模型选择器里能看到几条）

| 档位 | mgw 档位名 | DSH model id | 真机状态 |
|---|---|---|---|
| Fast | `fast` | `grok-web` | 已实测出正文 |
| Auto | `auto` | `grok-web-auto` | 已实测出正文 |
| Build | `build` | `grok-web-build` | 已实测出正文 |
| Expert | `expert` | `grok-web-expert` | 免费账号同一句 prompt 只回空响应（`EMPTY_RESPONSE`）；网页端这档在「Premium 解锁扩展能力」里 → 默认**不列出** |
| Heavy | `heavy` | `grok-web-heavy` | 同上，默认**不列出** |

量法（`node scripts/models.mjs` + 每档一句「只回一个字」）：`session.create` 阶段服务端
**不校验**档位名 —— 连 `zzz-not-a-model` 都会回 `session.created` 并原样回显，所以「握手接受」
不等于档位存在；只有真发一轮生成、看有没有正文才算数。

Expert / Heavy 想试：把设置里的 `model` 填成 `expert` / `heavy`，这一档就会出现在列表里
（未实测的档位只有你显式指定时才对外）。开了 Premium 之后若实测能出正文，把 `lib/config.js` 里 `TIERS` 对应项的
`verified` 改成 `true` 就默认列出。

## 认证文件

`%USERPROFILE%\.dsh\grok-web\auth.json` 结构：

```json
{
  "version": 1,
  "provider": "grok-web",
  "capturedAt": "2026-10-23T...",
  "userId": "...",
  "userAgent": "...",
  "cookies": [{ "name": "sso", "value": "...", "domain": ".grok.com", "...": "..." }]
}
```

- 文件写入时使用 `0600` 权限（Windows 上仍受目录 ACL 约束），请勿提交到仓库或分享。
- Cookie 等价于登录凭证：拿到它就能以你的账号身份与 grok.com 通信。
- 插件只把 Cookie 发给 `grok.com`（以及你配置的 HTTP 代理的 CONNECT 隧道），没有遥测。

## 已知限制

- **网页端不是 API**：免费额度、频控、风控、临时限制都可能随时出现；插件没有换号/绕风控机制。
- **协议可能变**：mgw 事件名、字段或通道名变化会让插件失效，需要按真机日志更新。
- **工具调用是提示词模拟**：模型可能输出坏 JSON、少括号、未转义引号。坏调用会被丢弃并按可重试错误上报（`EMPTY_RESPONSE`），由 DSH 自动重发；重发会消耗额度。默认串行也是为了提高成功率。
- **上下文**：每轮全量重发历史；长会话成本随时间增长。固定头（system + 工具目录 + 协议）不能截断，历史中段会被截掉，只保留头尾。
- **只能读正文**：网页端的思考通道、工具卡片等不会进入 DSH；token 用量是按字符**估算**的，不是服务端精确值。
- **不支持图片/文件理解**：图片与附件只留文字占位标记。
- **会话标题 / 上下文压缩**请求不会发送工具目录，避免模型在这些内部用途里调工具。
- **代理**：仅 http/https；HTTPS 代理（TLS-in-TLS）未在真机验证，优先用 HTTP 代理（例如本机 Clash 的 `http://127.0.0.1:2081`）。
- **登录捕获**以 Windows 为主；macOS/Linux 的浏览器路径已写但未实测。
- **并发**：网页端对并发/高频不友好，建议同一账号一次只开一个对话；并行 agent 会话请换账号或错开。

## 排错

| 现象 / code | 含义 | 处理 |
|---|---|---|
| `MISSING_CREDENTIAL` | 没有 auth.json / 缺 `x-userid` | 运行 `node scripts/login.mjs` |
| `AUTH` | 握手 401/403、登录失效、账号受限 | 重新登录；先在浏览器里确认 grok.com 能正常提问 |
| `RATE_LIMIT` | 409/429 或上游限流 | 等待后重试；降低并发 |
| `QUOTA` | 402 / 额度不足 | 换号或等额度恢复 |
| `EMPTY_RESPONSE` | 本轮没有正文、只有思考，或模型给出的调用无法解析 | 插件会自动重试；持续出现时先在网页端手动确认账号可用 |
| `TIMEOUT` / `TRANSPORT` | 网络、代理、TLS、连接中断 | 检查代理；用 `--proxy off` 对照；看 `probe.mjs --status` |
| `ECONNREFUSED 127.0.0.1:<port>`（登录时） | 读到了上次退出后残留的 `DevToolsActivePort` | 新版会自动清理；也可手动删掉 `%USERPROFILE%\.dsh\grok-web\browser-profile\DevToolsActivePort` 再重试 |
| 登录报 `AUTH` 且消息里带「页面提示「…」」 | 登录没在这个浏览器里走完，页面把原因写在了正文里（如「临时限制」「Too many login attempts」），捕获脚本本身在正常读 Cookie | 脚本连续三次读到同一类文案就会早停并原文复述；改走「从调试端口导入」（已登录的浏览器）或面板下方「Cookie」框手动粘贴 |
| 独立 profile 里卡在 X 的「确认你的帐户」（地址带 `#/s/knowledge_check/`） | X 对新设备/新 profile 的账户核验步骤，不是登录表单；自动填充进去的用户名往往没写进页面自己的表单状态，点「继续」看着没反应 | 在用户名框里**手动清空再逐字重输**再点继续；仍不行就改用「用我的默认浏览器登录」+ 面板「Cookie」框手动粘贴（日常浏览器有信誉，一般不会再要核验） |
| `CONTEXT_WINDOW_EXCEEDED` | 系统提示 + 工具目录超出预算 | 减少工具/系统提示，或调大 `maxPromptChars` |
| 回答中途停住 | 可能是 `max-tokens`（输出被截断）或静默超时 | 让模型「继续」；调大 `idleTimeoutMs` / `totalTimeoutMs` |
| 添加提供商/设置页里看不到 Grok | client 包没被加载（多为 `package.json` 的 `dsh.client` 或 `exports["./client"]` 缺项），或依赖解析失败导致 `apply` 抛错 | 看 DSH 日志里有没有 `已注册 provider "grok-web"`；没有就是服务端加载失败，先解决 `ERR_MODULE_NOT_FOUND` |
| 面板显示「宿主没有 webServer」 | 该宿主没开放 HTTP 路由 | 生成请求不受影响；登录改用 `node scripts/login.mjs` |
| 「从调试端口导入」报调试端口不可用 | 目标浏览器不是带 `--remote-debugging-port` 启动的，或端口写错 | 用 `chrome.exe --remote-debugging-port=9222 --user-data-dir=<独立目录>` 重开一个再导入 |

排查顺序建议：`login.mjs --status` → `probe.mjs --status` → `probe.mjs "你好"` → DSH 里试。
每一步都能把问题缩小到登录、网络或 DSH 集成。

## 开发

```cmd
cd /d "C:\path\to\dsh-grok-web"
node --test
```

离线测试覆盖：WebSocket 帧编解码/握手/错误映射、mgw 状态机（含注入连接）、提示词序列化与截断、
`dsh-tool` 流式过滤、Cookie 组装、代理解析、错误归一化、adapter 的 StreamChunk 顺序、插件入口
（路由 + 可配置提供商目录 + 面板 API 挂载）、宿主 API 的登录任务与不泄露 Cookie、设置节 schema、
client 包的 `__ModuleLoader__` / 槽位注册契约。

前置：`node --test` 会加载设置节 schema，所以 `@deepseek-ai/schemastery` 必须能解析到
（本机从 `DSH-plugin\node_modules` 取；没有它整个测试文件会 `ERR_MODULE_NOT_FOUND`）。

目录：

```text
lib/
  index.js         插件入口（注册 grok-web + 可配置提供商 + 面板 API）
  settings.js      schemastery 配置 schema（= DSH 里的设置节）
  api.js           /grok-web/api/*：登录抓取、调试端口导入、手动粘贴 Cookie、探活、状态
  client.js        设置页面板（__ModuleLoader__ 包，手写，无打包器）
  adapter.js       DSH LlmAdapter 契约 + 流式转换
  mgw.js           mgw WebSocket 状态机 + 握手验证
  protocol.js      提示词序列化 + 工具调用过滤器
  auth.js          auth.json / Cookie
  proxy.js         代理与环境/注册表探测
  ws.js            最小 RFC6455 客户端（含 HTTP CONNECT）
  browser-login.js CDP 登录捕获（含附加到已有调试端口）
  cdp.js / browser.js / config.js / errors.js / async-queue.js
scripts/
  login.mjs        登录捕获 CLI
  probe.mjs        端到端探针
  models.mjs       档位探针（只握手 + 逐档极短生成，用来判定档位真伪）
tests/             离线测试
```


## 致谢

- [cv-superding/dsh-deepseek-web-login](https://github.com/cv-superding/dsh-deepseek-web-login)（Apache-2.0）：
  DSH adapter 的契约用法、bundle 装配方式与「提示词工具协议」思路的参考。
- **Web2Chat**（本插件作者此前的项目）：mgw WebSocket 状态机与临时会话参数的行为来源。
- 本项目实现为独立编写；未包含上述项目的源代码，也未包含从任何打包应用中提取的代码。

## 许可证

Apache-2.0。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
