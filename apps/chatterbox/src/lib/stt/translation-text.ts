import type { SttChunk, SttEngineEventHandler } from './types'

const IDLE_FLUSH_MS = 5000

/** Keep incomplete translated words out of the final text sent as danmaku. */
export function createTranslationText(onEvent: SttEngineEventHandler) {
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (!pending) return
    const text = pending
    pending = ''
    onEvent({ type: 'transcript', chunks: [{ text, isFinal: true, kind: 'translation' }] })
    onEvent({ type: 'endpoint' })
  }

  const push = (delta: string) => {
    if (!delta) return
    clearTimeout(timer)
    pending += delta
    let boundary = 0
    // A period alone may be the beginning of a decimal, domain, or version number.
    for (const match of pending.matchAll(/[!?。！？]["'”’）)]*\s*|\.["'”’）)]*\s+/gu)) {
      boundary = match.index + match[0].length
    }
    const chunks: SttChunk[] = []
    if (boundary) {
      chunks.push({ text: pending.slice(0, boundary), isFinal: true, kind: 'translation' })
      pending = pending.slice(boundary)
    }
    chunks.push({ text: pending, isFinal: false, kind: 'translation' })
    onEvent({ type: 'transcript', chunks })
    if (boundary) onEvent({ type: 'endpoint' })
    timer = pending ? setTimeout(flush, IDLE_FLUSH_MS) : undefined
  }

  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
    pending = ''
  }

  return { push, flush, cancel }
}
