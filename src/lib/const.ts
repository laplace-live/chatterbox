/** App-identity strings for OpenRouter's `HTTP-Referer` + `X-Title` attribution headers; sent on every LLM request (other providers ignore them). */
export const PROJECT_NAME = 'LAPLACE Chatterbox'
export const PROJECT_URL = 'https://laplace.live/chatterbox'
export const GITHUB_URL = 'https://github.com/laplace-live/chatterbox'
export const DOCUMENT_URL = 'https://subspace.institute/docs/laplace-chatterbox'

/** Soniox STT SDK. ESM-only; point at the package's self-contained `dist/index.mjs` (no bare-specifier imports) to avoid a transitive-dep waterfall. */
export const SONIOX_CDN_URL = 'https://unpkg.com/@soniox/client@2.2.0/dist/index.mjs'

/** Soniox REST API root; append a path e.g. `${SONIOX_API_BASE}/models`. */
export const SONIOX_API_BASE = 'https://api.soniox.com/v1'

/** ElevenLabs Scribe v2 Realtime STT WebSocket. Talk the protocol directly: `@elevenlabs/client` bundles livekit-client whose webrtc-adapter shim throws (`'ontrack' in undefined`) at import time in the bilibili page. */
export const ELEVENLABS_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'

/** ElevenLabs REST API root. Mint the WS token via `${ELEVENLABS_API_BASE}/single-use-token/realtime_scribe` (15 min, single-use) since a WebSocket can't set the `xi-api-key` header; the key rides the `token` query param instead. */
export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1'

/** Deepgram realtime STT WebSocket. Auth via the `Sec-WebSocket-Protocol` subprotocol (`['token', apiKey]`) — passes the key without an `Authorization` header, so no token mint and no CORS. */
export const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen'

/** Deepgram REST API root; `${DEEPGRAM_API_BASE}/models` lists realtime STT models. No CORS for third-party origins, so this fetch must go through `GM_xmlhttpRequest` (`@connect api.deepgram.com`). */
export const DEEPGRAM_API_BASE = 'https://api.deepgram.com/v1'

/** Gladia realtime STT. No fixed WS URL: `POST ${GLADIA_API_BASE}/live` (header `x-gladia-key`) returns a one-shot WS URL with an embedded session token. Init endpoint sends permissive CORS, so a plain `fetch` works — no `GM_xmlhttpRequest`. */
export const GLADIA_API_BASE = 'https://api.gladia.io/v2'

/** Default realtime model id per provider; fallback when a session passes no model id. */
export const SONIOX_DEFAULT_MODEL = 'stt-rt-v5'
export const ELEVENLABS_DEFAULT_MODEL = 'scribe_v2_realtime'
export const DEEPGRAM_DEFAULT_MODEL = 'nova-3'
export const GLADIA_DEFAULT_MODEL = 'solaria-1'

/** mpegts.js FLV / MPEG-TS demuxer. UMD bundle — assigns to `window.mpegts` at runtime. */
export const MPEGTS_CDN_URL = 'https://unpkg.com/mpegts.js@1.8.0/dist/mpegts.js'

/** API endpoint URLs used by the script. */
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

  /** 主播信息聚合查询. GET `${LAPLACE_BILIBILI_USER}/${uid}` → `LaplaceInternal.HTTPS.Workers.BilibiliUser`. Kept separate from `LAPLACE_FERTILITY` so opting out of fertility data can't trigger that endpoint via this URL. */
  LAPLACE_BILIBILI_USER: 'https://workers.vrp.moe/laplace/bilibili-user',

  /** 魔法期查询. GET `${LAPLACE_FERTILITY}/${uid}` → `LaplaceInternal.HTTPS.Workers.FertilityUserResponse`. 404 means the uid isn't in the dataset (normal "no data", rendered as a gray pill, not an error). */
  LAPLACE_FERTILITY: 'https://workers.vrp.moe/laplace/fertility',
} as const
