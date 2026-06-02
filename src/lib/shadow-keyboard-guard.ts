/**
 * Keyboard isolation for text fields living inside our shadow root.
 *
 * The whole UI mounts inside a `mode:'open'` shadow root (see main.tsx).
 * Page-level keyboard-shortcut handlers — most visibly the popular
 * "Video Speed Controller" extension, but also B站's own hotkeys —
 * attach a `keydown` listener on `document` in the CAPTURE phase and
 * decide whether to swallow the key by inspecting `event.target` /
 * `document.activeElement`. Across a shadow boundary the event is
 * RETARGETED to the shadow host (a bare <div>), so those handlers never
 * see that a <textarea>/<input> is focused: they treat the keystroke as
 * a global shortcut and (e.g.) change the video speed while the user is
 * typing a note.
 *
 * Fix: install our own listener on `window` in the CAPTURE phase. Capture
 * runs window → document → … → target, so a window-capture listener fires
 * BEFORE any document-capture handler regardless of registration order —
 * the one place we can pre-empt an extension's document-capture hotkey.
 * When the focused element *inside our shadow root* is editable, we
 * `stopPropagation()` so page/extension handlers never see the key.
 *
 * Scope is deliberately narrow on two axes so we fix the hijack without
 * swallowing keys our own UI (or the browser) needs:
 *
 *   1. Only when one of OUR fields is focused. `shadowRoot.activeElement`
 *      resolves focus *within* the shadow tree (null when focus is in the
 *      host page), so we never touch the host page's own inputs.
 *
 *   2. Only "typing" keys: a single printable character with no
 *      Ctrl/Meta/Alt. These are exactly what shortcut handlers grab and
 *      what the user means to type. Escape, Enter, Tab, arrows, function
 *      keys and modifier combos all keep propagating — so the popover's
 *      document-level Escape-to-close, Enter-to-submit handlers, combobox
 *      navigation and native browser shortcuts are unaffected.
 *
 * We never `preventDefault()`: inserting the character is the browser's
 * default action, which propagation does not gate, so typing (and the
 * resulting `input` event our editors listen on) still works normally.
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
  // Single-code-unit `key` covers letters, digits, punctuation and space
  // (`' '`); named keys (`Escape`, `Enter`, `ArrowLeft`, …) are longer.
  return e.key.length === 1
}

/**
 * Wire the guard for `root`. Idempotent per call (each mount installs its
 * own listeners); we never tear them down because the host lives for the
 * page's lifetime.
 */
export function installShadowKeyboardGuard(root: ShadowRoot): void {
  const guard = (e: KeyboardEvent): void => {
    if (!isTypingKey(e)) return
    if (!isEditable(root.activeElement)) return
    e.stopPropagation()
  }

  // keydown is what VSC and most hotkey handlers use; keypress/keyup are
  // covered too so a handler latching on either can't slip through.
  window.addEventListener('keydown', guard, true)
  window.addEventListener('keypress', guard, true)
  window.addEventListener('keyup', guard, true)
}
