/**
 * Shared microphone → PCM16 capture for the raw-WebSocket STT engines
 * (ElevenLabs, Deepgram).
 *
 * Pins an AudioContext to 16 kHz so the browser resamples the mic for us, runs
 * the audio through a ScriptProcessor (chosen over AudioWorklet to avoid
 * blob-module / CSP issues on the host page), converts each block to
 * little-endian Int16, and hands it to `onFrame`. Each engine decides what to
 * do with a frame: base64-in-JSON for ElevenLabs, raw binary for Deepgram.
 */

import { floatTo16 } from './audio'

/** Sample rate the capture is pinned to; also what engines report to the server. */
export const PCM_SAMPLE_RATE = 16000

// 4096 frames ≈ 256 ms at 16 kHz — a good latency/overhead balance, and a valid
// ScriptProcessor buffer size.
const SCRIPT_PROCESSOR_BUFFER = 4096

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
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1)
  // Muted sink: a ScriptProcessor only fires while connected to a destination,
  // and routing through a zero gain keeps the mic from playing back.
  const zeroGain = context.createGain()
  zeroGain.gain.value = 0
  processor.onaudioprocess = event => {
    opts.onFrame(floatTo16(event.inputBuffer.getChannelData(0)))
  }
  source.connect(processor)
  processor.connect(zeroGain)
  zeroGain.connect(context.destination)
  // A context created several awaits after the click gesture can start
  // suspended under the autoplay policy; resume so the processor fires.
  void context.resume().catch(() => {})

  let stopped = false
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      processor.onaudioprocess = null
      processor.disconnect()
      source.disconnect()
      zeroGain.disconnect()
      for (const track of stream.getTracks()) track.stop()
      void context.close().catch(() => {})
    },
  }
}
