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
export const memesPanelOpen = gmSignal('memesPanelOpen', false)
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
