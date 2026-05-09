/**
 * Shared danmaku stream — a single MutationObserver on `.chat-items` that
 * fans out events to all subscribers. Both `danmaku-direct` (for inline
 * +1/steal buttons) and `auto-blend` (for trending detection) subscribe
 * here so we don't run multiple observers on the same DOM node.
 *
 * Lifecycle is reference-counted: the first subscribe attaches the observer
 * (waiting for `.chat-items` to appear if needed), and the last unsubscribe
 * tears everything down.
 */

export interface DanmakuEvent {
  /** The `.chat-item.danmaku-item` element. */
  node: HTMLElement
  /** Raw `data-danmaku` text (no @-reply prefix synthesis). */
  text: string
  /** Sender username, if extractable from the DOM. */
  uname: string | null
  /** Sender uid, if extractable from the DOM. */
  uid: string | null
  /** Whether `data-replymid` is non-zero (i.e. a reply danmaku). */
  isReply: boolean
  /**
   * True when B站 renders this danmaku as an inline "大表情" / fan-club
   * cheering emote — DOM marker is `.danmaku-item-right.emoticon.bulge`
   * containing an `<img>`. Distinct from regular cached emotes
   * (`.emoticon` without `.bulge`), which carry an `emoticon_unique`
   * matching `data-danmaku` and survive a faithful re-send.
   *
   * For 大表情 messages, `data-danmaku` is the emote's *display name*
   * (e.g. "应援", "干杯") — NOT an `emoticon_unique` — so naïvely
   * re-sending the text would land as plain text instead of the emote.
   * Consumers (auto-blend) use this together with `isEmoticonUnique` to
   * decide whether the message is faithfully reproducible from text alone.
   */
  hasLargeEmote: boolean
}

export interface DanmakuSubscription {
  /**
   * Called once with the `.chat-items` container as soon as it's available.
   * If the container is already attached at subscribe time, called immediately.
   */
  onAttach?: (container: HTMLElement) => void
  /** Called for each new danmaku node added to the chat. */
  onMessage?: (event: DanmakuEvent) => void
  /**
   * If true, also call `onMessage` for every currently-rendered danmaku at
   * attach time. Useful for late subscribers that want to back-fill state
   * (e.g. inject buttons into already-displayed messages).
   */
  emitExisting?: boolean
}

const subscriptions = new Set<DanmakuSubscription>()
let observer: MutationObserver | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let attached: HTMLElement | null = null

export function isValidDanmakuNode(node: HTMLElement): boolean {
  if (!node.classList.contains('chat-item') || !node.classList.contains('danmaku-item')) return false
  const count = node.classList.length
  if (count === 2) return true
  if (node.classList.contains('chat-colorful-bubble') && node.classList.contains('has-bubble') && count === 4)
    return true
  if (node.classList.contains('has-bubble') && count === 3) return true
  return false
}

export function extractDanmakuInfo(node: HTMLElement): DanmakuEvent | null {
  const text = node.dataset.danmaku
  const replymid = node.dataset.replymid
  if (text === undefined || replymid === undefined) return null
  // B站 puts user data on the chat-item root itself (alongside `data-danmaku`
  // / `data-replymid`), NOT on a descendant — `querySelector` would always
  // miss them. Read from the node first, fall back to a descendant lookup so
  // we still work on hypothetical future layouts where the attributes move.
  const uname = node.dataset.uname ?? node.querySelector<HTMLElement>('[data-uname]')?.dataset.uname ?? null
  const uid = node.dataset.uid ?? node.querySelector<HTMLElement>('[data-uid]')?.dataset.uid ?? null
  // Specifically target `.bulge` (大表情 / cheering emotes) — NOT every
  // emote rendering. Regular cached emotes (`.emoticon` without `.bulge`)
  // also have an inline `<img>` but their `data-danmaku` is a real
  // `emoticon_unique` so they re-send faithfully and shouldn't be
  // flagged. Conflating the two would over-eagerly drop legitimate
  // emote trends during the brief window before `cachedEmoticonPackages`
  // loads (when `isEmoticonUnique` returns false for everything).
  const hasLargeEmote = node.querySelector('.danmaku-item-right.emoticon.bulge img') !== null
  return {
    node,
    text,
    uname,
    uid,
    isReply: replymid !== '0',
    hasLargeEmote,
  }
}

function notifyAttach(container: HTMLElement, sub: DanmakuSubscription): void {
  if (sub.onAttach) {
    try {
      sub.onAttach(container)
    } catch (err) {
      console.error('[danmaku-stream] onAttach error:', err)
    }
  }
  if (sub.emitExisting && sub.onMessage) {
    const onMessage = sub.onMessage
    for (const node of container.querySelectorAll<HTMLElement>('.chat-item.danmaku-item')) {
      if (!isValidDanmakuNode(node)) continue
      const ev = extractDanmakuInfo(node)
      if (!ev) continue
      try {
        onMessage(ev)
      } catch (err) {
        console.error('[danmaku-stream] emitExisting error:', err)
      }
    }
  }
}

function tryAttach(): boolean {
  const container = document.querySelector<HTMLElement>('.chat-items')
  if (!container) return false
  attached = container

  for (const sub of subscriptions) notifyAttach(container, sub)

  observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (let i = 0; i < m.addedNodes.length; i++) {
        const node = m.addedNodes[i]
        if (!(node instanceof HTMLElement)) continue
        if (!isValidDanmakuNode(node)) continue
        const ev = extractDanmakuInfo(node)
        if (!ev) continue
        for (const sub of subscriptions) {
          if (!sub.onMessage) continue
          try {
            sub.onMessage(ev)
          } catch (err) {
            console.error('[danmaku-stream] onMessage error:', err)
          }
        }
      }
    }
  })
  observer.observe(container, { childList: true, subtree: false })
  return true
}

function ensureAttached(): void {
  if (attached || pollTimer) return
  if (tryAttach()) return
  pollTimer = setInterval(() => {
    if (tryAttach() && pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }, 1000)
}

function maybeDetach(): void {
  if (subscriptions.size > 0) return
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (observer) {
    observer.disconnect()
    observer = null
  }
  attached = null
}

export function subscribeDanmaku(sub: DanmakuSubscription): () => void {
  subscriptions.add(sub)
  if (attached) {
    notifyAttach(attached, sub)
  } else {
    ensureAttached()
  }
  return () => {
    subscriptions.delete(sub)
    maybeDetach()
  }
}

export function getDanmakuContainer(): HTMLElement | null {
  return attached
}
