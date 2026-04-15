import { effect, signal } from '@preact/signals'

import type { BilibiliEmoticonPackage } from './types'

import { GM_deleteValue, GM_getValue, GM_setValue } from '$'

function gmSignal<T>(key: string, defaultValue: T) {
  const s = signal<T>(GM_getValue(key, defaultValue))
  effect(() => GM_setValue(key, s.value))
  return s
}

// GM-persisted settings
export const msgSendInterval = gmSignal('msgSendInterval', 1)
export const maxLength = gmSignal('maxLength', 38)
export const maxLogLines = gmSignal('maxLogLines', 1000)
export const randomColor = gmSignal('randomColor', false)
export const randomInterval = gmSignal('randomInterval', false)
export const randomChar = gmSignal('randomChar', false)
export const aiEvasion = gmSignal('aiEvasion', false)
export const forceScrollDanmaku = gmSignal('forceScrollDanmaku', false)
export const optimizeLayout = gmSignal('optimizeLayout', false)
export const danmakuDirectMode = gmSignal('danmakuDirectMode', true)
export const danmakuDirectConfirm = gmSignal('danmakuDirectConfirm', false)
export const danmakuDirectAlwaysShow = gmSignal('danmakuDirectAlwaysShow', false)
export const unlockForbidLive = gmSignal('unlockForbidLive', true)
export const activeTab = gmSignal('activeTab', 'fasong')
export const msgTemplates = gmSignal<string[]>('MsgTemplates', [])
export const activeTemplateIndex = gmSignal('activeTemplateIndex', 0)
export const logPanelOpen = gmSignal('logPanelOpen', false)
export const autoSendPanelOpen = gmSignal('autoSendPanelOpen', true)
export const normalSendPanelOpen = gmSignal('normalSendPanelOpen', true)
export const memesPanelOpen = gmSignal('memesPanelOpen', true)
export const dialogOpen = gmSignal('dialogOpen', false)

// Soniox settings
export const sonioxApiKey = gmSignal('sonioxApiKey', '')
export const sonioxLanguageHints = gmSignal<string[]>('sonioxLanguageHints', ['zh'])
export const sonioxAutoSend = gmSignal('sonioxAutoSend', true)
export const sonioxMaxLength = gmSignal('sonioxMaxLength', 40)
export const sonioxTranslationEnabled = gmSignal('sonioxTranslationEnabled', false)
export const sonioxTranslationTarget = gmSignal('sonioxTranslationTarget', 'en')

// Migrate legacy flat replacementRules → localGlobalRules (one-time, then delete old key)
;(() => {
  const old = GM_getValue<Array<{ from?: string; to?: string }>>('replacementRules', [])
  if (old.length > 0) {
    const existing = GM_getValue<Array<{ from?: string; to?: string }>>('localGlobalRules', [])
    if (existing.length === 0) {
      GM_setValue('localGlobalRules', old)
    }
    GM_deleteValue('replacementRules')
  }
})()

// Replacement rules
export const localGlobalRules = gmSignal<Array<{ from?: string; to?: string }>>('localGlobalRules', [])
export const localRoomRules = gmSignal<Record<string, Array<{ from?: string; to?: string }>>>('localRoomRules', {})
export const remoteKeywords = gmSignal<{
  global?: { keywords?: Record<string, string> }
  rooms?: Array<{ room: string; keywords?: Record<string, string> }>
} | null>('remoteKeywords', null)
export const remoteKeywordsLastSync = gmSignal<number | null>('remoteKeywordsLastSync', null)

export const persistSendState = gmSignal<Record<string, boolean>>('persistSendState', {})

// Runtime state (not GM-persisted)
export const sendMsg = signal(false)
export const cachedRoomId = signal<number | null>(null)

let sendStateRestored = false

effect(() => {
  const persist = persistSendState.value
  const roomId = cachedRoomId.value
  const sending = sendMsg.value
  if (roomId === null) return
  const key = String(roomId)
  if (persist[key]) {
    if (!sendStateRestored) {
      sendStateRestored = true
      const stored = GM_getValue<Record<string, boolean>>('persistedSendMsg', {})
      if (stored[key]) {
        sendMsg.value = true
        appendLog('🔄 已恢复独轮车运行状态')
      }
      return
    }
    const stored = GM_getValue<Record<string, boolean>>('persistedSendMsg', {})
    GM_setValue('persistedSendMsg', { ...stored, [key]: sending })
  } else {
    const stored = GM_getValue<Record<string, boolean>>('persistedSendMsg', {})
    if (key in stored) {
      const { [key]: _, ...rest } = stored
      GM_setValue('persistedSendMsg', rest)
    }
  }
})

export const cachedStreamerUid = signal<number | null>(null)
export const availableDanmakuColors = signal<string[] | null>(null)
export const replacementMap = signal<Map<string, string> | null>(null)

export const cachedEmoticonPackages = signal<BilibiliEmoticonPackage[]>([])

export function isEmoticonUnique(msg: string): boolean {
  return cachedEmoticonPackages.value.some(pkg => pkg.emoticons.some(e => e.emoticon_unique === msg))
}

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
