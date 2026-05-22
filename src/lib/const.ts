import type { DataType } from '@huggingface/transformers'

import { GM_info } from '$'

/**
 * Userscript version, sourced from the `// @version` header that
 * vite-plugin-monkey generates from `helper/package.json`. Importing
 * `GM_info` from `$` lets vite-plugin-monkey track the dependency and add
 * the matching `@grant`.
 */
export const VERSION = GM_info.script.version

/**
 * App-identity strings used in outbound HTTP headers (currently only
 * for LLM API calls — see `lib/llm.ts`). They specifically target
 * OpenRouter's `HTTP-Referer` + `X-Title` attribution headers, which
 * surface this project on OpenRouter's public rankings / analytics.
 *
 * - `PROJECT_URL` is the canonical GitHub URL so anyone clicking through
 *   from OpenRouter's leaderboard lands on the actual source rather
 *   than a generic homepage.
 * - `PROJECT_NAME` is the project's English handle; matches the GitHub
 *   repo name and stays ASCII so any dashboard can render it without
 *   character-set surprises.
 *
 * We send these on every LLM request regardless of provider — non-
 * OpenRouter endpoints just ignore unknown headers, so it costs
 * nothing and means the attribution is always present whenever the
 * user happens to be pointing at OpenRouter.
 */
export const PROJECT_URL = 'https://github.com/laplace-live/chatterbox'
export const PROJECT_NAME = 'LAPLACE Chatterbox'
export const DOCUMENT_URL = 'https://subspace.institute/docs/laplace-chatterbox'

/**
 * Soniox real-time speech-to-text SDK. ESM-only package; we point
 * at the package's own `dist/index.mjs` (fully self-contained —
 * zero bare-specifier imports verified against the published
 * artifact) so no transitive-dep waterfall and no third-party CDN
 * rewriter in the loop.
 */
export const SONIOX_CDN_URL = 'https://unpkg.com/@soniox/client@2.1.0/dist/index.mjs'

/**
 * mpegts.js FLV / MPEG-TS demuxer. UMD bundle — assigns its exports
 * to `window.mpegts` at runtime, picked up via the shared
 * `loadScript()` probe path.
 */
export const MPEGTS_CDN_URL = 'https://unpkg.com/mpegts.js@1.8.0/dist/mpegts.js'

/**
 * Hugging Face Transformers.js ESM bundle, loaded **inside the
 * Whisper Web Worker** (not the main thread) via a fully-qualified
 * dynamic `import()`. jsdelivr's `+esm` endpoint produces a single
 * pre-bundled ESM module with all internal sub-imports rewritten to
 * absolute URLs — necessary because the worker's blob-URL origin
 * has no module resolver of its own.
 *
 * Pinned to v4.2.0, which ships a brand-new native WebGPU runtime
 * (C++ rewrite, co-developed with the ONNX Runtime team). The v4
 * line keeps the same public API surface we use — `AutoTokenizer`,
 * `AutoProcessor`, `WhisperForConditionalGeneration`, `env`,
 * `model.generate`, `tokenizer.batch_decode`, and `transformers.full`
 * — so the migration from 3.7.1 was URL-only on the worker side.
 *
 * The v4 +esm bundle internally pulls
 * `onnxruntime-web@1.26.0-dev.20260416-b7804b056c/webgpu/+esm`,
 * which is the same ORT version we pin separately for Silero VAD
 * (see `ORT_WASM_CDN_URL`). Same-CDN + same-version means jsdelivr
 * dedups them so there's exactly one ORT runtime in play — no
 * fight over the WASM backend singleton.
 *
 * Bumping past 4.x requires re-verifying the worker's
 * `from_pretrained` ⇒ `dtype` ⇒ `device` config still matches what
 * the new version expects, plus re-pinning `ORT_WASM_CDN_URL` to
 * whatever ORT version that release ships internally — otherwise
 * Silero VAD and Whisper end up loading two different ORTs.
 *
 * ~2 MB ESM bundle on cold load (cached by browser per usual CDN
 * cache semantics). Whisper model weights are NOT served from here —
 * those come straight from huggingface.co per transformers.js's
 * built-in remote-model fetch.
 */
export const TRANSFORMERS_CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm'

/**
 * onnxruntime-web bundle, used inside the worker to load **Silero
 * VAD** (a tiny ONNX speech-activity classifier). Transformers.js
 * bundles ORT internally for its own model loading, but doesn't
 * re-export a clean `InferenceSession` constructor — so we load
 * ORT directly via this URL for the VAD pipeline.
 *
 * We pick the `wasm.bundle` variant: ~700 KB ESM with the WASM
 * binary inlined as base64. Silero is a sub-3 MB model that runs
 * in <5 ms on CPU regardless of WebGPU — no point pulling in the
 * full WebGPU bundle (~3 MB more) for a model that doesn't
 * benefit. Pinned to the same patch transformers.js 4.2.0 depends
 * on (`1.26.0-dev.20260416-b7804b056c`) so both sides agree on
 * tensor formats and share a single ORT runtime singleton via
 * jsdelivr's same-version dedup.
 *
 * ~700 KB ESM bundle on cold load, cached by browser CDN cache.
 * The 2 MB Silero model itself comes straight from huggingface.co.
 */
export const ORT_WASM_CDN_URL =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort.wasm.bundle.min.mjs'

/**
 * Silero VAD ONNX weights, fp16 quantisation. ~1.15 MB. Speech
 * activity classifier trained on 99 languages including Mandarin.
 *
 * The repo `onnx-community/silero-vad` exposes raw `.onnx` files
 * (no `config.json`, not a transformers.js-style model) so we load
 * it directly via `ort.InferenceSession.create(url)`.
 *
 * Model contract (from upstream Silero docs):
 *  - input  `input`:  Float32Array [batch=1, 576] = 64 samples context + 512 audio samples
 *  - input  `state`:  Float32Array [2, 1, 128], reset per session
 *  - input  `sr`:     BigInt64Array [1], value = 16000n
 *  - output `output`: Float32Array [1, 1], speech probability ∈ [0, 1]
 *  - output `stateN`: Float32Array [2, 1, 128], state for next call
 *
 * Window: exactly 512 samples (32 ms @ 16 kHz). We chunk our
 * 5 s rolling buffer into ~156 windows and average the probability
 * to decide whether the chunk contains speech.
 */
export const SILERO_VAD_MODEL_URL = 'https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model_fp16.onnx'

/**
 * Available ONNX-quantized Whisper models, all fetched from
 * huggingface.co by transformers.js on first use and cached in
 * the browser Cache API.
 *
 * **Chinese language note.** No Chinese-finetuned Whisper exists
 * in ONNX format on the Hub (verified — `transformers.js + whisper
 * chinese` returns zero results). Community Chinese finetunes
 * (Belle-whisper, etc.) haven't been ONNX-converted. Whisper Turbo
 * is the standard multilingual OpenAI Whisper-large-v3 weights
 * (trained on ~24 000 hours of Mandarin) with a distilled decoder
 * — strong Chinese ASR out of the box.
 *
 * **Why only Turbo.** Earlier dogfood testing exposed Base and
 * Small as not good enough for Chinese livestream captions: short-
 * utterance hallucinations, frequent looping on noisy / overlapping
 * speech, and substantially worse rare-word handling. Both tiers
 * were removed to avoid users picking them, getting a bad
 * experience, and concluding the whole feature is broken. The
 * Turbo download is large (560 MB → 1.6 GB) but is one-time and
 * cached forever in IndexedDB.
 *
 * **Two precision tiers** — same model weights from
 * `onnx-community/whisper-large-v3-turbo`, different ONNX
 * quantisations:
 *   - turbo:    q4f16 encoder + q4f16 decoder, ~560 MB  (1-2% WER
 *               above fp16, but 3× smaller download)
 *   - turbo-hq: fp16  encoder + fp16  decoder, ~1614 MB (default —
 *               matches wide.video's production config exactly,
 *               best Chinese accuracy we can offer in-browser)
 *
 * Why we default to fp16 (`turbo-hq`) and not q4f16: dogfood
 * measurements showed fp16 noticeably reduces hallucinations and
 * rare-word errors on Chinese livestream audio for a one-time
 * ~1 GB extra download that's cached forever in IndexedDB. For
 * the danmaku use case, transcription quality is what users
 * actually feel, and the download is a single up-front cost on
 * first-run — so fp16 is the right default. Users on
 * bandwidth- or storage-constrained machines can opt down to
 * q4f16 (`turbo`) in the settings tab.
 *
 * **Approximate Chinese WER** (CommonVoice zh-CN, published
 * Whisper benchmarks):
 *   - turbo:    ~7 %   (q4f16 — small lossy hit vs fp16)
 *   - turbo-hq: ~6 %   (fp16 — matches OpenAI release)
 *
 * `num_mel_bins` field exists because the large-v3 architecture
 * uses 128 mel bins. Passing the wrong value to the warm-up
 * `transformers.full([1, MEL, 3000])` call crashes the model.
 * Kept in the config rather than hard-coded so a future tier
 * (e.g. a hypothetical Whisper-small re-add) doesn't silently
 * break by inheriting the wrong default.
 */
export interface WhisperModelConfig {
  /** HuggingFace repo id, e.g. `onnx-community/whisper-large-v3-turbo`. */
  id: string
  /** Human-readable label for the UI picker. */
  label: string
  /** Approximate total download size, in MB. */
  approxDownloadMb: number
  /**
   * Encoder dtype. Constrained to the subset of `DataType` that's
   * actually shipped in the Whisper ONNX repos and known to work
   * on WebGPU. `fp32` / `fp16` are unquantized paths; `q4f16` is
   * Xenova's 4-bit-with-fp16-activations variant. Plain `q4`
   * encoders are broken upstream for Whisper, hence not exposed.
   *
   * Typed against `@huggingface/transformers`'s `DataType` so that
   * a future transformers.js release adding/renaming dtypes
   * surfaces as a TypeScript error here rather than a runtime
   * crash inside the worker.
   */
  encoderDtype: Extract<DataType, 'fp32' | 'fp16' | 'q4f16'>
  /**
   * Decoder dtype. `fp32` is unquantized; `fp16` matches
   * wide.video's large tier; `q4` is the smallest non-broken
   * option; `q4f16` mixes 4-bit weights with fp16 activations.
   */
  decoderDtype: Extract<DataType, 'fp32' | 'fp16' | 'q4' | 'q4f16'>
  /** Mel filter-bank count — passed to the warm-up dummy spectrogram. */
  numMelBins: 80 | 128
}

export const WHISPER_MODELS = {
  turbo: {
    id: 'onnx-community/whisper-large-v3-turbo',
    label: 'Turbo — 560MB / 推荐 / q4f16 量化',
    approxDownloadMb: 560,
    encoderDtype: 'q4f16',
    decoderDtype: 'q4f16',
    numMelBins: 128,
  },
  'turbo-hq': {
    id: 'onnx-community/whisper-large-v3-turbo',
    label: 'Turbo HQ — 1.6GB / fp16 全精度',
    approxDownloadMb: 1614,
    encoderDtype: 'fp16',
    decoderDtype: 'fp16',
    numMelBins: 128,
  },
} as const satisfies Record<string, WhisperModelConfig>

export type WhisperModelKey = keyof typeof WHISPER_MODELS

/** Default model — `turbo-hq` matches wide.video's production
 *  config (fp16 weights, ~1.6 GB) for the best Chinese accuracy
 *  on M-series WebGPU. Users on bandwidth- or storage-constrained
 *  machines can switch to `turbo` (q4f16, ~560 MB) and accept the
 *  1-2% WER hit. */
export const DEFAULT_WHISPER_MODEL: WhisperModelKey = 'turbo-hq'

/**
 * API endpoint URLs used by the script.
 */
export const BASE_URL = {
  /** Fetches room basic info. GET, param: id (room ID). */
  BILIBILI_ROOM_INIT: 'https://api.live.bilibili.com/room/v1/Room/room_init',

  /** Send chat. POST, params: web_location, w_rid, wts. */
  BILIBILI_MSG_SEND: 'https://api.live.bilibili.com/msg/send',

  /** Chat config. POST. */
  BILIBILI_MSG_CONFIG: 'https://api.live.bilibili.com/xlive/web-room/v1/dM/AjaxSetConfig',

  /** Get danmaku config by group. GET, params: room_id, web_location, w_rid, wts. */
  BILIBILI_GET_DM_CONFIG: 'https://api.live.bilibili.com/xlive/web-room/v1/dM/GetDMConfigByGroup',

  /** Get emoticons for a room. GET, params: platform, room_id. */
  BILIBILI_GET_EMOTICONS: 'https://api.live.bilibili.com/xlive/web-ucenter/v2/emoticon/GetEmoticons',

  LAPLACE_CHAT_AUDIT: 'https://edge-workers.laplace.cn/laplace/chat-audit',

  REMOTE_KEYWORDS: 'https://workers.vrp.moe/gh-raw/laplace-live/public/master/artifacts/livesrtream-keywords.json',

  LAPLACE_MEMES: 'https://workers.vrp.moe/laplace/memes',
  LAPLACE_MEME_COPY: 'https://workers.vrp.moe/laplace/meme-copy',

  /**
   * 主播信息聚合查询 (Laplace fertility / guild / MCN database).
   *
   * GET `${LAPLACE_BILIBILI_USER}/${uid}` — returns
   * `LaplaceInternal.HTTPS.Workers.BilibiliUser`. Used by the info button
   * popover to surface guild / MCN history when those toggles are on.
   * Separate from `LAPLACE_FERTILITY` so a user opting out of fertility
   * data doesn't accidentally trigger that endpoint via this URL.
   */
  LAPLACE_BILIBILI_USER: 'https://workers.vrp.moe/laplace/bilibili-user',

  /**
   * 魔法期查询 (Laplace fertility cycle).
   *
   * GET `${LAPLACE_FERTILITY}/${uid}` — returns
   * `LaplaceInternal.HTTPS.Workers.FertilityUserResponse`. 404 means the
   * uid isn't in the dataset (a normal "no data" outcome we render as a
   * gray pill, not an error).
   */
  LAPLACE_FERTILITY: 'https://workers.vrp.moe/laplace/fertility',
} as const
