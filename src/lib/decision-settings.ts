import { computed } from '@preact/signals'

import type { DecisionPreset, DecisionProviderProfile } from './decision-model'

import { DECISION_PROVIDER_DEFAULTS, describeDecisionConnectionGap } from './decision-model'
import { gmSignal } from './gm-signal'

export const settingsDecisionOpen = gmSignal('settingsDecisionOpen', false)
export const decisionProviders = gmSignal<DecisionProviderProfile[]>('decisionProviders', [])
export const decisionActiveProviderId = gmSignal('decisionActiveProviderId', '')
export const activeDecisionProvider = computed<DecisionProviderProfile | null>(() => {
  const providers = decisionProviders.value
  return providers.find(provider => provider.id === decisionActiveProviderId.value) ?? providers[0] ?? null
})

export const decisionPresets = gmSignal<DecisionPreset[]>('decisionPresets', [
  {
    id: 'troll',
    name: '串子',
    instructions:
      '当候选弹幕结合上下文具有反串、反话、反讽或阴阳怪气的玩梗意味时发送。普通陈述、真诚赞美或单纯表达不同意见时不发送。',
  },
  {
    id: 'warm',
    name: '暖男',
    instructions:
      '当候选弹幕真诚地表达关心、安慰、鼓励或体贴，照顾主播或观众的感受时发送。讽刺性夸奖、阴阳怪气、反话或无关内容不发送。',
  },
  {
    id: 'comparison',
    name: '拉踩',
    instructions:
      '当候选弹幕通过比较主播、观众、作品或群体，抬高一方并贬低另一方时发送。单纯陈述差异、没有贬低意味的比较或无关内容不发送。',
  },
])

export const autoBlendDecisionEnabled = gmSignal('autoBlendDecisionEnabled', false)
export const autoBlendDecisionPresetId = gmSignal('autoBlendDecisionPresetId', 'troll')
export const autoBlendDecisionThreshold = gmSignal('autoBlendDecisionThreshold', 0.8)
/** Preset picked by `autoBlendDecisionPresetId`; null when stale (no fallback, so the gap stays visible). */
export const activeDecisionPreset = computed<DecisionPreset | null>(
  () => decisionPresets.value.find(preset => preset.id === autoBlendDecisionPresetId.value) ?? null
)

/** Add and activate a decision provider profile. */
export function addDecisionProvider(): DecisionProviderProfile {
  const provider: DecisionProviderProfile = {
    id: crypto.randomUUID(),
    name: `决策服务商 ${decisionProviders.value.length + 1}`,
    protocol: 'typesafe',
    ...DECISION_PROVIDER_DEFAULTS.typesafe,
    apiKey: '',
    models: [],
  }
  decisionProviders.value = [...decisionProviders.value, provider]
  decisionActiveProviderId.value = provider.id
  return provider
}

/** Remove a provider and select a remaining profile when needed. */
export function removeDecisionProvider(id: string): void {
  const remaining = decisionProviders.value.filter(provider => provider.id !== id)
  decisionProviders.value = remaining
  if (decisionActiveProviderId.value === id || remaining.length === 0) {
    decisionActiveProviderId.value = remaining[0]?.id ?? ''
  }
}

/** Persist a patch to one decision provider profile. */
export function updateDecisionProvider(id: string, patch: Partial<Omit<DecisionProviderProfile, 'id'>>): void {
  decisionProviders.value = decisionProviders.value.map(provider =>
    provider.id === id ? { ...provider, ...patch } : provider
  )
}

/** Everything a decision needs, or a hint naming what's missing. */
export function resolveDecisionConfig():
  | { provider: DecisionProviderProfile; preset: DecisionPreset; threshold: number }
  | string {
  const provider = activeDecisionProvider.value
  if (!provider) return '请先在「设置 → 决策模型」中添加服务商'
  const connectionGap = describeDecisionConnectionGap(provider)
  if (connectionGap) return connectionGap
  if (!provider.model.trim()) return '请先在「设置 → 决策模型」中填写模型 ID'
  const preset = activeDecisionPreset.value
  if (!preset) return '请先选择一个决策预设'
  if (!preset.name.trim() || !preset.instructions.trim()) {
    return '请在「设置 → 决策模型」中补全所选预设的名称与发送条件'
  }
  const threshold = autoBlendDecisionThreshold.value
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) return '发送概率阈值须大于 0% 且不超过 100%'
  return { provider, preset, threshold }
}

/** Explain missing decision configuration, or return null when ready. */
export function describeDecisionGap(): string | null {
  const config = resolveDecisionConfig()
  return typeof config === 'string' ? config : null
}
