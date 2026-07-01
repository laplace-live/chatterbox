/**
 * Shared mic → PCM16 capture for raw-WebSocket STT engines (ElevenLabs, Deepgram).
 * AudioContext pinned to 16 kHz so the browser resamples; AudioWorklet blob-loaded
 * (userscript has no separate asset for `addModule()`). Targeted Bilibili pages
 * enforce no `script-src` CSP that would block the blob module.
 */

import { floatTo16 } from './audio'

/** Sample rate the capture is pinned to; also what engines report to the server. */
export const PCM_SAMPLE_RATE = 16000

// 4096 samples ≈ 256 ms at 16 kHz — the cadence the STT engines already stream at.
const FRAME_SAMPLES = 4096

// AudioWorklet source (runs in AudioWorkletGlobalScope, not the DOM): batch mono
// input into a fixed Float32 buffer, post each full frame (transferred, zero-copy).
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
      // DSP off explicitly: raw transcribes best, and pinning a device otherwise
      // re-enables the browser's echo-cancellation / NS / AGC defaults.
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
    // Muted sink: node needs a path to destination to keep getting pulled; zero
    // gain stops the mic playing back.
    const zeroGain = context.createGain()
    zeroGain.gain.value = 0
    source.connect(node)
    node.connect(zeroGain)
    zeroGain.connect(context.destination)
    // Context created several awaits after the click gesture can start suspended
    // under the autoplay policy; resume so the node pulls audio.
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
    // Worklet load / node construction failed (e.g. enforcing host CSP blocks the
    // blob module): release mic + context so they don't leak, then rethrow.
    for (const track of stream.getTracks()) track.stop()
    void context.close().catch(() => {})
    throw err
  }
}
