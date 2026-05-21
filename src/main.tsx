import { type ComponentChild, render } from 'preact'

import css from './styles.css?inline'
import './lib/fetch-hijack'

import { AppRoom } from './components/app-room'
import { AppSpace } from './components/app-space'
import { infoCurrentUid } from './lib/info-status'

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

// The userscript matches both live.bilibili.com (full danmaku helper UI)
// and space.bilibili.com (originally fetch-hijack only, now also the
// minimal AppSpace for the info button). Each host gets a different
// tree so live-page features like the send loop, room-id resolution,
// and DOM hijacks don't run against pages they were never designed for,
// and so the space-page mount stays a tiny read-only surface.
const isLiveHost = location.hostname === 'live.bilibili.com'
const isSpaceHost = location.hostname === 'space.bilibili.com'

if (isLiveHost) {
  waitForBody(() => mount(<AppRoom />))
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
}
