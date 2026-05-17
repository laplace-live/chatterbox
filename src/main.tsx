import { render } from 'preact'

import css from './styles.css?inline'
import './lib/fetch-hijack'

import { App } from './components/app'

function mount() {
  // Shadow DOM PoC: attach a shadow root on a host element appended to <body>.
  // The whole App tree (toggle cluster + configurator dialog + alert dialog)
  // mounts inside the shadow root. Tailwind CSS is injected as a single
  // <style> sibling so utilities only apply inside the shadow tree.
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
  render(<App />, app)
}

// The userscript matches both live.bilibili.com (full danmaku helper UI) and
// space.bilibili.com (fetch-hijack only, e.g. unlockSpaceBlock on profile
// pages). On non-live hosts we skip mounting the App so live-page features
// like the send loop, room-id resolution, and DOM hijacks don't run against
// pages they were never designed for.
const isLiveHost = location.hostname === 'live.bilibili.com'

// The userscript runs at document-start so the WBI XHR interceptor (wbi.ts)
// can patch XMLHttpRequest before the page fires /x/web-interface/nav.
// At that point document.body may not exist yet, so we defer mounting until
// the browser creates <body>.
if (isLiveHost) {
  if (document.body) {
    mount()
  } else {
    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect()
        mount()
      }
    })
    observer.observe(document.documentElement, { childList: true })
  }
}
