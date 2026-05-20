# 弹幕助手 · 替你说,替你看

[![CI](https://github.com/aijc123/bilibili-live-wheel-auto-follow/actions/workflows/ci.yml/badge.svg)](https://github.com/aijc123/bilibili-live-wheel-auto-follow/actions/workflows/ci.yml)
[![Quality](https://github.com/aijc123/bilibili-live-wheel-auto-follow/actions/workflows/quality.yml/badge.svg)](https://github.com/aijc123/bilibili-live-wheel-auto-follow/actions/workflows/quality.yml)
[![Mutation](https://github.com/aijc123/bilibili-live-wheel-auto-follow/actions/workflows/mutation.yml/badge.svg)](https://github.com/aijc123/bilibili-live-wheel-auto-follow/actions/workflows/mutation.yml)
[![Gitleaks](https://github.com/aijc123/bilibili-live-wheel-auto-follow/actions/workflows/gitleaks.yml/badge.svg)](https://github.com/aijc123/bilibili-live-wheel-auto-follow/actions/workflows/gitleaks.yml)
[![codecov](https://codecov.io/gh/aijc123/bilibili-live-wheel-auto-follow/branch/master/graph/badge.svg)](https://codecov.io/gh/aijc123/bilibili-live-wheel-auto-follow)
[![Greasy Fork installs](https://img.shields.io/greasyfork/dt/574939?label=installs)](https://greasyfork.org/zh-CN/scripts/574939)
[![Greasy Fork version](https://img.shields.io/greasyfork/v/574939?label=greasy%20fork)](https://greasyfork.org/zh-CN/scripts/574939)
[![Bundle size](https://img.shields.io/github/size/aijc123/bilibili-live-wheel-auto-follow/dist/bilibili-live-wheel-auto-follow.user.js?label=userscript%20size)](https://github.com/aijc123/bilibili-live-wheel-auto-follow/blob/master/dist/bilibili-live-wheel-auto-follow.user.js)
[![Last commit](https://img.shields.io/github/last-commit/aijc123/bilibili-live-wheel-auto-follow)](https://github.com/aijc123/bilibili-live-wheel-auto-follow/commits/master)
[![License: AGPL-3.0](https://img.shields.io/github/license/aijc123/bilibili-live-wheel-auto-follow)](LICENSE)
[![Built with TypeScript](https://img.shields.io/badge/built_with-TypeScript-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-646cff?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Bun](https://img.shields.io/badge/Bun-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)

> **B站独轮车 + 自动跟车** — 在 B 站直播间替你说话，也替你看清弹幕。

**做给谁的**：每天泡 B 站直播间、在弹幕里特别活跃的观众。你发得多，所以经常被屏蔽 / 被禁言 / 被影子屏蔽 / 被主播拉黑——这个脚本帮你**发得更多更安全**，也帮你**看清自己今天在哪被禁了**。不是公会管理工具，不是直播间运营工具。

**血脉**：本脚本最初从 [LAPLACE Chatterbox](https://github.com/laplace-live/chatterbox) fork 而来，产品方向已经走得比较远。原 Chatterbox 的同传、烂梗库、弹幕替换、AI 规避、Chatterbox Chat 全部保留并继续演进，新增自动跟车、粉丝牌巡检、多源烂梗库和针对国内直播文化的影子屏蔽自动学习。如果 LAPLACE 有好的修复 / 功能，按需 cherry-pick。

项目链接：

- 官网：[aijc123.github.io/bilibili-live-wheel-auto-follow](https://aijc123.github.io/bilibili-live-wheel-auto-follow/)
- 安装：[Greasy Fork 脚本页](https://greasyfork.org/zh-CN/scripts/574939-b%E7%AB%99%E7%8B%AC%E8%BD%AE%E8%BD%A6-%E8%87%AA%E5%8A%A8%E8%B7%9F%E8%BD%A6)
- 源码：[GitHub](https://github.com/aijc123/bilibili-live-wheel-auto-follow)
- 反馈：[GitHub Issues](https://github.com/aijc123/bilibili-live-wheel-auto-follow/issues)

常见搜索词：B站独轮车、B站自动跟车、哔哩哔哩直播弹幕助手、Bilibili Live Auto Follow、Tampermonkey bilibili live userscript、Chatterbox Chat。

## 项目做什么

安装后，B 站直播间页面右下角会出现 `弹幕助手` 按钮。它做两件事：

### 替你说（发送类，主要）

- **独轮车循环发送**：多行模板循环发送，支持固定/随机间隔、随机颜色、随机字符，长弹幕自动拆分。
- **自动跟车**：识别短时间内被多人重复发送的弹幕，按阈值和冷却自动跟一句，发送后等 WS/DOM 回显确认；三档预设 + 自定义。试运行模式默认开启，主动切到真发。
- **手动发送**：手动一句弹幕；可选 AI 润色（用你自己的 prompt 改写）；影子屏蔽时自动给改写候选。

### 替你看（阅读类，辅助）

- **Chatterbox Chat**：接管右侧评论区，WS 主路 + DOM 兜底，深色模式自动适配，断线自动重连，状态圆点指示，自定义 CSS 走 sanitizer。
- **粉丝牌禁言巡检**：一键看自己在哪些关联直播间被禁言、被屏蔽、被风控、主播注销——重度观众的"健康检查"。

其余特性（智能辅助驾驶、多源烂梗库、同传翻译、LLM 多 provider、影子屏蔽自动学习、保安室 / 监控室代理跨房间同步、+1 等）→ 详见 [使用指南](docs/user-guide.md)。

这是民间自用/自制插件，不是 B 站官方功能。自动化功能（独轮车、自动跟车、智驾、自动重发）默认走试运行（只看不发），由你主动切到真发；请控制频率，避免打扰主播和其他观众。

## 安装步骤

1. 先安装一个用户脚本管理器：

   - [Tampermonkey](https://www.tampermonkey.net/)
   - [Violentmonkey](https://violentmonkey.github.io/)

2. 打开 [Greasy Fork 脚本页](https://greasyfork.org/zh-CN/scripts/574939-b%E7%AB%99%E7%8B%AC%E8%BD%AE%E8%BD%A6-%E8%87%AA%E5%8A%A8%E8%B7%9F%E8%BD%A6)。

3. 点击安装，并在脚本管理器弹出的页面里确认。

4. 打开任意 B 站直播间：

   ```text
   https://live.bilibili.com/
   ```

5. 点击页面右下角的 `弹幕助手` 按钮，按需开启发送、自动跟车、Chatterbox Chat、巡检或其他功能。

本地构建安装：

```bash
bun install
bun run build
```

然后用脚本管理器安装 `dist/bilibili-live-wheel-auto-follow.user.js`。

## 权限说明

当前脚本元信息里会请求这些权限：

- `@match *://live.bilibili.com/*`：只在 B 站直播间页面运行。
- `@run-at document-start`：尽早启动，方便准备样式隔离、UI 挂载和聊天适配。
- `GM_addStyle`：向页面注入弹幕助手和 Chatterbox Chat 的隔离样式。
- `GM_getValue` / `GM_setValue` / `GM_deleteValue`：在脚本管理器本地存储设置、模板、替换规则、观察记录和上次巡检结果。
- `GM_info`：读取脚本版本等元信息。
- `unsafeWindow`：在必要时与 B 站页面上下文交互，读取页面状态或桥接页面行为。

### `@connect` 外部域分类

脚本管理器会在**首次访问每个新域**时单独弹窗确认。下表按用途分组——如果你不开对应功能，那一域就不会被访问。

**必要（默认开，基础功能依赖）**

| 域 | 用途 |
|---|---|
| `chatterbox-cloud.aijc-eric.workers.dev` | 烂梗库默认聚合后端（本仓库 `server/` 自建，聚合 LAPLACE+SBHZM+社区贡献）；可在设置里通过 `cbBackendUrlOverride` 指向自有部署 |
| `workers.vrp.moe` | LAPLACE 的替换规则源 + 烂梗库源 |
| `edge-workers.laplace.cn` | LAPLACE AI 规避检查（影子屏蔽后台机制） |

**可选烂梗库 / 雷达源**

| 域 | 用途 |
|---|---|
| `sbhzm.cn` | 灰泽满直播间烂梗库（社区自建） |
| `live-meme-radar.aijc-eric.workers.dev` | [live-meme-radar](https://live-meme-radar.pages.dev) 传感器后端；用于跨房间热门梗 🔥 徽章和可选趋势上报。详见下面的「传感器（live-meme-radar）」小节 |

**LLM（填 key 才会用，主要服务 AI 润色 / AI 规避 / 智驾 LLM 选梗）**

| 域 | 用途 |
|---|---|
| `api.anthropic.com` | Anthropic Claude |
| `api.openai.com` | OpenAI GPT |
| `*`（兜底） | OpenAI 兼容的自填 base URL（DeepSeek / Moonshot / OpenRouter / Ollama / 小米 mimo 等）。脚本管理器首次访问每个新域仍会单独弹窗确认，这是这些自定义 LLM 调用的最后一道闸门 |

**同传 / 语音识别（启用同传才会用）**

| 域 | 用途 |
|---|---|
| `api.soniox.com` | Soniox 语音识别 API |
| `unpkg.com` | 加载 Soniox 浏览器客户端（`@require`） |

**本地开发 / 多房间挂机（可选）**

| 域 | 用途 |
|---|---|
| `localhost` | 本地自托管后端测试（`bun run dev` of `server/`） |
| `bilibili-guard-room.vercel.app` | 多房间观察台云同步（可选）；同时挂多个直播间 / 多设备的用户用来跨实例同步预设、状态、心跳。普通单房间用户不需要开启 |

## 隐私和数据流说明

大部分数据只保存在你的浏览器里，由脚本管理器本地存储：

- 弹幕模板和发送设置。
- 自动跟车配置。
- 本地全局规则和房间规则。
- Chatterbox Chat 主题、自定义 CSS 和偏好。
- 粉丝牌巡检缓存。
- 影子屏蔽观察记录和候选改写。

可能发生的网络数据流：

- B 站接口和 WebSocket：用于读取直播间事件、发送弹幕、获取当前账号相关粉丝牌房间信息、判断房间状态。这些请求使用你浏览器当前的 B 站登录会话。
- Soniox：仅在启用并使用同传/语音识别时涉及音频识别能力。
- 多房间观察台云同步（直播间保安室）：完全可选，只为同时挂多个直播间 / 多设备的用户准备。开启后只同步巡检摘要或选定规则，不应上传 cookie、csrf、localStorage 或完整 B 站接口响应。
- 烂梗库梗源（`sbhzm.cn` 社区库 / `chatterbox-cloud.aijc-eric.workers.dev` 自建聚合后端）：仅在打开烂梗库或社区贡献时拉取梗列表；可在设置里改成自部署地址或关闭该功能。
- live-meme-radar 传感器（`live-meme-radar.aijc-eric.workers.dev`）：烂梗库面板打开时后台只读拉一次 trending 列表给 🔥 徽章用，每 10 分钟最多一次，不上传任何本地数据。详见下面的"传感器（live-meme-radar）"小节。
- LLM 智能辅助驾驶（`api.anthropic.com`、`api.openai.com`，以及任何你自填的 OpenAI 兼容 base URL）：仅在你填入 API key 并主动开启 AI 规避/改写时才会调用，prompt 内容只包含当前要改写的弹幕和必要上下文。
- GitHub Pages / Greasy Fork：用于托管官网、发布产物和安装页面。
- unpkg：用于加载 Soniox 浏览器端客户端。

不要在 issue、截图或导出的配置里公开 cookie、csrf token、账号密钥、localStorage dump、私人房间规则或私有同步地址。

## 传感器（live-meme-radar）

[live-meme-radar](https://live-meme-radar.pages.dev) 是与本项目分离的只读"meme 雷达"传感器：它消化几十个直播间的弹幕、聚类成跨房间 meme，把"今天哪些梗在多个房间同时刷起来"的信号开放给 userscript。它本身**不发送弹幕**，只读、聚合、暴露公开 API。

userscript 把雷达数据用作烂梗库的辅助标记：打开烂梗库面板时，后台异步拉一次 `GET /radar/clusters/today`（10 分钟内存缓存），命中"今日跨房间热门"的梗在烂梗库面板里多一个 🔥 小徽章 + tooltip "今日第 N 位"。**没有用户设置开关、不影响自动跟车，雷达失联时只是徽章不出现，烂梗库本身不受影响。**

请求走 `GM_xmlhttpRequest`（绕开浏览器 CORS），失败一律静默。当前版本不会把本房间任何数据上传到 radar；本地 userscript 只读取雷达发布的聚合统计。更多 radar 项目细节、自部署指南、API 形态请见：<https://live-meme-radar.pages.dev>。

开启『设置 → 工具 → live-meme-radar 趋势上报』(`radarReportEnabled`, 默认关闭) 后,脚本会按 60 秒一批向 `/radar/report` 上报本房间命中已知 trending 簇的去重弹幕样本(单批 ≤30 条,单条 ≤200 字),仅含房间号 / 主播公开 ID / 样本文本 / 窗口起止时间戳,不含任何观众或发送者 uid / uname / 头像 / 单条时间戳。切房间或关掉 toggle 立即丢未发的 buffer。

## 常见问题和排障

- 看不到 `弹幕助手` 按钮：确认脚本已安装并启用，然后刷新 `https://live.bilibili.com/...` 直播间页面。
- 安装后没有更新：到 Tampermonkey/Violentmonkey 管理面板里手动检查更新，或从 Greasy Fork 重新安装。
- 弹幕发送失败：确认已登录 B 站、直播间允许发弹幕、账号状态正常、消息没有过长、没有使用无权限表情，也没有被风控或屏蔽。
- 自动跟车不触发：检查预设、阈值、冷却时间、唯一用户判断和融入黑名单；也可能是直播间没有达到重复条件。
- Chatterbox Chat 没内容：刷新页面，确认直播间确实有弹幕流；临时关闭自定义 CSS，排除样式把内容隐藏的情况。
- 粉丝牌巡检结果显示未知：可能是登录状态、接口限流、主播注销、网络错误或 B 站接口变动；稍后重试。
- 同传/语音识别不可用：检查浏览器麦克风权限、网络是否能访问 unpkg 和 Soniox 相关资源。
- 影子屏蔽候选没有自动发出：这是默认“只给候选”模式的正常行为。需要自动重发时，要明确开启“自动重发”模式和 AI 规避。

## 支持的浏览器和脚本管理器

构建产物以 `ES2022` 为目标（见 `tsconfig.app.json`），需要支持 `Promise.any`、私有类字段、可选链、空值合并等特性。下列组合是项目主线测试覆盖的范围：

- **桌面 Chrome/Edge ≥ 105** + Tampermonkey ≥ 4.18 / Violentmonkey ≥ 2.18：基线，所有功能可用。
- **桌面 Firefox ≥ 110** + Violentmonkey ≥ 2.18：可用，部分 `-webkit-*` 视觉效果会优雅降级（如背景模糊）。
- **桌面 Safari ≥ 15.1** + Tampermonkey：可用，但 B 站对 Safari 的支持本身有限，建议优先 Chrome/Firefox。
- **桌面 Chrome/Edge < 105**、**Firefox < 110**、**Safari < 15.1**、**任何 IE**、**移动端浏览器**：未测试，可能能跑也可能直接抛错。脚本里多处依赖 `AbortSignal` 监听器、`MutationObserver`、现代 CSS（`color-mix`、`backdrop-filter`），都需要相对新的引擎。

## 已知限制

- B 站页面结构、接口、风控策略和 WebSocket 数据格式可能随时变化。
- 高流量直播间里，DOM 兜底解析可能漏掉部分事件，广播验证也可能因为延迟出现误判。
- 自动发送、自动跟车和自动重发都可能被 B 站限流、屏蔽或风控。
- 影子屏蔽检测是启发式判断，不能百分百区分网络延迟、房间行为和真实屏蔽。
- 替换规则和 AI 规避不能保证每条弹幕都能通过审核。
- 同传准确率受麦克风质量、浏览器支持和 Soniox 服务可用性影响。
- 主要测试路径是桌面浏览器加 Tampermonkey/Violentmonkey，移动端和小众脚本管理器不保证体验一致。脚本会在检测到移动端 UA 时自动收起入口按钮并在控制台留一行警告，但不会拦截手动启用。

## 如何反馈 bug

请到 [GitHub Issues](https://github.com/aijc123/bilibili-live-wheel-auto-follow/issues) 反馈。

建议包含：

- 已安装脚本版本。
- 浏览器名称和版本。
- 脚本管理器名称和版本。
- 直播间 URL 或房间号，如果方便公开。
- 你原本预期发生什么。
- 实际发生了什么。
- 稳定复现步骤。
- 控制台报错、截图或相关日志。
- 关闭自定义 CSS 并刷新后是否仍然复现。

不要提交 cookie、csrf token、账号密钥、localStorage dump、私人规则导出或其他敏感信息。

## 更多文档

- [使用指南](docs/user-guide.md)
- [分支保护说明](docs/branch-protection.md)

## 开发

```bash
bun install
bun run dev
bun run build
```

常用检查：

```bash
bun test
bun run release:check
```

## 发版

```bash
bun run release:patch
```

也支持：

```bash
bun run release:minor
bun run release:major
```

发布脚本会运行检查、构建、提交 `Release x.y.z`、创建 tag、推送、创建 GitHub Release、部署 GitHub Pages，并等待线上 userscript 的 `@version` 更新。

## License

AGPL-3.0
