import { useSignal } from '@preact/signals'
import { IconCheck, IconChevronDown } from '@tabler/icons-preact'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

import { cn } from '../../lib/cn'

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
}: ComboboxProps<O>) {
  const open = useSignal(false)
  const query = useSignal('')
  // Index into the *filtered* list of the row that arrow-keys / Enter
  // currently target. Re-anchored on open and clamped on filter changes.
  const highlight = useSignal(0)

  const wrapperRef = useRef<HTMLDivElement>(null)
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

  // Outside-click / Escape closes the popover. mousedown (not click) so a
  // gesture that ends in a drag-select doesn't swallow the close — the
  // close decision is made the moment the user presses outside, not when
  // they release.
  useEffect(() => {
    if (!open.value) return
    const onDoc = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        open.value = false
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') open.value = false
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open.value])

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
    if (disabled) return
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
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
    <div ref={wrapperRef} class={cn('lc:relative', className)}>
      <button
        type='button'
        id={id}
        disabled={disabled}
        onClick={() => {
          if (disabled) return
          open.value = !open.value
        }}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup='listbox'
        aria-expanded={open.value}
        // Match Input's vertical metrics so a Combobox sitting inside
        // ROW_CLASS lines up with sibling inputs/buttons instead of
        // floating a hairline above or below them.
        class={cn(
          'lc:w-full lc:box-border',
          'lc:flex lc:items-center lc:justify-between lc:gap-1',
          'lc:pl-1.5 lc:pr-1 lc:py-px lc:min-h-5',
          'lc:border lc:border-solid lc:border-ga4 lc:rounded',
          'lc:bg-bg1 lc:text-inherit lc:text-left lc:leading-none',
          'lc:cursor-pointer lc:disabled:cursor-not-allowed lc:disabled:opacity-60',
          'lc:outline-none lc:transition',
          'lc:focus:border-brand',
          open.value && 'lc:border-brand'
        )}
      >
        <span class={cn('lc:flex-1 lc:truncate lc:leading-tight', !value && 'lc:text-ga5')}>
          {triggerLabel || placeholder}
        </span>
        {/* size/stroke explicit because Tabler's defaults (24/2) are too
            chunky here — we want the chevron to read as a hint, not an
            anchor, on a 20-px-tall trigger. */}
        <IconChevronDown
          size={12}
          aria-hidden='true'
          class={cn('lc:shrink-0 lc:transition-transform', open.value && 'lc:rotate-180')}
        />
      </button>

      {open.value && (
        <div
          role='dialog'
          class={cn(
            // top-full anchors below the trigger; left/right 0 stretch
            // the popover to the wrapper's full width so long ids have
            // room to breathe.
            'lc:absolute lc:left-0 lc:right-0 lc:top-full lc:mt-1 lc:z-50',
            'lc:border lc:border-solid lc:border-ga3 lc:rounded',
            'lc:bg-bg1',
            'lc:shadow-[0_4px_12px_rgba(0,0,0,.15)]',
            'lc:overflow-hidden'
          )}
        >
          <div class='lc:p-1 lc:border-b lc:border-b-solid lc:border-b-ga2'>
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
                'lc:w-full lc:box-border',
                'lc:px-1 lc:py-px',
                'lc:border lc:border-solid lc:border-ga4 lc:rounded',
                'lc:bg-bg1 lc:text-inherit',
                'lc:outline-none lc:leading-none lc:min-h-5',
                'lc:focus:border-brand'
              )}
            />
          </div>

          <div ref={listRef} role='listbox' class='lc:max-h-[200px] lc:overflow-y-auto'>
            {options.length === 0 && !showMissing ? (
              // Pre-fetch case: the user hasn't loaded any options yet.
              // Use unloadedText if the consumer supplied one (e.g.
              // "请先点击「刷新」"), else fall back to the generic empty
              // text so we still say *something*.
              <div class='lc:px-2 lc:py-1 lc:text-ga5'>{unloadedText ?? emptyText}</div>
            ) : filtered.length === 0 && !showMissing ? (
              <div class='lc:px-2 lc:py-1 lc:text-ga5'>{emptyText}</div>
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
                      'lc:w-full lc:box-border',
                      'lc:flex lc:items-start lc:gap-2',
                      'lc:px-2 lc:py-1',
                      'lc:bg-transparent lc:border-none',
                      'lc:text-left lc:text-inherit lc:leading-tight',
                      'lc:cursor-pointer',
                      // Mouse-hover and keyboard-highlight both drive the
                      // same `active` state so the visible "where am I"
                      // signal never disagrees between input modalities.
                      active && 'lc:bg-ga1s'
                    )}
                  >
                    {/* min-w-0 lets the inner content respect break-all
                        even though it sits inside a flex row; without
                        it long ids would force the parent button wider
                        than the popover. */}
                    <div class='lc:flex-1 lc:min-w-0'>
                      {renderItem ? (
                        renderItem(opt, { selected, active })
                      ) : (
                        // Default render: single-line label, bold when
                        // selected. break-all (not truncate) so a 60-char
                        // id like `meta-llama/Llama-3.1-405B-Instruct-FP8`
                        // wraps and stays fully readable.
                        <span class={cn('lc:block lc:break-all', selected && 'lc:font-bold')}>
                          {opt.label ?? opt.value}
                        </span>
                      )}
                    </div>
                    <IconCheck
                      size={12}
                      aria-hidden='true'
                      // Reserve the slot even for unselected rows
                      // (lc:invisible, not lc:hidden) so the option
                      // content doesn't shift horizontally as the
                      // selection moves between rows.
                      class={cn('lc:shrink-0 lc:mt-0.5', !selected && 'lc:invisible')}
                    />
                  </button>
                )
              })
            )}

            {showMissing && (
              // Static informational row — not a real listbox option.
              // We deliberately drop role='option' so screen readers
              // don't announce it as selectable; the user can't pick it
              // (it's already what's selected) and clicking does
              // nothing.
              <div
                title={value}
                class={cn(
                  'lc:w-full lc:box-border',
                  'lc:flex lc:items-start lc:gap-2',
                  'lc:px-2 lc:py-1',
                  // Pin the sentinel below the live list with a top
                  // divider so it reads as a separate cluster.
                  'lc:border-t lc:border-t-solid lc:border-t-ga2',
                  'lc:text-left lc:text-inherit lc:leading-tight lc:text-ga6'
                )}
              >
                <span class='lc:flex-1 lc:break-all'>{missingLabel(value)}</span>
                <IconCheck size={12} aria-hidden='true' class='lc:shrink-0 lc:mt-0.5' />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
