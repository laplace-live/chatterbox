import type { GmAbortHandle, GmResponseEventBase } from '$'

import { GM_xmlhttpRequest } from '$'

const NULL_BODY_STATUSES = new Set([204, 205, 304])

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
  // `Response` only takes 200–599; anything else (e.g. status 0) is a transport failure.
  if (status < 200 || status > 599) throw new TypeError('Failed to fetch')
  return new Response(NULL_BODY_STATUSES.has(status) ? null : responseText, {
    status,
    statusText,
    headers: parseHeaders(responseHeaders ?? ''),
  })
}

/**
 * `fetch` via the userscript manager, so CORS, mixed-content and private-network blocks don't apply.
 * Text bodies only; cookies only with `credentials: 'include'`. Rejects like `fetch`: the signal's reason on abort, else `TypeError`.
 */
export function gmFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const { signal } = init
  const abortReason = () => signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
  let onAbort = () => {}
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason())
      return
    }
    let request: GmAbortHandle | undefined
    onAbort = () => {
      reject(abortReason())
      request?.abort()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // A promise settles once, so callbacks after an abort (e.g. the `onabort` it triggers) are no-ops.
    request = GM_xmlhttpRequest({
      method: init.method ?? 'GET',
      url,
      headers: Object.fromEntries(new Headers(init.headers)),
      data: init.body ?? undefined,
      anonymous: init.credentials !== 'include',
      onload: event => {
        try {
          resolve(toResponse(event))
        } catch (err) {
          reject(err)
        }
      },
      onerror: event => reject(new TypeError(event?.error || 'Failed to fetch')),
      ontimeout: () => reject(new TypeError('Network request timed out')),
      onabort: () => reject(abortReason()),
    })
  }).finally(() => signal?.removeEventListener('abort', onAbort))
}
