/**
 * Gemini Live `SttEngine` (`gemini-3.5-transcribe-live`) — raw WebSocket, key in the URL. The server caps
 * each connection at ~10 min, so the engine swaps in a fresh one (on `goAway` or a drop) while the mic keeps running.
 */

import type { SttChunk, SttEngine, SttEngineEventHandler, SttSessionParams } from './types'

import { GEMINI_DEFAULT_MODEL } from '../const'
import { int16ToBase64 } from './audio'
import { buildGeminiLiveUrl } from './gemini-url'
import { parseGeminiLiveMessage } from './normalize'
import { PCM_SAMPLE_RATE, type PcmCapture, startPcmCapture } from './pcm-capture'

// Google's documented chunk size (~100 ms); the shared 256 ms default adds latency.
const FRAME_SAMPLES = 1600
const AUDIO_MIME_TYPE = `audio/pcm;rate=${PCM_SAMPLE_RATE}`
// Speech in a stream's first second is dropped (live-tested: 1 s of silence first saves it, 0.5 s doesn't).
const LEAD_IN_FRAMES = PCM_SAMPLE_RATE / FRAME_SAMPLES
const SILENT_FRAME = new Int16Array(FRAME_SAMPLES)
const SETUP_TIMEOUT_MS = 15_000
// `goAway` comes ~50 s ahead; wait this long for the utterance to end on its own before cutting it short.
const NATURAL_BREAK_WAIT_MS = 20_000
// How long a stop or swap waits for the final of an utterance cut short by `audioStreamEnd`.
const FINAL_GRACE_MS = 2000
// Only a connection that served this long is reconnected after an unexpected close, so a persistent fault can't loop.
const MIN_RETRY_LIFETIME_MS = 30_000
// ~10 s of audio held while a replacement connection sets up; the oldest frames drop first.
const MAX_BACKLOG_FRAMES = 100

interface LiveConnection {
  socket: WebSocket
  opened: boolean
  /** `Date.now()` at `setupComplete`; 0 until then. */
  readyAt: number
  /** An interim hypothesis is out that no final has replaced yet. */
  speaking: boolean
  setupTimer: ReturnType<typeof setTimeout> | null
}

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

function describeClose(event: CloseEvent, conn: LiveConnection): string {
  const reason = event.reason.trim()
  if (reason) return `连接已关闭（${event.code}）：${reason}`
  // The key is checked after the socket opens (close 1007), so a socket that never opened points at the network or address.
  if (!conn.opened) return '连接失败，请检查网络或接口地址'
  return `连接已关闭（${event.code}）`
}

export function createGeminiEngine(params: SttSessionParams, onEvent: SttEngineEventHandler): SttEngine {
  const decoder = new TextDecoder()
  const backlog: Int16Array<ArrayBuffer>[] = []
  const setupMessage = {
    setup: {
      // Typed ids may already carry the `models/` prefix that `models.list` returns.
      model: `models/${(params.model || GEMINI_DEFAULT_MODEL).replace(/^models\//, '')}`,
      generationConfig: { responseModalities: ['TEXT'] },
      // `[]` = auto-detect, including mid-stream language switches.
      inputAudioTranscription: { languageCodes: params.languageHints },
    },
  }
  let url = ''
  let settled = false
  let stopping = false
  let paused = false
  let connected = false
  let current: LiveConnection | null = null
  let capture: PcmCapture | null = null
  // Set while waiting on a final after `audioStreamEnd`; audio is held meanwhile so the stream stays ended.
  let afterDrain: (() => void) | null = null
  let drainTimer: ReturnType<typeof setTimeout> | null = null
  // Set while a `goAway` swap waits for a pause; audio keeps flowing to the old connection.
  let breakTimer: ReturnType<typeof setTimeout> | null = null

  const send = (conn: LiveConnection, message: object): void => {
    if (conn.socket.readyState === WebSocket.OPEN) conn.socket.send(JSON.stringify(message))
  }

  const sendAudio = (conn: LiveConnection, frame: Int16Array): void => {
    send(conn, { realtimeInput: { audio: { data: int16ToBase64(frame), mimeType: AUDIO_MIME_TYPE } } })
  }

  /** Detach and close a connection we're done with, so its late events are ignored. */
  const retire = (conn: LiveConnection): void => {
    if (conn.setupTimer) clearTimeout(conn.setupTimer)
    conn.socket.onopen = null
    conn.socket.onmessage = null
    conn.socket.onclose = null
    try {
      conn.socket.close()
    } catch {
      // closing a socket that never opened can throw
    }
  }

  const cancelDrain = (): void => {
    if (drainTimer) clearTimeout(drainTimer)
    drainTimer = null
    afterDrain = null
  }

  const completeDrain = (): void => {
    const next = afterDrain
    cancelDrain()
    next?.()
  }

  const cancelBreakWait = (): void => {
    if (breakTimer) clearTimeout(breakTimer)
    breakTimer = null
  }

  /** End the open utterance with `audioStreamEnd`, then run `next` once its final lands or the grace period lapses. */
  const drain = (conn: LiveConnection, next: () => void): void => {
    if (!conn.speaking) {
      next()
      return
    }
    send(conn, { realtimeInput: { audioStreamEnd: true } })
    afterDrain = next
    drainTimer = setTimeout(completeDrain, FINAL_GRACE_MS)
  }

  const teardown = (): void => {
    cancelDrain()
    cancelBreakWait()
    capture?.stop()
    capture = null
    backlog.length = 0
    if (current) retire(current)
    current = null
  }

  const finish = (): void => {
    if (settled) return
    settled = true
    teardown()
    onEvent({ type: 'state', state: 'stopped' })
    onEvent({ type: 'finished' })
  }

  const fail = (err: unknown): void => {
    if (settled) return
    settled = true
    teardown()
    onEvent({ type: 'error', error: toError(err) })
  }

  const onFrame = (frame: Int16Array<ArrayBuffer>): void => {
    if (paused || settled) return
    const conn = current
    if (conn && conn.readyAt > 0 && !afterDrain) {
      sendAudio(conn, frame)
      return
    }
    backlog.push(frame)
    if (backlog.length > MAX_BACKLOG_FRAMES) backlog.shift()
  }

  const beginAudio = async (): Promise<void> => {
    const cap = await startPcmCapture({ deviceId: params.audioDeviceId, frameSamples: FRAME_SAMPLES, onFrame })
    if (settled || stopping) {
      cap.stop()
      return
    }
    capture = cap
  }

  const handleReady = (conn: LiveConnection): void => {
    if (conn.readyAt > 0) return
    if (conn.setupTimer) clearTimeout(conn.setupTimer)
    conn.setupTimer = null
    conn.readyAt = Date.now()
    for (let i = 0; i < LEAD_IN_FRAMES; i++) sendAudio(conn, SILENT_FRAME)
    for (const frame of backlog.splice(0)) sendAudio(conn, frame)
    if (connected) return
    connected = true
    onEvent({ type: 'state', state: 'running' })
    onEvent({ type: 'connected' })
    void beginAudio().catch(err => fail(err))
  }

  const swap = (conn: LiveConnection): void => {
    retire(conn)
    connect()
  }

  /** Swap in a fresh connection before the one that sent `goAway` is cut off: at its next pause, or forced after a wait. */
  const rotate = (conn: LiveConnection): void => {
    if (breakTimer || afterDrain || stopping) return
    breakTimer = setTimeout(() => {
      breakTimer = null
      drain(conn, () => swap(conn))
    }, NATURAL_BREAK_WAIT_MS)
  }

  const handleMessage = (conn: LiveConnection, data: unknown): void => {
    // Google sends JSON in binary frames; `binaryType` makes those ArrayBuffers.
    const text = typeof data === 'string' ? data : data instanceof ArrayBuffer ? decoder.decode(data) : ''
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return
    }
    const message = parseGeminiLiveMessage(raw)
    if (message.setupComplete) handleReady(conn)
    if (message.goAway) rotate(conn)

    const chunks: SttChunk[] = []
    if (message.final !== undefined) {
      conn.speaking = false
      if (message.final) chunks.push({ text: message.final, isFinal: true, kind: 'original' })
    }
    if (message.interim) {
      conn.speaking = true
      chunks.push({ text: message.interim, isFinal: false, kind: 'original' })
    }
    if (chunks.length > 0) onEvent({ type: 'transcript', chunks })
    if (message.final) onEvent({ type: 'endpoint' })
    // Between utterances (immediately, for a `goAway` that arrives in silence): run any pending swap or drain.
    if (conn.speaking) return
    if (breakTimer) {
      cancelBreakWait()
      swap(conn)
    }
    if (afterDrain) completeDrain()
  }

  const handleClose = (conn: LiveConnection, event: CloseEvent): void => {
    if (conn !== current || settled) return
    if (stopping) {
      finish()
      return
    }
    if (conn.readyAt === 0 || Date.now() - conn.readyAt < MIN_RETRY_LIFETIME_MS) {
      fail(new Error(describeClose(event, conn)))
      return
    }
    // Dropped mid-session (e.g. the cap hit without a `goAway`): reconnect while capture fills the backlog.
    cancelDrain()
    cancelBreakWait()
    connect()
  }

  const connect = (): void => {
    try {
      const socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      const conn: LiveConnection = { socket, opened: false, readyAt: 0, speaking: false, setupTimer: null }
      current = conn
      conn.setupTimer = setTimeout(() => {
        if (conn === current) fail(new Error('连接超时：服务器未响应'))
      }, SETUP_TIMEOUT_MS)
      socket.onopen = () => {
        conn.opened = true
        send(conn, setupMessage)
      }
      socket.onmessage = event => {
        if (conn === current && !settled) handleMessage(conn, event.data)
      }
      socket.onclose = event => handleClose(conn, event)
    } catch (err) {
      fail(err)
    }
  }

  const start = (): void => {
    try {
      url = buildGeminiLiveUrl(params.baseUrl ?? '', params.apiKey)
    } catch (err) {
      fail(err)
      return
    }
    connect()
  }

  const stop = async (): Promise<void> => {
    if (settled || stopping) return
    stopping = true
    cancelBreakWait()
    onEvent({ type: 'state', state: 'stopping' })
    capture?.stop()
    capture = null
    backlog.length = 0
    const conn = current
    if (!conn || conn.readyAt === 0) {
      finish()
      return
    }
    // A swap is already waiting on this connection's final: finish there instead of reconnecting.
    if (afterDrain) {
      afterDrain = finish
      return
    }
    drain(conn, finish)
  }

  const cancel = (): void => {
    settled = true
    teardown()
  }

  const pause = (): void => {
    paused = true
  }

  const resume = (): void => {
    paused = false
  }

  // `audioStreamEnd` finalizes the open utterance now; the next audio frame reopens the stream.
  const finalize = (): void => {
    const conn = current
    if (conn && conn.readyAt > 0 && !afterDrain) send(conn, { realtimeInput: { audioStreamEnd: true } })
  }

  return { start, stop, cancel, pause, resume, finalize }
}
