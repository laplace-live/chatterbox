import { effect } from '@preact/signals'

import { unsafeWindow } from '$'
import { unlockLiveBlock, unlockSpaceBlock } from './store'

const LIVE_BLOCK_INDICATOR_ID = 'laplace-chatterbox-live-block-indicator'
const SPACE_BLOCK_BANNER_ID = 'laplace-chatterbox-space-block-banner'

// B站 API URLs whose JSON we transform on the fly. Match by `includes` so
// a query string / version prefix doesn't matter.
const GET_INFO_BY_USER_PATTERN = '/xlive/web-room/v1/index/getInfoByUser'
const ACC_RELATION_PATTERN = '/x/space/wbi/acc/relation'

// Observer references live at module scope so the toggle-off path
// (`effect(...)` below) can cancel a pending injection. Without this, a
// MutationObserver waiting for B站's late-mounted header could fire after
// the user disables the feature and inject the indicator anyway — the
// `remove*()` calls find nothing in the DOM yet, so they can't undo it.
let liveBlockObserver: MutationObserver | null = null
let spaceBlockObserver: MutationObserver | null = null

function disconnectLiveBlockObserver(): void {
  liveBlockObserver?.disconnect()
  liveBlockObserver = null
}

function disconnectSpaceBlockObserver(): void {
  spaceBlockObserver?.disconnect()
  spaceBlockObserver = null
}

function removeLiveBlockIndicator(): void {
  disconnectLiveBlockObserver()
  document.getElementById(LIVE_BLOCK_INDICATOR_ID)?.remove()
}

function removeSpaceBlockBanner(): void {
  disconnectSpaceBlockObserver()
  document.getElementById(SPACE_BLOCK_BANNER_ID)?.remove()
}

/**
 * Pill-style indicator inside the livestream header's right cluster
 * (`.right-section`). Prepending INTO the cluster keeps the pill inside its
 * existing flex layout, so we don't have to mirror whatever justify/gap
 * rules the header is using in the parent.
 *
 * Self-healing: if `.right-section` isn't in the DOM yet (we run at
 * document-start, B站 mounts the header later), a one-shot MutationObserver
 * waits for it.
 */
function ensureLiveBlockIndicator(): void {
  if (document.getElementById(LIVE_BLOCK_INDICATOR_ID)) return
  const inject = (targetEl: HTMLElement): void => {
    if (document.getElementById(LIVE_BLOCK_INDICATOR_ID)) return
    const el = document.createElement('div')
    el.id = LIVE_BLOCK_INDICATOR_ID
    el.title = 'LAPLACE 直播助手已解除该直播间的部分拉黑限制'
    el.textContent = '✽ 拉黑已解锁'
    el.style.cssText = [
      'display: inline-flex',
      'align-items: center',
      'align-self: center',
      'padding: 0 4px',
      'margin-right: 5px',
      'background: rgb(0 186 143)',
      'color: #fff',
      'border-radius: 4px',
      'font-size: 12px',
      'height: 20px',
      'line-height: 1',
      'flex-shrink: 0',
      'cursor: default',
    ].join(';')
    targetEl.prepend(el)
  }
  const targetEl = document.querySelector<HTMLElement>('.right-section')
  if (targetEl) {
    inject(targetEl)
    return
  }
  // Cancel any earlier pending observer so we keep at most one alive.
  disconnectLiveBlockObserver()
  liveBlockObserver = new MutationObserver(() => {
    // The user can flip `unlockLiveBlock` off in the configurator
    // between us setting up this observer and B站 finally mounting
    // `.right-section`. Re-read the signal so we don't inject behind the
    // user's back. The `effect(...)` below also disconnects on toggle-off
    // — this check is a defensive fallback for cases where the observer
    // fires before the effect microtask runs.
    if (!unlockLiveBlock.value) {
      disconnectLiveBlockObserver()
      return
    }
    const c = document.querySelector<HTMLElement>('.right-section')
    if (!c) return
    disconnectLiveBlockObserver()
    inject(c)
  })
  liveBlockObserver.observe(document.documentElement, { childList: true, subtree: true })
}

/**
 * Full-width banner inserted as a sibling immediately after B站's top
 * header on user space pages. Same self-healing observer pattern as the
 * livestream pill for the (common) case where our userscript runs before
 * B站 has rendered the header.
 */
function ensureSpaceBlockBanner(): void {
  if (document.getElementById(SPACE_BLOCK_BANNER_ID)) return
  const headerSelector = '.header.space-header'
  const inject = (header: HTMLElement): void => {
    if (document.getElementById(SPACE_BLOCK_BANNER_ID)) return
    const el = document.createElement('div')
    el.id = SPACE_BLOCK_BANNER_ID
    el.textContent = '✽ LAPLACE 直播助手已解除该用户的部分拉黑限制'
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
  disconnectSpaceBlockObserver()
  spaceBlockObserver = new MutationObserver(() => {
    // Same toggle-off race as `ensureLiveBlockIndicator`: re-check the
    // signal before injecting in case the user disabled the feature
    // while we were waiting for B站 to mount `.header.space-header`.
    if (!unlockSpaceBlock.value) {
      disconnectSpaceBlockObserver()
      return
    }
    const h = document.querySelector<HTMLElement>(headerSelector)
    if (!h) return
    disconnectSpaceBlockObserver()
    inject(h)
  })
  spaceBlockObserver.observe(document.documentElement, { childList: true, subtree: true })
}

// React to the configurator toggle in real time so disabling the feature
// drops the indicator immediately, without forcing a reload. (Re-enabling
// only re-shows it on the next fetch hit, which matches the existing
// "刷新生效" UX of the toggle itself.)
effect(() => {
  if (!unlockLiveBlock.value) removeLiveBlockIndicator()
})
effect(() => {
  if (!unlockSpaceBlock.value) removeSpaceBlockBanner()
})

/** True iff the current signal state means we'd actually rewrite this URL. */
function shouldHijackUrl(url: string): boolean {
  return (
    (unlockLiveBlock.value && url.includes(GET_INFO_BY_USER_PATTERN)) ||
    (unlockSpaceBlock.value && url.includes(ACC_RELATION_PATTERN))
  )
}

/**
 * Mutates parsed-JSON `data` in place to neutralize the relevant block
 * flags AND triggers the matching indicator/banner side effects.
 *
 * Idempotent: re-applying it on already-transformed data is a no-op
 * (`is_forbid` is already `false`, `attribute` is already `0`), so it's
 * safe even if B站's code clones a Response and consumes it twice.
 */
// biome-ignore lint/suspicious/noExplicitAny: parsed JSON shape from B站
function applyTransforms(url: string, data: any): void {
  if (unlockLiveBlock.value && url.includes(GET_INFO_BY_USER_PATTERN)) {
    console.log('[LAPLACE Chatterbox] Hijacking getInfoByUser response:', url)
    // Clear the previous room's pill before deciding whether to inject
    // one for the current room. Bilibili reuses `.right-section` across SPA
    // navigations, so a stale "已解锁" pill would otherwise linger when
    // the new room isn't blocking us.
    removeLiveBlockIndicator()
    const forbid = data?.data?.forbid_live
    if (forbid) {
      const wasBlocking = !!forbid.is_forbid
      forbid.is_forbid = false
      forbid.forbid_text = ''
      console.log('[LAPLACE Chatterbox] Blacklist livestream block removed')
      if (wasBlocking) ensureLiveBlockIndicator()
    }
  } else if (unlockSpaceBlock.value && url.includes(ACC_RELATION_PATTERN)) {
    console.log('[LAPLACE Chatterbox] Hijacking acc/relation response:', url)
    // Same SPA-navigation rationale as the livestream branch above:
    // clear the previous user's banner before deciding whether the
    // current user's relation needs one.
    removeSpaceBlockBanner()
    const beRel = data?.data?.be_relation
    if (beRel?.attribute === 128) {
      beRel.attribute = 0
      console.log('[LAPLACE Chatterbox] be_relation.attribute reset to 0')
      ensureSpaceBlockBanner()
    }
  }
}
/**
 * Patches `Response.prototype.json` / `Response.prototype.text` so we
 * transform B站 API responses regardless of which fetch reference
 * produced the Response.
 *
 * Why this layer and not `window.fetch`?
 * --------------------------------------
 * Patching `window.fetch` only catches calls that go through the
 * post-patch reference. B站's bundled JS captures the original `fetch`
 * into a closure during module init:
 *
 *     // somewhere inside B站's bundle (one-time module setup)
 *     const _fetch = window.fetch
 *     export const apiFetch = (u, o) => _fetch(u, o)
 *
 * Whether `_fetch` is ours or theirs depends on a parse-time race
 * between the userscript injection and the bundle's first `<script>`
 * execution. With DevTools "Disable cache" ON the bundle takes a fresh
 * network roundtrip and we always win; with cache ON the bundle parses
 * synchronously from disk cache and frequently beats us, leaving every
 * subsequent API call on the unpatched closure. That race exactly
 * matches the reported flakiness.
 *
 * The prototype layer side-steps the race entirely: `response.json()`
 * looks up `.json` on `Response.prototype` at *call* time, and the call
 * cannot happen until the network roundtrip resolves — by which point
 * even a slow userscript injection has long since landed. As long as
 * our patch is in place before the *first response is consumed* (not
 * before the first fetch is *issued*), the hijack is deterministic.
 */
;(() => {
  console.log('[LAPLACE Chatterbox] fetch-hijack loaded on', location.hostname)
  try {
    const ResponseProto = unsafeWindow.Response.prototype

    const origJson = ResponseProto.json
    ResponseProto.json = async function (this: Response): Promise<unknown> {
      const data = await origJson.call(this)
      const url = this.url
      if (url && data && typeof data === 'object') {
        try {
          applyTransforms(url, data)
        } catch (err) {
          console.error('[LAPLACE Chatterbox] applyTransforms (json) failed:', err)
        }
      }
      return data
    }

    // text() patch covers consumers that hand-roll JSON.parse (e.g.
    // `const t = await r.text(); JSON.parse(t)`). For non-target URLs
    // we pass the original string straight through — no parse cost.
    const origText = ResponseProto.text
    ResponseProto.text = async function (this: Response): Promise<string> {
      const text = await origText.call(this)
      const url = this.url
      if (url && shouldHijackUrl(url)) {
        try {
          const data = JSON.parse(text)
          applyTransforms(url, data)
          return JSON.stringify(data)
        } catch {
          // Body wasn't JSON (or transform threw); pass through unchanged.
        }
      }
      return text
    }
  } catch (err) {
    console.error('[LAPLACE Chatterbox] Failed to install Response prototype patches:', err)
  }
})()
