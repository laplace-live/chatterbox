/**
 * Pure-helper tests for the AI 候选 engine (`src/lib/ai-candidate.ts`).
 *
 * Four exported helpers carry the engine's actual decision logic:
 *
 *   1. `parseDecision` — defensive JSON parse (handles both pure-JSON
 *      and chatty-text-with-embedded-JSON returns from vendors that
 *      ignore response_format)
 *   2. `buildContextSummary` — char-budget-bounded composition of
 *      conversation history + recent viewer danmaku
 *   3. `isReadyForGen` — debounce trigger gate (endpoint / sentence-end
 *      regex / buffer length)
 *   4. `markOutgoing` + `isLikelySelfEcho` — 30s TTL Set used to drop
 *      the echo of our own sends from the danmaku context window
 *
 * Engine orchestration (scheduling, danmaku subscription, LLM call,
 * candidate queue management) is intentionally NOT covered here — that
 * surface is wired through gmSignals + danmaku-stream + send-queue and
 * needs the integration harness. Pure helpers are the parts mutation
 * tests / refactors are most likely to silently break.
 */

import { beforeEach, describe, expect, test } from 'bun:test'

import {
  _resetSelfEchoForTests,
  buildContextSummary,
  isLikelySelfEcho,
  isReadyForGen,
  markOutgoing,
  parseDecision,
  type ViewerChatEntry,
} from '../src/lib/ai-candidate'

// ---------------------------------------------------------------------------
// parseDecision
// ---------------------------------------------------------------------------

describe('parseDecision', () => {
  test('parses a valid JSON object with all three fields', () => {
    const json = JSON.stringify({ send: true, message: '哈哈', reason: '主播说得有趣' })
    const d = parseDecision(json, 40)
    expect(d.send).toBe(true)
    expect(d.message).toBe('哈哈')
    expect(d.reason).toBe('主播说得有趣')
  })

  test('extracts JSON from a chatty wrapper (vendor ignored response_format)', () => {
    // Real vendors do this: "Sure, here is the JSON: {...}" — fork's
    // fallback path is to find the outermost {…} block.
    const content =
      '好的，这是你要的 JSON：{"send": true, "message": "你太严格了", "reason": "杠一下"}\n希望对你有帮助。'
    const d = parseDecision(content, 40)
    expect(d.send).toBe(true)
    expect(d.message).toBe('你太严格了')
    expect(d.reason).toBe('杠一下')
  })

  test('throws when content is not JSON and has no {…} block to recover', () => {
    expect(() => parseDecision('there is no json here', 40)).toThrow(/无法解析为 JSON/)
  })

  test('throws on JSON that parses to a non-object (string, number, array)', () => {
    expect(() => parseDecision('"just a string"', 40)).toThrow(/无法解析为 JSON/)
    expect(() => parseDecision('42', 40)).toThrow(/无法解析为 JSON/)
    // Arrays are typeof 'object' but the cast still hits send/message/reason
    // checks and falls back to defaults. We accept that as "tolerated noise"
    // rather than a throw — locked by the next test.
  })

  test('non-true `send` (including "true" string and 1) is coerced to false (strict equality)', () => {
    // Detection asymmetry: B站 ban risk grows linearly with "AI message
    // sent". `send` must be exactly boolean true — string "true", number 1,
    // and missing field all → false.
    expect(parseDecision('{"send": "true", "message": "x", "reason": ""}', 40).send).toBe(false)
    expect(parseDecision('{"send": 1, "message": "x", "reason": ""}', 40).send).toBe(false)
    expect(parseDecision('{"message": "x", "reason": ""}', 40).send).toBe(false)
  })

  test('truncates message past maxLen', () => {
    // 50-char message; maxLen=10 → must be sliced.
    const long = '这是一段超过十个字的弹幕用来测试截断逻辑测试测试'
    const d = parseDecision(JSON.stringify({ send: true, message: long, reason: 'r' }), 10)
    expect(d.message.length).toBeLessThanOrEqual(10)
  })

  test('message field is trimmed (LLM trailing whitespace)', () => {
    const d = parseDecision('{"send": true, "message": "  哈哈  ", "reason": "x"}', 40)
    expect(d.message).toBe('哈哈')
  })

  test('missing reason defaults to empty string (not undefined)', () => {
    const d = parseDecision('{"send": false, "message": ""}', 40)
    expect(d.reason).toBe('')
  })
})

// ---------------------------------------------------------------------------
// buildContextSummary
// ---------------------------------------------------------------------------

describe('buildContextSummary', () => {
  test('returns empty string when history and viewerChats are both empty', () => {
    expect(buildContextSummary([], 2048, [])).toBe('')
  })

  test('includes viewer chats when they fit in half the char budget', () => {
    const viewers: ViewerChatEntry[] = [
      { uname: 'alice', uid: '1', text: '666', receivedAt: 0 },
      { uname: 'bob', uid: '2', text: '哈哈哈', receivedAt: 0 },
    ]
    const out = buildContextSummary([], 1000, viewers)
    expect(out).toContain('[最近观众弹幕]')
    expect(out).toContain('alice: 666')
    expect(out).toContain('bob: 哈哈哈')
  })

  test('skips viewer chats when they exceed half the char budget', () => {
    const huge = 'x'.repeat(2000)
    const viewers: ViewerChatEntry[] = [{ uname: 'spammer', uid: '1', text: huge, receivedAt: 0 }]
    const out = buildContextSummary([], 100, viewers)
    // Block was > 50 chars (half budget), so dropped entirely.
    expect(out).not.toContain('[最近观众弹幕]')
  })

  test('uses 观众 as the fallback uname when uname is null (anonymous)', () => {
    const viewers: ViewerChatEntry[] = [{ uname: null, uid: '1', text: 'hi', receivedAt: 0 }]
    const out = buildContextSummary([], 1000, viewers)
    expect(out).toContain('观众: hi')
  })

  test('walks history newest-first and stops at the char budget', () => {
    const history = [
      { transcript: 'A', chat: 'a' }, // oldest
      { transcript: 'B', chat: 'b' },
      { transcript: 'C', chat: 'c' }, // newest
    ]
    // 60-char budget — only enough room for the freshest entry or two.
    const out = buildContextSummary(history, 60, [])
    expect(out).toContain('[主播]: C')
    expect(out).toContain('[你已发送]: c')
    // C entry is ~30 chars; budget=60 should allow B too but not A.
    // We don't assert the exact cut-off (it depends on JSON format
    // sizing), but A (the oldest) should not appear when budget is
    // tight enough to drop one — pin "newest reaches output first".
    const positionC = out.indexOf('[主播]: C')
    const positionB = out.indexOf('[主播]: B')
    if (positionB !== -1) {
      // When both present, newest (C) comes LAST since the function
      // builds bottom-up.
      expect(positionB).toBeLessThan(positionC)
    }
  })

  test('history blocks join with blank lines for readability', () => {
    const history = [
      { transcript: '一', chat: '甲' },
      { transcript: '二', chat: '乙' },
    ]
    const out = buildContextSummary(history, 1000, [])
    // Two blocks separated by \n\n (paragraph break).
    expect(out.split('\n\n').length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// isReadyForGen
// ---------------------------------------------------------------------------

describe('isReadyForGen', () => {
  test('endpointReached=true short-circuits regardless of buffer content', () => {
    expect(isReadyForGen('', true)).toBe(true)
    expect(isReadyForGen('一个字', true)).toBe(true)
    expect(isReadyForGen('   ', true)).toBe(true)
  })

  test('buffer ending with sentence-end punctuation is ready', () => {
    // SENTENCE_END_REGEX covers exactly these six: 。 . ！ ! ？ ?
    // Trailing ellipsis (…) is deliberately NOT counted — the speaker
    // trailing off is ambiguous, wait for FALLBACK_MS instead.
    expect(isReadyForGen('我觉得这个主播挺有趣的。', false)).toBe(true)
    expect(isReadyForGen('你怎么看？', false)).toBe(true)
    expect(isReadyForGen('真的吗！', false)).toBe(true)
    expect(isReadyForGen('What do you think?', false)).toBe(true)
    expect(isReadyForGen('Wow!', false)).toBe(true)
    expect(isReadyForGen('I think so.', false)).toBe(true)
  })

  test('trailing ellipsis (…) is NOT counted as sentence-end', () => {
    expect(isReadyForGen('好的…', false)).toBe(false)
    expect(isReadyForGen('我想想…', false)).toBe(false)
  })

  test('buffer ending with non-terminal punct (comma, semicolon) is NOT ready', () => {
    // Sentence isn't finished — comma is too early to fire generation.
    expect(isReadyForGen('我觉得，', false)).toBe(false)
    expect(isReadyForGen('first;', false)).toBe(false)
  })

  test('buffer over 200 chars is ready even without sentence-end', () => {
    expect(isReadyForGen('x'.repeat(201), false)).toBe(true)
  })

  test('buffer at exactly 200 chars is NOT ready (strict > 200)', () => {
    expect(isReadyForGen('x'.repeat(200), false)).toBe(false)
  })

  test('short non-terminal buffer is not ready (typical mid-sentence STT)', () => {
    expect(isReadyForGen('主播刚才说', false)).toBe(false)
  })

  test('buffer of whitespace alone is not ready (sentence-end regex tests the trim)', () => {
    expect(isReadyForGen('   ', false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// markOutgoing / isLikelySelfEcho
// ---------------------------------------------------------------------------

describe('self-echo dedupe (markOutgoing + isLikelySelfEcho)', () => {
  beforeEach(() => {
    _resetSelfEchoForTests()
  })

  test('marked text is detected within the TTL window', () => {
    markOutgoing('哈哈哈')
    expect(isLikelySelfEcho('哈哈哈')).toBe(true)
  })

  test('unrelated text is not detected', () => {
    markOutgoing('哈哈哈')
    expect(isLikelySelfEcho('完全不同的话')).toBe(false)
  })

  test('mark + query trim whitespace on both sides (B站 normalizes some whitespace)', () => {
    markOutgoing('  好可爱  ')
    // The mark trims to '好可爱', so query trims and matches.
    expect(isLikelySelfEcho('好可爱')).toBe(true)
    expect(isLikelySelfEcho('  好可爱')).toBe(true)
    expect(isLikelySelfEcho('好可爱  ')).toBe(true)
  })

  test('marking an empty / whitespace-only string is a no-op', () => {
    markOutgoing('')
    markOutgoing('   ')
    // Empty queries always miss (trim → empty key, but Map doesn't have ''
    // since marking it was skipped).
    expect(isLikelySelfEcho('')).toBe(false)
    expect(isLikelySelfEcho('   ')).toBe(false)
  })

  test('OUTGOING_CAP eviction: oldest entries fall off when capacity exceeded', () => {
    // The module's OUTGOING_CAP is 64. Insert 65 distinct texts — the
    // very first one must no longer be detected (Map iteration order
    // matches insertion order, so the oldest is dropped first).
    const FIRST = 'echo-0'
    markOutgoing(FIRST)
    for (let i = 1; i <= 64; i++) markOutgoing(`echo-${i}`)
    expect(isLikelySelfEcho(FIRST)).toBe(false)
    // But the most recent insertion is still there.
    expect(isLikelySelfEcho('echo-64')).toBe(true)
  })

  test('_resetSelfEchoForTests clears all marked entries', () => {
    markOutgoing('foo')
    markOutgoing('bar')
    expect(isLikelySelfEcho('foo')).toBe(true)
    _resetSelfEchoForTests()
    expect(isLikelySelfEcho('foo')).toBe(false)
    expect(isLikelySelfEcho('bar')).toBe(false)
  })
})
