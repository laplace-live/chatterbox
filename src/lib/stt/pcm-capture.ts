/**
 * Shared microphone → PCM16 capture for the raw-WebSocket STT engines
 * (ElevenLabs, Deepgram).
 *
 * Pins an AudioContext to 16 kHz so the browser resamples the mic for us, taps
 * the stream with an AudioWorklet (off the main thread), and posts fixed-size
 * Float32 frames back for conversion to little-endian Int16 via `onFrame`. Each
 * engine decides what to do with a frame: base64-in-JSON for ElevenLabs, raw
 * binary for Deepgram.
 *
 * The worklet module is loaded from a runtime Blob URL — a single-file
 * userscript has no separate asset to point `addModule()` at. That's fine on
 * the Bilibili pages this script targets: none enforce a `script-src` CSP that
 * blocks blob modules (`live.`/`www.` send no CSP; `space.` is report-only).
 */

import { floatTo16 } from './audio'

/** Sample rate the capture is pinned to; also what engines report to the server. */
export const PCM_SAMPLE_RATE = 16000

// 4096 samples ≈ 256 ms at 16 kHz — a good latency/overhead balance, and the
// frame cadence the STT engines already stream at. The worklet accumulates to
// this size so the wire behaviour matches the previous ScriptProcessor.
const FRAME_SAMPLES = 4096

// AudioWorklet processor source, blob-loaded at runtime (see file header). Kept
// as a string so it stays self-contained and out of the typed/linted graph —
// it runs in AudioWorkletGlobalScope, not the DOM. It only batches: collect
// mono input into a fixed Float32 buffer and post each full frame to the main
// thread (buffer transferred, zero-copy). All DSP stays in `floatTo16`.
const PCM_TAP_PROCESSOR = `
class PcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this._size = options.processorOptions.frameSize
    this._buf = new Float32Array(this._size)
    this._n = 0
  }
  process(inputs) {
    const channel = inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      this._buf[this._n++] = channel[i]
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
  /** Stop capture and release the mic + audio graph. Idempotent. */
  stop: () => void
}

export interface PcmCaptureOptions {
  /** Microphone device id; '' = system default. */
  deviceId: string
  /** Called with each Int16 PCM block (little-endian, 16 kHz, mono). */
  onFrame: (frame: Int16Array<ArrayBuffer>) => void
}

export async function startPcmCapture(opts: PcmCaptureOptions): Promise<PcmCapture> {
  const constraints: MediaStreamConstraints = {
    audio: {
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
      // DSP off — raw audio transcribes best, and pinning a device shouldn't
      // silently re-enable the browser's echo-cancellation / NS / AGC defaults.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  }
  const stream = await navigator.mediaDevices.getUserMedia(constraints)
  const context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE })
  try {
    const source = context.createMediaStreamSource(stream)
    const moduleUrl = URL.createObjectURL(new Blob([PCM_TAP_PROCESSOR], { type: 'application/javascript' }))
    try {
      await context.audioWorklet.addModule(moduleUrl)
    } finally {
      URL.revokeObjectURL(moduleUrl)
    }
    const node = new AudioWorkletNode(context, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { frameSize: FRAME_SAMPLES },
    })
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      opts.onFrame(floatTo16(event.data))
    }
    // Muted sink: keep the node on a path to the destination so its processor
    // keeps getting pulled, while a zero gain stops the mic playing back.
    const zeroGain = context.createGain()
    zeroGain.gain.value = 0
    source.connect(node)
    node.connect(zeroGain)
    zeroGain.connect(context.destination)
    // A context created several awaits after the click gesture can start
    // suspended under the autoplay policy; resume so the node pulls audio.
    void context.resume().catch(() => {})

    let stopped = false
    return {
      stop: () => {
        if (stopped) return
        stopped = true
        node.port.onmessage = null
        node.disconnect()
        source.disconnect()
        zeroGain.disconnect()
        for (const track of stream.getTracks()) track.stop()
        void context.close().catch(() => {})
      },
    }
  } catch (err) {
    // Worklet module load / node construction failed (e.g. an enforcing
    // host-page CSP blocking the blob module). Release the mic + context so we
    // don't leak them, then surface the failure like a getUserMedia rejection.
    for (const track of stream.getTracks()) track.stop()
    void context.close().catch(() => {})
    throw err
  }
}
