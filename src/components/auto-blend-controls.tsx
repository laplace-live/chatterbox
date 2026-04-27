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
import { AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'

function NumberInput({
  value,
  min,
  max,
  width = '50px',
  onChange,
}: {
  value: number
  min: number
  max?: number
  width?: string
  onChange: (n: number) => void
}) {
  return (
    <Input
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
    <AccordionItem
      open={autoBlendPanelOpen.value}
      onOpenChange={v => {
        autoBlendPanelOpen.value = v
      }}
    >
      <AccordionTrigger>自动融入{autoBlendEnabled.value ? ' 🟣' : ''}</AccordionTrigger>
      <AccordionContent>
        <div style={{ margin: '.5em 0', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.25em' }}>
          <Button variant={autoBlendEnabled.value ? 'destructive' : 'default'} size='sm' onClick={toggleEnabled}>
            {autoBlendEnabled.value ? '停止融入' : '开始融入'}
          </Button>
        </div>

        <div
          style={{
            margin: '.5rem 0',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '.25rem 0.5rem',
            alignItems: 'center',
            color: autoBlendEnabled.value ? undefined : '#999',
          }}
        >
          <Label style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            触发：
            <NumberInput
              value={autoBlendUniqueUsers.value}
              min={1}
              onChange={v => {
                autoBlendUniqueUsers.value = v
              }}
            />
          </Label>
          <Label style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            人在
            <NumberInput
              value={autoBlendWindowSec.value}
              min={3}
              onChange={v => {
                autoBlendWindowSec.value = v
              }}
            />
          </Label>
          <Label style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            秒内重复
            <NumberInput
              value={autoBlendMinOccurrences.value}
              min={autoBlendUniqueUsers.value}
              onChange={v => {
                autoBlendMinOccurrences.value = v
              }}
            />
            次
          </Label>

          <Label style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            跟车
            <NumberInput
              value={autoBlendSendCount.value}
              min={1}
              max={20}
              onChange={v => {
                autoBlendSendCount.value = v
              }}
            />
            次
          </Label>
          <Label style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            自动融入冷却
            <NumberInput
              value={autoBlendCooldownSec.value}
              min={4}
              width='50px'
              onChange={v => {
                autoBlendCooldownSec.value = v
              }}
            />
            秒
          </Label>
        </div>

        <div
          style={{
            margin: '.5em 0',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '.75em',
          }}
        >
          <Checkbox
            id='autoBlendIncludeReply'
            checked={autoBlendIncludeReply.value}
            onInput={e => {
              autoBlendIncludeReply.value = e.currentTarget.checked
            }}
            label='包含 @ 回复弹幕'
          />
          <Checkbox
            id='autoBlendUseReplacements'
            checked={autoBlendUseReplacements.value}
            onInput={e => {
              autoBlendUseReplacements.value = e.currentTarget.checked
            }}
            label='应用替换规则'
          />
          <Checkbox
            id='persistAutoBlendState'
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
            label='保持当前直播间自动融入开关状态'
          />
        </div>

        <div style={{ color: '#999', fontSize: '12px', lineHeight: 1.5 }}>监测当前直播间弹幕，自动跟车热门弹幕</div>
      </AccordionContent>
    </AccordionItem>
  )
}
