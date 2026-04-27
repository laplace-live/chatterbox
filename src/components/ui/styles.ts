// Shared CSS for the ui/* components.
//
// Inline styles can't express :hover / :focus / :disabled, so we inject a
// tiny global stylesheet on first use. The injection is idempotent and
// guarded against running before <head> exists (the userscript runs at
// document-start so module-level code may execute before the parser has
// produced <head>).

const STYLE_ID = 'laplace-chatterbox-ui-styles'

let injected = false

const CSS = `
.lpc-ui-button:not(:disabled):hover {
  filter: brightness(0.96);
}
.lpc-ui-button:not(:disabled):active {
  filter: brightness(0.9);
}
.lpc-ui-input:focus,
.lpc-ui-textarea:focus {
  border-color: #36a185;
}
.lpc-ui-checkbox:focus-visible {
  outline: 2px solid #36a185;
  outline-offset: 1px;
}
`

export function ensureUiStyles(): void {
  if (injected) return
  if (typeof document === 'undefined' || !document.head) return
  if (document.getElementById(STYLE_ID)) {
    injected = true
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  injected = true
}
