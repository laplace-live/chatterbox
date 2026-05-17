import { render } from 'preact'

import './styles.css'
import './lib/fetch-hijack'

import { App } from './components/app'

function mount() {
  const app = document.createElement('div')
  document.body.append(app)
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
