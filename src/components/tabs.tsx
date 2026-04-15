import { activeTab } from '../store'

const TABS = [
  { id: 'fasong', label: '发送' },
  { id: 'tongchuan', label: '同传' },
  { id: 'settings', label: '设置' },
  { id: 'about', label: '关于' },
] as const

export function Tabs() {
  const current = activeTab.value

  return (
    <div
      style={{
        display: 'flex',
        marginBlockEnd: '5px',
        padding: '0 10px',
        gap: '.25em',
        borderBottom: '1px solid var(--Ga2, #ddd)',
      }}
    >
      {TABS.map(tab => (
        <button
          type='button'
          key={tab.id}
          onClick={() => {
            activeTab.value = tab.id
          }}
          style={{
            padding: '.25em .75em',
            marginBottom: '-1px',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            borderBottom: current === tab.id ? '1px solid #36a185' : '1px solid transparent',
            fontWeight: current === tab.id ? 'bold' : 'normal',
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
