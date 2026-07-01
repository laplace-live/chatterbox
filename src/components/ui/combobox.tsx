import { useSignal } from '@preact/signals'
import { IconCheck, IconChevronDown } from '@tabler/icons-preact'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

import { cn } from '../../lib/cn'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Separator } from './separator'

/** Minimal contract every Combobox option must satisfy; extend via the generic for `renderItem`. */
export interface ComboboxOption {
  /** Controlled id. Compared against `value` and emitted via `onChange`. */
  value: string
  /** Shown by default in the trigger and in option rows. Defaults to `value`. */
  label?: string
  /** Override the filter haystack; defaults to `value` joined with `label`. */
  searchText?: string
}

/**
 * shadcn-style Combobox: filterable, keyboard-navigable popover list; generic over the option type.
 * @remarks Popover is positioned against the trigger, so opening near an `overflow-hidden` panel's bottom edge can clip it.
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
  /** When `value` isn't in `options`, render a sentinel row using this label to surface a stale selection. */
  missingLabel?: (value: string) => string
  /** Custom rendering for each option row; defaults to a single-line `label ?? value`, bold when selected. */
  renderItem?: (option: O, state: { selected: boolean; active: boolean }) => ComponentChildren

  disabled?: boolean
  className?: string
  /** Forwarded onto the trigger button so external <Label htmlFor> works. */
  id?: string
  /** Native HTML title (tooltip) forwarded onto the trigger button. */
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
  // Index into the *filtered* list; re-anchored on open, clamped on filter changes.
  const highlight = useSignal(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // `searchText` wins entirely; else lowercased value + label.
  const haystack = (o: O): string => {
    if (o.searchText !== undefined) return o.searchText.toLowerCase()
    const v = o.value.toLowerCase()
    if (o.label && o.label !== o.value) return `${v} ${o.label.toLowerCase()}`
    return v
  }

  // Empty query passes the full list so the popover doubles as a plain dropdown.
  const q = query.value.trim().toLowerCase()
  const filtered = q ? options.filter(o => haystack(o).includes(q)) : options

  const selectedOption = options.find(o => o.value === value)
  const showMissing = !!value && !selectedOption && !!missingLabel

  // Prefer the matched option's `label` over the raw id.
  const triggerLabel = selectedOption?.label ?? value

  // Reset cursor on filter change so the highlight can't point at a now-unmatched row.
  useEffect(() => {
    highlight.value = 0
  }, [query.value])

  // Clamp highlight when the option set shrinks.
  useEffect(() => {
    if (filtered.length === 0) {
      highlight.value = 0
    } else if (highlight.value >= filtered.length) {
      highlight.value = filtered.length - 1
    }
  }, [filtered.length])

  // On open: focus input, anchor highlight on the selected option. On close: clear filter.
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

  // Outside-click and Escape are handled by <Popover>, not our own document listeners.

  // Keep the highlighted option visible; `block: 'nearest'` avoids jerking a row already in view.
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
    // Enter/Space toggle via the native button click; only ArrowDown (no click) needs handling.
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
      // No preventDefault: let Tab move focus naturally; just close the popover.
      open.value = false
    }
  }

  return (
    <Popover
      open={open.value}
      onOpenChange={v => {
        open.value = v
      }}
      // `block` overrides the Popover wrapper's default `inline-block` to keep flex-1 sizing.
      className={cn('block min-w-0', className)}
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
          // Match Input's vertical metrics so it lines up with sibling inputs/buttons.
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
          {/* Explicit size: Tabler's defaults (24/2) are too chunky for a 20px-tall trigger. */}
          <IconChevronDown
            size={12}
            aria-hidden='true'
            class={cn('shrink-0 transition-transform', open.value && 'rotate-180')}
          />
        </button>
      </PopoverTrigger>

      {/* matchTriggerWidth stretches the dropdown to the trigger (content is position:fixed). */}
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
            // Pre-fetch (no options yet): unloadedText if supplied, else emptyText.
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
                    // Hover and keyboard share one `active` state so they never disagree.
                    active && 'bg-ga1s'
                  )}
                >
                  {/* min-w-0 lets inner content wrap inside the flex row instead of forcing the button wider. */}
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
                    // invisible (not hidden) reserves the slot so rows don't shift as selection moves.
                    class={cn('mt-0.5 shrink-0', !selected && 'invisible')}
                  />
                </button>
              )
            })
          )}

          {showMissing && (
            <>
              {/* Static informational row; role='option' deliberately dropped so it's not announced as selectable. */}
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
