import { cn } from '../lib/cn'
import { activeTab, autoBlendEnabled, sendMsg, sttRunning } from '../lib/store'

const TABS = [
  { id: 'fasong', label: '发送' },
  { id: 'tongchuan', label: '同传' },
  { id: 'settings', label: '设置' },
  { id: 'about', label: '关于' },
] as const

export function Tabs() {
  const current = activeTab.value

  return (
    <div class='lc-flex lc-mb-[5px] lc-px-[10px] lc-gap-1 lc-border-b lc-border-b-solid lc-border-b-ga2'>
      {TABS.map(tab => {
        const isActive = current === tab.id
        return (
          <button
            type='button'
            key={tab.id}
            onClick={() => {
              activeTab.value = tab.id
            }}
            class={cn(
              'lc-py-1 lc-px-3 -lc-mb-px lc-bg-transparent lc-cursor-pointer',
              // Native <button> ships with a UA border. Zero-out top/x and
              // explicitly draw a 1px solid bottom border whose color we
              // toggle below — keeps the active-tab underline aligned with
              // the container's own bottom border (offset by mb-[-1px]).
              'lc-border-x-0 lc-border-t-0 lc-border-b lc-border-b-solid',
              isActive ? 'lc-border-b-brand lc-font-bold' : 'lc-border-b-transparent lc-font-normal'
            )}
          >
            {tab.label}
            {tab.id === 'fasong' && sendMsg.value ? ' 🟢' : ''}
            {tab.id === 'fasong' && autoBlendEnabled.value ? ' 🟣' : ''}
            {tab.id === 'tongchuan' && sttRunning.value ? ' 🔵' : ''}
          </button>
        )
      })}
    </div>
  )
}
