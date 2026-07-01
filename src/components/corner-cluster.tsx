import type { ComponentChildren } from 'preact'

/** Bottom-right fixed cluster shell owning position, z-index, and spacing; membership comes from children. */
export function CornerCluster({ children }: { children: ComponentChildren }) {
  return (
    <div data-slot={'corner-cluster'} class='fixed right-1 bottom-1 z-2147483647 flex items-center gap-1'>
      {children}
    </div>
  )
}
