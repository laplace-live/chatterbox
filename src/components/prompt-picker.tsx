import { getPromptPreview } from '../lib/prompts'
import { Combobox } from './ui/combobox'

export interface PromptPickerProps {
  /** All prompt drafts to choose from. */
  prompts: string[]
  /** Index of the currently active draft. */
  activeIndex: number
  /** Notify parent when the user picks a different draft. */
  onActiveIndexChange: (idx: number) => void

  /** Forwarded to the underlying Combobox trigger so external
   *  <Label htmlFor> / form-control wiring works. */
  id?: string
  /** Forwarded to the underlying Combobox. */
  className?: string
  /** Native HTML title (tooltip). Useful when there's no visible label. */
  title?: string
  /** Disable the picker even when there are prompts to choose from
   *  (e.g. while a parent operation is in flight). Empty lists also
   *  disable automatically. */
  disabled?: boolean

  /** Cap on the first-line preview length used for each option's
   *  visible label. Defers to `getPromptPreview`'s default (24) when
   *  omitted — inline pickers in feature tabs typically pass a smaller
   *  value to keep the dropdown narrow. */
  previewGraphemes?: number

  /** Placeholder shown in the trigger when `prompts` is empty.
   *  Defaults to `(空)` — pass a domain-relevant hint (e.g.
   *  "暂无提示词，请点击「新增」添加") when the surrounding UI offers an
   *  obvious next step. Callers that prefer to *hide* the picker
   *  entirely on empty should gate the JSX themselves rather than
   *  relying on this. */
  emptyText?: string
}

/**
 * Shared dropdown for picking the active draft from a per-feature
 * prompt list.
 *
 * Owns three concerns that would otherwise duplicate at every call
 * site:
 *   1. Index clamping for render — a persisted out-of-range index
 *      (e.g. user deleted prompts in Settings) gets visually anchored
 *      to a real option here. The next pick the user makes writes a
 *      clean value back through `onActiveIndexChange`.
 *   2. Option rendering — each row is `${i+1}: ${preview}` where
 *      `preview` is the prompt's first line, grapheme-trimmed by
 *      `getPromptPreview`. Numeric prefix gives users a stable handle
 *      to refer to ("the 3rd prompt") even when previews look similar.
 *   3. Empty-state handling — shows `emptyText ?? '(空)'` as the
 *      Combobox placeholder and auto-disables the trigger. We don't
 *      return null on empty so the layout doesn't reflow as the user
 *      adds / removes prompts; callers that *need* the picker to
 *      disappear should gate the JSX themselves.
 *
 * Used by the Settings PromptManager (with 24-grapheme previews and
 * a domain-specific empty hint) and the inline picker on each feature
 * tab (smaller previews to fit alongside the AI / YOLO buttons).
 */
export function PromptPicker({
  prompts,
  activeIndex,
  onActiveIndexChange,
  id,
  className,
  title,
  disabled,
  previewGraphemes,
  emptyText,
}: PromptPickerProps) {
  // Clamp for rendering only — never write back here. Two reasons:
  //   1. Avoids a render-time signal write that would re-enter the
  //      component during commit.
  //   2. Keeps the persisted value untouched; a caller-side write only
  //      happens in response to a real user pick.
  const safeIndex = prompts.length > 0 ? Math.min(Math.max(0, activeIndex), prompts.length - 1) : 0
  const isEmpty = prompts.length === 0

  return (
    <Combobox
      id={id}
      className={className}
      title={title}
      // Disable automatically when there's nothing to pick. Callers
      // can ALSO disable for their own reasons (e.g. "in flight"),
      // and either condition wins.
      disabled={disabled || isEmpty}
      // Empty value when there are no prompts so the trigger falls back
      // to `placeholder` (the emptyText hint) instead of echoing a stale
      // index. A real pick always writes a clean index back via onChange.
      value={isEmpty ? '' : String(safeIndex)}
      options={prompts.map((p, i) => ({
        value: String(i),
        // Numeric prefix gives users a stable handle to refer to
        // ("the 3rd prompt") even when previews look similar.
        label: `${i + 1}: ${getPromptPreview(p, previewGraphemes)}`,
      }))}
      onChange={v => {
        const idx = parseInt(v, 10)
        if (!Number.isNaN(idx)) onActiveIndexChange(idx)
      }}
      // Placeholder doubles as the empty-state sentinel: when the list
      // is empty the (disabled) trigger shows this text. Mirrors the
      // old single-sentinel <option>.
      placeholder={emptyText ?? '(空)'}
    />
  )
}
