import { useSignal } from '@preact/signals'
import { IconCheck, IconChevronUp } from '@tabler/icons-preact'
import { cn } from 'cn'
import { useEffect, useRef } from 'preact/hooks'

import { AUTO_ENGAGE_DELAY_MS } from '../lib/audio-only'
import { type AudioOnlyMode, audioOnlyActive, audioOnlyMode } from '../lib/store'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

interface ModeOption {
  value: AudioOnlyMode
  label: string
  hint: string
}

const MODE_OPTIONS: ModeOption[] = [
  { value: 'off', label: '视频', hint: '正常播放直播画面' },
  { value: 'on', label: '仅音频', hint: '只播放音频，节省约 90% 带宽' },
  {
    value: 'auto',
    label: '自动音频',
    hint: `页面在后台 ${AUTO_ENGAGE_DELAY_MS / 1000} 秒后切换为仅音频，回到前台立即恢复视频`,
  },
]

/**
 * 视频 / 仅音频 / 自动音频 picker.
 * Lives in our DOM, not the player controls: `stopPlayback()` destroys the controller subtree.
 */
export function AudioOnlyModeSelect() {
  const open = useSignal(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Unknown persisted values (hand-edited import) read as 视频, matching `lib/audio-only.ts`.
  const current = MODE_OPTIONS.find(o => o.value === audioOnlyMode.value) ?? MODE_OPTIONS[0]

  // Focus the checked row on open so arrow keys work straight away.
  useEffect(() => {
    if (open.value) listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
  }, [open.value])

  const close = () => {
    open.value = false
    triggerRef.current?.focus()
  }

  const select = (mode: AudioOnlyMode) => {
    audioOnlyMode.value = mode
    close()
  }

  // <Popover> closes on Escape too; handling it here also returns focus to the trigger.
  const onListKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close()
      return
    }
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
    const at = e.target instanceof HTMLElement ? rows.indexOf(e.target) : -1
    const last = rows.length - 1
    let next: number
    switch (e.key) {
      case 'ArrowDown':
        next = at >= last ? 0 : at + 1
        break
      case 'ArrowUp':
        next = at <= 0 ? last : at - 1
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = last
        break
      default:
        return
    }
    e.preventDefault()
    rows[next]?.focus()
  }

  return (
    <Popover open={open.value} onOpenChange={v => (open.value = v)}>
      <PopoverTrigger>
        <button
          ref={triggerRef}
          type='button'
          id='laplace-audio-only-toggle'
          title='播放模式：视频 / 仅音频 / 自动音频'
          aria-haspopup='listbox'
          aria-expanded={open.value}
          class={cn(
            'appearance-none border-none outline-none',
            'cursor-pointer select-none',
            'h-8 rounded px-2 text-white',
            'inline-flex items-center gap-0.5',
            // Pink only while engaged (自动音频 stays gray in the foreground); gray keeps `直播助手` primary.
            audioOnlyActive.value ? 'bg-[#FF6699]' : 'bg-ga6'
          )}
        >
          {current.label}
          <IconChevronUp
            size={14}
            aria-hidden='true'
            class={cn('shrink-0 transition-transform', open.value && 'rotate-180')}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent side='top' align='end' className='w-72 p-1 text-[13px]'>
        <div ref={listRef} role='listbox' aria-label='播放模式' onKeyDown={onListKeyDown} class='select-none'>
          {MODE_OPTIONS.map(opt => {
            const selected = opt.value === current.value
            return (
              <button
                key={opt.value}
                type='button'
                role='option'
                aria-selected={selected}
                onClick={() => select(opt.value)}
                class={cn(
                  'box-border w-full',
                  'flex items-start gap-2',
                  'px-2 py-1.5',
                  'rounded border-none bg-transparent',
                  'text-left text-inherit leading-tight',
                  'cursor-pointer outline-none',
                  'hover:bg-ga1s focus-visible:bg-ga1s'
                )}
              >
                <div class='flex min-w-0 flex-1 flex-col gap-0.5'>
                  <span class={cn(selected && 'font-bold')}>{opt.label}</span>
                  {/* keep-all: CJK wraps at the comma instead of mid-phrase. */}
                  <span class='break-keep text-[11px] text-ga6'>{opt.hint}</span>
                </div>
                <IconCheck size={12} aria-hidden='true' class={cn('mt-0.5 shrink-0', !selected && 'invisible')} />
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
