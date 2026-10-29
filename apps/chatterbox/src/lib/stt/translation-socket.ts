import type { SttEngine, SttEngineEvent, SttEngineEventHandler } from './types'

import { STT_STOP_TIMEOUT_MS } from '../const'
import { type PcmCapture, startPcmCapture } from './pcm-capture'

interface TranslationSocketControls {
  ready: () => void
  emit: (event: SttEngineEvent) => void
  finish: () => void
  fail: (error: Error) => void
}

export interface TranslationSocketConfig {
  deviceId: string
  sampleRate: number
  connect: (signal: AbortSignal) => Promise<{ url: string; protocols?: string[] }>
  audio: (frame: Int16Array<ArrayBuffer>) => unknown
  onMessage: (value: unknown, controls: TranslationSocketControls) => void
  stopMessage: unknown
}

const CONNECT_TIMEOUT_MS = 15_000
const DRAIN_TIMEOUT_MS = STT_STOP_TIMEOUT_MS - 1000
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024

/** Capture and drain a translation session without dropping its final text. */
export function createTranslationSocket(config: TranslationSocketConfig, onEvent: SttEngineEventHandler): SttEngine {
  const decoder = new TextDecoder()
  const controller = new AbortController()
  let socket: WebSocket | null = null
  let capture: PcmCapture | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false
  let settled = false
  let stopping = false
  let ready = false
  let paused = false
  let resolveStopped: () => void = () => {}
  const stopped = new Promise<void>(resolve => {
    resolveStopped = resolve
  })

  const releaseCapture = () => {
    capture?.stop()
    capture = null
  }

  const cleanup = () => {
    settled = true
    clearTimeout(timer)
    controller.abort()
    releaseCapture()
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      try {
        socket.close()
      } catch {}
    }
    resolveStopped()
  }

  const finish = () => {
    if (settled) return
    cleanup()
    onEvent({ type: 'state', state: 'stopped' })
    onEvent({ type: 'finished' })
  }

  const fail = (error: unknown) => {
    if (settled) return
    cleanup()
    onEvent({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) })
  }

  const send = (value: unknown) => {
    if (settled || socket?.readyState !== WebSocket.OPEN) return
    try {
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) throw new Error('同传连接发送积压，请重新连接')
      socket.send(JSON.stringify(value))
    } catch (error) {
      fail(error)
    }
  }

  const beginCapture = () => {
    if (settled || stopping || ready) return
    ready = true
    void startPcmCapture({
      deviceId: config.deviceId,
      sampleRate: config.sampleRate,
      frameSamples: config.sampleRate / 10,
      onFrame: frame => {
        if (!settled && !stopping) send(config.audio(paused ? new Int16Array(frame.length) : frame))
      },
    })
      .then(value => {
        if (settled || stopping) {
          value.stop()
          return
        }
        capture = value
        clearTimeout(timer)
        onEvent({ type: 'state', state: 'running' })
        onEvent({ type: 'connected' })
      })
      .catch(fail)
  }

  const start = () => {
    if (started || settled) return
    started = true
    onEvent({ type: 'state', state: 'connecting' })
    timer = setTimeout(() => fail(new Error(ready ? '同传麦克风启动超时' : '同传服务连接超时')), CONNECT_TIMEOUT_MS)
    void config
      .connect(controller.signal)
      .then(connection => {
        if (settled) return
        const ws = new WebSocket(connection.url, connection.protocols)
        socket = ws
        ws.binaryType = 'arraybuffer'
        ws.onmessage = event => {
          if (settled) return
          let value: unknown
          try {
            const raw = event.data instanceof ArrayBuffer ? decoder.decode(event.data) : event.data
            if (typeof raw !== 'string') return
            value = JSON.parse(raw)
          } catch {
            return
          }
          try {
            config.onMessage(value, {
              ready: beginCapture,
              emit: event => {
                if (!settled) onEvent(event)
              },
              finish,
              fail,
            })
          } catch (error) {
            fail(error)
          }
        }
        ws.onerror = () => fail(new Error('同传 WebSocket 连接失败'))
        ws.onclose = () => fail(new Error(stopping ? '同传连接在最终结果返回前关闭' : '同传连接意外关闭'))
      })
      .catch(fail)
  }

  const stop = () => {
    if (settled || stopping) return stopped
    stopping = true
    releaseCapture()
    if (!ready || socket?.readyState !== WebSocket.OPEN) {
      finish()
      return stopped
    }
    onEvent({ type: 'state', state: 'stopping' })
    clearTimeout(timer)
    timer = setTimeout(() => fail(new Error('同传最终结果等待超时')), DRAIN_TIMEOUT_MS)
    send(config.stopMessage)
    return stopped
  }

  return {
    start,
    stop,
    cancel: () => {
      if (!settled) cleanup()
    },
    pause: () => {
      paused = true
    },
    resume: () => {
      paused = false
    },
    finalize: () => {},
  }
}
