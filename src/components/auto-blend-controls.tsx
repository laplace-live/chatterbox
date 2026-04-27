import { cn } from '../lib/cn'
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

// Each Label wraps a hint + NumberInput pair, laid out as an inline flex row.
const FIELD_LABEL_CLASS = 'lc-inline-flex lc-items-center lc-gap-1'

function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number
  min: number
  max?: number
  onChange: (n: number) => void
}) {
  return (
    <Input
      type='number'
      autocomplete='off'
      min={String(min)}
      max={max !== undefined ? String(max) : undefined}
      className={'lc-w-[50px]'}
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
        <div class='lc-my-2 lc-flex lc-items-center lc-flex-wrap lc-gap-1'>
          <Button variant={autoBlendEnabled.value ? 'destructive' : 'default'} size='sm' onClick={toggleEnabled}>
            {autoBlendEnabled.value ? '停止融入' : '开始融入'}
          </Button>
        </div>

        <div
          class={cn(
            'lc-my-2 lc-flex lc-flex-wrap lc-items-center lc-gap-y-1 lc-gap-x-2',
            // Grey out the field labels when blend is off — applied at the
            // group level so the inline NumberInputs (which don't inherit
            // because they style themselves explicitly) and the surrounding
            // Chinese hint text both dim together.
            !autoBlendEnabled.value && 'lc-text-ga4'
          )}
        >
          <Label className={FIELD_LABEL_CLASS}>
            触发：
            <NumberInput
              value={autoBlendUniqueUsers.value}
              min={1}
              onChange={v => {
                autoBlendUniqueUsers.value = v
              }}
            />
          </Label>
          <Label className={FIELD_LABEL_CLASS}>
            人在
            <NumberInput
              value={autoBlendWindowSec.value}
              min={3}
              onChange={v => {
                autoBlendWindowSec.value = v
              }}
            />
          </Label>
          <Label className={FIELD_LABEL_CLASS}>
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

          <Label className={FIELD_LABEL_CLASS}>
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
          <Label className={FIELD_LABEL_CLASS}>
            自动融入冷却
            <NumberInput
              value={autoBlendCooldownSec.value}
              min={4}
              onChange={v => {
                autoBlendCooldownSec.value = v
              }}
            />
            秒
          </Label>
        </div>

        <div class='lc-my-2 lc-flex lc-flex-wrap lc-gap-3'>
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

        <div class='lc-text-ga4 lc-text-sm lc-leading-[1.5]'>监测当前直播间弹幕，自动跟车热门弹幕</div>
      </AccordionContent>
    </AccordionItem>
  )
}
