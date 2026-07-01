import { effect } from '@preact/signals'

import { unsafeWindow } from '$'
import { unlockLiveBlock, unlockSpaceBlock } from './store'

const LIVE_BLOCK_INDICATOR_ID = 'laplace-chatterbox-live-block-indicator'
const SPACE_BLOCK_BANNER_ID = 'laplace-chatterbox-space-block-banner'
const DELETED_SPACE_BANNER_ID = 'laplace-chatterbox-deleted-space-banner'

// Matched by `includes` so a query string / version prefix doesn't matter.
const GET_INFO_BY_USER_PATTERN = '/xlive/web-room/v1/index/getInfoByUser'
const ACC_RELATION_PATTERN = '/x/space/wbi/acc/relation'
const ACC_INFO_PATTERN = '/x/space/wbi/acc/info'

// Module scope so the toggle-off `effect(...)` can cancel a pending injection
// that would otherwise fire (and inject unremovably) after the feature is off.
let liveBlockObserver: MutationObserver | null = null

function disconnectLiveBlockObserver(): void {
  liveBlockObserver?.disconnect()
  liveBlockObserver = null
}

function removeLiveBlockIndicator(): void {
  disconnectLiveBlockObserver()
  document.getElementById(LIVE_BLOCK_INDICATOR_ID)?.remove()
}

/**
 * Prepend the pill indicator into the livestream header's `.right-section`,
 * or once B站 mounts it (one-shot observer, since we run at document-start).
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
    // Re-read: user may have toggled off while we waited for `.right-section`.
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
 * Factory for a full-width banner inserted after B站's space-page header.
 * Observer is per-closure (not module scope) so each banner's `remove()` can
 * cancel its own pending injection on toggle-off / SPA nav.
 */
function createSpaceBanner(id: string) {
  const headerSelector = '.header.space-header'
  let observer: MutationObserver | null = null

  const disconnect = (): void => {
    observer?.disconnect()
    observer = null
  }

  const inject = (header: HTMLElement, text: string): void => {
    if (document.getElementById(id)) return
    const el = document.createElement('div')
    el.id = id
    el.textContent = text
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

  return {
    remove(): void {
      disconnect()
      document.getElementById(id)?.remove()
    },
    /**
     * Inject the banner now, or once B站 mounts the header. `shouldInject` is
     * re-checked in the observer so a toggled-off feature doesn't inject late.
     */
    ensure(text: string, shouldInject: () => boolean = () => true): void {
      if (document.getElementById(id)) return
      const header = document.querySelector<HTMLElement>(headerSelector)
      if (header) {
        inject(header, text)
        return
      }
      disconnect()
      observer = new MutationObserver(() => {
        if (!shouldInject()) {
          disconnect()
          return
        }
        const h = document.querySelector<HTMLElement>(headerSelector)
        if (!h) return
        disconnect()
        inject(h, text)
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    },
  }
}

const spaceBlockBanner = createSpaceBanner(SPACE_BLOCK_BANNER_ID)
const deletedSpaceBanner = createSpaceBanner(DELETED_SPACE_BANNER_ID)

// Disabling drops the indicator immediately; re-enabling re-shows on next fetch.
effect(() => {
  if (!unlockLiveBlock.value) removeLiveBlockIndicator()
})
effect(() => {
  if (!unlockSpaceBlock.value) spaceBlockBanner.remove()
})

/** Pull the numeric `mid` out of an acc/info URL's query (0 if absent). */
function midFromUrl(url: string): number {
  try {
    const mid = new URL(url).searchParams.get('mid')
    const n = mid ? Number(mid) : 0
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/**
 * Synthetic `acc/info` `data` for a 注销 account (real response is `code:-404`,
 * no `data`). Verified-minimum field set: the Vue 3 SPA optional-chains almost
 * everything, but dereferences four parents UNGUARDED, throwing mid-render if
 * absent — `profession.is_show`, `sys_notice.content`, `official.type`, and
 * `birthday` (read via `.match`). Don't trim without re-checking the console
 * for new `Cannot read properties of undefined` throws.
 */
function buildDeletedAccountProfile(mid: number) {
  return {
    mid,
    name: '账号已注销',
    official: { role: 0, title: '', desc: '', type: -1 },
    profession: { name: '', department: '', title: '', is_show: 0 },
  }
}

/** True iff we'd actually rewrite this URL given the current signal state. */
function shouldHijackUrl(url: string): boolean {
  return (
    (unlockLiveBlock.value && url.includes(GET_INFO_BY_USER_PATTERN)) ||
    (unlockSpaceBlock.value && url.includes(ACC_RELATION_PATTERN)) ||
    // acc/info revival is always-on — no signal gate.
    url.includes(ACC_INFO_PATTERN)
  )
}

/**
 * Mutate parsed-JSON `data` in place to clear block flags and fire the matching
 * indicator/banner. Idempotent, so re-consuming a cloned Response is safe.
 */
// biome-ignore lint/suspicious/noExplicitAny: parsed JSON shape from B站
function applyTransforms(url: string, data: any): void {
  if (unlockLiveBlock.value && url.includes(GET_INFO_BY_USER_PATTERN)) {
    console.log('[LAPLACE Chatterbox] Hijacking getInfoByUser response:', url)
    // B站 reuses `.right-section` across SPA nav; clear the stale pill first.
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
    // Clear the previous user's stale banner (SPA nav) before re-deciding.
    spaceBlockBanner.remove()
    const beRel = data?.data?.be_relation
    if (beRel?.attribute === 128) {
      beRel.attribute = 0
      console.log('[LAPLACE Chatterbox] be_relation.attribute reset to 0')
      spaceBlockBanner.ensure('✽ LAPLACE 直播助手已解除该用户的部分拉黑限制', () => unlockSpaceBlock.value)
    }
  } else if (url.includes(ACC_INFO_PATTERN)) {
    // 注销 accounts return `code:-404`/no `data`, so the SPA short-circuits to
    // its error page and skips content tabs — but the contributions survive, so
    // synthesizing a minimal profile gets it past the gate. Always-on: content
    // is already public. Clear the stale banner first (SPA nav from a revived
    // account); re-added only when this response was actually 注销/封禁.
    deletedSpaceBanner.remove()
    if (data?.code === -404) {
      const mid = midFromUrl(url)
      console.log('[LAPLACE Chatterbox] Reviving deactivated account space:', mid || url)
      data.code = 0
      data.message = 'OK'
      data.data = buildDeletedAccountProfile(mid)
      deletedSpaceBanner.ensure('✽ LAPLACE 直播助手已恢复该注销账号的可见内容')
    } else if (data?.code === 0 && (data.data?.silence === 1 || data.data?.control === 1)) {
      // 封禁 accounts return real data with silence/control=1; both gate the
      // content tabs (clearing only `silence` isn't enough), so reset both.
      console.log('[LAPLACE Chatterbox] Reviving banned account space:', midFromUrl(url) || url)
      data.data.silence = 0
      data.data.control = 0
      deletedSpaceBanner.ensure('✽ LAPLACE 直播助手已恢复该封禁账号的可见内容')
    }
  }
}
/**
 * Patch `Response.prototype.json`/`.text` rather than `window.fetch`: B站's
 * bundle captures the original `fetch` into a closure at module init, racing our
 * injection (loses with disk cache). Prototype methods resolve at call time —
 * after the network roundtrip — so the hijack is deterministic as long as we
 * patch before the first response is *consumed*, not before the first fetch.
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

    // Covers consumers that hand-roll JSON.parse; non-target URLs pass through.
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
