import { GM_getValue, GM_setValue } from '$'

/** Default values for GM-stored settings (used to init missing keys). */
export const scriptInitVal: Record<string, number | boolean | string | string[]> = {
  msgSendInterval: 1,
  maxLength: 20,
  maxLogLines: 1000,
  randomColor: false,
  randomInterval: false,
  randomChar: false,
  aiEvasion: false,
  forceScrollDanmaku: false,
  sonioxApiKey: '',
  sonioxLanguageHints: ['zh'],
  sonioxAutoSend: true,
  sonioxMaxLength: 40,
  sonioxTranslationEnabled: false,
  sonioxTranslationTarget: 'en',
}

/** Ensures all scriptInitVal keys exist in GM storage. */
export function initGMDefaults(): void {
  for (const key of Object.keys(scriptInitVal)) {
    if (GM_getValue(key) === undefined) {
      GM_setValue(key, scriptInitVal[key])
    }
  }
}

/** Message templates for auto-send (synced with GM 'MsgTemplates'). */
export let MsgTemplates: string[] = []

/** Index of the currently selected template (synced with GM 'activeTemplateIndex'). */
export let activeTemplateIndex = 0

export function setActiveTemplateIndex(value: number): void {
  activeTemplateIndex = value
}

/** Loads MsgTemplates and activeTemplateIndex from GM. Call after initGMDefaults(). */
export function loadPersistedTemplates(): void {
  MsgTemplates = GM_getValue('MsgTemplates', [])
  activeTemplateIndex = GM_getValue('activeTemplateIndex', 0)
}

/** Whether the auto-send loop should be running. */
export let sendMsg = false

export function setSendMsg(value: boolean): void {
  sendMsg = value
}

/** Cached real room ID (number) from Bilibili API. */
export let cachedRoomId: number | null = null

export function setCachedRoomId(value: number | null): void {
  cachedRoomId = value
}

/** Called once when room ID becomes available (e.g. to refresh remote keywords). */
export let onRoomIdReadyCallback: (() => void) | null = null

export function setOnRoomIdReadyCallback(cb: (() => void) | null): void {
  onRoomIdReadyCallback = cb
}

/** Cached replacement map (from buildReplacementMap). Use setReplacementMap() to update. */
export let replacementMap: Map<string, string> | null = null

export function setReplacementMap(map: Map<string, string> | null): void {
  replacementMap = map
}

/** Cached danmaku color hex strings from API (e.g. ['0xe33fff', ...]). */
export let availableDanmakuColors: string[] | null = null

export function setAvailableDanmakuColors(value: string[] | null): void {
  availableDanmakuColors = value
}
