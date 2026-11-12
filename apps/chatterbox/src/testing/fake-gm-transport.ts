import type { GmAbortHandle, GmResponseEventBase, GmXmlhttpRequestOption } from '$'

/** One recorded `GM_xmlhttpRequest` call; the test settles it. */
export interface FakeGmRequest {
  options: GmXmlhttpRequestOption<'text', unknown>
  /** How many times `abort()` was called. */
  aborted: number
  /** Deliver an HTTP response to `onload`. */
  respond(status: number, body?: string, headers?: Record<string, string>): void
  /** Fire `onerror`, as for a refused connection or a denied @connect prompt. */
  fail(error?: string): void
  /** Fire `ontimeout`. */
  timeOut(): void
}

export const requests: FakeGmRequest[] = []

const seededStore: unknown = Reflect.get(globalThis, '__FAKE_GM_SEED_KEY__')
export const store: Map<string, unknown> = seededStore instanceof Map ? seededStore : new Map()

/** Stand-in for `GM_getValue`: reads from the isolated in-memory `store`. */
export function GM_getValue<T = unknown>(key: string, defaultValue?: T): T {
  return (store.has(key) ? store.get(key) : defaultValue) as T
}

/** Stand-in for `GM_setValue`: writes to the isolated in-memory `store`. */
export function GM_setValue(key: string, value: unknown): void {
  store.set(key, value)
}

/** Stand-in for `GM_deleteValue`: removes `key` from the isolated in-memory `store`. */
export function GM_deleteValue(key: string): void {
  store.delete(key)
}

/** Stand-in for `GM_listValues`: lists keys in the isolated in-memory `store`. */
export function GM_listValues(): string[] {
  return [...store.keys()]
}

/** No-op stand-in for `GM_addValueChangeListener`. */
export function GM_addValueChangeListener(): string {
  return ''
}

function event(status: number, body = '', responseHeaders = ''): GmResponseEventBase<'text'> {
  return {
    status,
    statusText: '',
    responseHeaders,
    responseText: body,
    response: body,
    responseXML: null,
    readyState: 4,
  }
}

/** Stand-in for the manager's `GM_xmlhttpRequest`: records each call instead of sending it. */
export function GM_xmlhttpRequest(options: GmXmlhttpRequestOption<'text', unknown>): GmAbortHandle {
  const request: FakeGmRequest = {
    options,
    aborted: 0,
    respond(status, body = '', headers = {}) {
      const raw = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join('\r\n')
      const loaded = { ...event(status, body, raw), finalUrl: options.url, context: options.context }
      options.onload?.call(loaded, loaded)
    },
    fail(error = '') {
      const failed = { ...event(0), error }
      options.onerror?.call(failed, failed)
    },
    timeOut() {
      options.ontimeout?.()
    },
  }
  requests.push(request)
  return {
    abort() {
      request.aborted++
      options.onabort?.()
    },
  }
}
