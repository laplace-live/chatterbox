import type { SVGAttributes as PreactSVGAttributes } from 'preact'

// @tabler/icons-preact's typings still read `JSX.SVGAttributes`, which Preact 11 moved to top-level `preact`;
// without this alias its icon props silently degrade to `any`. Drop once upstream imports it from `preact`.
declare global {
  namespace preact.JSX {
    type SVGAttributes<Target extends EventTarget = SVGElement> = PreactSVGAttributes<Target>
  }
}
