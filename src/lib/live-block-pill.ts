import { createDeferredNode } from './deferred-node'

/** The green "✽ …已解锁" pill shown in a live room header's `.right-section`. */
export function createLiveBlockPill(opts: { id: string; text: string; title: string }) {
  const { id, text, title } = opts
  const node = createDeferredNode({
    id,
    target: '.right-section',
    attach: (host, el) => host.prepend(el),
  })
  const render = (): HTMLElement => {
    const el = document.createElement('div')
    el.title = title
    el.textContent = text
    el.style.cssText = [
      'display: inline-flex',
      'align-items: center',
      'align-self: center',
      'padding: 0 4px',
      'margin-right: 5px',
      'background: rgb(0 186 143)',
      'color: #fff',
      'border-radius: 4px',
      'font-size: 12px',
      'height: 20px',
      'line-height: 1',
      'flex-shrink: 0',
      'cursor: default',
    ].join(';')
    return el
  }
  return {
    ensure: (shouldInject?: () => boolean) => node.ensure(render, shouldInject),
    remove: () => node.remove(),
  }
}
