import { type ComponentChild, render } from 'preact'

import { unsafeWindow } from '$'
import css from './styles.css?inline'
import './lib/fetch-hijack'

import { AppOpus } from './components/app-opus'
import { AppRoom } from './components/app-room'
import { AppSpace } from './components/app-space'
import { AppVideo } from './components/app-video'
import { infoCurrentUid, infoOpusMeta } from './lib/info-status'
import { installShadowKeyboardGuard } from './lib/shadow-keyboard-guard'
import { extractBvid, extractOpusAuthorUid, extractOpusPubDate, extractRoomNumber, whenDomReady } from './lib/utils'

// B站 SSR globals probed at startup; `unknown` since we only presence-check or defensively traverse them.
declare global {
  interface Window {
    __NEPTUNE_IS_MY_WAIFU__?: unknown
    __INITIAL_STATE__?: unknown
  }
}

// Browsers ignore `@property` inside shadow roots, so Tailwind v4's `--tw-*`
// composites (shadow, transform, …) break there. Register just the `@property`
// blocks once in <head> (global scope). Idempotent via marker id.
function registerTailwindProperties() {
  const markerId = 'laplace-chatterbox-tw-properties'
  if (document.getElementById(markerId)) return

  const propertyRules = css.match(/@property[^{]+\{[^}]*\}/g)
  if (!propertyRules) return

  const style = document.createElement('style')
  style.id = markerId
  style.textContent = propertyRules.join('\n')
  ;(document.head ?? document.documentElement).appendChild(style)
}

function mount(tree: ComponentChild) {
  // Mount the tree in a shadow root so Tailwind utilities stay scoped to it.
  const host = document.createElement('div')
  host.id = 'laplace-chatterbox-host'
  const root = host.attachShadow({ mode: 'open' })
  // Shadow boundary hides our field focus from page/extension document-level
  // key handlers, so guard against them hijacking keystrokes.
  installShadowKeyboardGuard(root)

  registerTailwindProperties()

  const style = document.createElement('style')
  style.textContent = css
  root.appendChild(style)

  const app = document.createElement('div')
  root.appendChild(app)
  document.body.appendChild(host)
  render(tree, app)
}

function waitForBody(cb: () => void): void {
  if (document.body) {
    cb()
    return
  }
  // Runs at document-start, so <body> may not exist yet; defer until it does.
  const observer = new MutationObserver(() => {
    if (document.body) {
      observer.disconnect()
      cb()
    }
  })
  observer.observe(document.documentElement, { childList: true })
}

// Each bilibili surface gets its own tree; the two `www.bilibili.com` surfaces
// (video, opus) are disambiguated by path below rather than by host.
const isLiveHost = location.hostname === 'live.bilibili.com'
const isSpaceHost = location.hostname === 'space.bilibili.com'
const isWwwHost = location.hostname === 'www.bilibili.com'

// Activity shells embed the real room in a same-origin `/blanc/<id>` iframe and
// the script runs in both, so pick the one functional frame to avoid double
// send loops / hijacks: `/blanc/<id>` mounts unconditionally; other number-paths
// only if a real room and not an activity shell. Gotcha: some `/5555` shells
// also define `__NEPTUNE_IS_MY_WAIFU__`, so that probe alone double-mounts —
// hence the `__BILIACT_*` exclusion below.
const hasResolvableRoom = extractRoomNumber(location.href) !== undefined
const isBlancEmbed = /^\/blanc\/\d+/.test(location.pathname)

// Activity/campaign shells expose `__BILIACT_*` SSR globals (absent on real rooms).
function isActivityShell(): boolean {
  return Object.keys(unsafeWindow).some(key => key.startsWith('__BILIACT_'))
}

if (isLiveHost && hasResolvableRoom) {
  if (isBlancEmbed) {
    waitForBody(() => mount(<AppRoom />))
  } else {
    whenDomReady(() => {
      if (!isActivityShell() && unsafeWindow.__NEPTUNE_IS_MY_WAIFU__) waitForBody(() => mount(<AppRoom />))
    })
  }
} else if (isSpaceHost) {
  // Pre-seed uid from the `/${uid}` path so the popover has identity before render;
  // legacy /space/uid forms won't match and fall back to "正在解析".
  const match = location.pathname.match(/^\/(\d+)/)
  if (match) {
    const uid = Number(match[1])
    if (Number.isFinite(uid)) infoCurrentUid.value = uid
  }
  waitForBody(() => mount(<AppSpace />))
} else if (isWwwHost) {
  // `www.bilibili.com` hosts two surfaces, disambiguated by path:
  const bvid = extractBvid(location.href)
  if (bvid) {
    // Only mount with a BV id; legacy `av` links have nothing to archive.
    waitForBody(() => mount(<AppVideo bvid={bvid} />))
  } else if (location.pathname.startsWith('/opus/')) {
    // Opus pages carry no uid in the URL; read the author from the SSR snapshot
    // (populated by whenDomReady) and only mount once it resolves.
    whenDomReady(() => {
      const state = unsafeWindow.__INITIAL_STATE__
      const uid = extractOpusAuthorUid(state)
      if (uid) {
        infoCurrentUid.value = uid
        // Provenance for the 魔法期 "贡献数据" link, only knowable on the opus page.
        infoOpusMeta.value = {
          source: location.origin + location.pathname,
          date: extractOpusPubDate(state) ?? null,
        }
        waitForBody(() => mount(<AppOpus />))
      }
    })
  }
}
