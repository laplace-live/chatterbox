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
  /** Optional textarea height override; defaults to 100px (taller than the danmaku editor since prompts run longer). */
  textareaClassName?: string
  /** Element id forwarded to the picker so an external `<Label htmlFor>` can wire up. */
  selectId?: string
}

/**
 * Reusable per-feature LLM prompt editor.
 *
 * - Type-to-create: editing an empty list materialises the first entry (no 新增 click needed).
 * - 删除当前 may delete the last entry; unlike auto-send there's no loop to stall, so an empty list is valid.
 * - Out-of-range active index (e.g. after a storage schema change) is clamped display-side only; state is untouched.
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
  // Clamp for rendering only — a write-back would be a render-time signal write; 新增 re-anchors the index naturally.
  const safeIndex = prompts.length > 0 ? Math.min(Math.max(0, activeIndex), prompts.length - 1) : 0
  const currentPrompt = prompts[safeIndex] ?? ''

  const updateActivePrompt = (text: string) => {
    // Type-to-create: an edit on an empty list materialises the first entry (picker grows 0 → 1).
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
    // Deleting the tail steps selection back to the new last item (follows the user's eye) instead of past the end.
    onActiveIndexChange(Math.max(0, Math.min(safeIndex, next.length - 1)))
  }

  return (
    <>
      <div class='mb-2 flex flex-wrap items-center gap-1'>
        <PromptPicker
          id={selectId}
          // Wider than feature-tab pickers since Settings has room; no previewGraphemes override keeps getPromptPreview's 24-grapheme cap.
          className='min-w-40 flex-1 truncate'
          prompts={prompts}
          activeIndex={activeIndex}
          onActiveIndexChange={onActiveIndexChange}
          // Domain-specific empty hint pointing at 新增, not the generic '(空)' fallback.
          emptyText='暂无提示词，请点击「新增」添加'
        />
        <Button variant='outline' size='sm' onClick={addPrompt}>
          新增
        </Button>
        <Button
          variant='outline'
          size='sm'
          // Disable rather than no-op to communicate affordance.
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
