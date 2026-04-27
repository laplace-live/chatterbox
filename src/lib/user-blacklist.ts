/**
 * Hijacks Bilibili's left-click `.danmaku-menu` (the popover that opens when
 * clicking a username, danmaku text, or emoticon in the chat panel) to add a
 * "融入黑名单" / "解除融入黑名单" toggle.
 *
 * IMPORTANT: B站 mounts a SINGLE `.danmaku-menu` element (under
 * `.chat-history-panel`) and reuses it across opens — each open just toggles
 * inline `style.display`, repositions via `style.left/top`, and rewrites the
 * username text. There's no element insertion to observe.
 *
 * Therefore the design is purely click-driven:
 *
 * 1. A capture-phase `click` listener on `document` fires before any of B站's
 *    own handlers. It walks up from the click target via `.open-menu` (the
 *    class B站 itself uses as the menu trigger) to the chat item, stashing
 *    `data-uid` / `data-uname` and refreshing our toggle inside the menu.
 * 2. The toggle is RE-INJECTED on every open so the click handler closure
 *    captures the CURRENT user's uid — not whoever was clicked the very
 *    first time.
 * 3. The toggle is built by deep-cloning an existing menu item so it inherits
 *    all of B站's styling automatically (padding, cursor, hover state, Vue
 *    scoped CSS). The clone is inert because Vue's `@click` handlers live on
 *    vnodes, not on the DOM element, so they don't survive `cloneNode`.
 */

import { appendLog } from './log'
import { autoBlendUserBlacklist } from './store'

const INJECTED_CLASS = 'lc-bl-toggle'

let pendingUid: string | null = null
let pendingUname: string | null = null
let clickHandler: ((e: MouseEvent) => void) | null = null

function captureFromClick(e: MouseEvent): void {
  const target = e.target
  if (!(target instanceof HTMLElement)) return
  // Only care about clicks B站 itself uses to open the menu.
  if (!target.closest('.open-menu')) return
  const item = target.closest<HTMLElement>('[data-uid]')
  if (!item) {
    pendingUid = null
    pendingUname = null
    return
  }
  pendingUid = item.dataset.uid ?? null
  pendingUname = item.dataset.uname ?? null
}

function buildToggleItem(template: HTMLElement, uid: string, uname: string | null): HTMLElement {
  const isBlacklisted = uid in autoBlendUserBlacklist.value

  // Deep-clone an existing item so we inherit ALL of B站's styling — padding,
  // cursor, hover state, scoped CSS — without having to chase the rules
  // (which live in a CORS-isolated stylesheet we can't enumerate). Vue's
  // @click handlers live on vnodes, not on DOM elements, so the cloned node
  // is inert until we wire our own listener.
  const div = template.cloneNode(true) as HTMLElement
  div.classList.add(INJECTED_CLASS)
  // The first item (`.go-space`) carries `target="_blank"`; we're not a link.
  div.removeAttribute('target')
  for (const a of Array.from(div.querySelectorAll('a'))) {
    a.removeAttribute('href')
  }
  const span = div.querySelector('span')
  if (span) span.textContent = isBlacklisted ? '🟣 解除融入黑名单' : '🟣 添加融入黑名单'

  div.addEventListener('click', e => {
    // Stop propagation so we don't re-trigger the click listener that opens
    // the menu and so this click isn't treated as outside the menu.
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

    // Mirror B站's own dismiss: hide via inline display:none. Don't remove
    // the menu element — it's persistent and reused on the next open.
    const menu = div.closest<HTMLElement>('.danmaku-menu')
    if (menu) menu.style.display = 'none'
  })

  return div
}

function ensureToggleInMenu(): void {
  if (!pendingUid) return
  const menu = document.querySelector<HTMLElement>('.danmaku-menu')
  if (!menu) return
  const list = menu.querySelector<HTMLElement>('.none-select')
  if (!list) return
  const template = list.firstElementChild
  if (!(template instanceof HTMLElement)) return

  // Always remove any existing toggle and re-inject with the CURRENT pendingUid
  // so the click handler closure references the user we just clicked, not a
  // previous one.
  list.querySelector(`.${INJECTED_CLASS}`)?.remove()
  list.appendChild(buildToggleItem(template, pendingUid, pendingUname))
}

export function startUserBlacklistHijack(): void {
  if (clickHandler) return

  clickHandler = e => {
    captureFromClick(e)
    if (!pendingUid) return
    // The menu element exists already (just hidden). Refresh our toggle in
    // place; rAF gives Vue a tick to flush the username/position update so
    // the menu we read is the one B站 just (re)showed.
    requestAnimationFrame(() => ensureToggleInMenu())
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
  for (const el of Array.from(document.querySelectorAll(`.${INJECTED_CLASS}`))) {
    el.remove()
  }
}
