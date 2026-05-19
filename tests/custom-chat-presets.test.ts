/**
 * Cascade lock-in tests for `MILK_GREEN_IMESSAGE_CSS` and
 * `MIDNIGHT_INDIGO_IMESSAGE_CSS`.
 *
 * Both presets shipped (2026-05-15 → 2026-05-17) with two cascade bugs that
 * caused them to silently fall back to baseline colors. The bugs:
 *
 *   1. **`@layer chatterbox-custom-css { … }` wrapper.** Per CSS Cascading
 *      Level 5, ANY unlayered author rule beats EVERY layered author rule
 *      regardless of specificity / source order. Baseline `CUSTOM_CHAT_STYLE`
 *      is unlayered, so wrapping the preset in a named layer made its color
 *      tokens lose every fight against baseline.
 *
 *   2. **`#laplace-custom-chat` bare-id selectors.** Baseline declares dark
 *      theme variants on `#laplace-custom-chat[data-theme="laplace"]`
 *      (specificity 0,1,1,0), one notch higher than the bare-id 0,1,0,0
 *      preset. Even after unlayering, those baseline overrides win. Bumping
 *      the preset to `#laplace-custom-chat[data-theme]` ties on specificity
 *      and lets source order (preset `<style>` is appended after baseline)
 *      decide — preset wins.
 *
 * These tests catch regressions of either bug. They are intentionally
 * brittle on the SELECTOR shape (not just "does this color appear somewhere")
 * because a preset can include a color in a comment and still be broken.
 *
 * Visual proof of the original failure & fix is in
 * `tmp/chat-preview/{chat-milk,chat-midnight}.html` — open them and call
 * `getComputedStyle(document.querySelector('#laplace-custom-chat'))` if you
 * want to eyeball the cascade.
 */

import { describe, expect, test } from 'bun:test'

import { MIDNIGHT_INDIGO_IMESSAGE_CSS, MILK_GREEN_IMESSAGE_CSS } from '../src/lib/custom-chat-presets'

const PRESETS = {
  MILK_GREEN_IMESSAGE_CSS,
  MIDNIGHT_INDIGO_IMESSAGE_CSS,
}

describe('preset cascade — no @layer wrapper', () => {
  for (const [name, css] of Object.entries(PRESETS)) {
    test(`${name} does not wrap rules in a cascade layer`, () => {
      // Either `@layer foo { ... }` (named) or `@layer { ... }` (anonymous)
      // would tank the preset's priority against unlayered baseline.
      expect(css).not.toMatch(/@layer\b/)
    })
  }
})

describe('preset cascade — selectors bump specificity past baseline data-theme variants', () => {
  for (const [name, css] of Object.entries(PRESETS)) {
    test(`${name} uses #laplace-custom-chat[data-theme] for every rule, never the bare id`, () => {
      // Pull every selector line (lines starting with `#laplace-custom-chat`
      // up to the next `{` opening brace). Allow comma-separated selector
      // groups by inspecting each fragment.
      const lines = css.split('\n')
      const offenders: string[] = []
      for (const rawLine of lines) {
        const line = rawLine.trim()
        // Only inspect actual selector lines, not properties inside rules.
        // A selector line either ends with `{` or with `,` (multi-selector
        // group continued on the next line).
        if (!line.startsWith('#laplace-custom-chat')) continue
        if (!line.endsWith('{') && !line.endsWith(',')) continue
        // Split on commas to handle multi-selector groups on the same line.
        for (const fragRaw of line.replace(/[{,]$/, '').split(',')) {
          const frag = fragRaw.trim()
          if (!frag.startsWith('#laplace-custom-chat')) continue
          // Acceptable: `#laplace-custom-chat[data-theme]` (with or without
          // trailing descendants). Reject: `#laplace-custom-chat` followed by
          // anything other than `[` (i.e. bare id, descendant, comma, or *).
          const afterId = frag.slice('#laplace-custom-chat'.length)
          if (!afterId.startsWith('[')) {
            offenders.push(frag)
          }
        }
      }
      // Toleration: if a future maintainer adds a `#laplace-custom-chat::before`
      // or `#laplace-custom-chat:hover` rule and intentionally wants lower
      // specificity, they should explicitly comment that intent. Until then,
      // require strict `[data-theme]` prefix.
      expect(offenders).toEqual([])
    })
  }
})

describe('preset color identity — sanity-check the headline tokens', () => {
  test('MILK_GREEN declares pale-mint background, not baseline gray', () => {
    expect(MILK_GREEN_IMESSAGE_CSS).toContain('--lc-chat-bg: #eef7f1')
    expect(MILK_GREEN_IMESSAGE_CSS).toContain('--lc-chat-name: #248a61')
  })
  test('MIDNIGHT_INDIGO declares midnight-blue background, not baseline near-black', () => {
    expect(MIDNIGHT_INDIGO_IMESSAGE_CSS).toContain('--lc-chat-bg: #0c1228')
    expect(MIDNIGHT_INDIGO_IMESSAGE_CSS).toContain('--lc-chat-name: #8ca6ff')
  })
  test('MIDNIGHT_INDIGO SC bubble keeps its rainbow outer glow (the "hero card" treatment)', () => {
    // The signature shadow is 12px y-offset + 32px blur in iOS Indigo blue —
    // this is what makes SC bubbles read as "see this, not a chat line".
    // After the refactor the value lives on `--lc-superchat-glow` instead of
    // a hard-coded `box-shadow:` line, but the rgba triple is unchanged so
    // this assertion still locks the visual identity.
    expect(MIDNIGHT_INDIGO_IMESSAGE_CSS).toContain('0 12px 32px rgba(13, 99, 255, .35)')
  })
})

describe('preset SC glow — each preset re-tints --lc-superchat-glow away from baseline red', () => {
  // Regression guard: MILK_GREEN shipped 2026-05-15→2026-05-18 with a
  // green/mint SC bubble background but inherited baseline's `0 12px 32px
  // rgba(255, 69, 58, .35)` red glow because the preset never overrode
  // box-shadow. Fix: baseline reads `box-shadow: var(--lc-superchat-glow)`,
  // each preset declares its own glow value next to `--lc-superchat-bg`.

  test('MILK_GREEN declares --lc-superchat-glow tinted to its SC palette, not baseline red', () => {
    // Must declare the variable…
    expect(MILK_GREEN_IMESSAGE_CSS).toMatch(/--lc-superchat-glow:/)
    // …and the outer-halo rgba should reference the SC gradient's mint
    // endpoint (#47d18c → rgba(71, 209, 140, …)), not baseline's hot-red
    // rgba(255, 69, 58, …).
    expect(MILK_GREEN_IMESSAGE_CSS).toContain('0 12px 32px rgba(71, 209, 140, .36)')
    expect(MILK_GREEN_IMESSAGE_CSS).not.toContain('rgba(255, 69, 58')
  })

  test('MIDNIGHT_INDIGO declares --lc-superchat-glow tinted to its SC palette, not baseline red', () => {
    expect(MIDNIGHT_INDIGO_IMESSAGE_CSS).toMatch(/--lc-superchat-glow:/)
    // Blue outer halo from the SC gradient's #0d63ff endpoint.
    expect(MIDNIGHT_INDIGO_IMESSAGE_CSS).toContain('0 12px 32px rgba(13, 99, 255, .35)')
    expect(MIDNIGHT_INDIGO_IMESSAGE_CSS).not.toContain('rgba(255, 69, 58')
  })
})
