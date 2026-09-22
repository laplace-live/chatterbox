import { activeDecisionPreset, autoBlendDecisionPresetId, decisionPresets } from '../lib/decision-settings'
import { NativeSelect } from './ui/native-select'

/** Picker bound to `autoBlendDecisionPresetId`; keeps a placeholder option while the saved id is stale. */
export function DecisionPresetSelect({ label }: { label: string }) {
  return (
    <NativeSelect
      aria-label={label}
      className='min-w-25 flex-1'
      value={autoBlendDecisionPresetId.value}
      onChange={e => {
        autoBlendDecisionPresetId.value = e.currentTarget.value
      }}
    >
      {!activeDecisionPreset.value && <option value={autoBlendDecisionPresetId.value}>请选择判断预设</option>}
      {decisionPresets.value.map(preset => (
        <option key={preset.id} value={preset.id}>
          {preset.name || '未命名预设'}
        </option>
      ))}
    </NativeSelect>
  )
}
