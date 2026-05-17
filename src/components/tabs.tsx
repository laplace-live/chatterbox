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
    <div class='mb-1.25 flex gap-1 border-b border-b-ga2 border-b-solid px-1'>
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
              '-mb-px cursor-pointer bg-transparent px-2 py-1',
              // Native <button> ships with a UA border. Zero-out top/x and
              // explicitly draw a 1px solid bottom border whose color we
              // toggle below — keeps the active-tab underline aligned with
              // the container's own bottom border (offset by mb-[-1px]).
              'border-x-0 border-t-0 border-b border-b-solid',
              isActive ? 'border-b-brand font-bold' : 'border-b-transparent font-normal'
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
