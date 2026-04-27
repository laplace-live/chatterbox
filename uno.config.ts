import { defineConfig, presetWind4 } from 'unocss'

// UnoCSS configuration for the userscript.
//
// Three constraints drive the choices below:
//
// 1. We render inside live.bilibili.com — a host page we don't own. Anything
//    we ship in CSS could leak. presetWind4 ships three things by default
//    that would all bleed onto B站's DOM, so all three must be turned off:
//      - `preflights.reset: false` skips the Tailwind4-style global reset
//        (`*`, `button`, `input`, headings, etc.).
//      - `preflights.theme: false` suppresses the `:root, :host { ... }`
//        block of theme CSS variables (`--spacing`, `--font-sans`, color
//        scales, etc.). With theme off, theme tokens we use are inlined
//        directly into each utility instead.
//      - `preflights.property: false` skips the `@property` rules that
//        target `*, ::before, ::after, ::backdrop` to declare helper
//        custom properties (`--lc-text-opacity`, etc.). Utilities still
//        work without them; we just lose the typed-property optimization.
//      - `prefix: 'lc-'` namespaces every utility class. `flex` does not
//        match — only `lc-flex` does. This prevents accidental collisions
//        with B站's own classes and means the generated CSS only targets
//        elements we deliberately tagged.
//      - `variablePrefix: 'lc-'` renames the internal helper CSS variables
//        UnoCSS emits (e.g. `--lc-bg-opacity` instead of `--un-bg-opacity`)
//        for the same reason.
//
// 2. The userscript bundle is one file. CSS is auto-inlined by
//    `vite-plugin-monkey` via `GM_addStyle` (with a `head || documentElement`
//    fallback for `document-start`), so we just need `import 'virtual:uno.css'`
//    in the entry — no separate stylesheet to ship.
//
// 3. The existing components inherit B站's design tokens through CSS variables
//    (`var(--Ga2, #eee)`, `var(--bg1, #fff)`). Mapping those into the theme
//    here lets us write `lc-bg-bg1` / `lc-border-ga2` and still have the
//    classes track host theme changes (light/dark) automatically.
export default defineConfig({
  presets: [
    presetWind4({
      prefix: 'lc-',
      variablePrefix: 'lc-',
      preflights: {
        reset: false,
        theme: 'on-demand',
        property: false,
      },
    }),
  ],

  theme: {
    colors: {
      // B站 host CSS variables. Fallbacks match the values used inline in
      // the existing components, so behavior is identical when these vars
      // aren't defined (e.g. on space.bilibili.com or in older themes).
      ga1: 'var(--Ga1, #f5f5f5)',
      ga1s: 'var(--Ga1_s, rgba(0,0,0,.04))',
      ga2: 'var(--Ga2, #eee)',
      ga3: 'var(--Ga3, #ddd)',
      ga4: 'var(--Ga4, #999)',
      bg1: 'var(--bg1, #fff)',
      bg2: 'var(--bg2, #f5f5f5)',

      // App-specific accents currently hard-coded in inline styles.
      brand: '#36a185',
      danger: '#d44',
      link: '#288bb8',
    },
  },

  // Tightly-scoped global CSS that can't be expressed as utility classes
  // because it has to apply to every descendant of the dialog (font-size
  // cascade). The selectors all start with our ID prefixes so this is safe
  // — it can't accidentally hit anything on B站's page outside our DOM.
  preflights: [
    {
      getCSS: () => `
        #laplace-chatterbox-toggle,
        #laplace-chatterbox-dialog {
          font-size: 13px;
        }
      `,
    },
  ],

  content: {
    pipeline: {
      include: [/\.[jt]sx?($|\?)/],
    },
  },
})
