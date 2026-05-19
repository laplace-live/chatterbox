import { appendLog } from '../lib/log'
import { cancelLoop } from '../lib/loop'
import { warnIfOtherSourcesActive } from '../lib/multi-source-warning'
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
import { YoloCallout } from './yolo-callout'

function getPreview(template: string): string {
  const firstLine = (template.split('\n')[0] ?? '').trim()
  if (!firstLine) return '(空)'
  return getGraphemes(firstLine).length > 10 ? `${trimText(firstLine, 10)[0]}…` : firstLine
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
      void warnIfOtherSourcesActive('loop')
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

  return (
    <details
      open={autoSendPanelOpen.value}
      onToggle={e => {
        autoSendPanelOpen.value = e.currentTarget.open
      }}
    >
      <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 'bold' }}>
        <span>独轮车</span>
        {sendMsg.value && <span className='cb-soft'>运行中</span>}
      </summary>
      <div className='cb-body cb-stack'>
        <div className='cb-row'>
          <button type='button' className={sendMsg.value ? 'cb-danger' : 'cb-primary'} onClick={toggleSend}>
            {sendMsg.value ? '停车' : '开车'}
          </button>
          <select
            style={{ width: '16ch' }}
            value={String(idx)}
            onChange={e => {
              activeTemplateIndex.value = Number.parseInt(e.currentTarget.value, 10)
            }}
          >
            {templates.map((t, i) => (
              <option key={i} value={String(i)}>
                {i + 1}: {getPreview(t)}
              </option>
            ))}
          </select>
          <button type='button' onClick={addTemplate}>
            新增
          </button>
          <button type='button' onClick={removeTemplate}>
            删除当前
          </button>
        </div>

        <textarea
          value={currentTemplate}
          onInput={e => updateTemplate(e.currentTarget.value)}
          placeholder='在这输入弹幕，每行一句话，超过可发送字数的会自动进行分割'
          style={{ boxSizing: 'border-box', height: '80px', width: '100%', resize: 'vertical' }}
        />

        <div className='cb-panel cb-stack'>
          <div className='cb-row'>
            <span>{msgCount} 条，</span>
            <span>间隔</span>
            <input
              type='number'
              min='0'
              autocomplete='off'
              title='允许范围：≥0 秒'
              aria-label='发送间隔（秒），允许范围 ≥0'
              style={{ width: '40px' }}
              value={msgSendInterval.value}
              onInput={e => {
                const v = Number.parseInt(e.currentTarget.value, 10)
                msgSendInterval.value = v >= 0 ? v : 0
              }}
            />
            <span className='cb-soft' aria-hidden='true' style={{ fontSize: '10px' }}>
              ≥0
            </span>
            <span>秒，</span>
            <span>超过</span>
            <input
              type='number'
              min='1'
              autocomplete='off'
              title='允许范围：≥1 字'
              aria-label='自动分段字数阈值，允许范围 ≥1'
              style={{ width: '30px' }}
              value={maxLength.value}
              onInput={e => {
                const v = Number.parseInt(e.currentTarget.value, 10)
                maxLength.value = v >= 1 ? v : 1
              }}
            />
            <span className='cb-soft' aria-hidden='true' style={{ fontSize: '10px' }}>
              ≥1
            </span>
            <span>字自动分段</span>
          </div>
          <span className='cb-row'>
            <input
              id='randomColor'
              type='checkbox'
              checked={randomColor.value}
              onInput={e => {
                randomColor.value = e.currentTarget.checked
              }}
            />
            <label htmlFor='randomColor'>随机颜色</label>
          </span>
          <span className='cb-row'>
            <input
              id='randomInterval'
              type='checkbox'
              checked={randomInterval.value}
              onInput={e => {
                randomInterval.value = e.currentTarget.checked
              }}
            />
            <label htmlFor='randomInterval'>间隔增加随机性</label>
          </span>
          <span className='cb-row'>
            <input
              id='randomChar'
              type='checkbox'
              checked={randomChar.value}
              onInput={e => {
                randomChar.value = e.currentTarget.checked
              }}
            />
            <label htmlFor='randomChar'>随机字符</label>
          </span>
          <span className='cb-row'>
            <input
              id='persistSendState'
              type='checkbox'
              disabled={cachedRoomId.value === null}
              checked={cachedRoomId.value !== null && Boolean(persistSendState.value[String(cachedRoomId.value)])}
              onInput={e => {
                const roomId = cachedRoomId.value
                if (roomId === null) return
                persistSendState.value = { ...persistSendState.value, [String(roomId)]: e.currentTarget.checked }
              }}
            />
            <label htmlFor='persistSendState'>保持当前直播间独轮车开关状态</label>
          </span>
          <span className='cb-row' style={{ flexWrap: 'wrap', gap: '.25em' }}>
            <input
              id='autoSendYolo'
              type='checkbox'
              checked={autoSendYolo.value}
              onInput={e => {
                autoSendYolo.value = e.currentTarget.checked
              }}
            />
            <label
              htmlFor='autoSendYolo'
              title='AI 润色（原 YOLO）：循环里每条非表情消息发出前先送 LLM 改写。配置不全会自动停车。LLM 凭证在「设置 → LLM」里集中配置。'
            >
              🤖 AI 润色（LLM 改写后再发）
            </label>
            <PromptPicker
              prompts={llmPromptsAutoSend.value}
              activeIndex={llmActivePromptAutoSend.value}
              onActiveIndexChange={i => {
                llmActivePromptAutoSend.value = i
              }}
              previewGraphemes={12}
              className='lc-min-w-[120px] lc-max-w-[180px] lc-truncate'
              title='当前提示词（在「设置 → LLM 提示词 → 独轮车」里管理）'
              emptyText='暂无提示词，请到设置里添加'
              disabled={!autoSendYolo.value}
            />
          </span>
          <YoloCallout
            feature='autoSend'
            enabled={autoSendYolo.value}
            readyText='已就绪：每条非表情消息会用 LLM 润色一次（产生 token 消耗）。'
          />
        </div>
      </div>
    </details>
  )
}
