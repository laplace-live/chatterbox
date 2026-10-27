import type { GmAbortHandle, GmResponseEvent, GmResponseEventBase, GmXmlhttpRequestOption } from '$'

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

/** Stand-in for the manager's `GM_xmlhttpRequest`: records each call instead of sending it. */
export function GM_xmlhttpRequest(options: GmXmlhttpRequestOption<'text', unknown>): GmAbortHandle {
  const request: FakeGmRequest = {
    options,
    aborted: 0,
    respond(status, body = '', headers = {}) {
      const event: GmResponseEvent<'text', unknown> = {
        status,
        statusText: '',
        responseHeaders: Object.entries(headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join('\r\n'),
        responseText: body,
        response: body,
        responseXML: null,
        readyState: 4,
        finalUrl: options.url,
        context: options.context,
      }
      options.onload?.call(event, event)
    },
    fail(error = '') {
      const event: GmResponseEventBase<'text'> & { error: string } = {
        status: 0,
        statusText: '',
        responseHeaders: '',
        responseText: '',
        response: '',
        responseXML: null,
        readyState: 4,
        error,
      }
      options.onerror?.call(event, event)
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
