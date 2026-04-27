import { effect } from '@preact/signals'

import { unsafeWindow } from '$'
import { unlockBeBlocked, unlockForbidLive } from './store'

const FORBID_LIVE_INDICATOR_ID = 'laplace-chatterbox-forbid-live-indicator'
const BE_BLOCKED_BANNER_ID = 'laplace-chatterbox-be-blocked-banner'

// Observer references live at module scope so the toggle-off path
// (`effect(...)` below) can cancel a pending injection. Without this, a
// MutationObserver waiting for B站's late-mounted header could fire after
// the user disables the feature and inject the indicator anyway — the
// `remove*()` calls find nothing in the DOM yet, so they can't undo it.
let forbidLiveObserver: MutationObserver | null = null
let beBlockedObserver: MutationObserver | null = null

function disconnectForbidLiveObserver(): void {
  forbidLiveObserver?.disconnect()
  forbidLiveObserver = null
}

function disconnectBeBlockedObserver(): void {
  beBlockedObserver?.disconnect()
  beBlockedObserver = null
}

function removeForbidLiveIndicator(): void {
  disconnectForbidLiveObserver()
  document.getElementById(FORBID_LIVE_INDICATOR_ID)?.remove()
}

function removeBeBlockedBanner(): void {
  disconnectBeBlockedObserver()
  document.getElementById(BE_BLOCKED_BANNER_ID)?.remove()
}

/**
 * Pill-style indicator inside the livestream header's right cluster
 * (`.right-ctnr`). Prepending INTO the cluster keeps the pill inside its
 * existing flex layout, so we don't have to mirror whatever justify/gap
 * rules the header is using in the parent.
 *
 * Self-healing: if `.right-ctnr` isn't in the DOM yet (we run at
 * document-start, B站 mounts the header later), a one-shot MutationObserver
 * waits for it.
 */
function ensureForbidLiveIndicator(): void {
  if (document.getElementById(FORBID_LIVE_INDICATOR_ID)) return
  const inject = (ctnr: HTMLElement): void => {
    if (document.getElementById(FORBID_LIVE_INDICATOR_ID)) return
    const el = document.createElement('div')
    el.id = FORBID_LIVE_INDICATOR_ID
    el.title = 'LAPLACE 弹幕助手已解除该直播间的部分拉黑限制'
    el.textContent = '🔓 拉黑已解锁'
    el.style.cssText = [
      'display: inline-flex',
      'align-items: center',
      'align-self: center',
      'padding: 0 4px',
      'background: rgb(0 186 143)',
      'color: #fff',
      'border-radius: 4px',
      'font-size: 12px',
      'height: 20px',
      'line-height: 1',
      'flex-shrink: 0',
      'cursor: default',
    ].join(';')
    ctnr.prepend(el)
  }
  const ctnr = document.querySelector<HTMLElement>('.right-ctnr')
  if (ctnr) {
    inject(ctnr)
    return
  }
  // Cancel any earlier pending observer so we keep at most one alive.
  disconnectForbidLiveObserver()
  forbidLiveObserver = new MutationObserver(() => {
    // The user can flip `unlockForbidLive` off in the configurator
    // between us setting up this observer and B站 finally mounting
    // `.right-ctnr`. Re-read the signal so we don't inject behind the
    // user's back. The `effect(...)` below also disconnects on toggle-off
    // — this check is a defensive fallback for cases where the observer
    // fires before the effect microtask runs.
    if (!unlockForbidLive.value) {
      disconnectForbidLiveObserver()
      return
    }
    const c = document.querySelector<HTMLElement>('.right-ctnr')
    if (!c) return
    disconnectForbidLiveObserver()
    inject(c)
  })
  forbidLiveObserver.observe(document.documentElement, { childList: true, subtree: true })
}

/**
 * Full-width banner inserted as a sibling immediately after B站's top
 * header on user space pages. Same self-healing observer pattern as the
 * livestream pill for the (common) case where our userscript runs before
 * B站 has rendered the header.
 */
function ensureBeBlockedBanner(): void {
  if (document.getElementById(BE_BLOCKED_BANNER_ID)) return
  const headerSelector = '.header.space-header'
  const inject = (header: HTMLElement): void => {
    if (document.getElementById(BE_BLOCKED_BANNER_ID)) return
    const el = document.createElement('div')
    el.id = BE_BLOCKED_BANNER_ID
    el.textContent = '🔓 LAPLACE 弹幕助手已解除该用户的部分拉黑限制'
    el.style.cssText = [
      'background: rgb(228 243 240)',
      'color: rgb(0 82 63)',
      'padding: 8px 16px',
      'font-size: 12px',
      'text-align: center',
      'box-sizing: border-box',
      'width: 100%',
      'line-height: 1',
    ].join(';')
    header.insertAdjacentElement('afterend', el)
  }
  const header = document.querySelector<HTMLElement>(headerSelector)
  if (header) {
    inject(header)
    return
  }
  disconnectBeBlockedObserver()
  beBlockedObserver = new MutationObserver(() => {
    // Same toggle-off race as `ensureForbidLiveIndicator`: re-check the
    // signal before injecting in case the user disabled the feature
    // while we were waiting for B站 to mount `.header.space-header`.
    if (!unlockBeBlocked.value) {
      disconnectBeBlockedObserver()
      return
    }
    const h = document.querySelector<HTMLElement>(headerSelector)
    if (!h) return
    disconnectBeBlockedObserver()
    inject(h)
  })
  beBlockedObserver.observe(document.documentElement, { childList: true, subtree: true })
}

// React to the configurator toggle in real time so disabling the feature
// drops the indicator immediately, without forcing a reload. (Re-enabling
// only re-shows it on the next fetch hit, which matches the existing
// "刷新生效" UX of the toggle itself.)
effect(() => {
  if (!unlockForbidLive.value) removeForbidLiveIndicator()
})
effect(() => {
  if (!unlockBeBlocked.value) removeBeBlockedBanner()
})

/** Patches fetch() responses for specific Bilibili live API endpoints. */
;(() => {
  console.log('[LAPLACE Chatterbox] fetch-hijack loaded on', location.hostname)
  const pageWindow = unsafeWindow
  const originalFetch = pageWindow.fetch
  const patchedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString()
    const resp = await originalFetch.call(pageWindow, input, init)

    if (unlockForbidLive.value && url.includes('/xlive/web-room/v1/index/getInfoByUser')) {
      console.log('[LAPLACE Chatterbox] Hijacking getInfoByUser fetch response:', url)
      // Clear the previous room's pill before deciding whether to inject
      // one for the current room. Bilibili reuses `.right-ctnr` across SPA
      // navigations, so a stale "已解锁" pill would otherwise linger when
      // the new room isn't blocking us.
      removeForbidLiveIndicator()
      const text = await resp.text()
      try {
        const data = JSON.parse(text)
        if (data?.data?.forbid_live) {
          const wasBlocking = !!data.data.forbid_live.is_forbid
          data.data.forbid_live.is_forbid = false
          data.data.forbid_live.forbid_text = ''
          console.log('[LAPLACE Chatterbox] Blacklist livestream block removed')
          if (wasBlocking) ensureForbidLiveIndicator()
          return new Response(JSON.stringify(data), {
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers,
          })
        }
      } catch {
        /* not JSON, return as-is */
      }
      return new Response(text, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      })
    }

    if (unlockBeBlocked.value && url.includes('/x/space/wbi/acc/relation')) {
      console.log('[LAPLACE Chatterbox] Hijacking acc/relation fetch response:', url)
      // Same SPA-navigation rationale as the livestream branch above:
      // clear the previous user's banner before deciding whether the
      // current user's relation needs one.
      removeBeBlockedBanner()
      const text = await resp.text()
      try {
        const data = JSON.parse(text)
        if (data?.data?.be_relation && data.data.be_relation.attribute !== 0) {
          data.data.be_relation.attribute = 0
          console.log('[LAPLACE Chatterbox] be_relation.attribute reset to 0')
          ensureBeBlockedBanner()
          return new Response(JSON.stringify(data), {
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers,
          })
        }
      } catch {
        /* not JSON, return as-is */
      }
      return new Response(text, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      })
    }

    return resp
  }
  pageWindow.fetch = Object.assign(patchedFetch, originalFetch)
})()
