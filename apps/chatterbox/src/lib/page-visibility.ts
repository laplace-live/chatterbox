// Anti-AFK scripts (e.g. BLTH's 屏蔽挂机检测) pin `document.hidden` to false as an own property, and
// Tampermonkey runs every userscript in one shared world; the prototype getter still reports the truth.
const nativeHiddenGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')?.get

/** Real tab visibility, immune to own-property overrides on `document`. */
export function isTabHidden(): boolean {
  return nativeHiddenGetter ? nativeHiddenGetter.call(document) === true : document.hidden
}
