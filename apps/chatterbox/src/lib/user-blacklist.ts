/**
 * Adds 自动融入 blacklist toggles and 贡献烂梗 to B站's `.danmaku-menu` popover.
 * B站 reuses one persistent menu element, so items are re-injected on every open to bind the clicked row.
 */

import { isEmoteDanmaku } from './danmaku-stream'
import { appendLog } from './log'
import { autoBlendMessageBlacklist, autoBlendUserBlacklist, cachedStreamerUid } from './store'
import { buildMemeContributeUrl } from './utils'

const USER_INJECTED_CLASS = 'lc-blacklist-toggle'
const MESSAGE_INJECTED_CLASS = 'lc-blacklist-msg-toggle'
const MEME_INJECTED_CLASS = 'lc-meme-contribute'
const INJECTED_CLASSES = [USER_INJECTED_CLASS, MESSAGE_INJECTED_CLASS, MEME_INJECTED_CLASS]

let pendingUid: string | null = null
let pendingUname: string | null = null
let pendingText: string | null = null
let pendingMemeText: string | null = null
let clickHandler: ((e: MouseEvent) => void) | null = null

/** Records the clicked row; returns false for clicks that can't open the menu. */
function captureFromClick(e: MouseEvent): boolean {
  const target = e.target
  // `Element`, not `HTMLElement`: an SVG icon inside `.open-menu` can be the target.
  if (!(target instanceof Element)) return false
  if (!target.closest('.open-menu')) return false
  const item = target.closest<HTMLElement>('[data-uid]')
  if (!item) {
    pendingUid = null
    pendingUname = null
    pendingText = null
    pendingMemeText = null
    return true
  }
  pendingUid = item.dataset.uid ?? null
  pendingUname = item.dataset.uname ?? null
  // `data-danmaku` only on danmaku rows (not gift/welcome/system); trim to
  // match the key `auto-blend` uses.
  const raw = item.dataset.danmaku
  pendingText = raw !== undefined ? raw.trim() : null
  if (pendingText === '') pendingText = null
  pendingMemeText = isEmoteDanmaku(item) ? null : pendingText
  return true
}

/**
 * Clone `template` into an item labelled `label` that runs `onClick`, then hides the menu.
 */
function buildMenuItem(template: HTMLElement, className: string, label: string, onClick: () => void): HTMLElement {
  // Clone for B站's scoped styling; its Vue @click lives on vnodes, so the clone starts inert.
  // `importNode` not `cloneNode`: same deep clone, but typed as the input element.
  const div = document.importNode(template, true)
  div.classList.add(className)
  // First item (`.go-space`) carries `target="_blank"`; we're not a link.
  div.removeAttribute('target')
  for (const a of Array.from(div.querySelectorAll('a'))) {
    a.removeAttribute('href')
  }
  const span = div.querySelector('span')
  if (span) span.textContent = label

  div.addEventListener('click', e => {
    // Don't re-trigger the menu-open listener or count as an outside click.
    e.stopPropagation()
    onClick()

    // Hide, don't remove: the menu is persistent and reused on next open.
    const menu = div.closest<HTMLElement>('.danmaku-menu')
    if (menu) menu.style.display = 'none'
  })

  return div
}

/**
 * Build a menu item that toggles `uid` in `autoBlendUserBlacklist`.
 */
function buildUserToggleItem(template: HTMLElement, uid: string, uname: string | null): HTMLElement {
  const isBlacklisted = uid in autoBlendUserBlacklist.value
  const label = isBlacklisted ? '🟣 解除融入黑名单' : '🟣 添加融入黑名单'

  return buildMenuItem(template, USER_INJECTED_CLASS, label, () => {
    const next = { ...autoBlendUserBlacklist.value }
    const display = uname || uid
    if (uid in next) {
      delete next[uid]
      appendLog(`🚲 已解除融入黑名单：${display}`)
    } else {
      next[uid] = uname ?? ''
      appendLog(`🚲 已加入融入黑名单：${display}`)
    }
    autoBlendUserBlacklist.value = next
  })
}

/**
 * Build a menu item that toggles `text` in `autoBlendMessageBlacklist`.
 */
function buildMessageToggleItem(template: HTMLElement, text: string): HTMLElement {
  // `Object.hasOwn` not `in`: keys are arbitrary user text, and `in` would
  // match prototype props like "toString".
  const isBlacklisted = Object.hasOwn(autoBlendMessageBlacklist.value, text)
  const label = isBlacklisted ? '🟣 解除融入消息黑名单' : '🟣 添加融入消息黑名单'

  return buildMenuItem(template, MESSAGE_INJECTED_CLASS, label, () => {
    const next = { ...autoBlendMessageBlacklist.value }
    if (Object.hasOwn(next, text)) {
      delete next[text]
      appendLog(`🚲 已解除融入消息黑名单：${text}`)
    } else {
      next[text] = 1
      appendLog(`🚲 已加入融入消息黑名单：${text}`)
    }
    autoBlendMessageBlacklist.value = next
  })
}

/**
 * Build a menu item that opens laplace.live's meme contribution form prefilled with `text`.
 */
function buildMemeContributeItem(template: HTMLElement, text: string): HTMLElement {
  return buildMenuItem(template, MEME_INJECTED_CLASS, '贡献烂梗', () => {
    window.open(buildMemeContributeUrl(cachedStreamerUid.value, text), '_blank', 'noopener')
  })
}

function ensureItemsInMenu(): void {
  const menu = document.querySelector<HTMLElement>('.danmaku-menu')
  if (!menu) return
  const list = menu.querySelector<HTMLElement>('.none-select')
  if (!list) return

  // Re-inject with current pending values so click closures reference the
  // just-clicked row, not a previous selection.
  for (const cls of INJECTED_CLASSES) {
    list.querySelector(`.${cls}`)?.remove()
  }
  const template = list.firstElementChild
  if (!(template instanceof HTMLElement)) return

  if (pendingUid) {
    list.appendChild(buildUserToggleItem(template, pendingUid, pendingUname))
  }
  if (pendingText) {
    list.appendChild(buildMessageToggleItem(template, pendingText))
  }
  if (pendingMemeText) {
    list.appendChild(buildMemeContributeItem(template, pendingMemeText))
  }
}

export function startUserBlacklistHijack(): void {
  if (clickHandler) return

  clickHandler = e => {
    if (!captureFromClick(e)) return
    // rAF lets Vue flush the username/position update first, so we read the
    // menu B站 just (re)showed.
    requestAnimationFrame(() => {
      if (clickHandler) ensureItemsInMenu()
    })
  }
  document.addEventListener('click', clickHandler, true)
}

export function stopUserBlacklistHijack(): void {
  if (clickHandler) {
    document.removeEventListener('click', clickHandler, true)
    clickHandler = null
  }
  pendingUid = null
  pendingUname = null
  pendingText = null
  pendingMemeText = null
  for (const el of Array.from(document.querySelectorAll(INJECTED_CLASSES.map(cls => `.${cls}`).join(',')))) {
    el.remove()
  }
}
