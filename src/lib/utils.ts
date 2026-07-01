/** 1σ of send-interval jitter as a fraction of the base interval; samples clamped to ±2σ. */
const SEND_JITTER_SIGMA = 0.2

/**
 * Splits a string into grapheme clusters (user-perceived characters).
 */
export function getGraphemes(str: string): string[] {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })
  return Array.from(segmenter.segment(str), ({ segment }) => segment)
}

/**
 * Emoji-safe split of text into parts by maximum grapheme length.
 */
export function trimText(text: string, maxLength: number): string[] {
  if (!text) return [text]

  const graphemes = getGraphemes(text)
  if (graphemes.length <= maxLength) return [text]

  const parts: string[] = []
  let currentPart: string[] = []
  let currentLength = 0

  for (const char of graphemes) {
    if (currentLength >= maxLength) {
      parts.push(currentPart.join(''))
      currentPart = [char]
      currentLength = 1
    } else {
      currentPart.push(char)
      currentLength++
    }
  }

  if (currentPart.length > 0) {
    parts.push(currentPart.join(''))
  }

  return parts
}

/**
 * Strips trailing punctuation (for live captions).
 */
export function stripTrailingPunctuation(text: string): string {
  if (!text) return text
  return text.replace(/[.,!?;:。，、！？；：…]+$/, '')
}

const SENTENCE_PUNCT = new Set(['.', '?', '!', '。', '？', '！', '…'])
const CLAUSE_PUNCT = new Set([',', ';', ':', '、', '，', '；', '：'])

/**
 * Length-bounded grapheme split preferring natural breaks (sentence punct, then
 * clause punct, then whitespace within `lookback`) over a blind cut at `maxLen`.
 * Tail smaller than `minTail` steals graphemes from the previous chunk; `maxLen` still holds.
 */
export function splitTextSmart(
  text: string,
  maxLen: number,
  opts: { lookback?: number; minTail?: number } = {}
): string[] {
  if (!text || maxLen <= 0) return [text]
  const graphemes = getGraphemes(text)
  if (graphemes.length <= maxLen) return [text]

  const lookback = opts.lookback ?? Math.max(4, Math.floor(maxLen / 3))
  // Cap minTail at maxLen so the rebalance can't grow a chunk past maxLen.
  const minTail = Math.min(maxLen, opts.minTail ?? Math.max(3, Math.floor(maxLen / 8)))

  const isWs = (g: string): boolean => g.length === 1 && /\s/.test(g)

  const parts: string[] = []
  let i = 0
  while (i < graphemes.length) {
    // Skip leading whitespace so a cut after "punct + space" leaves no stray leading space.
    while (i < graphemes.length && isWs(graphemes[i])) i++
    if (i >= graphemes.length) break

    const remaining = graphemes.length - i
    if (remaining <= maxLen) {
      parts.push(graphemes.slice(i).join(''))
      break
    }
    const windowEnd = i + maxLen
    const minBreak = Math.max(i + 1, windowEnd - lookback)
    let cut = -1
    let skipNext = 0
    for (let j = windowEnd - 1; j >= minBreak; j--) {
      if (SENTENCE_PUNCT.has(graphemes[j])) {
        cut = j + 1
        break
      }
    }
    if (cut === -1) {
      for (let j = windowEnd - 1; j >= minBreak; j--) {
        if (CLAUSE_PUNCT.has(graphemes[j])) {
          cut = j + 1
          break
        }
      }
    }
    if (cut === -1) {
      for (let j = windowEnd - 1; j >= minBreak; j--) {
        if (isWs(graphemes[j])) {
          // consume the whitespace so it lands in neither chunk
          cut = j
          skipNext = 1
          break
        }
      }
    }
    if (cut === -1) cut = windowEnd
    parts.push(graphemes.slice(i, cut).join(''))
    i = cut + skipNext
  }

  if (parts.length >= 2) {
    const lastG = getGraphemes(parts[parts.length - 1])
    if (lastG.length < minTail) {
      const prevG = getGraphemes(parts[parts.length - 2])
      const transfer = Math.min(minTail - lastG.length, prevG.length - 1)
      if (transfer > 0) {
        parts[parts.length - 2] = prevG.slice(0, prevG.length - transfer).join('')
        parts[parts.length - 1] = prevG.slice(prevG.length - transfer).join('') + parts[parts.length - 1]
      }
    }
  }

  return parts
}

/**
 * Extracts the room number from a Bilibili live room URL.
 */
export function extractRoomNumber(url: string): string | undefined {
  const urlObj = new URL(url)
  const pathSegments = urlObj.pathname.split('/').filter(segment => segment !== '')
  return pathSegments.find(segment => Number.isInteger(Number(segment)))
}

/**
 * Extracts the BV id from a Bilibili video URL. Case-sensitive (base58).
 * @returns undefined for paths with no BV id (e.g. legacy `/video/av170001`).
 */
export function extractBvid(url: string): string | undefined {
  const urlObj = new URL(url)
  const pathSegments = urlObj.pathname.split('/').filter(segment => segment !== '')
  return pathSegments.find(segment => /^BV[0-9A-Za-z]+$/.test(segment))
}

/** Narrowed `window.__INITIAL_STATE__` shape for an opus page (author-identity fields only). */
interface OpusInitialState {
  detail?: {
    /** Author uid as a string, e.g. `"1802654492"`. */
    basic?: { uid?: string | number }
    /** Author lives in the `MODULE_TYPE_AUTHOR` entry; `pub_ts` is Unix seconds. */
    modules?: Array<{ module_type?: string; module_author?: { mid?: number; pub_ts?: string | number } }>
  }
}

/**
 * Extracts the author's UID from an opus page's SSR snapshot (prefers module `mid`, falls back to `basic.uid`).
 * The URL carries the post id not a uid, so identity comes from the global, not the path.
 * DOM is deliberately not scraped: opus pages link to unrelated users (fav lists, recs). Traverses defensively.
 */
export function extractOpusAuthorUid(initialState: unknown): number | undefined {
  const detail = (initialState as OpusInitialState | undefined)?.detail
  if (!detail) return undefined

  const authorMid = detail.modules?.find(m => m?.module_type === 'MODULE_TYPE_AUTHOR')?.module_author?.mid
  if (typeof authorMid === 'number' && Number.isFinite(authorMid) && authorMid > 0) return authorMid

  const uid = Number(detail.basic?.uid)
  if (Number.isFinite(uid) && uid > 0) return uid

  return undefined
}

/**
 * Extracts the opus publish date as `YYYY-MM-DD` from the SSR snapshot, or undefined if no usable pub_ts.
 * Uses `pub_ts` not `pub_time` (the latter reads "编辑于 …" after an edit). Asia/Shanghai: timestamps are Beijing time.
 */
export function extractOpusPubDate(initialState: unknown): string | undefined {
  const detail = (initialState as OpusInitialState | undefined)?.detail
  const pubTs = detail?.modules?.find(m => m?.module_type === 'MODULE_TYPE_AUTHOR')?.module_author?.pub_ts
  const seconds = Number(pubTs)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return new Date(seconds * 1000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

/**
 * Builds the laplace.live /ovu contribution link: `?uid=<uid>[&source=<url>][&date=<YYYY-MM-DD>]`.
 * `source` and `date` are only known on `/opus/*` pages, so they're optional.
 */
export function buildOvuContributeUrl(
  uid: number,
  opts: { source?: string | null; date?: string | null } = {}
): string {
  const params = new URLSearchParams({ uid: String(uid) })
  if (opts.source) params.set('source', opts.source)
  if (opts.date) params.set('date', opts.date)
  return `https://laplace.live/ovu?${params.toString()}`
}

/** Runs `cb` once the DOM is parsed — immediately if already done, else on `DOMContentLoaded`. */
export function whenDomReady(cb: () => void): void {
  if (document.readyState !== 'loading') cb()
  else document.addEventListener('DOMContentLoaded', () => cb(), { once: true })
}

/**
 * Inserts a random soft hyphen (U+00AD) for dedup-bypass. Grapheme-safe and emote-safe:
 * never lands inside a balanced `[...]` bracket (would break B站 emote rendering). Falls back to appending.
 */
export function addRandomCharacter(text: string): string {
  if (!text || text.length === 0) return text

  const graphemes = getGraphemes(text)

  // Insertion at index k means "before graphemes[k]" (or at the end
  // when k === graphemes.length). Mark every k that falls strictly
  // inside a balanced `[...]` bmote as forbidden — i.e. k between
  // (open+1) and (close), inclusive of close, since position `close`
  // inserts BEFORE the `]` and is still inside the bracket.
  const forbidden = new Set<number>()
  let openAt = -1
  for (let i = 0; i < graphemes.length; i++) {
    const g = graphemes[i]
    if (g === '[') {
      openAt = i
    } else if (g === ']' && openAt !== -1) {
      for (let k = openAt + 1; k <= i; k++) forbidden.add(k)
      openAt = -1
    }
  }

  const allowed: number[] = []
  for (let k = 0; k <= graphemes.length; k++) {
    if (!forbidden.has(k)) allowed.push(k)
  }

  const idx =
    allowed.length > 0 ? (allowed[Math.floor(Math.random() * allowed.length)] ?? graphemes.length) : graphemes.length

  graphemes.splice(idx, 0, '­')
  return graphemes.join('')
}

/**
 * One sample from a standard normal (mean 0, variance 1) via Box-Muller (cosine half only).
 * `u1 || 1e-9` guards `Math.random() === 0`, which would give `log(0)` and propagate NaN.
 */
function sampleStandardNormal(): number {
  const u1 = Math.random() || 1e-9
  const u2 = Math.random()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/**
 * Sleep duration (ms) between auto-send iterations: `intervalSeconds * 1000` plus optional
 * Gaussian jitter (σ = `SEND_JITTER_SIGMA * baseMs`, clamped ±2σ). Result clamped ≥ 0 for `setTimeout`.
 */
export function resolveSendDelayMs(intervalSeconds: number, random: boolean): number {
  const baseMs = intervalSeconds * 1000
  if (!random) return Math.max(0, baseMs)
  const sigmaMs = baseMs * SEND_JITTER_SIGMA
  const clampedSample = Math.max(-2, Math.min(2, sampleStandardNormal()))
  return Math.max(0, Math.round(baseMs + clampedSample * sigmaMs))
}

/**
 * Maps Bilibili danmaku error codes to human-readable messages.
 */
export function formatDanmakuError(error: string | undefined): string {
  if (!error) return '未知错误'
  if (error === 'f' || error.includes('f')) return 'f - 包含全局屏蔽词'
  if (error === 'k' || error.includes('k')) return 'k - 包含房间屏蔽词'
  return error
}

/**
 * Splits lines, optionally adds random chars, trims to max length per message.
 */
export function processMessages(text: string, maxLength: number, addRandomChar = false): string[] {
  return text
    .split('\n')
    .flatMap(line => {
      let l = line
      if (addRandomChar && l?.trim()) {
        l = addRandomCharacter(l)
      }
      return trimText(l, maxLength)
    })
    .filter(line => line?.trim())
}

/**
 * Whether a CDN `host` (`https://<host>`, no path) points at a raw IP rather than a hostname.
 * Matches IPv4 (with optional port) and bracketed IPv6; hostnames with a non-numeric label return false.
 */
export function isIpHost(host: string): boolean {
  // Strip scheme + port + path so we're left with just the authority.
  let authority = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  // Bracketed IPv6 literal.
  if (authority.startsWith('[') && authority.includes(']')) return true
  // Drop trailing `:port` for IPv4 / hostname comparison.
  authority = authority.replace(/:\d+$/, '')
  // Bare IPv4: four dot-separated decimal octets and nothing else.
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(authority)
}
