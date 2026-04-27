import { useEffect, useRef } from 'preact/hooks'

import { logLines, maxLogLines } from '../lib/log'
import { logPanelOpen } from '../lib/store'
import { Textarea } from './ui/textarea'

export function LogPanel() {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [logLines.value])

  return (
    <details
      open={logPanelOpen.value}
      onToggle={e => {
        logPanelOpen.value = e.currentTarget.open
      }}
      style={{ marginTop: '.25em' }}
    >
      <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 'bold' }}>日志</summary>
      <Textarea
        ref={ref}
        readOnly
        value={logLines.value.join('\n')}
        placeholder={`此处将输出日志（最多保留 ${maxLogLines.value} 条）`}
        style={{
          boxSizing: 'border-box',
          height: '60px',
          width: '100%',
          resize: 'vertical',
          marginTop: '.5em',
        }}
      />
    </details>
  )
}
