/**
 * App-identity strings used in outbound HTTP headers (currently only
 * for LLM API calls — see `lib/llm.ts`). They specifically target
 * OpenRouter's `HTTP-Referer` + `X-Title` attribution headers, which
 * surface this project on OpenRouter's public rankings / analytics.
 *
 * - `GITHUB_URL` is the canonical GitHub URL so anyone clicking through
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
export const PROJECT_NAME = 'LAPLACE Chatterbox'
export const PROJECT_URL = 'https://laplace.live/chatterbox'
export const GITHUB_URL = 'https://github.com/laplace-live/chatterbox'
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
 * Soniox REST API root. Endpoints are built by appending a path — e.g.
 * `${SONIOX_API_BASE}/models` to list available STT models. The base is
 * fixed (Soniox-hosted), unlike the user-configurable LLM endpoint, so it
 * lives here as a constant rather than a setting.
 */
export const SONIOX_API_BASE = 'https://api.soniox.com/v1'

/**
 * ElevenLabs Scribe v2 Realtime speech-to-text WebSocket endpoint.
 *
 * We talk the protocol directly rather than via `@elevenlabs/client`: that SDK
 * bundles `livekit-client`, whose webrtc-adapter shim runs at import time and
 * throws (`'ontrack' in undefined`) in the bilibili page context — and Scribe
 * realtime is a plain WebSocket that never needs WebRTC anyway. The engine
 * appends `?token=&model_id=&audio_format=pcm_16000&commit_strategy=vad`
 * (+ optional `language_code`) and streams base64 PCM16 chunks.
 */
export const ELEVENLABS_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'

/**
 * ElevenLabs REST API root. We hit `${ELEVENLABS_API_BASE}/single-use-token/
 * realtime_scribe` to mint the short-lived (15 min, single-use) token the
 * WebSocket needs — browsers can't set the `xi-api-key` header on a WebSocket,
 * so the key rides the `token` query param instead and never travels on the
 * socket itself. Fixed (ElevenLabs-hosted), like `SONIOX_API_BASE`.
 */
export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1'

/**
 * Deepgram realtime speech-to-text WebSocket endpoint. The engine appends
 * `?model=&language=&encoding=linear16&sample_rate=16000&channels=1&
 * interim_results=true&...` and authenticates via the `Sec-WebSocket-Protocol`
 * subprotocol (`['token', apiKey]`) — the browser-blessed way to pass the key
 * without an `Authorization` header, so no token mint and no CORS in play.
 */
export const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen'

/**
 * Deepgram REST API root. We hit `${DEEPGRAM_API_BASE}/models` to list the
 * realtime (`streaming: true`) STT models for the picker. Deepgram doesn't send
 * CORS headers for third-party origins, so that fetch must go through
 * `GM_xmlhttpRequest` (declared via `@connect api.deepgram.com`); the WebSocket
 * stream above needs neither.
 */
export const DEEPGRAM_API_BASE = 'https://api.deepgram.com/v1'

/**
 * mpegts.js FLV / MPEG-TS demuxer. UMD bundle — assigns its exports
 * to `window.mpegts` at runtime, picked up via the shared
 * `loadUmdScript()` probe path.
 */
export const MPEGTS_CDN_URL = 'https://unpkg.com/mpegts.js@1.8.0/dist/mpegts.js'

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
