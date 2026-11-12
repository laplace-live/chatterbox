import { computed } from '@preact/signals'

import type { DecisionPreset, DecisionProviderProfile } from './decision-model'

import { GM_getValue, GM_setValue } from '$'
import { DECISION_PROVIDER_DEFAULTS, describeDecisionConnectionGap, normalizeDecisionModelId } from './decision-model'
import { gmSignal } from './gm-signal'
import { isRecord } from './utils'

const LEGACY_V1_INSTRUCTIONS: Record<string, string> = {
  troll:
    '当候选弹幕结合上下文具有反串、反话、反讽或阴阳怪气的玩梗意味时发送。普通陈述、真诚赞美或单纯表达不同意见时不发送。',
  warm: '当候选弹幕真诚地表达关心、安慰、鼓励或体贴，照顾主播或观众的感受时发送。讽刺性夸奖、阴阳怪气、反话或无关内容不发送。',
  comparison:
    '当候选弹幕通过比较主播、观众、作品或群体，抬高一方并贬低另一方时发送。单纯陈述差异、没有贬低意味的比较或无关内容不发送。',
}

const SAFE_DECISION_PRESET: DecisionPreset = {
  id: 'safe',
  name: '安全跟风',
  instructions: '候选弹幕是否自然贴合当前直播间话题与弹幕氛围，适合作为普通观众顺势跟风发送？',
  trueCriteria: '紧扣近期弹幕正在讨论的梗、画面事件或情绪反应，简短自然、语气合群，混在公屏中不突兀。',
  falseCriteria: '偏离当前直播间话题的自说自话、敏感违规或引战攻击、生硬的AI总结腔、过长说教或明显滞后的旧话题。',
}

/** Built-in structured decision presets. */
export const DEFAULT_DECISION_PRESETS: readonly DecisionPreset[] = [
  {
    id: 'troll',
    name: '串子',
    instructions: '候选弹幕结合直播间上下文，是否在用反话、反串或阴阳怪气的方式调侃玩梗？',
    trueCriteria: '表面顺着夸赞、附和或认错，实则顺着弹幕风向反讽玩梗、故意说反话拱火，带有明显的直播间玩梗语境。',
    falseCriteria:
      '平铺直叙的事实陈述、发自内心的真诚夸奖、直接表达反对意见、无语境的纯脏话人身攻击或与当前话题无关的内容。',
  },
  {
    id: 'warm',
    name: '暖男',
    instructions: '候选弹幕是否在真诚地表达关心、安慰、鼓励或体贴，照顾主播或观众的情绪？',
    trueCriteria: '语气温和自然，在主播受挫、疲惫或互动时给予真诚鼓励、肯定、安慰或贴心提醒。',
    falseCriteria: '阴阳怪气的反话夸奖、敷衍刷屏口号、说教指责、过度油腻冒犯的搭讪或与当前情境无关的内容。',
  },
  {
    id: 'comparison',
    name: '拉踩',
    instructions: '候选弹幕是否通过对比主播、作品、操作或群体，明显抬高一方并贬低另一方？',
    trueCriteria:
      '出现明示或暗示的高下对比（如拿其他主播、前作、队友或观众群体作参照），借吹捧一方来嘲讽或踩低另一方。',
    falseCriteria: '客观讨论版本或玩法差异、不带贬低意味的中性比较、单独评价某一方而未作对比，或与当前话题无关的内容。',
  },
  SAFE_DECISION_PRESET,
]

function cloneDefaultPresets(): DecisionPreset[] {
  return DEFAULT_DECISION_PRESETS.map(preset => ({ ...preset }))
}

export const settingsDecisionOpen = gmSignal('settingsDecisionOpen', false)
export const decisionProviders = gmSignal<DecisionProviderProfile[]>('decisionProviders', [])
export const decisionActiveProviderId = gmSignal('decisionActiveProviderId', '')
export const activeDecisionProvider = computed<DecisionProviderProfile | null>(() => {
  const providers = decisionProviders.value
  return providers.find(provider => provider.id === decisionActiveProviderId.value) ?? providers[0] ?? null
})

// One-shot v2 upgrade; flag lets later edits/deletions stick while pre-v2 backups lacking it still migrate on import.
;(() => {
  if (GM_getValue<boolean>('decisionPresetsSeededV2', false) === true) return
  const stored = GM_getValue<unknown>('decisionPresets', undefined)
  if (Array.isArray(stored)) {
    const isPlainRecord = (v: unknown): v is Record<string, unknown> => isRecord(v) && !Array.isArray(v)
    const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
    const migrated = stored.map(entry => {
      if (!isPlainRecord(entry)) return entry
      if (typeof entry.id !== 'string' || !Object.hasOwn(LEGACY_V1_INSTRUCTIONS, entry.id)) return { ...entry }
      if (
        entry.instructions !== LEGACY_V1_INSTRUCTIONS[entry.id] ||
        hasText(entry.trueCriteria) ||
        hasText(entry.falseCriteria)
      ) {
        return { ...entry }
      }
      const next = DEFAULT_DECISION_PRESETS.find(preset => preset.id === entry.id)
      if (!next) return { ...entry }
      return { ...next, name: hasText(entry.name) ? entry.name : next.name }
    })
    if (migrated.length > 0 && !migrated.some(entry => isPlainRecord(entry) && entry.id === 'safe')) {
      migrated.push({ ...SAFE_DECISION_PRESET })
    }
    GM_setValue('decisionPresets', migrated)
  }
  GM_setValue('decisionPresetsSeededV2', true)
})()

export const decisionPresets = gmSignal<DecisionPreset[]>('decisionPresets', cloneDefaultPresets())

export const autoBlendDecisionEnabled = gmSignal('autoBlendDecisionEnabled', false)
export const autoBlendDecisionPresetId = gmSignal('autoBlendDecisionPresetId', 'troll')
export const autoBlendDecisionThreshold = gmSignal('autoBlendDecisionThreshold', 0.8)
/** Preset picked by `autoBlendDecisionPresetId`; null when stale (no fallback, so the gap stays visible). */
export const activeDecisionPreset = computed<DecisionPreset | null>(
  () => decisionPresets.value.find(preset => preset.id === autoBlendDecisionPresetId.value) ?? null
)

/** Restore built-in decision presets and fall back to the first preset if the active ID is stale. */
export function resetDecisionPresets(): void {
  decisionPresets.value = cloneDefaultPresets()
  if (!DEFAULT_DECISION_PRESETS.some(preset => preset.id === autoBlendDecisionPresetId.value)) {
    autoBlendDecisionPresetId.value = DEFAULT_DECISION_PRESETS[0].id
  }
}

/** Add and activate a decision provider profile. */
export function addDecisionProvider(): DecisionProviderProfile {
  const provider: DecisionProviderProfile = {
    id: crypto.randomUUID(),
    name: `决策服务商 ${decisionProviders.value.length + 1}`,
    protocol: 'gemini',
    ...DECISION_PROVIDER_DEFAULTS.gemini,
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
  if (!normalizeDecisionModelId(provider.protocol, provider.model)) return '请先在「设置 → 决策模型」中填写模型 ID'
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
