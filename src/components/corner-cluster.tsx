import type { ComponentChildren } from 'preact'

/**
 * Bottom-right fixed cluster shell. Owns positioning, z-index ceiling,
 * and inter-button spacing so every surface that mounts buttons in the
 * corner stays visually aligned without each call site re-deriving the
 * same offsets.
 *
 * Membership is the caller's job — pass whatever buttons belong on that
 * surface as children. This keeps the "which buttons appear where"
 * decision colocated with the surface (`AppRoom`, `AppSpace`) instead of
 * being smuggled through a boolean flag on a shared component.
 */
export function CornerCluster({ children }: { children: ComponentChildren }) {
  return <div class='fixed right-1 bottom-1 z-2147483647 flex items-center gap-1'>{children}</div>
}
