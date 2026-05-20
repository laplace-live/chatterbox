import { GM_info } from '$'

/**
 * Userscript version, sourced from the `// @version` header that
 * vite-plugin-monkey generates from `helper/package.json`. Importing
 * `GM_info` from `$` lets vite-plugin-monkey track the dependency and add
 * the matching `@grant`.
 */
export const VERSION = GM_info.script.version

/**
 * Soniox real-time speech-to-text SDK (v2). ESM-only package; we point
 * at the package's own `dist/index.mjs` and load it via `<script
 * type="module">` injection at first 「开始同传」 click — see
 * `src/lib/soniox.ts`. Pinned to a specific version so a breaking
 * upstream change doesn't silently land in user browsers on next CDN
 * cache miss; bump deliberately when validating a new version, and keep
 * in sync with the `@soniox/client` version pinned in `package.json`
 * (installed purely for `import type { ... } from '@soniox/client'` so
 * the locally-checked types stay accurate against the runtime ESM we
 * fetch).
 */
export const SONIOX_CDN_URL = 'https://unpkg.com/@soniox/client@2.1.0/dist/index.mjs'

/**
 * mpegts.js FLV / MPEG-TS demuxer used by 仅音频模式. UMD bundle —
 * assigns its exports to `window.mpegts` at runtime; picked up via the
 * shared `loadScript()` probe in `src/lib/audio-only.ts`. Pinned for the
 * same reasons as `SONIOX_CDN_URL` above; keep in sync with
 * `package.json` (installed only for `import type Mpegts from
 * 'mpegts.js'`).
 */
export const MPEGTS_CDN_URL = 'https://unpkg.com/mpegts.js@1.8.0/dist/mpegts.js'

/**
 * API endpoint URLs used by the script.
 */
export const BASE_URL = {
  /** Fetches room basic info. GET, param: id (room ID). */
  BILIBILI_ROOM_INIT: 'https://api.live.bilibili.com/room/v1/Room/room_init',

  /** Alternative room info endpoint. GET, param: room_id. Fallback when room_init fails. */
  BILIBILI_ROOM_INIT_ALT: 'https://api.live.bilibili.com/room/v1/Room/get_info',

  /** Resolve live room info by anchor UID. GET, param: mid. */
  BILIBILI_ROOM_INFO_BY_UID: 'https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld',

  /** Send chat. POST, params: web_location, w_rid, wts. */
  BILIBILI_MSG_SEND: 'https://api.live.bilibili.com/msg/send',

  /** Chat config. POST. */
  BILIBILI_MSG_CONFIG: 'https://api.live.bilibili.com/xlive/web-room/v1/dM/AjaxSetConfig',

  /** Get danmaku config by group. GET, params: room_id, web_location, w_rid, wts. */
  BILIBILI_GET_DM_CONFIG: 'https://api.live.bilibili.com/xlive/web-room/v1/dM/GetDMConfigByGroup',

  /** Get live WebSocket token and host list. GET, param: id (real room ID). */
  BILIBILI_DANMU_INFO: 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo',

  /** Get emoticons for a room. GET, params: platform, room_id. */
  BILIBILI_GET_EMOTICONS: 'https://api.live.bilibili.com/xlive/web-ucenter/v2/emoticon/GetEmoticons',

  /** All fan medals for a user. GET, param: target_id. */
  BILIBILI_MEDAL_WALL: 'https://api.live.bilibili.com/xlive/web-ucenter/user/MedalWall',

  /** Followed anchors for the logged-in account. GET, params: vmid, pn, ps. */
  BILIBILI_FOLLOWINGS: 'https://api.bilibili.com/x/relation/followings',

  /** Current viewer info in a live room. GET, param: room_id. */
  BILIBILI_ROOM_USER_INFO: 'https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByUser',

  /** Room silent list. Usually only available to anchors/admins. */
  BILIBILI_SILENT_USER_LIST: 'https://api.live.bilibili.com/xlive/web-ucenter/v1/banned/GetSilentUserList',

  LAPLACE_CHAT_AUDIT: 'https://edge-workers.laplace.cn/laplace/chat-audit',

  REMOTE_KEYWORDS: 'https://workers.vrp.moe/gh-raw/laplace-live/public/master/artifacts/livesrtream-keywords.json',

  LAPLACE_MEMES: 'https://workers.vrp.moe/laplace/memes',
  LAPLACE_MEME_COPY: 'https://workers.vrp.moe/laplace/meme-copy',
  BILIBILI_AVATAR: 'https://workers.vrp.moe/bilibili/avatar',
  BILIBILI_SUPERCHAT_ORDER: 'https://workers.vrp.moe/bilibili/live-create-order',

  /** sbhzm.cn community meme list (paginated). GET, params: page, page_size. */
  SBHZM_MEMES: 'https://sbhzm.cn/api/public/memes',
  /** sbhzm.cn random meme endpoint. GET. Used as fallback when paginated list is empty. */
  SBHZM_MEMES_RANDOM: 'https://sbhzm.cn/api/public/memes/random',
  /** sbhzm.cn tag dictionary (id ↔ name). GET. Used to resolve tag names → ids when uploading. */
  SBHZM_TAGS: 'https://sbhzm.cn/api/public/tags',
  /**
   * sbhzm.cn meme submission. POST, JSON body `{ content, tag_ids: number[] }`.
   * NOTE: Unauthenticated despite the `/admin/` path. Returns the inserted row
   * (including auto-generated `id`) on success.
   */
  SBHZM_SUBMIT_MEME: 'https://sbhzm.cn/api/admin/memes',
  /** sbhzm.cn submit page (kept as user-facing fallback link). */
  SBHZM_SUBMIT_PAGE: 'https://sbhzm.cn/submit',

  /**
   * chatterbox-cloud 后端基础 URL(自建第三方烂梗库 + LAPLACE/SBHZM 聚合)。
   * Phase A 阶段:仅有 GET /health 和 GET /memes(写死 3 条样例)。
   * 默认指向待部署的生产域名;开发期通过 cbBackendUrlOverride GM-signal 指到本地
   * `http://localhost:8787`。读取应走 `getCbBackendBaseUrl()`(cb-backend-client.ts)。
   */
  CB_BACKEND: 'https://chatterbox-cloud.aijc-eric.workers.dev',

  /**
   * live-meme-radar 后端基础 URL(独立的"meme 雷达"传感器项目)。
   * 公开端点:GET /radar/clusters/today、/cluster-rank、/amplifiers/today。
   * 部署在自家 Cloudflare Worker;本地开发期通过 radarBackendUrlOverride
   * GM-signal 指到 `http://localhost:8788` 等。读取走
   * `getRadarBackendBaseUrl()`(radar-client.ts)。
   */
  RADAR_BACKEND: 'https://live-meme-radar.aijc-eric.workers.dev',

  /** Anthropic Messages API. POST. Used by 智能辅助驾驶 LLM mode. */
  ANTHROPIC_MESSAGES: 'https://api.anthropic.com/v1/messages',
  /** OpenAI chat completions. POST. Also reused for OpenAI-compatible providers via custom base URL. */
  OPENAI_CHAT: 'https://api.openai.com/v1/chat/completions',
} as const

/**
 * Sentinel **query parameter** that Chatterbox attaches to its own
 * `/msg/send` requests so the fetch hijack in `fetch-hijack.ts` can
 * distinguish them from native Bilibili UI sends and skip the duplicate
 * verification path.
 *
 * NOTE: must use a URL marker, not a custom request header. Custom headers
 * trigger a CORS preflight on `api.live.bilibili.com`, which B站 rejects,
 * which would break every Chatterbox-initiated send with `Failed to fetch`.
 * Unknown query params are ignored by the API and CORS-safelisted.
 */
export const CHATTERBOX_SEND_PARAM = 'cb_send'
export const CHATTERBOX_SEND_VALUE = '1'
export const CHATTERBOX_SEND_MARKER = `${CHATTERBOX_SEND_PARAM}=${CHATTERBOX_SEND_VALUE}`

/**
 * GitHub issues URL surfaced in user-facing error messages so people can
 * file actionable reports instead of a generic "doesn't work" thread.
 */
export const ISSUES_URL = 'https://github.com/aijc123/bilibili-live-wheel-auto-follow/issues'
