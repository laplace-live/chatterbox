/**
 * Whisper Web Worker source — runs the ONNX/WebGPU model off the
 * main thread so transcription doesn't block UI / signal updates
 * during inference.
 *
 * This file is loaded as a **raw string** (`?raw` import) by
 * `whisper.ts`, wrapped in a `Blob`, and spawned as a module worker
 * via `URL.createObjectURL`. The worker's own scope is therefore a
 * Service Worker-style global with no module resolution against the
 * userscript bundle — every external dep must come from a fully-
 * qualified URL `import()` inside the worker.
 *
 * **CRITICAL:** because we load this file as `?raw` (vite hands us
 * the bytes on disk verbatim, NOT a transpiled module), the entire
 * body must be **valid JavaScript with no TypeScript syntax**.
 * Typing is JSDoc-only.
 *
 * **Design change vs. v1:** v1 used Whisper's `TextStreamer` to
 * emit per-token deltas to the UI. Dogfood measurements showed
 * this caused ~35 caption updates per second at steady state —
 * users perceived this as "flashing" because each delta replaces
 * the previous one and the human eye can't track sub-100ms text
 * changes meaningfully. We now run a plain `model.generate` +
 * `batch_decode` per pass and emit the full text once at the end.
 * Caption updates at ~1 Hz, matching the audio pass cadence and
 * the maximum sustainable read rate.
 */

// Body is shipped as raw text to a Worker — JSDoc-only typing.
// The `@import` JSDoc tags below pull type aliases out of
// `@huggingface/transformers` for editor IntelliSense and to
// declare intent ("this is the same DataType the SDK uses").
// The runtime `import(cdnUrl)` returns the same module shape
// these types describe.
//
/** @import { DataType, PreTrainedTokenizer, Processor, WhisperForConditionalGeneration } from '@huggingface/transformers' */

/**
 * Singleton pipeline promise. `null` until `init` arrives, then a
 * Promise resolving to the loaded transformers.js trio. Every
 * `transcribe` awaits this same promise once it's warm.
 *
 * @type {Promise<{ tokenizer: PreTrainedTokenizer; processor: Processor; model: WhisperForConditionalGeneration }> | null}
 */
let pipelinePromise = null
let generating = false

// 64 tokens per pass — same as the Xenova reference. At our chosen
// window length (≤ 5 s of audio) Whisper-base emits roughly
// 10-30 tokens, so 64 is comfortably above the cap without paying
// for unused decoder steps.
const MAX_NEW_TOKENS = 64

/**
 * @param {string} modelId          HuggingFace repo id, e.g. `onnx-community/whisper-large-v3-turbo`.
 * @param {string} cdnUrl           Fully-qualified URL to dynamically import the transformers.js bundle.
 * @param {Extract<DataType, 'fp32' | 'fp16' | 'q4f16'>} encoderDtype  Encoder quantisation; must match what the repo ships.
 * @param {Extract<DataType, 'fp32' | 'fp16' | 'q4' | 'q4f16'>} decoderDtype  Decoder quantisation. `fp16` matches wide.video's 1.6 GB tier.
 * @param {80 | 128} numMelBins     Mel filter-bank count for the warm-up spectrogram —
 *                                  large-v3-turbo uses 128, base/small use 80.
 *                                  Mismatched value crashes the model on first input.
 * @returns {Promise<{ tokenizer: PreTrainedTokenizer; processor: Processor; model: WhisperForConditionalGeneration }>}
 */
async function loadPipeline(modelId, cdnUrl, encoderDtype, decoderDtype, numMelBins) {
  if (pipelinePromise) return pipelinePromise
  pipelinePromise = (async () => {
    self.postMessage({ type: 'loading-status', message: '正在加载 Transformers.js…' })
    const transformers = await import(cdnUrl)
    const { AutoTokenizer, AutoProcessor, WhisperForConditionalGeneration, env } = transformers

    if (env) {
      env.allowRemoteModels = true
      env.allowLocalModels = false
      env.useBrowserCache = true
    }

    self.postMessage({
      type: 'loading-status',
      message: '正在下载模型（首次较慢，已缓存后秒开）…',
    })

    /**
     * Progress events emitted by transformers.js during model
     * download. The runtime shape isn't formally typed by the
     * SDK (`progress_callback` is `any` upstream), so we use an
     * inline JSDoc record describing the fields we actually
     * read — extra keys are ignored.
     *
     * @param {{ status?: string; file?: string; loaded?: number; total?: number; progress?: number } | null | undefined} data
     */
    const onProgress = data => {
      if (!data) return
      const file = data.file || ''
      if (data.status === 'progress') {
        self.postMessage({
          type: 'loading-progress',
          file,
          loaded: data.loaded,
          total: data.total,
          progress: data.progress,
        })
      } else if (data.status === 'done') {
        self.postMessage({ type: 'loading-progress', file, progress: 100 })
      }
    }

    const [tokenizer, processor, model] = await Promise.all([
      AutoTokenizer.from_pretrained(modelId, { progress_callback: onProgress }),
      AutoProcessor.from_pretrained(modelId, { progress_callback: onProgress }),
      WhisperForConditionalGeneration.from_pretrained(modelId, {
        dtype: {
          encoder_model: encoderDtype,
          decoder_model_merged: decoderDtype,
        },
        device: 'webgpu',
        progress_callback: onProgress,
      }),
    ])

    self.postMessage({ type: 'loading-status', message: '正在编译 WebGPU 着色器…' })
    // Warm-up generate with a dummy log-mel spectrogram so the
    // user's first real audio chunk doesn't pay the shader-compile
    // cost (which can be 2-5 s on cold GPU). `numMelBins` must
    // match the model's config.json — Turbo uses 128, base/small
    // use 80. Passing the wrong value here crashes the model on
    // first real input.
    await model.generate({
      input_features: transformers.full([1, numMelBins, 3000], 0.0),
      max_new_tokens: 1,
    })

    self.postMessage({ type: 'ready' })
    return { tokenizer, processor, model }
  })()
  return pipelinePromise
}

/**
 * Silero VAD session, lazy-loaded on first `transcribe` with
 * `vad.enabled` set. Kept alongside the Whisper pipeline so a
 * `reset` clears both.
 *
 * @type {Promise<{ session: import('onnxruntime-web').InferenceSession; ort: typeof import('onnxruntime-web') }> | null}
 */
let vadPromise = null

/**
 * Window size for Silero @ 16 kHz. Hard-coded by the model.
 * The LSTM hidden state is rebuilt per `vadCheck` call (see
 * docstring there for rationale).
 */
const VAD_WINDOW_SAMPLES = 512
/**
 * Context size that prepends each window. Hard-coded by the model.
 */
const VAD_CONTEXT_SAMPLES = 64

/**
 * Load Silero VAD via onnxruntime-web's WASM backend. Idempotent —
 * the first call kicks off load; subsequent calls reuse the
 * promise. We use WASM (not WebGPU) because Silero is tiny and
 * runs faster on CPU than it would going through GPU dispatch
 * overhead for ~512 samples.
 *
 * @param {string} ortCdnUrl
 * @param {string} modelUrl
 */
async function loadVad(ortCdnUrl, modelUrl) {
  if (vadPromise) return vadPromise
  self.postMessage({ type: 'vad-loading' })
  vadPromise = (async () => {
    const ort = /** @type {typeof import('onnxruntime-web')} */ (await import(ortCdnUrl))
    // Bundle variant already has the WASM binary inlined as
    // base64, so no extra `env.wasm.wasmPaths` configuration is
    // needed. The default execution provider is `wasm`, which is
    // exactly what we want for Silero.
    const session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      // Single-threaded suffices — Silero is <3 MB and runs in
      // <5 ms. Multi-thread would only help if we were running
      // batched inference, which we aren't.
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    })
    self.postMessage({ type: 'vad-ready' })
    return { session, ort }
  })()
  return vadPromise
}

/**
 * Run Silero VAD on an audio chunk and return the
 * window-averaged speech probability. Resets state at the start
 * (so each call is independent — see `vadState` docblock).
 *
 * Implementation follows the contract documented in
 * `const.ts`'s `SILERO_VAD_MODEL_URL`:
 *   - chunks audio into 512-sample windows
 *   - prepends 64-sample context tail from the previous window
 *   - threads the LSTM hidden state across windows
 *   - averages `output[0]` across all windows
 *
 * @param {Float32Array} audio  Float32 PCM @ 16 kHz, mono.
 * @param {Awaited<typeof vadPromise>} vad
 * @returns {Promise<number>}   Speech probability ∈ [0, 1].
 */
async function vadCheck(audio, vad) {
  const { session, ort } = /** @type {NonNullable<typeof vad>} */ (vad)
  // Fresh state for this chunk. Silero's LSTM is small enough
  // that re-initializing per ~5 s call adds well under a ms,
  // and the alternative (carry state across non-contiguous
  // chunks) would feed it lies that hurt accuracy.
  const state = new Float32Array(2 * 1 * 128) // already zero-filled
  const sr = new BigInt64Array([16000n])

  let probSum = 0
  let probCount = 0
  // Slide a 64-sample context tail through the audio.
  const context = new Float32Array(VAD_CONTEXT_SAMPLES)
  for (let i = 0; i + VAD_WINDOW_SAMPLES <= audio.length; i += VAD_WINDOW_SAMPLES) {
    const window = audio.subarray(i, i + VAD_WINDOW_SAMPLES)
    // Build [context || window] = 576-sample input.
    const input = new Float32Array(VAD_CONTEXT_SAMPLES + VAD_WINDOW_SAMPLES)
    input.set(context, 0)
    input.set(window, VAD_CONTEXT_SAMPLES)

    const feeds = {
      input: new ort.Tensor('float32', input, [1, input.length]),
      state: new ort.Tensor('float32', state, [2, 1, 128]),
      sr: new ort.Tensor('int64', sr, [1]),
    }
    const out = await session.run(feeds)
    // `output` is shape [1, 1] = probability of speech in this window.
    const probArr = /** @type {Float32Array} */ (out.output.data)
    probSum += probArr[0]
    probCount++

    // Update LSTM state for next window.
    const stateArr = /** @type {Float32Array} */ (out.stateN.data)
    state.set(stateArr)

    // Tail of current window becomes context for next window.
    context.set(window.subarray(VAD_WINDOW_SAMPLES - VAD_CONTEXT_SAMPLES))
  }
  return probCount === 0 ? 0 : probSum / probCount
}

/**
 * Transcribe a single audio chunk and post the result back once.
 * No per-token streaming — matches what the user can actually read.
 *
 * If `vad.enabled`, runs Silero on the chunk first and skips the
 * Whisper inference entirely when the chunk doesn't look like
 * speech. Saves ~200 ms GPU time per skipped chunk and prevents
 * music / BGM from polluting the danmaku queue.
 *
 * @param {number} id
 * @param {Float32Array} audio
 * @param {string} language
 * @param {{ enabled: boolean; threshold: number; ortCdnUrl: string; modelUrl: string } | undefined} vadConfig
 */
async function transcribe(id, audio, language, vadConfig) {
  if (generating) {
    // Drop the request — the main thread should debounce, but
    // we belt-and-suspenders here so a flood can't queue up
    // model.generate calls.
    self.postMessage({ type: 'transcribe-dropped', id })
    return
  }
  if (!pipelinePromise) {
    self.postMessage({ type: 'error', message: 'pipeline not initialised', id })
    return
  }
  generating = true
  const tStart = performance.now()
  try {
    // ---- VAD gate -----------------------------------------------
    // Run before pipeline await so the GPU isn't tied up waiting
    // for a transcription we're about to discard.
    if (vadConfig?.enabled) {
      try {
        const vad = await loadVad(vadConfig.ortCdnUrl, vadConfig.modelUrl)
        const speechProb = await vadCheck(audio, vad)
        if (speechProb < vadConfig.threshold) {
          const elapsedMs = Math.round(performance.now() - tStart)
          self.postMessage({
            type: 'transcribe-skipped',
            id,
            reason: 'no-speech',
            speechProb,
            elapsedMs,
          })
          return
        }
      } catch (err) {
        // VAD load / inference failed — log and fall through to
        // Whisper. A broken VAD shouldn't take the captions down.
        const message = err instanceof Error ? err.message : String(err)
        self.postMessage({ type: 'error', message: `VAD failed (passthrough): ${message}`, id })
      }
    }

    const { tokenizer, processor, model } = await pipelinePromise
    const inputs = await processor(audio)
    // `WhisperForConditionalGeneration.generate` is typed to
    // return `ModelOutput | Tensor` upstream, but in practice a
    // bare-options call (no `output_scores` / `output_attentions`
    // requested) always resolves to a Tensor of token ids — the
    // `ModelOutput` arm is for the verbose modes we don't use.
    // The cast is needed because `tokenizer.batch_decode` only
    // accepts `Tensor | number[][]`.
    const outputs = /** @type {import('@huggingface/transformers').Tensor} */ (
      await model.generate({
        ...inputs,
        max_new_tokens: MAX_NEW_TOKENS,
        language,
      })
    )
    const decoded = tokenizer.batch_decode(outputs, { skip_special_tokens: true })
    const text = (Array.isArray(decoded) ? decoded[0] : String(decoded)).trim()
    const elapsedMs = Math.round(performance.now() - tStart)
    self.postMessage({ type: 'transcribe-complete', id, text, elapsedMs })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    self.postMessage({ type: 'error', message: `transcribe failed: ${message}`, id })
  } finally {
    generating = false
  }
}

self.addEventListener('message', e => {
  const msg = e.data
  if (!msg) return
  switch (msg.type) {
    case 'init':
      loadPipeline(msg.modelId, msg.transformersCdnUrl, msg.encoderDtype, msg.decoderDtype, msg.numMelBins).catch(
        err => {
          const message = err instanceof Error ? err.message : String(err)
          self.postMessage({ type: 'error', message: `init failed: ${message}` })
          pipelinePromise = null
        }
      )
      break
    case 'transcribe':
      transcribe(msg.id, msg.audio, msg.language, msg.vad)
      break
    case 'reset':
      pipelinePromise = null
      vadPromise = null
      generating = false
      break
  }
})
