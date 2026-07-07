/** Place `node` relative to the resolved `target` element (e.g. prepend, or insert after). */
type AttachFn = (target: HTMLElement, node: HTMLElement) => void

export interface DeferredNode {
  /**
   * Inject `render()`'s node now, or once `target` mounts (we run at document-start,
   * so it usually doesn't exist yet). `shouldInject` is re-checked when the target
   * finally mounts, so a toggled-off feature skips a late injection. No-op while the
   * node (by `id`) is already present.
   */
  ensure(render: () => HTMLElement, shouldInject?: () => boolean): void
  remove(): void
}

/**
 * A single DOM node injected relative to `target`, which may mount after us — we
 * wait via MutationObserver. Idempotent by `id`; `remove()` also cancels a pending
 * injection so it can't fire (unremovably) after the feature is off.
 */
export function createDeferredNode(opts: { id: string; target: string; attach: AttachFn }): DeferredNode {
  const { id, target, attach } = opts
  let observer: MutationObserver | null = null

  const disconnect = (): void => {
    observer?.disconnect()
    observer = null
  }

  const inject = (host: HTMLElement, render: () => HTMLElement): void => {
    if (document.getElementById(id)) return
    const node = render()
    node.id = id
    attach(host, node)
  }

  return {
    ensure(render: () => HTMLElement, shouldInject: () => boolean = () => true): void {
      if (document.getElementById(id)) return
      const host = document.querySelector<HTMLElement>(target)
      if (host) {
        inject(host, render)
        return
      }
      disconnect()
      observer = new MutationObserver(() => {
        if (!shouldInject()) {
          disconnect()
          return
        }
        const h = document.querySelector<HTMLElement>(target)
        if (!h) return
        disconnect()
        inject(h, render)
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    },
    remove(): void {
      disconnect()
      document.getElementById(id)?.remove()
    },
  }
}
