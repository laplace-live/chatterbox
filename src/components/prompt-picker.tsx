import { getPromptPreview } from '../lib/prompts'
import { Combobox } from './ui/combobox'

export interface PromptPickerProps {
  /** All prompt drafts to choose from. */
  prompts: string[]
  /** Index of the currently active draft. */
  activeIndex: number
  /** Notify parent when the user picks a different draft. */
  onActiveIndexChange: (idx: number) => void

  /** Forwarded to the Combobox trigger for `<Label htmlFor>` wiring. */
  id?: string
  /** Forwarded to the underlying Combobox. */
  className?: string
  /** Native HTML title (tooltip). Useful when there's no visible label. */
  title?: string
  /** Force-disable the picker; empty lists also disable automatically. */
  disabled?: boolean

  /** Cap on each option's first-line preview length; defaults to 24 via `getPromptPreview`. */
  previewGraphemes?: number

  /** Trigger placeholder when `prompts` is empty. Defaults to `(空)`. */
  emptyText?: string
}

/**
 * Shared dropdown for picking the active draft from a per-feature prompt list.
 * Clamps out-of-range indices for render only; renders a disabled placeholder
 * on empty (rather than null) so layout doesn't reflow as prompts change.
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
  // Clamp for render only — writing back here would re-enter during commit.
  const safeIndex = prompts.length > 0 ? Math.min(Math.max(0, activeIndex), prompts.length - 1) : 0
  const isEmpty = prompts.length === 0

  return (
    <Combobox
      id={id}
      className={className}
      title={title}
      disabled={disabled || isEmpty}
      // Empty value falls back to `placeholder` instead of echoing a stale index.
      value={isEmpty ? '' : String(safeIndex)}
      options={prompts.map((p, i) => ({
        value: String(i),
        // Numeric prefix gives a stable handle even when previews look similar.
        label: `${i + 1}: ${getPromptPreview(p, previewGraphemes)}`,
      }))}
      onChange={v => {
        const idx = parseInt(v, 10)
        if (!Number.isNaN(idx)) onActiveIndexChange(idx)
      }}
      placeholder={emptyText ?? '(空)'}
    />
  )
}
