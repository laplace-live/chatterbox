# Greasy Fork Release Notes

## Greasy Fork 脚本简介

**B站独轮车 + 自动跟车 · 弹幕助手** —— 替你说，替你看。

给每天泡 B 站直播间、在弹幕里特别活跃的观众。你发得多，所以经常被屏蔽 / 被禁言 / 被影子屏蔽 / 被主播拉黑——这个脚本帮你**发得更多更安全**，也帮你**看清自己今天在哪被禁了**。不是公会管理工具，不是直播间运营工具。

- **替你说**：独轮车循环 · 自动跟车 · 手动发送 + AI 润色 · 影子屏蔽自动改写
- **替你看**：Chatterbox Chat 接管右侧评论区 · 粉丝牌禁言巡检 · 同传 + 烂梗库

适用 Tampermonkey、Violentmonkey 等用户脚本管理器。装完进 B 站直播间，右下角的「弹幕助手」按钮就是入口。

## 当前发布说明

- **新增「仅音频模式」**：面板顶部加了个 speaker 图标，关闭态灰、开启态粉。打开后停掉 B 站原生视频流，改成只听音频——带宽节省约 90%，多房间挂机时笔记本不烤机。Tampermonkey 菜单也注册了「切换仅音频模式」命令，全屏 / 重度用户用得上。Cherry-pick 自 upstream chatterbox。
- **新增「AI 陪聊（候选）」**：跟「同传」并列，都做「手动发送」的支持功能。配好 LLM key 之后，AI 听主播 STT + 房间弹幕，生成上下文相关的候选弹幕放队列里，**每条都要你点确认才发**。没有"自动发送"开关——LLM 输出有统计指纹，怕 B 站日后上 LLM 检测让你被 ban 更狠，这条线主动放弃。4 个 persona：杠精 / 吐槽役 / 暖男 / 互动派，自己挑。
- **三档 AI 润色默认 prompt 可见**：手动发送 / 自动跟车 / 独轮车 三档的默认 prompt 之前只在 runtime fallback 里悄悄兜底，编辑器是空的，用户看不到。现在跟 AI 候选的 4 个 persona 一样 seed 进编辑器——打开「设置 → LLM 提示词」就能看到、编辑、删除，开箱即用。
- **发送间隔抖动改成高斯分布**：原来的 0–500ms 均匀随机减法换成 σ=10% 钟形分布（±2σ 截断）。均匀随机在窄窗口下本身就是个指纹，钟形分布更贴近真人节奏——独轮车 / 自动跟车 / 智驾 都受益，反检测白送一层。Cherry-pick 自 upstream chatterbox。
- **聊天面板视觉升级**：新增 `MIDNIGHT_INDIGO` 深色预设；SC 外发光改成 CSS 变量（presets 可以再 tint 颜色）；SC 置顶条改成横向轮播 + reader-focused 时长 + 3 种输入模态；4px 基线网格 + 入场动画。深色模式更耐看。
- **「我的状态」一目了然**：粉丝牌巡检结果浓缩成 iOS 风角标（被禁的房间数显示为红色 ×N sticker），主面板第一眼就看到今天哪些房间禁了你——之前要展开整个粉丝牌巡检面板才看得到。
- **LLM 5 厂商一键预设**：Anthropic / OpenAI / DeepSeek / Moonshot / OpenRouter 一键填好 base URL + 默认模型，省去翻接入文档。AI 润色 / AI 规避 / 智驾 都共用同一份 LLM 配置。
- **手动发送 + AI 润色（命名清理）**：「常规发送」改名「手动发送」；YOLO 改名「AI 润色」——新名字更直白。替换规则 + 几个偏门 section 从设置抽屉里背景化（搜索仍能搜到）；设置搜索框移除，外部点击直接关面板。
- **修复**：软连字符插入不再撞坏 `[doge]` 这种表情包括号（cherry-pick from upstream）；CDN 懒加载脚本失败时正确清缓存允许重试（PR review 抓到的 P2 bug）；landing 页若干 SEO 标题被拆散结构修正（`B站独轮车 + 自动跟车 插件`）。

## 2.14.0

- **面板彻底重构**：设计基线——用户进直播间只想做一件事，替我说话。所有 UI 围绕这件事重新组织。
- **撤掉顶部 4 Tab**：原来的「发送 / 同传 / 设置 / 关于」上方切换栏全部移除。产品只有一个主上下文，把配件做成同等地位的 Tab 是把心智成本转嫁给用户。
- **三张归属式核心卡 + 抽屉式设置**：主页变成单页瀑布——独轮车 / 自动跟车 / 普通发送三张主卡，烂梗库 / 智驾 / 同传 等配件视觉上从属于它们服务的核心原语。设置和关于变成全屏抽屉，由顶部「← 返回」退出。
- **设置默认精简**：5 项常用（Chatterbox Chat / +1 直接动作 / 布局 / 表情 / 备份）直接可见；10+ 项高级（智能识别 / 替换规则 / 影子屏蔽 / LLM / 粉丝牌巡检 / 后端 / 雷达 / 日志）藏在「▸ 显示高级设置」之后。搜索框跨所有 section，需要时永远能找到。
- **新的顶部状态栏**：常驻显示「弹幕助手 · 房间号 · 活跃功能 chip」。WS 健康时不显示任何状态——除非有事让用户做，否则别出现；断开时才露红色「↻ 重连」按钮。房间号第一眼就有，不等后台任务。
- **折叠动画 iOS 风**：所有 `<details>` 240ms 滑动展开，关闭略快——更果断；chevron 用 Apple 标准 cubic-bezier 同步旋转。烂梗库 / 智驾的嵌套 toggle 合并为单层入口。
- **多发送源风险提示**：开第二个自动发送源（独轮车 + 自动跟车 / 智驾叠加）时弹一次 toast 提醒可能触发风控。
- **Esc 两段式**：在抽屉里按 Esc 回主页；主页按 Esc 关面板；输入框聚焦时 Esc 仍走默认行为。
- **修复**：连上 WS 后顶栏仍显示「未连」（值类型 typo，`'open'` → `'live'`）；HMR / 缓存导致 toggle 按压无挤压动画（同一份 PANEL_STYLE 被叠了多份）；IPv6 字面量 URL 被钓鱼警告误标。
- **测试**：新增 26 条回归测试覆盖 PanelHeader 状态显示 / WS 重连 / details 动画 CSS / installPanelStyles 幂等性，把这次的 UX 决策锁进 CI。

## 2.13.12

- **测试补齐**：v2.13.11 一口气改了 22 个文件 1400 多行业务逻辑但零测试，patch coverage 37.58%。本版补 +58 个回归测试覆盖 v2.13.11 的关键修复点——跨 tab 互斥 / 未知 errorCode 计数器 / 全过滤波段冷却 / LLM base URL 钓鱼防护——把 patch coverage 拉到 70%+，未来重构有 safety net。
- **顺手修一处**：测试发现 IPv6 字面量 URL（`http://[::1]:8080`）被钓鱼警告误标——`URL` 解析出 hostname `[::1]` 带方括号，原 `isLocalHost` 检查 `::1` 不匹配。已剥括号修复。
- 无功能变化、无 UI 变化。

## 2.13.11

- **跨 tab 互斥**：同账号开两个 tab 同时进同一直播间打开自动跟车不再翻倍发送被风控，后开的 tab 自动让出（navigator.locks）。
- **凭证安全升级**：LLM / Soniox / 保安室同步密钥都加「仅本会话」开关；持久模式时显眼红字提示明文落盘；base URL 不在已知 LLM 服务商列表（DeepSeek / Moonshot / OpenRouter / Anthropic / OpenAI / Ollama / 小米 mimo）时显示橙色防钓鱼警告；backup 导出不再包含 API key / 同步密钥字段。
- **风控感知更强**：自动跟车连续 3 次收到我们不认识的 B 站错误码会自动切试运行，避免被禁言后继续真发；「每次发 N 遍」的实际累计冷却时长在 UI 显示；自适应冷却 ≥30s 时状态文案写明"冷场房间冷却拉长"；高 CPM 房间 recentDom 上限 240→1000，减少自己消息回显被 FIFO 提前淘汰造成的"未广播"误报。
- **影子屏蔽体验**：候选改写气泡 60s → 5min；自动重发模式切换要二次确认；自动学到的规则在「当前房间替换规则」单独分组带学习时间，每条「撤销」按钮，顶部「撤销最近 5 条 / 清空全部」一键回滚。
- **预设漂移修复**：调参后改回预设基线值不再误标"自定义"；非预设字段（dryRun / cooldownAuto / avoidRepeat）改动也不再触发掉档。
- **杂项**：YOLO 复选框未配置 LLM 时显示一键跳转设置；全锁定表情触发后强制 5s 短冷却防紧凑重触发；customChatCss 存盘前就 sanitize；STT 默认不自动发送；自动跟车确认 30 天 TTL 超期重新弹；删除 `space.bilibili.com` 死 @match。

## 2.13.10

- **设置面板大幅简化**："Chatfilter 弹幕归一化" 一段从 4 个场景开关 + 算法档位下拉 + 远程聚类 endpoint，砍到只剩 2 个开关：「启用」和「在右侧聊天面板把重复弹幕折叠显示」。标题也改成"智能识别同义弹幕"，去工程师黑话。
- **远程语义聚类下线**：那一整段 UI 移除（要自托管 Python 后端才能用，普通用户用不上）；底层代码保留以备后用。
- **高级选项进 debug 后门**：算法档位（safe/normal/aggressive）、观察日志面板、学习候选、自动跟车 canonical 单独开关全部隐藏——设置 tab 搜索 `chatfilter debug` 才展开。
- **行为零变化**：默认走 normal 档（原本就是默认），所有现有用户无感升级。

## 2.13.9

- **新增：Chatfilter 拼音反查层**——抓字典里没列举的纯谐音变体。"加优"/"加铀"/"加由" → "加油"；"楠亭" / "南亭" → "难听"。设置 → "Chatfilter 弹幕归一化" 档位选 normal（默认）即生效。
- **实现要点**：pinyin-pro 仅在构建期跑，运行时用预生成的 ~3300 字 toneless CHAR_PINYIN 表 + 24 条 PINYIN_TO_CANONICAL 反查表（音节冲突 canonical 已剔除）。bundle 只增 ~14 KB gz，不带 pinyin-pro 完整包的 ~150 KB gz。
- **修复：UI 文案对齐实际实现**——v2.13.8 设置面板里"M4 / M5 / M6 待实现"等占位字面（其实功能 v2.13.8 都已经发出去了，只是 UI 文案没改）全部清掉，按实际行为重写每条开关的描述。
- **测试**：2166 条 client 测试全过（新增 14 条 pinyin 单测）。bundle raw 1090 KB / gzip 288 KB，预算 1120 KB。

## 2.13.8

- **新增：Chatfilter 弹幕语义归一化**——"niubi"/"NB"/"牛批" / "哈哈哈"/"hhhh"/"蛤蛤蛤" 等同义弹幕合并为同一条 canonical，自动跟车的相似计数从字面相等升级为语义合并，threshold 命中更准。
- **新增：4 个场景开关 + 3 档 aggressiveness**（safe / normal / aggressive），设置 → "Chatfilter 弹幕归一化"自助开关。默认仅启用"增强自动跟车趋势"，其余（Custom Chat 同义折叠 / 替换规则学习 / 观察日志面板）按需启用。
- **新增：观察日志面板**——开启场景 D 后「发送」tab 底部出现 200 行环形缓冲，实时显示每条弹幕的归一化过程（清洗 🧹 / 别名 🔄 / 循环压缩 ♻️ / SimHash 🔍），可复制 JSON / 过滤 / 清空。
- **新增：替换规则学习候选**——开启场景 C 后，房间内同一 variant→canonical 命中 ≥ 10 次自动出现在候选列表，用户点「采纳」才写入 localRoomRules。
- **新增：远程语义聚类（可选）**——用户自托管 Chatfilter Python 服务后，userscript 通过 SSE / 轮询订阅 BGE 语义聚类结果。默认关闭，需填 endpoint 才能启用。
- **CI 修复**：把生成文件 `src/lib/chatfilter/variants.gen.ts` 加进 biome 忽略列表（构建脚本输出的字典 TS，不该被 lint 规则约束）。v2.13.7 因这个就在 release.yml 的 biome 步挂了没部署到 Pages，本版补上。
- **测试**：2152 条 client 测试全过（新增 50+ chatfilter 单测/集成）。bundle 预算从 1024 → 1120 KB 给增量留 60 KB 头空间，实测 raw 1044 KB / gzip 274 KB。

## 2.13.6

- **修复：暗色模式下错误浮层 / 首次引导 / 通知卡片 / 影子封禁候选 chip 不再白底刺眼**；新加 `.cb-floating-surface` 共享类，全部尊重 `prefers-color-scheme: dark`。WS 断线橙色横幅在暗色下改用浅橙色提高对比度。
- **修复：自动跟车 / 智驾的"危险参数组合"现在会被拦下来**。"每次发 N 遍 × 间隔 > 冷却"在开车前要红色二次确认；智驾叠加文字独轮车、智驾 LLM 模式没填 API key 都会先弹 `showConfirm` 而不是默默撞限速。提示也从橙色升级到红色 `role='alert'`。
- **修复：备份恢复加"预览变更"两步走**。新 `previewImportSettings` 返回 per-key diff，UI 先列出"会被覆盖的字段 + 当前值 → 导入后值"，确认后才执行覆盖，避免一周前的旧备份静默吃掉最近改的 API key / 模板 / 规则。
- **修复：开启 Chatterbox Chat 后「常规发送」不再凭空消失**——改为显示一行重定向提示，告诉用户去右侧自定义聊天面板的输入框里发，要回来就关 Chatterbox Chat。
- **修复：手动发送成功现在有 ✓ 已发送 闪现反馈**（aria-live polite），不只是清空输入框。
- **修复：STT 自动分段 / CB 后端 URL / 保安室地址 / LLM Base URL 加输入校验**——缺协议头、HTTPS-only 违例、超出 1–200 范围都会即时显示橙色 ⚠️，不必等连接测试失败才知道。
- **修复：影子封禁候选 chip 的"×"现在持久化**（新 `shadowChipDismissedKeys` GM-signal，上限 256 条），不会在关闭再开面板后反复冒出来。
- **修复：日志面板加「复制全部 / 清空」按钮和行数计数器**——反馈 bug 时不再要 Ctrl+A 全选；清空只清当前会话视图，不影响已发出的弹幕。
- **新增：清空自定义 CSS 加二次确认**、烂梗投稿表单切换时同行其它按钮变淡并改 title 提示（避免"两个表单都开了"的错觉）、自定义 CSS 字节数 / 截断 / 剔除条目实时显示在编辑器下方。
- **新增：「关于」页每条第三方服务带「总会调用 / 已启用 / 未启用」徽章**，按当前 signal 状态动态计算（AI 规避 / Guard Room / LLM / Soniox / CB 后端 等）。LLM 区块加 YOLO 代号说明。
- **测试**：2057 条 client 测试全过。`tests/yolo-ui-toggles.test.ts` 中"NormalSendTab 在 customChatEnabled 时返回 null"的断言改为"渲染重定向提示"。

## 2.13.5

- **修复：自动跟车一波全被过滤时不再白吃 20–45s 冷却**；burst 中途关掉立即停发；UID 黑名单换 `Object.hasOwn` 防 `toString` / `constructor` 类原型链 key 误命中。
- **修复：send-queue 加 200 上限，溢出只丢 AUTO，MANUAL / STT 永远保留**；shadow-learn 用户手工规则永不被淘汰；fetch-cache / meme-contributor 加内存上限。
- **修复：live-ws-source 不再泄漏 `visibilitychange` 监听**；reconnect 用 connectionSerial 隔离旧 socket 事件。
- **修复：gm-fetch / llm-driver / ai-evasion 接 AbortSignal+超时**；错误日志 URL 砍到 origin+pathname，自填 baseURL 的 token 不再泄漏。
- **修复：custom-chat 自定义 CSS 净化加 escape 解码**，`@\69 mport` 一类绕过失效。
- **修复：Guard Room handoff 加 session 形态校验 + URL 参数用完抹除**，防刷新重放。
- **修复：`splitTextSmart` 纯空白超长输入不再返回 `[]`**（STT / 智驾"啥也没发"的成因）。
- **修复：着陆页主色加深过 WCAG AA**（`#1677ff` → `#0050b3`）。
- **修复（后端）：`POST /memes/bulk-mirror` IDOR + 攻击者字段污染**。自托管 maintainer 需 `wrangler deploy`。
- **质量基建：CodeQL / OSV-Scanner / Semgrep / Gitleaks / Knip / Lighthouse-CI / Stryker / DeepSource 全上线**；覆盖率 11 个模块补到 90%+；运行时零变化。

## 2.13.4

- **修复：LLM API 配置在非灰泽满直播间也能填了** — 原本 LLM 凭证（provider / key / model / baseURL）只能在「智能辅助驾驶」面板里填，而那个面板只在灰泽满（1713546334）等已注册梗源的房间出现。其他房间的用户开了 YOLO 三档却找不到地方配 API。这次把凭证抽到「设置 → LLM → LLM API 配置」里，所有房间永远可见。HZM 面板改为只读摘要 +「在设置中配置 →」跳转。同一份凭证给智驾选梗 + YOLO 润色共用。GM 存储 key 仍是 `hzmLlm*`，老用户的 API key 升级后保留。
- **修复：LLM 设置面板溢出弹幕助手右侧** — `.cb-stack` 是 `display:grid` 但没设 `grid-template-columns`，PromptManager 的 textarea/select 把列撑到 347px、超出 291px 的 section 边界。加 `grid-template-columns: minmax(0, 1fr)` 修。LLM API 配置面板也重写为 stacked 布局（label 在上、input 100% 宽），不再把 4 个元素挤一行。
- **改进：弹幕助手设置搜索支持多词** — 之前 `'ai 规避'` / `'key llm'` 这种空格分隔多词查询永远不命中（纯子串匹配）。改为按空格 token 化，每个 token 都要命中 KEYWORDS 才显示。同时补全了 11 个 section 的英中同义词。
- **改进：5 处 native `confirm()` 全部换成 styled dialog** — 影响开车 / 跟车 / 替换词测试 / 影子封禁清空等确认弹窗，改为暗色模式友好、Bilibili 反弹窗策略下不被吞的对话框。
- **改进：发送 tab 加 `· 智` 指示器** — 智驾运行时跟 `· 车`（独轮车）/ `· 跟`（跟车）一致。
- **改进：备份/恢复 从「工具」组挪到「系统」组** — 用户心智里属于系统级，不是日常工具。
- **改进：YOLO 未配置提示加跳转按钮** — 三处 YOLO callout 抽成共享组件，配置缺失时直接显示「前往设置 →」按钮。

## 2.13.3

- **新增：YOLO（LLM 文本润色）** — 自动跟车 / 独轮车 / 常规发送 三个 send path 各加一个独立的 🤖 YOLO 开关：开启后弹幕在发送前先送 LLM 润色一遍。默认全关、按场景独立配置。LLM 凭证直接复用「智能辅助驾驶」面板里那一份（provider / API key / model / openai-compat baseURL），不需要再配第二套——同一个模型既能选梗又能润色，省事且省 token。失败/未配置时各自的策略：自动跟车跳过该 target，独轮车自动停车，常规发送回退发原文。每个 path 上都内嵌一个提示词选择器，对应「设置 → LLM 提示词 → 常规发送 / 自动跟车 / 独轮车」里的草稿列表。从 upstream chatterbox 0c8706f / 090bd1e / 3914ec6 移植，但适配本 fork：复用现有的 llm-driver.ts（已支持 Anthropic + OpenAI + OpenAI-compat 经 gm-fetch 绕 CORS），不引入并行 `llmApiBase`/`llmApiKey`/`llmModel` 设置。
- **新增：LLM 提示词管理** — 设置 → LLM → LLM 提示词（YOLO 用）：四档独立的多草稿提示词编辑器（全局基线 + 常规发送 / 自动跟车 / 独轮车 三个功能各自的提示词）。每个功能选一个"激活"草稿，发送时全局基线会被自动拼到功能提示词前面（`<global>\n\n以下是用户的修改提示：\n\n<feature>`）。全局基线带一份出厂默认值（"40 字以内 / 不要 markdown / 不带句号" 等弹幕基本约束），首次安装自动 seed 一次；用户可自由编辑、新增、删除——seed 完后即使删空也不会被还原。
- **变更：去掉「也跟 @ 回复」开关，改为永远不跟** — `@` 回复是定向对话，把它放进自动跟车候选会把私下聊天误放大成"群体趋势"。从 upstream chatterbox 624de4e 移植同一变更。原 `autoBlendIncludeReply` 设置（默认就是 false）下线，备份里若残留此 key 会被静默忽略，无副作用。
- **小修：备份/恢复同步新加的 LLM 状态** — 新增的 8 个提示词 signal（4 列表 + 4 索引）和 3 个 YOLO 开关（autoBlendYolo / autoSendYolo / normalSendYolo）全部进入 `EXPORT_KEYS`；`autoBlendIncludeReply` 从导出列表移除。

> **说明：上游 commit 431ba97（dialog 最小宽度 280→180、tab padding 10px→4px / 3px→2px）未移植** — 本 fork 的 Configurator 用响应式 `lc-w-[320px] lc-max-w-[calc(100vw_-_16px)]` 而不是可拖动 dialog；Tabs 用 CSS class（`cb-tabs` / `cb-tab`）而不是行内 padding。上游的具体数值在 fork 上没有对应的字段可调，所以这条略过。

> **说明：上游 commit 431ba97（dialog 最小宽度 280→180、tab padding 10px→4px / 3px→2px）未移植** — 本 fork 的 Configurator 用响应式 `lc-w-[320px] lc-max-w-[calc(100vw_-_16px)]` 而不是可拖动 dialog；Tabs 用 CSS class（`cb-tabs` / `cb-tab`）而不是行内 padding。上游的具体数值在 fork 上没有对应的字段可调，所以这条略过。
## 2.13.3

- **新增：YOLO（LLM 文本润色）** — 自动跟车 / 独轮车 / 常规发送 三个 send path 各加一个独立的 🤖 YOLO 开关：开启后弹幕在发送前先送 LLM 润色一遍。默认全关、按场景独立配置。LLM 凭证直接复用「智能辅助驾驶」面板里那一份（provider / API key / model / openai-compat baseURL），不需要再配第二套——同一个模型既能选梗又能润色，省事且省 token。失败/未配置时各自的策略：自动跟车跳过该 target，独轮车自动停车，常规发送回退发原文。每个 path 上都内嵌一个提示词选择器，对应「设置 → LLM 提示词 → 常规发送 / 自动跟车 / 独轮车」里的草稿列表。从 upstream chatterbox 0c8706f / 090bd1e / 3914ec6 移植，但适配本 fork：复用现有的 llm-driver.ts（已支持 Anthropic + OpenAI + OpenAI-compat 经 gm-fetch 绕 CORS），不引入并行 `llmApiBase`/`llmApiKey`/`llmModel` 设置。
- **新增：LLM 提示词管理** — 设置 → LLM → LLM 提示词（YOLO 用）：四档独立的多草稿提示词编辑器（全局基线 + 常规发送 / 自动跟车 / 独轮车 三个功能各自的提示词）。每个功能选一个"激活"草稿，发送时全局基线会被自动拼到功能提示词前面（`<global>\n\n以下是用户的修改提示：\n\n<feature>`）。全局基线带一份出厂默认值（"40 字以内 / 不要 markdown / 不带句号" 等弹幕基本约束），首次安装自动 seed 一次；用户可自由编辑、新增、删除——seed 完后即使删空也不会被还原。
- **变更：去掉「也跟 @ 回复」开关，改为永远不跟** — `@` 回复是定向对话，把它放进自动跟车候选会把私下聊天误放大成"群体趋势"。从 upstream chatterbox 624de4e 移植同一变更。原 `autoBlendIncludeReply` 设置（默认就是 false）下线，备份里若残留此 key 会被静默忽略，无副作用。
- **小修：备份/恢复同步新加的 LLM 状态** — 新增的 8 个提示词 signal（4 列表 + 4 索引）和 3 个 YOLO 开关（autoBlendYolo / autoSendYolo / normalSendYolo）全部进入 `EXPORT_KEYS`；`autoBlendIncludeReply` 从导出列表移除。

> **说明：上游 commit 431ba97（dialog 最小宽度 280→180、tab padding 10px→4px / 3px→2px）未移植** — 本 fork 的 Configurator 用响应式 `lc-w-[320px] lc-max-w-[calc(100vw_-_16px)]` 而不是可拖动 dialog；Tabs 用 CSS class（`cb-tabs` / `cb-tab`）而不是行内 padding。上游的具体数值在 fork 上没有对应的字段可调，所以这条略过。
## 2.13.2

- **修复：跨房间表情 ID 不再被当文本发出去** — 观众如果粘贴了别房间的表情 unique（`room_<其他房间>_<id>` / `official_<id>` / `upower_<...>` 形态），以前自动跟车会把它累积成 trend 然后触发，发出去 B 站不识别 → 在聊天里变成一坨"乱码"。现在自动跟车（recordDanmaku 早期 + triggerSend safety net）、独轮车、+1、手动发送、同传、AI 规避六条 send path 全部硬拒绝并 🚫 提示。表情缓存还没加载时 fail-open，避免误杀本房间合法表情。从 upstream 644e6b1 移植。
- **修复：fan-club 大表情（`bulge-emoticon`）不再被当文字 +1 / 跟车** — 大表情的 `data-danmaku` 是显示名（"应援"、"干杯"…）不是 emoticon_unique，以前堆够阈值会触发自动跟车 → 屏幕上出现纯文字"应援"两个字而别人看到的是图。现在 `DanmakuEvent` 多一个 `hasLargeEmote` 字段，自动跟车 / 智驾 / +1 按钮三处都依据这个字段忽略大表情；按钮直接不注入。从 upstream 776174b 移植。
- **新增：自动跟车文本黑名单** — 设置 → 自动跟车 → 融入文本黑名单：精确匹配（trim 后）拉黑像 "666" / "+1" / "哈哈哈" 这种万能水弹幕，再多人发也不进 trend。和已有的 UID 黑名单互补——一个按人，一个按内容。命中后仍计入 CPM（房间活跃度），不影响自适应冷却。底层用 `Object.hasOwn`（不是 `in`），不会被原型链上的 `toString` / `constructor` 等内置 key 误命中。从 upstream 2820b45 + 16972c7 移植。
- **修复：备份/恢复漏掉了几个 auto-blend 设置** — `autoBlendUserBlacklist`、`autoBlendCooldownAuto`、`autoBlendAvoidRepeat`、`lastAppliedPresetBaseline` 之前被漏在 `EXPORT_KEYS` 之外，导出再导入会丢；现在补齐并加 round-trip 测试。新增的 `autoBlendMessageBlacklist` 也走同一个备份链。
## 2.13.1

- **修复 (radarReportEnabled): 上报 payload schema 与 live-meme-radar 后端对齐** — 2.13.0 中此 toggle 因客户端发送的 payload 形态(`{ roomId, channelUid, sampledTexts, windowStartTs, windowEndTs }`)跟 server 接受的 schema(`{ reporter_uid, client_version, buckets: [{ bucket_ts, room_id, channel_uid, msg_count, distinct_uid_count }] }`)不匹配,**100 % 被 server 以 400 `bad_reporter_uid` 拒绝**,事实上不工作;fire-and-forget 模型把错误吞了所以肉眼也看不到。2.13.1 客户端改成发送 5 分钟对齐的桶聚合(每个桶仅含 msg_count + distinct_uid_count,不再含任何弹幕原文 / 单条 timestamp / 发送者 uid,**比原方案更隐私**),并带上观众自身的 `reporter_uid`(server 端 hashUid+IP_HASH_SALT 后才落 D1)和 userscript `// @version`。匿名观众(未登录 / 无 `DedeUserID` cookie)短路不上报。**启用过 toggle 的用户无需任何操作,2.13.1 自动恢复正常上报**。详见 `src/lib/radar-report.ts` 与 `src/lib/radar-client.ts` 的 `reportRadarObservation`,隐私契约同步更新到 SECURITY.md。
## 2.13.0

- **新增 (opt-in, 默认关闭): live-meme-radar 趋势上报** — 设置 → 工具 → 勾选『live-meme-radar 趋势上报 (radarReportEnabled)』后,脚本按 60 秒一批向 live-meme-radar 后端上报本房间命中已知 trending 簇的去重弹幕样本,帮助跨房间热门梗检测。仅含房间号 / 主播公开 ID / 样本文本 / 窗口时间戳,不含任何观众 / 发送者 uid 或单条时间戳。切房间或关 toggle 立即丢未发的 buffer。默认关闭,不影响自动跟车 / 弹幕屏蔽 / 自定义聊天 / 任何其它现有功能。
## 2.12.0

- **新增：去重折叠（×N 合并）**：9 秒内重复弹幕合并成一条，行尾显示 `×N`。能识别独轮车换长度变体——`666` / `6666` / `晚安晚安晚安` / `[doge][doge]` 都归同一条。两个独立开关：Chatterbox Chat 自家列表（设置 → Chatterbox Chat）、B 站原生右侧聊天框（设置 → +1 直接动作）。默认全关。
- **每条弹幕高度 -20 px**：偷 / +1 / 复制按钮改成悬停才显形浮在气泡右下，不再独占一行；顶部渐变 18 → 6 px，第一行人名 + 牌子不再被吃。
- **修复：单击「回到最新 ↓」常常到不了底**——虚拟列表估算高度有偏差，现在自动迭代直到真到底。
- **修复：刷屏房间下「回到最新」跳不动**——smooth 滚动被新弹幕打断，改成 instant。
- **emoji picker 居中对齐**：之前贴右边时离按钮 ~300 px 像无关 popup。
- **B 站表情贴纸现在能 +1 / 跟车 / 折叠**：之前被 DOM 检查误拒。
- **工具栏新增 🔍 搜索按钮**：之前搜索藏在 ⋯ 菜单里。
- 删除占位按钮 👍 点赞 / 💰 SC（接入前不再 ship 占位）。
- 未读 > 99 显示 `99+`。

## 2.11.13

- **关于页「作者: NougatDev」去掉超链接**：之前作者署名是一个指向 GitHub 帐号的 `<a>` 链接，现在改成纯文本 `作者: NougatDev`，不再可点击跳转。下方的「源代码: GitHub」链接保持不变，想去仓库的用户仍可走那条入口。仅 `src/components/about-tab.tsx` 一处显示元素改动，无运行时行为变化。
## 2.11.12

- **关于页作者署名改为 `NougatDev`**：关于页的「作者」字段 改成 `NougatDev`，链接仍指向同一个 GitHub 帐号（`github.com/aijc123`）。仅 `src/components/about-tab.tsx` 一处显示文案改动，无运行时行为变化，userscript header 的 `@author` / `package.json` / 着陆页的 `<meta name=author>` 等保持不变。
## 2.11.11

- **修复：同传 → 语音识别设置 → 设备下拉在 Edge / Firefox 把面板撑出右边**：2.11.8 给 `<select>` 加了 `flex:1 1 0; min-width:0; max-width:100%`，Chrome 老老实实把它收进 flex 分配空间内，但 Edge / Firefox 把 `<select>` 当 "replaced-element-ish" 控件，宽度由最长 `<option>` 决定，CSS `min-width: 0` 不生效——一个超长设备名（如 `Microphone Array (Intel® Smart Sound Technology for Digital Microphones)` ≈ 65 字符 / ≈ 450px）就把整行拉到面板右边外去。本次把 `<select>` 套进一个 `flex:1 1 0; min-width:0; overflow:hidden` 的容器 div，select 自己拿 `width:100%`：在拒绝缩 select 的浏览器里，wrapper 的 `overflow:hidden` 视觉截断它而不让它撑行。隔离测试（带超长 option 的对照面板）：`row=535px → 286px`（`section=302`），无溢出。原生下拉弹层宽度仍由浏览器控制（弹开会溢出面板，那是 Edge 原生控件行为，CSS 管不到）。
## 2.11.10

- **同传 → 语音识别设置：语言开关合并回一行 + 短 label**：2.11.9 把「语言提示：」拆出来独占一行、4 个开关再独占一行，物理上没溢出但视觉上看不出修了什么。本次把「语言：」+ 4 个开关压回同一行，label 由全名（`中文 / English / 日本語 / 한국어` ≈ 256px）改成短形（`中 / EN / 日 / 한` ≈ 130px），整行 ≈ 195px，280px 内 spec 也容得下；hover tooltip 仍显示全名（`title=` 属性）以保持可读性。section 高度 226px → 200px（少 26px），抓在 320px 隔离预览实测无溢出。其他行（设备 / 超过 N 字 / 自动发送 / 【】包裹）全部不动。
## 2.11.9

- **修复：同传 → 语音识别设置面板的"语言提示"行把面板撑出右边框**：原先「语言提示： + 4 个语言开关（中文 / English / 日本語 / 한국어）+ 超过 N 字自动分段」全挤在同一个 `cb-row` 里，4 个开关 + 标签合起来约 322px > 320px 面板内容区（287px），加上 `flexWrap: wrap` 行为是把 한국어 单独挤到下一行变成"孤儿"，视觉上像第二条溢出行；某些用户的面板因此还会被撑宽超出 320px。本次拆成三行：(1) 设备下拉行；(2)「语言提示：」标签独占一行（17px）；(3) 4 个开关独占下一行（287px 全宽，4 个开关合 256px ≤ 287，全部一行容下）；(4)「超过 N 字自动分段」拆成独立一行；(5) 自动发送 / 【】包裹保持原行。已在 320px 隔离面板里实测：`scrollWidth=319 ≤ 320`，无溢出，无孤儿换行。1247 / 1247 测试全过。
## 2.11.8

- **修复：同传 → 语音识别设置面板的设备下拉超出右边框**：设备 `<select>` 之前用 `flex: 1; min-width: 150px`，但 flex 子元素隐式带 `min-width: auto`（= 内容尺寸），导致一个长名字的麦克风（比如 `Realtek(R) Audio - 立体声混音`）会让 select 实际宽度超过 flex 分配的空间，把那一行整体挤到面板右边框之外。改成 `flex: 1 1 0; min-width: 0; max-width: 100%`，让 select 可以缩到分配空间内、过长的设备名按 `<select>` 原生方式截断。其他行（语言提示 / 超过 N 字 / 自动发送 / 包裹）已经是 `flexWrap: wrap`，未受影响。
## 2.11.7

- **修复：2.11.6 改了 Tampermonkey `@name` 导致脚本被识别成新装**：Tampermonkey 用 `@namespace + @name` 做脚本身份，2.11.6 把 `@name` 从 `B站独轮车 + 自动跟车 / Bilibili Live Auto Follow` 改成 `B站独轮车直播间插件 + 自动跟车 / Bilibili Live Auto Follow`，并多了 `@name:en Bilibili Live Wheel Auto Follow` / `@name:zh-CN ...` 多语言变体；老用户从 Greasy Fork 更新后，旧 2.11.5 那一份没被覆盖，反而装出了第二份「Bilibili Live Wheel Auto Follow」。本次把 `vite.config.ts` 里的 `name` / `description` 全部回退成 2.11.5 时的单字符串原文，未来更新会重新认到原来那份。**已经被装出第二份的用户需要自己在 Tampermonkey 里手动删除多出来的那个脚本**，本脚本无法替对方删除。仅 userscript header 改动，运行时行为零变化。
## 2.11.6

- **空间拉黑解锁（`unlockSpaceBlock`，默认开）**：新增设置 → 直播间布局复选框「空间拉黑解锁」。脚本现在也匹配 `*://space.bilibili.com/*`，命中 `/x/space/wbi/acc/relation` 响应时把 `data.be_relation.attribute === 128` 改写为 `0`，并在 `.header.space-header` 下注入"🔓 已解除该用户的部分拉黑限制"横条。`document-start` 时机 header 还没挂载，因此用一个一次性 `MutationObserver` 等待挂载；用户在面板里关掉开关时通过 `effect()` 立即移除横条并断开 observer，不需要刷新。SPA 路由切换会先清掉上一位用户的横条再判断当前用户的 `be_relation`。
- **自动跟车：候选进度条**（`autoBlendCandidateProgress` + `formatAutoBlendCandidateProgress`）：「正在刷」一行从纯文本升级为「短文本 + N/threshold 条 [+ M/min 人] + 60×6 像素进度条」。颜色按 `min(countRatio, userRatio)`（AND 瓶颈）从橙→红渐变，所以条满之前就能一眼看到"快触发了"。当 `requireDistinctUsers` 关闭时人数分母被忽略，进度只看条数。
- **自动跟车：自定义档偏移度可视化**（`autoBlendDriftFromPreset` computed + `lastAppliedPresetBaseline` GM 持久值）：一旦数值被改、preset 翻成 `custom`，主区会显示「自定义（基于「正常」档 +12% 激进）」并出现 ↺ 一键回到基线档按钮，丢弃当前自定义数值。偏移按四个维度加权（threshold / cooldownSec ×2、windowSec / minDistinctUsers ×1）合成单个百分比，正值=更激进。
- **自动跟车：触发条件 UI 重排**：「多少算跟」改名「触发条件」并把"且至少 N 人都在刷"这条原先藏在高级里的 distinct-users 子句抬到主区直接列出来；「突发等待」→「凑齐刷屏的窗口」；「限频保护」→「失败熔断」；「一波刷屏全跟」→「多句一起跟」，启用时「每次发 X 遍」灰掉并提示已被覆盖为 1。文案不改变行为，只是让"为什么没跟"更直观。
- **自动跟车：自适应冷却实时读数**（`LiveCooldownReadout`）：`autoBlendCooldownAuto` 开启时主区每 2s 重渲一行「自动调节中（约 Xs，CPM=Y）」；启动前显示「启动后按弹幕速率自动调节」。读 `getCurrentCpm` / `computeAutoCooldownSec` 的当前结果，用来回答"现在到底冷却多久"。
- **修复：burst 内 repeat 间隔忽略 `autoBlendCooldownAuto`**：`getAutoBlendRepeatGapMs` 之前直接 `Math.max(autoBlendCooldownSec, …)`，于是 autoCooldown 开启时手动那个秒数仍然在隐式封顶 burst 内同句重复发的间隔。改读 `getEffectiveCooldownMs(now)` 后，自适应冷却才会真正接管这条路径。
- **更友好的风控/禁言/频率熔断停车提示**：被禁言、账号风控、连续频率限制三种自动停车日志各自加上一句行动建议（"等到禁言解除后再开"/"先停用一段时间或换账号"/"歇一阵子再开，或切到「稳一点」档"），减少用户疑惑"为什么自动跟车又关了"。
- **fetch-hijack 拆分**：把纯逻辑（URL 匹配、`applyTransforms`、横条注入/清理）挪到 `src/lib/fetch-hijack-helpers.ts`，让单测能 import 而不会触发 orchestrator 的 prototype-patching IIFE。orchestrator 因 IIFE 副作用本来就在 coverage whitelist 里。
- **userscript metadata + 着陆页 SEO**：Tampermonkey header `name` / `description` 改成多语言对象（zh-CN + en），`homepage`/`website` 改指 GitHub Pages 着陆页，`@match` 加上 `space.bilibili.com/*`。`public/index.html` 补上 og:locale、Twitter card、theme-color、`alternate hreflang`、JSON-LD 增补 `featureList` / `offers` / `sameAs` / `isAccessibleForFree` 字段、新增 FAQPage schema；title/description/keywords 增强"独轮车直播间/直播间独轮车"长尾词命中。`public/sitemap.xml` 加 `lastmod` / `changefreq` / `priority`。
- **同传：超长切片设置换行**：「超过 N 字…分句」那行从设备列同行换到独立行，避免在窄面板里 wrap 错位。
- **测试覆盖**：新增 4 个测试文件 `auto-blend-controls-ui` / `auto-blend-drift` / `auto-blend-progress` / `fetch-hijack-helpers`；`auto-blend-cooldown-auto` 与 `settings-ui` 补充 `getAutoBlendRepeatGapMs`、`unlockSpaceBlock` 复选框、其他布局 toggle onInput 写回等用例。覆盖 burst-gap 改 `getEffectiveCooldownMs`、`be_relation.attribute === 128` 的 `applyTransforms` 路径、空 header 时的 banner injection 跳过、preset drift 计算分支等。
## 2.11.5

- **从 upstream LAPLACE Chatterbox 抄过来 4 个值得抄的功能**（diff 自 `laplace-live/chatterbox@7049181`，跳过已超越或道德可疑的部分）。
- **自动跟车：不重复上次自动发送（`autoBlendAvoidRepeat`）**：开启后,与上一次自动跟车发出去的弹幕完全相同的新弹幕在 `recordDanmaku` 早期就被丢弃,既不进 `trendMap` 候选榜也不会触发新一轮 burst——避免冷却结束后被同一句话立刻再次刷上去。`triggerSend` 多目标 burst 推进时**逐目标**记录 `lastAutoSentText`,适配 fork 的"一波刷屏全跟"模式;stop 时清空,opt-in 不影响默认行为。设置 → 自动跟车 → 高级设置新增复选框。
- **自动跟车：自适应冷却（`autoBlendCooldownAuto`）**：开启后按当前房间弹幕速率(CPM)动态算冷却,公式 `cooldown = clamp(K/cpm, 2s, 60s)`,K=300 ⇒ 任意 CPM 下两次自动跟车之间约保留 5 条别人的弹幕。冷场房间拉到 60s 上限免抢话,高峰房间压到 2s 下限不浪费窗口。CPM 用 30s 滑动窗口 + 2s 外推下限,自身回声在写入 CPM 之前就被过滤,不会形成正反馈。开启时固定冷却数字框灰掉。
- **同传：麦克风设备选择**：同传设置区新增"设备"下拉,枚举 `navigator.mediaDevices`,持久化 `sonioxAudioDeviceId`;首次点"授权"按钮触发 `getUserMedia` 解锁设备 label;监听 `devicechange` 自动刷新列表;启动同传时校验已选设备仍存在,掉线静默回落到系统默认并清空持久值,避免错过去年插的麦克风。`audioConstraints` 显式传 `echoCancellation / noiseSuppression / autoGainControl: false` + 单声道 44.1k,与 Soniox SDK 推荐的原始音频一致。
- **烂梗库：动画用 Web Animations API**：FLIP 重排动画从 double-RAF + CSS transition 改成 `node.animate()`,快速重排时 `getAnimations().cancel()` 自动取消上一条,不会出现"上一条还没动完就被新值打断"的视觉残留。
- **副带修复：`_resetSendQueueForTests` 漏处理 inflight 项**：`cancel path` 集成测试的 manual-preempt 在 `HARD_MIN_GAP_MS` setTimeout 闭包里夹带,会泄漏到下个测试。修复方式:reset 时同时把 `inflight.cancelled = true`,让 processQueue 的 post-sleep 取消重检 bail。生产代码 0 影响（reset 仅测试调用）。
- **测试覆盖**：新增 33 条单测 + 3 条端到端集成测试,共 36 条。`store-auto-blend.ts` / `store-stt.ts` 100% 覆盖;`auto-blend.ts` 新增代码 100% 覆盖（CPM 数学全分支 / `getEffectiveCooldownMs` 路由 / avoidRepeat 早期 drop / 多目标 burst 的 `lastAutoSentText` 写入 / stop 与 reset 清理）;集成测试断言 `cooldownUntil - beforeTrigger` 实际值,精确验证 `triggerSend` 接的是 `getEffectiveCooldownMs` 而不是 `autoBlendCooldownSec`。完整套件 1171 / 1171 通过。
## 2.11.4

- **接入 DeepSource 静态分析（仅代码质量门禁，运行时零影响）**：仓库根新增 `.deepsource.toml`，启用 JavaScript / TypeScript 分析器（browser + nodejs 双环境、Preact 插件），把 `dist/`、`coverage/`、`scripts/`、`server/scripts/`、`public/` 这些纯产物 / CLI / 静态资源目录排除在分析外，`tests/**` 标记为 test_patterns。
- **`src/lib/` 多处 `if (cond) return; return` 链合并为单条 return**：`custom-chat-dom` / `custom-chat-native-adapter` / `danmaku-stream` / `hzm-auto-drive` / `live-ws-helpers` / `meme-contributor` / `moderation` / `send-verification` 共 9 处布尔判定改写，等价、无行为变更，仅降低分支密度。
- **去除冗余 `undefined` 默认值 + optional chain**：`backup.ts` / `medal-check-section.tsx` 的 `GM_getValue(key, undefined)` 简化为 `GM_getValue(key)`；`radar-client.ts` 的 `area && area.trim()` 改为 `area?.trim()`。
- **测试 mock 默认实现形参表对齐**：`fetchImpl` / `responder` / `mockResponseFactory` 等可重新赋值的 mock 默认值原本是零参 arrow，但调用点会传 `(url, init)` / `(req)` 等参数；现在显式带上 `_url, _init` / `_req` placeholder，类型签名与实际形参一致，DeepSource 不再误报"too many arguments"。
- **空 catch 加说明 + 诊断 console.log 标 skipcq**：`medal-check-section` 三段 legacy `GM_deleteValue` 兜底块、`danmaku-stream.test` 的 unsubscriber 清理块都补了 best-effort 注释；`[CB][WS-SELF]`（live-ws-source）与 `[CB][VERIFY]`（send-verification）两条调试 trace 因测试断言依赖原生 console 而非 log buffer，故继续走 `console.log`，加 pragma 让 DeepSource 不再标 JS-0002；`server/src/index.ts` 的 Cloudflare Workers cron 日志同理。
## 2.11.3

- **跨房间热门梗 🔥 徽章（自动开启）**：烂梗库面板打开时后台异步查询独立的 [live-meme-radar](https://live-meme-radar.pages.dev) 传感器一次（10 分钟内存缓存 + in-flight dedup，最多每 10 分钟一个网络请求），命中"今日跨房间 trending"簇的梗在卡片左上多一个 🔥 小徽章 + tooltip "今日第 N 位（簇 #X）"。**无用户开关、无后台轮询、对自动跟车零影响**；雷达失联或返回空 → 徽章不出现，烂梗库其余功能不受影响。
- **移除"radar 软门"实验开关**：2.11.0 / 2.11.1 的「实验：用跨房间热度增强自动跟车」checkbox 整段下线，雷达不再参与自动跟车决策——auto-blend 路径已经回到与雷达无关的本地逻辑。底层 `radarConsultEnabled` / `radarReportEnabled` GM signal 仍声明保留以兼容已存值，但 UI 不再渲染、生产代码无人调用。
- **新增 `meme-trending` 客户端 + 单独 `<TrendingBadge>` 组件**：`src/lib/meme-trending.ts` 用 `memeContentKey` 把雷达返回的 cluster representative 文本做归一化匹配；`src/components/trending-badge.tsx` 是单参数纯组件，雷达失联时返回 `null`。
- **测试覆盖**：新增 22 条测试（15 条 meme-trending 单元 + 7 条 TrendingBadge 渲染分支）；删除旧的 `auto-blend-radar-boost` 测试。雷达相关四个源文件全部 100% 函数 / 100% 行覆盖（`meme-trending.ts` / `trending-badge.tsx` / `radar-client.ts` / `store-radar.ts`）。
## 2.11.2

- **修复：智驾发送超长梗被 B 站拒收**：智能辅助驾驶之前直接整段把梗塞进发送队列，遇到长度超过 `maxLength`（默认 38 字）的烂梗时被 B 站服务端拒收，日志报 `❌ 智驾发送失败：...，原因：超出限制长度`。现在和手动发送 / 独轮车一致，在发送前用 `splitTextSmart` 按标点切片，每片不超过 `maxLength`，逐条进入发送队列；多片日志里带 `[i/n]` 后缀。
- **去重 / 限速口径**：每片切片都计入每分钟限速 (`hzmRateLimitPerMin`) 和每日发送计数 (`hzmDailyStatsByRoom`)；最近发送去重 (`hzmRecentSentByRoom`) 仍按原始整段记录一次，不会让同一条长梗短时间反复被选中。
- **失败 / 取消时止损**：任一切片返回失败或被打断都会立即终止后续切片，不再灌半截广播；异常会被外层 catch 并记 `❌ 智驾发送异常：...`。
- **关于页 External Services 刷新**：把 chatterbox-cloud 自建后端、SBHZM 社区源、保安室、LLM 矩阵和本地开发后端全部补进关于页的对外服务列表，触发条件 / 数据范围按 2.11 当前实现重写。
## 2.11.1

- **实验：跨房间热度提示（默认关闭）**：自动跟车在准备发送前可以可选地查询独立的 [live-meme-radar](https://live-meme-radar.pages.dev) 传感器；当雷达确认该 meme 也在其他直播间流行时，仅在日志里多打一条确认信息。**不会阻止、跳过或延迟原本的自动跟车**；雷达失联或不匹配时一切按本地逻辑继续。
- **新增设置开关与 @connect**：设置 → 工具 → "Meme 雷达" 折叠区中的 `radarConsultEnabled` 开关；`@connect live-meme-radar.aijc-eric.workers.dev` 写进 userscript header（兜底的 `*` 仍在）。
- **新增客户端模块**：`src/lib/radar-client.ts` 暴露 `queryClusterRank` 等只读查询函数，所有错误静默兜底为 `null`，不影响主流程。
- **测试覆盖**：新增 radar-client 与 auto-blend 雷达分支测试，沿用项目既有的 `_setGmXhrForTests` DI seam。
## 2.11.0

- **实验：跨房间热度提示（默认关闭）**：自动跟车在准备发送前可以可选地查询独立的 [live-meme-radar](https://live-meme-radar.pages.dev) 传感器；当雷达确认该 meme 也在其他直播间流行时，仅在日志里多打一条确认信息。**不会阻止、跳过或延迟原本的自动跟车**；雷达失联或不匹配时一切按本地逻辑继续。
- **新增设置开关与 @connect**：设置 → 工具 → "Meme 雷达" 折叠区中的 `radarConsultEnabled` 开关；`@connect live-meme-radar.aijc-eric.workers.dev` 写进 userscript header（兜底的 `*` 仍在）。
- **新增客户端模块**：`src/lib/radar-client.ts` 暴露 `queryClusterRank` 等只读查询函数，所有错误静默兜底为 `null`，不影响主流程。
- **测试覆盖**：新增 radar-client 与 auto-blend 雷达分支测试，沿用项目既有的 `_setGmXhrForTests` DI seam。

## 2.10.6

- **chatterbox-cloud 数据库瘦身**：`upstream_sbhzm_cache` 表收尾退役 —— GC 保留期从 7 天收紧到 1 天，旧 SBHZM 全量快照行立即回收（D1 数据库体积 73.9 MB → 1.21 MB,缩 98.4%）。读路径仍接受 ≤24h 的旧行兜底,行为对用户透明。
- **梗 tag 体系注入与回填**：`POST /memes/bulk-mirror` 和后端 SBHZM cron 路径都开始把上游 `tags` 字段写进 `tags` + `meme_tags` 两表；用 `content_hash` 反查 attach,**同时回填**之前已在库里但缺 tag 的旧梗。每条最多 8 个 tag,name ≤40 字、color ≤32、emoji ≤16 挡住滥用。烂梗库面板里历史梗的 tag 徽章和颜色现在能正常显示（已回填 1763/1955 条,~90% 覆盖,剩余随用户自然 mirror 继续填）。
- **Lint 清理**：批量把 `<label for=...>` 改成 JSX 推荐的 `htmlFor=`,`NaN` 改成 `Number.NaN`,对齐 biome `useHtmlForAttribute` / `useNumberNamespace` 规则；零行为变化。
## 2.10.5

- **自定义烂梗源**：新增 `userMemeSources` GM 存储入口，允许高级用户在 Tampermonkey 存储里给任意房间注入自定义烂梗源；用户配置会覆盖同房间内置源，非法 URL / 过长字段 / 异常 tag 会被静默丢弃，避免坏配置拖垮整个烂梗面板。
- **SBHZM 后端同步可配置**：`chatterbox-cloud` 的 SBHZM 定时同步支持 `SBHZM_LIST_URL` 和 `SBHZM_STALE_HOURS` 环境变量，默认仍走 `https://sbhzm.cn/api/public/memes` 和 12 小时刷新阈值；URL 校验只接受 HTTPS 或本地开发地址，便于接 staging mock / 自建镜像。
- **发布流程提醒后端部署**：GitHub Pages release workflow 会在 `server/` 自上个 tag 起有变更时，在 workflow summary 里提示 maintainer 手动 `cd server && wrangler deploy`；用户脚本发布不被后端部署步骤阻塞，但更不容易忘记同步 Workers。
- **覆盖率政策落地**：新增 coverage whitelist 文档并把 Codecov file-level ignore 写入 `codecov.yml`，记录哪些文件/行属于 happy-dom 或 Bun coverage 当前无法可靠覆盖的区域，避免 coverage gate 和实际风险脱节。
- **回归测试补强**：新增 API 额外分支、弹幕 DOM stream、fetch TTL cache、live WebSocket source、SBHZM client error、shadow-learn extras 等测试；同时给 live-ws / WBI 增加测试专用 reset / setter hook，缩短等待时间并让连接生命周期测试更稳定。
- **维护文档**：补充 `custom-chat-dom.ts` Phase 1 refactor audit，记录模块职责、风险分区、候选抽取顺序、测试计划和 bundle 预算约束，方便后续拆分这个大文件时逐步推进。
## 2.10.4

- **自定义烂梗源**：新增 `userMemeSources` GM 存储入口，允许高级用户在 Tampermonkey 存储里给任意房间注入自定义烂梗源；用户配置会覆盖同房间内置源，非法 URL / 过长字段 / 异常 tag 会被静默丢弃，避免坏配置拖垮整个烂梗面板。
- **SBHZM 后端同步可配置**：`chatterbox-cloud` 的 SBHZM 定时同步支持 `SBHZM_LIST_URL` 和 `SBHZM_STALE_HOURS` 环境变量，默认仍走 `https://sbhzm.cn/api/public/memes` 和 12 小时刷新阈值；URL 校验只接受 HTTPS 或本地开发地址，便于接 staging mock / 自建镜像。
- **发布流程提醒后端部署**：GitHub Pages release workflow 会在 `server/` 自上个 tag 起有变更时，在 workflow summary 里提示 maintainer 手动 `cd server && wrangler deploy`；用户脚本发布不被后端部署步骤阻塞，但更不容易忘记同步 Workers。
- **覆盖率政策落地**：新增 coverage whitelist 文档并把 Codecov file-level ignore 写入 `codecov.yml`，记录哪些文件/行属于 happy-dom 或 Bun coverage 当前无法可靠覆盖的区域，避免 coverage gate 和实际风险脱节。
- **回归测试补强**：新增 API 额外分支、弹幕 DOM stream、fetch TTL cache、live WebSocket source、SBHZM client error、shadow-learn extras 等测试；同时给 live-ws / WBI 增加测试专用 reset / setter hook，缩短等待时间并让连接生命周期测试更稳定。
- **维护文档**：补充 `custom-chat-dom.ts` Phase 1 refactor audit，记录模块职责、风险分区、候选抽取顺序、测试计划和 bundle 预算约束，方便后续拆分这个大文件时逐步推进。
## 2.10.3

- **自定义烂梗源**：新增 `userMemeSources` GM 存储入口，允许高级用户在 Tampermonkey 存储里给任意房间注入自定义烂梗源；用户配置会覆盖同房间内置源，非法 URL / 过长字段 / 异常 tag 会被静默丢弃，避免坏配置拖垮整个烂梗面板。
- **SBHZM 后端同步可配置**：`chatterbox-cloud` 的 SBHZM 定时同步支持 `SBHZM_LIST_URL` 和 `SBHZM_STALE_HOURS` 环境变量，默认仍走 `https://sbhzm.cn/api/public/memes` 和 12 小时刷新阈值；URL 校验只接受 HTTPS 或本地开发地址，便于接 staging mock / 自建镜像。
- **发布流程提醒后端部署**：GitHub Pages release workflow 会在 `server/` 自上个 tag 起有变更时，在 workflow summary 里提示 maintainer 手动 `cd server && wrangler deploy`；用户脚本发布不被后端部署步骤阻塞，但更不容易忘记同步 Workers。
- **覆盖率政策落地**：新增 coverage whitelist 文档并把 Codecov file-level ignore 写入 `codecov.yml`，记录哪些文件/行属于 happy-dom 或 Bun coverage 当前无法可靠覆盖的区域，避免 coverage gate 和实际风险脱节。
- **回归测试补强**：新增 API 额外分支、弹幕 DOM stream、fetch TTL cache、live WebSocket source、SBHZM client error、shadow-learn extras 等测试；同时给 live-ws / WBI 增加测试专用 reset / setter hook，缩短等待时间并让连接生命周期测试更稳定。
- **维护文档**：补充 `custom-chat-dom.ts` Phase 1 refactor audit，记录模块职责、风险分区、候选抽取顺序、测试计划和 bundle 预算约束，方便后续拆分这个大文件时逐步推进。
## 2.10.2

- **自定义烂梗源**：新增 `userMemeSources` GM 存储入口，允许高级用户在 Tampermonkey 存储里给任意房间注入自定义烂梗源；用户配置会覆盖同房间内置源，非法 URL / 过长字段 / 异常 tag 会被静默丢弃，避免坏配置拖垮整个烂梗面板。
- **SBHZM 后端同步可配置**：`chatterbox-cloud` 的 SBHZM 定时同步支持 `SBHZM_LIST_URL` 和 `SBHZM_STALE_HOURS` 环境变量，默认仍走 `https://sbhzm.cn/api/public/memes` 和 12 小时刷新阈值；URL 校验只接受 HTTPS 或本地开发地址，便于接 staging mock / 自建镜像。
- **发布流程提醒后端部署**：GitHub Pages release workflow 会在 `server/` 自上个 tag 起有变更时，在 workflow summary 里提示 maintainer 手动 `cd server && wrangler deploy`；用户脚本发布不被后端部署步骤阻塞，但更不容易忘记同步 Workers。
- **覆盖率政策落地**：新增 coverage whitelist 文档并把 Codecov file-level ignore 写入 `codecov.yml`，记录哪些文件/行属于 happy-dom 或 Bun coverage 当前无法可靠覆盖的区域，避免 coverage gate 和实际风险脱节。
- **回归测试补强**：新增 API 额外分支、弹幕 DOM stream、fetch TTL cache、live WebSocket source、SBHZM client error、shadow-learn extras 等测试；同时给 live-ws / WBI 增加测试专用 reset / setter hook，缩短等待时间并让连接生命周期测试更稳定。
- **维护文档**：补充 `custom-chat-dom.ts` Phase 1 refactor audit，记录模块职责、风险分区、候选抽取顺序、测试计划和 bundle 预算约束，方便后续拆分这个大文件时逐步推进。
## 2.10.1

- **自定义烂梗源**：新增 `userMemeSources` GM 存储入口，允许高级用户在 Tampermonkey 存储里给任意房间注入自定义烂梗源；用户配置会覆盖同房间内置源，非法 URL / 过长字段 / 异常 tag 会被静默丢弃，避免坏配置拖垮整个烂梗面板。
- **SBHZM 后端同步可配置**：`chatterbox-cloud` 的 SBHZM 定时同步支持 `SBHZM_LIST_URL` 和 `SBHZM_STALE_HOURS` 环境变量，默认仍走 `https://sbhzm.cn/api/public/memes` 和 12 小时刷新阈值；URL 校验只接受 HTTPS 或本地开发地址，便于接 staging mock / 自建镜像。
- **发布流程提醒后端部署**：GitHub Pages release workflow 会在 `server/` 自上个 tag 起有变更时，在 workflow summary 里提示 maintainer 手动 `cd server && wrangler deploy`；用户脚本发布不被后端部署步骤阻塞，但更不容易忘记同步 Workers。
- **覆盖率政策落地**：新增 coverage whitelist 文档并把 Codecov file-level ignore 写入 `codecov.yml`，记录哪些文件/行属于 happy-dom 或 Bun coverage 当前无法可靠覆盖的区域，避免 coverage gate 和实际风险脱节。
- **回归测试补强**：新增 API 额外分支、弹幕 DOM stream、fetch TTL cache、live WebSocket source、SBHZM client error、shadow-learn extras 等测试；同时给 live-ws / WBI 增加测试专用 reset / setter hook，缩短等待时间并让连接生命周期测试更稳定。
- **维护文档**：补充 `custom-chat-dom.ts` Phase 1 refactor audit，记录模块职责、风险分区、候选抽取顺序、测试计划和 bundle 预算约束，方便后续拆分这个大文件时逐步推进。
## 2.10.0

- **深色模式**：当系统/浏览器使用深色主题时，弹幕助手浮窗、Chatterbox Chat 设置面板和 tab 区会自动切换成 iOS 风格深色配色，避免在 B 站直播间深色背景下白底刺眼；按钮、复选框、tab 同步加上 `:focus-visible` 聚焦环，浮窗按 Esc 直接关闭（在输入框中按 Esc 仍保留默认行为），tabs 加上 `role="tablist"` / `aria-selected` 等无障碍属性。
- **WebSocket 断线提示与可见性自动重连**：直播 WS 进入 close/error 时，发送 tab 上出现 ⚠️ 图标和橙色提示条「直播 WS 已断开 · 已退回 DOM 抓取（高峰期可能漏事件）」；浏览器 tab 从后台切回前台时如果应连未连，会立即重新发起连接，规避移动端/bfcache 下 setTimeout 被冻住导致的长时间断流。
- **智能辅助驾驶接入更多 LLM provider**：除 Anthropic、OpenAI 外新增 OpenAI 兼容 provider 支持（DeepSeek、Moonshot、OpenRouter、Ollama、小米 mimo 等任意自填 base URL），通过 `@connect *` 兜底放行；`@connect` 同步加入 `api.anthropic.com`、`api.openai.com`、`sbhzm.cn`、`chatterbox-cloud.aijc-eric.workers.dev`。脚本管理器在首次访问每个新域时仍会单独弹窗确认，README、官网和用户指南列出每一项的具体用途和触发条件。
- **chatterbox-cloud 自建后端升级**：新增 `POST /memes/copy/batch` 批量计数接口（客户端 debounce 聚合，N+1 → 1 次往返）；`POST /memes` 提交按 ip_hash 限速 30 次/小时；鉴权失败写一行 `auth_fail` 审计（IP 哈希、UA、token hash 前 8 位，便于回溯探测）；`/admin/*` 显式跳过 wildcard CORS（即便 token 泄露也无法在第三方页面跨域调用）；SBHZM 定时同步任务异常显式 `console.error`，不再被 Workers runtime 静默吞掉。
- **安全加固**：Chatterbox Chat 自定义 CSS 新增 sanitizer，自动剔除 `@import` / `url(javascript:|data:text/html|...)` / `expression()` / `behavior:` 等危险结构并强制 256 KB 长度上限；数值型 GM 设置写入 NaN/越界/非整数时自动钳位、四舍五入、非有限值回退默认并打 warn；备份导入失败显示 JSON parser 真实错误，并明确列出"格式不匹配被跳过"和"未识别 key 被忽略"的字段；`getRoomId` 等核心调用失败时给出可定位的具体原因和 issue 反馈链接。
- **跨平台兼容与诊断**：新增跨浏览器剪贴板 fallback（HTTP / Firefox + Violentmonkey / 老旧引擎走隐藏 textarea + execCommand）；检测到移动端 UA 时打一行 console 警告说明本脚本仅在桌面端测试，不阻断功能；live-ws 暴露 `__chatterboxLiveWsCoercion` 全局诊断计数器，便于排查 B 站 payload 结构变化导致的字段丢失。README 列出明确的浏览器支持矩阵（Chrome/Edge ≥ 105、Firefox ≥ 110、Safari ≥ 15.1）。
- **测试与发布检查**：新增 ~30 个单元测试文件，覆盖 clipboard、custom-chat-css-sanitize、user-blacklist-parsers、meme-fetch、platform 检测、log debug-mode、cb-backend client、laplace client、wbi 诊断、备份导入校验等模块；发布检查新增"构建产物 JS body 必须能 parse"的 smoke test，防止打包升级悄悄改坏产物，并将 userscript raw bundle 预算放宽到 975 kB；日志设置新增"调试模式"开关，打开后内部诊断行带 🔍 前缀，便于打包完整日志反馈给维护者。
## 2.9.7

- 新增 `chatterbox-cloud` 自建烂梗后端：包含 Cloudflare Worker、D1 迁移、公开烂梗 API、提交/审核接口、admin 页面和 SBHZM 定时同步任务。
- 烂梗面板接入 chatterbox-cloud 聚合源：开启后优先从后端拉取 LAPLACE、SBHZM 与自建社区库，后端不可用时自动降级到原本的本地直拉逻辑。
- 候选梗贡献区新增提交到 chatterbox-cloud：支持标签字典拉取、关键词推荐、自定义 tag、重复提交识别和复制次数回报。
- 设置页新增 chatterbox-cloud 开关、后端 URL 覆盖和连通性探测，默认生产地址接入 `chatterbox-cloud.aijc-eric.workers.dev`。
- 修复烂梗库串房间问题：非灰泽满直播间不再显示 SBHZM/灰泽满专属烂梗，并为房间筛选逻辑补齐 100% 覆盖的回归测试。
- 智能辅助驾驶状态和烂梗存储迁移继续加固，补充后端客户端、提交验签、状态迁移和 HZM 驾驶状态测试；发布检查同步放宽 userscript raw bundle 预算到 925 kB。
## 2.9.6

- 新增 `chatterbox-cloud` 自建烂梗后端：包含 Cloudflare Worker、D1 迁移、公开烂梗 API、提交/审核接口、admin 页面和 SBHZM 定时同步任务。
- 烂梗面板接入 chatterbox-cloud 聚合源：开启后优先从后端拉取 LAPLACE、SBHZM 与自建社区库，后端不可用时自动降级到原本的本地直拉逻辑。
- 候选梗贡献区新增提交到 chatterbox-cloud：支持标签字典拉取、关键词推荐、自定义 tag、重复提交识别和复制次数回报。
- 设置页新增 chatterbox-cloud 开关、后端 URL 覆盖和连通性探测，默认生产地址接入 `chatterbox-cloud.aijc-eric.workers.dev`。
- 智能辅助驾驶状态和烂梗存储迁移继续加固，补充后端客户端、提交验签、状态迁移和 HZM 驾驶状态测试；发布检查同步放宽 userscript raw bundle 预算到 925 kB。
## 2.9.5

- 内容同 2.9.6（构建/版本元数据更新，未引入新功能）。

## 2.9.4

- 内容同 2.9.6（构建/版本元数据更新，未引入新功能）。

## 2.9.3

- 灰泽满直播间接入 `sbhzm.cn` 专属烂梗库，烂梗面板会同时拉取 LAPLACE 与社区梗源，并提供来源筛选、来源标记和 tag 聚合筛选。
- 候选梗贡献区新增一键上传到灰泽满烂梗库：可自动拉取 tag 字典、按内容推断 tag，并通过 `GM_xmlhttpRequest` 兼容跨域提交。
- 新增「智能辅助驾驶」面板：支持 dryRun、启发式选梗、tag 白名单/黑名单、暂停关键词、每分钟限速、每日统计，以及与文字独轮车共存提示。
- 智驾新增可选 LLM 模式，支持 Anthropic、OpenAI 和 OpenAI 兼容接口；未填写 API Key 时自动回退启发式。
- 烂梗库客户端、GM fetch 封装、智驾选梗、LLM 选择和表情提取补充单元测试，发布检查同步放宽 userscript raw bundle 预算到 900 kB。
## 2.9.2

- 内容同 2.9.3（构建/版本元数据更新，未引入新功能）。

## 2.9.1

- Chatterbox Chat 表情选择器改为 portal 渲染，避开 `backdrop-filter` 容器遮挡，懒加载表情包，首次打开不再黑底/错位；未进直播间时给出"请先进入直播间"提示，避免一直转圈。
- 自动跟车 preset 切换补上「自定义」按钮，点击保留当前数值并自动展开高级设置，不再需要手动改阈值。
- 粉丝牌禁言巡检页面整段重写：状态/统计/操作分区更清晰，改善长列表浏览与排错体验。
- 加固 moderation 与发送校验链路：补充更多风控字段识别与回归测试，发送结果判定更可靠。
- 弹幕替换规则、API 包装、fetch-hijack 安装防御、常量定义做小幅整理与边界修补。
- 新增自动跟车自定义按钮、Chatterbox 发送标记、粉丝牌巡检面板的单元测试。
## 2.9.0

- 内容同 2.9.1（构建/版本元数据更新，未引入新功能）。

## 2.8.59

- Chatterbox Chat 新增表情选择器入口，支持更稳的表情定位、房间表情缓存和权限校验，普通发送与接管聊天区的发送动作进一步统一。
- 自动跟车新增一键切换与发送校验链路，发送后会结合接口结果、回显观察和风控判断给出更明确的成功/失败反馈。
- 新增 Guard Room / Shadow Learn 观察学习能力，支持从直播间行为中沉淀观察规则，并在设置页提供对应的观察配置入口。
- 优化 AI 规避、弹幕替换、烂梗贡献和自定义聊天区 DOM 适配，降低空弹幕、重复事件、页面结构变化导致的误判。
- 设置、引导、备份、粉丝牌巡检和发送页继续整理 UI 文案与状态展示，减少首次使用和排错时的困惑。
- 扩充自动跟车、表情、发送校验、Guard Room、Shadow Learn、版本更新等单元测试，发版前检查覆盖更多关键链路。
## 2.8.58

- 引入 `bun run release:check`：本地一条命令跑完 lint、测试、版本一致性、构建、userscript artifact 校验和 bundle 体积预算，CI 与本地走同一份脚本。
- 拆分发版工作流：`release.yml` 改为 tag 触发（`v*` + `workflow_dispatch`），新增 `pages-deploy.yml` 负责非发版的 master 推送（commit 以 `Release ` 开头时自动跳过），新增 `ci.yml` 校验 PR 与非 master 分支。
- 新增 userscript artifact 校验：在 build 之后逐项检查 `@version`、`@name`、`@namespace`、`@match` 与 sibling `meta.js`，避免 `vite-plugin-monkey` 升级时悄悄改坏元数据。
- 新增版本一致性脚本：在 `package.json`、`GREASYFORK_RELEASE_NOTES.md` 当前/历史小节、构建产物 `@version` 之间做交叉校验，发版时还会对 tag 做严格匹配。
- 整理 `scripts/release.ts`：semver、release notes 解析、Pages 轮询等 helper 提到 `scripts/lib/release-checks.ts`，本地预检与 CI 共享；`gh workflow run` 改为基于 tag 推送后用 `gh run list` 查找工作流 run。
- 启用 Bun ecosystem 的 Dependabot（每周一），按 dev / preact 分组，对 vite/preact/typescript/biome 等关键大版本默认忽略，留人工评估。
## 2.8.57

- 收紧全局 hijack 的安装防御：XHR 与 Response 原型 patch 加上哨兵，嵌入页或重复加载时不再二次包裹 B 站全局对象，减少与页面脚本相互影响。
- 加固设置导入与云端替换规则：导入项按字段做类型校验，不匹配会被丢弃，并拒绝高于当前支持版本的备份；云端关键词补上数量与长度上限，异常配置不会再塞爆替换链。
- Guard Room 同步链路要求 https，仅环回地址放行 http，避免地址写错把同步密钥与观察名单发到非预期目标。
- 自定评论区性能改良：高频去重改 O(1) Map 查找，渲染队列与统计窗口不再逐条 shift，搜索框输入节流 120ms，WS 在线时停掉原生兜底观察器。
- 自动跟车 / 弹幕发送更稳：WS 重连退避加 0–25% 抖动避免多标签锁步重连；AI 规避替换为空时不再发送空弹幕；房间号解析仅承认直播页路径，登录 UID 在边界值下回退到匿名加入。
- 风控字段递归扫描和违禁字段时长解析加上循环引用保护，重复访问相同对象时不再栈溢出。
- 单元测试覆盖大幅扩充（105 用例 / 247 断言），关键修正都有回归保护。
## 2.8.56

- 吸收 LAPLACE Chatterbox 的基础设施改进：新增表情权限 helper，权限不足的锁定表情会在发送前被阻止并给出提示。
- 自动跟车新增「融入黑名单」底层支持，可从 B 站弹幕菜单加入/解除用户，黑名单用户不再参与跟车趋势判断。
- 面板入口和样式开始迁入带 `lc-` 前缀的 UnoCSS 隔离层，同时把 App 里的样式和重挂载副作用拆到独立生命周期模块，降低对 B 站页面的样式污染和维护成本。
- Chatterbox Chat 合并高频 RAF 渲染任务，并给 DOM 兜底观察器加 16ms 批处理；设置页新增关键词搜索，错误提示统一改走面板通知，不再弹浏览器 alert。
- 继续整理架构：按领域拆分 store，拆出 Custom Chat 样式/虚拟列表/原生 DOM 适配/交互 helper；自动跟车日志改为内部事件桥，并降低趋势过期清理频率。
- 首次打开面板新增轻量引导，烂梗库改为展开后再加载，减少面板首屏负担。
## 2.8.55

- 内容同 2.8.56（构建/版本元数据更新，未引入新功能）。

## 2.8.54

- 内容同 2.8.56（构建/版本元数据更新，未引入新功能）。

## 2.8.53

- 内容同 2.8.56（构建/版本元数据更新，未引入新功能）。

## 2.8.52

- 内容同 2.8.56（构建/版本元数据更新，未引入新功能）。

## 2.8.51

- 内容同 2.8.56（构建/版本元数据更新，未引入新功能）。

## 2.8.50

- 内容同 2.8.56（构建/版本元数据更新，未引入新功能）。

## 2.8.49

- 内容同 2.8.56（构建/版本元数据更新，未引入新功能）。

## 2.8.48

- 内容同 2.8.56（构建/版本元数据更新，未引入新功能）。

## 2.8.47

- 内容同 2.8.56（构建/版本元数据更新，未引入新功能）。

## 2.8.46

- 内容同 2.8.56（构建/版本元数据更新，未引入新功能）。

## 2.8.45

- Chatterbox Chat「开 → 关 → 开」自动重挂载现在改为：用户在设置里手动从关切换到开时也会触发一次，保证从关闭状态打开能干净挂载；进直播间时仍然只在已开启状态下重挂载，不会强制接管。
## 2.8.44

- 修复 Chatterbox Chat 关闭后进直播间又会被自动接管的问题：进房间时的「开 → 关 → 开」自动重挂载现在只在用户已开启接管时才执行，关着就不再被强制打开。
## 2.8.43

- Chatterbox Chat 自定义 CSS 编辑器改为防抖保存（400ms），不再每次按键就立即写磁盘和重绘样式，编辑时右下角显示「有待保存更改 / 已保存」状态。
- Chatterbox Chat 评论区状态指示器新增彩色圆点：绿色表示正常连接，橙色脉冲动画表示连接中，橙色表示降级兜底或告警。
## 2.8.42

- 内容同 2.8.43（构建/版本元数据更新，未引入新功能）。

## 2.8.41

- 内容同 2.8.43（构建/版本元数据更新，未引入新功能）。

## 2.8.40

- Chatterbox Chat「接管 B 站聊天区」默认改为关闭（对所有用户生效，包括老用户），更新后不再自动替换原生评论区；需要时在「设置」里手动开启。
## 2.8.39

- Chatterbox Chat「接管 B 站聊天区」默认改为关闭，首次安装不再自动替换原生评论区；需要时在「设置」里手动开启。
## 2.8.38

- 修复 Chatterbox Chat 接管时误隐藏礼物/打赏条的问题：现在隐藏原生聊天区时会保留 `.gift-item`，不再影响直播间礼物展示。
- 收窄原生发送框识别范围：滑块、数字框、按钮、文件/颜色等控件不再被当作聊天输入框，减少误判导致的面板隐藏。
## 2.8.37

- 修复 Chatterbox Chat 聊天区表情不显示的问题：现在聊天区启动时会主动拉取当前直播间表情包缓存，不再依赖独轮车主循环先初始化。
- 普通表情和直播间专属表情都能在 Chatterbox Chat 里正常渲染，不再只剩纯文本 token。
- 表情缓存请求在聊天区停止或切房重挂载时会自动作废旧结果，减少旧房间数据回写导致的显示异常。
## 2.8.36

- 修复 Chatterbox Chat 自动重挂载触发不稳定的问题：进入直播间后现在会更稳地执行一次“开 → 关 → 开”，不再依赖过于死板的房间路径匹配。
- Chatterbox Chat 默认保持：开启接管、关闭“隐藏 B 站原评论列表和原发送框”、开启“直连 WebSocket 获取礼物、醒目留言、进场等事件（DOM 兜底）”。
- 自动重挂载仍然静默执行，不额外刷一条醒目的日志。
## 2.8.35

- Chatterbox Chat 进入直播间后会自动执行一次“开 → 关 → 开”重挂载，减少接管状态卡住或未完整刷新。
- Chatterbox Chat 默认改为：开启接管、关闭“隐藏 B 站原评论列表和原发送框”、开启“直连 WebSocket 获取礼物、醒目留言、进场等事件（DOM 兜底）”。
- 自动重挂载不再额外刷一条醒目的日志，默认日志面板更安静。
## 2.8.34

- 修复自动跟车自定义配置被“监控室 / 保安室”网站统一配置覆盖的问题：现在默认不会再把本地参数重置回 `normal + 试运行`，只有明确开启“允许网站覆盖本地自动跟车配置”或从接管跳转页进入时，才会应用网站下发设定。
## 2.8.33

- 收窄 Chatterbox 接管时的原生输入框隐藏范围：不再继续扫描并隐藏上一层兄弟节点，避免把聊天区外部但同样含输入框的模块一起误隐藏。
## 2.8.32

- 优化直播间号解析兜底：`room_init` 失败时会自动回退到 `get_info`，再不行就直接把现代房间号当作真实房间 ID，减少初始化失败。
- 修复 Chatterbox 接管时原生发送框在不同布局下仍会残留的问题：现在会优先识别并隐藏原生发送栏，但保留礼物/打赏条，不再一刀切误伤同级容器。
- 将「常规发送」折叠区改为原生 `details/summary`，结构更简单，也避免额外状态同步带来的小问题。
## 2.8.31

- 优化弹幕助手面板布局：将「常规发送」移动到自动跟车、烂梗库之后，并支持折叠收起，减少面板默认占用空间。
- 修复开启 Chatterbox Chat 接管后，B 站原生发送栏在部分直播间仍残留或重复显示的问题：现在会更彻底地隐藏同级原生输入容器，并在退出接管时自动恢复。
- 优化评论区徽章显示：不再补出无意义的 `LV0` 等级，合并徽章时只保留有效等级，列表看起来更干净。
## 2.8.30

- 修复自动跟车回显检测逻辑：之前 API 成功后立即产生本地回显，导致等待 WS 广播的检测被短路，无法发现弹幕实际未广播的情况。现在只有收到真实 WS/DOM 广播才算确认；若超时仍未见广播，日志会提示「接口成功，但未看到广播回显」。
## 2.8.29

- 内容同 2.8.30（构建/版本元数据更新，未引入新功能）。

## 2.8.28

- 内容同 2.8.30（构建/版本元数据更新，未引入新功能）。

## 2.8.27

- 内容同 2.8.30（构建/版本元数据更新，未引入新功能）。

## 2.8.26

- 修复自动跟车回显检测逻辑：之前 API 成功后立即产生本地回显，导致等待 WS 广播的检测被短路，无法发现弹幕被 B 站静默过滤的情况。现在只有收到真实 WS/DOM 广播才算确认；若超时仍未见广播，日志会明确提示「弹幕可能被过滤」。
## 2.8.25

- 自动跟车检测到禁言或账号风控时会弹出可见通知，不再只写进日志。
- 错误分类优先匹配 B 站 API 错误码，比字符串匹配更稳定，B 站改文案不会漏报。
- WebSocket 重连在连接异常时改为逐步退避（最长 30 秒），减少对 B 站的频繁重试。
- 粉丝牌禁言巡检新增「下载报告」按钮，可将全量结果保存为 .txt 文件。
- 首次安装后会显示功能引导提示。
- 清除所有生产环境 console 日志输出。
## 2.8.24

- 内容同 2.8.25（构建/版本元数据更新，未引入新功能）。

## 2.8.23

- Chatterbox Chat 新增“暂停跟随/恢复跟随”阅读模式：手动上滑或点暂停后会冻结当前视图，显示未读提示，恢复时再一键回到底部。
- Chatterbox Chat 现在会直接渲染 B 站内置表情，并合并同一条消息的 DOM / WS / 本地补充信息，礼物金额和 `LV` 等级徽章也会显示得更准确。
- 自动跟车发送后会同时等待 WS、DOM 和本地历史回显；就算 WebSocket 没赶上，也更容易正确判断“这条已经成功发出”。

## 2.8.22

- 修复关闭「接管 B 站聊天区（Chatterbox Chat）」后仍然挂载自定义聊天区的问题；关闭后会恢复 B 站原聊天区，并停止 Chatterbox WebSocket 事件源。
- 弹幕助手「发送」页恢复「常规发送」输入框；未接管时可直接在助手里发送，接管时仍可聚焦 Chatterbox 输入框。

## 2.8.21

- Chatterbox Chat 默认常驻接管逻辑，设置页改为「接管/并排」模式，评论区和 WebSocket 事件源不再被总开关误关。
- 自动跟车新增「试运行（只观察，不发送）」开关，并在发送成功后等待聊天区回显，便于判断接口成功但未上屏的情况。
- 弹幕发送接口增加 12 秒超时提示，避免网络卡住时一直停在发送中。
- Chatterbox 事件流压缩进场等轻量事件，强化粉丝牌/舰队/房管/榜单等徽章颜色，并优化手动滚动时的自动暂停和未读提示。

## 2.8.18

- 设置页改成可折叠分组，并把本地全局/直播间替换规则整理成更清晰的表单和规则列表。
- 错误和警告会在面板外直接提示，点击“查看日志”可自动展开日志并定位到底部，不用再猜失败原因藏在哪里。
- 自动跟车高级数值项补充说明，STT 页新增 Soniox API Key 入口，并保留启动失败的具体状态提示。
- 同步更新 Chatterbox Chat 与发布页视觉细节，生成新版 userscript。

## 2.8.17

- 加固 Chatterbox 长时间运行性能：消息数组、渲染队列和 DOM 兜底扫描都增加硬上限，避免高并发后越积越多。
- 渲染队列改为每帧分批处理，极端弹幕量下不再一次性创建大量 DOM 节点导致直播间卡死。
- DOM 兜底 observer 改为候选节点批处理，跳过普通弹幕节点，降低礼物/SC/舰队兜底解析对主页面的压力。
- 移除每条消息的延迟 timer，并取消消息列表频繁 smooth scroll，减少长时间使用后的主线程负担。

## 2.8.16

- Chatterbox 默认聊天气泡重打磨为更接近 Apple iMessage 的视觉：更柔和的圆角、短尾巴、阴影层次、头像尺寸和 meta 间距。
- 礼物、SC、舰队等大卡片事件同步优化尾巴和阴影，和普通弹幕气泡保持同一套 Apple 风格语言。
- 输入区改成更像系统聊天 App 的圆角输入框，并优化事件选中态；“奶绿 iMessage”预设也适配新版气泡尾巴。

## 2.8.15

- 修复不点右上角 `...` 时 Chatterbox 发送框不显示的问题：自定义评论区现在优先挂到评论历史面板的父容器，自己占完整“消息列表 + 发送框”高度，不再被历史列表容器裁掉。
- Chatterbox 发送区改为底部 sticky 兜底，即使 B 站容器高度抖动也会优先保留输入框。
- 原 B 站历史面板仅在 Chatterbox 成功挂到父容器后隐藏，DOM 事件源仍继续用于兜底解析。

## 2.8.14

- 礼物、SC、舰队卡片新增结构化字段 DOM：礼物名、数量、金额、SC 价格/时长、舰队等级/月数等会渲染为 `.lc-chat-card-field`，并带 `data-field` / `data-kind` 方便 CSS 精准换皮。
- 新增 Chatterbox 事件调试面板：点击任意消息可查看 id、data-kind、data-card、data-guard、source、uid、raw cmd 和字段列表，方便继续适配 B 站奇怪 DOM/WS 事件。
- Chatterbox 开启时，弹幕助手“常规发送”不再显示第二个 textarea，只保留聚焦 Chatterbox 输入框和 AI 规避开关，发送入口视觉上合并为一个。

## 2.8.13

- 修复 Chatterbox 发送框可能消失的问题：只有自定义聊天已成功挂载并确认 composer 存在时，才隐藏 B 站原发送框。
- Chatterbox 根节点挂载后会打上 `lc-custom-chat-mounted` 状态，卸载时恢复原生评论/发送框，避免空白兜底失败。
- 自定义发送区增加固定底部布局和最小高度，减少 B 站不同直播间布局下被挤没的概率。

## 2.8.12

- 修复打开 Chatterbox 搜索/显示筛选时可能卡住的问题：筛选和搜索重绘改为分帧批量渲染，不再一次性重建整段聊天 DOM。
- 拆分 Chatterbox 输入框同步和样式设置 effect，避免输入框文本变化时反复重写自定义 CSS，尤其降低带 `@import` 预设时的重排压力。
- WS 异常状态改为温和的“页面兜底运行中”，不再在界面里一直显示刺眼异常；异常/断开时状态样式也不再标红。

## 2.8.11

- 奶绿 iMessage 预设升级为完整 Laplace 风格换皮 CSS，覆盖头像、用户名、粉丝牌、普通气泡、礼物、SC、舰队、红包、天选和进场/关注/点赞/分享类事件。
- Chatterbox 事件总线新增归一化：舰队、红包、天选、关注、点赞、分享等事件会落到稳定 `data-kind` / `data-card` / `data-guard` 语义属性，方便自定义 CSS 精准命中。
- Chatterbox 输入框与弹幕助手常规发送框共享同一份文本状态，偷弹幕、手动输入、发送动作开始向同一个动作系统收敛。
- 新增 Chatterbox 性能调试开关，可显示消息数、每秒事件数、渲染批大小、队列长度和 WS/DOM/local 来源占比。

## 2.8.10

- 修复原版聊天界面新弹幕出现时会自动露出 `偷` / `+1` 按钮的问题；现在只在鼠标悬停到弹幕时显示，除非开启“总是显示偷/+1按钮”。

## 2.8.9

- 修复 Chatterbox Chat 长时间使用后可能卡住的问题：超过消息上限时只裁剪旧 DOM，不再整表重渲染。
- 搜索/筛选等主动重渲染改为批量更新计数和滚动，避免每条消息重复触发昂贵操作。
- 重渲染时不再给历史消息批量挂载动画定时器，降低高弹幕量场景的 CPU 压力。

## 2.8.8

- 修复用户名末尾多出 `:` / `：` 的问题，粉丝牌前缀拆名后也会再清洗一次。
- 右上角 `...` 菜单改为展开后占位显示，不再压住聊天消息。
- 手动向上滚动查看历史时不再被新弹幕强制拖回底部，回到底部后自动清空未读提示。

## 2.8.7

- 修复 B 站装扮提示被误识别成用户名的问题，例如“通过活动获得/查看我的装扮”不再显示为昵称。
- 收紧用户名解析来源，避免把粉丝牌、等级、头像框、装扮说明容器当作用户名。
- 放宽粉丝牌 chip 宽度，`小孩梓 36` 这类粉丝牌优先完整显示。

## 2.8.6

- 修复粉丝牌/等级混进用户名的问题，例如 `小孩梓 44 昵称` 会显示为昵称 + 单独粉丝牌。
- 进一步去重粉丝牌和等级 chip，避免 `小孩梓 44 / 小孩梓 / 44` 重复铺开。
- 重做右上角更多菜单为不透明紧凑控制卡片，避免展开后三点菜单覆盖聊天流变成控制台。

## 2.8.5

- 将 Chatterbox Chat 主界面改成真正的 iMessage 聊天流：搜索、筛选、清屏、WS 状态全部收进右上角更多菜单。
- 普通弹幕不再显示“弹幕”标签；粉丝牌/等级徽章会去重、过滤“这是 TA 的荣耀”等说明性文本。
- `偷`、`+1`、`复制` 改成消息 hover/click 后出现的浮动操作区，不再压住用户名和正文。
- 新增页面 DOM 兜底解析 SC、礼物和舰队/舰长类事件，WS 异常时仍尽量接管原生事件。
- 奶绿 iMessage 预设补全礼物、SC、舰长/提督/总督卡片配色。

## 2.8.4

- 礼物、醒目留言和舰队/舰长类事件改成 Laplace 风格大卡片，在 iMessage 评论流里更醒目。
- 新增“奶绿 iMessage”自定义 CSS 预设，设置页可一键套用或清空。
- 舰队事件会附带 guard 等级标记，方便主题 CSS 针对舰长/提督/总督分别换色。

## 2.8.3

- 修复 Chatterbox Chat 出现横向滚动条的问题：评论列表、消息行、meta 徽章和输入区都限制在容器宽度内。
- 重新打磨 iMessage 风格消息布局：头像列、用户名/粉丝牌可换行、气泡正文自动换行，并增加气泡尾巴和列表上下渐隐。
- 徽章、粉丝牌、长用户名和长弹幕现在会截断或换行，不再把整个评论区撑宽。

## 2.8.2

- Chatterbox Chat 改成 iMessage 气泡式评论区：头像、名字、时间、身份徽章和正文分层显示。
- DOM 兜底弹幕现在会尽量解析用户名、UID、头像、粉丝牌、用户等级、舰队/房管等信息，不再轻易退成一片匿名。
- 评论区样式改成 CSS 变量和语义 class，可覆盖 `--lc-chat-*`、`.lc-chat-bubble`、`.lc-chat-medal` 等选择器快速换皮。
- 压缩顶部工具栏、筛选条和底部发送框，让弹幕多的时候可读内容更多。

## 2.8.1

- 修复自定义评论区空白：不再隐藏承载自定义 Chat 的 `.chat-history-panel` 父容器。
- 修复消息裁剪导致的重复重绘风险，避免评论区渲染后卡住或显示不出来。

## 2.8.0

- Chatterbox Chat 强化右侧评论区接管布局，补充更多原生评论容器隐藏选择器。
- 新增评论区事件过滤条，可快速显示/隐藏弹幕、礼物、SC、进场、通知。
- 新增 WS 状态显示，能看到直连弹幕源是否连接、关闭或异常。
- 新增主题预设：Laplace Dark、Light、Compact。

## 2.7.0

- Chatterbox Chat 支持直连 B 站直播 WebSocket，使用 `@laplace.live/ws/client` 自动重连。
- 新增礼物、醒目留言、进场、通知等事件分层渲染，并保留 DOM 弹幕兜底。
- 新增用户头像显示，使用 Bilibili Avatar as a Service 代理头像。
- 搜索支持 `kind:` 和 `source:` 条件，例如 `kind:gift`、`kind:superchat`、`source:ws`。

## 2.6.0

- 新增 Chatterbox Chat 自定义评论区，可接管 B 站直播间原评论列表和发送框。
- 自定义评论区支持发送弹幕、暂停滚动、清屏、偷弹幕、+1、复制。
- 支持隐藏 B 站原评论区，并保留设置开关用于随时回退。
- 支持粘贴自定义 CSS 覆盖 Chatterbox Chat 样式，方便套用自己的评论区主题。

## 2.5.11

- 优化直播间聊天消息旁的 `偷` / `+1` 操作按钮：改为短小悬浮层，不再撑长弹幕行。
- 新弹幕出现时按钮会短暂露出，之后自动收起；鼠标悬停到评论上仍可再次显示。
- `偷弹幕` 现在会同时填入弹幕助手发送框，并自动复制到剪贴板。

发布前检查：

- `bun run build`
