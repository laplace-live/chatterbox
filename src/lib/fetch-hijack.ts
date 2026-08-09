import { unsafeWindow } from '$'
import { createDeferredNode } from './deferred-node'
import { createLiveBlockPill } from './live-block-pill'

const LIVE_BLOCK_INDICATOR_ID = 'laplace-chatterbox-live-block-indicator'
const SPACE_BLOCK_BANNER_ID = 'laplace-chatterbox-space-block-banner'
const DELETED_SPACE_BANNER_ID = 'laplace-chatterbox-deleted-space-banner'

/** `relation.attribute` value meaning 拉黑; mutually exclusive with the follow states. */
const BLOCK_ATTRIBUTE = 128
const BLACKLIST_MANAGER_URL = 'https://account.bilibili.com/account/blacklist'

// Matched by `includes` so a query string / version prefix doesn't matter.
const GET_INFO_BY_USER_PATTERN = '/xlive/web-room/v1/index/getInfoByUser'
const ACC_RELATION_PATTERN = '/x/space/wbi/acc/relation'
const ACC_INFO_PATTERN = '/x/space/wbi/acc/info'

const liveBlockPill = createLiveBlockPill({
  id: LIVE_BLOCK_INDICATOR_ID,
  text: '✽ 拉黑已解锁',
  title: 'LAPLACE 直播助手已解除该直播间的部分拉黑限制',
})

interface BannerLink {
  href: string
  label: string
}

/** Full-width banner (per-`ensure` text) inserted after B站's space-page header. */
function buildSpaceBanner(text: string, link?: BannerLink): HTMLElement {
  const el = document.createElement('div')
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
  if (link) {
    const anchor = document.createElement('a')
    anchor.href = link.href
    anchor.target = '_blank'
    anchor.rel = 'noreferrer'
    anchor.textContent = link.label
    anchor.style.cssText = 'color: inherit; text-decoration: underline'
    el.appendChild(anchor)
  }
  return el
}

function createSpaceBanner(id: string) {
  const node = createDeferredNode({
    id,
    target: '.header.space-header',
    attach: (host, el) => host.insertAdjacentElement('afterend', el),
  })
  return {
    remove: () => node.remove(),
    ensure: (text: string, link?: BannerLink, shouldInject?: () => boolean) =>
      node.ensure(() => buildSpaceBanner(text, link), shouldInject),
  }
}

const spaceBlockBanner = createSpaceBanner(SPACE_BLOCK_BANNER_ID)
const deletedSpaceBanner = createSpaceBanner(DELETED_SPACE_BANNER_ID)

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

/** True iff this is one of the URLs we rewrite. */
function shouldHijackUrl(url: string): boolean {
  return url.includes(GET_INFO_BY_USER_PATTERN) || url.includes(ACC_RELATION_PATTERN) || url.includes(ACC_INFO_PATTERN)
}

/**
 * Mutate parsed-JSON `data` in place to clear block flags and fire the matching
 * indicator/banner. Idempotent, so re-consuming a cloned Response is safe.
 */
// biome-ignore lint/suspicious/noExplicitAny: parsed JSON shape from B站
function applyTransforms(url: string, data: any): void {
  if (url.includes(GET_INFO_BY_USER_PATTERN)) {
    console.log('[LAPLACE Chatterbox] Hijacking getInfoByUser response:', url)
    // B站 reuses `.right-section` across SPA nav; clear the stale pill first.
    liveBlockPill.remove()
    const forbid = data?.data?.forbid_live
    if (forbid) {
      const wasBlocking = !!forbid.is_forbid
      forbid.is_forbid = false
      forbid.forbid_text = ''
      console.log('[LAPLACE Chatterbox] Blacklist livestream block removed')
      if (wasBlocking) liveBlockPill.ensure()
    }
  } else if (url.includes(ACC_RELATION_PATTERN)) {
    console.log('[LAPLACE Chatterbox] Hijacking acc/relation response:', url)
    // Clear the previous user's stale banner (SPA nav) before re-deciding.
    spaceBlockBanner.remove()
    // `relation` is our block on them, `be_relation` theirs on us. The SPA's
    // content gate trips on either (`blockedType` 1 / 2), so clear both.
    const rel = data?.data?.relation
    const beRel = data?.data?.be_relation
    const iBlockedThem = rel?.attribute === BLOCK_ATTRIBUTE
    const theyBlockedMe = beRel?.attribute === BLOCK_ATTRIBUTE
    if (iBlockedThem) {
      rel.attribute = 0
      console.log('[LAPLACE Chatterbox] relation.attribute reset to 0')
    }
    if (theyBlockedMe) {
      beRel.attribute = 0
      console.log('[LAPLACE Chatterbox] be_relation.attribute reset to 0')
    }
    if (iBlockedThem) {
      // Zeroing our own attribute also flips the header button back to 关注 and
      // swaps the ⋮ entry to 加入黑名单, so point at the only remaining way to unblock.
      spaceBlockBanner.ensure('✽ LAPLACE 直播助手已解除你对该用户的拉黑限制，如需取消拉黑请前往', {
        href: BLACKLIST_MANAGER_URL,
        label: '黑名单管理',
      })
    } else if (theyBlockedMe) {
      spaceBlockBanner.ensure('✽ LAPLACE 直播助手已解除该用户的部分拉黑限制')
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
 * Patch `Response.prototype.json`/`.text` rather than `window.fetch`: B站's bundle
 * closes over `fetch` at module init. It closes over these methods too, so the real
 * invariant is landing before that bundle initialises — patching before the response
 * is merely *consumed* is not enough, since the call never routes through a layer
 * added after the capture. `document-start` guarantees it; `vite dev`'s async module
 * graph does not (the hijack evaluates ~600ms in, too late to ever be called), so
 * verify these unlocks against a build.
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
