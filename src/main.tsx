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

// B站 SSR data globals we probe at startup:
//   - `__NEPTUNE_IS_MY_WAIFU__` marks a real live room (presence probe only,
//     so the value type is irrelevant).
//   - `__INITIAL_STATE__` carries the opus page's post data; we read the
//     author uid out of it via `extractOpusAuthorUid`, which traverses it
//     defensively, so `unknown` is enough here.
declare global {
  interface Window {
    __NEPTUNE_IS_MY_WAIFU__?: unknown
    __INITIAL_STATE__?: unknown
  }
}

// Tailwind v4 composes properties like `box-shadow`, `transform`, `filter`
// and `--tw-ring-*` out of several `--tw-*` custom properties whose default
// values (`0 0 #0000`, `0px`, …) are supplied solely by `@property`
// initial-value registrations. In every current browser, `@property` rules
// only register at the document scope — declarations inside a shadow root are
// ignored — so the variables resolve to nothing and the composite shorthand
// becomes invalid (e.g. `shadow-sm` renders as `box-shadow: none`).
//   - https://developer.chrome.com/docs/css-ui/css-names (section "@property")
//     "Today however, in all browsers you can only declare @property in the
//      document scope and @property declarations within shadow roots are ignored."
//   - https://github.com/w3c/csswg-drafts/issues/10541 (spec vs. implementation)
//
// Custom-property registration is global to the document, so we lift just the
// `@property` blocks out of the compiled CSS and register them once in
// <head>. This makes them available inside every shadow root without leaking
// any visual utilities into B站's light DOM. Idempotent via a marker id so
// repeated mounts don't duplicate the registration.
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

  // Register Tailwind's `@property` rules at the document level first — they
  // don't take effect inside the shadow root (see registerTailwindProperties).
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

// The userscript matches several bilibili surfaces, each getting a different
// tree so live-page features (send loop, room-id resolution, DOM hijacks)
// never run against pages they were never designed for:
//   - live.bilibili.com        → full danmaku helper UI (AppRoom)
//   - space.bilibili.com       → tiny read-only info surface (AppSpace)
//   - www.bilibili.com/video/* → minimal LAPLACE ICU archive button (AppVideo)
//   - www.bilibili.com/opus/*  → read-only 主播额外信息 popover (AppOpus)
// The last two share the `www.bilibili.com` host, so they're disambiguated by
// path below rather than by host.
const isLiveHost = location.hostname === 'live.bilibili.com'
const isSpaceHost = location.hostname === 'space.bilibili.com'
const isWwwHost = location.hostname === 'www.bilibili.com'

// Campaign / activity / promotion pages embed the actual live room in a
// same-origin `/blanc/<roomid>` iframe, and the userscript matches (and so
// runs in) both the outer shell and that iframe. Mounting in both gives two
// send loops, two danmaku hijacks and two corner clusters, so we pick the one
// functional frame:
//
//   - `/blackboard/era/<id>.html` campaign shells have no room number in their
//     path, so `extractRoomNumber` already excludes them here.
//   - `/<roomid>` activity rooms like `/5555` look exactly like a normal room
//     (`/999`) by URL, yet the real room lives in their `/blanc/<id>` iframe.
//     The number-only gate used to mount the shell on top of its iframe.
//
// We pick the functional frame with two checks at DOMContentLoaded (so SSR
// inline scripts have run):
//
//   - `/blanc/<id>` embeds are always the functional frame, so they mount
//     unconditionally on their own path.
//   - Other number-paths mount only if they're a real room AND not an activity
//     shell. `__NEPTUNE_IS_MY_WAIFU__` (B站's standard live-room SSR data
//     global) marks a room — but activity shells are built on B站's activity
//     platform and SOME variants of them (e.g. the full/logged-in `/5555`) ALSO
//     define it, so the neptune probe alone double-mounts on the shell and its
//     `/blanc/<id>` iframe. Activity shells are reliably identified by their
//     `__BILIACT_*` platform globals (baked into the page's SSR HTML and absent
//     on real rooms), so we exclude any frame carrying them.
const hasResolvableRoom = extractRoomNumber(location.href) !== undefined
const isBlancEmbed = /^\/blanc\/\d+/.test(location.pathname)

// Activity/campaign shells (e.g. `/5555`) expose B站's activity-platform SSR
// globals (`__BILIACT_ENV__`, `__BILIACT_PAGEINFO__`, …). They embed the real
// room in a `/blanc/<id>` iframe that mounts on its own path, so the shell must
// not mount even when it also defines `__NEPTUNE_IS_MY_WAIFU__`.
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
} else if (isWwwHost) {
  // `www.bilibili.com` hosts two surfaces, disambiguated by path:
  const bvid = extractBvid(location.href)
  if (bvid) {
    // Video watch pages (`/video/BVxxxx`). Mount only when the URL carries a
    // BV id — legacy `av` short links and non-video paths under www.bilibili.com
    // have nothing to archive, so we skip them rather than render a dead button.
    waitForBody(() => mount(<AppVideo bvid={bvid} />))
  } else if (location.pathname.startsWith('/opus/')) {
    // Opus (图文动态 / 专栏) pages. Identity isn't in the URL — the path carries
    // the post id, not a uid — so we read the author's uid from the page's SSR
    // snapshot (`__INITIAL_STATE__.detail`). That global is set by an inline
    // script in the initial HTML, so it's reliably populated by `whenDomReady`
    // (DOMContentLoaded). We seed `infoCurrentUid` before mounting so the
    // popover has identity at first paint, and only mount when it resolves —
    // mirroring the video branch's `if (bvid)` gate so we never render a dead,
    // uid-less button.
    whenDomReady(() => {
      const state = unsafeWindow.__INITIAL_STATE__
      const uid = extractOpusAuthorUid(state)
      if (uid) {
        infoCurrentUid.value = uid
        // Provenance for the 魔法期 "贡献数据" link, only knowable here on the
        // opus page: the permalink (origin+pathname, dropping any tracking
        // query) as `source`, and the post's publish date as `date`.
        infoOpusMeta.value = {
          source: location.origin + location.pathname,
          date: extractOpusPubDate(state) ?? null,
        }
        waitForBody(() => mount(<AppOpus />))
      }
    })
  }
}
