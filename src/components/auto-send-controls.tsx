import { describeLlmGap, isLlmApiConfigured } from '../lib/llm-tasks'
import { appendLog } from '../lib/log'
import { cancelLoop } from '../lib/loop'
import {
  activeTemplateIndex,
  autoSendPanelOpen,
  autoSendYolo,
  cachedRoomId,
  llmActivePromptAutoSend,
  llmPromptsAutoSend,
  maxLength,
  msgSendInterval,
  msgTemplates,
  persistSendState,
  randomChar,
  randomColor,
  randomInterval,
  sendMsg,
} from '../lib/store'
import { getGraphemes, processMessages, trimText } from '../lib/utils'
import { PromptPicker } from './prompt-picker'
import { AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Combobox } from './ui/combobox'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'

function getPreview(template: string): string {
  const firstLine = (template.split('\n')[0] ?? '').trim()
  if (!firstLine) return '(空)'
  return getGraphemes(firstLine).length > 10 ? `${trimText(firstLine, 40)[0]}…` : firstLine
}

export function AutoSendControls() {
  const templates = msgTemplates.value
  const idx = activeTemplateIndex.value
  const currentTemplate = templates[idx] ?? ''
  const msgCount = processMessages(currentTemplate, maxLength.value).length

  const toggleSend = () => {
    if (!sendMsg.value) {
      if (!currentTemplate.trim()) {
        appendLog('⚠️ 当前模板为空，请先输入内容')
        return
      }
      sendMsg.value = true
    } else {
      cancelLoop()
      sendMsg.value = false
    }
  }

  const updateTemplate = (text: string) => {
    const next = [...templates]
    next[idx] = text
    msgTemplates.value = next
  }

  const addTemplate = () => {
    msgTemplates.value = [...templates, '']
    activeTemplateIndex.value = msgTemplates.value.length - 1
  }

  const removeTemplate = () => {
    if (templates.length <= 1) return
    const next = [...templates]
    next.splice(idx, 1)
    msgTemplates.value = next
    activeTemplateIndex.value = Math.max(0, idx - 1)
  }

  // Picker shows even when the active draft is empty, so the user can recover by switching.
  const llmGap = describeLlmGap('autoSend')
  const llmReady = llmGap === null
  const showPromptPicker = isLlmApiConfigured() && llmPromptsAutoSend.value.length > 0

  return (
    <AccordionItem
      open={autoSendPanelOpen.value}
      onOpenChange={v => {
        autoSendPanelOpen.value = v
      }}
    >
      {/* Title markers: 🟢 = loop sending, ⚡️ = YOLO polish active (both can be on). */}
      <AccordionTrigger>
        独轮车{sendMsg.value ? ' 🟢' : ''}
        {autoSendYolo.value ? ' ⚡️' : ''}
      </AccordionTrigger>
      <AccordionContent>
        <div class='my-2 flex items-center gap-1'>
          <Button variant={sendMsg.value ? 'destructive' : 'default'} size='sm' onClick={toggleSend}>
            {sendMsg.value ? '停车' : '开车'}
          </Button>
          <Combobox
            value={String(idx)}
            options={templates.map((t, i) => ({
              value: String(i),
              label: `${i + 1}: ${getPreview(t)}`,
              searchText: t,
            }))}
            onChange={v => {
              activeTemplateIndex.value = parseInt(v, 10)
            }}
          />
          <Button variant='outline' size='sm' onClick={addTemplate}>
            新增
          </Button>
          <Button variant='outline' size='sm' onClick={removeTemplate}>
            删除当前
          </Button>
        </div>

        {/* Own line: LLM-side controls, orthogonal to the template controls above. */}
        <div class='my-2 flex items-center gap-1'>
          <Button
            // Variant flip mirrors 常规发送 / 自动融入 as the "is YOLO on?" affordance.
            variant={autoSendYolo.value ? 'default' : 'outline'}
            size='sm'
            disabled={!llmReady}
            onClick={() => {
              autoSendYolo.value = !autoSendYolo.value
            }}
          >
            YOLO
          </Button>
          {showPromptPicker && (
            // Hot-swaps the active prompt only; author/edit/reorder lives in Settings.
            <PromptPicker
              className='min-w-10 truncate'
              title='切换 YOLO 使用的独轮车提示词'
              prompts={llmPromptsAutoSend.value}
              activeIndex={llmActivePromptAutoSend.value}
              onActiveIndexChange={v => {
                llmActivePromptAutoSend.value = v
              }}
              previewGraphemes={16}
            />
          )}
        </div>

        <Textarea
          value={currentTemplate}
          onInput={e => updateTemplate(e.currentTarget.value)}
          placeholder='在这输入弹幕，每行一句话，超过可发送字数的会自动进行分割'
          className='h-20'
        />

        <div class='my-2 flex flex-wrap gap-2'>
          <div>
            <span>{msgCount} 条，</span>
            <span>间隔</span>
            <Input
              type='number'
              min='0'
              autocomplete='off'
              className='w-16'
              value={msgSendInterval.value}
              onInput={e => {
                const v = parseInt(e.currentTarget.value, 10)
                msgSendInterval.value = v >= 0 ? v : 0
              }}
            />
            <span>秒，</span>
            <span>超过</span>
            <Input
              type='number'
              min='1'
              autocomplete='off'
              className='w-16'
              value={maxLength.value}
              onInput={e => {
                const v = parseInt(e.currentTarget.value, 10)
                maxLength.value = v >= 1 ? v : 1
              }}
            />
            <span>字自动分段</span>
          </div>
          <Checkbox
            id='randomColor'
            checked={randomColor.value}
            onInput={e => {
              randomColor.value = e.currentTarget.checked
            }}
            label='随机颜色'
          />
          <Checkbox
            id='randomInterval'
            checked={randomInterval.value}
            onInput={e => {
              randomInterval.value = e.currentTarget.checked
            }}
            label='间隔增加随机性'
          />
          <Checkbox
            id='randomChar'
            checked={randomChar.value}
            onInput={e => {
              randomChar.value = e.currentTarget.checked
            }}
            label='随机字符'
          />
          <Checkbox
            id='persistSendState'
            disabled={cachedRoomId.value === null}
            checked={cachedRoomId.value !== null && !!persistSendState.value[String(cachedRoomId.value)]}
            onInput={e => {
              const roomId = cachedRoomId.value
              if (roomId === null) return
              persistSendState.value = { ...persistSendState.value, [String(roomId)]: e.currentTarget.checked }
            }}
            label='保持当前直播间独轮车开关状态'
          />
        </div>
      </AccordionContent>
    </AccordionItem>
  )
}
