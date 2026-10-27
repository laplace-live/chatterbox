import type { GmResponseEventBase } from '$'

import { GM_xmlhttpRequest } from '$'

const NULL_BODY_STATUSES = new Set([204, 205, 304])

export interface GmFetchInit extends RequestInit {
  /** Reject with a `TimeoutError` after this many ms, including time spent on a pending @connect prompt. */
  timeout?: number
}

function parseHeaders(raw: string): Headers {
  const headers = new Headers()
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon < 1) continue
    try {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
    } catch {
      // skip a header `Headers` refuses (invalid name or non-Latin-1 value)
    }
  }
  return headers
}

function toResponse({ status, statusText, responseHeaders, responseText }: GmResponseEventBase<'text'>): Response {
  // `Response` only takes 200–599; anything else (status 0, missing, NaN) is a transport failure.
  if (!(status >= 200 && status <= 599)) throw new TypeError('Failed to fetch')
  return new Response(NULL_BODY_STATUSES.has(status) ? null : responseText, {
    status,
    statusText,
    headers: parseHeaders(responseHeaders ?? ''),
  })
}

/**
 * `fetch` via the userscript manager, so CORS, mixed-content and private-network blocks don't apply.
 * Reads responses as text; sends cookies only with `credentials: 'include'`; rejects like `fetch`.
 */
export function gmFetch(url: string, init: GmFetchInit = {}): Promise<Response> {
  const { signal, timeout } = init
  let cleanup = () => {}
  return new Promise<Response>((resolve, reject) => {
    signal?.throwIfAborted()
    const timedOut = () => new DOMException(`Timed out after ${timeout} ms`, 'TimeoutError')
    // A promise settles once, so callbacks after an abort or timeout (e.g. the `onabort` it triggers) are no-ops.
    const request = GM_xmlhttpRequest({
      method: init.method ?? 'GET',
      url,
      headers: Object.fromEntries(new Headers(init.headers)),
      data: init.body ?? undefined,
      anonymous: init.credentials !== 'include',
      timeout,
      onload: event => {
        try {
          resolve(toResponse(event))
        } catch (err) {
          reject(err)
        }
      },
      onerror: event => reject(new TypeError(event?.error || 'Failed to fetch')),
      ontimeout: () => reject(timedOut()),
      // An abort the manager starts itself (e.g. the script being disabled) is a transport failure, not the caller's cancel.
      onabort: () =>
        reject(signal?.aborted ? signal.reason : new TypeError('Request aborted by the userscript manager')),
    })
    const cancel = (reason: unknown) => {
      reject(reason)
      // Some managers (e.g. FireMonkey) return no abort handle.
      request?.abort?.()
    }
    const onAbort = () => cancel(signal?.reason)
    // GM's own `timeout` doesn't cover a pending @connect prompt, so a page timer backs it up.
    const timer = timeout ? setTimeout(() => cancel(timedOut()), timeout) : undefined
    signal?.addEventListener('abort', onAbort, { once: true })
    cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }).finally(() => cleanup())
}
