/**
 * Lock-in tests for visual fixes shipped in the Chatterbox chat panel:
 *
 *   1. Emojis (inline + big stickers) were oversized — assert they shrunk.
 *   2. The list mask used to fade BOTH the top and bottom 18px to transparent,
 *      which made the newest message look like it was vanishing under the
 *      composer. Assert the bottom edge is now fully opaque.
 *   3. A floating "jump to bottom / new messages" pill is rendered above the
 *      composer; assert the rule exists and is absolutely positioned so it
 *      can't push the composer's grid layout around.
 */
import { describe, expect, test } from 'bun:test'

import { CUSTOM_CHAT_STYLE } from '../src/lib/custom-chat-style'

function ruleBlock(css: string, selectorSuffix: string): string {
  // Pull out the body of `<anything> ${selectorSuffix} { ... }`. The style
  // sheet uses backticked template literals with the panel id interpolated,
  // so we match by the unique trailing class name.
  const pattern = new RegExp(`${selectorSuffix.replace(/[-\\^$*+?.()|[\\]{}]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm')
  const match = css.match(pattern)
  if (!match) throw new Error(`No CSS rule found for selector ending in "${selectorSuffix}"`)
  return match[1]
}

describe('chat emoji sizing', () => {
  test('inline emote shrunk from 1.7em to 1.35em', () => {
    const body = ruleBlock(CUSTOM_CHAT_STYLE, '.lc-chat-emote')
    expect(body).toContain('width: 1.35em')
    expect(body).toContain('height: 1.35em')
    expect(body).not.toContain('1.7em')
  })

  test('big sticker capped at 96px instead of 160px', () => {
    const body = ruleBlock(CUSTOM_CHAT_STYLE, '.lc-chat-emote-big')
    expect(body).toContain('max-width: 96px')
    expect(body).toContain('max-height: 96px')
    expect(body).not.toContain('160px')
  })
})

describe('chat list mask', () => {
  test('mask no longer fades the bottom edge to transparent', () => {
    const body = ruleBlock(CUSTOM_CHAT_STYLE, '.lc-chat-list')
    // Before: linear-gradient(to bottom, transparent, #000 18px, #000 calc(100% - 18px), transparent)
    // After:  linear-gradient(to bottom, transparent, #000 18px, #000 100%)
    // Either form keeps the top fade, but only the new form ends at #000 100%.
    expect(body).toContain('#000 100%)')
    expect(body).not.toContain('calc(100% - 18px)')
  })
})

describe('floating jump-to-bottom pill', () => {
  test('rule is defined and absolutely positioned above the composer', () => {
    const body = ruleBlock(CUSTOM_CHAT_STYLE, '.lc-chat-jump-bottom')
    expect(body).toContain('position: absolute')
    // Anchored relative to the composer's top edge so it floats above it
    // regardless of composer height (varies with the textarea).
    expect(body).toContain('bottom: calc(100% + 6px)')
    // Centered horizontally.
    expect(body).toContain('left: 50%')
    expect(body).toContain('translateX(-50%)')
  })

  test('unread variant uses the accent color so it reads as new-message bait', () => {
    // The data-unread="true" branch swaps to the panel accent — that's what
    // turns the pill blue when there's a count to show.
    expect(CUSTOM_CHAT_STYLE).toContain('.lc-chat-jump-bottom[data-unread="true"]')
  })
})

describe('Jobs-style baseline polish (2026-05-18 visual QA)', () => {
  // These lock in the round of changes that landed after the Claude Preview
  // audit showed the baseline themes were violating their own design-direction
  // doc (docs/chatterbox-chat-design-direction.md): bubble font-weight 400
  // unreadable on dark BG, no inset highlight, SC indistinguishable from
  // other cards, off-grid padding 13/9/11/14.

  test('normal bubble font-weight is 500 — no more featherweight 400 in dark themes', () => {
    // Anchor to the main bubble rule: starts with `#${ROOT_ID} .lc-chat-bubble {`
    // and stops before the next `}`. Greedy `[^}]*` is safe here because the
    // bubble rule has no nested braces.
    const m = CUSTOM_CHAT_STYLE.match(/#laplace-custom-chat \.lc-chat-bubble \{([^}]*)\}/)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('font-weight: 500')
    // The 400 ban is global: NO rule in the stylesheet should set 400.
    // (Cards explicitly set 800, lite sets 500, bubble sets 500.)
    expect(CUSTOM_CHAT_STYLE).not.toMatch(/font-weight:\s*400\b/)
  })

  test('normal bubble padding + radius snap to 4px grid (no more 13/9/7)', () => {
    const m = CUSTOM_CHAT_STYLE.match(/#laplace-custom-chat \.lc-chat-bubble \{([^}]*)\}/)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('padding: 8px 12px')
    expect(m![1]).toContain('border-bottom-left-radius: 8px')
    expect(m![1]).not.toContain('padding: 8px 13px 9px')
    expect(m![1]).not.toContain('border-bottom-left-radius: 7px')
  })

  test('bubble shadow includes an inset top-edge highlight (iOS 18 raised-card trick)', () => {
    // Both light + dark variants set --lc-chat-bubble-shadow with `inset`.
    // The inset is what makes bubbles read as raised cards instead of flat
    // colored rectangles.
    expect(CUSTOM_CHAT_STYLE).toMatch(/--lc-chat-bubble-shadow:.*inset/)
    // Dark variant explicitly named — the laplace/compact override:
    expect(CUSTOM_CHAT_STYLE).toMatch(/\[data-theme="laplace"\][\s\S]*?--lc-chat-bubble-shadow:[^;]*\binset\b/)
  })

  test('SC bubble has the "hero card" outer glow (NOT just --lc-chat-bubble-shadow)', () => {
    // SC is the only event that gets its own box-shadow rule — every other
    // card type rides on --lc-chat-bubble-shadow. If SC ever loses this
    // dedicated rule, it visually drops to the same weight as gift / guard,
    // which defeats "user paid for this, make sure it's seen".
    const m = CUSTOM_CHAT_STYLE.match(/\.lc-chat-card-event\[data-card="superchat"\] \.lc-chat-bubble \{([^}]*)\}/)
    expect(m).not.toBeNull()
    // The rule must read the dedicated `--lc-superchat-glow` variable, not
    // fall back to --lc-chat-bubble-shadow (which would make SC visually
    // identical to gift / guard cards) and not inline the rgba triple
    // (which would block presets from re-tinting the glow to match their
    // own SC gradient — see custom-chat-presets.ts MILK_GREEN / MIDNIGHT_INDIGO).
    expect(m![1]).toMatch(/box-shadow:\s*var\(--lc-superchat-glow\)/)
  })

  test('--lc-superchat-glow baseline value is the iOS orange→red hero halo', () => {
    // The default glow value lives on the root selector so presets only
    // need to redeclare the var (not the whole rule). Locking it in here
    // because the rgba triple IS the visual identity — change it and SC
    // stops looking like SC.
    expect(CUSTOM_CHAT_STYLE).toMatch(/--lc-superchat-glow:\s*[\s\S]*?0 12px 32px rgba\(255, 69, 58, \.35\)/)
  })

  test('entrance animation is registered AND scoped to .lc-chat-peek (not every message)', () => {
    expect(CUSTOM_CHAT_STYLE).toContain('@keyframes lc-msg-in')
    // The selector matters: .lc-chat-peek is only set by the renderer for
    // genuinely new messages (custom-chat-dom.ts ~line 1282). If a future
    // edit drops `.lc-chat-peek` from the selector, virtualized scroll will
    // re-animate every visible message on every render — disaster.
    expect(CUSTOM_CHAT_STYLE).toMatch(/\.lc-chat-message\.lc-chat-peek\s*\{[^}]*animation:\s*lc-msg-in/)
  })

  test('entrance animation respects prefers-reduced-motion', () => {
    expect(CUSTOM_CHAT_STYLE).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.lc-chat-message\.lc-chat-peek[\s\S]*?animation:\s*none/
    )
  })

  test('lite event padding is on 4px grid (was 4px 9px)', () => {
    const m = CUSTOM_CHAT_STYLE.match(/\.lc-chat-message\[data-priority="lite"\] \.lc-chat-bubble \{([^}]*)\}/)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('padding: 4px 12px')
    expect(m![1]).not.toContain('padding: 4px 9px')
  })
})
