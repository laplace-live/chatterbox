/**
 * Main-thread orchestrator for the in-browser Whisper STT engine.
 *
 * **v2 architecture (current).** The v1 design used MediaRecorder
 * to capture compressed webm/opus chunks, concatenated them into a
 * Blob, and re-decoded the full audio history on every pass.
 * Dogfood measurements on a 60+ second session showed three
 * compounding problems:
 *
 * 1. **Pass latency ballooned from ~250 ms to ~900 ms** once the
 *    buffer hit the 30 s ceiling — Whisper itself isn't faster
 *    than O(audio length), so any rolling-30s scheme inherits
 *    ~1 s minimum loop time on a Mac M-series GPU.
 * 2. **Caption updates at ~35 Hz**, far above any reader's
 *    comprehension threshold — perceived as "flashing characters"
 *    even though each update was technically growing.
 * 3. **Memory leaked linearly** with session length because the
 *    chunks array was never trimmed.
 *
 * v2 fixes all three:
 *
 * - **AudioWorklet → Float32 ring buffer.** Raw 16 kHz mono PCM
 *   samples land directly in a fixed-size ring buffer. No decode
 *   step, no compressed-container intermediate. Buffer size is
 *   bounded by `MAX_BUFFER_SECONDS`, so memory is constant
 *   regardless of session length.
 * - **Commit-and-slide windowing.** Each pass takes the current
 *   buffer contents (up to MAX_BUFFER_SECONDS), transcribes them
 *   end-to-end, and then advances a cursor: the first
 *   `COMMIT_SECONDS` of audio is dropped from the front of the
 *   buffer once a pass completes. `OVERLAP_SECONDS` of trailing
 *   audio is retained so the next pass has acoustic context that
 *   straddles the commit boundary (Whisper hallucinates badly
 *   when a phrase is cut mid-word at the buffer start).
 * - **No per-token streaming to UI.** The worker no longer uses
 *   `TextStreamer`; it returns a single `text` per pass via
 *   `transcribe-complete`. The caption updates exactly once per
 *   completed pass — readable, not strobing.
 *
 * Tradeoffs vs. v1:
 * - We lose Whisper's full 30 s acoustic context, which can
 *   slightly hurt accuracy on long pauses / contextual words. In
 *   practice on Chinese live streams (utterance-dense, short
 *   phrases) the 5 s window is a wash and we win on latency.
 * - The "growing partial caption" UX is gone. We measured that
 *   users couldn't read it anyway; the per-pass commit gives a
 *   single stable line that grows by one phrase per second.
 */

import { signal } from '@preact/signals'

import {
  DEFAULT_WHISPER_MODEL,
  ORT_WASM_CDN_URL,
  SILERO_VAD_MODEL_URL,
  TRANSFORMERS_CDN_URL,
  WHISPER_MODELS,
  type WhisperModelConfig,
  type WhisperModelKey,
} from './const'
import workerSource from './whisper-worker.js?raw'
import workletSource from './whisper-worklet.js?raw'

export { DEFAULT_WHISPER_MODEL, WHISPER_MODELS, type WhisperModelKey } from './const'

const SAMPLE_RATE = 16_000

/**
 * Trailing audio retained in the buffer at the moment we hand it
 * to the model. Shorter than v1's 30 s — Whisper's per-pass cost
 * scales linearly with audio length, and 5 s of speech is plenty
 * of context for word-level decoding on the kinds of bursty
 * utterances streamers actually produce. Measured cost on M-series
 * WebGPU: ~250-350 ms per pass at 5 s, vs ~900 ms at 30 s.
 */
const MAX_BUFFER_SECONDS = 5
const MAX_BUFFER_SAMPLES = SAMPLE_RATE * MAX_BUFFER_SECONDS

/**
 * How much of the front of the buffer to drop ("commit") after
 * each successful pass. The transcription of those samples is
 * considered final and goes to the caption + send queue. Larger =
 * fewer but longer captions per pass (less perceived flicker);
 * smaller = more frequent updates but more re-transcribed audio.
 * 3 s is the sweet spot we measured: caption updates feel ~1/s
 * during continuous speech.
 */
const COMMIT_SECONDS = 3
const COMMIT_SAMPLES = SAMPLE_RATE * COMMIT_SECONDS

// Trailing audio kept after a commit = MAX_BUFFER_SAMPLES -
// COMMIT_SAMPLES. Computed implicitly by the `copyWithin` calls in
// the message handlers; documented here so future maintainers don't
// have to reverse it from the buffer ops. Without overlap, Whisper
// hallucinates phantom word starts at the buffer head.

/**
 * How long to wait between checking "should I kick off a new
 * pass?" once the worker is idle. Capped below `COMMIT_SECONDS`
 * so we never let the buffer fully overflow before posting.
 */
const SCHEDULER_TICK_MS = 200

/**
 * RMS floor for the speech-presence gate. Buffers below this
 * energy aren't sent to the model — prevents Whisper hallucinating
 * boilerplate ("了", "嗯", "Thank you", …) on silent input. 0.005
 * ≈ -46 dBFS, well below normal speech (typically 0.05-0.2) and
 * above mic self-noise.
 */
const SILENCE_RMS_THRESHOLD = 0.005

export type WhisperState = 'idle' | 'loading' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'
export type WhisperLanguage = 'zh' | 'en' | 'ja' | 'ko'

export interface WhisperProgress {
  file: string
  progress: number
  loaded?: number
  total?: number
}

/**
 * Wire protocol between main thread (this file) and the worker
 * (`whisper-worker.ts`). The worker is shipped as a raw text blob,
 * so there's no module import that could share types across the
 * runtime boundary — declaring the protocol once here and using
 * it on both sides at type-check time is the cleanest way to keep
 * the two honest. Mirrors the `import type from '@soniox/client'`
 * pattern we use for the streaming SDK.
 *
 * Sub-types reuse `WhisperModelConfig` from `const.ts` rather than
 * inlining string literals, which means a dtype added/renamed
 * upstream (`@huggingface/transformers`'s `DataType` union) flows
 * end-to-end as a TypeScript error rather than a runtime crash
 * inside the worker.
 */
export type WhisperWorkerInbound =
  | {
      type: 'init'
      modelId: string
      transformersCdnUrl: string
      encoderDtype: WhisperModelConfig['encoderDtype']
      decoderDtype: WhisperModelConfig['decoderDtype']
      numMelBins: WhisperModelConfig['numMelBins']
    }
  | {
      type: 'transcribe'
      id: number
      audio: Float32Array
      language: WhisperLanguage
      /**
       * When set, the worker runs Silero VAD on `audio` before
       * dispatching to Whisper. If average speech probability
       * across the chunk falls below `vadThreshold`, the pass is
       * skipped and a `transcribe-skipped` outbound message is
       * posted instead of `transcribe-complete`. Skipping keeps
       * music / room tone / typing noise out of the danmaku queue
       * without burning the ~200 ms Whisper inference budget.
       *
       * Lazy-loaded on first request: a separate `load-vad`
       * message warms the model up front, but `transcribe` with
       * `vad` set is also tolerant if the VAD isn't loaded yet
       * (skips the gate, falls through to Whisper).
       */
      vad?: { enabled: boolean; threshold: number; ortCdnUrl: string; modelUrl: string }
    }
  | { type: 'reset' }

export type WhisperWorkerOutbound =
  | { type: 'loading-progress'; file: string; progress: number; loaded?: number; total?: number }
  | { type: 'loading-status'; message: string }
  | { type: 'ready' }
  /** Whisper produced a transcription for this id. */
  | { type: 'transcribe-complete'; id: number; text: string; elapsedMs: number }
  /** Worker was busy when the request arrived. */
  | { type: 'transcribe-dropped'; id: number }
  /**
   * VAD ran and the chunk was below the speech-probability threshold,
   * so Whisper was never invoked. Carries the measured probability so
   * the UI can surface it (and so we can tune thresholds from logs).
   */
  | { type: 'transcribe-skipped'; id: number; reason: 'no-speech'; speechProb: number; elapsedMs: number }
  /** VAD is enabled but its model is still loading; passthrough this time. */
  | { type: 'vad-loading' }
  /** VAD has loaded and is ready to gate transcribe calls. */
  | { type: 'vad-ready' }
  | { type: 'error'; message: string; id?: number }

export interface WhisperCallbacks {
  onLoadProgress?: (p: WhisperProgress) => void
  onLoadStatus?: (message: string) => void
  onReady?: () => void
  /**
   * Fired exactly once per completed pass with the decoded text
   * for the committed window. This is append-style: each event
   * carries the transcription of a fresh ~3 s of audio, never the
   * full history. Consumers should append to their own log.
   */
  onSegment?: (text: string, elapsedMs: number) => void
  /**
   * Fired when Silero VAD gated a pass (the audio chunk contained
   * insufficient speech to bother running Whisper). Useful for
   * surfacing "music skipped" in the status line and for tuning
   * the threshold from logs. `speechProb` is the chunk-averaged
   * probability ∈ [0, 1]; below `whisperVadThreshold` it's
   * considered non-speech.
   */
  onVadSkipped?: (speechProb: number, elapsedMs: number) => void
  onError?: (err: Error) => void
}

export interface WhisperEngineOptions {
  language: WhisperLanguage
  deviceId?: string
  /**
   * Which Whisper model to load. Defaults to `DEFAULT_WHISPER_MODEL`
   * (currently 'turbo-hq' — fp16 weights, ~1.6 GB, matches
   * wide.video's production config for the best Chinese accuracy
   * we can offer in-browser on M-series WebGPU). Changing this
   * value across sessions tears down the warm singleton worker
   * (the cached weights stay in IndexedDB, so it's the model
   * compile that gets repeated, not the download).
   */
  model?: WhisperModelKey
  /**
   * Voice Activity Detection options. When enabled, every audio
   * chunk runs through Silero VAD before being handed to Whisper
   * — chunks that score below `vadThreshold` (averaged across the
   * chunk's 32 ms windows) are skipped entirely. This is what
   * keeps background music, room tone, keyboard noise, and
   * applause from being hallucinated as lyrics / phantom speech.
   *
   * Silero is small (~1.15 MB fp16, cached in browser Cache API
   * after first download), fast (<5 ms per pass on CPU), and
   * specifically trained to discriminate speech from music. On by
   * default — users can opt out for completely BGM-free streams
   * (or to debug a missed-speech case).
   *
   * `threshold` is the chunk-averaged probability cutoff ∈ [0, 1].
   * Default 0.3 (conservative — Chinese speech occasionally
   * scores below the 0.5 default, especially soft tones). Raise
   * to ~0.5 if too much music leaks through; lower to ~0.2 if
   * actual speech gets gated out.
   */
  vad?: { enabled: boolean; threshold: number }
}

let workerInstance: Worker | null = null
let workerInitialised = false
// Tracks which model id the warm worker holds. If a new engine is
// started with a different model, we tear down + respawn so the
// user's switch actually takes effect.
let workerLoadedModel: WhisperModelKey | null = null
let nextTranscribeId = 1

/**
 * Reactive view of "is the worker warm?". Exposed for UI so panel
 * can show "已加载" without firing extra postMessages.
 */
export const whisperWorkerReady = signal(false)

export function isWebGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu
}

function spawnWorker(): Worker {
  if (workerInstance) return workerInstance
  const blob = new Blob([workerSource], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  workerInstance = new Worker(url, { type: 'module' })
  URL.revokeObjectURL(url)
  return workerInstance
}

export interface WhisperEngine {
  stop(): Promise<void>
  setLanguage(language: WhisperLanguage): void
  /**
   * Update VAD config live. The new values take effect on the next
   * generate pass — no worker tear-down. `enabled: true` triggers
   * lazy Silero load on the next transcribe if it isn't already
   * warm; `enabled: false` skips the VAD check entirely (Silero
   * stays loaded in worker memory for fast re-enable).
   */
  setVad(vad: { enabled: boolean; threshold: number }): void
}

/**
 * Start the in-browser Whisper engine with the v2 commit-and-slide
 * pipeline. See file-level docblock for the rationale behind the
 * architecture.
 */
export async function startWhisperEngine(
  options: WhisperEngineOptions,
  callbacks: WhisperCallbacks
): Promise<WhisperEngine> {
  if (!isWebGpuAvailable()) {
    throw new Error('WebGPU is not available in this browser')
  }

  let currentLanguage: WhisperLanguage = options.language
  // VAD config is read per-pass (we re-send it in every
  // `transcribe` message) so the toggle and threshold can change
  // live without tearing down the engine. Default: enabled at a
  // conservative 0.3 threshold — tuned for Chinese where soft
  // speech sometimes scores below the canonical 0.5 default.
  let currentVad = options.vad ?? { enabled: true, threshold: 0.3 }
  let stopped = false

  // ---- Audio capture ------------------------------------------
  // Ring buffer for raw PCM samples. We use a single Float32Array
  // of MAX_BUFFER_SAMPLES capacity and track a write cursor; on
  // commit we shift the unwritten tail forward. Simpler than a
  // true ring (no wraparound handling on the read side) and the
  // O(N) shift is cheap at 5 s × 16 kHz = 80 000 floats.
  const buffer = new Float32Array(MAX_BUFFER_SAMPLES)
  let bufferLen = 0
  let posting = false
  let scheduler: ReturnType<typeof setInterval> | null = null

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      // Raw audio (no AGC / NS / EC distorting the spectrogram)
      // is what Whisper expects. Matches what we do for Soniox.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
    },
  })

  const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })

  // Register the worklet processor from an inline blob URL — we
  // can't ship a sibling JS file from a userscript, so this is
  // the same trick as the Worker bootstrap.
  const workletBlob = new Blob([workletSource], { type: 'application/javascript' })
  const workletUrl = URL.createObjectURL(workletBlob)
  try {
    await audioContext.audioWorklet.addModule(workletUrl)
  } finally {
    URL.revokeObjectURL(workletUrl)
  }

  const source = audioContext.createMediaStreamSource(stream)
  const captureNode = new AudioWorkletNode(audioContext, 'chatterbox-capture')

  captureNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (stopped) return
    const chunk = e.data
    if (!chunk?.length) return
    // If incoming chunk doesn't fit, drop the oldest samples so
    // the head of the buffer is always the oldest audio still in
    // our window. With our 200 ms scheduler tick this only kicks
    // in when the worker is busy for >1 s, which is rare.
    if (bufferLen + chunk.length > MAX_BUFFER_SAMPLES) {
      const overflow = bufferLen + chunk.length - MAX_BUFFER_SAMPLES
      buffer.copyWithin(0, overflow, bufferLen)
      bufferLen -= overflow
    }
    buffer.set(chunk, bufferLen)
    bufferLen += chunk.length
  }

  source.connect(captureNode)
  // Worklet must be connected somewhere for `process` to run.
  // We connect to a muted GainNode → destination so nothing
  // actually plays back through the speakers.
  const muteNode = audioContext.createGain()
  muteNode.gain.value = 0
  captureNode.connect(muteNode).connect(audioContext.destination)

  // ---- Worker wiring ------------------------------------------
  // Resolve the model BEFORE spawning the worker — if the warm
  // singleton was loaded with a different model, we need to
  // terminate it first so the next spawn returns a fresh worker
  // ready to receive the new model. Weights remain in IndexedDB,
  // so it's only the pipeline compile that gets repeated, not the
  // download.
  const modelKey: WhisperModelKey = options.model ?? DEFAULT_WHISPER_MODEL
  const modelConfig = WHISPER_MODELS[modelKey]
  if (workerInitialised && workerLoadedModel !== modelKey) {
    terminateWhisperWorker()
  }
  const worker = spawnWorker()

  const onWorkerMessage = (e: MessageEvent<WhisperWorkerOutbound>) => {
    if (stopped) return
    const msg = e.data
    switch (msg?.type) {
      case 'loading-progress':
        callbacks.onLoadProgress?.({
          file: msg.file,
          progress: typeof msg.progress === 'number' ? msg.progress : 0,
          loaded: msg.loaded,
          total: msg.total,
        })
        break
      case 'loading-status':
        callbacks.onLoadStatus?.(msg.message)
        break
      case 'ready':
        workerInitialised = true
        whisperWorkerReady.value = true
        callbacks.onReady?.()
        break
      case 'transcribe-complete': {
        posting = false
        // The pass we just received transcribed audio from
        // index 0 up to (whatever `bufferLen` was at post time,
        // capped at MAX_BUFFER_SAMPLES). We commit the first
        // COMMIT_SAMPLES of that and keep the trailing
        // OVERLAP_SAMPLES for the next pass's context.
        if (bufferLen > COMMIT_SAMPLES) {
          buffer.copyWithin(0, COMMIT_SAMPLES, bufferLen)
          bufferLen -= COMMIT_SAMPLES
        } else {
          // Pass happened on a sub-COMMIT_SECONDS buffer (only
          // possible if we forced a flush at stop time) — just
          // drop everything.
          bufferLen = 0
        }
        if (msg.text) callbacks.onSegment?.(msg.text, msg.elapsedMs ?? 0)
        break
      }
      case 'transcribe-dropped':
        // Worker rejected our post because it was busy. Release
        // the lock so the scheduler can try again next tick.
        posting = false
        break
      case 'transcribe-skipped': {
        // VAD decided the chunk wasn't speech. Same buffer
        // bookkeeping as a normal complete (commit the
        // COMMIT_SAMPLES we already audited) so the next pass
        // doesn't keep re-evaluating identical "no speech"
        // audio. Surface to the panel so users can see VAD
        // working.
        posting = false
        if (bufferLen > COMMIT_SAMPLES) {
          buffer.copyWithin(0, COMMIT_SAMPLES, bufferLen)
          bufferLen -= COMMIT_SAMPLES
        } else {
          bufferLen = 0
        }
        callbacks.onVadSkipped?.(msg.speechProb, msg.elapsedMs)
        break
      }
      case 'vad-loading':
      case 'vad-ready':
        // No UI noise needed — the panel's status line picks up
        // the gating result via `onVadSkipped`. Kept as
        // dedicated events so a future debug overlay can show
        // "VAD ready" without inferring it from skip events.
        break
      case 'error':
        posting = false
        callbacks.onError?.(new Error(msg.message))
        break
    }
  }
  worker.addEventListener('message', onWorkerMessage)

  const onWorkerError = (e: ErrorEvent) => {
    if (stopped) return
    const parts = [
      e.message,
      e.filename ? `at ${e.filename}` : '',
      e.lineno ? `:${e.lineno}` : '',
      e.colno ? `:${e.colno}` : '',
    ].filter(Boolean)
    const summary = parts.join('') || 'worker died with no diagnostic'
    callbacks.onError?.(new Error(`worker: ${summary}`))
    posting = false
  }
  worker.addEventListener('error', onWorkerError)

  // ---- Pass scheduler -----------------------------------------
  // Independent of the audio-capture cadence. Fires every
  // SCHEDULER_TICK_MS and decides whether to launch a new pass
  // based on (a) is the worker idle, (b) do we have enough audio,
  // (c) is the audio not silent.
  const tryDispatch = () => {
    if (stopped) return
    if (posting) return
    if (!workerInitialised) return
    if (bufferLen < COMMIT_SAMPLES) return

    // Silence gate: skip if the buffer is mostly empty / quiet.
    // Otherwise we'd burn GPU time decoding noise and the user
    // would see hallucinated tokens fired into the send queue.
    let sumSq = 0
    for (let i = 0; i < bufferLen; i++) {
      const s = buffer[i]
      sumSq += s * s
    }
    const rms = Math.sqrt(sumSq / bufferLen)
    if (rms < SILENCE_RMS_THRESHOLD) {
      // Don't keep silence accumulating forever; drop the front
      // commit-chunk so we never re-evaluate the same silent
      // samples on every tick. Keeps memory + CPU bounded.
      if (bufferLen > COMMIT_SAMPLES) {
        buffer.copyWithin(0, COMMIT_SAMPLES, bufferLen)
        bufferLen -= COMMIT_SAMPLES
      } else {
        bufferLen = 0
      }
      return
    }

    posting = true
    // Copy the in-use slice so the buffer we send is independent
    // of the live ring buffer (samples can keep streaming in
    // while the worker is busy). `.slice()` is a real copy, not
    // a view.
    const audio = buffer.slice(0, bufferLen)
    const transcribeMsg: WhisperWorkerInbound = {
      type: 'transcribe',
      id: nextTranscribeId++,
      audio,
      language: currentLanguage,
      // Pass VAD config every time rather than at init — lets the
      // user flip the toggle mid-session without restarting the
      // worker. Worker lazy-loads Silero on first request with
      // `enabled: true` and reuses the session thereafter.
      ...(currentVad.enabled
        ? {
            vad: {
              enabled: true,
              threshold: currentVad.threshold,
              ortCdnUrl: ORT_WASM_CDN_URL,
              modelUrl: SILERO_VAD_MODEL_URL,
            },
          }
        : {}),
    }
    worker.postMessage(
      transcribeMsg,
      // Transfer to avoid the second copy when the worker reads
      // it. Original view on the main thread becomes neutered
      // (we don't use it after this anyway).
      [audio.buffer]
    )
  }

  // ---- Worker init --------------------------------------------
  if (!workerInitialised) {
    workerLoadedModel = modelKey
    const initMsg: WhisperWorkerInbound = {
      type: 'init',
      modelId: modelConfig.id,
      transformersCdnUrl: TRANSFORMERS_CDN_URL,
      encoderDtype: modelConfig.encoderDtype,
      decoderDtype: modelConfig.decoderDtype,
      numMelBins: modelConfig.numMelBins,
    }
    worker.postMessage(initMsg)
  } else {
    // Already warm with the right model — surface ready
    // synchronously so UI doesn't sit on "loading…" forever.
    callbacks.onReady?.()
  }

  // Start polling whenever we're loaded; the dispatch function
  // gates on workerInitialised internally so early ticks are
  // no-ops.
  scheduler = setInterval(tryDispatch, SCHEDULER_TICK_MS)

  return {
    setLanguage(language: WhisperLanguage) {
      currentLanguage = language
    },
    setVad(vad: { enabled: boolean; threshold: number }) {
      currentVad = vad
    },
    async stop() {
      if (stopped) return
      stopped = true
      if (scheduler) {
        clearInterval(scheduler)
        scheduler = null
      }
      try {
        captureNode.port.onmessage = null
        captureNode.disconnect()
      } catch {
        // ignore
      }
      try {
        source.disconnect()
      } catch {
        // ignore
      }
      try {
        for (const track of stream.getTracks()) track.stop()
      } catch {
        // ignore
      }
      try {
        await audioContext.close()
      } catch {
        // ignore
      }
      worker.removeEventListener('message', onWorkerMessage)
      worker.removeEventListener('error', onWorkerError)
      // Worker stays alive across stop/start cycles so the
      // ~300 MB of warm GPU state survives. Released on page
      // unload or via terminateWhisperWorker().
    },
  }
}

/**
 * Tear down the singleton Worker. Frees GPU memory and the model
 * weights cache in worker scope. Not called from the normal stop
 * path — only by tests or explicit "switch model" flows.
 */
export function terminateWhisperWorker(): void {
  if (workerInstance) {
    workerInstance.terminate()
    workerInstance = null
    workerInitialised = false
    workerLoadedModel = null
    whisperWorkerReady.value = false
  }
}
