// Coverage for src/components/panel-header.tsx — the sticky panel header
// that replaced the 4-Tab bar.
//
// PanelHeader uses useRef + useEffect, so a bare `PanelHeader()` call
// throws inside Preact's hook machinery — we need a real component-render
// pass. happy-dom + preact's `render()` gives us that.
//
// What this locks down:
//   1. Room ID is shown via the URL fallback even when cachedRoomId.value
//      is null (e.g. before any side effect populates it).
//   2. The "0" defense: a literal cachedRoomId=0 (impossible but defensive)
//      is rejected, falling through to the URL fallback.
//   3. WS badge visibility — only renders for `connecting` / `closed` /
//      `error`. Hidden in healthy (`live`) and idle (`off`) states.
//   4. The "↻ 重连" reconnect button only appears in degraded states.
//   5. The historical `'open'` typo is locked out by asserting that the
//      real healthy value `'live'` silences the header.

import { Window } from 'happy-dom'

const happyWindow = new Window({ url: 'https://live.bilibili.com/12345' })
;(happyWindow as unknown as { SyntaxError: SyntaxErrorConstructor }).SyntaxError = SyntaxError

// Wire the happy-dom window into globals BEFORE any module imports so
// `window.location.href` and friends resolve correctly.
Object.defineProperty(globalThis, 'window', { value: happyWindow, configurable: true })
Object.defineProperty(globalThis, 'document', { value: happyWindow.document, configurable: true })
Object.defineProperty(globalThis, 'location', { value: happyWindow.location, configurable: true })
Object.defineProperty(globalThis, 'HTMLElement', { value: happyWindow.HTMLElement, configurable: true })
Object.defineProperty(globalThis, 'HTMLButtonElement', { value: happyWindow.HTMLButtonElement, configurable: true })

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { h, render } from 'preact'

import { installGmStoreMock } from './_gm-store'

const { reset: resetGmStore } = installGmStoreMock()

// Suppress wbi.ts XMLHttpRequest prototype patching (transitively imported).
class TestXMLHttpRequest {
  open(): void {}
  send(): void {}
}
;(globalThis as unknown as { XMLHttpRequest: typeof TestXMLHttpRequest }).XMLHttpRequest = TestXMLHttpRequest

// Don't import real live-ws-source — its module init touches XHR / WS globals
// and we don't need any of that here. A stub keeps reconnectLiveWsNow callable
// from the rendered button.
mock.module('../src/lib/live-ws-source', () => ({
  reconnectLiveWsNow: () => true,
  startLiveWsSource: () => () => {},
  stopLiveWsSource: () => {},
}))

// Mock notifyUser so the reconnect button's notifyUser fallback doesn't reach
// real toast machinery.
const realLog = await import('../src/lib/log')
mock.module('../src/lib/log', () => ({
  ...realLog,
  notifyUser: () => {},
}))

const { PanelHeader } = await import('../src/components/panel-header')
const {
  activeTab,
  autoBlendDryRun,
  autoBlendEnabled,
  cachedRoomId,
  hzmDriveEnabled,
  hzmDryRun,
  liveWsStatus,
  sendMsg,
  sttRunning,
} = await import('../src/lib/store')

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

let container: HTMLElement

function mount(): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  // `h(PanelHeader, null)` calls the component with no props; we don't need any.
  render(h(PanelHeader, {}), container)
  return container
}

function unmount(): void {
  if (container) {
    render(null, container)
    container.remove()
  }
}

function setUrl(href: string): void {
  // Happy-dom exposes `location` as writable. Setting `location.href` doesn't
  // navigate (no real browser doc switch), it just rewrites the value the
  // app reads back. That's exactly what we want for the fallback test.
  ;(happyWindow as unknown as { location: { href: string } }).location.href = href
}

function text(): string {
  return container?.textContent ?? ''
}

function hasClass(needle: string): boolean {
  if (!container) return false
  return container.querySelector(`.${needle}`) !== null
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  resetGmStore()
  activeTab.value = 'fasong'
  cachedRoomId.value = null
  liveWsStatus.value = 'off'
  sendMsg.value = false
  autoBlendEnabled.value = false
  autoBlendDryRun.value = false
  hzmDriveEnabled.value = false
  hzmDryRun.value = false
  sttRunning.value = false
  setUrl('https://live.bilibili.com/12345')
})

afterEach(() => {
  unmount()
  activeTab.value = 'fasong'
})

// ===========================================================================

describe('PanelHeader — room ID display', () => {
  test('renders room ID parsed from window.location.href when cachedRoomId is null', () => {
    cachedRoomId.value = null
    setUrl('https://live.bilibili.com/12345')
    mount()
    expect(text()).toContain('12345')
  })

  test('renders cached room ID when present (takes precedence over URL fallback)', () => {
    cachedRoomId.value = 99999
    setUrl('https://live.bilibili.com/11111')
    mount()
    const t = text()
    expect(t).toContain('99999')
    expect(t).not.toContain('11111')
  })

  test('hides the room ID chip entirely when neither cache nor URL has one', () => {
    cachedRoomId.value = null
    setUrl('https://example.com/not-a-room')
    mount()
    expect(hasClass('cb-panel-header-roomid')).toBe(false)
  })

  test('rejects cachedRoomId === 0 and falls through to URL fallback', () => {
    // Defensive guard: 0 is not a real Bilibili room ID. If a corrupt
    // restore wrote 0 we want the URL fallback to take over rather than
    // rendering "· 0" in the header.
    cachedRoomId.value = 0
    setUrl('https://live.bilibili.com/22222')
    mount()
    const t = text()
    expect(t).toContain('22222')
    expect(t).not.toMatch(/·\s*0(?!\d)/)
  })

  test('rejects a parsed-as-zero URL room (e.g. /0) and shows no room id at all', () => {
    cachedRoomId.value = null
    setUrl('https://live.bilibili.com/0')
    mount()
    expect(hasClass('cb-panel-header-roomid')).toBe(false)
  })
})

// ===========================================================================

describe('PanelHeader — WS state visibility (Jobs "silent on healthy" rule)', () => {
  test('healthy `live` state: WS badge hidden, no reconnect button, no degraded banner', () => {
    liveWsStatus.value = 'live'
    mount()
    expect(hasClass('cb-panel-header-ws')).toBe(false)
    expect(hasClass('cb-panel-header-reconnect')).toBe(false)
    expect(hasClass('cb-ws-degraded-banner')).toBe(false)
  })

  test('idle `off` state: WS badge hidden (user never enabled WS — not a problem to surface)', () => {
    liveWsStatus.value = 'off'
    mount()
    expect(hasClass('cb-panel-header-ws')).toBe(false)
    expect(hasClass('cb-panel-header-reconnect')).toBe(false)
    expect(hasClass('cb-ws-degraded-banner')).toBe(false)
  })

  test('`connecting` state: badge shows in connecting variant (orange pulse), no reconnect button', () => {
    liveWsStatus.value = 'connecting'
    mount()
    expect(hasClass('cb-panel-header-ws')).toBe(true)
    expect(hasClass('cb-panel-header-ws--connecting')).toBe(true)
    expect(hasClass('cb-panel-header-ws--bad')).toBe(false)
    expect(hasClass('cb-panel-header-reconnect')).toBe(false)
  })

  test('`closed` degraded state: badge in --bad variant + ↻ reconnect button + bottom banner', () => {
    liveWsStatus.value = 'closed'
    mount()
    expect(hasClass('cb-panel-header-ws--bad')).toBe(true)
    expect(hasClass('cb-panel-header-reconnect')).toBe(true)
    expect(hasClass('cb-ws-degraded-banner')).toBe(true)
    expect(text()).toContain('重连')
  })

  test('`error` degraded state: same UI as `closed` (both treated as actionable failure)', () => {
    liveWsStatus.value = 'error'
    mount()
    expect(hasClass('cb-panel-header-ws--bad')).toBe(true)
    expect(hasClass('cb-panel-header-reconnect')).toBe(true)
    expect(hasClass('cb-ws-degraded-banner')).toBe(true)
  })

  test('regression: legacy `"open"` value (typo from a previous version) must not be treated as healthy', () => {
    // Guards against the historical bug where `ws === 'open'` (never in the
    // CustomChatWsStatus enum) was used to decide "healthy" — so the header
    // always showed "WS 未连" even after the log printed "🟢 已连接". The
    // real healthy value is 'live'. Locking that in:
    liveWsStatus.value = 'live'
    mount()
    expect(hasClass('cb-panel-header-ws')).toBe(false)
  })
})

// ===========================================================================

describe('PanelHeader — activity chips', () => {
  test('no chips rendered when nothing is active', () => {
    mount()
    expect(hasClass('cb-panel-header-chips')).toBe(false)
  })

  test('shows 独轮车 chip when loop is running', () => {
    sendMsg.value = true
    mount()
    expect(text()).toContain('独轮车')
  })

  test('shows 跟车 chip when auto-blend is on, with `·试` suffix in dry-run mode', () => {
    autoBlendEnabled.value = true
    autoBlendDryRun.value = true
    mount()
    expect(text()).toContain('跟车·试')
    // The standalone "⚠ 试运行" emphasis chip was removed (visual redundancy
    // with the per-feature `·试` suffix + orange chip color). Single source
    // of truth: each feature's own chip carries its dryRun state.
    expect(text()).not.toContain('⚠ 试运行')
  })

  test('shows 智驾 chip when HZM is on', () => {
    hzmDriveEnabled.value = true
    mount()
    expect(text()).toContain('智驾')
  })

  test('shows 同传 chip when STT is running', () => {
    sttRunning.value = true
    mount()
    expect(text()).toContain('同传')
  })

  test('all-real-fire (no dry) does NOT show the ⚠ 试运行 chip', () => {
    autoBlendEnabled.value = true
    autoBlendDryRun.value = false
    hzmDriveEnabled.value = true
    hzmDryRun.value = false
    mount()
    expect(text()).not.toContain('⚠ 试运行')
  })
})

// ===========================================================================

describe('PanelHeader — sub-page (← 返回) variant', () => {
  test('settings sub-page renders the back button with the right page title', () => {
    activeTab.value = 'settings'
    mount()
    const t = text()
    expect(t).toContain('返回')
    expect(t).toContain('设置')
  })

  test('about sub-page renders the back button with the about title', () => {
    activeTab.value = 'about'
    mount()
    const t = text()
    expect(t).toContain('返回')
    expect(t).toContain('关于')
  })
})
