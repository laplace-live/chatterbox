import { getPromptPreview } from '../lib/prompts'
import { NativeSelect } from './ui/native-select'

export interface PromptPickerProps {
  /** All prompt drafts to choose from. */
  prompts: string[]
  /** Index of the currently active draft. */
  activeIndex: number
  /** Notify parent when the user picks a different draft. */
  onActiveIndexChange: (idx: number) => void

  /** Forwarded to the underlying <select> so external <Label htmlFor>
   *  / form-control wiring works. */
  id?: string
  /** Forwarded to the underlying <select>. */
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

  /** Sentinel option label rendered when `prompts` is empty.
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
 *   1. Index clamping for render — a persisted out-of-range index gets
 *      visually anchored to a real option here. The next pick the user
 *      makes writes a clean value back through `onActiveIndexChange`.
 *   2. Option rendering — each row is `${i+1}: ${preview}` where
 *      `preview` is the prompt's first line, grapheme-trimmed by
 *      `getPromptPreview`. Numeric prefix gives users a stable handle
 *      to refer to ("the 3rd prompt") even when previews look similar.
 *   3. Empty-state handling — renders a single sentinel option labelled
 *      `emptyText ?? '(空)'` and auto-disables the select. We don't
 *      return null on empty so the layout doesn't reflow as the user
 *      adds / removes prompts; callers that *need* the picker to
 *      disappear should gate the JSX themselves.
 *
 * Used by the Settings PromptManager (with 24-grapheme previews and a
 * domain-specific empty hint) and the inline picker on each feature
 * tab (smaller previews to fit alongside the AI 润色 toggles, internal
 * name still `yolo`).
 *
 * 设计参考自 upstream chatterbox 090bd1e。
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
    <NativeSelect
      id={id}
      className={className}
      title={title}
      // Disable automatically when there's nothing to pick. Callers can
      // ALSO disable for their own reasons (e.g. "in flight"), and either
      // condition wins.
      disabled={disabled || isEmpty}
      // Sentinel value '' when empty so the <select>'s value matches the
      // sentinel option's value. Without this, Firefox / Safari would
      // treat the value '0' as pointing at no visible option and render
      // the field blank. Chrome happens to fall back to the first option,
      // which is the same outcome but inconsistent — this keeps all
      // three browsers in sync.
      value={isEmpty ? '' : String(safeIndex)}
      onChange={e => {
        const v = Number.parseInt(e.currentTarget.value, 10)
        if (!Number.isNaN(v)) onActiveIndexChange(v)
      }}
    >
      {isEmpty ? (
        <option value=''>{emptyText ?? '(空)'}</option>
      ) : (
        prompts.map((p, i) => (
          <option key={i} value={String(i)}>
            {i + 1}: {getPromptPreview(p, previewGraphemes)}
          </option>
        ))
      )}
    </NativeSelect>
  )
}
