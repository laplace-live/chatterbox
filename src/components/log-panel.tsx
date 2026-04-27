import { useEffect, useRef } from 'preact/hooks'

import { logLines, maxLogLines } from '../lib/log'
import { logPanelOpen } from '../lib/store'
import { AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Textarea } from './ui/textarea'

export function LogPanel() {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [logLines.value])

  return (
    <AccordionItem
      open={logPanelOpen.value}
      onOpenChange={v => {
        logPanelOpen.value = v
      }}
      style={{ marginTop: '.25em' }}
    >
      <AccordionTrigger>日志</AccordionTrigger>
      <AccordionContent>
        <Textarea
          ref={ref}
          readOnly
          value={logLines.value.join('\n')}
          placeholder={`此处将输出日志（最多保留 ${maxLogLines.value} 条）`}
          style={{ height: '60px', marginTop: '.5em' }}
        />
      </AccordionContent>
    </AccordionItem>
  )
}
