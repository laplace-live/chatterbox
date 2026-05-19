import { effect as signalEffect } from '@preact/signals'

import { ensureRoomId, fetchEmoticons } from './api'
import { getCustomChatFoldCanonical } from './chatfilter-runtime'
import { setChatText as setText } from './custom-chat-emoticons'
import {
  type CustomChatEvent,
  type CustomChatField,
  type CustomChatKind,
  type CustomChatWsStatus,
  chatEventTime,
  emitCustomChatEvent,
  prewarmAvatar,
  subscribeCustomChatEvents,
  subscribeCustomChatWsStatus,
} from './custom-chat-events'
import { normalizeWheelDelta, prepareChatButton } from './custom-chat-interaction'
import {
  cleanDisplayName,
  compactText,
  formatBadgeLevel,
  isBadDisplayName,
  isNativeDomUnhealthy,
  isNoiseEventText,
  MAX_NATIVE_INITIAL_SCAN,
  MAX_NATIVE_SCAN_BATCH,
  NATIVE_EVENT_SELECTOR,
  NATIVE_HEALTH_MAX_EVENTS,
  NATIVE_HEALTH_MIN_SCANS,
  NATIVE_HEALTH_WINDOW,
  NATIVE_SCAN_DEBOUNCE_MS,
  type NativeParseContext,
  nativeAvatar,
  nativeUid,
  parseBadgeLevel,
  parseNativeEvent,
  resolveAvatarUrl,
  shouldScanNativeEventNode,
  usefulBadgeText,
  wheelFoldKey,
} from './custom-chat-native-adapter'
import { formatMilliyuanAmount, stripCardCountSuffix } from './custom-chat-pricing'
import {
  CUSTOM_CHAT_MAX_MESSAGES,
  customChatBadgeType,
  customChatPriority,
  shouldAnimateRenderBatch,
  shouldSuppressCustomChatEvent,
  takeRenderBatch,
  trimRenderQueue,
  visibleRenderMessages,
} from './custom-chat-render'
import { createScPinStrip } from './custom-chat-sc-pinstrip'
import { customChatSearchHint, kindLabel, messageMatchesCustomChatSearch } from './custom-chat-search'
import { ensureCustomChatStyles } from './custom-chat-style'
import { calculateVirtualContentHeight, calculateVirtualRange } from './custom-chat-virtualizer'
import { copyText, repeatDanmaku, sendManualDanmaku, stealDanmaku } from './danmaku-actions'
import { type DanmakuEvent, subscribeDanmaku } from './danmaku-stream'
import { mountSendActionsIsland } from './emote-picker-mount'
import { hasRecentWsDanmaku } from './live-ws-source'
import {
  customChatCss,
  customChatFoldMode,
  customChatHideNative,
  customChatPerfDebug,
  customChatShowDanmaku,
  customChatShowEnter,
  customChatShowGift,
  customChatShowNotice,
  customChatShowSuperchat,
  customChatTheme,
  danmakuDirectConfirm,
  fasongText,
} from './store'

const ROOT_ID = 'laplace-custom-chat'
const STYLE_ID = 'laplace-custom-chat-style'
const USER_STYLE_ID = 'laplace-custom-chat-user-style'
const MAX_MESSAGES = CUSTOM_CHAT_MAX_MESSAGES
const VIRTUAL_OVERSCAN = 7
// Action row 改成 absolute 后，普通弹幕一条不再有第二行 grid，估算行高
// 从 62 降到 48（avatar 32 + meta+bubble 实际 ~14+18 + padding ~4）。
// `measureRenderedRows` 会在首次渲染后把每行真实高度回填到 `rowHeights` Map，
// 估算只决定首次填充和 spacer 高度，差几像素无所谓。
const DEFAULT_ROW_HEIGHT = 48
const LITE_ROW_HEIGHT = 36
const CARD_ROW_HEIGHT = 96
const CRITICAL_CARD_ROW_HEIGHT = 108
const COMPACT_CARD_ROW_HEIGHT = 70

type ChatFollowMode = 'following' | 'frozenByScroll' | 'frozenByButton'

interface FrozenSnapshot {
  messages: CustomChatEvent[]
  rowHeights: Map<string, number>
  scrollTop: number
}

let unsubscribeDom: (() => void) | null = null
let unsubscribeEvents: (() => void) | null = null
let unsubscribeWsStatus: (() => void) | null = null
let disposeSettings: (() => void) | null = null
let disposeComposer: (() => void) | null = null
let disposeActionsIsland: (() => void) | null = null
let disposePinStrip: (() => void) | null = null
let fallbackMountTimer: ReturnType<typeof setTimeout> | null = null
let nativeEventObserver: MutationObserver | null = null
// The container the native observer is currently bound to. Used so we can
// re-connect after suspending the observer while WS is live.
let nativeEventObserverContainer: HTMLElement | null = null
// Track suspension state so updateWsStatus can flip the observer on/off.
let nativeEventObserverSuspended = false
let root: HTMLElement | null = null
let rootOutsideHistory = false
let rootUsesFallbackHost = false
let fallbackHost: HTMLElement | null = null
let listEl: HTMLElement | null = null
let virtualTopSpacer: HTMLElement | null = null
let virtualItemsEl: HTMLElement | null = null
let virtualBottomSpacer: HTMLElement | null = null
let pauseBtn: HTMLButtonElement | null = null
let unreadBtn: HTMLButtonElement | null = null
let jumpBottomBtn: HTMLButtonElement | null = null
let searchInput: HTMLInputElement | null = null
let matchCountEl: HTMLElement | null = null
let wsStatusEl: HTMLElement | null = null
let emptyEl: HTMLElement | null = null
let perfEl: HTMLElement | null = null
let debugEl: HTMLElement | null = null
let textarea: HTMLTextAreaElement | null = null
let countEl: HTMLElement | null = null
let styleEl: HTMLStyleElement | null = null
let userStyleEl: HTMLStyleElement | null = null
let messageSeq = 0
let followMode: ChatFollowMode = 'following'
let frozenSnapshot: FrozenSnapshot | null = null
let unread = 0
let sending = false
let searchQuery = ''
let hasClearedMessages = false
let currentWsStatus: CustomChatWsStatus = 'off'
let nativeDomWarning = false
const messages: CustomChatEvent[] = []
const messageKeys = new Set<string>()
const recentEventKeys = new Map<string, number>()
// Cache `eventKey(message)` per message ref to avoid recomputing the regex
// inside `compactText` on every dedup scan.
const eventKeyByMessage = new WeakMap<CustomChatEvent, string>()
// Map from eventKey → most-recent message that produced it. O(1) duplicate
// lookup in `messageIndexByEvent`. The array index is recovered via indexOf
// only on the (rare) duplicate-hit path.
const messageByEventKey = new Map<string, CustomChatEvent>()
// 去重折叠：跨用户的 (kind, compactText) 键。仅 danmaku 用，
// 与 messageByEventKey 平行，不替换它。
const messageByCardKey = new Map<string, CustomChatEvent>()
const recentCardKeys = new Map<string, number>()
// Cap on how many entries we keep in the dedup TTL map before forcing GC.
const RECENT_EVENT_KEYS_GC_THRESHOLD = 512
const renderQueue: CustomChatEvent[] = []
let visibleMessages: CustomChatEvent[] = []
const rowHeights = new Map<string, number>()
const eventTicks: number[] = []
const nativeHealthSamples: Array<{ ts: number; parsed: boolean }> = []
const seenNativeNodes = new WeakSet<HTMLElement>()
const pendingNativeNodes = new Set<HTMLElement>()
const sourceCounts: Record<CustomChatEvent['source'], number> = { dom: 0, ws: 0, local: 0 }
let lastBatchSize = 0
let chatFrame: number | null = null
let nativeScanFrame: number | null = null
let nativeScanDebounceTimer: ReturnType<typeof setTimeout> | null = null
let pendingRenderFlush = false
let pendingRerender: { token: number; refreshFrozenSnapshot: boolean } | null = null
let rerenderToken = 0
let emoticonRefreshToken = 0
// Registered listener cleanup. Older Safari (<15) and some Violentmonkey
// sandboxes don't support `addEventListener({ signal })`, so we keep a manual
// disposer list and only opportunistically use AbortSignal as a fast path
// when we can prove it's wired up. See `addRootEventListener` for the probe.
let rootEventController: AbortController | null = null
let rootEventDisposers: Array<() => void> = []

async function refreshCurrentRoomEmoticons(): Promise<void> {
  const token = ++emoticonRefreshToken
  try {
    const roomId = await ensureRoomId()
    if (token !== emoticonRefreshToken) return
    await fetchEmoticons(roomId)
  } catch {
    // Non-critical: the chat can still render plain text and native DOM fallbacks.
  }
}

function eventToSendableMessage(ev: DanmakuEvent): string {
  if (!ev.isReply) return ev.text
  return ev.uname ? `@${ev.uname} ${ev.text}` : ev.text
}

/**
 * Cached probe result for `addEventListener({ signal })` support.
 * Safari 15+, Firefox 124+, and Chrome 90+ accept `signal` in listener
 * options; older versions silently ignore it (so listeners never detach when
 * we abort). We feature-detect once on first call and cache the result.
 */
let signalListenerSupported: boolean | null = null
function detectSignalListenerSupport(): boolean {
  if (signalListenerSupported !== null) return signalListenerSupported
  if (typeof AbortController === 'undefined') {
    signalListenerSupported = false
    return false
  }
  try {
    let read = false
    const probeOptions: AddEventListenerOptions = {}
    Object.defineProperty(probeOptions, 'signal', {
      get() {
        read = true
        return undefined
      },
    })
    // Attach + immediately detach a no-op listener on a transient element so
    // the page never sees this probe.
    const probeTarget = typeof document !== 'undefined' ? document.createElement('div') : null
    if (!probeTarget) {
      signalListenerSupported = false
      return false
    }
    probeTarget.addEventListener('test', () => {}, probeOptions)
    probeTarget.removeEventListener('test', () => {}, probeOptions)
    signalListenerSupported = read
    return read
  } catch {
    signalListenerSupported = false
    return false
  }
}

function getRootEventSignal(): AbortSignal | undefined {
  if (typeof AbortController === 'undefined') return undefined
  rootEventController ??= new AbortController()
  return rootEventController.signal
}

function abortRootEventListeners(): void {
  rootEventController?.abort()
  rootEventController = null
  // Always run manual disposers too — they cover environments where the
  // signal-as-listener-option fast path was unavailable.
  for (const dispose of rootEventDisposers) {
    try {
      dispose()
    } catch {
      // best-effort cleanup
    }
  }
  rootEventDisposers = []
}

function addRootEventListener<K extends keyof GlobalEventHandlersEventMap>(
  target: HTMLElement,
  type: K,
  listener: (event: GlobalEventHandlersEventMap[K]) => void,
  options?: AddEventListenerOptions
): void {
  const eventListener = listener as EventListener
  if (detectSignalListenerSupport()) {
    target.addEventListener(type, eventListener, { ...options, signal: getRootEventSignal() })
    return
  }
  // Fallback path: browser/sandbox doesn't honor `signal` in listener options.
  // Register manually and queue a disposer so abortRootEventListeners() can
  // detach it. Same observable behavior, slightly more closure overhead.
  target.addEventListener(type, eventListener, options)
  rootEventDisposers.push(() => target.removeEventListener(type, eventListener, options))
}

function makeButton(
  className: string,
  text: string,
  title: string,
  onClick: (e: MouseEvent) => void
): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = className
  btn.textContent = text
  prepareChatButton(btn, title)
  addRootEventListener(btn, 'click', onClick)
  return btn
}
function eventKey(event: Pick<CustomChatEvent, 'kind' | 'uid' | 'text'>): string {
  return `${event.kind}:${event.uid ?? ''}:${compactText(event.text).slice(0, 80)}`
}

function eventKeyOf(message: CustomChatEvent): string {
  let key = eventKeyByMessage.get(message)
  if (key === undefined) {
    key = eventKey(message)
    eventKeyByMessage.set(message, key)
  }
  return key
}

function messageKey(event: Pick<CustomChatEvent, 'source' | 'id'>): string {
  return `${event.source}:${event.id}`
}

function gcRecentEventKeys(now: number): void {
  for (const [key, ts] of recentEventKeys) {
    if (now - ts > 9000) recentEventKeys.delete(key)
  }
}

function cardKey(event: Pick<CustomChatEvent, 'kind' | 'text'>): string {
  // wheelFoldKey 把「666」「6666」「66666」/「哈哈」「哈哈哈」归一化成同一把键，
  // 让独轮车的不同长度版本能合并到一张卡。slice(80) 防止极长弹幕拖慢键比较。
  //
  // chatfilter 场景 B（chatfilterAffectCustomChatFold）开时优先用 chatfilter
  // canonical 做 key —— 这样"niubi"/"NB"/"牛批" 这类同义弹幕也合并成一张卡，
  // 不只是字面重复。getCustomChatFoldCanonical 在场景关闭或文本被 filtered
  // 时返回 null，自动回落到原 wheelFoldKey。
  const canonical = getCustomChatFoldCanonical(event.text)
  const key = canonical ?? wheelFoldKey(event.text)
  return `${event.kind}:${key.slice(0, 80)}`
}

function gcRecentCardKeys(now: number): void {
  for (const [key, ts] of recentCardKeys) {
    if (now - ts > 9000) recentCardKeys.delete(key)
  }
}

function rememberEvent(event: Pick<CustomChatEvent, 'kind' | 'uid' | 'text'>): boolean {
  const now = Date.now()
  // Bound the map: only sweep when it grows past the threshold instead of
  // iterating the whole map on every event.
  if (recentEventKeys.size > RECENT_EVENT_KEYS_GC_THRESHOLD) {
    gcRecentEventKeys(now)
  }
  const key = eventKey(event)
  if (recentEventKeys.has(key)) return false
  recentEventKeys.set(key, now)
  return true
}

function messageIndexByEvent(event: Pick<CustomChatEvent, 'kind' | 'uid' | 'text'>): number {
  const key = eventKey(event)
  const existing = messageByEventKey.get(key)
  if (!existing) return -1
  return messages.indexOf(existing)
}

function chooseBetterName(current: string, incoming: string): string {
  const currentName = compactText(current)
  const incomingName = compactText(incoming)
  if (!incomingName) return current
  if (!currentName || currentName === '匿名') return incoming
  if (incomingName === '匿名') return current
  if (incomingName.length > currentName.length && incomingName.includes(currentName)) return incoming
  return current
}

function mergeFields(
  current: CustomChatField[] | undefined,
  incoming: CustomChatField[] | undefined
): CustomChatField[] | undefined {
  if (!incoming?.length) return current
  if (!current?.length) return incoming
  const merged = [...current]
  const keys = new Set(current.map(field => field.key))
  for (const field of incoming) {
    if (keys.has(field.key)) continue
    merged.push(field)
  }
  return merged
}

function bestMergedBadges(currentBadges: string[], incomingBadges: string[]): string[] {
  const merged: string[] = []
  let bestLevel: number | null = null
  for (const raw of [...currentBadges, ...incomingBadges]) {
    const level = parseBadgeLevel(raw)
    if (level !== null) {
      if (level > 0 && (bestLevel === null || level > bestLevel)) bestLevel = level
      continue
    }
    if (!merged.includes(raw)) merged.push(raw)
  }
  if (bestLevel !== null) merged.push(formatBadgeLevel(bestLevel))
  return merged
}

function mergeDuplicateEvent(current: CustomChatEvent, incoming: CustomChatEvent): CustomChatEvent | null {
  const preferIncomingIdentity = incoming.source === 'ws' && current.source === 'dom'
  const mergedBadges = bestMergedBadges(current.badges, incoming.badges)
  const mergedFields = mergeFields(current.fields, incoming.fields)
  const merged: CustomChatEvent = {
    ...current,
    id: preferIncomingIdentity ? incoming.id : current.id,
    kind: current.kind === incoming.kind ? current.kind : incoming.kind,
    sendText: incoming.sendText ?? current.sendText,
    uname: chooseBetterName(current.uname, incoming.uname),
    uid: current.uid ?? incoming.uid,
    time: preferIncomingIdentity ? incoming.time : current.time,
    isReply: current.isReply || incoming.isReply,
    source: preferIncomingIdentity ? incoming.source : current.source,
    badges: mergedBadges,
    avatarUrl: incoming.avatarUrl ?? current.avatarUrl,
    amount: current.amount ?? incoming.amount,
    fields: mergedFields,
    rawCmd: incoming.rawCmd ?? current.rawCmd,
  }

  const changed =
    merged.id !== current.id ||
    merged.kind !== current.kind ||
    merged.sendText !== current.sendText ||
    merged.uname !== current.uname ||
    merged.uid !== current.uid ||
    merged.time !== current.time ||
    merged.isReply !== current.isReply ||
    merged.source !== current.source ||
    merged.avatarUrl !== current.avatarUrl ||
    merged.amount !== current.amount ||
    merged.rawCmd !== current.rawCmd ||
    merged.badges.length !== current.badges.length ||
    merged.badges.some((badge, index) => badge !== current.badges[index]) ||
    (merged.fields?.length ?? 0) !== (current.fields?.length ?? 0)

  return changed ? merged : null
}

function replaceMessage(index: number, next: CustomChatEvent): void {
  const previous = messages[index]
  if (!previous) return
  const prevKey = messageKey(previous)
  const nextKey = messageKey(next)
  const prevEventKey = eventKeyOf(previous)
  const nextEventKey = eventKey(next)
  eventKeyByMessage.set(next, nextEventKey)
  messages[index] = next
  if (prevKey !== nextKey) {
    messageKeys.delete(prevKey)
    rowHeights.delete(prevKey)
    messageKeys.add(nextKey)
  }
  if (messageByEventKey.get(prevEventKey) === previous) {
    messageByEventKey.delete(prevEventKey)
  }
  messageByEventKey.set(nextEventKey, next)
  scheduleRerenderMessages()
}

function recordEventStats(event: CustomChatEvent): void {
  const now = Date.now()
  eventTicks.push(now)
  // Find the first tick still inside the 1s window and drop everything before
  // it in a single splice, instead of shifting one by one (O(n) per shift on
  // each event during chat waves).
  let dropCount = 0
  while (dropCount < eventTicks.length && now - eventTicks[dropCount] > 1000) dropCount++
  if (dropCount > 0) eventTicks.splice(0, dropCount)
  sourceCounts[event.source]++
}

function updatePerfDebug(): void {
  if (!perfEl || !root) return
  root.dataset.debug = customChatPerfDebug.value ? 'true' : 'false'
  root.dataset.followMode = followMode
  if (!customChatPerfDebug.value) {
    root.removeAttribute('data-inspecting')
    root.querySelectorAll('.lc-chat-message.lc-chat-selected').forEach(el => {
      el.classList.remove('lc-chat-selected')
    })
    debugEl?.replaceChildren()
    return
  }
  const totalSources = sourceCounts.dom + sourceCounts.ws + sourceCounts.local || 1
  const pct = (value: number) => Math.round((value / totalSources) * 100)
  const rendered = virtualItemsEl?.querySelectorAll('.lc-chat-message').length ?? 0
  perfEl.textContent = `消息 ${messages.length}/${MAX_MESSAGES} | 可见 ${renderedMessages().length} | DOM节点 ${rendered} | 事件 ${eventTicks.length}/秒 | 本帧 ${lastBatchSize} | 待渲染 ${renderQueue.length} | DOM待扫 ${pendingNativeNodes.size} | WS ${pct(sourceCounts.ws)}% DOM ${pct(sourceCounts.dom)}% 本地 ${pct(sourceCounts.local)}%`
}

function isReliableEvent(event: CustomChatEvent): boolean {
  if (shouldSuppressCustomChatEvent(event)) return false
  const text = compactText(event.text)
  if (isNoiseEventText(text)) return false
  return !(
    event.source === 'dom' &&
    displayName(event) === '匿名' &&
    !event.uid &&
    !event.avatarUrl &&
    text.length <= 2
  )
}

function shouldShowUserLevelBadge(message: CustomChatEvent): boolean {
  return message.kind === 'danmaku'
}

function normalizedUserLevelBadge(message: CustomChatEvent, name = displayName(message)): string | null {
  if (!shouldShowUserLevelBadge(message)) return null
  for (const raw of message.badges) {
    const text = usefulBadgeText(raw, name)
    const level = text ? parseBadgeLevel(text) : parseBadgeLevel(raw)
    if (level !== null) return formatBadgeLevel(level)
  }
  return null
}

function displayName(message: CustomChatEvent): string {
  let name = cleanDisplayName(message.uname) || '匿名'
  for (const raw of message.badges) {
    const badge = compactText(raw)
    if (badge && name.startsWith(`${badge} `)) {
      name = cleanDisplayName(name.slice(badge.length))
    }
  }
  const medalPrefix = name.match(/^[^\s:：]{1,10}\s+\d{1,3}\s+(.{1,32})$/u)
  const medalName = cleanDisplayName(medalPrefix?.[1] ?? '')
  if (medalName && !isBadDisplayName(medalName)) name = medalName
  name = cleanDisplayName(name)
  if (isBadDisplayName(name)) return '匿名'
  return name || '匿名'
}

function normalizeBadges(message: CustomChatEvent, name = displayName(message)): string[] {
  const normalized: string[] = []
  const userLevelBadge = normalizedUserLevelBadge(message, name)
  const maxOtherBadges = userLevelBadge ? 1 : 2
  for (const raw of message.badges) {
    const text = usefulBadgeText(raw, name)
    if (!text) continue
    if (parseBadgeLevel(text) !== null) continue
    if (text === name || name.includes(text)) continue
    if (normalized.includes(text)) continue
    const parts = text.split(/\s+/).filter(Boolean)
    if (parts.length === 1 && normalized.some(item => item.includes(text))) continue
    if (parts.length > 1) {
      for (let i = normalized.length - 1; i >= 0; i--) {
        if (/^\d{1,3}$/.test(normalized[i]) && text.includes(normalized[i])) normalized.splice(i, 1)
      }
    }
    normalized.push(text)
    if (normalized.length >= maxOtherBadges) break
  }
  if (userLevelBadge && !normalized.includes(userLevelBadge)) normalized.push(userLevelBadge)
  return normalized
}

function guardLevel(message: CustomChatEvent): string | null {
  const value = `${message.text} ${message.badges.join(' ')} ${message.rawCmd ?? ''}`
  if (/总督|GUARD\s*1|舰队\s*1|privilege[_-]?type["':\s]*1/iu.test(value)) return '1'
  if (/提督|GUARD\s*2|舰队\s*2|privilege[_-]?type["':\s]*2/iu.test(value)) return '2'
  if (/舰长|GUARD\s*3|舰队\s*3|privilege[_-]?type["':\s]*3/iu.test(value)) return '3'
  return null
}

function cardType(message: CustomChatEvent): 'gift' | 'superchat' | 'guard' | 'redpacket' | 'lottery' | null {
  if (message.kind === 'superchat') return 'superchat'
  if (message.kind === 'gift') return 'gift'
  if (message.kind === 'guard') return 'guard'
  if (message.kind === 'redpacket') return 'redpacket'
  if (message.kind === 'lottery') return 'lottery'
  return null
}

function cardTitle(
  type: 'gift' | 'superchat' | 'guard' | 'redpacket' | 'lottery',
  message: CustomChatEvent,
  guard: string | null
): string {
  if (type === 'superchat') return message.amount ? `醒目留言 ¥${message.amount}` : '醒目留言'
  if (type === 'gift') return message.amount ? `礼物 ¥${Math.round(message.amount / 1000)}` : '礼物事件'
  if (type === 'redpacket') return '红包事件'
  if (type === 'lottery') return '天选时刻'
  if (guard === '1') return '总督事件'
  if (guard === '2') return '提督事件'
  return '舰长事件'
}

function cardMark(type: 'gift' | 'superchat' | 'guard' | 'redpacket' | 'lottery', guard: string | null): string {
  if (type === 'superchat') return 'SC'
  if (type === 'gift') return '礼物'
  if (type === 'redpacket') return '红包'
  if (type === 'lottery') return '天选'
  if (guard === '1') return '总督'
  if (guard === '2') return '提督'
  return '舰长'
}

function formatAmount(message: CustomChatEvent, card: NonNullable<ReturnType<typeof cardType>>): string {
  if (!message.amount) return ''
  if (card === 'gift' || card === 'guard') return formatMilliyuanAmount(message.amount)
  if (card === 'gift' || card === 'guard') return `¥${Math.round(message.amount / 1000)}`
  return `¥${message.amount}`
}

function cardFields(
  message: CustomChatEvent,
  card: NonNullable<ReturnType<typeof cardType>>,
  guard: string | null
): CustomChatField[] {
  const fields = message.fields?.filter(field => field.value) ?? []
  if (fields.length > 0) return fields

  const fallback: CustomChatField[] = []
  const amount = formatAmount(message, card)
  if (card === 'superchat' && amount) fallback.push({ key: 'sc-price', label: '金额', value: amount, kind: 'money' })
  if (card === 'gift') {
    const giftMatch = message.text.match(/(.+?)\s*x\s*(\d+)/i)
    if (giftMatch?.[1])
      fallback.push({
        key: 'gift-name',
        label: '礼物',
        value: giftMatch[1].replace(/^.*?(投喂|赠送|送出)\s*/u, ''),
        kind: 'text',
      })
    if (giftMatch?.[2]) fallback.push({ key: 'gift-count', label: '数量', value: `x${giftMatch[2]}`, kind: 'count' })
    if (amount) fallback.push({ key: 'gift-price', label: '金额', value: amount, kind: 'money' })
  }
  if (card === 'guard') {
    const level = guard === '1' ? '总督' : guard === '2' ? '提督' : '舰长'
    fallback.push({ key: 'guard-level', label: '等级', value: level, kind: 'level' })
    const month = message.text.match(/x\s*(\d+)/i)?.[1]
    if (month) fallback.push({ key: 'guard-months', label: '月份', value: `${month}个月`, kind: 'duration' })
    if (amount) fallback.push({ key: 'guard-price', label: '金额', value: amount, kind: 'money' })
  }
  return fallback
}

/** @internal Exported for tests; not part of the public API. */
export function createAvatar(message: CustomChatEvent): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'lc-chat-avatar lc-chat-avatar-fallback'
  // No initial-letter text: the styled "blue + first character" placeholder
  // reads as a loading-state widget and pulls the eye. The fallback styling
  // (a muted gray silhouette, in custom-chat-style) is intentionally quiet,
  // so the swap to the real avatar is not visually dramatic.
  wrap.title = message.uid ? `UID ${message.uid}` : message.uname

  const avatar = message.avatarUrl || resolveAvatarUrl(message.uid)
  if (!avatar) return wrap

  const img = document.createElement('img')
  img.className = 'lc-chat-avatar-img'
  img.alt = ''
  img.referrerPolicy = 'no-referrer'
  // Sync decoding so a cache hit paints in the same frame as the message
  // text — that's the whole point of prewarmAvatar. For a 96px avatar the
  // sync decode path is sub-millisecond even on a miss, so it doesn't slow
  // message rendering. (Mutating decoding after src is set is undefined in
  // some engines; we set it before src and never touch it again.)
  img.decoding = 'sync'
  img.src = avatar
  if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
    img.dataset.loaded = '1'
  } else {
    addRootEventListener(img, 'load', () => img.setAttribute('data-loaded', '1'), { once: true })
  }
  addRootEventListener(img, 'error', () => img.remove(), { once: true })
  wrap.append(img)
  return wrap
}

function recordNativeHealth(parsed: boolean): void {
  const now = Date.now()
  nativeHealthSamples.push({ ts: now, parsed })
  while (nativeHealthSamples.length > 0 && now - nativeHealthSamples[0].ts > NATIVE_HEALTH_WINDOW) {
    nativeHealthSamples.shift()
  }
  const unhealthy = isNativeDomUnhealthy(nativeHealthSamples, NATIVE_HEALTH_MIN_SCANS, NATIVE_HEALTH_MAX_EVENTS)
  if (nativeDomWarning === unhealthy) return
  nativeDomWarning = unhealthy
  updateWsStatus(currentWsStatus)
}

function kindVisible(kind: CustomChatKind): boolean {
  if (kind === 'danmaku') return customChatShowDanmaku.value
  if (kind === 'gift') return customChatShowGift.value
  if (kind === 'superchat') return customChatShowSuperchat.value
  if (kind === 'guard' || kind === 'enter' || kind === 'follow' || kind === 'like' || kind === 'share')
    return customChatShowEnter.value
  if (kind === 'redpacket' || kind === 'lottery' || kind === 'notice' || kind === 'system')
    return customChatShowNotice.value
  return true
}

function messageMatchesSearch(message: CustomChatEvent): boolean {
  return messageMatchesCustomChatSearch(message, searchQuery, kindVisible)
}

function searchHint(): string {
  return customChatSearchHint(searchQuery)
}

function isFollowing(): boolean {
  return followMode === 'following'
}

function renderedMessages(): CustomChatEvent[] {
  return frozenSnapshot?.messages ?? visibleMessages
}

function renderedRowHeights(): Map<string, number> {
  return frozenSnapshot?.rowHeights ?? rowHeights
}

function snapshotFromLive(scrollTop = listEl?.scrollTop ?? 0): FrozenSnapshot {
  return {
    messages: [...visibleMessages],
    rowHeights: new Map(rowHeights),
    scrollTop,
  }
}

function syncFrozenSnapshotFromLive(): void {
  if (isFollowing()) return
  frozenSnapshot = snapshotFromLive(listEl?.scrollTop ?? frozenSnapshot?.scrollTop ?? 0)
}

function enterFrozenMode(mode: Exclude<ChatFollowMode, 'following'>): void {
  if (isFollowing()) {
    frozenSnapshot = snapshotFromLive()
  } else if (frozenSnapshot && listEl) {
    frozenSnapshot.scrollTop = listEl.scrollTop
  }
  followMode = mode
  updateUnread()
}

function resumeFollowing(behavior: ScrollBehavior = 'smooth'): void {
  followMode = 'following'
  frozenSnapshot = null
  unread = 0
  updateUnread()
  scrollToBottom(behavior)
}

function renderedMessageCount(): number {
  return renderedMessages().length
}

function updateEmptyState(): void {
  if (!listEl || !emptyEl) return
  const visibleCount = renderedMessageCount()
  if (visibleCount > 0) {
    emptyEl.remove()
    return
  }
  const trimmedQuery = searchQuery.trim()
  const hint = searchHint()
  if (trimmedQuery) {
    emptyEl.textContent = hint || `没有找到匹配“${trimmedQuery}”的消息`
  } else if (hasClearedMessages) {
    emptyEl.textContent = '已清屏，新的弹幕会继续出现在这里'
  } else {
    emptyEl.textContent = '还没有收到消息'
  }
  if (!emptyEl.isConnected) listEl.append(emptyEl)
}

function wsStatusLabel(status: CustomChatWsStatus): string {
  if (nativeDomWarning && (status === 'error' || status === 'closed' || status === 'off'))
    return '页面兜底疑似失效，B站页面结构可能变了'
  if (status === 'connecting') return '实时事件源连接中'
  if (status === 'live') return '实时事件源正常'
  if (status === 'error') return '直连异常，使用页面兜底，可能漏消息'
  if (status === 'closed') return '直连已断开，使用页面兜底，可能漏消息'
  return '实时事件源关闭'
}

function updateWsStatus(status: CustomChatWsStatus): void {
  currentWsStatus = status
  syncNativeObserverWithWsStatus()
  if (!wsStatusEl) return
  wsStatusEl.textContent = wsStatusLabel(status)
  wsStatusEl.dataset.status =
    nativeDomWarning && (status === 'error' || status === 'closed' || status === 'off')
      ? 'dom-warning'
      : status === 'error' || status === 'closed'
        ? 'fallback'
        : status
}

function updateMatchCount(): void {
  if (!matchCountEl) return
  if (!searchQuery.trim()) {
    matchCountEl.textContent = ''
    matchCountEl.style.display = 'none'
    return
  }
  const hint = searchHint()
  if (hint) {
    matchCountEl.textContent = hint
    matchCountEl.style.display = ''
    return
  }
  const count = messages.filter(messageMatchesSearch).length
  matchCountEl.textContent = `${count}/${messages.length}`
  matchCountEl.style.display = ''
}

/** 大于 99 的未读消息显示为 "99+"，避免 pill 被超长数字撑开。 */
function formatUnread(n: number): string {
  return n > 99 ? '99+' : String(n)
}

function updateUnread(): void {
  if (pauseBtn) {
    const frozen = !isFollowing()
    pauseBtn.textContent = frozen ? '恢复跟随' : '暂停'
    pauseBtn.title = frozen ? '恢复自动跟随并跳到底部' : '暂停自动跟随，停留在当前聊天位置'
    pauseBtn.setAttribute('aria-pressed', frozen ? 'true' : 'false')
  }
  if (unreadBtn) {
    if (isFollowing()) {
      unreadBtn.textContent = ''
      unreadBtn.style.display = 'none'
      unreadBtn.dataset.frozen = 'false'
    } else {
      unreadBtn.textContent =
        unread > 0
          ? `${formatUnread(unread)} 条新消息，点击回到底部`
          : followMode === 'frozenByButton'
            ? '已手动暂停跟随'
            : '正在浏览历史'
      unreadBtn.title = '恢复自动跟随并跳到底部'
      unreadBtn.style.display = ''
      unreadBtn.dataset.frozen = 'true'
    }
  }
  if (jumpBottomBtn) {
    if (isFollowing()) {
      jumpBottomBtn.style.display = 'none'
      jumpBottomBtn.dataset.unread = '0'
    } else {
      jumpBottomBtn.style.display = ''
      jumpBottomBtn.dataset.unread = unread > 0 ? 'true' : 'false'
      jumpBottomBtn.textContent = unread > 0 ? `新消息 ${formatUnread(unread)} ↓` : '回到最新 ↓'
      jumpBottomBtn.title = '回到底部并恢复自动跟随'
    }
  }
  updatePerfDebug()
}

function isNearBottom(): boolean {
  if (!listEl) return true
  return virtualContentHeight() - listEl.scrollTop - listEl.clientHeight < 80
}

function syncAutoFollowFromScroll(): void {
  if (!listEl) return
  if (frozenSnapshot) frozenSnapshot.scrollTop = listEl.scrollTop
  const nearBottom = isNearBottom()
  if (isFollowing()) {
    if (!nearBottom) enterFrozenMode('frozenByScroll')
    return
  }
  if (followMode === 'frozenByScroll' && nearBottom) {
    resumeFollowing()
    return
  }
  updateUnread()
}

function scrollToBottom(behavior: ScrollBehavior = 'auto'): void {
  if (!listEl) return
  let top = Math.max(0, virtualContentHeight() - listEl.clientHeight)
  listEl.scrollTo({ top, behavior })
  if (behavior !== 'auto') return
  // After the first scroll, the bottom rows that were never previously
  // rendered get rendered + measured here. Their actual heights routinely
  // differ from estimatedRowHeight (long danmaku that wrap to extra lines,
  // gift / SC cards, …), so virtualContentHeight() grows. Without iterating,
  // a single click lands on the *estimated* bottom — measured live in the
  // browser, the gap was 250+ px after one pass — and the user has to click
  // "回到最新 ↓" / "新消息 99+ ↓" repeatedly while the target keeps moving.
  for (let attempts = 0; attempts < 4; attempts++) {
    renderVirtualWindow()
    const nextTop = Math.max(0, virtualContentHeight() - listEl.clientHeight)
    if (Math.abs(nextTop - top) < 1) break
    top = nextTop
    listEl.scrollTo({ top, behavior: 'auto' })
  }
}

function scrollListByWheel(event: WheelEvent): void {
  if (!listEl || renderedMessages().length === 0) return
  const delta = normalizeWheelDelta(event)
  if (delta === 0) return
  event.preventDefault()
  const maxTop = Math.max(0, virtualContentHeight() - listEl.clientHeight)
  const nextTop = Math.max(0, Math.min(maxTop, listEl.scrollTop + delta))
  if (Math.abs(nextTop - listEl.scrollTop) < 0.5) return
  listEl.scrollTop = nextTop
  renderVirtualWindow()
  syncAutoFollowFromScroll()
}

function pruneMessages(): void {
  if (messages.length <= MAX_MESSAGES) {
    updatePerfDebug()
    return
  }
  const dropCount = messages.length - MAX_MESSAGES
  const removed = messages.splice(0, dropCount)
  for (const message of removed) {
    const key = messageKey(message)
    messageKeys.delete(key)
    rowHeights.delete(key)
    const ek = eventKeyByMessage.get(message)
    if (ek !== undefined && messageByEventKey.get(ek) === message) {
      messageByEventKey.delete(ek)
    }
    if (message.kind === 'danmaku') {
      const ck = cardKey(message)
      if (messageByCardKey.get(ck) === message) {
        messageByCardKey.delete(ck)
        recentCardKeys.delete(ck)
      }
    }
  }
  updatePerfDebug()
}

function estimatedRowHeight(message: CustomChatEvent): number {
  const card = cardType(message)
  const priority = customChatPriority(message)
  if (priority === 'lite') return LITE_ROW_HEIGHT
  if (card === 'gift' && !message.amount) return COMPACT_CARD_ROW_HEIGHT
  if (priority === 'critical') return CRITICAL_CARD_ROW_HEIGHT
  if (card) return CARD_ROW_HEIGHT
  return DEFAULT_ROW_HEIGHT + Math.max(0, Math.ceil(message.text.length / 34) - 1) * 18
}

function rowHeight(message: CustomChatEvent): number {
  return renderedRowHeights().get(messageKey(message)) ?? estimatedRowHeight(message)
}

function virtualContentHeight(end = renderedMessages().length): number {
  const items = renderedMessages()
  return calculateVirtualContentHeight(items.length, index => rowHeight(items[index]), end)
}

function setSpacerHeight(spacer: HTMLElement | null, height: number): void {
  if (!spacer) return
  spacer.style.height = `${Math.max(0, Math.round(height))}px`
}

function refreshVisibleMessages(): void {
  visibleMessages = visibleRenderMessages(messages, messageMatchesSearch)
}

function createMessageRow(message: CustomChatEvent, animate = false, virtualIndex = 0): HTMLElement {
  const row = document.createElement('div')
  const priority = customChatPriority(message)
  row.className = animate ? 'lc-chat-message lc-chat-peek' : 'lc-chat-message'
  row.dataset.uid = message.uid ?? ''
  row.dataset.kind = message.kind
  row.dataset.source = message.source
  row.dataset.user = displayName(message)
  row.dataset.priority = priority
  row.dataset.virtualIndex = String(virtualIndex)
  row.setAttribute('role', 'listitem')
  row.tabIndex = 0
  const guard = guardLevel(message)
  const card = cardType(message)
  if (priority === 'lite') row.classList.add('lc-chat-lite-event')
  if (card) {
    row.classList.add('lc-chat-card-event')
    row.dataset.card = card
  }
  if (card === 'gift' && !message.amount) row.classList.add('lc-chat-card-compact')
  if (guard) row.dataset.guard = guard

  addRootEventListener(row, 'click', e => {
    if (!customChatPerfDebug.value) return
    const target = e.target
    if (target instanceof HTMLElement && target.closest('button')) return
    showEventDebug(message, row, card, guard)
  })

  const avatarEl = createAvatar(message)

  const meta = document.createElement('div')
  meta.className = 'lc-chat-meta'

  const kind = document.createElement('span')
  kind.className = 'lc-chat-badge lc-chat-kind'
  kind.dataset.kind = message.kind
  setText(kind, kindLabel(message.kind))

  const name = document.createElement('span')
  name.className = 'lc-chat-name'
  const shownName = displayName(message)
  setText(name, shownName)

  const time = document.createElement('span')
  time.className = 'lc-chat-time'
  setText(time, message.time)

  if (message.kind !== 'danmaku') meta.append(kind)
  meta.append(name, time)
  // ×N 折叠徽章不在 meta(用户名行)里 ——挂在用户名后会被误读成"这个用户的属性"。
  // 实际语义是"这条文本最近 9 秒出现 N 次",所以挂在文本气泡的末尾(见下面 text
  // 内容块构建完之后)。pattern 参考 iMessage 的 "Sent N times" 标签。
  const mergeCount = message.mergeCount ?? 1
  const mergeBadge = mergeCount > 1 ? document.createElement('span') : null
  if (mergeBadge) {
    mergeBadge.className = 'lc-chat-merge-count'
    mergeBadge.textContent = `×${mergeCount}`
    mergeBadge.title = `近 9 秒内同一弹幕共出现 ${mergeCount} 次`
  }
  if (message.isReply) {
    const reply = document.createElement('span')
    reply.className = 'lc-chat-reply'
    reply.textContent = '回复'
    meta.append(reply)
  }
  for (const badgeText of normalizeBadges(message, shownName)) {
    const badgeType = customChatBadgeType(badgeText)
    const badge = document.createElement('span')
    badge.className = `lc-chat-badge lc-chat-medal lc-chat-badge-${badgeType}`
    badge.dataset.badge = badgeText
    badge.dataset.badgeType = badgeType
    setText(badge, badgeText)
    meta.append(badge)
  }

  const actions = document.createElement('div')
  actions.className = 'lc-chat-actions'
  if (message.sendText) {
    actions.append(
      makeButton('lc-chat-action', '偷', '偷到发送框并复制', () => void stealDanmaku(message.sendText ?? message.text)),
      makeButton('lc-chat-action', '+1', '+1 发送', e => {
        void repeatDanmaku(message.sendText ?? message.text, {
          confirm: danmakuDirectConfirm.value,
          anchor: { x: e.clientX, y: e.clientY },
        })
      })
    )
  }
  actions.append(
    makeButton('lc-chat-action', '复制', '复制事件文本', () => void copyText(message.sendText ?? message.text))
  )

  const body = document.createElement('div')
  body.className = 'lc-chat-body'

  const text = document.createElement('div')
  text.className = 'lc-chat-bubble lc-chat-text'
  if (card) {
    const head = document.createElement('div')
    head.className = 'lc-chat-card-head'

    const title = document.createElement('span')
    title.className = 'lc-chat-card-title'
    setText(title, cardTitle(card, message, guard))

    const mark = document.createElement('span')
    mark.className = 'lc-chat-card-mark'
    setText(mark, cardMark(card, guard))

    const content = document.createElement('span')
    content.className = 'lc-chat-card-text'
    // Gift / guard 的 message.text 末尾常带 "× 1" / "x3" 等数量后缀(B 站源数据),
    // 跟 .lc-chat-merge-count 的折叠 ×N 符号撞车 (Jobs 2026-05-18)。strip 逻辑
    // 抽到 custom-chat-pricing.ts 的 stripCardCountSuffix 便于单测。
    const contentText = card === 'gift' || card === 'guard' ? stripCardCountSuffix(message.text) : message.text
    setText(content, contentText)

    const fields = cardFields(message, card, guard).slice(0, 3)
    const fieldsEl = document.createElement('div')
    fieldsEl.className = 'lc-chat-card-fields'
    for (const field of fields) {
      const fieldEl = document.createElement('span')
      fieldEl.className = 'lc-chat-card-field'
      fieldEl.dataset.field = field.key
      if (field.kind) fieldEl.dataset.kind = field.kind
      const label = document.createElement('span')
      label.className = 'lc-chat-card-field-label'
      setText(label, field.label)
      const value = document.createElement('span')
      value.className = 'lc-chat-card-field-value'
      setText(value, field.value)
      fieldEl.append(label, value)
      fieldsEl.append(fieldEl)
    }

    head.append(title, mark)
    text.append(head)
    if (fields.length > 0) text.append(fieldsEl)
    text.append(content)
  } else if (message.emoticonImage?.url) {
    const img = document.createElement('img')
    img.className = 'lc-chat-emote-big'
    img.dataset.emoteKind = 'big'
    img.src = message.emoticonImage.url
    img.alt = message.emoticonImage.alt
    img.title = message.emoticonImage.alt
    img.loading = 'lazy'
    img.decoding = 'async'
    text.replaceChildren(img)
  } else {
    setText(text, message.text)
  }
  // ×N 角标 ——append 到气泡里,CSS 用 absolute top-right 把它浮到气泡右上角
  // (custom-chat-style.ts .lc-chat-merge-count 块,Jobs P0-4 修复:原 inline-block
  // 长文本换行时变成视觉孤儿)。card / emote / plain 三种形态都靠同一份 CSS
  // 处理;card 上额外有 .lc-chat-card-event 子规则切到白色 chip 防止跟 SC 橙红
  // 渐变冲突(Jobs P1-6)。
  if (mergeBadge) text.append(mergeBadge)
  body.append(meta, text)

  row.append(avatarEl, body, actions)
  return row
}

function virtualRange(): { start: number; end: number; top: number; bottom: number; total: number } {
  const items = renderedMessages()
  return calculateVirtualRange({
    itemCount: items.length,
    scrollTop: listEl?.scrollTop ?? 0,
    viewportHeight: listEl?.clientHeight ?? 0,
    overscan: VIRTUAL_OVERSCAN,
    rowHeight: index => rowHeight(items[index]),
  })
}

function measureRenderedRows(): void {
  if (!virtualItemsEl) return
  const items = renderedMessages()
  const heights = renderedRowHeights()
  let changed = false
  for (const row of virtualItemsEl.querySelectorAll<HTMLElement>('.lc-chat-message')) {
    const index = Number(row.dataset.virtualIndex)
    const message = items[index]
    if (!message) continue
    const measured = Math.ceil(row.getBoundingClientRect().height)
    if (measured <= 0) continue
    const key = messageKey(message)
    if (Math.abs((heights.get(key) ?? 0) - measured) > 2) {
      heights.set(key, measured)
      changed = true
    }
  }
  if (changed) {
    const range = virtualRange()
    setSpacerHeight(virtualTopSpacer, range.top)
    setSpacerHeight(virtualBottomSpacer, range.total - range.bottom)
  }
}

function renderVirtualWindow(animateKeys = new Set<string>()): void {
  if (!listEl || !virtualItemsEl) return
  const items = renderedMessages()
  if (items.length === 0) {
    virtualItemsEl.replaceChildren()
    setSpacerHeight(virtualTopSpacer, 0)
    setSpacerHeight(virtualBottomSpacer, 0)
    updateEmptyState()
    updatePerfDebug()
    return
  }

  emptyEl?.remove()
  const activeKey =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<HTMLElement>('.lc-chat-message')?.dataset.key
      : undefined
  const range = virtualRange()
  const rows: HTMLElement[] = []
  for (let index = range.start; index < range.end; index++) {
    const message = items[index]
    const key = messageKey(message)
    const row = createMessageRow(message, animateKeys.has(key), index)
    row.dataset.key = key
    rows.push(row)
  }
  virtualItemsEl.replaceChildren(...rows)
  setSpacerHeight(virtualTopSpacer, range.top)
  setSpacerHeight(virtualBottomSpacer, range.total - range.bottom)
  if (activeKey) {
    for (const row of virtualItemsEl.querySelectorAll<HTMLElement>('.lc-chat-message')) {
      if (row.dataset.key === activeKey) {
        row.focus()
        break
      }
    }
  }
  measureRenderedRows()
  updateEmptyState()
  updatePerfDebug()
}

function scrollToVirtualIndex(index: number): void {
  const items = renderedMessages()
  if (!listEl || items.length === 0) return
  const clamped = Math.max(0, Math.min(items.length - 1, index))
  const top = virtualContentHeight(clamped)
  listEl.scrollTo({ top: Math.max(0, top - 10), behavior: 'auto' })
  renderVirtualWindow()
  virtualItemsEl?.querySelector<HTMLElement>(`.lc-chat-message[data-virtual-index="${clamped}"]`)?.focus()
}

function clearMessages(): void {
  messages.length = 0
  messageKeys.clear()
  messageByEventKey.clear()
  renderQueue.length = 0
  visibleMessages = []
  rowHeights.clear()
  unread = 0
  followMode = 'following'
  frozenSnapshot = null
  hasClearedMessages = true
  virtualItemsEl?.replaceChildren()
  setSpacerHeight(virtualTopSpacer, 0)
  setSpacerHeight(virtualBottomSpacer, 0)
  updateUnread()
  updateMatchCount()
  updateEmptyState()
}

function restoreFrozenScrollPosition(): void {
  if (!listEl || !frozenSnapshot) return
  const maxTop = Math.max(0, virtualContentHeight() - listEl.clientHeight)
  const top = Math.max(0, Math.min(maxTop, frozenSnapshot.scrollTop))
  if (Math.abs(top - listEl.scrollTop) > 0.5) listEl.scrollTop = top
  frozenSnapshot.scrollTop = top
}

function rerenderMessages(options: { refreshFrozenSnapshot?: boolean } = {}): void {
  if (!listEl || !virtualItemsEl) return
  pruneMessages()
  refreshVisibleMessages()
  if (!isFollowing()) {
    if (options.refreshFrozenSnapshot || !frozenSnapshot) syncFrozenSnapshotFromLive()
    restoreFrozenScrollPosition()
  }
  renderVirtualWindow()
  updateMatchCount()
  updateEmptyState()
  if (isFollowing()) scrollToBottom()
}

function requestChatFrame(): void {
  if (chatFrame !== null) return
  chatFrame = window.requestAnimationFrame(() => {
    chatFrame = null
    const shouldFlushRender = pendingRenderFlush
    const rerender = pendingRerender
    pendingRenderFlush = false
    pendingRerender = null

    if (shouldFlushRender) flushRenderQueue()
    if (rerender) runScheduledRerender(rerender)
  })
}

function runScheduledRerender(rerender: { token: number; refreshFrozenSnapshot: boolean }): void {
  if (!listEl || rerender.token !== rerenderToken) return
  refreshVisibleMessages()
  if (!isFollowing()) {
    if (rerender.refreshFrozenSnapshot || !frozenSnapshot) syncFrozenSnapshotFromLive()
    restoreFrozenScrollPosition()
  }
  renderVirtualWindow()
  updateMatchCount()
  updatePerfDebug()
  updateEmptyState()
  if (isFollowing()) scrollToBottom()
}

function scheduleRerenderMessages(options: { refreshFrozenSnapshot?: boolean } = {}): void {
  rerenderToken++
  const token = rerenderToken
  pendingRerender = {
    token,
    refreshFrozenSnapshot: Boolean(options.refreshFrozenSnapshot) || Boolean(pendingRerender?.refreshFrozenSnapshot),
  }
  requestChatFrame()
}

function flushRenderQueue(): void {
  if (!listEl || renderQueue.length === 0) return
  const batch = takeRenderBatch(renderQueue)
  lastBatchSize = batch.length
  const shouldStickToBottom = isFollowing() && isNearBottom()
  const animate = isFollowing() && shouldAnimateRenderBatch(batch.length)
  const animateKeys = new Set<string>()
  let matched = 0
  for (const event of batch) {
    if (!messageKeys.has(messageKey(event))) continue
    if (!messageMatchesSearch(event)) continue
    matched++
    if (animate) animateKeys.add(messageKey(event))
  }
  refreshVisibleMessages()
  if (isFollowing()) renderVirtualWindow(animateKeys)
  if (renderQueue.length > 0) {
    pendingRenderFlush = true
    requestChatFrame()
  }
  if (matched === 0) {
    updateMatchCount()
    updatePerfDebug()
    updateEmptyState()
    return
  }
  pruneMessages()
  if (!shouldStickToBottom) {
    if (isFollowing()) enterFrozenMode('frozenByScroll')
    unread += matched
    updateUnread()
  } else {
    scrollToBottom()
  }
  updateMatchCount()
  updatePerfDebug()
  updateEmptyState()
}

function scheduleRender(event: CustomChatEvent): void {
  renderQueue.push(event)
  trimRenderQueue(renderQueue)
  updatePerfDebug()
  pendingRenderFlush = true
  requestChatFrame()
}

async function sendFromComposer(): Promise<void> {
  if (!textarea || sending) return
  const text = textarea.value
  sending = true
  const sendBtn = root?.querySelector<HTMLButtonElement>('.lc-chat-send')
  if (sendBtn) sendBtn.disabled = true
  const sent = await sendManualDanmaku(text)
  if (sent) {
    textarea.value = ''
    fasongText.value = ''
    updateCount()
  }
  sending = false
  if (sendBtn) sendBtn.disabled = false
}

function updateCount(): void {
  if (countEl && textarea) countEl.textContent = String(textarea.value.length)
}

function syncComposerFromStore(): void {
  if (!textarea || textarea.value === fasongText.value) return
  textarea.value = fasongText.value
  updateCount()
}

function isNativeSendBox(el: HTMLElement): boolean {
  return (
    el.querySelector(
      'input[type="text"], textarea, input:not([type="submit"]):not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="range"]):not([type="number"]):not([type="button"]):not([type="image"]):not([type="reset"]):not([type="file"]):not([type="color"])'
    ) !== null
  )
}

function isNativeChatHistory(el: HTMLElement): boolean {
  return (
    el.classList.contains('chat-history-panel') ||
    el.classList.contains('chat-room') ||
    (typeof el.className === 'string' && el.className.includes('chat-history'))
  )
}

function applyHide(el: HTMLElement, shouldHide: boolean): void {
  if (shouldHide && !el.dataset.lcHidden) {
    el.dataset.lcHidden = 'true'
    el.style.display = 'none'
  } else if (!shouldHide && el.dataset.lcHidden) {
    delete el.dataset.lcHidden
    el.style.display = ''
  }
}

/**
 * hideSendBox: hide the native danmaku input (always true when Chatterbox is mounted,
 *              since Chatterbox provides its own send bar).
 * hideNative:  additionally hide the native chat history panel.
 *
 * The gift/reward bar is intentionally left untouched — it is not a send box and
 * not a chat history container.
 */
function hideSiblingNativeElements(hideSendBox: boolean, hideNative: boolean): void {
  const host = root?.parentElement
  if (!host) return

  for (const el of Array.from(host.children)) {
    if (!(el instanceof HTMLElement) || el.id === ROOT_ID) continue
    const isSendBox = isNativeSendBox(el)
    const isChatHistory = isNativeChatHistory(el)
    const shouldHide = (hideSendBox && isSendBox) || (hideNative && (isChatHistory || isSendBox))
    applyHide(el, shouldHide)
  }
}

function updateNativeVisibility(): void {
  const mounted = Boolean(root?.isConnected) && root?.querySelector('.lc-chat-composer') != null
  const nativeMounted = mounted && !rootUsesFallbackHost
  const shouldHideNative = nativeMounted && customChatHideNative.value
  document.documentElement.classList.toggle('lc-custom-chat-mounted', nativeMounted)
  document.documentElement.classList.toggle('lc-custom-chat-root-outside-history', nativeMounted && rootOutsideHistory)
  document.documentElement.classList.toggle('lc-custom-chat-hide-native', shouldHideNative)
  // Always hide native send box when mounted (Chatterbox has its own); hide
  // chat history only when the "隐藏原评论列表和原发送框" option is on.
  hideSiblingNativeElements(nativeMounted, shouldHideNative)
}

function appendDebugRow(parent: HTMLElement, key: string, value: string): void {
  const row = document.createElement('div')
  row.className = 'lc-chat-debug-row'
  const keyEl = document.createElement('span')
  keyEl.className = 'lc-chat-debug-key'
  setText(keyEl, key)
  const valueEl = document.createElement('span')
  valueEl.className = 'lc-chat-debug-value'
  setText(valueEl, value || '-')
  row.append(keyEl, valueEl)
  parent.append(row)
}

function showEventDebug(
  message: CustomChatEvent,
  row: HTMLElement,
  card: ReturnType<typeof cardType>,
  guard: string | null
): void {
  if (!root || !debugEl) return
  root.querySelectorAll('.lc-chat-message.lc-chat-selected').forEach(el => {
    if (el !== row) el.classList.remove('lc-chat-selected')
  })
  row.classList.add('lc-chat-selected')
  root.dataset.inspecting = 'true'
  debugEl.replaceChildren()

  const head = document.createElement('div')
  head.className = 'lc-chat-debug-head'
  const title = document.createElement('span')
  title.className = 'lc-chat-debug-title'
  setText(title, '事件调试')
  const close = makeButton('lc-chat-debug-close', '关闭', '关闭事件调试', () => {
    root?.removeAttribute('data-inspecting')
    row.classList.remove('lc-chat-selected')
    debugEl?.replaceChildren()
  })
  head.append(title, close)
  debugEl.append(head)
  appendDebugRow(debugEl, 'id', message.id)
  appendDebugRow(debugEl, 'data-kind', message.kind)
  appendDebugRow(debugEl, 'data-card', card ?? '')
  appendDebugRow(debugEl, 'data-guard', guard ?? '')
  appendDebugRow(debugEl, 'priority', customChatPriority(message))
  appendDebugRow(debugEl, 'source', message.source)
  appendDebugRow(debugEl, 'uid', message.uid ?? '')
  appendDebugRow(debugEl, 'raw cmd', message.rawCmd ?? '')
  appendDebugRow(debugEl, 'fields', (message.fields ?? []).map(field => `${field.key}=${field.value}`).join(' | '))
}

function createRoot(): HTMLElement {
  const panel = document.createElement('section')
  panel.id = ROOT_ID
  panel.dataset.theme = customChatTheme.value
  panel.dataset.debug = customChatPerfDebug.value ? 'true' : 'false'

  const toolbar = document.createElement('div')
  toolbar.className = 'lc-chat-toolbar'

  // 2026-05-18 重构(Jobs 反馈):原本 🔍 按钮 + ⋯ 按钮**功能重叠** ——两个都打开
  // 同一个 menu drawer,而且 🔍 用 `classList.add` 只能开不能关。
  // 解药:删 🔍 按钮,把 search input **直接放进 toolbar 始终可见**,代替原
  // "直播聊天" 居中标题。⋯ 现在只管 filters/clear/status drawer,语义彻底分开。
  // search input 作为 toolbar 的第一公民,用户随时打字就行,不需要先点按钮。
  // "/" 快捷键(toggle-button.tsx 里注册)继续聚焦 search input 兼容老习惯。
  const menuBtn = makeButton('lc-chat-icon', '…', '过滤 / 暂停 / 清屏 / 状态', () => {
    panel.classList.toggle('lc-chat-menu-open')
  })
  menuBtn.setAttribute('aria-label', '聊天工具')

  const menu = document.createElement('div')
  menu.className = 'lc-chat-menu'

  pauseBtn = makeButton('lc-chat-pill', '暂停', '暂停自动跟随', () => {
    if (isFollowing()) {
      enterFrozenMode('frozenByButton')
      return
    }
    // 'auto' (instant) — not 'smooth'. On a busy room the smooth animation
    // gets cancelled by the constant spacer / virtual-items DOM mutations
    // from incoming messages, so the smooth scroll never actually moves
    // scrollTop. Verified in-page on live.bilibili.com/21452505.
    resumeFollowing('auto')
  })
  unreadBtn = makeButton('lc-chat-pill lc-chat-unread', '', '恢复自动跟随并跳到底部', () => {
    resumeFollowing('auto')
  })
  unreadBtn.style.display = 'none'
  matchCountEl = document.createElement('span')
  matchCountEl.className = 'lc-chat-hint'
  matchCountEl.style.display = 'none'
  wsStatusEl = document.createElement('span')
  wsStatusEl.className = 'lc-chat-ws-status'
  updateWsStatus(currentWsStatus)
  perfEl = document.createElement('div')
  perfEl.className = 'lc-chat-perf'
  updatePerfDebug()

  searchInput = document.createElement('input')
  searchInput.type = 'search'
  searchInput.className = 'lc-chat-search'
  // toolbar 里现在是 search input 当家,placeholder 写短一点免得截断 ——
  // 高级搜索语法(user:名 / kind:gift / -词)写在 README 跟提示 title 里就行。
  searchInput.placeholder = '搜索消息'
  searchInput.title = '支持 user:名 / kind:gift / -词;按 / 也能聚焦'
  searchInput.setAttribute('aria-label', '搜索直播聊天消息')
  searchInput.value = searchQuery
  // Debounce keystrokes — every input event would otherwise re-filter all 220
  // messages and rebuild the visible list. ~120ms is the sweet spot between
  // perceived snappiness and not running the filter pass per character.
  let searchInputTimer: ReturnType<typeof setTimeout> | null = null
  addRootEventListener(searchInput, 'input', () => {
    if (searchInputTimer !== null) clearTimeout(searchInputTimer)
    searchInputTimer = setTimeout(() => {
      searchInputTimer = null
      searchQuery = searchInput?.value ?? ''
      unread = 0
      scheduleRerenderMessages({ refreshFrozenSnapshot: true })
      updateUnread()
    }, 120)
  })

  const clearBtn = makeButton('lc-chat-pill', '清屏', '清空自定义评论区', clearMessages)

  const filterbar = document.createElement('div')
  filterbar.className = 'lc-chat-filterbar'
  const filters: Array<[CustomChatKind, string, typeof customChatShowDanmaku]> = [
    ['danmaku', '弹幕', customChatShowDanmaku],
    ['gift', '礼物', customChatShowGift],
    ['superchat', 'SC', customChatShowSuperchat],
    ['enter', '进场', customChatShowEnter],
    ['notice', '通知', customChatShowNotice],
  ]
  for (const [, label, signal] of filters) {
    const btn = makeButton('lc-chat-filter', label, `显示/隐藏${label}`, () => {
      signal.value = !signal.value
      btn.setAttribute('aria-pressed', signal.value ? 'true' : 'false')
      scheduleRerenderMessages({ refreshFrozenSnapshot: true })
    })
    btn.setAttribute('aria-pressed', signal.value ? 'true' : 'false')
    filterbar.append(btn)
  }

  // searchRow 删了 ——search input 现在直接住在 toolbar(见下方 toolbar.append),
  // matchCountEl 跟着 searchInput 也搬到 toolbar 右边,菜单 drawer 完全聚焦 filters
  // / 控制 / 状态 三件事,跟 search 语义彻底拆开(Jobs 2026-05-18 反馈)。
  const controlRow = document.createElement('div')
  controlRow.className = 'lc-chat-menu-row'
  controlRow.append(pauseBtn, unreadBtn, clearBtn)

  const statusRow = document.createElement('div')
  statusRow.className = 'lc-chat-menu-row'
  const statusLabel = document.createElement('span')
  statusLabel.className = 'lc-chat-menu-label'
  statusLabel.textContent = '状态'
  statusRow.append(statusLabel, wsStatusEl)

  const filterLabel = document.createElement('span')
  filterLabel.className = 'lc-chat-menu-label'
  filterLabel.textContent = '显示'
  const filterRow = document.createElement('div')
  filterRow.className = 'lc-chat-menu-row'
  filterRow.append(filterLabel, filterbar)

  menu.append(controlRow, filterRow, statusRow, perfEl)
  // toolbar 布局:[search input (flex 1)] [match count] [⋯]
  // search input 永远可见,不需要先点 🔍 切换 ——降低发现门槛 + 消除按钮重复。
  toolbar.append(searchInput, matchCountEl, menuBtn)

  debugEl = document.createElement('div')
  debugEl.className = 'lc-chat-event-debug'

  listEl = document.createElement('div')
  listEl.className = 'lc-chat-list'
  listEl.tabIndex = 0
  listEl.setAttribute('role', 'log')
  listEl.setAttribute('aria-live', 'polite')
  listEl.setAttribute('aria-label', '直播聊天消息')
  virtualTopSpacer = document.createElement('div')
  virtualTopSpacer.className = 'lc-chat-virtual-spacer'
  virtualItemsEl = document.createElement('div')
  virtualItemsEl.className = 'lc-chat-virtual-items'
  virtualBottomSpacer = document.createElement('div')
  virtualBottomSpacer.className = 'lc-chat-virtual-spacer'
  emptyEl = document.createElement('div')
  emptyEl.className = 'lc-chat-empty'
  listEl.append(virtualTopSpacer, virtualItemsEl, virtualBottomSpacer)
  addRootEventListener(listEl, 'wheel', scrollListByWheel, { passive: false })
  addRootEventListener(
    listEl,
    'scroll',
    () => {
      renderVirtualWindow()
      syncAutoFollowFromScroll()
    },
    { passive: true }
  )
  addRootEventListener(listEl, 'keydown', e => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
    const items = renderedMessages()
    if (items.length === 0) return
    e.preventDefault()
    const active =
      document.activeElement instanceof HTMLElement ? document.activeElement.closest('.lc-chat-message') : null
    const index = active instanceof HTMLElement ? Number(active.dataset.virtualIndex) : -1
    const nextIndex =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : Math.max(0, Math.min(items.length - 1, index + (e.key === 'ArrowUp' ? -1 : 1)))
    scrollToVirtualIndex(nextIndex)
  })

  const composer = document.createElement('div')
  composer.className = 'lc-chat-composer'

  const inputWrap = document.createElement('div')
  inputWrap.className = 'lc-chat-input-wrap'

  textarea = document.createElement('textarea')
  textarea.value = fasongText.value
  textarea.placeholder = '输入弹幕... Enter 发送，Shift+Enter 换行'
  addRootEventListener(textarea, 'input', () => {
    fasongText.value = textarea?.value ?? ''
    updateCount()
  })
  addRootEventListener(textarea, 'keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void sendFromComposer()
    }
  })

  countEl = document.createElement('span')
  countEl.className = 'lc-chat-count'
  countEl.textContent = '0'

  inputWrap.append(textarea, countEl)

  const sendRow = document.createElement('div')
  sendRow.className = 'lc-chat-send-row'
  const actionsHost = document.createElement('div')
  actionsHost.className = 'lc-chat-actions-host'
  const sendBtn = makeButton('lc-chat-send', '发送', '发送弹幕', () => void sendFromComposer())
  const hint = document.createElement('span')
  hint.className = 'lc-chat-hint'
  hint.textContent = '偷 / +1 / 复制，设置可贴 CSS'
  sendRow.append(actionsHost, sendBtn, hint)
  // Tear down the previous Preact island before mounting a new one. mount()
  // and mountFallback() recreate the panel via createRoot(), so without this
  // teardown the old EmotePicker's document listeners (resize/mousedown/
  // keydown) would leak across remounts.
  disposeActionsIsland?.()
  disposeActionsIsland = mountSendActionsIsland(actionsHost, msg => void sendManualDanmaku(msg))

  jumpBottomBtn = makeButton('lc-chat-jump-bottom', '回到最新 ↓', '回到底部并恢复自动跟随', () => {
    resumeFollowing('auto')
  })
  jumpBottomBtn.style.display = 'none'
  composer.append(jumpBottomBtn, inputWrap, sendRow)

  // SC pin strip sits between toolbar and the menu / debug / list rows. When
  // there are no active SCs the strip carries `.lc-chat-sc-pinstrip-empty`
  // which collapses it to `display:none` (zero grid row) — so empty chats
  // pay no layout cost. See custom-chat-sc-pinstrip.ts for the rationale
  // (horizontal time-multiplex, reader-focused durations, 3 input modes).
  const pinStrip = createScPinStrip()
  disposePinStrip = pinStrip.dispose

  panel.append(toolbar, pinStrip.element, menu, debugEl, listEl, composer)
  updateUnread()
  updateEmptyState()
  return panel
}

function ensureStyles(): void {
  const styles = ensureCustomChatStyles({
    styleId: STYLE_ID,
    userStyleId: USER_STYLE_ID,
    customCss: customChatCss.value,
    styleEl,
    userStyleEl,
  })
  styleEl = styles.styleEl
  userStyleEl = styles.userStyleEl
}

/** @internal Exported for tests; not part of the public API. */
export function bootstrapPrewarmFromNative(container: HTMLElement): void {
  // One-shot scrape on chat mount. We prewarm BOTH URL forms because:
  //   * `nativeAvatar(node)` returns Bilibili's own rendered URL (typically
  //     `i0.hdslb.com/bfs/face/...`), which is what DOM-source events use.
  //   * `resolveAvatarUrl(uid)` returns the proxied form
  //     (`workers.vrp.moe/bilibili/avatar/{uid}?size=96`) — what WS-source
  //     events and the createAvatar fallback use.
  // Without prewarming both, a chat opened mid-stream would see WS events
  // arrive with the proxy URL and miss the cache anyway. Same UID / two
  // prewarms / two HTTP cache slots — the cap is 2000 so cost is negligible.
  const nodes = container.querySelectorAll<HTMLElement>(NATIVE_EVENT_SELECTOR)
  const limit = Math.min(nodes.length, MAX_NATIVE_INITIAL_SCAN)
  for (let i = 0; i < limit; i++) {
    const node = nodes[i]
    const nativeUrl = nativeAvatar(node)
    if (nativeUrl) prewarmAvatar(nativeUrl)
    const canonical = resolveAvatarUrl(nativeUid(node))
    if (canonical) prewarmAvatar(canonical)
  }
}

function mount(container: HTMLElement): void {
  ensureStyles()
  abortRootEventListeners()
  nativeEventObserver?.disconnect()
  nativeEventObserverContainer = null
  nativeEventObserverSuspended = false
  root?.remove()
  rootUsesFallbackHost = false
  fallbackHost?.remove()
  fallbackHost = null
  const historyPanel = container.closest<HTMLElement>('.chat-history-panel')
  const host = historyPanel?.parentElement ?? container.parentElement
  if (!host) return
  root = createRoot()
  rootOutsideHistory = historyPanel !== null && host !== historyPanel
  root.dataset.theme = customChatTheme.value
  host.appendChild(root)
  updateNativeVisibility()
  observeNativeEvents(container)
  bootstrapPrewarmFromNative(container)
  rerenderMessages()
}

function ensureFallbackHost(): HTMLElement {
  if (fallbackHost?.isConnected) return fallbackHost
  const host = document.createElement('div')
  host.id = 'laplace-custom-chat-fallback-host'
  host.style.position = 'fixed'
  host.style.right = '12px'
  host.style.bottom = '52px'
  host.style.zIndex = '2147483646'
  host.style.width = 'min(360px, calc(100vw - 24px))'
  host.style.height = 'min(62vh, 560px)'
  host.style.minHeight = '340px'
  host.style.overflow = 'hidden'
  host.style.borderRadius = '18px'
  host.style.border = '1px solid rgba(255, 255, 255, .08)'
  host.style.boxShadow = '0 20px 48px rgba(0, 0, 0, .32)'
  host.style.backdropFilter = 'blur(18px)'
  host.style.webkitBackdropFilter = 'blur(18px)'
  document.body.appendChild(host)
  fallbackHost = host
  return host
}

function mountFallback(): void {
  if (root?.isConnected && rootUsesFallbackHost) return
  ensureStyles()
  abortRootEventListeners()
  nativeEventObserver?.disconnect()
  nativeEventObserver = null
  nativeEventObserverContainer = null
  nativeEventObserverSuspended = false
  pendingNativeNodes.clear()
  root?.remove()
  const host = ensureFallbackHost()
  root = createRoot()
  rootOutsideHistory = false
  rootUsesFallbackHost = true
  root.dataset.theme = customChatTheme.value
  host.replaceChildren(root)
  updateNativeVisibility()
  rerenderMessages()
}

function scheduleFallbackMount(): void {
  if (fallbackMountTimer !== null) return
  fallbackMountTimer = setTimeout(() => {
    fallbackMountTimer = null
    if (root?.isConnected) return
    mountFallback()
  }, 2500)
}

function observeNativeEvents(container: HTMLElement): void {
  nativeEventObserver?.disconnect()
  nativeEventObserverContainer = null
  nativeEventObserverSuspended = false
  pendingNativeNodes.clear()
  nativeHealthSamples.length = 0
  nativeDomWarning = false
  updateWsStatus(currentWsStatus)
  if (nativeScanFrame !== null) {
    window.cancelAnimationFrame(nativeScanFrame)
    nativeScanFrame = null
  }
  if (nativeScanDebounceTimer !== null) {
    clearTimeout(nativeScanDebounceTimer)
    nativeScanDebounceTimer = null
  }
  const nativeCtx: NativeParseContext = { rootId: ROOT_ID, nextId: () => `native-${++messageSeq}` }
  const scan = (node: HTMLElement): void => {
    if (seenNativeNodes.has(node)) return
    seenNativeNodes.add(node)
    const event = parseNativeEvent(node, nativeCtx)
    let parsed = false
    if (event) emitCustomChatEvent(event)
    if (event) parsed = true
    for (const child of node.querySelectorAll<HTMLElement>(NATIVE_EVENT_SELECTOR)) {
      if (seenNativeNodes.has(child) || child.classList.contains('danmaku-item')) continue
      seenNativeNodes.add(child)
      const childEvent = parseNativeEvent(child, nativeCtx)
      if (childEvent) emitCustomChatEvent(childEvent)
      if (childEvent) parsed = true
    }
    recordNativeHealth(parsed)
  }
  const flushScan = (): void => {
    nativeScanFrame = null
    let count = 0
    for (const node of pendingNativeNodes) {
      pendingNativeNodes.delete(node)
      if (node.isConnected) scan(node)
      count++
      if (count >= MAX_NATIVE_SCAN_BATCH) break
    }
    if (pendingNativeNodes.size > 0) nativeScanFrame = window.requestAnimationFrame(flushScan)
  }
  const scheduleNativeScan = (): void => {
    if (nativeScanFrame !== null || nativeScanDebounceTimer !== null) return
    nativeScanDebounceTimer = setTimeout(() => {
      nativeScanDebounceTimer = null
      if (nativeScanFrame === null) nativeScanFrame = window.requestAnimationFrame(flushScan)
    }, NATIVE_SCAN_DEBOUNCE_MS)
  }
  const queueScan = (node: HTMLElement): void => {
    if (!shouldScanNativeEventNode(node, ROOT_ID)) return
    pendingNativeNodes.add(node)
    scheduleNativeScan()
  }
  const existing = Array.from(container.querySelectorAll<HTMLElement>(NATIVE_EVENT_SELECTOR))
    .filter(node => !node.classList.contains('danmaku-item'))
    .slice(-MAX_NATIVE_INITIAL_SCAN)
  for (const node of existing) queueScan(node)
  nativeEventObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) queueScan(node)
      }
    }
  })
  nativeEventObserverContainer = container
  // Don't bind the observer if WS is already healthy — DOM is fallback only.
  if (currentWsStatus === 'live') {
    nativeEventObserverSuspended = true
  } else {
    nativeEventObserverSuspended = false
    nativeEventObserver.observe(container, { childList: true, subtree: true })
  }
}

function syncNativeObserverWithWsStatus(): void {
  if (!nativeEventObserver || !nativeEventObserverContainer) return
  const shouldSuspend = currentWsStatus === 'live'
  if (shouldSuspend && !nativeEventObserverSuspended) {
    nativeEventObserver.disconnect()
    nativeEventObserverSuspended = true
  } else if (!shouldSuspend && nativeEventObserverSuspended) {
    nativeEventObserver.observe(nativeEventObserverContainer, { childList: true, subtree: true })
    nativeEventObserverSuspended = false
  }
}

function addDomMessage(ev: DanmakuEvent): void {
  const text = ev.text.trim()
  if (!text) return
  const uid = ev.uid
  if (hasRecentWsDanmaku(text, uid)) return
  emitCustomChatEvent({
    id: `dom-${++messageSeq}`,
    kind: 'danmaku',
    text,
    sendText: eventToSendableMessage(ev),
    uname: ev.uname || '匿名',
    uid,
    time: chatEventTime(),
    isReply: ev.isReply,
    source: 'dom',
    badges: ev.badges,
    avatarUrl: ev.avatarUrl || resolveAvatarUrl(uid),
  })
}

function addEvent(event: CustomChatEvent): void {
  if (!isReliableEvent(event)) return

  // 去重折叠：跨用户文本相同的 danmaku 合并到一张卡片上，递增 ×N 徽章。
  // 9 秒窗口外或卡片已被 prune，则走正常入队流程，重新成卡。
  if (customChatFoldMode.value && event.kind === 'danmaku') {
    const ck = cardKey(event)
    const now = Date.now()
    if (recentCardKeys.size > RECENT_EVENT_KEYS_GC_THRESHOLD) gcRecentCardKeys(now)
    const lastSeen = recentCardKeys.get(ck)
    const existing = messageByCardKey.get(ck)
    if (existing && lastSeen !== undefined && now - lastSeen <= 9000) {
      const idx = messages.indexOf(existing)
      if (idx >= 0) {
        // 折叠卡上 +1 应该发**最新**的那一条原文（独轮车的不同长度版本——666 vs
        // 6666——按 wheelFoldKey 都进同一张卡，但用户期望 +1 跟最新一条同款）。
        // 把 sendText / text / time 也滚到最新事件，meta（uid、uname）保留首条
        // 不变，避免 UI 闪烁。
        const next: CustomChatEvent = {
          ...existing,
          text: event.text,
          sendText: event.sendText ?? existing.sendText,
          time: event.time,
          mergeCount: (existing.mergeCount ?? 1) + 1,
        }
        replaceMessage(idx, next)
        messageByCardKey.set(ck, next)
        recentCardKeys.set(ck, now)
        // 同时刷新 recentEventKeys，避免旧的 9 秒窗口在折叠模式关闭后立刻把
        // 同一文本的下一条扔掉。
        recentEventKeys.set(eventKey(next), now)
        return
      }
      // 索引不在数组里（理论不会发生），清理悬挂条目走兜底。
      messageByCardKey.delete(ck)
    }
    // 第一次见这条卡片，落到下面的正常入队流程；登记后由 push 路径接管。
  }

  const duplicateIndex = messageIndexByEvent(event)
  if (duplicateIndex >= 0) {
    const merged = mergeDuplicateEvent(messages[duplicateIndex], event)
    if (merged) replaceMessage(duplicateIndex, merged)
    return
  }
  const key = messageKey(event)
  if (messageKeys.has(key)) return
  if (!rememberEvent(event)) return
  hasClearedMessages = false
  recordEventStats(event)
  const ek = eventKey(event)
  eventKeyByMessage.set(event, ek)
  messages.push(event)
  messageKeys.add(key)
  messageByEventKey.set(ek, event)
  if (customChatFoldMode.value && event.kind === 'danmaku') {
    const ck = cardKey(event)
    messageByCardKey.set(ck, event)
    recentCardKeys.set(ck, Date.now())
  }
  pruneMessages()
  scheduleRender(event)
}

/** @internal Exported for tests; not part of the public API. */
export function ensureAvatarPreconnect(): void {
  const head = document.head
  if (!head) return
  for (const host of ['https://workers.vrp.moe', 'https://i0.hdslb.com']) {
    const id = `lc-avatar-preconnect-${host.replace(/[^a-z0-9]/gi, '-')}`
    if (document.getElementById(id)) continue
    const link = document.createElement('link')
    link.id = id
    link.rel = 'preconnect'
    link.href = host
    head.append(link)
  }
}

/** Bilibili's canonical "no avatar" placeholder, used as the cache-miss
 *  state for `.lc-chat-avatar-fallback` (see custom-chat-style.ts). Kept
 *  here so the prewarm and the CSS reference the same URL. */
const BILIBILI_NOFACE_URL = 'https://i0.hdslb.com/bfs/face/member/noface.jpg'

export function startCustomChatDom(): void {
  if (unsubscribeDom) return

  ensureStyles()
  ensureAvatarPreconnect()
  // Warm the noface placeholder once on chat start so the very first
  // cache-miss avatar already has the fallback bg image in HTTP cache.
  prewarmAvatar(BILIBILI_NOFACE_URL)
  scheduleFallbackMount()
  void refreshCurrentRoomEmoticons()
  disposeSettings = signalEffect(() => {
    if (root) root.dataset.theme = customChatTheme.value
    if (root) root.dataset.debug = customChatPerfDebug.value ? 'true' : 'false'
    updateNativeVisibility()
    updatePerfDebug()
    ensureStyles()
  })
  disposeComposer = signalEffect(syncComposerFromStore)

  unsubscribeEvents = subscribeCustomChatEvents(addEvent)
  unsubscribeWsStatus = subscribeCustomChatWsStatus(updateWsStatus)
  unsubscribeDom = subscribeDanmaku({
    onAttach: mount,
    onMessage: addDomMessage,
    emitExisting: true,
  })
}

export function stopCustomChatDom(): void {
  emoticonRefreshToken += 1
  if (fallbackMountTimer) {
    clearTimeout(fallbackMountTimer)
    fallbackMountTimer = null
  }
  if (unsubscribeDom) {
    unsubscribeDom()
    unsubscribeDom = null
  }
  if (unsubscribeEvents) {
    unsubscribeEvents()
    unsubscribeEvents = null
  }
  if (unsubscribeWsStatus) {
    unsubscribeWsStatus()
    unsubscribeWsStatus = null
  }
  if (disposeSettings) {
    disposeSettings()
    disposeSettings = null
  }
  if (disposeComposer) {
    disposeComposer()
    disposeComposer = null
  }
  if (disposeActionsIsland) {
    disposeActionsIsland()
    disposeActionsIsland = null
  }
  if (disposePinStrip) {
    disposePinStrip()
    disposePinStrip = null
  }
  abortRootEventListeners()
  nativeEventObserver?.disconnect()
  nativeEventObserver = null
  nativeEventObserverContainer = null
  nativeEventObserverSuspended = false
  pendingNativeNodes.clear()
  if (nativeScanDebounceTimer !== null) {
    clearTimeout(nativeScanDebounceTimer)
    nativeScanDebounceTimer = null
  }
  if (nativeScanFrame !== null) {
    window.cancelAnimationFrame(nativeScanFrame)
    nativeScanFrame = null
  }
  hideSiblingNativeElements(false, false)
  document.documentElement.classList.remove('lc-custom-chat-hide-native')
  document.documentElement.classList.remove('lc-custom-chat-mounted')
  document.documentElement.classList.remove('lc-custom-chat-root-outside-history')
  root?.remove()
  root = null
  rootOutsideHistory = false
  rootUsesFallbackHost = false
  fallbackHost?.remove()
  fallbackHost = null
  styleEl?.remove()
  styleEl = null
  userStyleEl?.remove()
  userStyleEl = null
  listEl = null
  virtualTopSpacer = null
  virtualItemsEl = null
  virtualBottomSpacer = null
  pauseBtn = null
  unreadBtn = null
  jumpBottomBtn = null
  textarea = null
  countEl = null
  searchInput = null
  matchCountEl = null
  wsStatusEl = null
  emptyEl = null
  perfEl = null
  debugEl = null
  messages.length = 0
  messageKeys.clear()
  messageByEventKey.clear()
  renderQueue.length = 0
  visibleMessages = []
  rowHeights.clear()
  eventTicks.length = 0
  nativeHealthSamples.length = 0
  rerenderToken++
  sourceCounts.dom = 0
  sourceCounts.ws = 0
  sourceCounts.local = 0
  lastBatchSize = 0
  if (chatFrame !== null) {
    window.cancelAnimationFrame(chatFrame)
    chatFrame = null
  }
  pendingRenderFlush = false
  pendingRerender = null
  unread = 0
  followMode = 'following'
  frozenSnapshot = null
  sending = false
  searchQuery = ''
  hasClearedMessages = false
  currentWsStatus = 'off'
  nativeDomWarning = false
  recentEventKeys.clear()
}
