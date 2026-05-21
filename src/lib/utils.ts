/**
 * Sigma (1σ) of the send-interval jitter, expressed as a fraction of the
 * base interval. Used by `resolveSendDelayMs` when randomness is enabled.
 * 0.10 means ~68% of delays fall within ±10% of the user's configured
 * interval, and ~95% within ±20% (samples are clamped to ±2σ to bound the
 * worst case so a freak Gaussian draw can't, e.g., schedule a 5-minute
 * pause when the user set 1 second). Tune here.
 */
const SEND_JITTER_SIGMA = 0.1

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
 * Length-bounded grapheme split that prefers natural break points over a
 * blind cut at `maxLen`.
 *
 * Strategy per chunk:
 *  1. If remaining text fits, emit it as the final chunk.
 *  2. Otherwise look for a sentence-ending punct (`。？！…` etc.) within the
 *     last `lookback` graphemes of the maxLen window; cut just after it.
 *  3. If none, fall back to clause punct (`，、；：` etc.) in the same window.
 *  4. If still none, fall back to whitespace (word boundary) in the same
 *     window — important for English/translated text. The whitespace
 *     grapheme itself is dropped so it doesn't appear as trailing space
 *     inside the chunk or leading space in the next.
 *  5. If still none, hard-cut at maxLen.
 *
 * Tail rebalance: if the final chunk would be smaller than `minTail`
 * graphemes, transfer just enough graphemes from the end of the previous
 * chunk so the tail reaches `minTail`. This avoids ugly orphan tails (e.g.
 * a single character on its own line) while preserving the `maxLen`
 * contract — no chunk grows beyond maxLen.
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
  // Cap minTail at maxLen so the rebalance below can never grow a chunk past
  // maxLen — the maxLen contract takes precedence over the no-orphan goal.
  const minTail = Math.min(maxLen, opts.minTail ?? Math.max(3, Math.floor(maxLen / 8)))

  const isWs = (g: string): boolean => g.length === 1 && /\s/.test(g)

  const parts: string[] = []
  let i = 0
  while (i < graphemes.length) {
    // Skip leading whitespace from the start of each chunk so a cut after a
    // punct that's followed by a space (e.g. "Hello, world") doesn't leave a
    // stray leading space in the next chunk.
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
          // Cut at the space and consume it so neither chunk includes it.
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
 * Inserts a random soft hyphen (U+00AD) in the text for dedup-bypass /
 * evasion. Insertion is grapheme-safe (no splitting inside a combining
 * sequence or emoji ZWJ cluster) and bmote-safe: positions strictly
 * inside a B站 standard emote bracket — `[doge]`, `[花]`, `[OK]`,
 * `[捂脸2]`, etc. — are excluded so the soft hyphen can never land
 * between `[` and its matching `]` and break the emote rendering.
 *
 * Unbalanced single brackets (e.g. literal `[第3章` with no close) form
 * no emote and so don't restrict insertion. The outer ends of each
 * matched `[...]` pair stay valid: positions immediately before `[` or
 * immediately after `]` are fine.
 *
 * When every position is forbidden (only possible if the entire string
 * is one balanced bracket pair AND we somehow blocked the head/tail —
 * shouldn't happen in practice), falls back to appending at the end.
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
 * Sample one value from a standard normal distribution (mean 0, variance 1)
 * via the Box-Muller transform. Only the cosine half is taken; the sine half
 * is discarded since we need a single sample per call. `u1 || 1e-9` guards
 * against the rare-but-possible `Math.random() === 0` (which would otherwise
 * produce `log(0) = -Infinity` and propagate NaN downstream).
 */
function sampleStandardNormal(): number {
  const u1 = Math.random() || 1e-9
  const u2 = Math.random()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/**
 * Resolves the actual sleep duration (ms) between auto-send iterations.
 *
 * Base delay is `intervalSeconds * 1000`. When `random` is true, a Gaussian
 * (bell-curve) jitter is added with σ = `SEND_JITTER_SIGMA * baseMs` — most
 * delays cluster tightly around `baseMs` with rare ±2σ outliers, matching
 * human cadence better than uniform jitter (uniform "randomness" is itself a
 * fingerprint over a tight window). The sample is clamped to ±2σ so a freak
 * Gaussian draw can't blow past the user's expected cadence. Result is also
 * clamped to ≥ 0 so a 0-second interval with jitter doesn't pass a negative
 * argument down to `setTimeout`.
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
 * Detect whether a CDN `host` value points at a raw IP address rather
 * than a hostname. Accepts the full `host` field as returned by the
 * bilibili app endpoint — which is `https://<host>` with no path —
 * and inspects the authority portion.
 *
 * Matches both IPv4 (`https://1.2.3.4`, `https://1.2.3.4:8080`) and
 * bracketed IPv6 (`https://[2001:db8::1]`). Hostnames containing dots
 * but at least one non-numeric label (the normal CDN case like
 * `cn-jsnt-fx-01-12.bilivideo.com`) return false.
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
