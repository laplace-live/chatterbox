/**
 * Gemini Live transcription and translation over WebSocket. Connections rotate on `goAway` while capture continues.
 */

import type { SttChunk, SttEngine, SttEngineEventHandler, SttSessionParams } from './types'

import { GEMINI_DEFAULT_MODEL, GEMINI_TRANSLATION_STOP_TIMEOUT_MS, STT_STOP_TIMEOUT_MS } from '../const'
import { int16ToBase64 } from './audio'
import { translationCapabilities } from './capabilities'
import { buildGeminiLiveUrl } from './gemini-url'
import { parseGeminiLiveMessage, parseGeminiTranslationMessage, readField } from './normalize'
import { PCM_SAMPLE_RATE, type PcmCapture, startPcmCapture } from './pcm-capture'
import { createTranslationText } from './translation-text'

// Google's documented chunk size (~100 ms); the shared 256 ms default adds latency.
const FRAME_SAMPLES = 1600
const FRAME_MS = (FRAME_SAMPLES / PCM_SAMPLE_RATE) * 1000
const AUDIO_MIME_TYPE = `audio/pcm;rate=${PCM_SAMPLE_RATE}`
// Speech in a stream's first second is dropped (live-tested: 1 s of silence first saves it, 0.5 s doesn't).
const LEAD_IN_FRAMES = PCM_SAMPLE_RATE / FRAME_SAMPLES
const SILENT_FRAME = new Int16Array(FRAME_SAMPLES)
const SETUP_TIMEOUT_MS = 15_000
// `goAway` comes ~50 s ahead; wait this long for the utterance to end on its own before cutting it short.
const NATURAL_BREAK_WAIT_MS = 20_000
// How long a stop or forced swap waits for a final after `audioStreamEnd`; past it, the last interim stands in.
const FINAL_GRACE_MS = 2000
// The same wait with no interim out yet, for speech that started too recently to have one.
const QUIET_GRACE_MS = 1000
// Continuous translation may omit turn markers; drain until text has been quiet for this long.
const TRANSLATION_GRACE_MS = 5000
// Only a connection that served this long is reconnected after an unexpected close, so a persistent fault can't loop.
const MIN_RETRY_LIFETIME_MS = 30_000
// Audio held through a drain plus the longest setup; a replacement slower than that fails on its setup timeout instead.
const MAX_BACKLOG_FRAMES = Math.ceil((STT_STOP_TIMEOUT_MS + SETUP_TIMEOUT_MS) / FRAME_MS)
// A stop waiting on a reconnect or a final still finishes before the tab force-cancels it.
const STOP_DEADLINE_MS = STT_STOP_TIMEOUT_MS - 2000

interface LiveConnection {
  socket: WebSocket
  opened: boolean
  /** `Date.now()` at `setupComplete`; 0 until then. */
  readyAt: number
  /** Latest interim hypothesis that no final has replaced yet; '' between utterances. */
  interim: string
  setupTimer: ReturnType<typeof setTimeout>
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
  const translationText = createTranslationText(onEvent)
  const backlog: Int16Array<ArrayBuffer>[] = []
  const model = (params.model.trim() || GEMINI_DEFAULT_MODEL).replace(/^models\//, '')
  const translating = translationCapabilities('gemini', model).mode === 'required'
  const targetLanguage = params.translation?.targetLanguage.trim()
  const setupMessage = {
    setup: {
      model: `models/${model}`,
      generationConfig: translating
        ? {
            responseModalities: ['AUDIO'],
            translationConfig: { targetLanguageCode: targetLanguage, echoTargetLanguage: true },
          }
        : { responseModalities: ['TEXT'] },
      // `[]` = auto-detect, including mid-stream language switches.
      inputAudioTranscription: translating ? {} : { languageCodes: params.languageHints },
      ...(translating ? { outputAudioTranscription: {} } : {}),
    },
  }
  let url = ''
  let settled = false
  let stopping = false
  let paused = false
  let connected = false
  let current: LiveConnection | null = null
  let capture: PcmCapture | null = null
  const captureAbort = new AbortController()
  // Set while waiting on a final after `audioStreamEnd`; audio is held meanwhile so the stream stays ended.
  let afterDrain: (() => void) | null = null
  let drainTimer: ReturnType<typeof setTimeout> | null = null
  let drainDeadline = 0
  // Set while a `goAway` swap waits for a pause; audio keeps flowing to the old connection.
  let breakTimer: ReturnType<typeof setTimeout> | null = null
  let stopTimer: ReturnType<typeof setTimeout> | null = null
  let stopDeadline = 0

  const send = (conn: LiveConnection, message: object): void => {
    if (conn.socket.readyState === WebSocket.OPEN) conn.socket.send(JSON.stringify(message))
  }

  const sendAudio = (conn: LiveConnection, frame: Int16Array): void => {
    send(conn, { realtimeInput: { audio: { data: int16ToBase64(frame), mimeType: AUDIO_MIME_TYPE } } })
  }

  /** Detach and close a connection we're done with, so its late events are ignored. */
  const retire = (conn: LiveConnection): void => {
    clearTimeout(conn.setupTimer)
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
    drainDeadline = 0
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

  /** Deliver a connection's open utterance as final once its own final can no longer arrive. */
  const commitInterim = (conn: LiveConnection): void => {
    if (!conn.interim) return
    onEvent({ type: 'transcript', chunks: [{ text: conn.interim, isFinal: true, kind: 'original' }] })
    onEvent({ type: 'endpoint' })
    conn.interim = ''
  }

  const expireDrain = (conn: LiveConnection): void => {
    if (translating && Date.now() >= drainDeadline) {
      fail(new Error('等待 Gemini 同传最终结果超时'))
      return
    }
    commitInterim(conn)
    completeDrain()
  }

  /** End the stream with `audioStreamEnd`, then run `next` once a final lands or the grace period lapses. */
  const drain = (conn: LiveConnection, next: () => void): void => {
    send(conn, { realtimeInput: { audioStreamEnd: true } })
    afterDrain = next
    drainDeadline = translating && stopping ? stopDeadline : Date.now() + STOP_DEADLINE_MS
    drainTimer = setTimeout(
      () => expireDrain(conn),
      translating ? TRANSLATION_GRACE_MS : conn.interim ? FINAL_GRACE_MS : QUIET_GRACE_MS
    )
  }

  const stopCapture = (): void => {
    captureAbort.abort()
    capture?.stop()
    capture = null
  }

  const teardown = (): void => {
    translationText.cancel()
    cancelDrain()
    cancelBreakWait()
    if (stopTimer) clearTimeout(stopTimer)
    stopTimer = null
    stopCapture()
    backlog.length = 0
    if (current) retire(current)
    current = null
  }

  const finish = (): void => {
    if (settled) return
    translationText.flush()
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
    // A socket the server is closing can't take audio; buffer it for the reconnect.
    if (conn && conn.readyAt > 0 && !afterDrain && conn.socket.readyState === WebSocket.OPEN) {
      sendAudio(conn, frame)
      return
    }
    backlog.push(frame)
    if (backlog.length > MAX_BACKLOG_FRAMES) backlog.shift()
  }

  const beginAudio = async (): Promise<void> => {
    const cap = await startPcmCapture({
      deviceId: params.audioDeviceId,
      frameSamples: FRAME_SAMPLES,
      signal: captureAbort.signal,
      onFrame,
    })
    if (settled || stopping) {
      cap.stop()
      return
    }
    capture = cap
  }

  const handleReady = (conn: LiveConnection): void => {
    if (conn.readyAt > 0) return
    clearTimeout(conn.setupTimer)
    conn.readyAt = Date.now()
    for (let i = 0; i < LEAD_IN_FRAMES; i++) sendAudio(conn, SILENT_FRAME)
    for (const frame of backlog.splice(0)) sendAudio(conn, frame)
    if (stopping) {
      drain(conn, finish)
      return
    }
    if (connected) return
    connected = true
    onEvent({ type: 'state', state: 'running' })
    onEvent({ type: 'connected' })
    void beginAudio().catch(err => {
      if (!stopping && !settled) fail(err)
    })
  }

  const swap = (conn: LiveConnection): void => {
    translationText.flush()
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
    if (readField(raw, 'setupComplete') !== undefined) handleReady(conn)
    if (readField(raw, 'goAway') !== undefined) rotate(conn)

    if (translating) {
      const result = parseGeminiTranslationMessage(raw)
      if (result.error) {
        fail(new Error(result.error))
        return
      }
      if (result.original) {
        onEvent({ type: 'transcript', chunks: [{ text: result.original, isFinal: true, kind: 'original' }] })
      }
      if (result.translation) translationText.push(result.translation)
      if (result.complete) translationText.flush()
      if (result.complete) {
        if (afterDrain) completeDrain()
        else if (breakTimer) {
          cancelBreakWait()
          drain(conn, () => swap(conn))
        }
      } else if (afterDrain && (result.original || result.translation)) {
        if (drainTimer) clearTimeout(drainTimer)
        drainTimer = setTimeout(
          () => expireDrain(conn),
          Math.max(0, Math.min(TRANSLATION_GRACE_MS, drainDeadline - Date.now()))
        )
      }
      return
    }

    const message = parseGeminiLiveMessage(raw)
    const chunks: SttChunk[] = []
    if (message.final !== undefined) {
      conn.interim = ''
      if (message.final) chunks.push({ text: message.final, isFinal: true, kind: 'original' })
    }
    if (message.interim) {
      conn.interim = message.interim
      chunks.push({ text: message.interim, isFinal: false, kind: 'original' })
    }
    // A final ends the utterance even without text, so the stale interim still clears.
    if (chunks.length > 0 || message.final !== undefined) onEvent({ type: 'transcript', chunks })
    if (message.final !== undefined) onEvent({ type: 'endpoint' })
    // Only a final that leaves nothing open is a pause: speech too new for an interim may already be on the socket.
    if (message.final === undefined || conn.interim) return
    if (afterDrain) {
      completeDrain()
    } else if (breakTimer) {
      cancelBreakWait()
      // The next utterance may have started while this final was in flight; end its stream before retiring it.
      drain(conn, () => swap(conn))
    }
  }

  const handleClose = (conn: LiveConnection, event: CloseEvent): void => {
    if (conn !== current || settled) return
    if (stopping) {
      if (translating && event.code !== 1000) {
        fail(new Error(describeClose(event, conn)))
        return
      }
      commitInterim(conn)
      finish()
      return
    }
    if (conn.readyAt === 0 || Date.now() - conn.readyAt < MIN_RETRY_LIFETIME_MS) {
      fail(new Error(describeClose(event, conn)))
      return
    }
    // Dropped mid-session (e.g. the cap hit without a `goAway`): keep what it heard, reconnect while capture fills the backlog.
    translationText.flush()
    commitInterim(conn)
    cancelDrain()
    cancelBreakWait()
    connect()
  }

  const connect = (): void => {
    try {
      const socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      const conn: LiveConnection = {
        socket,
        opened: false,
        readyAt: 0,
        interim: '',
        setupTimer: setTimeout(() => {
          if (conn === current) fail(new Error('连接超时：服务器未响应'))
        }, SETUP_TIMEOUT_MS),
      }
      current = conn
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
    if (translating && !targetLanguage) {
      fail(new Error('请为 Gemini 同传选择翻译目标语言'))
      return
    }
    if (!translating && params.translation) {
      fail(new Error('当前 Gemini 模型仅支持转录，请选择 Live Translate 模型进行同传'))
      return
    }
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
    stopCapture()
    const stopBudget = translating ? GEMINI_TRANSLATION_STOP_TIMEOUT_MS - 2000 : STOP_DEADLINE_MS
    stopDeadline = Date.now() + stopBudget
    stopTimer = setTimeout(() => {
      if (translating) {
        fail(new Error('等待 Gemini 同传最终结果超时'))
        return
      }
      if (current) commitInterim(current)
      finish()
    }, stopBudget)
    const conn = current
    // A replacement still setting up gets the buffered audio first (`handleReady`), then drains.
    if (conn && conn.readyAt === 0 && backlog.length > 0) return
    if (!conn || conn.readyAt === 0) {
      finish()
      return
    }
    // A swap is already draining this connection: audio queued for the replacement rides the swap, else finish here.
    if (afterDrain) {
      if (translating) {
        drainDeadline = stopDeadline
        if (drainTimer) clearTimeout(drainTimer)
        drainTimer = setTimeout(() => expireDrain(conn), TRANSLATION_GRACE_MS)
      }
      if (backlog.length === 0) afterDrain = finish
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
