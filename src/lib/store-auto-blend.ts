import { computed, signal } from '@preact/signals'

import type { AutoBlendCandidateProgress } from './auto-blend-status'

import { AUTO_BLEND_PRESETS, type AutoBlendPreset } from './auto-blend-preset-config'
import { gmSignal, numericGmSignal } from './gm-signal'

// 自动跟车 (auto-blend internally): send when any message hits N repeats within W seconds,
// then freeze the detector for C seconds. A routine timer picks from active candidates
// by weighted random choice for sustained multi-topic trends.
// Optional: require N distinct users for a stricter social-consensus trigger.
export const autoBlendWindowSec = numericGmSignal('autoBlendWindowSec', 20, { min: 1, max: 600 })
export const autoBlendThreshold = numericGmSignal('autoBlendThreshold', 4, { min: 1, max: 100, integer: true })
export const autoBlendCooldownSec = numericGmSignal('autoBlendCooldownSec', 35, { min: 1, max: 3600 })
// 自动冷却：开启后按当前房间弹幕速率(CPM)动态算冷却。冷场拉长到上限,
// 高峰压到下限——避免一刀切的固定冷却在两种极端下都不合适。开启时上面的
// autoBlendCooldownSec 数值被忽略。从 upstream chatterbox 76cc1ba 移植。
export const autoBlendCooldownAuto = gmSignal('autoBlendCooldownAuto', false)
export const autoBlendRoutineIntervalSec = numericGmSignal('autoBlendRoutineIntervalSec', 60, { min: 5, max: 3600 })
export const autoBlendBurstSettleMs = numericGmSignal('autoBlendBurstSettleMs', 1500, { min: 100, max: 60000 })
export const autoBlendRateLimitWindowMin = numericGmSignal('autoBlendRateLimitWindowMin', 10, { min: 1, max: 1440 })
export const autoBlendRateLimitStopThreshold = numericGmSignal('autoBlendRateLimitStopThreshold', 3, {
  min: 1,
  max: 100,
  integer: true,
})
export const autoBlendPreset = gmSignal<'safe' | 'normal' | 'hot' | 'custom'>('autoBlendPreset', 'normal')
// Last preset that was actually applied via applyAutoBlendPreset(). When the
// user later tweaks a number and the preset flips to 'custom', this remembers
// the baseline so the UI can show "基于正常档 +X% 激进" + a one-click reset.
// Default 'normal' covers the case where someone modifies before ever clicking
// a preset button (initial preset is also 'normal').
export const lastAppliedPresetBaseline = gmSignal<AutoBlendPreset>('lastAppliedPresetBaseline', 'normal')
export const autoBlendAdvancedOpen = gmSignal('autoBlendAdvancedOpen', false)
// 自动跟车试运行默认 ON（新用户安全起步）。从用户视角："第一次开跟车不会真发,
// 让你先看看脚本想发什么,确认后再切到真发"——这是 Apple 的招数:危险默认 → 安全。
//
// 历史包袱：之前 v2.x 期间，autoBlendDryRunVisibleDefaultMigrated 这个一次性
// migration 曾经把已有用户的 dryRun=true 强制改回 false（当时默认是 false，
// 想清理掉一波早期默认 true 留下的"为什么不发"困惑）。Jobs 式审计后翻转回
// 默认 true:对没改过设置的新用户更安全,有改过的老用户依然保留他们的最后
// 选择（GM 持久值优先）。
//
// 旧 migration 已删除——它是一个单次清理,已跑过的用户全部已被它写入 false,
// 不再生效;没跑过的用户极少（早就升级过了）,即便他们撞上新默认 true 也是
// 朝安全方向收敛。
export const autoBlendDryRun = gmSignal('autoBlendDryRun', true)
/**
 * @public Forward-compat GM key — UI removed but GM storage / backup payloads
 * still round-trip through this signal so old values aren't lost. Not currently
 * read by any production code path.
 */
export const autoBlendAvoidRisky = gmSignal('autoBlendAvoidRisky', true)
/** @public Forward-compat — see {@link autoBlendAvoidRisky}. */
export const autoBlendBlockedWords = gmSignal('autoBlendBlockedWords', '抽奖\n加群\n私信\n房管\n举报')
// 旧的 `autoBlendIncludeReply` 已经移除：自上游 chatterbox 624de4e 起 @ 回复
// 一律不入候选（@ 是定向对话,不应该被自动跟车放大）。store 里也不再持久化对应
// signal——backup 老备份里若包含此 key 会被 backup.ts 的 unknown-keys 流程
// 静默忽略（旧值在 GM 存储里残留也无害,没人读它）。
export const autoBlendUseReplacements = gmSignal('autoBlendUseReplacements', true)
// 不重复上次自动发送：开启后,与上一次自动跟车发出去的弹幕完全相同的新弹幕
// 不再计入候选,避免冷却结束后被同一句话立刻再次刷上去。仅作用于一次
// startAutoBlend 周期(stop 时清空)。从 upstream chatterbox 32b9b84 移植。
//
// 默认 **true**：跟车的语义是"跟着 community 走"。一次会话里同一句话被脚本
// 跟两次=用户一个号在短时间里塞了同样两遍，既不像人，也加重被风控识别为
// 重复刷屏的风险。默认避免重复 = 更分散、更自然。如果用户就是想反复跟同一
// 句热门梗，可手动关掉这个开关。老用户持久值不变。
export const autoBlendAvoidRepeat = gmSignal('autoBlendAvoidRepeat', true)
export const autoBlendRequireDistinctUsers = gmSignal('autoBlendRequireDistinctUsers', true)
export const autoBlendMinDistinctUsers = numericGmSignal('autoBlendMinDistinctUsers', 3, {
  min: 1,
  max: 100,
  integer: true,
})
export const autoBlendSendCount = numericGmSignal('autoBlendSendCount', 1, { min: 1, max: 50, integer: true })
export const autoBlendUserBlacklist = gmSignal<Record<string, string>>('autoBlendUserBlacklist', {})
// 文本黑名单(精确匹配,trim 后):某些万能水弹幕("666"、"+1"、"哈哈哈")
// 即使触发达标也不希望我们去跟。和上面 UID 黑名单互补——一个是按人,
// 一个是按内容。键存 trim 后的文本,值固定为 true(用 Record 而非 Set
// 是为了 GM_setValue 的可序列化语义)。从 upstream chatterbox 2820b45
// 移植,采纳 16972c7 的 Object.hasOwn 修复(避免命中 Object.prototype 的
// 内置 key 例如 "toString"、"constructor")。
export const autoBlendMessageBlacklist = gmSignal<Record<string, true>>('autoBlendMessageBlacklist', {})
// When enabled, a burst trigger sends ALL currently-trending messages (sorted by
// count) instead of just the one that crossed the threshold first.
// The routine timer always picks one message per tick (weighted random).
export const autoBlendSendAllTrending = gmSignal('autoBlendSendAllTrending', false)

export const autoBlendEnabled = signal(false)
export const autoBlendStatusText = signal('已关闭')
export const autoBlendCandidateText = signal('暂无')
export const autoBlendLastActionText = signal('暂无')
// Structured snapshot of the leading candidate's progress towards the trigger
// thresholds. Drives the progress bar in the panel; null = no candidate yet.
export const autoBlendCandidateProgress = signal<AutoBlendCandidateProgress | null>(null)

export interface AutoBlendDrift {
  baselinePreset: AutoBlendPreset | null
  driftPercent: number
}

// 把当前数值与基线档比，得到一个有符号的"激进度偏移"。正值=比基线更激进
// (更短窗口/更低阈值/更短冷却/更少人数都算激进)，负值=更保守。权重把
// threshold 与 cooldown 提到 2，因为这两个对触发节奏的体感影响最大。
export const autoBlendDriftFromPreset = computed<AutoBlendDrift>(() => {
  const preset = autoBlendPreset.value
  if (preset !== 'custom') return { baselinePreset: preset, driftPercent: 0 }

  const baseline = AUTO_BLEND_PRESETS[lastAppliedPresetBaseline.value]
  // 各字段方向：threshold/cooldownSec/minDistinctUsers 越低越激进，windowSec
  // 越长越激进（窗口越长越容易凑齐 N 条）。统一成 +ve = aggressive。
  const offsets: Array<[number, number]> = [
    [(autoBlendWindowSec.value - baseline.windowSec) / baseline.windowSec, 1],
    [(baseline.threshold - autoBlendThreshold.value) / baseline.threshold, 2],
    [(baseline.cooldownSec - autoBlendCooldownSec.value) / baseline.cooldownSec, 2],
    [(baseline.minDistinctUsers - autoBlendMinDistinctUsers.value) / baseline.minDistinctUsers, 1],
  ]
  const totalWeight = offsets.reduce((s, [, w]) => s + w, 0)
  const weighted = offsets.reduce((s, [v, w]) => s + v * w, 0) / totalWeight
  return {
    baselinePreset: lastAppliedPresetBaseline.value,
    driftPercent: Math.round(weighted * 100),
  }
})
