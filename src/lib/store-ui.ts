import { signal } from '@preact/signals'

import { gmSignal } from './gm-signal'

export const forceScrollDanmaku = gmSignal('forceScrollDanmaku', false)
export const optimizeLayout = gmSignal('optimizeLayout', false)
export const danmakuDirectMode = gmSignal('danmakuDirectMode', true)
export const danmakuDirectConfirm = gmSignal('danmakuDirectConfirm', false)
export const danmakuDirectAlwaysShow = gmSignal('danmakuDirectAlwaysShow', false)
export const activeTab = gmSignal('activeTab', 'fasong')
export const logPanelOpen = gmSignal('logPanelOpen', false)
export const logPanelFocusRequest = signal(0)
export const autoSendPanelOpen = gmSignal('autoSendPanelOpen', true)
export const autoBlendPanelOpen = gmSignal('autoBlendPanelOpen', true)
// 旧字段:`memesPanelOpen`(早期烂梗库是独轮车下面的折叠 supporting feature 时
// 用来记忆展开状态)。Jobs 审计后烂梗库升到顶级 cb-library-section、常驻可见,
// 这个 signal 没有 reader 了。GM 里的持久化旧值留着不动(无害,后续启动不读)。
// 保留在 backup.ts allowlist 让导入/导出不报"未知键"。
/**
 * 主面板「我的状态」(粉丝牌禁言巡检的紧凑视图) 折叠状态。默认折叠 —— 没有
 * 巡检过的新用户看到的是一行 summary("尚未巡检 · 点这里在设置里巡检"),不
 * 占垂直空间。展开后给计数 + top 3 异常 + 跳转设置链接。
 */
export const medalStatusPanelOpen = gmSignal('medalStatusPanelOpen', false)
export const dialogOpen = gmSignal('dialogOpen', false)
export const unlockForbidLive = gmSignal('unlockForbidLive', true)
export const unlockSpaceBlock = gmSignal('unlockSpaceBlock', true)
export const hasSeenWelcome = gmSignal('hasSeenWelcome', false)
export const hasConfirmedAutoBlendRealFire = gmSignal('hasConfirmedAutoBlendRealFire', false)
/**
 * 上次"自动跟车真发"确认弹窗的接受时间（ms epoch）。0 = 从未确认。
 *
 * `hasConfirmedAutoBlendRealFire` 是布尔型且永不过期，这意味着用户第一次
 * 点过"我已了解"之后，半年后回来再开车也不弹窗——但半年前的"我知道"
 * 对现在的状态不一定还成立（账号风控政策变了、用户换了直播节奏、想重新
 * 确认风险）。新增一个 TTL 字段：调用方判断"30 天内确认过 = 不再问"，
 * 超 30 天即视为未确认重新弹。
 */
export const lastAutoBlendRealFireConfirmAt = gmSignal('lastAutoBlendRealFireConfirmAt', 0)
export const lastSeenVersion = gmSignal('lastSeenVersion', '')

/**
 * 设置 Tab 的"显示高级设置"开关。默认 `false` —— 新用户只看到 4-5 个常用 section
 * （Chatterbox Chat / +1 直接动作 / 布局 / 表情 / 备份）。打开后才显示替换规则 /
 * 影子屏蔽 / LLM / 粉丝牌巡检 / chatterbox-cloud 后端 / 雷达 / 日志设置等高级项。
 *
 * 关键例外：当用户在搜索框输入了关键词，所有 section 都会参与匹配，无论这个开关
 * 是否开启 —— 否则"搜索"会因为开关关着而搜不到东西，违反搜索的直觉。
 */
export const settingsAdvancedVisible = gmSignal('settingsAdvancedVisible', false)

/**
 * 仅音频模式。打开时停掉 B 站原生 HLS 视频流，改用懒加载的 mpegts.js 从
 * `only_audio=1` 的安卓 app 端流取真正的 audio-only FLV，挂到一个隐藏
 * `<audio>` 元素上播放 —— 约 180 kbps 对比 1080P 流的 1700 kbps，省约
 * 90% 带宽，CPU/GPU/风扇都下降。多房间同开的 heavy 多房观察者刚需。
 *
 * 默认 OFF。设置入口是右下角 ToggleButton 旁的"仅音频/恢复视频"小按钮
 * （cherry-pick from laplace-live/chatterbox@ecc1b22）。逻辑实现见
 * `src/lib/audio-only.ts`。
 */
export const audioOnlyEnabled = gmSignal('audioOnlyEnabled', false)

/**
 * 自动追帧 (auto-seek)：监听播放器 buffered-ahead，微调 `playbackRate`
 * 把直播延迟压到 ~1.5s。事件驱动 (`progress` / `waiting` / `timeupdate` /
 * `playing` / `ratechange` + MutationObserver)，无定时轮询；后台标签零唤醒。
 * 视频和"仅音频"模式同一套机制 —— 两种模式都通过 `HTMLMediaElement` 的
 * buffered/rate API。算法 (速度梯度 + slowdown 优先) 沿用 c-basalt
 * `Bilibili直播自动追帧` (greasyfork 439875, GPL-3.0) 的实战默认值。
 *
 * 默认 ON。同传 / 智驾 / 烂梗库等 Tier 1/2 功能都依赖"接近实时"的直播
 * 状态：streamer 说什么、弹幕在玩什么——延迟 5-8s 等于这些功能的输出
 * 都晚一个话题。把它默认开就是给这些核心功能续命。
 *
 * 没有 UI 开关 (Jobs 风：开关藏起来，用户感觉到"突然跟得上 streamer 了"
 * 但不知道为什么)。逻辑实现见 `src/lib/auto-seek.ts`。
 */
export const autoSeekEnabled = gmSignal('autoSeekEnabled', true)

/**
 * 目标 buffered-ahead 长度 (秒)。1.5s 是 c-basalt greasyfork 439875 的
 * 默认，跨数千 B 站房间实测稳定 —— 比这低容易在网络抖动时卡顿，比这高
 * 失去追帧意义。不暴露 UI，硬走默认值；进阶用户可以通过 Tampermonkey
 * 编辑 GM 存储自调 (validation 接受 0.3-10 秒)。
 */
export const autoSeekBufferThreshold = gmSignal('autoSeekBufferThreshold', 1.5)

/**
 * 自动追帧实时指标 —— 当前 buffered-ahead 长度 (秒) 和当前 playbackRate。
 * 不持久化 (普通 `signal()` 而非 `gmSignal()`)：刷新页面后从 0/1 开始，
 * 首次 tick 落地后才有真实值。当前没有 UI 消费者；保留发布是为了之后想
 * 在日志面板或 debug 后门里观测时不需要回头改 `auto-seek.ts`。
 */
export const autoSeekCurrentBufferLen = signal(0)
export const autoSeekCurrentRate = signal(1)
