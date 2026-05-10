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
} as const
