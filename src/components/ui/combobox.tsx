import { useSignal } from '@preact/signals'
import { IconCheck, IconChevronDown } from '@tabler/icons-preact'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

import { cn } from '../../lib/cn'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Separator } from './separator'

/**
 * Minimal contract every Combobox option must satisfy. Consumers can
 * extend this with whatever extra fields they need (e.g. pricing tier,
 * owner, tags, …) and pass that richer type through to `renderItem`
 * via the generic parameter — `Combobox<MyOption>`.
 */
export interface ComboboxOption {
  /** Controlled id. Compared against `value` and emitted via `onChange`. */
  value: string
  /** Shown by default in the trigger and in option rows. Defaults to `value`. */
  label?: string
  /**
   * Override the filter haystack. By default the filter matches against
   * `value` joined with `label` (when label differs) so typing the id
   * OR the friendly name both find the row. Set this when you want to
   * filter against extra metadata (price, owner, …) that isn't part of
   * the visible label.
   */
  searchText?: string
}

/**
 * shadcn-style Combobox: a button trigger that opens a floating popover
 * containing a filter input and a scrollable, keyboard-navigable list of
 * options. Picked over the native <select> when the option set is large
 * enough that filtering by typing is faster than scrolling — model
 * catalogs (OpenAI, OpenRouter, Together, …) easily run into hundreds of
 * ids.
 *
 * Generic over the option type so consumers can attach arbitrary metadata
 * to each option and surface it via `renderItem`. The Combobox owns the
 * click target, hover/keyboard tracking, and the leading check-icon
 * column; consumers' `renderItem` only returns the row content.
 *
 * Layout caveat: the popover is positioned absolutely against the trigger
 * wrapper. Inside the floating Configurator panel the dialog itself is
 * `overflow-hidden` (optimized) / `overflow-y-auto` (legacy), so a popover
 * opened near the dialog's bottom edge can be clipped. Place the
 * Combobox where there's room below it, or expect to scroll the panel.
 */
export interface ComboboxProps<O extends ComboboxOption = ComboboxOption> {
  value: string
  options: O[]
  onChange: (value: string) => void

  /** Trigger label when no value is selected. */
  placeholder?: string
  /** Filter input placeholder shown inside the popover. */
  searchPlaceholder?: string
  /** Empty-state message when the active filter has no matches. */
  emptyText?: string
  /** Empty-state message when there are no options at all (pre-fetch). */
  unloadedText?: string
  /**
   * When `value` is set but isn't present in `options`, render a
   * sentinel row at the bottom of the list using this label. Used to
   * surface a saved-but-now-missing selection (e.g. a model id that
   * disappeared from the provider's catalog) — the same pattern Soniox
   * uses for an unplugged microphone.
   */
  missingLabel?: (value: string) => string
  /**
   * Custom rendering for each option row. Receives the full option
   * object plus the `selected` / `active` flags so consumers can react
   * to selection or hover state.
   *
   * Default: a single-line `label ?? value` with `font-bold` when
   * selected.
   */
  renderItem?: (option: O, state: { selected: boolean; active: boolean }) => ComponentChildren

  disabled?: boolean
  className?: string
  /** Forwarded onto the trigger button so external <Label htmlFor> works. */
  id?: string
  /**
   * Native HTML title (tooltip) forwarded onto the trigger button.
   * Useful when the combobox has no visible <Label> beside it (e.g. the
   * inline PromptPicker that swaps the active prompt on a feature tab).
   */
  title?: string
}

export function Combobox<O extends ComboboxOption = ComboboxOption>({
  value,
  options,
  onChange,
  placeholder = '请选择',
  searchPlaceholder = '搜索…',
  emptyText = '未找到匹配项',
  unloadedText,
  missingLabel,
  renderItem,
  disabled,
  className,
  id,
  title,
}: ComboboxProps<O>) {
  const open = useSignal(false)
  const query = useSignal('')
  // Index into the *filtered* list of the row that arrow-keys / Enter
  // currently target. Re-anchored on open and clamped on filter changes.
  const highlight = useSignal(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Filter haystack. Consumer-provided `searchText` wins entirely.
  // Otherwise we lowercase value + label so typing either matches.
  const haystack = (o: O): string => {
    if (o.searchText !== undefined) return o.searchText.toLowerCase()
    const v = o.value.toLowerCase()
    if (o.label && o.label !== o.value) return `${v} ${o.label.toLowerCase()}`
    return v
  }

  // Substring match, case-insensitive. Empty query passes the full list
  // through so the popover doubles as a plain dropdown for users who'd
  // rather scroll than type.
  const q = query.value.trim().toLowerCase()
  const filtered = q ? options.filter(o => haystack(o).includes(q)) : options

  const selectedOption = options.find(o => o.value === value)
  const showMissing = !!value && !selectedOption && !!missingLabel

  // Trigger label prefers the matched option's `label` so a friendly
  // display name (e.g. "OpenAI: GPT-4o") wins over the raw id when one
  // is provided.
  const triggerLabel = selectedOption?.label ?? value

  // Reset cursor to the top of the list whenever the filter changes —
  // otherwise typing `gpt` after navigating to row 7 leaves the highlight
  // pointing at a row that no longer matches the user's mental model.
  useEffect(() => {
    highlight.value = 0
  }, [query.value])

  // Clamp highlight when the option set shrinks (filter narrows or a
  // /models refetch returns a shorter list).
  useEffect(() => {
    if (filtered.length === 0) {
      highlight.value = 0
    } else if (highlight.value >= filtered.length) {
      highlight.value = filtered.length - 1
    }
  }, [filtered.length])

  // On open: clear stale query, focus input, anchor highlight on the
  // currently selected option so arrow-keys move *from* the user's
  // existing pick rather than always starting from the top.
  // On close: clear filter so a re-open starts fresh.
  useEffect(() => {
    if (open.value) {
      inputRef.current?.focus()
      const idx = options.findIndex(o => o.value === value)
      highlight.value = idx >= 0 ? idx : 0
    } else {
      query.value = ''
      highlight.value = 0
    }
  }, [open.value])

  // Outside-click and Escape are handled by <Popover>/<PopoverContent>, so
  // the Combobox no longer wires its own document listeners.

  // Keep the highlighted option visible while keyboard-navigating a long
  // list. `block: 'nearest'` so we don't jerk the scroll position around
  // when the row is already in view.
  useEffect(() => {
    if (!open.value) return
    const item = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight.value}"]`)
    item?.scrollIntoView({ block: 'nearest' })
  }, [highlight.value, open.value])

  const select = (v: string) => {
    onChange(v)
    open.value = false
  }

  const onTriggerKeyDown = (e: KeyboardEvent) => {
    // Enter / Space already toggle via the native button click that
    // PopoverTrigger hooks; only ArrowDown (which fires no click) needs to
    // open the list here. A disabled <button> receives no keydown at all.
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      open.value = true
    }
  }

  const onInputKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (filtered.length > 0) {
        highlight.value = Math.min(highlight.value + 1, filtered.length - 1)
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      highlight.value = Math.max(highlight.value - 1, 0)
    } else if (e.key === 'Home') {
      e.preventDefault()
      highlight.value = 0
    } else if (e.key === 'End') {
      e.preventDefault()
      if (filtered.length > 0) highlight.value = filtered.length - 1
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = filtered[highlight.value]
      if (item) select(item.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      open.value = false
    } else if (e.key === 'Tab') {
      // Don't preventDefault — let Tab move focus naturally; just close
      // so the popover doesn't stay floating over whatever the user
      // tabs to next.
      open.value = false
    }
  }

  return (
    <Popover
      open={open.value}
      onOpenChange={v => {
        open.value = v
      }}
      // `block` overrides the Popover wrapper's default `inline-block` so the
      // combobox keeps the block / flex-1 sizing it gets from `className`.
      className={cn('block', className)}
    >
      <PopoverTrigger>
        <button
          type='button'
          id={id}
          title={title}
          disabled={disabled}
          onKeyDown={onTriggerKeyDown}
          aria-haspopup='listbox'
          aria-expanded={open.value}
          // Match Input's vertical metrics so a Combobox sitting inside
          // ROW_CLASS lines up with sibling inputs/buttons instead of
          // floating a hairline above or below them.
          class={cn(
            'box-border w-full',
            'flex items-center justify-between gap-1',
            'min-h-5 py-px pr-1 pl-1.5',
            'rounded border border-ga4 border-solid',
            'bg-bg1 text-left text-inherit leading-none',
            'cursor-pointer disabled:cursor-not-allowed disabled:opacity-60',
            'outline-none transition',
            'focus:border-brand',
            open.value && 'border-brand'
          )}
        >
          <span class={cn('flex-1 truncate leading-tight', !value && 'text-ga5')}>{triggerLabel || placeholder}</span>
          {/* size/stroke explicit because Tabler's defaults (24/2) are too
              chunky here — we want the chevron to read as a hint, not an
              anchor, on a 20-px-tall trigger. */}
          <IconChevronDown
            size={12}
            aria-hidden='true'
            class={cn('shrink-0 transition-transform', open.value && 'rotate-180')}
          />
        </button>
      </PopoverTrigger>

      {/* matchTriggerWidth stretches the dropdown to the trigger, replacing
          the old `left-0 right-0` now that the content is position:fixed. */}
      <PopoverContent side='bottom' align='start' matchTriggerWidth>
        <div class='p-1'>
          <input
            ref={inputRef}
            type='text'
            placeholder={searchPlaceholder}
            value={query.value}
            onInput={e => {
              query.value = e.currentTarget.value
            }}
            onKeyDown={onInputKeyDown}
            class={cn(
              'box-border w-full',
              'px-1 py-px',
              'rounded border border-ga4 border-solid',
              'bg-bg1 text-inherit',
              'min-h-5 leading-none outline-none',
              'focus:border-brand'
            )}
          />
        </div>

        <Separator />

        <div ref={listRef} role='listbox' class='max-h-50 overflow-y-auto'>
          {options.length === 0 && !showMissing ? (
            // Pre-fetch case: the user hasn't loaded any options yet.
            // Use unloadedText if the consumer supplied one (e.g.
            // "请先点击「刷新」"), else fall back to the generic empty
            // text so we still say *something*.
            <div class='px-2 py-1 text-ga5'>{unloadedText ?? emptyText}</div>
          ) : filtered.length === 0 && !showMissing ? (
            <div class='px-2 py-1 text-ga5'>{emptyText}</div>
          ) : (
            filtered.map((opt, i) => {
              const selected = opt.value === value
              const active = i === highlight.value
              return (
                <button
                  key={opt.value}
                  type='button'
                  role='option'
                  aria-selected={selected}
                  data-idx={i}
                  title={opt.label ?? opt.value}
                  onMouseEnter={() => {
                    highlight.value = i
                  }}
                  onClick={() => select(opt.value)}
                  class={cn(
                    'box-border w-full',
                    'flex items-start gap-2',
                    'px-2 py-1',
                    'border-none bg-transparent',
                    'text-left text-inherit leading-tight',
                    'cursor-pointer',
                    // Mouse-hover and keyboard-highlight both drive the
                    // same `active` state so the visible "where am I"
                    // signal never disagrees between input modalities.
                    active && 'bg-ga1s'
                  )}
                >
                  {/* min-w-0 lets the inner content respect break-all
                      even though it sits inside a flex row; without
                      it long ids would force the parent button wider
                      than the popover. */}
                  <div class='min-w-0 flex-1'>
                    {renderItem ? (
                      renderItem(opt, { selected, active })
                    ) : (
                      <span class={cn('block truncate', selected && 'font-bold')}>{opt.label ?? opt.value}</span>
                    )}
                  </div>
                  <IconCheck
                    size={12}
                    aria-hidden='true'
                    // Reserve the slot even for unselected rows
                    // (invisible, not hidden) so the option
                    // content doesn't shift horizontally as the
                    // selection moves between rows.
                    class={cn('mt-0.5 shrink-0', !selected && 'invisible')}
                  />
                </button>
              )
            })
          )}

          {showMissing && (
            <>
              {/* Pin the sentinel below the live list with a divider
                  so it reads as a separate cluster. Static informational
                  row — not a real listbox option. We deliberately drop
                  role='option' so screen readers don't announce it as
                  selectable; the user can't pick it (it's already what's
                  selected) and clicking does nothing. */}
              <Separator />
              <div
                title={value}
                class={cn(
                  'box-border w-full',
                  'flex items-start gap-2',
                  'px-2 py-1',
                  'text-left text-ga6 leading-tight'
                )}
              >
                <span class='flex-1 break-all'>{missingLabel(value)}</span>
                <IconCheck size={12} aria-hidden='true' class='mt-0.5 shrink-0' />
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
