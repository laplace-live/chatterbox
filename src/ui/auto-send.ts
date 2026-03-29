import { GM_getValue, GM_setValue } from '$'
import { activeTemplateIndex, MsgTemplates, sendMsg, setActiveTemplateIndex, setSendMsg } from '../state.js'
import { appendToLimitedLog, getGraphemes, processMessages, trimText } from '../utils.js'

export function setupAutoSend(toggleBtn: HTMLElement, _list: HTMLElement): void {
  const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement
  const msgLogs = document.getElementById('msgLogs') as HTMLTextAreaElement
  const maxLogLinesVal = GM_getValue<number>('maxLogLines', 1000)

  const msgInput = document.getElementById('msgList') as HTMLTextAreaElement
  const msgCount = document.getElementById('msgCount') as HTMLSpanElement
  const msgIntervalInput = document.getElementById('msgSendInterval') as HTMLInputElement
  const maxLengthInput = document.getElementById('maxLength') as HTMLInputElement
  const randomColorInput = document.getElementById('randomColor') as HTMLInputElement
  const randomIntervalInput = document.getElementById('randomInterval') as HTMLInputElement
  const randomCharInput = document.getElementById('randomChar') as HTMLInputElement
  const templateSelect = document.getElementById('templateSelect') as HTMLSelectElement
  const addTemplateBtn = document.getElementById('addTemplateBtn') as HTMLButtonElement
  const removeTemplateBtn = document.getElementById('removeTemplateBtn') as HTMLButtonElement

  function updateMessages(): void {
    const maxLength = parseInt(maxLengthInput.value, 10) || 20
    MsgTemplates[activeTemplateIndex] = msgInput.value
    GM_setValue('MsgTemplates', MsgTemplates)
    const Msg = processMessages(msgInput.value, maxLength)
    msgCount.textContent = `${Msg.length || 0} 条，`
  }

  function updateTemplateSelect(): void {
    templateSelect.innerHTML = ''
    MsgTemplates.forEach((template, index) => {
      const option = document.createElement('option')
      option.value = String(index)
      const firstLine = (template.split('\n')[0] ?? '').trim()
      const preview = firstLine
        ? getGraphemes(firstLine).length > 10
          ? `${trimText(firstLine, 10)[0]}…`
          : firstLine
        : '(空)'
      option.textContent = `${index + 1}: ${preview}`
      templateSelect.appendChild(option)
    })
    templateSelect.value = String(activeTemplateIndex)
    msgInput.value = MsgTemplates[activeTemplateIndex] ?? ''
    updateMessages()
  }

  sendBtn?.addEventListener('click', () => {
    if (!sendMsg) {
      const currentTemplate = MsgTemplates[activeTemplateIndex] ?? ''
      if (!currentTemplate.trim()) {
        appendToLimitedLog(msgLogs, '⚠️ 当前模板为空，请先输入内容', maxLogLinesVal)
        return
      }
      updateMessages()
      setSendMsg(true)
      sendBtn.textContent = '关闭独轮车'
      toggleBtn.style.background = 'rgb(0 186 143)'
    } else {
      setSendMsg(false)
      sendBtn.textContent = '开启独轮车'
      toggleBtn.style.background = 'rgb(166 166 166)'
    }
  })

  templateSelect?.addEventListener('change', () => {
    const idx = parseInt(templateSelect.value, 10)
    setActiveTemplateIndex(idx)
    msgInput.value = MsgTemplates[idx] ?? ''
    updateMessages()
    GM_setValue('activeTemplateIndex', idx)
  })

  addTemplateBtn?.addEventListener('click', () => {
    MsgTemplates.push('')
    const newIdx = MsgTemplates.length - 1
    setActiveTemplateIndex(newIdx)
    GM_setValue('MsgTemplates', MsgTemplates)
    GM_setValue('activeTemplateIndex', newIdx)
    updateTemplateSelect()
  })

  removeTemplateBtn?.addEventListener('click', () => {
    if (MsgTemplates.length > 1) {
      MsgTemplates.splice(activeTemplateIndex, 1)
      const newIdx = Math.max(0, activeTemplateIndex - 1)
      setActiveTemplateIndex(newIdx)
      GM_setValue('MsgTemplates', MsgTemplates)
      GM_setValue('activeTemplateIndex', newIdx)
      updateTemplateSelect()
    }
  })

  msgInput?.addEventListener('input', () => {
    updateMessages()
    updateTemplateSelect()
  })

  msgIntervalInput?.addEventListener('input', () => {
    const v = parseInt(msgIntervalInput.value, 10)
    if (!(v >= 0)) msgIntervalInput.value = '0'
    GM_setValue('msgSendInterval', msgIntervalInput.value)
  })

  randomColorInput?.addEventListener('input', () => {
    GM_setValue('randomColor', randomColorInput.checked)
  })
  randomIntervalInput?.addEventListener('input', () => {
    GM_setValue('randomInterval', randomIntervalInput.checked)
  })
  randomCharInput?.addEventListener('input', () => {
    GM_setValue('randomChar', randomCharInput.checked)
  })

  maxLengthInput?.addEventListener('input', () => {
    const value = parseInt(maxLengthInput.value, 10)
    if (value < 1) maxLengthInput.value = '1'
    GM_setValue('maxLength', maxLengthInput.value)
    updateMessages()
  })

  updateTemplateSelect()
}
