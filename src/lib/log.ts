import { signal } from '@preact/signals'

import type { SendDanmakuResult } from './api'

import { gmSignal } from './gm-signal'
import { formatDanmakuError } from './utils'

/** Maximum number of lines kept in the rolling log buffer. */
export const maxLogLines = gmSignal('maxLogLines', 1000)

/** Rolling log buffer surfaced by the LogPanel. */
export const logLines = signal<string[]>([])

/** Appends an entry to the shared log; a send result renders as `✅/❌ label: text，原因：...`. */
export function appendLog(message: string): void
export function appendLog(result: SendDanmakuResult, label: string, display: string): void
export function appendLog(arg: string | SendDanmakuResult, label?: string, display?: string): void {
  const message =
    typeof arg === 'string'
      ? arg
      : arg.cancelled
        ? `⏭ ${label}: ${display}（被手动发送中断）`
        : arg.success
          ? `✅ ${label}: ${display}`
          : `❌ ${label}: ${display}，原因：${formatDanmakuError(arg.error)}`

  const max = maxLogLines.value
  const lines = logLines.value
  const next = lines.length >= max ? [...lines.slice(lines.length - max + 1), message] : [...lines, message]
  logLines.value = next
}
