import { evaluateDecision } from './decision-model'
import {
  activeDecisionProvider,
  autoBlendDecisionPresetId,
  autoBlendDecisionThreshold,
  decisionPresets,
  describeDecisionGap,
} from './decision-settings'

/** Apply the selected sending preset to one qualified auto-blend candidate. */
export async function decideAutoBlendCandidate(
  candidate: string,
  recentMessages: string[],
  signal?: AbortSignal
): Promise<{ send: boolean; reason: string }> {
  const gap = describeDecisionGap()
  if (gap) throw new Error(gap)
  const provider = activeDecisionProvider.value
  const preset = decisionPresets.value.find(p => p.id === autoBlendDecisionPresetId.value)
  if (!provider || !preset) throw new Error('决策模型或判断预设未配置')
  const threshold = autoBlendDecisionThreshold.value
  const { sendProbability } = await evaluateDecision({
    provider,
    preset,
    state: { candidate, recentMessages },
    signal,
  })
  return {
    send: sendProbability >= threshold,
    reason: `「${preset.name || '未命名'}」发送概率 ${Math.round(sendProbability * 100)}%（阈值 ${Math.round(threshold * 100)}%）`,
  }
}
