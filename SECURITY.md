# Security Policy

本文档面向准备审计 `bilibili-live-wheel-auto-follow`（B 站独轮车 + 自动跟车，Greasy Fork [scriptId 574939](https://greasyfork.org/zh-CN/scripts/574939)）的 power user、Tampermonkey 用户和安全研究员。它描述这个 userscript 的威胁模型、运行时权限、出入站数据流和已知不可避免的风险。如果你在 README / `docs/user-guide.md` 的"隐私和数据流"小节看到不一致的描述，以本文档为准并请提 issue。

## 支持的版本（Supported versions）

只支持 Greasy Fork 上**最新发布**的那一版。Tampermonkey / Violentmonkey 默认会自动检查 `// @updateURL`（与 `// @downloadURL` 同源），用户应保持自动更新开启。在旧版本上发现的安全问题会以"升级到最新版"作为修复路径，不再向旧版本发补丁；项目目前没有 LTS 分支，也没有内部维护的旧版分叉。

## 报告漏洞（Reporting a vulnerability）

- **非敏感缺陷**（功能 bug、UI 错乱、误报）→ 直接在 [GitHub issues](https://github.com/aijc123/bilibili-live-wheel-auto-follow/issues) 公开提。
- **安全敏感问题**（可能被恶意利用、影响其他用户的隐私或账号）→ 走 GitHub Security Advisories：在仓库 Security 标签页点击 **Report a vulnerability**。这条通道默认私有，会议讨论和补丁会在 advisory 内进行，公开披露与版本发布同步。

响应节奏是单维护者尽力而为：通常 24–72 小时内会有第一次回复，复杂 issue 的修复时间视范围而定。请不要在公开 issue / Discord / 群聊里贴 PoC 或可被复现的攻击向量。

## 威胁模型（Threat model）

**本 userscript 设计用于防御：**

- 同直播间其他观众的被动观察 —— 默认不上传任何弹幕历史、不广播本机识别 / 翻译结果。
- 配置导出 / 截图泄漏 PII —— 任何可选的对外上传 payload 都不带观众 uid / uname / 头像 / 单条 timestamp。
- 粉丝牌身份伪造、徽章欺诈 —— 巡检 / 排行榜路径默认只读，不会因为接到伪造数据而向 B 站发危险写请求。

**不在防御范围内：**

- **共驻浏览器扩展恶意化**。Tampermonkey 自身不能把本脚本和其他扩展隔离开 —— 任何能访问当前页面 DOM 或 `localStorage` 的扩展都看得到本脚本的状态。
- **B 站宿主页面被攻陷**。本脚本运行在 `live.bilibili.com` / `space.bilibili.com` 的页面上下文里，这些页面被注入恶意脚本时（例如供应链攻击、HTTPS 中间人）本脚本无法保护用户。
- **Greasy Fork 镜像 / 第三方分发**。请只从官方 scriptId `574939` 链接 [`https://greasyfork.org/zh-CN/scripts/574939`](https://greasyfork.org/zh-CN/scripts/574939) 安装。第三方网站 / 群文件转发的 `.user.js` 与本项目无关。

## 运行时权限 / userscript header（Permissions）

来源：`vite.config.ts` 的 `userscript.match / connect / run-at`，`@grant` 由 `vite-plugin-monkey` 静态分析源码后自动注入 `dist/bilibili-live-wheel-auto-follow.meta.js`。Tampermonkey 用户可对照下面的清单审计安装时弹窗。

### `@match`

- `*://live.bilibili.com/*` — 直播间页面，所有功能的运行场所。
- `*://space.bilibili.com/*` — 个人空间页，仅用于解析 / 验证 streamer UID（导出粉丝牌巡检数据时用到），不发任何弹幕。

### `@run-at`

- `document-start` — 在页面 JS 之前注入。这是为了让 `fetch-hijack.ts` 在 B 站自家 SDK 调用 `/msg/send` 之前完成 monkey-patch（用于跟车广播验证），不是为了越权读 cookie。

### `@connect`

显式列出（`vite.config.ts` line 27–47）：

| 域名 | 用途 |
|---|---|
| `bilibili-guard-room.vercel.app` | 直播间保安室，可选的巡检规则 / 摘要同步后端，用户必须自填 endpoint + sync key 才会被调用 |
| `localhost` | 仅开发期：cb-backend / radar-backend 的 `*UrlOverride` 指向 `http://localhost:8787 / 8788` |
| `sbhzm.cn` | 烂梗库社区源（灰泽满直播间等社区自建库），打开烂梗库面板时拉取 |
| `chatterbox-cloud.aijc-eric.workers.dev` | 自建烂梗库聚合后端（LAPLACE+SBHZM+社区贡献，硬审核），打开烂梗库面板时拉取 |
| `live-meme-radar.aijc-eric.workers.dev` | 跨房间 meme 雷达后端，烂梗库面板打开时拉一次今日 trending 列表给 🔥 徽章 |
| `api.anthropic.com` | LLM 智能辅助驾驶 / AI 规避，用户必须自填 API key 才会被调用 |
| `api.openai.com` | 同上，OpenAI 默认 endpoint |
| `*` | OpenAI 兼容自定义 base URL（DeepSeek / Moonshot / OpenRouter / Ollama / 小米 mimo 等）。**这是用户授权 LLM 的兜底**：之前没有兜底时 Tampermonkey 直接以 "domain is not a part of the @connect list" 拒绝、连权限弹窗都不会出。加 `*` 后 Tampermonkey 仍会在首次访问每个新域时弹一次用户确认 —— 这是人在闸门上的最后一道审批。如果你不放心，可在 Tampermonkey 设置里关闭"允许 `*` 通配"，本脚本只会失去 LLM 自定义 provider，其他功能不受影响。 |

### `@grant`

`vite-plugin-monkey` 通过 `import { ... } from '$'` 的静态扫描自动选择，最终 header 见 `dist/bilibili-live-wheel-auto-follow.meta.js`。摘要：

- `GM_getValue / GM_setValue / GM_deleteValue / GM_listValues`（含批量 `*Values`） — userscript 持久化（弹幕模板、自动跟车配置、UI 状态、巡检缓存等），见 `src/lib/gm-signal.ts`。
- `GM_addValueChangeListener / GM_removeValueChangeListener` — 多 tab 同步：B 站直播间多开时设置即时跨 tab 生效。
- `GM_xmlhttpRequest` — 走 GM 通道访问无 CORS 的第三方 API（`sbhzm.cn`、LLM provider、guard-room、radar 后端），见 `src/lib/gm-fetch.ts`。原生 `fetch` 仅用于 B 站自家 API（同源 / 已正确配 CORS）。
- `GM_addElement / GM_addStyle` — 注入弹幕助手浮动面板和 UnoCSS 样式表。
- `GM_registerMenuCommand / GM_unregisterMenuCommand` — Tampermonkey 菜单里的快捷开关。
- `GM_setClipboard` — 烂梗 / 弹幕模板的"复制"按钮（替代 `navigator.clipboard.writeText`，后者在 iframe 中常被禁用）。
- `GM_notification` — 自动跟车 / 巡检异常时的桌面提醒（用户可关）。
- `GM_openInTab` — "在新 tab 打开主播粉丝牌相关房间"等导航动作。
- `GM_info` — 读自身 `// @version`，给"关于"页和升级提示用。
- `GM_log` — 兜底诊断日志，正常路径走 `appendLog`（页内日志面板）。
- `GM_audio / GM_cookie / GM_download / GM_getResourceText / GM_getResourceURL / GM_getTab / GM_getTabs / GM_saveTab / GM_webRequest / GM_notification` — 部分由 `vite-plugin-monkey` 在静态分析阶段保守注入；并不全部走主路径。其中 `GM_cookie / GM_webRequest / GM_download` 当前没有功能依赖它们，是分析器对 `@grant` 的过度近似。如果你更激进地审计，可在 Tampermonkey 编辑器里逐项剥掉这几个未使用的 grant 来收紧 attack surface（未来某次升级可能重新需要 —— 升级提示会复现）。
- `unsafeWindow` — `fetch-hijack.ts` 必须在页面真实 window 上替换 `fetch`，才能拦截 B 站 SDK 的 `/msg/send` 完成跟车广播验证。Tampermonkey 沙箱版的 `window` 不会被 B 站脚本看见。

## 数据流（Data flow）

### 必须出站（Mandatory outbound）

这些是脚本的核心功能依赖，关闭即等于不能用：

- **B 站 HTTP API**（`api.live.bilibili.com`、`api.bilibili.com`，见 `src/lib/const.ts` 中 `BASE_URL.BILIBILI_*`）。读直播间元信息、解析粉丝牌、发弹幕。请求**复用浏览器当前 B 站会话**（cookie + CSRF），脚本不另存账号密钥。
- **B 站直播 WebSocket**（`@laplace.live/ws` 客户端，连接 `getDanmuInfo` 返回的 host_list 中的 `wss://...` 节点，见 `src/lib/live-ws-source.ts:490` 的 `new WebSocket(url)`）。读取直播间事件流（弹幕 / 礼物 / 进场）。这条链路的 token 由 B 站发，不上传任何用户数据。

### 可选出站（Opt-in / 默认 OFF）

- **`POST /radar/report` 到 live-meme-radar**（v2.13.0 起，2.13.1 起改成 server schema 对齐的 bucket-aggregate 形态；详见 `src/lib/radar-report.ts` 与 `src/lib/radar-client.ts` 的 `reportRadarObservation`）。
  - 入口：『设置 → 工具 → live-meme-radar 趋势上报』 toggle，对应 GM key `radarReportEnabled`，默认 `false`。
  - 节奏：每 60 秒 flush 一批；服务端单批硬上限 100 个 5 分钟桶（`REPORT_MAX_BUCKETS`），客户端在调用前裁到这个上限。
  - 匿名观众短路：`cachedSelfUid`（来自 `DedeUserID` cookie）为空时 toggle 也不会上报 —— 没有可哈希的 reporter 身份就不发。
  - Payload schema（`RadarReportPayload`，与 server `validateBucket` 对齐）：
    ```
    {
      reporter_uid: number,        // 观众自身公开 bili uid；server 端 hashUid+IP_HASH_SALT 后才落 D1
      client_version: string,      // userscript // @version（≤64 字符）
      buckets: [
        {
          bucket_ts: number,         // epoch 秒，必须 300 对齐
          room_id: number,           // 直播间号
          channel_uid: number,       // 主播本人公开 uid（=房间所有者），不是观众 / 发送者的 uid
          msg_count: number,         // 桶内观察到的弹幕条数
          distinct_uid_count: number // 桶内 distinct 发送者数量；server 拒掉 distinct > msg_count
        }
      ]
    }
    ```
  - **不再发送任何弹幕原文 / 单条 timestamp**：v2.13.0 的 `sampledTexts` 数组已退役，取而代之的是每个 5 分钟桶的两个计数字段。这一改在隐私上是严格的"减"操作 —— 文本样本不出门了，server 也没法事后回放观众读到了什么。
  - sender uid 只在客户端用于桶内 `distinctSenderUids: Set` 去重，**不放进 payload**；payload 里能反查到观众身份的字段只有 `reporter_uid`，并且 server 端在哈希前永远不会落 D1。
  - 切房间 / 关 toggle 立即丢未发的桶，不在用户改主意之后才发出去。
  - 失败一律静默（`reportRadarObservation` 内部 swallow），不影响其他功能。
- **Soniox STT WebSocket**（`@soniox/client` v2 ESM 包通过 `src/lib/soniox.ts` 注入 `<script type="module">` 动态 `import()` 加载，CDN 路径见 `SONIOX_CDN_URL`；首次"开始同传"时按需下载，不开同传就不下载）。
  - 入口：『同传』tab 自填 Soniox API key 并主动开始。
  - 数据：用户麦克风音频流 → Soniox 服务端，识别结果回到本机。脚本不持久化音频。
  - 完全可选，不开启则不加载麦克风、不连 Soniox。
- **LLM API 调用**（`api.anthropic.com` / `api.openai.com` / 用户自填 OpenAI 兼容 base URL，见 `src/lib/llm-driver.ts`、`src/lib/ai-evasion.ts`）。
  - 入口：用户必须填 API key 并主动开启 AI 规避 / 智能辅助驾驶才会触发。
  - Payload：当前要改写 / 决策的弹幕文本 + 必要上下文。脚本不主动把弹幕历史、cookie、账号信息塞进 prompt。
- **直播间保安室同步**（`bilibili-guard-room.vercel.app` 或用户自填 endpoint，见 `src/lib/guard-room-sync.ts`）。
  - 入口：用户填 endpoint + sync key 才会被调用。
  - Payload：巡检摘要 / 选定规则 / 影子屏蔽候选改写。**显式排除** cookie、CSRF、localStorage dump、完整 B 站接口响应。

### 默认开启但语义上是只读传感器（Always-on read，no user data uploaded）

- **`GET /radar/clusters/today` / `GET /radar/cluster-rank` / `GET /radar/amplifiers/today` 到 live-meme-radar**（见 `src/lib/radar-client.ts` 的 `fetchTodayRadar / queryClusterRank / fetchTopAmplifiers`）。烂梗库面板打开时后台拉一次今日 trending（10 分钟缓存）给 🔥 徽章用。**只读、聚合、不上传本地数据**。失败静默，徽章不出现，其他功能不受影响。
- **烂梗库梗源**（`sbhzm.cn`、`chatterbox-cloud.aijc-eric.workers.dev`、LAPLACE `workers.vrp.moe`，见 `src/lib/laplace-client.ts`、`src/lib/sbhzm-client.ts`、`src/lib/cb-backend-client.ts`）。打开烂梗库面板时拉梗列表 + 复制计数回报（仅梗 ID）。

### 永不出站（Never outbound）

- 弹幕历史 / 完整聊天 transcript（自定义 Chatterbox Chat 完全本地渲染）。
- **弹幕原文 / 单条 timestamp / 弹幕发送者 uid**（在 opt-in 的 `/radar/report` payload 里都不含 —— 只送 5 分钟桶的两个计数）。注：`/radar/report` payload 里**会**含登录观众自身的 `reporter_uid`，server 端 hashUid+IP_HASH_SALT 后才落 D1，原 uid 不进库；这点见上面 opt-in 段。
- 观众 uname / 头像。
- 浏览器 cookie / B 站 CSRF token / Tampermonkey GM storage dump。
- LocalStorage / GM storage 的整体导出内容（用户可手动导出 backup，见下面"本地存储"，但脚本绝不主动上传）。

### 本地存储（Local storage）

所有持久化设置都走 `gmSignal('<key>', default)` → `GM_getValue / GM_setValue`（见 `src/lib/gm-signal.ts`），**不写浏览器 `localStorage`**。设计原则是 userscript 设置应被 Tampermonkey 接管 / 备份，而不是混进 B 站宿主页面的 localStorage 命名空间。

按域分组（非穷举）：

- 弹幕模板与发送：`MsgTemplates`、`msgSendInterval`、`maxLength`、`activeTemplateIndex`…
- 自动跟车 / 智能辅助驾驶：`autoBlend*`（窗口、阈值、冷却、preset…）。
- Chatterbox Chat：`customChat*`（主题、自定义 CSS、显隐过滤…）。
- 粉丝牌巡检 + 保安室：`hzm*`、`guardRoom*`（含 `guardRoomSyncKey` —— **自填的密钥，导出时小心**）。
- 影子屏蔽：`shadowLearn*` 观察记录与候选改写。
- 同传：`sonioxApiKey`（**用户自填 API key**）、`sonioxLanguageHints`、`sonioxTranslationTarget`…
- LLM：provider 选择、自定义 base URL、API key（**自填**）。
- 雷达：`radarReportEnabled`（默认 `false`）、`radarBackendUrlOverride`（开发期）。

完整可导出键列表见 `src/lib/backup.ts` 的 `EXPORT_KEYS`。导入 / 导出按钮（设置 → 备份）使用同一份白名单 —— 导出文件**会包含**自填的 API key / sync key。请勿把导出 JSON 公开贴到 issue / 群聊。

## 第三方服务清单（Third-party services）

| 服务 | 用途 | 模式 | 失联 / 被屏蔽时的退化 |
|---|---|---|---|
| `api.live.bilibili.com` / `api.bilibili.com` | 直播间元信息、发弹幕、粉丝牌 | 必须 | 整个脚本不可用 |
| B 站直播 WSS（动态 host） | 实时弹幕 / 礼物事件流 | 必须 | 自定义 Chatterbox Chat / 跟车失能，DOM fallback 仍可用 |
| `unpkg.com`（动态 `<script type="module">`） | 加载 Soniox ESM 客户端 | 首次开同传时按需 | 同传 tab 不可用 |
| `cdn.jsdelivr.net`（`@require`） | 加载 SystemJS 运行时 | 安装时一次性 | 脚本无法 boot —— 装好后会缓存，运行时不再实时拉 |
| Soniox WSS | STT 识别 + 翻译 | opt-in，自填 key | 不开就不连 |
| `api.anthropic.com` / `api.openai.com` / 自定义 base URL | LLM 决策 / 改写 | opt-in，自填 key | 不开就不调；AI 规避退化为本地启发式 |
| `sbhzm.cn` | 社区烂梗库源 | 打开烂梗库面板时拉 | 该源消失，其他源仍可用 |
| `chatterbox-cloud.aijc-eric.workers.dev` | 自建烂梗库聚合后端 | 打开烂梗库面板时拉 | 同上 |
| `live-meme-radar.aijc-eric.workers.dev` | 跨房间 meme 雷达 | 默认只读拉，opt-in 上报 | 🔥 徽章不出现；上报静默丢弃 |
| `bilibili-guard-room.vercel.app`（或自填） | 巡检规则 / 摘要同步 | opt-in，自填 endpoint+key | 不填就不调 |
| Greasy Fork（`greasyfork.org`） | 安装与升级分发 | 安装 / 升级动作 | 用户需手动从 GitHub release 安装 |
| GitHub Pages / `aijc123.github.io` | 项目官网 | 用户主动访问 | 与脚本运行无关 |
| `workers.vrp.moe` | LAPLACE 烂梗库代理 | 打开烂梗库面板时拉 | 该源消失，其他源仍可用 |

## 依赖审计（Dependency audit）

- 运行时依赖只有 3 个：`@laplace.live/ws`、`@preact/signals`、`preact`（见 `package.json`）。Soniox SDK (`@soniox/client`) 装在 dev 依赖里仅供 `import type` 编译期使用；运行时按需从 `unpkg.com` 动态注入 `<script type="module">` 加载。
- **Dependabot** 每周一扫描 `bun` 与 `github-actions` 生态（见 `.github/dependabot.yml`），dev 依赖 minor / patch 自动合并组，preact 全家归组，`vite / vite-plugin-monkey / preact / typescript / @biomejs/biome` 的 major 升级显式忽略（升级前需手动评估 breaking change）。
- 每个 PR 触发 `.github/workflows/ci.yml`，跑 `bun run release:check` —— 即 biome ci + 客户端测试 + 服务端测试 + 版本一致性 + build + artifact 验证 + bundle 体积预算。release tag 走 `.github/workflows/release.yml` 单独流程。
- 项目当前**未启用 GitHub CodeQL / Snyk 等深度静态扫描**。这是一个已知缺口；外部研究员愿意贡献此类配置可直接发 PR。

## 已知不可避免的风险（Known unmitigated risks）

短而坦白的清单 —— 装这个脚本之前请知悉：

1. **Tampermonkey grants 是高权限**。本脚本的 `@grant` 可读写 cookie / 跨域 XHR / 注入 DOM / 操作剪贴板。如果维护者账号或发布管线被攻陷推送恶意更新，你的下次自动升级会安装它 —— 与所有其他流行 userscript 同病相怜，这是 userscript 模型的固有信任假设。缓解：可以在 Tampermonkey 里关掉自动更新，每次手动 diff `// @version` 之后再升级。
2. **`localStorage` / GM storage 是明文**。其他扩展 / 同机用户可读出弹幕模板、API key、sync key 等。请把高敏 API key 留给最小必要功能（例如 LLM 用临时低额度子 key）。
3. **Greasy Fork 安装链路信任 Greasy Fork 的 TLS 链**。即便链接是 HTTPS，安装动作本身把信任根放在 Greasy Fork 的证书与基础设施上。如果你需要更强保证，请改从 GitHub release 下载 `dist/bilibili-live-wheel-auto-follow.user.js` 并核对 commit / tag。
4. **`@connect *` 的兜底通配存在**。这是为支持 OpenAI 兼容自定义 provider（用户自填 base URL）才放的；Tampermonkey 仍会在首次访问每个新域时弹用户确认。不放心可在 Tampermonkey 设置里禁用 `*`，会失去自定义 LLM provider，其他功能不受影响。
5. **`document-start` 注入 + `unsafeWindow` 替换 `fetch`**。这是为了拦截 B 站 SDK 的 `/msg/send` 做跟车广播验证（见 `src/lib/fetch-hijack.ts`）。任何与本脚本协同 / 冲突的其他 userscript 也会看到被替换的 `fetch`，可能产生意料之外的交互。

---

如果你审计过程中发现本文档与实际代码行为不符（包括"Permissions"清单偏差、未列出的出站调用、文档声称只读但实际写入的 endpoint），请按"报告漏洞"流程上报 —— 文档失同步本身就是隐私 bug。
