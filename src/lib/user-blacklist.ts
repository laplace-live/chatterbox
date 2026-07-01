/**
 * Adds 自动融入 blacklist toggles to B站's `.danmaku-menu` popover.
 * B站 reuses a SINGLE persistent menu element (toggled via inline display),
 * so this is purely click-driven: toggles are re-injected on every open so
 * their click closures capture the current user/text.
 */

import { appendLog } from './log'
import { autoBlendMessageBlacklist, autoBlendUserBlacklist } from './store'

const USER_INJECTED_CLASS = 'lc-blacklist-toggle'
const MESSAGE_INJECTED_CLASS = 'lc-blacklist-msg-toggle'

let pendingUid: string | null = null
let pendingUname: string | null = null
let pendingText: string | null = null
let clickHandler: ((e: MouseEvent) => void) | null = null

function captureFromClick(e: MouseEvent): void {
  const target = e.target
  if (!(target instanceof HTMLElement)) return
  if (!target.closest('.open-menu')) return
  const item = target.closest<HTMLElement>('[data-uid]')
  if (!item) {
    pendingUid = null
    pendingUname = null
    pendingText = null
    return
  }
  pendingUid = item.dataset.uid ?? null
  pendingUname = item.dataset.uname ?? null
  // `data-danmaku` only on danmaku rows (not gift/welcome/system); trim to
  // match the key `auto-blend` uses.
  const raw = item.dataset.danmaku
  pendingText = raw !== undefined ? raw.trim() : null
  if (pendingText === '') pendingText = null
}

/**
 * Build a menu item that toggles `uid` in `autoBlendUserBlacklist`.
 */
function buildUserToggleItem(template: HTMLElement, uid: string, uname: string | null): HTMLElement {
  const isBlacklisted = uid in autoBlendUserBlacklist.value

  // Deep-clone to inherit B站's scoped styling; Vue @click lives on vnodes,
  // so the clone is inert until we wire our own listener.
  const div = template.cloneNode(true) as HTMLElement
  div.classList.add(USER_INJECTED_CLASS)
  // First item (`.go-space`) carries `target="_blank"`; we're not a link.
  div.removeAttribute('target')
  for (const a of Array.from(div.querySelectorAll('a'))) {
    a.removeAttribute('href')
  }
  const span = div.querySelector('span')
  if (span) span.textContent = isBlacklisted ? '🟣 解除融入黑名单' : '🟣 添加融入黑名单'

  div.addEventListener('click', e => {
    // Don't re-trigger the menu-open listener or count as an outside click.
    e.stopPropagation()

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

    // Hide, don't remove: the menu is persistent and reused on next open.
    const menu = div.closest<HTMLElement>('.danmaku-menu')
    if (menu) menu.style.display = 'none'
  })

  return div
}

/**
 * Build a menu item that toggles `text` in `autoBlendMessageBlacklist`.
 * Same cloning trick as `buildUserToggleItem`; only the action and class differ.
 */
function buildMessageToggleItem(template: HTMLElement, text: string): HTMLElement {
  // `Object.hasOwn` not `in`: keys are arbitrary user text, and `in` would
  // match prototype props like "toString".
  const isBlacklisted = Object.hasOwn(autoBlendMessageBlacklist.value, text)

  const div = template.cloneNode(true) as HTMLElement
  div.classList.add(MESSAGE_INJECTED_CLASS)
  div.removeAttribute('target')
  for (const a of Array.from(div.querySelectorAll('a'))) {
    a.removeAttribute('href')
  }
  const span = div.querySelector('span')
  if (span) span.textContent = isBlacklisted ? '🟣 解除融入消息黑名单' : '🟣 添加融入消息黑名单'

  div.addEventListener('click', e => {
    e.stopPropagation()

    const next = { ...autoBlendMessageBlacklist.value }
    if (Object.hasOwn(next, text)) {
      delete next[text]
      appendLog(`🚲 已解除融入消息黑名单：${text}`)
    } else {
      next[text] = 1
      appendLog(`🚲 已加入融入消息黑名单：${text}`)
    }
    autoBlendMessageBlacklist.value = next

    const menu = div.closest<HTMLElement>('.danmaku-menu')
    if (menu) menu.style.display = 'none'
  })

  return div
}

function ensureTogglesInMenu(): void {
  if (!pendingUid && !pendingText) return
  const menu = document.querySelector<HTMLElement>('.danmaku-menu')
  if (!menu) return
  const list = menu.querySelector<HTMLElement>('.none-select')
  if (!list) return
  const template = list.firstElementChild
  if (!(template instanceof HTMLElement)) return

  // Re-inject with current pending values so click closures reference the
  // just-clicked row, not a previous selection.
  list.querySelector(`.${USER_INJECTED_CLASS}`)?.remove()
  list.querySelector(`.${MESSAGE_INJECTED_CLASS}`)?.remove()

  if (pendingUid) {
    list.appendChild(buildUserToggleItem(template, pendingUid, pendingUname))
  }
  if (pendingText) {
    list.appendChild(buildMessageToggleItem(template, pendingText))
  }
}

export function startUserBlacklistHijack(): void {
  if (clickHandler) return

  clickHandler = e => {
    captureFromClick(e)
    if (!pendingUid && !pendingText) return
    // rAF lets Vue flush the username/position update first, so we read the
    // menu B站 just (re)showed.
    requestAnimationFrame(() => ensureTogglesInMenu())
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
  for (const el of Array.from(document.querySelectorAll(`.${USER_INJECTED_CLASS}`))) {
    el.remove()
  }
  for (const el of Array.from(document.querySelectorAll(`.${MESSAGE_INJECTED_CLASS}`))) {
    el.remove()
  }
}
