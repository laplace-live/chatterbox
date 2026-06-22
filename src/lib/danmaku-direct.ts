import { effect as signalEffect } from '@preact/signals'

import { showConfirm } from '../components/ui/alert-dialog'
import { ensureRoomId, getCsrfToken } from './api'
import { type DanmakuEvent, subscribeDanmaku } from './danmaku-stream'
import { isEmoticonUnique } from './emoticon'
import { isLlmReady, polishWithLlm } from './llm-tasks'
import { appendLog } from './log'
import { applyReplacements } from './replacement'
import { enqueueDanmaku, SendPriority } from './send-queue'
import {
  activeTab,
  danmakuDirectAlwaysShow,
  danmakuDirectConfirm,
  danmakuDirectMode,
  dialogOpen,
  fasongText,
  normalSendYolo,
} from './store'

const MARKER = 'laplace-dm-direct'
const STYLE_ID = 'laplace-dm-direct-style'

const STYLE = `
.${MARKER} {
  display: inline-flex;
  vertical-align: middle;
  margin-left: 2px;
  gap: 2px;
  opacity: 0;
  transition: opacity .15s;
  user-select: none;
}
.chat-item.danmaku-item:hover .${MARKER} {
  opacity: 1;
}
.${MARKER} button {
  all: unset;
  cursor: pointer;
  padding: 2px;
  border: 1px solid currentColor;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  line-height: 1;
  color: inherit;
  opacity: .35;
  transition: opacity .1s;
}
.${MARKER} button:hover {
  opacity: 1;
}
html.laplace-dm-direct-always .${MARKER} {
  opacity: 1;
}
`

/**
 * Builds the actual danmaku string we'd send for a given event.
 * Reply danmakus need an `@uname ` prefix to be meaningful when re-sent.
 * Returns null when the message can't be reliably reconstructed.
 */
function eventToSendableMessage(ev: DanmakuEvent): string | null {
  if (!ev.isReply) return ev.text
  return ev.uname ? `@${ev.uname} ${ev.text}` : null
}

function injectButtons(node: HTMLElement, msg: string): void {
  if (node.querySelector(`.${MARKER}`)) return
  const anchor = node.querySelector('.danmaku-item-right')
  if (!anchor) return

  const container = document.createElement('span')
  container.className = MARKER
  container.dataset.msg = msg

  const stealBtn = document.createElement('button')
  stealBtn.type = 'button'
  stealBtn.textContent = '偷'
  stealBtn.title = '偷弹幕到发送框'
  stealBtn.dataset.action = 'steal'

  const repeatBtn = document.createElement('button')
  repeatBtn.type = 'button'
  repeatBtn.textContent = '+1'
  repeatBtn.title = '+1 发送弹幕'
  repeatBtn.dataset.action = 'repeat'

  container.appendChild(stealBtn)
  container.appendChild(repeatBtn)
  anchor.after(container)
}

function handleSteal(msg: string): void {
  fasongText.value = msg
  activeTab.value = 'fasong'
  dialogOpen.value = true
  appendLog(`🥷 偷: ${msg}`)
}

async function handleRepeat(msg: string, anchor?: { x: number; y: number }): Promise<void> {
  // YOLO polish for +1 piggybacks on the 常规发送 toggle (`normalSendYolo`)
  // rather than getting its own switch — both paths are conceptually
  // "user-initiated single send", just one is typed and the other is
  // a quick repeat. Sharing the toggle (and the `normalSend` prompt)
  // means the user's "polish style for what I send manually" applies
  // uniformly to both surfaces, which is what the user asked for.
  //
  // Polish runs BEFORE the confirm dialog so the dialog body shows
  // what will ACTUALLY be sent (post-polish, pre-replacement). If we
  // confirmed the raw text and then quietly swapped it out at send
  // time, the confirmation would be lying.
  //
  // Emote +1 skips polish entirely: the chat-item's `dataset.msg` for
  // an emote is its `emoticon_unique` (e.g. `room_1713546334_108382`),
  // an opaque ID. Feeding that to the LLM yields mangled text that
  // `sendDanmaku` would no longer recognise as an emote — B站 echoes
  // it back as plain chat text. Same `!isEmote` guard the auto-blend
  // and loop YOLO paths apply to keep all three surfaces consistent.
  const isEmote = isEmoticonUnique(msg)
  let toSend = msg
  if (normalSendYolo.value && !isEmote) {
    if (!isLlmReady('normalSend')) {
      // Refuse rather than fall back to raw send — same contract as
      // the 常规发送 / 自动融入 YOLO modes. The user opted in; a
      // silent skip-the-polish would surprise them.
      appendLog('❌ +1 YOLO 模式已开启，但 LLM 配置不完整，本次跳过')
      return
    }
    try {
      const polished = await polishWithLlm('normalSend', msg)
      if (!polished.trim()) {
        appendLog('⚠️ +1 AI 返回为空，本次跳过')
        return
      }
      appendLog(`✨ +1 AI 润色：${msg} → ${polished}`)
      toSend = polished
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 +1 AI 润色失败：${errMsg}`)
      return
    }
  }

  if (danmakuDirectConfirm.value) {
    const confirmed = await showConfirm({ title: '确认发送以下弹幕？', body: toSend, confirmText: '发送', anchor })
    if (!confirmed) return
  }

  try {
    const roomId = await ensureRoomId()
    const csrfToken = getCsrfToken()
    if (!csrfToken) {
      appendLog('❌ 未找到登录信息，请先登录 Bilibili')
      return
    }
    const processed = applyReplacements(toSend)
    const result = await enqueueDanmaku(processed, roomId, csrfToken, SendPriority.MANUAL)
    // Display arrow lights up whenever the final text differs from the
    // original danmaku — captures both the YOLO polish (toSend !== msg)
    // and the sensitive-word replacement (processed !== toSend) in a
    // single compact `original → final` line.
    const display = msg !== processed ? `${msg} → ${processed}` : processed
    appendLog(result, '+1', display)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    appendLog(`🔴 +1 出错：${message}`)
  }
}

function handleDelegatedClick(e: MouseEvent): void {
  const target = e.target
  if (!(target instanceof HTMLElement)) return
  const btn = target.closest<HTMLElement>(`.${MARKER} button`)
  if (!btn) return
  e.stopPropagation()
  const container = btn.closest<HTMLElement>(`.${MARKER}`)
  const msg = container?.dataset.msg
  if (!msg) return
  const action = btn.dataset.action
  if (action === 'steal') handleSteal(msg)
  else if (action === 'repeat') {
    void handleRepeat(msg, { x: e.clientX, y: e.clientY })
  }
}

let unsubscribe: (() => void) | null = null
let styleEl: HTMLStyleElement | null = null
let attachedContainer: HTMLElement | null = null
let alwaysShowDispose: (() => void) | null = null
let contextMenuHandler: (() => void) | null = null

function closeNativeContextMenu(): void {
  for (const li of document.querySelectorAll('li')) {
    if (li.textContent?.trim() === '关闭') {
      li.click()
      return
    }
  }
}

function createContextMenuItem(source: HTMLLIElement, label: string): HTMLLIElement {
  const item = document.createElement('li')
  item.className = source.className
  item.dataset.lc = ''
  item.textContent = label
  return item
}

function tryInjectContextMenuItems(li: HTMLLIElement): void {
  if (li.textContent?.trim() !== '复制弹幕') return

  const ul = li.parentElement
  if (!ul || ul.querySelector('[data-lc]')) return

  const repeatEl = createContextMenuItem(li, '弹幕 +1')

  repeatEl.onclick = (e: MouseEvent) => {
    const text = ul.parentElement?.querySelector('span')?.textContent?.trim() ?? null
    if (text) {
      void handleRepeat(text, { x: e.clientX, y: e.clientY })
    }
    closeNativeContextMenu()
  }

  const stealEl = createContextMenuItem(li, '偷弹幕')

  stealEl.onclick = () => {
    const text = ul.parentElement?.querySelector('span')?.textContent?.trim() ?? null
    if (text) {
      handleSteal(text)
    }
    closeNativeContextMenu()
  }

  ul.insertBefore(stealEl, ul.firstChild)
  ul.insertBefore(repeatEl, ul.firstChild)
}

function initContextMenuHijack(): void {
  if (contextMenuHandler) return

  contextMenuHandler = () => {
    requestAnimationFrame(() => {
      for (const li of document.querySelectorAll<HTMLLIElement>('li')) {
        tryInjectContextMenuItems(li)
      }
    })
  }

  document.addEventListener('contextmenu', contextMenuHandler)
}

function stopContextMenuHijack(): void {
  if (contextMenuHandler) {
    document.removeEventListener('contextmenu', contextMenuHandler)
    contextMenuHandler = null
  }
}

export function startDanmakuDirect(): void {
  if (unsubscribe) return

  alwaysShowDispose = signalEffect(() => {
    document.documentElement.classList.toggle('laplace-dm-direct-always', danmakuDirectAlwaysShow.value)
  })

  initContextMenuHijack()

  unsubscribe = subscribeDanmaku({
    onAttach: container => {
      styleEl = document.createElement('style')
      styleEl.id = STYLE_ID
      styleEl.textContent = STYLE
      document.head.appendChild(styleEl)

      attachedContainer = container
      container.addEventListener('click', handleDelegatedClick, true)
    },
    onMessage: ev => {
      if (!danmakuDirectMode.value) return
      const msg = eventToSendableMessage(ev)
      if (msg !== null) injectButtons(ev.node, msg)
    },
    emitExisting: true,
  })
}

export function stopDanmakuDirect(): void {
  stopContextMenuHijack()
  if (alwaysShowDispose) {
    alwaysShowDispose()
    alwaysShowDispose = null
    document.documentElement.classList.remove('laplace-dm-direct-always')
  }
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  if (attachedContainer) {
    attachedContainer.removeEventListener('click', handleDelegatedClick, true)
    attachedContainer = null
  }
  if (styleEl) {
    styleEl.remove()
    styleEl = null
  }
  for (const el of Array.from(document.querySelectorAll(`.${MARKER}`))) {
    el.remove()
  }
}
