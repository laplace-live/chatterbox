import type { BilibiliWbiKeys } from './types.js'

import { md5 } from './md5.js'

/** WBI keys captured by XHR hijack; set when /x/web-interface/nav response is received. */
export let cachedWbiKeys: BilibiliWbiKeys | null = null

function setCachedWbiKeys(keys: BilibiliWbiKeys) {
  cachedWbiKeys = keys
}

;(() => {
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    ;(this as XMLHttpRequest & { _url?: string })._url = typeof url === 'string' ? url : url.toString()
    return originalOpen.call(this, method, url, async ?? true, username ?? null, password ?? null)
  }

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const url = (this as XMLHttpRequest & { _url?: string })._url
    if (url?.includes('/x/web-interface/nav')) {
      console.log('[LAPLACE Chatterbox Helper] Intercepted request:', url)

      this.addEventListener('load', function () {
        try {
          const data: {
            data?: { wbi_img?: { img_url?: string; sub_url?: string } }
          } = JSON.parse(this.responseText)
          if (data?.data?.wbi_img) {
            console.log('[LAPLACE Chatterbox Helper] wbi_img:', data.data.wbi_img)

            const img_url = data.data.wbi_img.img_url
            const sub_url = data.data.wbi_img.sub_url

            const img_key = img_url?.split('/').pop()?.split('.')[0] ?? ''
            const sub_key = sub_url?.split('/').pop()?.split('.')[0] ?? ''

            setCachedWbiKeys({ img_key, sub_key })
            console.log('[LAPLACE Chatterbox Helper] Extracted WBI keys:', cachedWbiKeys)
          } else {
            console.log('[LAPLACE Chatterbox Helper] Response received but wbi_img not found:', data)
          }
        } catch (err) {
          console.error('[LAPLACE Chatterbox Helper] Error parsing response:', err)
        }
      })
    }

    return originalSend.call(this, body)
  }
})()

/**
 * Waits for WBI keys to become available via XHR interception.
 */
export async function waitForWbiKeys(timeout = 5000, interval = 100): Promise<boolean> {
  const startTime = Date.now()
  while (!cachedWbiKeys) {
    if (Date.now() - startTime > timeout) {
      return false
    }
    await new Promise(r => setTimeout(r, interval))
  }
  return true
}

// https://s1.hdslb.com/bfs/static/laputa-home/client/assets/vendor.7679ec63.js
const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
]

function getMixinKey(orig: string): string {
  return mixinKeyEncTab
    .map(n => orig[n])
    .join('')
    .slice(0, 32)
}

/**
 * Adds wts and w_rid to request parameters (WBI signature).
 */
export function encodeWbi(params: Record<string, string | number>, wbiKeys: BilibiliWbiKeys): string {
  const mixin_key = getMixinKey(wbiKeys.img_key + wbiKeys.sub_key)
  const currentTime = Math.round(Date.now() / 1000)
  const charaFilter = /[!'()*]/g

  const paramsWithWts: Record<string, string | number> = { ...params, wts: currentTime }

  const sortedQuery = Object.keys(paramsWithWts)
    .sort()
    .map(key => {
      const resolvedValue = paramsWithWts[key]?.toString() ?? ''
      const value = resolvedValue.replace(charaFilter, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')

  const wbi_sign = md5(sortedQuery + mixin_key)

  const unsortedQuery = Object.keys(params)
    .map(key => {
      const resolvedValue = params[key]?.toString() ?? ''
      const value = resolvedValue.replace(charaFilter, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')

  return `${unsortedQuery}&w_rid=${wbi_sign}&wts=${currentTime}`
}
