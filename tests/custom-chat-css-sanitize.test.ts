/**
 * Defends `sanitizeCustomChatCss` against the four attack/footgun vectors the
 * QA audit (A4) called out:
 *   1. `@import url('https://evil')` — bypasses the script's @connect
 *      allowlist and exfiltrates IP/UA to a third party.
 *   2. `url(javascript:alert(1))` and similar hostile URL schemes — older
 *      engines have executed these; defense in depth is cheap.
 *   3. Legacy `expression(...)` and `behavior:` IE attack surface — kept
 *      because old userscript managers sometimes embed legacy WebView shims.
 *   4. Megabyte-scale paste from a corrupted backup — would otherwise sit in
 *      GM storage and force a full stylesheet recompute on every signal tick.
 *
 * Pure function, no DOM needed.
 */

import { describe, expect, test } from 'bun:test'

import { CUSTOM_CHAT_CSS_MAX_LENGTH, sanitizeCustomChatCss } from '../src/lib/custom-chat-css-sanitize'

describe('sanitizeCustomChatCss', () => {
  test('returns the input untouched when it has no hostile content', () => {
    const input = '.lc-chat-message { color: red; background: rgba(0,0,0,.5); }'
    const r = sanitizeCustomChatCss(input)
    expect(r.css).toBe(input)
    expect(r.truncated).toBe(false)
    expect(r.removedImports).toBe(0)
    expect(r.removedUrlSchemes).toBe(0)
    expect(r.removedLegacyHooks).toBe(0)
  })

  test('strips @import directives and reports the count', () => {
    const input = `@import url('https://evil.example/leak.css');\nbody { color: red; }\n@import "https://example.com";`
    const r = sanitizeCustomChatCss(input)
    expect(r.removedImports).toBe(2)
    expect(r.css).not.toContain('@import')
    expect(r.css).toContain('color: red')
  })

  test('neutralizes url(javascript:...) but keeps the rest of the rule intact', () => {
    const input = `.x { background: url("javascript:alert(1)"); color: red; }`
    const r = sanitizeCustomChatCss(input)
    expect(r.removedUrlSchemes).toBe(1)
    expect(r.css).not.toContain('javascript:')
    expect(r.css).toContain('about:blank')
    expect(r.css).toContain('color: red')
  })

  test('neutralizes vbscript: and data:text/html schemes inside url()', () => {
    const input = [
      `.a { background: url(vbscript:msgbox); }`,
      `.b { background: url("data:text/html,<script>alert(1)</script>"); }`,
    ].join('\n')
    const r = sanitizeCustomChatCss(input)
    expect(r.removedUrlSchemes).toBe(2)
    expect(r.css).not.toContain('vbscript:')
    expect(r.css).not.toContain('data:text/html')
  })

  test('keeps benign url() like images and fonts intact', () => {
    const input = `.x { background: url('https://i0.hdslb.com/foo.png'); }`
    const r = sanitizeCustomChatCss(input)
    expect(r.removedUrlSchemes).toBe(0)
    expect(r.css).toBe(input)
  })

  test('strips expression(...) and behavior: legacy IE hooks', () => {
    const input = `.x { width: expression(alert(1)); behavior: url(htc.htc); }`
    const r = sanitizeCustomChatCss(input)
    expect(r.removedLegacyHooks).toBe(2)
    expect(r.css).not.toContain('expression(')
    expect(r.css).not.toContain('behavior:')
  })

  test('truncates input over CUSTOM_CHAT_CSS_MAX_LENGTH and reports it', () => {
    const huge = 'a'.repeat(CUSTOM_CHAT_CSS_MAX_LENGTH + 1000)
    const r = sanitizeCustomChatCss(huge)
    expect(r.truncated).toBe(true)
    expect(r.css.length).toBeLessThanOrEqual(CUSTOM_CHAT_CSS_MAX_LENGTH)
  })

  test('handles empty / non-string inputs without throwing', () => {
    expect(sanitizeCustomChatCss('').css).toBe('')
    // Cast to bypass the type signature — we want to confirm runtime safety
    // because the CSS string can come from a corrupted GM storage value.
    expect(sanitizeCustomChatCss(undefined as unknown as string).css).toBe('')
    expect(sanitizeCustomChatCss(null as unknown as string).css).toBe('')
  })

  test('chained attack: @import + javascript: url + huge — all guards fire together', () => {
    const css = [
      `@import url('https://evil');`,
      `.x { background: url("javascript:alert(1)"); }`,
      'a'.repeat(CUSTOM_CHAT_CSS_MAX_LENGTH),
    ].join('\n')
    const r = sanitizeCustomChatCss(css)
    expect(r.truncated).toBe(true)
    // After truncation, the @import and javascript: should both be gone if
    // they fell within the truncated window. They're at the very start, so
    // they survive truncation — and the strip rules then fire on them.
    expect(r.removedImports).toBeGreaterThanOrEqual(1)
    expect(r.css).not.toContain('@import')
    expect(r.css).not.toContain('javascript:')
  })

  // ---------------------------------------------------------------------------
  // Mutation-test targeted: pin the exact removed-substring contents so a
  // mutant that lets the replacer return "Stryker was here!" or skips the
  // regex with a flipped guard gets caught.
  // ---------------------------------------------------------------------------

  test('replacer returns EMPTY string, not a sentinel (@import)', () => {
    // Mutant: the `return ''` in the @import replacer changes to a non-empty
    // sentinel. The input rule is `@import 'x';` (10 chars). Sanitized
    // length must drop by at least that count.
    const before = `@import 'x';`
    const r = sanitizeCustomChatCss(before)
    expect(r.css).toBe('') // entire input was an @import; nothing remains
    expect(r.css.length).toBe(0)
  })

  test('replacer returns EMPTY string, not a sentinel (expression)', () => {
    // No nested parens — the [^)]* class stops at the first `)`, so
    // `expression(alert(1))` would leave a stray `)` behind. With a flat
    // expression we can pin the exact post-replace string.
    const before = `.x { width: expression(noNesting); color: red; }`
    const r = sanitizeCustomChatCss(before)
    expect(r.css).toBe('.x { width: ; color: red; }')
  })

  test('replacer returns EMPTY string, not a sentinel (behavior)', () => {
    const before = `.x { behavior: url(htc.htc); }`
    const r = sanitizeCustomChatCss(before)
    expect(r.css).toBe('.x {  }')
  })

  test('truncated boundary: input at exactly MAX_LENGTH is NOT truncated (kills `>` → `>=`)', () => {
    const exact = 'a'.repeat(CUSTOM_CHAT_CSS_MAX_LENGTH)
    const r = sanitizeCustomChatCss(exact)
    expect(r.truncated).toBe(false)
    expect(r.css.length).toBe(CUSTOM_CHAT_CSS_MAX_LENGTH)
  })

  test('truncated boundary: input at MAX_LENGTH+1 IS truncated', () => {
    const over = 'a'.repeat(CUSTOM_CHAT_CSS_MAX_LENGTH + 1)
    const r = sanitizeCustomChatCss(over)
    expect(r.truncated).toBe(true)
    expect(r.css.length).toBe(CUSTOM_CHAT_CSS_MAX_LENGTH)
  })

  test('initial-empty result has truncated=FALSE (kills BooleanLiteral mutant on the early-return)', () => {
    // The early-return shape is { css: '', truncated: false, ... }. If
    // `truncated` were mutated to `true`, callers might surface a misleading
    // "truncated content" warning even for an intentionally-empty input.
    expect(sanitizeCustomChatCss('').truncated).toBe(false)
    expect(sanitizeCustomChatCss(undefined as unknown as string).truncated).toBe(false)
    expect(sanitizeCustomChatCss(null as unknown as string).truncated).toBe(false)
  })

  test('@import regex matches BOTH with-semicolon and without-semicolon endings', () => {
    // Two @import rules: one terminated, one ending at EOF without ';'.
    // Mutant variants that drop the `;?` would only strip ONE; assertion
    // forces both to be removed.
    const css = `@import 'a.css';\n@import 'b.css'`
    const r = sanitizeCustomChatCss(css)
    expect(r.removedImports).toBe(2)
    expect(r.css).not.toContain('@import')
  })

  test('@import [^;]* class matches arbitrary content including quotes/parens (kills `[^;]` → `[;]`)', () => {
    // Mutant that flips `[^;]*` → `[;]*` would only strip @import that
    // contains semicolons as content (impossible). Assert that an @import
    // with diverse content (single quotes, parens, spaces) is fully removed.
    const css = `@import url('https://evil.example/a.css?x=1');\nbody{}`
    const r = sanitizeCustomChatCss(css)
    expect(r.removedImports).toBe(1)
    expect(r.css).toContain('body{}')
  })

  test('expression regex needs \\s* (whitespace ok), not \\S* (any non-ws)', () => {
    // Mutant `expression\s*\(...\)` → `expression\S*\(...\)` would only
    // match if there were a non-ws between `expression` and `(`. The real
    // CSS often has `expression(`. Assert the no-whitespace form is
    // stripped (and the WITH-whitespace form too).
    expect(sanitizeCustomChatCss('.x { x: expression(alert(1)); }').removedLegacyHooks).toBe(1)
    expect(sanitizeCustomChatCss('.x { x: expression (alert(1)); }').removedLegacyHooks).toBe(1)
  })

  test('behavior regex needs \\s* before `:` (kills `\\s` → `\\S`)', () => {
    // Mutant `behavior\s*:` → `behavior\S*:` would only match if a
    // non-whitespace lived between `behavior` and `:`. Real CSS may have
    // 0 or 1 whitespace.
    expect(sanitizeCustomChatCss('.x { behavior:url(a); }').removedLegacyHooks).toBe(1)
    expect(sanitizeCustomChatCss('.x { behavior :url(a); }').removedLegacyHooks).toBe(1)
  })

  test('behavior regex [^;]* allows everything-but-semicolon as value', () => {
    // Mutant `[^;]` → `[;]` would fail to strip non-semicolon content.
    // Real values like `url(file.htc)` have neither semicolons internally.
    expect(sanitizeCustomChatCss('.x { behavior: url(file.htc); }').removedLegacyHooks).toBe(1)
    expect(sanitizeCustomChatCss('.x { behavior: foo bar baz; }').removedLegacyHooks).toBe(1)
  })

  test('url() scheme regex must require WHITESPACE inside `url(` argument area, then NON-ws scheme', () => {
    // Mutant `url\(\s*` → `url\(\S*` would change "url(" with optional
    // whitespace-then-quote to "url(" with non-ws-then-quote. Match for
    // benign `url( "javascript:..." )` (with leading whitespace) should
    // still neutralize.
    expect(sanitizeCustomChatCss('.x { background: url( "javascript:alert(1)" ); }').removedUrlSchemes).toBe(1)
    expect(sanitizeCustomChatCss('.x { background: url("javascript:alert(1)"); }').removedUrlSchemes).toBe(1)
  })

  test('input type guard: non-string returns empty result (kills `||` → `&&`-ish flip)', () => {
    // `typeof input !== 'string' || input.length === 0` → false mutant
    // would let non-string input slip through and crash on `.length` or
    // `.replace`. Confirms safety.
    expect(() => sanitizeCustomChatCss(undefined as unknown as string)).not.toThrow()
    expect(() => sanitizeCustomChatCss(null as unknown as string)).not.toThrow()
    expect(() => sanitizeCustomChatCss(42 as unknown as string)).not.toThrow()
    expect(() => sanitizeCustomChatCss({} as unknown as string)).not.toThrow()
    expect(sanitizeCustomChatCss(42 as unknown as string).css).toBe('')
  })

  // ---------------------------------------------------------------------------
  // normalizeEscapes — CSS hex / single-char escape resolver
  //
  // The function is responsible for resolving `\41 ` → `A`, `\\` → `\`, etc.
  // Without this, payloads like `@\69 mport url(evil)` and `expressi\6Fn(...)`
  // would slip past the literal-character regexes. Mutation testing surfaced
  // ~30 survivors here — every regex flag, every range guard, every fallback
  // path was untested by the existing test set.
  // ---------------------------------------------------------------------------

  test('normalizeEscapes: 2-digit hex `\\41 ` decodes to `A` (locks decoder enabled at all)', () => {
    // Mutant: BlockStatement {} on the replace callback → callback returns
    // undefined → match replaced with literal "undefined". This test fails
    // if the escape isn't decoded to A.
    const r = sanitizeCustomChatCss('.\\41 { color: red; }')
    // After escape resolution the selector becomes `.A`.
    expect(r.css).toContain('.A')
    expect(r.css).toContain('color: red')
    // And no literal escape sequence survives.
    expect(r.css).not.toContain('\\41')
  })

  test('normalizeEscapes: 6-digit hex `\\000041 ` still decodes to `A` (locks `{1,6}` upper bound)', () => {
    // Mutant `{1,6}` → `{1,5}` would fail to match the 6-digit form.
    const r = sanitizeCustomChatCss('.\\000041 { color: red; }')
    expect(r.css).toContain('.A')
    expect(r.css).not.toContain('\\000041')
  })

  test('normalizeEscapes: hex WITHOUT trailing whitespace also decodes (locks `\\s?` as optional)', () => {
    // Mutant `\s?` → `\s` would require trailing whitespace; `\41xyz` would
    // fail to match. Real CSS often has `\41` directly followed by a char.
    const r = sanitizeCustomChatCss('.\\41xyz')
    expect(r.css).toContain('.Axyz')
  })

  test('normalizeEscapes: hex with trailing space consumes the space (no leftover whitespace)', () => {
    // Mutant `\s?` → `\S?` would consume non-ws (0 chars in practice) and
    // leave the space behind → output `.A xyz` instead of `.Axyz`.
    const r = sanitizeCustomChatCss('.\\41 xyz')
    expect(r.css).toContain('.Axyz')
    expect(r.css).not.toContain('.A xyz')
  })

  test('normalizeEscapes: non-hex single-char escape `\\g` decodes to `g` (kills `[^\\n]` → `[\\n]`)', () => {
    // `g` is not in [0-9a-fA-F] so the hex branch fails; the char branch
    // fires and returns `g`. Mutated regex (`[\n]` instead of `[^\n]`)
    // requires the matched char to be a newline — `\g` no longer matches,
    // so the backslash and `g` both survive in output.
    //
    // Pin the EXACT post-resolution form (not just removedImports) so
    // downstream IMPORT_RE behavior doesn't mask the difference.
    const r = sanitizeCustomChatCss('.a { color: \\g; }')
    expect(r.css).toBe('.a { color: g; }')
  })

  test('normalizeEscapes: bypass attack `@\\69 mport url(evil)` is caught by IMPORT_RE post-resolution', () => {
    // \69 → 'i'. So `@\69 mport ...` → `@import ...`. The sanitizer must
    // strip the resolved form. This test exercises the *purpose* of
    // normalizeEscapes: making escape-obfuscated payloads visible.
    const r = sanitizeCustomChatCss(`@\\69 mport url('https://evil');\nbody{}`)
    expect(r.removedImports).toBe(1)
    expect(r.css).not.toContain('import')
    expect(r.css).toContain('body{}')
  })

  test('normalizeEscapes: bypass attack `expressi\\6Fn(...)` is caught by EXPRESSION_RE post-resolution', () => {
    // \6F → 'o'. So `expressi\6Fn(...)` → `expression(...)`.
    const r = sanitizeCustomChatCss('.x { width: expressi\\6Fn(alert(1)); color: red; }')
    expect(r.removedLegacyHooks).toBe(1)
    expect(r.css).not.toContain('expression')
    expect(r.css).toContain('color: red')
  })

  test('normalizeEscapes: invalid codepoint `\\0` (null) yields U+FFFD (NOT empty string)', () => {
    // Mutants on L69: StringLiteral '"" or "Stryker was here!"' would change
    // the replacement char. Also kills EqualityOperator `code !== 0`.
    //
    // Note: we need a non-hex char (and non-whitespace) immediately after `\0`
    // so the greedy `[0-9a-fA-F]{1,6}` regex stops at "0" and doesn't extend
    // to e.g. `0b` (which would decode to U+000B vertical tab, not invalid).
    const r = sanitizeCustomChatCss('a\\0xyz')
    expect(r.css).toContain('�')
    expect(r.css).toContain('a')
    expect(r.css).toContain('xyz')
    // And specifically NOT empty between `a` and `xyz`.
    expect(r.css).not.toBe('axyz')
  })

  test('normalizeEscapes: surrogate-range lower boundary `\\d800` yields U+FFFD (kills `>= 0xd800` → `> 0xd800`)', () => {
    // Mutant: `code >= 0xd800` → `code > 0xd800`. With input `\d800`, code is
    // exactly 0xd800 which is no longer in the surrogate range → falls through
    // to String.fromCodePoint(0xd800) = lone high surrogate U+D800 (NOT U+FFFD).
    // Use charCodeAt for an unambiguous assertion that bypasses any surrogate
    // normalization the test runner might perform.
    const r = sanitizeCustomChatCss('a\\d800 b')
    expect(r.css.charCodeAt(0)).toBe(0x61) // 'a'
    expect(r.css.charCodeAt(1)).toBe(0xfffd) // replacement, NOT 0xd800
    expect(r.css.charCodeAt(2)).toBe(0x62) // 'b'
    expect(r.css.length).toBe(3)
  })

  test('normalizeEscapes: surrogate-range upper boundary `\\dfff` yields U+FFFD (kills `<= 0xdfff` → `< 0xdfff`)', () => {
    // Mutant: `code <= 0xdfff` → `code < 0xdfff`. With input `\dfff`, code is
    // exactly 0xdfff which falls out of the (mutated) surrogate range and
    // gets decoded as a lone low surrogate U+DFFF. Charcode assertion makes
    // the diff between U+FFFD and U+DFFF unambiguous.
    const r = sanitizeCustomChatCss('a\\dfff b')
    expect(r.css.charCodeAt(0)).toBe(0x61) // 'a'
    expect(r.css.charCodeAt(1)).toBe(0xfffd) // replacement, NOT 0xdfff
    expect(r.css.charCodeAt(2)).toBe(0x62) // 'b'
    expect(r.css.length).toBe(3)
  })

  test('normalizeEscapes: out-of-range codepoint `\\110000` yields U+FFFD (kills `> 0x10ffff` boundary)', () => {
    // Locks `code > 0x10ffff`. 0x110000 is the first out-of-range codepoint
    // (one past Unicode max). Mutant `>= 0x10ffff` would mark 0x10ffff itself
    // invalid — the next test pins the just-valid side.
    const r = sanitizeCustomChatCss('a\\110000 b')
    expect(r.css).toContain('�')
  })

  test('normalizeEscapes: max-valid codepoint `\\10ffff` decodes to the actual character (kills `>= 0x10ffff`)', () => {
    // Pins the valid side of the upper boundary. 0x10ffff is the Unicode max.
    // Mutant `>= 0x10ffff` would reject this valid codepoint as U+FFFD.
    const r = sanitizeCustomChatCss('a\\10ffff b')
    const expected = String.fromCodePoint(0x10ffff)
    expect(r.css).toContain(expected)
    expect(r.css).not.toContain('�')
  })

  test('normalizeEscapes: just-before-surrogate `\\d7ff` decodes to a valid char (kills `> 0xd800`)', () => {
    // Pins the valid side BELOW the surrogate range. Mutant `code > 0xd800`
    // would reject 0xd7ff as invalid.
    const r = sanitizeCustomChatCss('a\\d7ff b')
    const expected = String.fromCodePoint(0xd7ff)
    expect(r.css).toContain(expected)
    expect(r.css).not.toContain('�')
  })

  test('normalizeEscapes: just-after-surrogate `\\e000` decodes to a valid char (kills `< 0xdfff`)', () => {
    // Pins the valid side ABOVE the surrogate range. Mutant `code < 0xdfff`
    // would reject 0xe000 (Private Use Area start) as invalid.
    const r = sanitizeCustomChatCss('a\\e000 b')
    const expected = String.fromCodePoint(0xe000)
    expect(r.css).toContain(expected)
    expect(r.css).not.toContain('�')
  })

  test('normalizeEscapes: BMP codepoint `\\4e2d` decodes to `中` (locks `String.fromCodePoint` enabled)', () => {
    // A normal CJK codepoint, well inside the valid range. Establishes that
    // the decoder produces the *actual* character and not a replacement or
    // empty string for legitimate input.
    const r = sanitizeCustomChatCss('.\\4e2d  font')
    expect(r.css).toContain('.中')
  })

  test('normalizeEscapes: SMP codepoint `\\1f600` decodes to the 😀 emoji (locks 6-digit handling)', () => {
    // Beyond BMP — exercises String.fromCodePoint's surrogate-pair output.
    const r = sanitizeCustomChatCss('a\\1f600 b')
    expect(r.css).toContain('\u{1f600}')
  })

  // ---------------------------------------------------------------------------
  // COMMENT_RE — `/\/\*[\s\S]*?\*\//g`
  //
  // Four regex mutants on this single line. The existing tests never assert
  // that two SEPARATE comments are stripped individually (non-greedy), nor
  // that a comment containing newlines is stripped, nor that a comment with
  // non-whitespace content is stripped.
  // ---------------------------------------------------------------------------

  test('COMMENT_RE: two separate comments are stripped INDIVIDUALLY (kills `*?` → `*` greedy)', () => {
    // With original lazy `*?`: input `/*a*/keep/*b*/` → output `keep`.
    // With greedy `*` mutant:  input matches everything from first `/*` to
    //                          last `*/` → output is empty.
    // Note: comments fire BEFORE the @import/expression strippers, so this
    // assertion is on the final css output.
    const r = sanitizeCustomChatCss('/*a*/keep/*b*/')
    expect(r.css).toBe('keep')
  })

  test('COMMENT_RE: comment with newlines inside is stripped (kills `[\\s\\S]` → `[\\S\\S]`)', () => {
    // `[\S\S]` is just `\S` — wouldn't match the newline inside the comment.
    const css = '/* line1\nline2 */body { color: red; }'
    const r = sanitizeCustomChatCss(css)
    expect(r.css).not.toContain('line1')
    expect(r.css).not.toContain('line2')
    expect(r.css).toContain('body { color: red; }')
  })

  test('COMMENT_RE: comment with non-whitespace content is stripped (kills `[\\s\\S]` → `[\\s\\s]`)', () => {
    // `[\s\s]` is just `\s` — would only match whitespace. A comment whose
    // body has letters/digits would be left intact.
    const r = sanitizeCustomChatCss('/*hostile-content*/body{}')
    expect(r.css).not.toContain('hostile-content')
    expect(r.css).toContain('body{}')
  })

  test('COMMENT_RE: a comment is stripped at all (kills `[\\s\\S]*?` → `[^\\s\\S]*?` empty-class)', () => {
    // `[^\s\S]` is the empty class — matches nothing. So the regex degrades
    // to literal `/\/\*\*\//` (just `/**/`). A comment with any body would
    // not be touched. Original strips any comment.
    const r = sanitizeCustomChatCss('body { /* note */ color: red; }')
    expect(r.css).not.toContain('note')
    expect(r.css).toContain('body')
    expect(r.css).toContain('color: red')
  })

  // ---------------------------------------------------------------------------
  // Truncation slice — locks the `css.slice(0, MAX_LENGTH)` step.
  // ---------------------------------------------------------------------------

  test('over-length input is sliced to exactly MAX_LENGTH (kills MethodExpression `css.slice → css`)', () => {
    // Mutant MethodExpression: `css.slice(0, MAX)` → `css` keeps full input,
    // truncated=true is set but css.length stays > MAX. The "<=" boundary
    // assertion already catches that, but pin equality so a mutation that
    // returns the wrong slice (e.g., a different argument) also dies.
    const over = 'b'.repeat(CUSTOM_CHAT_CSS_MAX_LENGTH + 100)
    const r = sanitizeCustomChatCss(over)
    expect(r.css.length).toBe(CUSTOM_CHAT_CSS_MAX_LENGTH)
    expect(r.truncated).toBe(true)
  })

  test('post-strip second-pass truncation sets truncated=true (kills BooleanLiteral on L139)', () => {
    // We need a case where the FIRST length check (L99) does NOT fire but
    // the SECOND one (L137) does. That happens when the strip operations
    // can grow the css (URL_SCHEME_RE replaces with `url("about:blank")`).
    // For most inputs this rarely overruns the cap; we construct one here
    // by feeding right at the cap with many neutralizable url() schemes.
    //
    // Each `url(javascript:a)` is 18 chars; `url("about:blank")` is 18 chars.
    // Same length — won't grow. Use a shorter source to force expansion:
    // `url(vbscript:)` is 14 chars → expands to 18 → grows by 4 per match.
    const padFiller = ' '.repeat(CUSTOM_CHAT_CSS_MAX_LENGTH - 14 * 30)
    const attacks = 'url(vbscript:)'.repeat(30)
    const input = padFiller + attacks
    expect(input.length).toBe(CUSTOM_CHAT_CSS_MAX_LENGTH)
    const r = sanitizeCustomChatCss(input)
    // First-pass: length == MAX → no truncation.
    // Strip: 30 url() expansions each grow by 4 → length is now MAX+120.
    // Second-pass: length > MAX → truncate, set truncated=true.
    expect(r.css.length).toBe(CUSTOM_CHAT_CSS_MAX_LENGTH)
    expect(r.truncated).toBe(true)
  })

  test('@import strip replaces match with `""` (kills StringLiteral mutant on `css.replace(COMMENT_RE, "")`)', () => {
    // The comment-strip replacement string is `''`. Mutated to
    // `"Stryker was here!"` would leak that sentinel into the output.
    // Pin the exact post-strip form so the leak is caught.
    const r = sanitizeCustomChatCss('a /* note */ b')
    expect(r.css).toBe('a  b') // two spaces because the comment between them collapses
    expect(r.css).not.toContain('Stryker')
  })

  test('url() regex needs `\\s*` (whitespace allowed) BETWEEN the optional quote and the scheme', () => {
    // The URL_SCHEME_RE has TWO `\s*` clusters:
    //   url\(\s*    (["']?)   \s*    (javascript:|...)
    //         ^ first         ^ second
    // The first one is already pinned by an earlier test. This pins the
    // SECOND `\s*` — input has whitespace between the quote and the
    // scheme keyword, which is unusual but legal CSS.
    const r = sanitizeCustomChatCss(`.x { background: url(" javascript:alert(1) "); }`)
    expect(r.removedUrlSchemes).toBe(1)
    expect(r.css).not.toContain('javascript:')
  })

  test('behavior regex matches WITHOUT trailing semicolon (kills `;?` → `;` mandatory)', () => {
    // Mutated BEHAVIOR_RE = /behavior\s*:[^;]*;/gi (no `?`). Real CSS may
    // end a rule with `behavior: url(a)` followed by `}` and no semicolon.
    // Mutant fails to match; original strips it.
    const r = sanitizeCustomChatCss('.x { color: red; behavior: url(a)}')
    expect(r.removedLegacyHooks).toBe(1)
    expect(r.css).not.toContain('behavior')
    expect(r.css).toContain('color: red')
  })
})
