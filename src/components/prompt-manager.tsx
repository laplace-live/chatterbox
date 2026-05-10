import { getGraphemes, trimText } from '../lib/utils'
import { Button } from './ui/button'
import { NativeSelect } from './ui/native-select'
import { Textarea } from './ui/textarea'

/** Hard cap on how many graphemes of the first line we surface as a
 *  preview in the picker. Larger than the 10-grapheme cap used by the
 *  独轮车 template editor because LLM prompts in this UI live inside the
 *  full-width Settings tab and tend to start with longer instructions
 *  ("You are a Bilibili danmaku rewriter that…") where 10 chars cuts
 *  before any meaningful disambiguator. */
const PROMPT_PREVIEW_GRAPHEMES = 24

/**
 * Build the picker label for a single prompt: the first non-empty line,
 * grapheme-trimmed with an ellipsis when over `PROMPT_PREVIEW_GRAPHEMES`.
 * Empty drafts surface as `(空)` so the user can still pick + edit them.
 *
 * Mirrors `getPreview` in `auto-send-controls.tsx` so the two managers
 * read the same way at a glance.
 */
function getPromptPreview(prompt: string): string {
  const firstLine = (prompt.split('\n')[0] ?? '').trim()
  if (!firstLine) return '(空)'
  return getGraphemes(firstLine).length > PROMPT_PREVIEW_GRAPHEMES
    ? `${trimText(firstLine, PROMPT_PREVIEW_GRAPHEMES)[0]}…`
    : firstLine
}

export interface PromptManagerProps {
  /** All prompt drafts the user has authored for one feature. */
  prompts: string[]
  /** Index into `prompts` of the draft that's currently editable / used. */
  activeIndex: number
  /** Push a new prompts array (after add / remove / edit). */
  onPromptsChange: (next: string[]) => void
  /** Push a new active-index value (after add / remove / picker change). */
  onActiveIndexChange: (next: number) => void
  /** Placeholder shown inside the textarea when the draft is empty. */
  placeholder?: string
  /** Optional textarea height override; defaults to 100px (taller than
   *  the danmaku template editor because prompts run longer). */
  textareaClassName?: string
  /** Element id forwarded to the picker so an external <Label htmlFor>
   *  can wire up correctly. */
  selectId?: string
}

/**
 * Reusable per-feature LLM prompt editor.
 *
 * UX intentionally mirrors the 独轮车 template manager: a NativeSelect
 * picker, 新增 / 删除当前 buttons, and a single Textarea bound to the
 * active draft. The user's request was explicit about that parity so the
 * mental model carries over without learning anything new.
 *
 * Subtle behaviours worth knowing about:
 *
 * - `prompts` is treated as the source of truth even when the active
 *   index points past its end. We render an empty draft and let the
 *   user start typing — first keystroke materialises a new entry at
 *   index 0 — instead of forcing them to click 新增 first. Matches the
 *   "type to create" forgiveness in `auto-send-controls.tsx`.
 *
 * - 删除当前 always allows deletion, even of the last entry. The auto-
 *   send manager refuses to delete the last template because an empty
 *   template would silently stop the loop; the LLM prompt list has no
 *   such auto-trigger, so an empty list is a perfectly valid "I haven't
 *   set anything up yet" state.
 *
 * - When the active index is out of range (e.g. after the storage
 *   schema changed underneath us), we clamp display-side without
 *   touching state. The next user action that adjusts the index will
 *   write a clean value back.
 */
export function PromptManager({
  prompts,
  activeIndex,
  onPromptsChange,
  onActiveIndexChange,
  placeholder,
  textareaClassName,
  selectId,
}: PromptManagerProps) {
  // Clamp for rendering only — never write back here. Two reasons:
  //   1. Avoids a render-time signal write that would re-enter the
  //      component during commit.
  //   2. Keeps the persisted value untouched if the user clicks 新增
  //      next, which will re-anchor the index naturally.
  const safeIndex = prompts.length > 0 ? Math.min(Math.max(0, activeIndex), prompts.length - 1) : 0
  const currentPrompt = prompts[safeIndex] ?? ''

  const updateActivePrompt = (text: string) => {
    // Type-to-create: an edit on an empty list materialises the first
    // entry rather than rejecting the keystroke. The user explicitly
    // gets feedback (the picker grows from 0 → 1 entry).
    if (prompts.length === 0) {
      onPromptsChange([text])
      onActiveIndexChange(0)
      return
    }
    const next = [...prompts]
    next[safeIndex] = text
    onPromptsChange(next)
  }

  const addPrompt = () => {
    const next = [...prompts, '']
    onPromptsChange(next)
    onActiveIndexChange(next.length - 1)
  }

  const removeCurrent = () => {
    if (prompts.length === 0) return
    const next = [...prompts]
    next.splice(safeIndex, 1)
    onPromptsChange(next)
    // Step back one slot when we just deleted the current tail, so the
    // selection follows the user's eye to the entry that took its place
    // visually (the new last item) rather than jumping past the end.
    onActiveIndexChange(Math.max(0, Math.min(safeIndex, next.length - 1)))
  }

  return (
    <>
      <div class='lc-flex lc-gap-1 lc-items-center lc-flex-wrap lc-mb-2'>
        <NativeSelect
          id={selectId}
          // Wider than the 16ch picker in 独轮车 because Settings has the
          // room to breathe and prompt previews benefit from it.
          className='lc-flex-1 lc-min-w-[160px]'
          // Empty list disables the picker entirely so users don't see a
          // greyed-out (空) option masquerading as a real choice.
          disabled={prompts.length === 0}
          value={String(safeIndex)}
          onChange={e => {
            const v = parseInt(e.currentTarget.value, 10)
            if (!Number.isNaN(v)) onActiveIndexChange(v)
          }}
        >
          {prompts.length === 0 ? (
            // Sentinel option so the <select> isn't blank — users see
            // "暂无提示词" the same way an empty NativeSelect would
            // show "Choose…" in stock HTML, but with a domain-relevant
            // hint that points at the 新增 button next to it.
            <option value=''>暂无提示词，请点击「新增」添加</option>
          ) : (
            prompts.map((p, i) => (
              <option key={i} value={String(i)}>
                {i + 1}: {getPromptPreview(p)}
              </option>
            ))
          )}
        </NativeSelect>
        <Button variant='outline' size='sm' onClick={addPrompt}>
          新增
        </Button>
        <Button
          variant='outline'
          size='sm'
          // Disabling (rather than no-op) communicates affordance —
          // matches what the auto-send manager would do if it allowed
          // deleting the last template.
          disabled={prompts.length === 0}
          onClick={removeCurrent}
        >
          删除当前
        </Button>
      </div>

      <Textarea
        value={currentPrompt}
        onInput={e => updateActivePrompt(e.currentTarget.value)}
        placeholder={placeholder ?? '在这里输入提示词，第一行会作为预览名称'}
        className={textareaClassName ?? 'lc-h-[100px]'}
      />
    </>
  )
}
