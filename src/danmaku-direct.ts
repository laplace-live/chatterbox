import { ensureRoomId, getCsrfToken, sendDanmaku } from './api.js'
import { applyReplacements } from './replacement.js'
import { activeTab, appendLog, danmakuDirectMode, fasongText } from './store.js'

const MARKER = 'lc-dm-direct'
const STYLE_ID = 'lc-dm-direct-style'

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
`

function isValidDanmakuNode(node: HTMLElement): boolean {
  if (!node.classList.contains('chat-item') || !node.classList.contains('danmaku-item')) return false
  const count = node.classList.length
  if (count === 2) return true
  if (node.classList.contains('chat-colorful-bubble') && node.classList.contains('has-bubble') && count === 4)
    return true
  if (node.classList.contains('has-bubble') && count === 3) return true
  return false
}

function extractMessage(node: HTMLElement): string | null {
  const danmaku = node.dataset.danmaku
  const replyMid = node.dataset.replymid
  if (danmaku === undefined || replyMid === undefined) return null
  if (replyMid !== '0') {
    const replyUname = node.querySelector('[data-uname]')?.getAttribute('data-uname')
    if (replyUname) return `@${replyUname} ${danmaku}`
    return null
  }
  return danmaku
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
  const dialog = document.getElementById('laplace-chatterbox-dialog')
  if (dialog && dialog.style.display === 'none') {
    dialog.style.display = 'block'
  }
  appendLog(`🥷 偷: ${msg}`)
}

async function handleRepeat(msg: string): Promise<void> {
  try {
    const roomId = await ensureRoomId()
    const csrfToken = getCsrfToken()
    if (!csrfToken) {
      appendLog('❌ 未找到登录信息，请先登录 Bilibili')
      return
    }
    const processed = applyReplacements(msg)
    const result = await sendDanmaku(processed, roomId, csrfToken)
    const display = msg !== processed ? `${msg} → ${processed}` : processed
    if (result.success) {
      appendLog(`✅ +1: ${display}`)
    } else {
      appendLog(`❌ +1: ${display}，原因：${result.error}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    appendLog(`🔴 +1 出错：${message}`)
  }
}

function handleDelegatedClick(e: Event): void {
  const btn = (e.target as HTMLElement).closest(`.${MARKER} button`) as HTMLElement | null
  if (!btn) return
  e.stopPropagation()
  const container = btn.closest(`.${MARKER}`) as HTMLElement | null
  const msg = container?.dataset.msg
  if (!msg) return
  const action = btn.dataset.action
  if (action === 'steal') handleSteal(msg)
  else if (action === 'repeat') void handleRepeat(msg)
}

let observer: MutationObserver | null = null
let styleEl: HTMLStyleElement | null = null
let delegateTarget: HTMLElement | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

function processExistingNodes(container: HTMLElement): void {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>('.chat-item.danmaku-item'))
  for (const node of nodes) {
    if (!isValidDanmakuNode(node)) continue
    const msg = extractMessage(node)
    if (msg !== null) injectButtons(node, msg)
  }
}

function tryAttach(): boolean {
  const chatContainer = document.querySelector<HTMLElement>('.chat-items')
  if (!chatContainer) return false

  styleEl = document.createElement('style')
  styleEl.id = STYLE_ID
  styleEl.textContent = STYLE
  document.head.appendChild(styleEl)

  processExistingNodes(chatContainer)

  chatContainer.addEventListener('click', handleDelegatedClick, true)
  delegateTarget = chatContainer

  observer = new MutationObserver(mutations => {
    if (!danmakuDirectMode.value) return
    for (const mutation of mutations) {
      for (let i = 0; i < mutation.addedNodes.length; i++) {
        const node = mutation.addedNodes[i]
        if (!(node instanceof HTMLElement)) continue
        if (!isValidDanmakuNode(node)) continue
        const msg = extractMessage(node)
        if (msg !== null) injectButtons(node, msg)
      }
    }
  })

  observer.observe(chatContainer, { childList: true, subtree: false })
  return true
}

export function startDanmakuDirect(): void {
  if (observer) return
  if (tryAttach()) return

  // Bilibili's SPA may not have rendered .chat-items yet; poll until it appears
  pollTimer = setInterval(() => {
    if (tryAttach()) {
      if (pollTimer !== null) clearInterval(pollTimer)
      pollTimer = null
    }
  }, 1000)
}

export function stopDanmakuDirect(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (observer) {
    observer.disconnect()
    observer = null
  }
  if (delegateTarget) {
    delegateTarget.removeEventListener('click', handleDelegatedClick, true)
    delegateTarget = null
  }
  if (styleEl) {
    styleEl.remove()
    styleEl = null
  }
  for (const el of Array.from(document.querySelectorAll(`.${MARKER}`))) {
    el.remove()
  }
}
