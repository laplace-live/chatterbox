import { unsafeWindow } from '$'
import { unlockBeBlocked, unlockForbidLive } from './store'

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
      const text = await resp.text()
      try {
        const data = JSON.parse(text)
        if (data?.data?.forbid_live) {
          data.data.forbid_live.is_forbid = false
          data.data.forbid_live.forbid_text = ''
          console.log('[LAPLACE Chatterbox] Blacklist livestream block removed')
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
      const text = await resp.text()
      try {
        const data = JSON.parse(text)
        if (data?.data?.be_relation && data.data.be_relation.attribute !== 0) {
          data.data.be_relation.attribute = 0
          console.log('[LAPLACE Chatterbox] be_relation.attribute reset to 0')
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
