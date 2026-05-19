import { autoBlendStatus, CANDIDATE_LIMIT } from '../lib/auto-blend'
import { cn } from '../lib/cn'
import { describeLlmGap, isLlmApiConfigured } from '../lib/llm-tasks'
import {
  autoBlendAvoidRepeat,
  autoBlendCooldownAuto,
  autoBlendCooldownSec,
  autoBlendEnabled,
  autoBlendMinOccurrences,
  autoBlendPanelOpen,
  autoBlendSendCount,
  autoBlendUniqueUsers,
  autoBlendUseReplacements,
  autoBlendWindowSec,
  autoBlendYolo,
  cachedRoomId,
  llmActivePromptAutoBlend,
  llmPromptsAutoBlend,
  persistAutoBlendState,
} from '../lib/store'
import { PromptPicker } from './prompt-picker'
import { AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'

function NumberInput({
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  value: number
  min: number
  max?: number
  disabled?: boolean
  onChange: (n: number) => void
}) {
  return (
    <Input
      type='number'
      autocomplete='off'
      min={String(min)}
      max={max !== undefined ? String(max) : undefined}
      className={'w-12.5'}
      value={value}
      disabled={disabled}
      onInput={e => {
        let v = parseInt(e.currentTarget.value, 10)
        if (Number.isNaN(v) || v < min) v = min
        if (max !== undefined && v > max) v = max
        onChange(v)
      }}
    />
  )
}

/**
 * Live "融入候选" leaderboard plus chat-velocity / cooldown readout. Shown
 * only while 自动融入 is running, so the user can see:
 *
 * - which danmaku are accumulating toward the trigger,
 * - the room's current CPM (chats per minute), which drives adaptive
 *   cooldown when it's enabled,
 * - what the next cooldown will be (or how much of the current one is
 *   left).
 *
 * Each candidate row colours `n/threshold` in `text-brand` once the
 * threshold is met, making it obvious at a glance which axis (人 vs 条) is
 * the bottleneck — since a candidate must hit BOTH thresholds before
 * triggering, you'll typically see one number green and the other neutral.
 */
function AutoBlendStatus() {
  const { candidates, cooldownRemainingSec, chatsPerMinute, cooldownEffectiveSec } = autoBlendStatus.value
  const userThreshold = autoBlendUniqueUsers.value
  const countThreshold = autoBlendMinOccurrences.value
  const auto = autoBlendCooldownAuto.value

  return (
    <div class='my-2 flex flex-col gap-1 rounded-sm bg-ga1 px-2 py-1.5'>
      <div class='flex items-center justify-between gap-2 text-ga6'>
        <span class='shrink-0'>候选 (前 {CANDIDATE_LIMIT})</span>
        <span class='min-w-0 truncate text-right'>
          <span>弹幕 {chatsPerMinute} 条/分</span>
          {cooldownRemainingSec > 0 ? (
            <>
              <span> · </span>
              <span class='text-brand'>冷却中 {cooldownRemainingSec} 秒</span>
            </>
          ) : (
            // Only surface the would-be cooldown when auto is on — the
            // manual value is already visible in the input above, so
            // restating it here would just be noise.
            auto && (
              <>
                <span> · </span>
                <span>冷却 {cooldownEffectiveSec} 秒</span>
              </>
            )
          )}
        </span>
      </div>
      {candidates.length === 0 ? (
        <div class='text-ga6'>{cooldownRemainingSec > 0 ? '冷却中，暂停统计' : '暂无统计'}</div>
      ) : (
        candidates.map((entry, i) => (
          <div key={entry.text} class='flex items-center gap-2 leading-tight' title={entry.text}>
            <span class='w-3 shrink-0 text-right text-ga6'>{i + 1}</span>
            <span class='min-w-0 flex-1 truncate'>{entry.text}</span>
            <span class='shrink-0 font-mono text-[11px] text-ga6'>
              <span class={entry.uniqueUsers >= userThreshold ? 'text-brand' : ''}>
                {entry.uniqueUsers}/{userThreshold}
              </span>
              <span> 人 </span>
              <span class={entry.totalCount >= countThreshold ? 'text-brand' : ''}>
                {entry.totalCount}/{countThreshold}
              </span>
              <span> 条</span>
            </span>
          </div>
        ))
      )}
    </div>
  )
}

export function AutoBlendControls() {
  const toggleEnabled = () => {
    autoBlendEnabled.value = !autoBlendEnabled.value
  }

  // YOLO toggle gating + inline picker visibility — same logic
  // shape as 常规发送, scoped to the autoBlend feature instead. The
  // toggle is enabled only when the LLM is fully usable for autoBlend
  // (API + active autoBlend prompt). The picker shows as soon as API
  // is configured AND there's at least one autoBlend draft, even when
  // the active draft is empty (so the user can recover by switching
  // to a non-empty draft without leaving the tab).
  const llmGap = describeLlmGap('autoBlend')
  const llmReady = llmGap === null
  const showPromptPicker = isLlmApiConfigured() && llmPromptsAutoBlend.value.length > 0

  return (
    <AccordionItem
      open={autoBlendPanelOpen.value}
      onOpenChange={v => {
        autoBlendPanelOpen.value = v
      }}
    >
      {/* Two independent run-state markers in the title: 🟣 = blend
          detector running, ⚡️ = YOLO polish active. Both can be on
          at once and the user wants to see both states without
          expanding the panel. */}
      <AccordionTrigger>
        自动融入{autoBlendEnabled.value ? ' 🟣' : ''}
        {autoBlendYolo.value ? ' ⚡️' : ''}
      </AccordionTrigger>
      <AccordionContent>
        <div class='my-2 flex items-center gap-1'>
          <Button variant={autoBlendEnabled.value ? 'destructive' : 'default'} size='sm' onClick={toggleEnabled}>
            {autoBlendEnabled.value ? '停止融入' : '开始融入'}
          </Button>
          <Button
            // Variant flip mirrors the 常规发送 YOLO button — outline
            // when off, brand-coloured fill when on. Same affordance
            // pattern across every YOLO toggle so the visual language
            // stays consistent.
            variant={autoBlendYolo.value ? 'default' : 'outline'}
            size='sm'
            disabled={!llmReady}
            onClick={() => {
              autoBlendYolo.value = !autoBlendYolo.value
            }}
          >
            YOLO
          </Button>
          {showPromptPicker && (
            // Inline switcher for the active 自动融入 prompt — the
            // PromptManager in Settings is still the place to author
            // / edit / reorder the list, this is just for hot-
            // swapping which one feeds the YOLO polish without
            // leaving this tab. Smaller grapheme cap than the
            // Settings picker to keep the row readable in the
            // narrowest dialog width.
            <PromptPicker
              className='min-w-10 truncate'
              title='切换 YOLO 使用的自动融入提示词'
              prompts={llmPromptsAutoBlend.value}
              activeIndex={llmActivePromptAutoBlend.value}
              onActiveIndexChange={v => {
                llmActivePromptAutoBlend.value = v
              }}
              previewGraphemes={16}
            />
          )}
          {!llmReady && <span class='ml-1 text-ga6'>AI 功能需配置 LLM 后启用</span>}
        </div>

        <div
          class={cn(
            'my-2 flex flex-wrap items-center gap-x-2 gap-y-1',
            // Grey out the field labels when blend is off — applied at the
            // group level so the inline NumberInputs (which don't inherit
            // because they style themselves explicitly) and the surrounding
            // Chinese hint text both dim together.
            !autoBlendEnabled.value && 'text-ga4'
          )}
        >
          <Label className={'inline-flex items-center gap-1'}>
            触发：
            <NumberInput
              value={autoBlendUniqueUsers.value}
              min={1}
              onChange={v => {
                autoBlendUniqueUsers.value = v
              }}
            />
          </Label>
          <Label className={'inline-flex items-center gap-1'}>
            人在
            <NumberInput
              value={autoBlendWindowSec.value}
              min={3}
              onChange={v => {
                autoBlendWindowSec.value = v
              }}
            />
          </Label>
          <Label className={'inline-flex items-center gap-1'}>
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

          <Label className={'inline-flex items-center gap-1'}>
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
          <Label className={'inline-flex items-center gap-1'}>
            自动融入冷却
            <NumberInput
              value={autoBlendCooldownSec.value}
              min={4}
              disabled={autoBlendCooldownAuto.value}
              onChange={v => {
                autoBlendCooldownSec.value = v
              }}
            />
            秒
          </Label>
        </div>

        <div class='my-2 flex flex-wrap gap-3'>
          <Checkbox
            id='autoBlendUseReplacements'
            checked={autoBlendUseReplacements.value}
            onInput={e => {
              autoBlendUseReplacements.value = e.currentTarget.checked
            }}
            label='应用替换规则'
          />
          <Checkbox
            id='autoBlendCooldownAuto'
            checked={autoBlendCooldownAuto.value}
            onInput={e => {
              autoBlendCooldownAuto.value = e.currentTarget.checked
            }}
            label='自动冷却（按弹幕速率）'
          />
          <Checkbox
            id='autoBlendAvoidRepeat'
            checked={autoBlendAvoidRepeat.value}
            onInput={e => {
              autoBlendAvoidRepeat.value = e.currentTarget.checked
            }}
            label='不重复上次自动发送'
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

        {autoBlendEnabled.value && <AutoBlendStatus />}
      </AccordionContent>
    </AccordionItem>
  )
}
