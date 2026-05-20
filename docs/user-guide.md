# 使用指南

这份文档面向 B 站直播间用户，说明 B站独轮车 + 自动跟车的用途、安装方式、主要功能、权限、隐私数据流、排障方式、已知限制和 bug 反馈方式。

## 项目做什么

B站独轮车 + 自动跟车是一个运行在 B 站直播间页面的 userscript。安装后，直播间页面会出现 `弹幕助手` 按钮。它可以帮你循环发送预设弹幕、自动跟随直播间里被多人重复发送的弹幕、接管右侧评论区、巡检粉丝牌房间状态、维护替换规则、处理疑似影子屏蔽、使用同传/翻译和烂梗库。

它不是 B 站官方功能。请控制自动发送频率，避免影响直播间秩序。

## 安装步骤

1. 安装脚本管理器：

   - [Tampermonkey](https://www.tampermonkey.net/)
   - [Violentmonkey](https://violentmonkey.github.io/)

2. 打开 [Greasy Fork 脚本页](https://greasyfork.org/zh-CN/scripts/574939-b%E7%AB%99%E7%8B%AC%E8%BD%AE%E8%BD%A6-%E8%87%AA%E5%8A%A8%E8%B7%9F%E8%BD%A6)。

3. 点击安装，并在脚本管理器页面确认。

4. 打开 `https://live.bilibili.com/` 下的任意直播间。

5. 点击 `弹幕助手`，按需开启功能。

本地构建安装：

```bash
bun install
bun run build
```

然后安装 `dist/bilibili-live-wheel-auto-follow.user.js`。

## 主要功能

### 独轮车循环发送

- 支持多套弹幕模板，每行一句自动循环发送。
- 支持固定间隔、随机间隔、随机颜色和随机字符。
- 超过字数会自动拆分，减少单条过长导致的发送失败。
- 可记住当前直播间的开关状态，适合常驻房间使用。

### 自动跟车

- 自动观察直播间弹幕，识别短时间内被多人重复发送的内容。
- 命中阈值后自动跟上一句，并带冷却时间，避免过度刷屏。
- 提供 `稳一点`、`正常`、`热闹` 三档预设，可一键切到「自定义」保留当前数值并展开高级参数。
- 面板会显示当前状态、候选弹幕和上次跟车内容。
- 可在 B 站弹幕菜单里把用户加入融入黑名单，自动跟车会忽略这些用户。
- 发送前会识别平台锁定的表情，权限不足时直接阻止并提示原因。
- 发送后会等 WebSocket / DOM 回显确认弹幕真的广播出去；接口返回 200 但没回显时，会以 ⚠️ 标记疑似影子屏蔽，并触发候选改写流程。

### 智能辅助驾驶（HZM Auto-Drive）

- 按节奏自动从烂梗库挑梗发送，与文字独轮车、自动跟车共用同一个发送队列，不会冲突；同时启用会叠加每分钟发送量。
- 两种选梗模式：
  - **启发式**：按 tag 白名单 / 黑名单、`copy_count`、最近发送去重打分。
  - **LLM**：默认每 N 次 tick 调一次 LLM（其余仍走启发式），支持 Anthropic、OpenAI、OpenAI 兼容自填 base URL（DeepSeek、Moonshot、OpenRouter、Ollama、小米 mimo 等）；未填 API Key 时自动回退启发式。
- 活跃度门槛：在最近 N 秒里至少看到 X 条弹幕、Y 个不同用户才会跟。
- 暂停关键词：命中后 60s 内不发；每分钟限速；每日发送 / LLM 调用计数。
- `dryRun` 模式只在面板日志里展示候选，不真发，方便调参。

### Chatterbox Chat 评论区

- 可接管 B 站直播间右侧评论区和发送框。
- 支持直连 B 站直播 WebSocket 获取弹幕、礼物、醒目留言、舰队、进场、关注、点赞、分享等事件，并保留 DOM 兜底解析。
- 状态指示：连接正常时显示绿色圆点，连接中显示橙色脉冲动画，降级或告警时显示橙色；WS 断线后浏览器 tab 切回前台会立即重连。
- 消息旁支持偷弹幕、+1、复制，可设置发送前确认，减少误触。
- 内置搜索、筛选、清屏、未读提示、性能调试信息和消息数量上限。
- 支持 `iMessage Dark` / `iMessage Light` / `Compact Bubble` 三个内置主题，外加奶绿 iMessage 一键 CSS 预设；自定义 CSS 走 sanitizer，自动剔除 `@import`、`url(javascript:|data:text/html|...)`、`expression()`、`behavior:` 等结构并强制 256 KB 长度上限。
- 表情选择器走 portal 渲染，避开 `backdrop-filter` 容器遮挡，懒加载表情包。

### 粉丝牌禁言巡检

- 一键读取当前账号粉丝牌关联的直播间，不发送弹幕。
- 按限制、无法确认、主播已注销、正常自动分类和排序。
- 支持点击统计项筛选异常、限制、未知、主播注销、正常或全部结果。
- 支持复制巡检结果，便于保存或反馈问题。
- 可选同步到独立项目「直播间保安室」，只上传巡检摘要，不上传 cookie、csrf、localStorage 或完整接口响应；可选订阅控制 profile，由保安室下发 dry-run、心跳频率、热度阈值等参数；保安室还能用 URL 查询参数接管直播页（`?guard_room_source=guard-room&guard_room_mode=dry-run&guard_room_autostart=1`）。
- 自动保留上一次巡检结果，刷新页面后也能继续查看。

### 替换规则、AI 规避和影子屏蔽处理

- 在插件面板或 Chatterbox Chat 输入框里直接发弹幕，支持 Enter 发送。
- 支持云端替换规则、本地全局替换规则和当前房间替换规则；云端关键词带数量与长度上限，异常配置不会塞爆替换链。
- 可测试替换词是否仍会触发屏蔽，方便维护房间专属规则。
- 默认「只给候选」模式：检测到疑似影子屏蔽后，输入框旁会出现候选改写气泡（不可见连接符 / 中间插「口」/ 全角空格三种策略），点选才发，不自动重发。
- 可选「自动重发」模式：需要同时开启 AI 规避，脚本才会调 LLM 改写并自动重发。
- 可选「自动学习房间规则」：成功用 AI 改写绕过屏蔽时，自动把 `(原词 → 替换词)` 写进当前房间规则，下次直接用规则跳过 LLM 调用；设置页保留观察记录列表。

### 多源烂梗库

- 烂梗面板优先从 chatterbox-cloud 自建后端拉取聚合数据（LAPLACE + SBHZM + 社区贡献），后端不可用时自动降级到本地直拉 LAPLACE / SBHZM。
- 直播间专属源：进入注册过的房间（如灰泽满直播间）会同时加载该房间的社区库，支持来源筛选、来源标记和 tag 聚合筛选。
- 高级用户可通过 `userMemeSources` GM 存储入口给任意房间注入自定义源，会覆盖同房间的内置默认。
- 候选梗贡献：脚本可根据直播间弹幕自动挖掘待贡献梗，支持自动拉取 tag 字典、按内容推断 tag、关键词推荐、自定义 tag、重复识别。
- 一键提交到 chatterbox-cloud 或对应社区库，并把复制次数回报上去。

### LLM 智能辅助（AI 规避 / 改写）

- 默认关闭，必须自己填 API key 才会被调用；prompt 里只会包含当前要改写的弹幕和必要上下文，不会带 cookie、csrf 或私人数据。
- 支持三种 provider：
  - `anthropic` → `https://api.anthropic.com/v1/messages`
  - `openai` → `https://api.openai.com/v1/chat/completions`
  - `openai-compat` → 自填 base URL，OpenAI 兼容（DeepSeek、Moonshot、OpenRouter、Ollama、小米 mimo 等）
- 三类调用入口：
  - 影子屏蔽自动改写（需要同时开「自动重发」+「AI 规避」）
  - 「自动学习房间规则」沉淀到本地，下次直接命中规则跳过 LLM
  - 智能辅助驾驶 LLM 选梗模式

### 同传与翻译

- 接入 Soniox 语音识别，支持识别后自动发送弹幕。
- 支持实时翻译结果发送。

### 小面板 UI

- 主入口含「发送 / 同传 / 设置 / 关于」四个 tab；发送 tab 标签会按状态加 `· 车 / · 跟 / ⚠️` 提示，同传 tab 加 `· 开`，WS 断线时整行加一条 `⚠️ 直播 WS 已断开 · 已退回 DOM 抓取（高峰期可能漏事件）` 提示条。
- 面板宽度适合 B 站直播间右侧区域，最多占屏幕高度一半；内容多时在面板内部滚动；折叠功能区后高度会自动变短。
- 设置页支持关键词搜索，能快速过滤主题、保安室、CSS、备份、影子屏蔽观察等配置分组。
- 首次打开面板会显示轻量引导，可一键套用新手配置。
- 系统配深色主题时面板会自动切深色配色；按 Esc 直接关闭浮窗，按钮 / 复选框 / tab 都带可见聚焦环。
- 设置页提供备份导出 / 导入：导入会按字段做类型校验，跳过格式不匹配项，拒绝高于当前支持的版本。

## 权限说明

- `@match *://live.bilibili.com/*`：只在 B 站直播间运行。
- `@connect`：脚本会请求脚本管理器允许它访问以下域，每一项都对应一个具体功能；脚本管理器在首次访问每个新域时仍会单独弹窗确认：
  - `bilibili-guard-room.vercel.app`：可选的直播间保安室同步。
  - `localhost`：本地开发和自托管后端测试。
  - `sbhzm.cn`：烂梗库专属梗源（社区自建库）。
  - `chatterbox-cloud.aijc-eric.workers.dev`：自建后端，聚合 LAPLACE+SBHZM+社区贡献的梗库；可在设置里改成自部署地址。
  - `api.anthropic.com`、`api.openai.com`：智能辅助驾驶 LLM 默认 provider，仅在你填入 API key 并主动启用 AI 规避/改写时才会调用。
  - `*`：兜底项，让你能填入 OpenAI 兼容的自定义 base URL（DeepSeek、Moonshot、OpenRouter、Ollama、小米 mimo 等）。脚本管理器在首次访问每个新域时仍会单独确认。
- `GM_addStyle`：注入弹幕助手和 Chatterbox Chat 样式。
- `GM_getValue`、`GM_setValue`、`GM_deleteValue`：在本地保存配置、模板、规则和缓存。
- `GM_info`：读取脚本元信息。
- `unsafeWindow`：必要时与 B 站页面上下文交互。
- `@run-at document-start`：尽早启动，保证 UI、样式和聊天适配能及时准备。

## 隐私和数据流说明

默认保存在本地的数据：

- 弹幕模板、发送设置和自动跟车配置。
- 本地替换规则和房间规则。
- Chatterbox Chat 设置和自定义 CSS。
- 粉丝牌巡检缓存。
- 影子屏蔽观察记录和候选改写。

可能访问的外部服务：

- B 站接口和 WebSocket：读取直播间事件、发送弹幕、获取粉丝牌相关房间信息和房间状态。
- Soniox：仅在你启用并使用语音识别时参与。
- 直播间保安室：完全可选，只同步摘要或选定规则，不上传 cookie、csrf、localStorage 或完整接口响应。
- 烂梗库梗源（`sbhzm.cn`、`chatterbox-cloud.aijc-eric.workers.dev`）：仅在打开烂梗库或社区贡献时拉取梗列表，可在设置里改成自部署地址或关闭。
- LLM 智能辅助驾驶（`api.anthropic.com`、`api.openai.com`，以及你自填的 OpenAI 兼容 base URL）：仅在你填入 API key 并主动开启 AI 规避/改写时才会调用。
- **live-meme-radar 趋势上报** (`radarReportEnabled`,可在『设置 → 工具』开启,默认关闭): 脚本会按 60 秒一批向 live-meme-radar 后端上报本房间命中已知 trending 簇的去重弹幕样本(单批 ≤30 条,单条 ≤200 字),帮助改进跨房间热门梗检测。仅含房间号 / 主播公开 ID / 样本文本 / 窗口起止时间戳,不含观众或发送者 uid / uname / 头像 / 单条时间戳。切房间或关 toggle 立即丢未发的 buffer。
- GitHub Pages、Greasy Fork、unpkg：用于官网、安装和依赖资源加载。

反馈问题时不要公开 cookie、csrf token、账号密钥、localStorage dump、私人规则或私有同步地址。

## 常见问题和排障

- 看不到按钮：确认脚本启用，刷新 B 站直播间页面。
- 无法更新：在脚本管理器里手动检查更新，或从 Greasy Fork 重新安装。
- 发不出弹幕：检查登录状态、直播间权限、账号状态、弹幕长度、锁定表情权限和风控提示。
- 自动跟车不工作：检查阈值、冷却、唯一用户要求、黑名单和当前直播间弹幕重复情况。
- Chatterbox Chat 空白：刷新页面，确认原生弹幕区有内容，临时关闭自定义 CSS。
- 巡检结果未知：可能是接口限流、网络错误、主播注销或 B 站接口变化，稍后重试。
- 同传不可用：检查麦克风权限、浏览器支持，以及 unpkg/Soniox 资源是否能加载。
- 候选改写不自动发送：默认就是只展示候选。自动重发需要你明确开启对应模式。

## 已知限制

- B 站页面和接口变化可能导致功能失效。
- 高流量直播间可能影响事件解析和广播验证。
- 自动发送可能被 B 站限流或风控。
- 影子屏蔽检测不是绝对准确。
- 替换规则和 AI 规避不能保证绕过所有审核。
- 同传质量受麦克风、浏览器和 Soniox 服务影响。
- 主要测试环境是桌面浏览器加 Tampermonkey/Violentmonkey。

## 如何反馈 bug

请到 [GitHub Issues](https://github.com/aijc123/bilibili-live-wheel-auto-follow/issues) 提交问题。

请尽量提供：

- 脚本版本。
- 浏览器和脚本管理器版本。
- 直播间 URL 或房间号，如果方便公开。
- 复现步骤。
- 预期结果。
- 实际结果。
- 控制台报错、截图或日志。
- 关闭自定义 CSS 并刷新后是否仍复现。

不要提交 cookie、csrf token、账号密钥、localStorage dump、私人规则或其他敏感信息。
