import { Window } from 'happy-dom'

const happyWindow = new Window()
;(happyWindow as unknown as { SyntaxError: SyntaxErrorConstructor }).SyntaxError = SyntaxError

Object.assign(globalThis, {
  document: happyWindow.document,
  Event: happyWindow.Event,
  HTMLElement: happyWindow.HTMLElement,
  HTMLButtonElement: happyWindow.HTMLButtonElement,
  HTMLImageElement: happyWindow.HTMLImageElement,
  HTMLInputElement: happyWindow.HTMLInputElement,
  HTMLTextAreaElement: happyWindow.HTMLTextAreaElement,
  KeyboardEvent: happyWindow.KeyboardEvent,
  MouseEvent: happyWindow.MouseEvent,
  MutationObserver: happyWindow.MutationObserver,
  window: happyWindow,
})

let rafSeq = 0
const rafTimers = new Map<number, ReturnType<typeof setTimeout>>()
happyWindow.requestAnimationFrame = (callback: FrameRequestCallback): number => {
  const id = ++rafSeq
  const timer = setTimeout(() => {
    rafTimers.delete(id)
    callback(Date.now())
  }, 0)
  rafTimers.set(id, timer)
  return id
}
happyWindow.cancelAnimationFrame = (id: number): void => {
  const timer = rafTimers.get(id)
  if (timer) clearTimeout(timer)
  rafTimers.delete(id)
}

if (!('scrollTo' in happyWindow.HTMLElement.prototype)) {
  Object.defineProperty(happyWindow.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, opts: ScrollToOptions | number) {
      this.scrollTop = typeof opts === 'number' ? opts : (opts.top ?? this.scrollTop)
    },
  })
}

class RecordingImage {
  src = ''
  decoding = ''
  referrerPolicy = ''

  decode(): Promise<void> {
    return Promise.resolve()
  }
}

;(globalThis as { Image: unknown }).Image = RecordingImage

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import type { CustomChatEvent } from '../src/lib/custom-chat-events'
import type { DanmakuSubscription } from '../src/lib/danmaku-stream'

mock.module('$', () => ({
  GM_addStyle: () => {},
  GM_deleteValue: () => {},
  GM_getValue: <T>(_key: string, defaultValue: T): T => defaultValue,
  GM_info: { script: { version: 'test' } },
  GM_setValue: () => {},
  GM_xmlhttpRequest: () => {},
  unsafeWindow: globalThis,
}))

let activeDanmakuSubscription: DanmakuSubscription | null = null
let nativeContainer: HTMLElement | null = null

mock.module('../src/lib/danmaku-stream', () => ({
  subscribeDanmaku: (subscription: DanmakuSubscription) => {
    activeDanmakuSubscription = subscription
    nativeContainer = document.createElement('div')
    nativeContainer.className = 'chat-items'
    const historyPanel = document.createElement('div')
    historyPanel.className = 'chat-history-panel'
    historyPanel.append(nativeContainer)
    const sendBox = document.createElement('div')
    sendBox.className = 'chat-control-panel-vm'
    sendBox.append(document.createElement('textarea'))
    const host = document.createElement('div')
    host.id = 'native-chat-host'
    host.append(historyPanel, sendBox)
    document.body.append(host)
    subscription.onAttach?.(nativeContainer)
    return () => {
      activeDanmakuSubscription = null
    }
  },
}))

mock.module('../src/lib/api', () => ({
  ensureRoomId: async () => 1000,
  fetchEmoticons: async () => {},
}))

const sentMessages: string[] = []
const copiedMessages: string[] = []
const stolenMessages: string[] = []
const repeatedMessages: Array<{ text: string; confirm: boolean; anchor?: { x: number; y: number } }> = []
let sendManualResult = true

mock.module('../src/lib/danmaku-actions', () => ({
  copyText: async (text: string) => {
    copiedMessages.push(text)
  },
  repeatDanmaku: async (text: string, opts: { confirm: boolean; anchor?: { x: number; y: number } }) => {
    repeatedMessages.push({ text, confirm: opts.confirm, anchor: opts.anchor })
  },
  sendManualDanmaku: async (text: string) => {
    sentMessages.push(text)
    return sendManualResult
  },
  stealDanmaku: async (text: string) => {
    stolenMessages.push(text)
  },
}))

let actionsIslandDisposes = 0
mock.module('../src/lib/emote-picker-mount', () => ({
  mountSendActionsIsland: (host: HTMLElement, onSend: (text: string) => void) => {
    const marker = document.createElement('button')
    marker.className = 'mock-actions-island'
    marker.textContent = '表情'
    marker.addEventListener('click', () => onSend('[doge]'))
    host.append(marker)
    return () => {
      actionsIslandDisposes++
      marker.remove()
    }
  },
}))

mock.module('../src/lib/live-ws-source', () => ({
  hasRecentWsDanmaku: () => false,
}))

const { emitCustomChatEvent, emitCustomChatWsStatus, clearRecentCustomChatDanmakuHistory } = await import(
  '../src/lib/custom-chat-events'
)
const { startCustomChatDom, stopCustomChatDom } = await import('../src/lib/custom-chat-dom')
const {
  customChatHideNative,
  customChatPerfDebug,
  customChatShowGift,
  customChatTheme,
  danmakuDirectConfirm,
  fasongText,
} = await import('../src/lib/store')

function baseEvent(overrides: Partial<CustomChatEvent> = {}): CustomChatEvent {
  return {
    id: 'evt-1',
    kind: 'danmaku',
    text: '普通弹幕',
    sendText: '普通弹幕',
    uname: 'Alice',
    uid: '42',
    time: '19:30',
    isReply: false,
    source: 'ws',
    badges: [],
    ...overrides,
  }
}

async function flushDom(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function waitForSearchDebounce(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 150))
  await flushDom()
}

function root(): HTMLElement {
  const el = document.getElementById('laplace-custom-chat')
  if (!el) throw new Error('custom chat root is not mounted')
  return el
}

function rows(): HTMLElement[] {
  return Array.from(root().querySelectorAll<HTMLElement>('.lc-chat-message'))
}

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  document.documentElement.className = ''
  nativeContainer = null
  activeDanmakuSubscription = null
  sentMessages.length = 0
  copiedMessages.length = 0
  stolenMessages.length = 0
  repeatedMessages.length = 0
  actionsIslandDisposes = 0
  sendManualResult = true
  clearRecentCustomChatDanmakuHistory()
  customChatHideNative.value = false
  customChatPerfDebug.value = false
  customChatShowGift.value = true
  customChatTheme.value = 'light'
  danmakuDirectConfirm.value = true
  fasongText.value = ''
})

afterEach(() => {
  stopCustomChatDom()
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  document.documentElement.className = ''
})

describe('custom chat DOM lifecycle and rendering', () => {
  test('startCustomChatDom mounts beside the native panel, wires status, hides only the native send box, and stop cleans up', async () => {
    startCustomChatDom()
    await flushDom()

    const panel = root()
    const host = document.getElementById('native-chat-host')
    const historyPanel = host?.querySelector<HTMLElement>('.chat-history-panel')
    const sendBox = host?.querySelector<HTMLElement>('.chat-control-panel-vm')

    expect(panel.dataset.theme).toBe('light')
    // toolbar 重构后(Jobs 2026-05-18):.lc-chat-title 已删除,search input 常驻
    // toolbar 占据原标题位置。验证 search input 存在且 placeholder 正确。
    const searchInput = panel.querySelector<HTMLInputElement>('.lc-chat-toolbar .lc-chat-search')
    expect(searchInput?.placeholder).toBe('搜索消息')
    expect(panel.querySelector('.lc-chat-empty')?.textContent).toBe('还没有收到消息')
    expect(document.documentElement.classList.contains('lc-custom-chat-mounted')).toBe(true)
    expect(sendBox?.style.display).toBe('none')
    expect(historyPanel?.style.display).toBe('')

    emitCustomChatWsStatus('live')
    await flushDom()
    const status = panel.querySelector<HTMLElement>('.lc-chat-ws-status')
    expect(status?.dataset.status).toBe('live')
    expect(status?.textContent).toBe('实时事件源正常')

    stopCustomChatDom()

    expect(document.getElementById('laplace-custom-chat')).toBeNull()
    expect(sendBox?.style.display).toBe('')
    expect(document.documentElement.classList.contains('lc-custom-chat-mounted')).toBe(false)
    expect(actionsIslandDisposes).toBe(1)
  })

  test('renders danmaku rows with reply marker, normalized badges, and message action buttons', async () => {
    startCustomChatDom()

    emitCustomChatEvent(
      baseEvent({
        id: 'dm-1',
        text: '你好呀',
        sendText: '@Bob 你好呀',
        uname: '牌子 21 Alice',
        isReply: true,
        badges: ['牌子 21', 'UL 33', 'Alice'],
      })
    )
    await flushDom()

    const [row] = rows()
    expect(row.dataset.kind).toBe('danmaku')
    expect(row.dataset.source).toBe('ws')
    expect(row.dataset.user).toBe('Alice')
    expect(row.querySelector('.lc-chat-reply')?.textContent).toBe('回复')
    expect(row.querySelector('.lc-chat-text')?.textContent).toContain('你好呀')
    expect(Array.from(row.querySelectorAll('.lc-chat-medal')).map(el => el.textContent)).toEqual(['牌子 21', 'LV33'])

    row.querySelectorAll<HTMLButtonElement>('.lc-chat-action')[0]?.click()
    row
      .querySelectorAll<HTMLButtonElement>('.lc-chat-action')[1]
      ?.dispatchEvent(new MouseEvent('click', { clientX: 12, clientY: 34 }))
    row.querySelectorAll<HTMLButtonElement>('.lc-chat-action')[2]?.click()
    await flushDom()

    expect(stolenMessages).toEqual(['@Bob 你好呀'])
    expect(repeatedMessages).toEqual([{ text: '@Bob 你好呀', confirm: true, anchor: { x: 12, y: 34 } }])
    expect(copiedMessages).toEqual(['@Bob 你好呀'])
  })

  test('dedupes repeated message IDs while allowing the same text from a different UID', async () => {
    startCustomChatDom()

    emitCustomChatEvent(
      baseEvent({
        id: 'ws-1',
        text: '同一条',
        uname: 'Alice',
        uid: '42',
        source: 'ws',
        badges: ['UL 2'],
      })
    )
    emitCustomChatEvent(
      baseEvent({
        id: 'ws-1',
        text: '同一条',
        uname: 'Alice Duplicate',
        uid: '42',
        source: 'ws',
        badges: ['UL 22', '舰长'],
      })
    )
    emitCustomChatEvent(
      baseEvent({
        id: 'ws-3',
        text: '同一条',
        uname: 'Bob',
        uid: '43',
        source: 'ws',
      })
    )
    await flushDom()

    expect(rows()).toHaveLength(2)
    expect(rows().map(row => row.dataset.key)).toEqual(['ws:ws-1', 'ws:ws-3'])
    expect(rows().map(row => row.dataset.user)).toEqual(['Alice', 'Bob'])
  })

  test('renders card events, fallback fields, and authoritative big emoticon images', async () => {
    startCustomChatDom()

    emitCustomChatEvent(
      baseEvent({
        id: 'gift-1',
        kind: 'gift',
        text: '投喂 小花 x 3',
        amount: 12300,
        fields: [],
      })
    )
    emitCustomChatEvent(
      baseEvent({
        id: 'sc-1',
        kind: 'superchat',
        text: '醒目留言内容',
        amount: 30,
        fields: [{ key: 'duration', label: '时长', value: '60 秒', kind: 'duration' }],
      })
    )
    emitCustomChatEvent(
      baseEvent({
        id: 'emo-1',
        text: '[doge]',
        emoticonImage: { url: 'https://example.test/doge.png', alt: '[doge]', width: 96, height: 96 },
      })
    )
    await flushDom()

    const rendered = rows()
    const gift = rendered.find(row => row.dataset.key === 'ws:gift-1')
    const sc = rendered.find(row => row.dataset.key === 'ws:sc-1')
    const emote = rendered.find(row => row.dataset.key === 'ws:emo-1')

    expect(gift?.dataset.card).toBe('gift')
    expect(gift?.querySelector('.lc-chat-card-title')?.textContent).toBe('礼物 ¥12')
    expect(gift?.querySelector('.lc-chat-card-field[data-field="gift-name"]')?.textContent).toContain('小花')
    expect(sc?.dataset.card).toBe('superchat')
    expect(sc?.querySelector('.lc-chat-card-field[data-field="duration"]')?.textContent).toContain('60 秒')
    expect(emote?.querySelector<HTMLImageElement>('.lc-chat-emote-big')?.src).toBe('https://example.test/doge.png')
  })

  test('search, filter toggles, perf debug, and clear button update the mounted DOM', async () => {
    customChatPerfDebug.value = true
    startCustomChatDom()
    emitCustomChatEvent(baseEvent({ id: 'dm-search', text: '普通弹幕', kind: 'danmaku' }))
    emitCustomChatEvent(baseEvent({ id: 'gift-search', text: '投喂 小花 x 1', kind: 'gift' }))
    await flushDom()

    const panel = root()
    expect(panel.dataset.debug).toBe('true')
    expect(panel.querySelector('.lc-chat-perf')?.textContent).toContain('消息 2/')

    const search = panel.querySelector<HTMLInputElement>('.lc-chat-search')
    if (!search) throw new Error('search input missing')
    search.value = 'kind:gift'
    search.dispatchEvent(new Event('input'))
    await waitForSearchDebounce()

    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.dataset.kind).toBe('gift')
    expect(panel.querySelector('.lc-chat-hint')?.textContent).toBe('1/2')

    const giftFilter = Array.from(panel.querySelectorAll<HTMLButtonElement>('.lc-chat-filter')).find(
      button => button.textContent === '礼物'
    )
    giftFilter?.click()
    await flushDom()

    expect(rows()).toHaveLength(0)
    expect(panel.querySelector('.lc-chat-empty')?.textContent).toBe('没有找到匹配“kind:gift”的消息')

    search.value = ''
    search.dispatchEvent(new Event('input'))
    await waitForSearchDebounce()

    const clearButton = Array.from(panel.querySelectorAll<HTMLButtonElement>('.lc-chat-pill')).find(
      button => button.textContent === '清屏'
    )
    clearButton?.click()
    await flushDom()

    expect(panel.querySelector('.lc-chat-empty')?.textContent).toBe('已清屏，新的弹幕会继续出现在这里')
  })

  test('composer updates fasongText from user input, sends on Enter, and only clears after successful send', async () => {
    startCustomChatDom()
    await flushDom()

    const panel = root()
    const textarea = panel.querySelector<HTMLTextAreaElement>('textarea.lc-chat-search, .lc-chat-composer textarea')
    if (!textarea) throw new Error('composer textarea missing')

    textarea.value = '手动输入'
    textarea.dispatchEvent(new Event('input'))
    expect(fasongText.value).toBe('手动输入')
    expect(panel.querySelector('.lc-chat-count')?.textContent).toBe('4')

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flushDom()
    expect(sentMessages).toEqual(['手动输入'])
    expect(textarea.value).toBe('')
    expect(fasongText.value).toBe('')

    sendManualResult = false
    textarea.value = '失败保留'
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flushDom()
    expect(sentMessages).toEqual(['手动输入', '失败保留'])
    expect(textarea.value).toBe('失败保留')
  })

  test('native danmaku fallback ignores recent WS duplicates and can be paused with unread tracking', async () => {
    startCustomChatDom()
    await flushDom()

    activeDanmakuSubscription?.onMessage?.({
      node: document.createElement('div'),
      text: '页面兜底弹幕',
      uname: 'DomUser',
      uid: '77',
      badges: ['UL 7'],
      isReply: true,
    })
    await flushDom()

    expect(rows()[0]?.dataset.source).toBe('dom')
    expect(rows()[0]?.querySelector('.lc-chat-text')?.textContent).toContain('页面兜底弹幕')
    rows()[0]?.querySelector<HTMLButtonElement>('.lc-chat-action')?.click()
    await flushDom()
    expect(stolenMessages).toContain('@DomUser 页面兜底弹幕')

    emitCustomChatEvent(baseEvent({ id: 'ws-recent', text: 'WS 已到', uid: '88', source: 'ws' }))
    await flushDom()
    activeDanmakuSubscription?.onMessage?.({
      node: document.createElement('div'),
      text: 'WS 已到',
      uname: 'DomLate',
      uid: '88',
      badges: [],
      isReply: false,
    })
    await flushDom()
    expect(rows().filter(row => row.textContent?.includes('WS 已到'))).toHaveLength(1)

    root().querySelector<HTMLButtonElement>('.lc-chat-pill')?.click()
    emitCustomChatEvent(baseEvent({ id: 'while-paused', text: '暂停后新消息' }))
    await flushDom()

    const unread = root().querySelector<HTMLElement>('.lc-chat-unread')
    expect(unread?.dataset.frozen).toBe('true')
    expect(unread?.textContent).toContain('1 条新消息')
  })
})
