import { evaluateDecision } from './decision-model'
import { resolveDecisionConfig } from './decision-settings'

/** Apply the selected sending preset to one qualified auto-blend candidate. */
export async function decideAutoBlendCandidate(
  candidate: string,
  recentMessages: string[],
  signal?: AbortSignal
): Promise<{ send: boolean; reason: string }> {
  const config = resolveDecisionConfig()
  if (typeof config === 'string') throw new Error(config)
  const { provider, preset, threshold } = config
  const { sendProbability } = await evaluateDecision({
    provider,
    preset,
    state: { candidate, recentMessages },
    signal,
  })
  return {
    send: sendProbability >= threshold,
    reason: `「${preset.name}」发送概率 ${Math.round(sendProbability * 100)}%（阈值 ${Math.round(threshold * 100)}%）`,
  }
}
