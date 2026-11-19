import { describeLlmGap, isLlmApiConfigured } from '../lib/llm-tasks'
import {
  handleNormalSendKeyDown,
  normalSendPolishing,
  normalSendPreview,
  polishNormalSendInput,
} from '../lib/normal-send'
import {
  aiEvasion,
  fasongText,
  llmActivePromptNormalSend,
  llmPromptsNormalSend,
  normalSendPanelOpen,
  normalSendRoadRage,
  normalSendWrapBrackets,
  normalSendYolo,
} from '../lib/store'
import { EmoteSelector } from './emote-selector'
import { FansMedalSelector } from './fans-medal-selector'
import { PromptPicker } from './prompt-picker'
import { AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Textarea } from './ui/textarea'

/** Manual danmaku send panel (常规发送) with fans medal and emote pickers, AI polish, YOLO mode, and Road Rage dedup. */
export function NormalSendTab() {
  const llmGap = describeLlmGap('normalSend')
  const llmReady = llmGap === null

  // Shown even when the active draft is empty (llmReady false), so the user can switch to a non-empty draft.
  const showPromptPicker = isLlmApiConfigured() && llmPromptsNormalSend.value.length > 0

  const { msgCount, charCount } = normalSendPreview.value

  return (
    <AccordionItem
      open={normalSendPanelOpen.value}
      onOpenChange={v => {
        normalSendPanelOpen.value = v
      }}
    >
      <AccordionTrigger>常规发送{normalSendYolo.value ? ' ⚡️' : ''}</AccordionTrigger>
      <AccordionContent>
        <div class='relative my-2'>
          <Textarea
            value={fasongText.value}
            // Read-only (not disabled, which drops focus) during polish so the completing write can't clobber fresh keystrokes.
            readOnly={normalSendPolishing.value}
            aria-busy={normalSendPolishing.value}
            onInput={e => {
              fasongText.value = e.currentTarget.value
            }}
            onKeyDown={handleNormalSendKeyDown}
            placeholder={
              normalSendYolo.value && llmReady
                ? 'YOLO 模式：输入后 Enter 会自动 AI 润色并发送'
                : '输入弹幕内容… (Enter 发送)'
            }
            className='h-14 read-only:cursor-not-allowed read-only:opacity-60'
          />
          <div class='pointer-events-none absolute right-2 bottom-1.5 text-ga6'>
            {msgCount > 1 ? `${msgCount} 条 · ${charCount}` : charCount}
          </div>
        </div>

        <div class='my-2 flex items-center gap-1'>
          <FansMedalSelector />
          <EmoteSelector />
          <Button
            variant='outline'
            size='sm'
            title='AI 润色（Alt+Enter）'
            disabled={!llmReady || normalSendPolishing.value || !fasongText.value.trim()}
            onClick={() => void polishNormalSendInput()}
          >
            {normalSendPolishing.value ? '润色中…' : 'AI 润色'}
          </Button>
        </div>

        <div class='my-2 flex items-center gap-1'>
          <Button
            variant={normalSendYolo.value ? 'default' : 'outline'}
            size='sm'
            disabled={!llmReady}
            onClick={() => {
              normalSendYolo.value = !normalSendYolo.value
            }}
          >
            YOLO
          </Button>
          {showPromptPicker && (
            <PromptPicker
              className='min-w-10 truncate'
              title='切换 AI 润色 / YOLO 使用的常规发送提示词'
              prompts={llmPromptsNormalSend.value}
              activeIndex={llmActivePromptNormalSend.value}
              onActiveIndexChange={v => {
                llmActivePromptNormalSend.value = v
              }}
              previewGraphemes={16}
            />
          )}
        </div>

        <div class='my-2 flex flex-wrap items-center gap-2'>
          <Checkbox
            id='aiEvasion'
            checked={aiEvasion.value}
            onInput={e => {
              aiEvasion.value = e.currentTarget.checked
            }}
            label='AI规避（发送失败时自动检测敏感词并重试）'
          />
          <Checkbox
            id='normalSendWrapBrackets'
            checked={normalSendWrapBrackets.value}
            onInput={e => {
              normalSendWrapBrackets.value = e.currentTarget.checked
            }}
            label='使用【】包裹弹幕内容'
          />
          <Checkbox
            id='normalSendRoadRage'
            checked={normalSendRoadRage.value}
            onInput={e => {
              normalSendRoadRage.value = e.currentTarget.checked
            }}
            label='路怒模式（重复发送相同弹幕时自动降重）'
          />
        </div>
      </AccordionContent>
    </AccordionItem>
  )
}
