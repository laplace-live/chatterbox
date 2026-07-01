/**
 * Parsing / validation / matching for the 自动融入 message blacklist.
 * A key is either a plain-text literal (exact whole-message match) or a
 * `/pattern/flags` regex matched as a SUBSTRING. Deliberately import-free so
 * rules stay unit-testable.
 */

export interface RegexEntry {
  source: string
  flags: string
}

export type RegexValidation = { ok: true } | { ok: false; error: string }

export interface CompiledBlacklist {
  /** Literal entries — matched by exact whole-message equality. */
  literals: Set<string>
  /** Pre-compiled regex entries — matched as a substring via `.test`. */
  regexes: RegExp[]
}

// Greedy `(.+)` keeps everything up to the LAST slash as source, so `/a\/b/`
// parses per JS regex-literal convention.
const REGEX_ENTRY_RE = /^\/(.+)\/([a-z]*)$/

/**
 * Parse a `/.../` regex key into `{ source, flags }`, or `null` for a literal.
 * Purely syntactic — validity is checked at validation / compilation time.
 */
export function parseRegexEntry(key: string): RegexEntry | null {
  const m = REGEX_ENTRY_RE.exec(key)
  if (!m) return null
  return { source: m[1], flags: m[2] }
}

/** Whether a stored key is a regex entry (drives the UI "正则" badge). */
export function isRegexEntry(key: string): boolean {
  return REGEX_ENTRY_RE.test(key)
}

// Drop `g`/`y`: they make a reused `RegExp.test()` stateful (advancing
// `lastIndex`), alternating hit/miss — meaningless for a boolean match check.
function sanitizeFlags(flags: string): string {
  return flags.replace(/[gy]/g, '')
}

/**
 * Validate blacklist input: literals always pass, regex entries must compile.
 * @returns the `RegExp` error message on failure so the caller can surface it.
 */
export function validateRegexEntry(input: string): RegexValidation {
  const parsed = parseRegexEntry(input)
  if (!parsed) return { ok: true }
  try {
    new RegExp(parsed.source, sanitizeFlags(parsed.flags))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Compile blacklist keys into a matcher (literals in a `Set`, regexes compiled
 * once). An invalid regex is SKIPPED, never thrown, so the danmaku hot path
 * can't crash on bad user data.
 */
export function compileMessageBlacklist(keys: Iterable<string>): CompiledBlacklist {
  const literals = new Set<string>()
  const regexes: RegExp[] = []
  for (const key of keys) {
    const parsed = parseRegexEntry(key)
    if (!parsed) {
      literals.add(key)
      continue
    }
    try {
      regexes.push(new RegExp(parsed.source, sanitizeFlags(parsed.flags)))
    } catch {
      // Malformed pattern — drop it rather than poison the matcher.
    }
  }
  return { literals, regexes }
}

/**
 * True when `text` (an already-trimmed danmaku) hits the blacklist via exact
 * literal or regex substring match.
 */
export function testMessageBlacklist(compiled: CompiledBlacklist, text: string): boolean {
  if (compiled.literals.has(text)) return true
  for (const re of compiled.regexes) {
    if (re.test(text)) return true
  }
  return false
}
