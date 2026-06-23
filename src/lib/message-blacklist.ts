/**
 * Pure parsing / validation / matching for the 自动融入 message blacklist.
 *
 * Entries are stored as the keys of `autoBlendMessageBlacklist` (a
 * `Record<string, 1>`). A key carries its own kind:
 *
 *   - `口交`        → literal: matches a danmaku ONLY when the whole trimmed
 *                     text equals it (the historical, backward-compatible
 *                     behaviour; also what right-click adds capture).
 *   - `/口.*交/i`   → regex: `/pattern/flags`, matched as a SUBSTRING
 *                     (`.test`) so one pattern catches evasion variants like
 *                     `口交`, `口***交`, `口 活 交`, …
 *
 * This module is deliberately free of any signal / GM-storage / DOM imports
 * so the rules stay unit-testable in `bun test`. The reactive glue (a
 * `computed` over the store signal) lives at the single match site in
 * `auto-blend.ts`; the Settings UI imports the validation + `isRegexEntry`
 * helpers directly.
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

// A key is a regex iff it's wrapped in slashes with a non-empty body and an
// optional run of trailing flag letters. `(.+)` is greedy, so a pattern that
// itself contains slashes (e.g. `/a\/b/`) keeps everything up to the LAST
// slash as its source — the JS regex-literal convention.
const REGEX_ENTRY_RE = /^\/(.+)\/([a-z]*)$/

/**
 * Parse a blacklist key into `{ source, flags }` when it's a `/.../` regex
 * entry, or `null` when it's a plain-text literal. Purely syntactic — flag
 * and pattern VALIDITY is the job of `validateRegexEntry` / compilation.
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

// `g` / `y` make `RegExp.test()` stateful (they advance `lastIndex` between
// calls, so a reused instance alternates hit/miss on the same input). They're
// meaningless for a boolean "does this match anywhere" check, so drop them
// before compiling — both at add-time validation and at match-time.
function sanitizeFlags(flags: string): string {
  return flags.replace(/[gy]/g, '')
}

/**
 * Validate user input destined for the blacklist. Literals are always valid
 * (empty-input is the caller's concern); regex entries must compile. Returns
 * the `RegExp` error message on failure so the caller can surface it.
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
 * Compile a set of blacklist keys into a fast matcher. Literal keys go into a
 * `Set` (O(1) exact lookup); regex keys are compiled once. An invalid regex
 * (e.g. imported from a malformed config) is SKIPPED, never thrown — the
 * danmaku hot path must not be able to crash on bad user data.
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
 * True when `text` (an already-trimmed danmaku) hits the blacklist: an exact
 * literal match, or a substring match against any regex entry.
 */
export function testMessageBlacklist(compiled: CompiledBlacklist, text: string): boolean {
  if (compiled.literals.has(text)) return true
  for (const re of compiled.regexes) {
    if (re.test(text)) return true
  }
  return false
}
