/** Shared mic or live-player → 16 kHz mono PCM16 capture via a blob-loaded AudioWorklet. */

import { appendLog } from '../log'
import { floatTo16 } from './audio'
import { acquirePageAudio, bindPageAudio, WEB_AUDIO_DEVICE_ID } from './page-audio'

export { WEB_AUDIO_DEVICE_ID }

/** Default capture sample rate in Hz. */
export const PCM_SAMPLE_RATE = 16000

const DEFAULT_FRAME_SAMPLES = 4096

// Emit zero samples when disconnected so downstream sockets stay alive and VAD flushes open segments.
const PCM_TAP_PROCESSOR = `
class PcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this._size = options.processorOptions.frameSize
    this._buf = new Float32Array(this._size)
    this._n = 0
  }
  process(inputs) {
    const channel = inputs[0]?.[0]
    const len = channel ? channel.length : 128
    for (let i = 0; i < len; i++) {
      this._buf[this._n++] = channel ? channel[i] : 0
      if (this._n === this._size) {
        const frame = this._buf.slice(0)
        this.port.postMessage(frame, [frame.buffer])
        this._n = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-tap', PcmTapProcessor)
`

export interface PcmCapture {
  /** Stop capture and release the audio source + graph. Idempotent. */
  stop: () => void
}

export interface PcmCaptureOptions {
  /** Microphone device id, '' for system default, or {@link WEB_AUDIO_DEVICE_ID} for live-player audio. */
  deviceId: string
  /** Samples per `onFrame` block; defaults to 4096 (256 ms). */
  frameSamples?: number
  /** Capture sample rate in Hz; defaults to 16000. */
  sampleRate?: number
  /** Optional abort signal cancelling pending source acquisition. */
  signal?: AbortSignal
  /** Called with each Int16 PCM block (little-endian, mono). */
  onFrame: (frame: Int16Array<ArrayBuffer>) => void
}

async function createWorkletSink(
  context: AudioContext,
  opts: PcmCaptureOptions
): Promise<{ node: AudioWorkletNode; teardownSink: () => void }> {
  const moduleUrl = URL.createObjectURL(new Blob([PCM_TAP_PROCESSOR], { type: 'application/javascript' }))
  try {
    await context.audioWorklet.addModule(moduleUrl)
  } finally {
    URL.revokeObjectURL(moduleUrl)
  }
  if (opts.signal?.aborted) {
    throw opts.signal.reason instanceof Error ? opts.signal.reason : new DOMException('Aborted', 'AbortError')
  }
  const node = new AudioWorkletNode(context, 'pcm-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    // Downmix stereo `captureStream()` sources (`0.5 * (L + R)`) before `PcmTapProcessor` reads channel 0.
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { frameSize: opts.frameSamples ?? DEFAULT_FRAME_SAMPLES },
  })
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    opts.onFrame(floatTo16(event.data))
  }
  // Muted sink: worklets need a path to destination to be pulled without echoing to speakers.
  const zeroGain = context.createGain()
  zeroGain.gain.value = 0
  node.connect(zeroGain)
  zeroGain.connect(context.destination)

  return {
    node,
    teardownSink: () => {
      node.port.onmessage = null
      node.disconnect()
      zeroGain.disconnect()
    },
  }
}

/** Start capturing mono PCM16 frames from the selected microphone or live-player stream. */
export async function startPcmCapture(opts: PcmCaptureOptions): Promise<PcmCapture> {
  if (opts.deviceId === WEB_AUDIO_DEVICE_ID) {
    const initial = await acquirePageAudio({ signal: opts.signal })
    const context = new AudioContext({ sampleRate: opts.sampleRate ?? PCM_SAMPLE_RATE })
    try {
      const { node, teardownSink } = await createWorkletSink(context, opts)
      const binding = bindPageAudio({ context, destination: node, initial, onLog: appendLog })
      void context.resume().catch(() => {})

      let stopped = false
      return {
        stop: () => {
          if (stopped) return
          stopped = true
          teardownSink()
          binding.stop()
          void context.close().catch(() => {})
        },
      }
    } catch (err) {
      initial.release()
      void context.close().catch(() => {})
      throw err
    }
  }

  const constraints: MediaStreamConstraints = {
    audio: {
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
      // DSP off explicitly: raw transcribes best, and pinning a device otherwise re-enables browser defaults.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  }
  const stream = await navigator.mediaDevices.getUserMedia(constraints)
  const context = new AudioContext({ sampleRate: opts.sampleRate ?? PCM_SAMPLE_RATE })
  try {
    const source = context.createMediaStreamSource(stream)
    const { node, teardownSink } = await createWorkletSink(context, opts)
    source.connect(node)
    void context.resume().catch(() => {})

    let stopped = false
    return {
      stop: () => {
        if (stopped) return
        stopped = true
        teardownSink()
        source.disconnect()
        for (const track of stream.getTracks()) track.stop()
        void context.close().catch(() => {})
      },
    }
  } catch (err) {
    for (const track of stream.getTracks()) track.stop()
    void context.close().catch(() => {})
    throw err
  }
}
