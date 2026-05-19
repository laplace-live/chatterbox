/**
 * SC pin strip — the horizontal carousel that holds active Superchats above
 * the scrolling chat list.
 *
 * Why this exists: a SC bubble that just scrolls past in 5 seconds disrespects
 * the user who paid ¥100/¥500/¥1000 to be seen. B 站 native chat pins SCs at
 * the top; when chatterbox replaces native chat (`customChatHideNative`), we
 * lose that pinning unless we re-implement it. This module is that
 * re-implementation, with three deliberate departures from B 站 native:
 *
 *  1. **Horizontal time-multiplexing, not vertical stacking.** A single 64px
 *     row shows one SC at a time, auto-rotating every 4 s through every
 *     active card. Queue size doesn't cost layout space — a busy room with
 *     20 active SCs uses the same 64 px as a quiet room with 1.
 *
 *  2. **Reader-focused pin durations (15 s → 5 min CAP).** B 站 caps at 60 min
 *     because that serves *the streamer's revenue moment*. We cap at 5 min
 *     because beyond that, a pin punishes the chat reader's screen real
 *     estate. See `custom-chat-sc-pinstrip-tier.ts` for the per-tier table
 *     + rationale.
 *
 *  3. **Three equivalent input modalities** (touch swipe / mouse hover-and-
 *     button / keyboard arrows) so the strip works equally well on phones,
 *     desktop, and a11y users. None of these depend on the others.
 *
 * Architecture: this file holds the wire-up only — DOM construction +
 * subscription to chat events + timer loops + input handlers. All decision
 * logic lives in:
 *
 *  - `custom-chat-sc-pinstrip-tier.ts` (pure): amount → tier → duration.
 *  - `custom-chat-sc-pinstrip-state.ts` (pure): queue / index / pause state.
 *
 * That split keeps the testable logic out of DOM and the DOM out of test
 * coverage gaps.
 */

import type { CustomChatEvent } from './custom-chat-events'

import { copyTextToClipboard } from './clipboard'
import { subscribeCustomChatEvents } from './custom-chat-events'
import {
  currentSC,
  dismissCurrent,
  enqueue,
  initialState,
  isAutoRotateEligible,
  jumpTo,
  makeActiveSC,
  next as nextState,
  type PinStripState,
  pauseFor,
  prev as prevState,
  tick,
  toggleStickCurrent,
  USER_INTERACTION_PAUSE_MS,
} from './custom-chat-sc-pinstrip-state'
import { formatRemainingTime, tierAccessibilityLabel } from './custom-chat-sc-pinstrip-tier'

/** Minimum horizontal pointer travel before we treat it as a swipe (px).
 *  Tuned for touch — keep small enough that a deliberate flick on a phone
 *  works, big enough that a clumsy tap doesn't accidentally navigate. */
const SWIPE_HORIZONTAL_THRESHOLD_PX = 36
/** Minimum vertical travel for an upward dismiss swipe. */
const SWIPE_UP_THRESHOLD_PX = 48
/** How often the lifecycle loop runs: tick expired SCs, advance auto-rotate,
 *  refresh the progress bar. 250 ms is a sweet spot — frequent enough that
 *  the progress bar looks smooth, infrequent enough that idle CPU stays
 *  near zero. */
const LOOP_INTERVAL_MS = 250

export interface PinStripHandle {
  /** The root DOM element. Caller inserts this where it wants the strip
   *  (typically immediately after the toolbar). */
  element: HTMLElement
  /** Tear-down: clears timers, unsubscribes events, removes DOM. Safe to
   *  call multiple times. */
  dispose(): void
}

export function createScPinStrip(): PinStripHandle {
  let state: PinStripState = initialState()
  let hoverPaused = false
  let lastAdvanceAt = 0
  let renderScheduled = false
  let disposed = false

  // ─────────────── DOM ───────────────

  const root = document.createElement('div')
  root.className = 'lc-chat-sc-pinstrip lc-chat-sc-pinstrip-empty'
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', 'Superchat 醒目留言')
  root.tabIndex = 0

  const card = document.createElement('div')
  card.className = 'lc-chat-sc-card'

  const amountBadge = document.createElement('span')
  amountBadge.className = 'lc-chat-sc-amount'

  const avatarWrap = document.createElement('div')
  avatarWrap.className = 'lc-chat-sc-avatar lc-chat-avatar-fallback'
  const avatarImg = document.createElement('img')
  avatarImg.className = 'lc-chat-sc-avatar-img'
  avatarImg.referrerPolicy = 'no-referrer'
  avatarImg.decoding = 'async'
  avatarImg.alt = ''
  avatarWrap.appendChild(avatarImg)

  const body = document.createElement('div')
  body.className = 'lc-chat-sc-body'
  const uname = document.createElement('span')
  uname.className = 'lc-chat-sc-name'
  const text = document.createElement('span')
  text.className = 'lc-chat-sc-text'
  body.append(uname, text)

  const timeLeft = document.createElement('span')
  timeLeft.className = 'lc-chat-sc-time'

  card.append(amountBadge, avatarWrap, body, timeLeft)

  // Nav buttons — visible on hover for desktop discoverability. Touch users
  // get swipe; keyboard users get arrow keys. We don't try to hide these
  // dynamically based on input modality (hard to detect reliably); CSS shows
  // them on hover only so they don't visually compete with the SC content.
  const navPrev = document.createElement('button')
  navPrev.type = 'button'
  navPrev.className = 'lc-chat-sc-nav lc-chat-sc-nav-prev'
  navPrev.setAttribute('aria-label', '上一条 Superchat')
  navPrev.textContent = '‹'

  const navNext = document.createElement('button')
  navNext.type = 'button'
  navNext.className = 'lc-chat-sc-nav lc-chat-sc-nav-next'
  navNext.setAttribute('aria-label', '下一条 Superchat')
  navNext.textContent = '›'

  const dots = document.createElement('div')
  dots.className = 'lc-chat-sc-dots'
  dots.setAttribute('role', 'tablist')

  const progress = document.createElement('div')
  progress.className = 'lc-chat-sc-progress'

  root.append(navPrev, card, navNext, dots, progress)

  // ─────────────── State updates + render ───────────────

  function update(nextState: PinStripState): void {
    if (nextState === state) return
    state = nextState
    scheduleRender()
  }

  function scheduleRender(): void {
    if (renderScheduled || disposed) return
    renderScheduled = true
    // Qualify on `window` so the happy-dom test harness's patched
    // requestAnimationFrame is picked up — same pattern used elsewhere in
    // custom-chat-dom.ts. Bare `requestAnimationFrame()` would skip the
    // patch and crash under bun's test runner.
    window.requestAnimationFrame(() => {
      renderScheduled = false
      if (disposed) return
      render()
    })
  }

  function render(): void {
    const sc = currentSC(state)
    if (!sc) {
      root.classList.add('lc-chat-sc-pinstrip-empty')
      return
    }
    root.classList.remove('lc-chat-sc-pinstrip-empty')

    amountBadge.textContent = `¥${sc.amountYuan}`
    amountBadge.dataset.tier = sc.tier.id

    if (sc.avatarUrl && avatarImg.src !== sc.avatarUrl) {
      avatarImg.src = sc.avatarUrl
      avatarWrap.classList.remove('lc-chat-avatar-fallback')
    } else if (!sc.avatarUrl) {
      avatarImg.removeAttribute('src')
      avatarWrap.classList.add('lc-chat-avatar-fallback')
    }

    uname.textContent = sc.uname
    text.textContent = sc.text

    // Render the dot indicator. We rebuild from scratch since the count
    // changes infrequently and the cost is tiny (≤ 20 dots typical, hard
    // overflow becomes a +N counter).
    renderDots(sc.id)

    // Sticky indicator on the card.
    card.classList.toggle('lc-chat-sc-card-stuck', sc.stuck)

    // ARIA live region for screen readers — announce new SCs.
    root.setAttribute('aria-label', tierAccessibilityLabel(sc.tier, sc.amountYuan))
  }

  function renderDots(activeId: string): void {
    // Cap visible dots at 5; show "+N" if more.
    const MAX_DOTS = 5
    dots.innerHTML = ''
    const total = state.active.length
    const visible = state.active.slice(-MAX_DOTS)
    for (const sc of visible) {
      const dot = document.createElement('button')
      dot.type = 'button'
      dot.className = 'lc-chat-sc-dot'
      if (sc.id === activeId) dot.classList.add('lc-chat-sc-dot-active')
      dot.setAttribute('role', 'tab')
      dot.setAttribute('aria-label', `¥${sc.amountYuan} ${sc.uname}`)
      dot.addEventListener('click', () => {
        const idx = state.active.findIndex(x => x.id === sc.id)
        if (idx >= 0) update(jumpTo(state, idx, Date.now()))
      })
      dots.appendChild(dot)
    }
    if (total > MAX_DOTS) {
      const overflow = document.createElement('span')
      overflow.className = 'lc-chat-sc-dot-overflow'
      overflow.textContent = `+${total - MAX_DOTS}`
      dots.appendChild(overflow)
    }
  }

  /** Update the progress bar's scale-X based on current SC's remaining
   *  lifetime. Cheap — runs every LOOP_INTERVAL_MS without re-rendering
   *  any other DOM. */
  function updateProgressBar(now: number): void {
    const sc = currentSC(state)
    if (!sc) {
      progress.style.transform = 'scaleX(0)'
      timeLeft.textContent = ''
      return
    }
    const total = sc.expiresAt - sc.pinnedAt
    const left = Math.max(0, sc.expiresAt - now)
    const ratio = total > 0 ? left / total : 0
    progress.style.transform = `scaleX(${ratio.toFixed(3)})`
    if (sc.stuck) {
      timeLeft.textContent = '已钉住'
    } else {
      timeLeft.textContent = formatRemainingTime(left)
    }
  }

  // ─────────────── Lifecycle loop ───────────────

  function loop(): void {
    if (disposed) return
    const now = Date.now()
    // 1. Reap expired SCs.
    const afterTick = tick(state, now)
    if (afterTick !== state) update(afterTick)
    // 2. Maybe auto-rotate.
    if (!hoverPaused && isAutoRotateEligible(state, now, lastAdvanceAt)) {
      update(nextState(state, now, false))
      lastAdvanceAt = now
    }
    // 3. Refresh progress bar (cheap, no state change).
    updateProgressBar(now)
  }

  const intervalId = window.setInterval(loop, LOOP_INTERVAL_MS)

  // ─────────────── Input modalities ───────────────

  // Desktop hover → pause auto-rotate while mouse is over the strip.
  root.addEventListener('mouseenter', () => {
    hoverPaused = true
  })
  root.addEventListener('mouseleave', () => {
    hoverPaused = false
  })

  // Nav buttons — desktop discoverability for prev/next.
  navPrev.addEventListener('click', e => {
    e.stopPropagation()
    update(prevState(state, Date.now(), true))
  })
  navNext.addEventListener('click', e => {
    e.stopPropagation()
    update(nextState(state, Date.now(), true))
  })

  // Touch swipe — horizontal navigates, upward dismisses.
  let touchStartX = 0
  let touchStartY = 0
  let touchStartT = 0
  root.addEventListener(
    'touchstart',
    e => {
      const t = e.touches[0]
      touchStartX = t.clientX
      touchStartY = t.clientY
      touchStartT = Date.now()
    },
    { passive: true }
  )
  root.addEventListener('touchend', e => {
    const t = e.changedTouches[0]
    const dx = t.clientX - touchStartX
    const dy = t.clientY - touchStartY
    const dt = Date.now() - touchStartT
    // Ignore long-press; only treat fast flicks as swipes.
    if (dt > 600) return
    // Upward swipe dismisses current SC.
    if (dy < -SWIPE_UP_THRESHOLD_PX && Math.abs(dy) > Math.abs(dx)) {
      update(dismissCurrent(state, Date.now()))
      return
    }
    // Horizontal swipe navigates.
    if (Math.abs(dx) < SWIPE_HORIZONTAL_THRESHOLD_PX) return
    if (dx > 0) update(prevState(state, Date.now(), true))
    else update(nextState(state, Date.now(), true))
  })

  // Keyboard — only when strip is focused.
  root.addEventListener('keydown', e => {
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault()
        update(prevState(state, Date.now(), true))
        break
      case 'ArrowRight':
        e.preventDefault()
        update(nextState(state, Date.now(), true))
        break
      case 'Escape':
        e.preventDefault()
        update(dismissCurrent(state, Date.now()))
        break
      case ' ':
      case 'Spacebar':
        // Toggle stick on the current card.
        e.preventDefault()
        update(toggleStickCurrent(state))
        break
    }
  })

  // Double-click / double-tap → copy SC text.
  root.addEventListener('dblclick', () => {
    const sc = currentSC(state)
    if (!sc) return
    void copyTextToClipboard(sc.text)
    // Brief visual feedback — toggle a class that CSS animates.
    root.classList.add('lc-chat-sc-pinstrip-copied')
    window.setTimeout(() => root.classList.remove('lc-chat-sc-pinstrip-copied'), 600)
  })

  // ─────────────── Event subscription ───────────────

  const unsubscribe = subscribeCustomChatEvents((event: CustomChatEvent) => {
    if (event.kind !== 'superchat') return
    const now = Date.now()
    const sc = makeActiveSC(event, now)
    if (!sc) return
    update(enqueue(state, sc, now))
    // Reset auto-rotate clock so the newest SC gets a full AUTO_ROTATE_INTERVAL_MS
    // of attention before the carousel moves on.
    lastAdvanceAt = now
  })

  // ─────────────── Initial state ───────────────

  scheduleRender()

  // ─────────────── Dispose ───────────────

  function dispose(): void {
    if (disposed) return
    disposed = true
    window.clearInterval(intervalId)
    unsubscribe()
    root.remove()
    // hoverPaused / state / lastAdvanceAt all become garbage once `root` is
    // detached and there are no remaining handlers. The closure captures
    // them, but the closure itself is unreachable once `dispose` returns
    // and `root` is no longer in any tree.
  }

  // Expose USER_INTERACTION_PAUSE_MS for any caller that wants to coordinate.
  // (Currently unused outside this module but cheap to expose; keeps the
  // file from importing it twice.)
  void USER_INTERACTION_PAUSE_MS
  void pauseFor

  return { element: root, dispose }
}
