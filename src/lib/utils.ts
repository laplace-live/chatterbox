import { DEFAULT_INVISIBLE_CHAR, INVISIBLE_CHAR_CUSTOM, INVISIBLE_CHAR_PRESETS } from './const'

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

/** True when `raw` is an absolute http(s) URL. Protocol is checked because `new URL` parses schemeless `host:port` with a bogus protocol. */
export function isHttpUrl(raw: string): boolean {
  try {
    return /^https?:$/.test(new URL(raw).protocol)
  } catch {
    return false
  }
}

/** True for any non-null object (arrays included), so untyped JSON/page globals can be read key-by-key as `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `module_author` of the `MODULE_TYPE_AUTHOR` entry in an opus `__INITIAL_STATE__.detail`; `pub_ts` is Unix seconds. */
function findOpusModuleAuthor(detail: unknown): Record<string, unknown> | undefined {
  const modules: unknown[] = isRecord(detail) && Array.isArray(detail.modules) ? detail.modules : []
  const authorModule = modules.find(m => isRecord(m) && m.module_type === 'MODULE_TYPE_AUTHOR')
  return isRecord(authorModule) && isRecord(authorModule.module_author) ? authorModule.module_author : undefined
}

/**
 * Extracts the author's UID from an opus page's SSR snapshot (prefers module `mid`, falls back to `basic.uid`).
 * The URL carries the post id not a uid, so identity comes from the global, not the path.
 * DOM is deliberately not scraped: opus pages link to unrelated users (fav lists, recs). Traverses defensively.
 */
export function extractOpusAuthorUid(initialState: unknown): number | undefined {
  const detail = isRecord(initialState) ? initialState.detail : undefined
  if (!isRecord(detail)) return undefined

  const authorMid = findOpusModuleAuthor(detail)?.mid
  if (typeof authorMid === 'number' && Number.isFinite(authorMid) && authorMid > 0) return authorMid

  const uid = Number(isRecord(detail.basic) ? detail.basic.uid : undefined)
  if (Number.isFinite(uid) && uid > 0) return uid

  return undefined
}

/**
 * Extracts the opus publish date as `YYYY-MM-DD` from the SSR snapshot, or undefined if no usable pub_ts.
 * Uses `pub_ts` not `pub_time` (the latter reads "编辑于 …" after an edit). Asia/Shanghai: timestamps are Beijing time.
 */
export function extractOpusPubDate(initialState: unknown): string | undefined {
  const detail = isRecord(initialState) ? initialState.detail : undefined
  const pubTs = findOpusModuleAuthor(detail)?.pub_ts
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
 * Emote-safe insertion slots for `graphemes`: slot `k` inserts before `graphemes[k]` (or at the end
 * when `k === length`). Every slot strictly inside a balanced `[...]` bracket is excluded, since a
 * char there breaks B站 emote rendering; unbalanced brackets restrict nothing. Outer ends are always
 * valid, so a non-empty string always has ≥2 slots.
 */
function allowedInsertIndices(graphemes: string[]): number[] {
  const forbidden = new Set<number>()
  let openAt = -1
  for (let i = 0; i < graphemes.length; i++) {
    const g = graphemes[i]
    if (g === '[') {
      openAt = i
    } else if (g === ']' && openAt !== -1) {
      // `close` inclusive: inserting before `]` is still inside the bracket.
      for (let k = openAt + 1; k <= i; k++) forbidden.add(k)
      openAt = -1
    }
  }
  const allowed: number[] = []
  for (let k = 0; k <= graphemes.length; k++) {
    if (!forbidden.has(k)) allowed.push(k)
  }
  return allowed
}

/**
 * Inserts `char` at a random emote-safe position. When `avoidIndex` is set and another slot exists,
 * that slot is skipped so a repeated message never varies at the same spot twice in a row.
 * @returns the new text and the chosen grapheme index (offset into the ORIGINAL `text`; -1 for empty input).
 */
export function insertRandomChar(text: string, char: string, avoidIndex?: number): { text: string; index: number } {
  if (!text || text.length === 0) return { text, index: -1 }

  const graphemes = getGraphemes(text)
  let allowed = allowedInsertIndices(graphemes)
  if (allowed.length === 0) allowed = [graphemes.length]
  if (avoidIndex !== undefined && allowed.length > 1) {
    const pruned = allowed.filter(k => k !== avoidIndex)
    if (pruned.length > 0) allowed = pruned
  }

  const idx = allowed[Math.floor(Math.random() * allowed.length)] ?? graphemes.length
  graphemes.splice(idx, 0, char)
  return { text: graphemes.join(''), index: idx }
}

/**
 * Inserts `char` at a random position for dedup-bypass. Grapheme-safe and emote-safe:
 * never lands inside a balanced `[...]` bracket (would break B站 emote rendering). Falls back to appending.
 */
export function addRandomCharacter(text: string, char: string): string {
  return insertRandomChar(text, char).text
}

/** Formats each code point as `U+XXXX`, space-separated. */
export function formatCodePoints(str: string): string {
  return Array.from(str, c => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ')
}

/**
 * Parses the custom insert-char field. Input made only of `U+XXXX` code points (whitespace-separated) is decoded,
 * since invisible chars can't be typed; anything else is literal. `null` = surrogate or out-of-range code point.
 */
export function parseCustomChar(input: string): string | null {
  if (!/^\s*(?:U\+[0-9a-f]{4,6}\s*)+$/i.test(input)) return input
  let out = ''
  for (const [, hex] of input.matchAll(/U\+([0-9a-f]{4,6})/gi)) {
    const cp = Number.parseInt(hex, 16)
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null
    out += String.fromCodePoint(cp)
  }
  return out
}

/** Resolves the char to insert; an unknown preset or empty/invalid custom input falls back to `DEFAULT_INVISIBLE_CHAR`. */
export function resolveInvisibleChar(preset: string, custom: string): string {
  if (preset === INVISIBLE_CHAR_CUSTOM) return parseCustomChar(custom) || DEFAULT_INVISIBLE_CHAR
  return INVISIBLE_CHAR_PRESETS.some(p => p.char === preset) ? preset : DEFAULT_INVISIBLE_CHAR
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
 * Splits lines, optionally inserts `randomChar` into each (see `addRandomCharacter`), trims to max length per message.
 */
export function processMessages(text: string, maxLength: number, randomChar?: string): string[] {
  return text
    .split('\n')
    .flatMap(line => {
      let l = line
      if (randomChar && l?.trim()) {
        l = addRandomCharacter(l, randomChar)
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
