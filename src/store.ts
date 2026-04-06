import { effect, signal } from '@preact/signals'

import { GM_getValue, GM_setValue } from '$'

function gmSignal<T>(key: string, defaultValue: T) {
  const s = signal<T>(GM_getValue(key, defaultValue))
  effect(() => GM_setValue(key, s.value))
  return s
}

// GM-persisted settings
export const msgSendInterval = gmSignal('msgSendInterval', 1)
export const maxLength = gmSignal('maxLength', 20)
export const maxLogLines = gmSignal('maxLogLines', 1000)
export const randomColor = gmSignal('randomColor', false)
export const randomInterval = gmSignal('randomInterval', false)
export const randomChar = gmSignal('randomChar', false)
export const aiEvasion = gmSignal('aiEvasion', false)
export const forceScrollDanmaku = gmSignal('forceScrollDanmaku', false)
export const optimizeLayout = gmSignal('optimizeLayout', false)
export const danmakuDirectMode = gmSignal('danmakuDirectMode', true)
export const danmakuDirectConfirm = gmSignal('danmakuDirectConfirm', false)
export const activeTab = gmSignal('activeTab', 'dulunche')
export const msgTemplates = gmSignal<string[]>('MsgTemplates', [])
export const activeTemplateIndex = gmSignal('activeTemplateIndex', 0)
export const logPanelOpen = gmSignal('logPanelOpen', false)

// Soniox settings
export const sonioxApiKey = gmSignal('sonioxApiKey', '')
export const sonioxLanguageHints = gmSignal<string[]>('sonioxLanguageHints', ['zh'])
export const sonioxAutoSend = gmSignal('sonioxAutoSend', true)
export const sonioxMaxLength = gmSignal('sonioxMaxLength', 40)
export const sonioxTranslationEnabled = gmSignal('sonioxTranslationEnabled', false)
export const sonioxTranslationTarget = gmSignal('sonioxTranslationTarget', 'en')

// Replacement rules
export const replacementRules = gmSignal<Array<{ from?: string; to?: string }>>('replacementRules', [])
export const remoteKeywords = gmSignal<{
  global?: { keywords?: Record<string, string> }
  rooms?: Array<{ room: string; keywords?: Record<string, string> }>
} | null>('remoteKeywords', null)
export const remoteKeywordsLastSync = gmSignal<number | null>('remoteKeywordsLastSync', null)

// Runtime state (not GM-persisted)
export const dialogOpen = signal(false)
export const sendMsg = signal(false)
export const cachedRoomId = signal<number | null>(null)
export const cachedStreamerUid = signal<number | null>(null)
export const availableDanmakuColors = signal<string[] | null>(null)
export const replacementMap = signal<Map<string, string> | null>(null)

// Fasong tab shared text
export const fasongText = signal('')

// Shared log
export const logLines = signal<string[]>([])

export function appendLog(message: string): void {
  const max = maxLogLines.value
  const lines = logLines.value
  const next = lines.length >= max ? [...lines.slice(lines.length - max + 1), message] : [...lines, message]
  logLines.value = next
}
