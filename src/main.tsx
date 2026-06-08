import { type ComponentChild, render } from 'preact'

import { unsafeWindow } from '$'
import css from './styles.css?inline'
import './lib/fetch-hijack'

import { AppRoom } from './components/app-room'
import { AppSpace } from './components/app-space'
import { AppVideo } from './components/app-video'
import { infoCurrentUid } from './lib/info-status'
import { installShadowKeyboardGuard } from './lib/shadow-keyboard-guard'
import { extractBvid, extractRoomNumber, whenDomReady } from './lib/utils'

// `__NEPTUNE_IS_MY_WAIFU__` is B站's standard live-room SSR data global. We
// only probe for its presence, so the value type is irrelevant.
declare global {
  interface Window {
    __NEPTUNE_IS_MY_WAIFU__?: unknown
  }
}

function mount(tree: ComponentChild) {
  // Shadow DOM PoC: attach a shadow root on a host element appended to <body>.
  // The whole tree (live App or minimal AppSpace) mounts inside the shadow
  // root. Tailwind CSS is injected as a single <style> sibling so utilities
  // only apply inside the shadow tree.
  //
  // Anything injected directly into B站's DOM (chat-item +1/偷 buttons in
  // danmaku-direct.ts, menu items in user-blacklist.ts, the <html> flag in
  // audio-only.ts) still lives in the light DOM and uses literal class
  // names — those don't depend on the utility CSS that's now inside the
  // shadow root.
  const host = document.createElement('div')
  host.id = 'laplace-chatterbox-host'
  const root = host.attachShadow({ mode: 'open' })
  // Stop page/extension keyboard shortcuts (e.g. Video Speed Controller)
  // from hijacking keystrokes while the user types in our shadow-DOM
  // fields — the shadow boundary hides our <textarea>/<input> focus from
  // their document-level handlers. See shadow-keyboard-guard.ts.
  installShadowKeyboardGuard(root)

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
  // The userscript runs at document-start so the WBI XHR interceptor
  // (wbi.ts) can patch XMLHttpRequest before the page fires
  // /x/web-interface/nav. At that point document.body may not exist
  // yet, so we defer mounting until the browser creates <body>.
  const observer = new MutationObserver(() => {
    if (document.body) {
      observer.disconnect()
      cb()
    }
  })
  observer.observe(document.documentElement, { childList: true })
}

// The userscript matches three bilibili surfaces, each getting a different
// tree so live-page features (send loop, room-id resolution, DOM hijacks)
// never run against pages they were never designed for:
//   - live.bilibili.com  → full danmaku helper UI (AppRoom)
//   - space.bilibili.com → tiny read-only info surface (AppSpace)
//   - www.bilibili.com/video/* → minimal LAPLACE ICU archive button (AppVideo)
const isLiveHost = location.hostname === 'live.bilibili.com'
const isSpaceHost = location.hostname === 'space.bilibili.com'
const isVideoHost = location.hostname === 'www.bilibili.com'

// Campaign / activity / promotion pages embed the actual live room in a
// same-origin `/blanc/<roomid>` iframe, and the userscript matches (and so
// runs in) both the outer shell and that iframe. Mounting in both gives two
// send loops, two danmaku hijacks and two corner clusters, so we pick the one
// functional frame:
//
//   - `/blackboard/era/<id>.html` campaign shells have no room number in their
//     path, so `extractRoomNumber` already excludes them here.
//   - `/<roomid>` promotion rooms like `/510` look exactly like a normal room
//     (`/999`) by URL, yet the real room lives in their `/blanc/<id>` iframe.
//     The number-only gate used to mount the shell on top of its iframe — the
//     reported double-mount on `/510`.
//
// The discriminator is `__NEPTUNE_IS_MY_WAIFU__`, B站's standard live-room SSR
// data global: real rooms define it (via an inline script, before
// DOMContentLoaded), decorated shells never do. The `/blanc/<id>` embed is the
// functional frame on those pages but omits the global, so it mounts on its
// own path. We check at DOMContentLoaded so the inline script has run.
const hasResolvableRoom = extractRoomNumber(location.href) !== undefined
const isBlancEmbed = /^\/blanc\/\d+/.test(location.pathname)

if (isLiveHost && hasResolvableRoom) {
  if (isBlancEmbed) {
    waitForBody(() => mount(<AppRoom />))
  } else {
    whenDomReady(() => {
      if (unsafeWindow.__NEPTUNE_IS_MY_WAIFU__) waitForBody(() => mount(<AppRoom />))
    })
  }
} else if (isSpaceHost) {
  // Pre-seed the info uid from the URL so the popover has an identity
  // ready before render. Space URLs always start with `/${uid}` (e.g.
  // `/3493115307571904/dynamic`). If the URL doesn't match (rare —
  // some legacy /space/uid forms exist) we leave `infoCurrentUid` null
  // and the popover shows its "正在解析" fallback.
  const match = location.pathname.match(/^\/(\d+)/)
  if (match) {
    const uid = Number(match[1])
    if (Number.isFinite(uid)) infoCurrentUid.value = uid
  }
  waitForBody(() => mount(<AppSpace />))
} else if (isVideoHost) {
  // Video watch pages (`/video/BVxxxx`). Mount only when the URL carries a
  // BV id — legacy `av` short links and non-video paths under www.bilibili.com
  // have nothing to archive, so we skip them rather than render a dead button.
  const bvid = extractBvid(location.href)
  if (bvid) waitForBody(() => mount(<AppVideo bvid={bvid} />))
}
