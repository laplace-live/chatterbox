import {
  autoBlendCooldownSec,
  autoBlendEnabled,
  autoBlendIncludeReply,
  autoBlendMinOccurrences,
  autoBlendPanelOpen,
  autoBlendSendCount,
  autoBlendUniqueUsers,
  autoBlendUseReplacements,
  autoBlendWindowSec,
  cachedRoomId,
  persistAutoBlendState,
} from '../lib/store'

function NumberInput({
  value,
  min,
  max,
  width = '40px',
  onChange,
}: {
  value: number
  min: number
  max?: number
  width?: string
  onChange: (n: number) => void
}) {
  return (
    <input
      type='number'
      autocomplete='off'
      min={String(min)}
      max={max !== undefined ? String(max) : undefined}
      style={{ width }}
      value={value}
      onInput={e => {
        let v = parseInt(e.currentTarget.value, 10)
        if (Number.isNaN(v) || v < min) v = min
        if (max !== undefined && v > max) v = max
        onChange(v)
      }}
    />
  )
}

export function AutoBlendControls() {
  const toggleEnabled = () => {
    autoBlendEnabled.value = !autoBlendEnabled.value
  }

  return (
    <details
      open={autoBlendPanelOpen.value}
      onToggle={e => {
        autoBlendPanelOpen.value = e.currentTarget.open
      }}
    >
      <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 'bold' }}>
        自动融入{autoBlendEnabled.value ? ' 🟣' : ''}
      </summary>

      <div style={{ margin: '.5em 0', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.25em' }}>
        <button type='button' onClick={toggleEnabled}>
          {autoBlendEnabled.value ? '停止融入' : '开始融入'}
        </button>
      </div>

      <div
        style={{
          margin: '.5em 0',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '.5em',
          alignItems: 'center',
          color: autoBlendEnabled.value ? undefined : '#999',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
          <span>触发：</span>
          <NumberInput
            value={autoBlendUniqueUsers.value}
            min={1}
            onChange={v => {
              autoBlendUniqueUsers.value = v
            }}
          />
          <span>人在</span>
          <NumberInput
            value={autoBlendWindowSec.value}
            min={3}
            onChange={v => {
              autoBlendWindowSec.value = v
            }}
          />
          <span>秒内重复</span>
          <NumberInput
            value={autoBlendMinOccurrences.value}
            min={autoBlendUniqueUsers.value}
            onChange={v => {
              autoBlendMinOccurrences.value = v
            }}
          />
          <span>次</span>
        </span>
      </div>

      <div
        style={{
          margin: '.5em 0',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '.5em',
          alignItems: 'center',
          color: autoBlendEnabled.value ? undefined : '#999',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
          <span>跟车</span>
          <NumberInput
            value={autoBlendSendCount.value}
            min={1}
            max={20}
            onChange={v => {
              autoBlendSendCount.value = v
            }}
          />
          <span>次</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
          <span>自动融入冷却</span>
          <NumberInput
            value={autoBlendCooldownSec.value}
            min={4}
            width='50px'
            onChange={v => {
              autoBlendCooldownSec.value = v
            }}
          />
          <span>秒</span>
        </span>
      </div>

      <div
        style={{
          margin: '.5em 0',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '.75em',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
          <input
            id='autoBlendIncludeReply'
            type='checkbox'
            checked={autoBlendIncludeReply.value}
            onInput={e => {
              autoBlendIncludeReply.value = e.currentTarget.checked
            }}
          />
          <label for='autoBlendIncludeReply'>包含 @ 回复弹幕</label>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
          <input
            id='autoBlendUseReplacements'
            type='checkbox'
            checked={autoBlendUseReplacements.value}
            onInput={e => {
              autoBlendUseReplacements.value = e.currentTarget.checked
            }}
          />
          <label for='autoBlendUseReplacements'>应用替换规则</label>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
          <input
            id='persistAutoBlendState'
            type='checkbox'
            disabled={cachedRoomId.value === null}
            checked={cachedRoomId.value !== null && !!persistAutoBlendState.value[String(cachedRoomId.value)]}
            onInput={e => {
              const roomId = cachedRoomId.value
              if (roomId === null) return
              persistAutoBlendState.value = {
                ...persistAutoBlendState.value,
                [String(roomId)]: e.currentTarget.checked,
              }
            }}
          />
          <label for='persistAutoBlendState'>保持当前直播间自动融入开关状态</label>
        </span>
      </div>

      <div style={{ color: '#999', fontSize: '12px', lineHeight: 1.5 }}>监测当前直播间弹幕，自动跟车热门弹幕</div>
    </details>
  )
}
