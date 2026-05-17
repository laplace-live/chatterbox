import { PromptPicker } from './prompt-picker'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'

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
      <div class='mb-2 flex flex-wrap items-center gap-1'>
        <PromptPicker
          id={selectId}
          // Wider than the inline pickers in feature tabs because
          // Settings has the room to breathe and prompt previews
          // benefit from it. Default 24-grapheme cap from
          // `getPromptPreview` is preserved (no `previewGraphemes`
          // override).
          className='min-w-40 flex-1 truncate'
          prompts={prompts}
          activeIndex={activeIndex}
          onActiveIndexChange={onActiveIndexChange}
          // Domain-specific empty hint that points at the sibling
          // 新增 button rather than the generic '(空)' fallback.
          emptyText='暂无提示词，请点击「新增」添加'
        />
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
        className={textareaClassName ?? 'h-25'}
      />
    </>
  )
}
