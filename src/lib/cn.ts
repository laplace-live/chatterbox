import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Why tailwind-merge v2.x and not v3.x:
//
// tailwind-merge v3+ assumes Tailwind v4's new prefix syntax where the
// prefix is the FIRST modifier (`lc:hover:flex`). UnoCSS, even with
// `presetWind4`, still emits Tailwind v3-style classes where the prefix
// hugs the utility name (`hover:lc-flex`). v2.6.0 is the last release
// that recognises the v3-style prefix, so this is the version that
// actually understands what UnoCSS produces.
//
// Trade-offs of staying on v2.x:
// - No knowledge of Tailwind v4's calc-based spacing scale, but tw-merge
//   matches by class-group taxonomy (the `padding` group is the same
//   whether the value resolves to `1rem` or `calc(var(--spacing) * 4)`),
//   so this is fine for our usage.
// - Bare-pixel arbitrary values like `lc-size-16px` aren't recognised —
//   only bracket form `lc-size-[16px]` is. Our codebase already uses the
//   bracket form everywhere.
const twMerge = extendTailwindMerge({
  prefix: 'lc-',
})

// Standard shadcn-shape `cn` helper: clsx for conditional/array/object
// composition, tailwind-merge for last-wins conflict resolution. Use this
// anywhere a component composes multiple class sources (BASE + variant +
// consumer override).
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
