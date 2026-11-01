/** Shared mic or live-player → 16 kHz mono PCM16 capture via a blob-loaded AudioWorklet. */

import { WEB_AUDIO_DEVICE_ID } from '../const'
import { appendLog } from '../log'
import { floatTo16 } from './audio'
import { acquirePageAudio, bindPageAudio, toAbortError } from './page-audio'

/** Default capture sample rate in Hz. */
export const PCM_SAMPLE_RATE = 16000

/** Default samples per PCM frame (256 ms at 16 kHz). */
export const PCM_FRAME_SAMPLES = 4096

// Average active input channels and emit zeros when disconnected so sockets stay alive and VAD flushes open segments.
const PCM_TAP_PROCESSOR = `
class PcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this._size = options.processorOptions.frameSize
    this._buf = new Float32Array(this._size)
    this._n = 0
  }
  process(inputs) {
    const channels = inputs[0]
    const chCount = channels ? channels.length : 0
    const len = chCount > 0 ? channels[0].length : 128
    for (let i = 0; i < len; i++) {
      let sample = 0
      if (chCount === 1) {
        sample = channels[0][i]
      } else if (chCount > 1) {
        for (let ch = 0; ch < chCount; ch++) sample += channels[ch][i]
        sample /= chCount
      }
      this._buf[this._n++] = sample
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
  if (opts.signal?.aborted) throw toAbortError(opts.signal)
  const node = new AudioWorkletNode(context, 'pcm-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    // Downmix stereo `captureStream()` sources (`0.5 * (L + R)`) before `PcmTapProcessor` reads channel 0.
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { frameSize: opts.frameSamples ?? PCM_FRAME_SAMPLES },
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

interface AcquiredAudioSource {
  connect: (context: AudioContext, destination: AudioNode) => () => void
  release: () => void
}

async function getUserMediaWithSignal(constraints: MediaStreamConstraints, signal?: AbortSignal): Promise<MediaStream> {
  if (signal?.aborted) throw toAbortError(signal)
  const pending = navigator.mediaDevices.getUserMedia(constraints)
  if (!signal) return pending
  const stopStream = (stream: MediaStream): void => {
    for (const track of stream.getTracks()) track.stop()
  }
  return new Promise<MediaStream>((resolve, reject) => {
    const onAbort = (): void => {
      reject(toAbortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      stream => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) {
          stopStream(stream)
          return
        }
        resolve(stream)
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        if (!signal.aborted) reject(err)
      }
    )
  })
}

async function acquireAudioSource(opts: PcmCaptureOptions): Promise<AcquiredAudioSource> {
  if (opts.deviceId === WEB_AUDIO_DEVICE_ID) {
    const initial = await acquirePageAudio({ signal: opts.signal })
    return {
      connect: (context, destination) => {
        const binding = bindPageAudio({ context, destination, initial, onLog: appendLog })
        return () => binding.stop()
      },
      release: () => initial.release(),
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
  const stream = await getUserMediaWithSignal(constraints, opts.signal)
  const stopTracks = (): void => {
    for (const track of stream.getTracks()) track.stop()
  }
  return {
    connect: (context, destination) => {
      const source = context.createMediaStreamSource(stream)
      source.connect(destination)
      return () => {
        source.disconnect()
        stopTracks()
      }
    },
    release: stopTracks,
  }
}

/** Start capturing mono PCM16 frames from the selected microphone or live-player stream. */
export async function startPcmCapture(opts: PcmCaptureOptions): Promise<PcmCapture> {
  const audioSource = await acquireAudioSource(opts)
  let context: AudioContext | null = null
  try {
    const ctx = new AudioContext({ sampleRate: opts.sampleRate ?? PCM_SAMPLE_RATE })
    context = ctx
    const { node, teardownSink } = await createWorkletSink(ctx, opts)
    const teardownSource = audioSource.connect(ctx, node)
    void ctx.resume().catch(() => {})

    let stopped = false
    return {
      stop: () => {
        if (stopped) return
        stopped = true
        teardownSink()
        teardownSource()
        void ctx.close().catch(() => {})
      },
    }
  } catch (err) {
    audioSource.release()
    if (context) void context.close().catch(() => {})
    throw err
  }
}
