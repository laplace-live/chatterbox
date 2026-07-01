/**
 * Keyboard isolation for text fields inside our shadow root.
 *
 * Shadow-boundary retargeting hides our focused <input>/<textarea> from page
 * hotkey handlers (they see the bare host <div>), so they hijack typing keys.
 * We listen on `window` in the capture phase — fires before any document-capture
 * handler regardless of order — and `stopPropagation()` for bare printable keys
 * while a field in our shadow tree is focused. Never `preventDefault()`: char
 * insertion is the browser default and propagation doesn't gate it, so typing
 * still works. Scope stays narrow (only our focus, only unmodified printable
 * keys) so Escape/Enter/Tab/arrows and browser shortcuts keep propagating.
 */

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA'])

function isEditable(el: Element | null): boolean {
  if (!el) return false
  if (EDITABLE_TAGS.has(el.tagName)) return true
  return (el as HTMLElement).isContentEditable === true
}

/** True for a bare printable keystroke (no modifier) — what page hotkeys grab. */
function isTypingKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  // Single-code-unit `key` = printable char; named keys (Escape, …) are longer.
  return e.key.length === 1
}

/**
 * Wire the guard for `root`. Listeners are never removed — the host lives for
 * the page's lifetime.
 */
export function installShadowKeyboardGuard(root: ShadowRoot): void {
  const guard = (e: KeyboardEvent): void => {
    if (!isTypingKey(e)) return
    if (!isEditable(root.activeElement)) return
    e.stopPropagation()
  }

  // keypress/keyup covered too so a handler latching on either can't slip through.
  window.addEventListener('keydown', guard, true)
  window.addEventListener('keypress', guard, true)
  window.addEventListener('keyup', guard, true)
}
