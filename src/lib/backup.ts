import { GM_getValue, GM_setValue } from '$'
import { applyImportedSettings, isValidImportedValue } from './gm-signal'

const BACKUP_VERSION = 1

// All GM-persisted keys that are safe to export. Migration flags are excluded.
const EXPORT_KEYS = [
  // Send
  'msgSendInterval',
  'maxLength',
  'randomColor',
  'randomInterval',
  'randomChar',
  'aiEvasion',
  'forceScrollDanmaku',
  'optimizeLayout',
  'danmakuDirectMode',
  'danmakuDirectConfirm',
  'danmakuDirectAlwaysShow',
  // Templates
  'MsgTemplates',
  'activeTemplateIndex',
  'persistSendState',
  // Auto-blend
  'autoBlendWindowSec',
  'autoBlendThreshold',
  'autoBlendCooldownSec',
  'autoBlendCooldownAuto',
  'autoBlendRoutineIntervalSec',
  'autoBlendBurstSettleMs',
  'autoBlendRateLimitWindowMin',
  'autoBlendRateLimitStopThreshold',
  'autoBlendPreset',
  'lastAppliedPresetBaseline',
  'autoBlendAdvancedOpen',
  'autoBlendDryRun',
  // 'autoBlendAvoidRisky'、'autoBlendBlockedWords' — 已废除，生产代码不读，
  // 留在 GM 存储是死字段。老备份里若包含会进入 unknownKeys 列表被静默忽略。
  // 'autoBlendIncludeReply' — 已废除（@ 回复一律不跟），不再导入/导出。
  'autoBlendUseReplacements',
  'autoBlendAvoidRepeat',
  'autoBlendRequireDistinctUsers',
  'autoBlendMinDistinctUsers',
  'autoBlendSendCount',
  'autoBlendUserBlacklist',
  'autoBlendSendAllTrending',
  'autoBlendMessageBlacklist',
  // AI 润色（原 YOLO；LLM 文本改写）开关 + 提示词。LLM 凭证(provider/key/model/baseURL)
  // 复用 hzm-* 那一份,backup-section 已有覆盖,这里不重复。
  // GM key 名仍带 `Yolo` 以保持向后兼容,无需迁移。
  'autoBlendYolo',
  'autoSendYolo',
  'normalSendYolo',
  'llmPromptsGlobal',
  'llmActivePromptGlobal',
  'llmPromptsNormalSend',
  'llmActivePromptNormalSend',
  'llmPromptsAutoBlend',
  'llmActivePromptAutoBlend',
  'llmPromptsAutoSend',
  'llmActivePromptAutoSend',
  // Custom chat
  'customChatEnabled',
  'customChatHideNative',
  'customChatUseWs',
  'customChatTheme',
  'customChatShowDanmaku',
  'customChatShowGift',
  'customChatShowSuperchat',
  'customChatShowEnter',
  'customChatShowNotice',
  'customChatCss',
  'customChatPerfDebug',
  // Guard room — note: guardRoomSyncKey 是 Bearer 凭证，不进 backup（跟 LLM
  // 凭证同策略，避免用户分享备份时无意识泄漏 token）。persist toggle 进 backup
  // 以保留用户偏好。
  'guardRoomEndpoint',
  'guardRoomSyncKeyPersist',
  'guardRoomWebsiteControlEnabled',
  // UI panel state
  'logPanelOpen',
  'autoSendPanelOpen',
  'autoBlendPanelOpen',
  'memesPanelOpen',
  // STT — sonioxApiKey 是凭证，不进 backup（同上）。
  'sonioxApiKeyPersist',
  'sonioxLanguageHints',
  'sonioxAutoSend',
  'sonioxMaxLength',
  'sonioxWrapBrackets',
  'sonioxTranslationEnabled',
  'sonioxTranslationTarget',
  // Replacement rules
  'localGlobalRules',
  'localRoomRules',
  // Log
  'maxLogLines',
  // Confirm TTL — 一并备份，避免恢复后立刻又被弹窗。
  'lastAutoBlendRealFireConfirmAt',
] as const

export function exportSettings(): string {
  const data: Record<string, unknown> = {
    __version: BACKUP_VERSION,
    __exportedAt: new Date().toISOString(),
  }
  for (const key of EXPORT_KEYS) {
    const val = GM_getValue(key)
    if (val !== undefined) data[key] = val
  }
  return JSON.stringify(data, null, 2)
}

export interface ImportSettingsResult {
  ok: boolean
  error?: string
  count: number
  /**
   * Keys that appeared in the backup, were on the allowlist, but were
   * rejected by the per-key validator (typically because the stored type
   * doesn't match the live signal's type). Surfaced so the settings UI can
   * show the user *which* fields didn't survive a corrupt or downgraded
   * backup, instead of a flat "导入了 N 项" with no signal about what was lost.
   */
  skipped?: string[]
  /** Allowlisted keys that arrived but had an unrelated structural issue
   * (e.g. JSON.parse succeeded but the value was wrong shape). Same intent
   * as `skipped`, separated so future tooling can show different copy.
   */
  unknownKeys?: string[]
}

/**
 * Cheap deep-equal for backup values (primitives, arrays, plain objects).
 * Good enough to decide "would overwrite" vs "no-op" without depending on
 * `node:util` or a runtime in the userscript bundle.
 */
function backupValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!backupValueEqual(a[i], b[i])) return false
    }
    return true
  }
  if (typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return false
}

function shortRepr(val: unknown, maxLen = 48): string {
  if (val === undefined) return '（未设置）'
  let s: string
  try {
    s = typeof val === 'string' ? val : JSON.stringify(val)
  } catch {
    s = String(val)
  }
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1)}…`
  return s
}

export interface ImportPreviewChange {
  key: string
  before: string
  after: string
}
export interface ImportPreviewResult {
  ok: boolean
  error?: string
  changes: ImportPreviewChange[]
  unchanged: number
  skipped: string[]
  unknownKeys: string[]
}

/**
 * Parse a backup blob WITHOUT writing anything. Returns the list of fields
 * whose value would change, plus the would-be-skipped / unknown sets. Lets
 * the UI show a diff preview before the user commits a potentially
 * destructive overwrite.
 */
export function previewImportSettings(json: string): ImportPreviewResult {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(json) as Record<string, unknown>
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `无效的 JSON 格式：${detail}`, changes: [], unchanged: 0, skipped: [], unknownKeys: [] }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: '数据格式错误，需要 JSON 对象', changes: [], unchanged: 0, skipped: [], unknownKeys: [] }
  }
  const version = data.__version
  if (typeof version === 'number' && version > BACKUP_VERSION) {
    return {
      ok: false,
      error: `导入版本 ${version} 高于当前支持的版本 ${BACKUP_VERSION}`,
      changes: [],
      unchanged: 0,
      skipped: [],
      unknownKeys: [],
    }
  }
  const allowed = new Set<string>(EXPORT_KEYS)
  const changes: ImportPreviewChange[] = []
  const skipped: string[] = []
  const unknownKeys: string[] = []
  let unchanged = 0
  for (const [key, val] of Object.entries(data)) {
    if (key.startsWith('__')) continue
    if (!allowed.has(key)) {
      unknownKeys.push(key)
      continue
    }
    if (!isValidImportedValue(key, val)) {
      skipped.push(key)
      continue
    }
    const current = GM_getValue(key)
    if (backupValueEqual(current, val)) {
      unchanged += 1
      continue
    }
    changes.push({ key, before: shortRepr(current), after: shortRepr(val) })
  }
  return { ok: true, changes, unchanged, skipped, unknownKeys }
}

export function importSettings(json: string): ImportSettingsResult {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(json) as Record<string, unknown>
  } catch (err) {
    // Surface the parser's own diagnostic (`Unexpected token … at position N`)
    // instead of a flat "无效的 JSON 格式". For a hand-edited backup this
    // narrows the user's search to the offending line.
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `无效的 JSON 格式：${detail}`, count: 0 }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: '数据格式错误，需要 JSON 对象', count: 0 }
  }
  // Reject backups produced by a newer schema we don't understand. Backups
  // missing __version are accepted (legacy export).
  const version = data.__version
  if (typeof version === 'number' && version > BACKUP_VERSION) {
    return { ok: false, error: `导入版本 ${version} 高于当前支持的版本 ${BACKUP_VERSION}`, count: 0 }
  }
  const allowed = new Set<string>(EXPORT_KEYS)
  const toApply: Record<string, unknown> = {}
  const skipped: string[] = []
  const unknownKeys: string[] = []
  let count = 0
  for (const [key, val] of Object.entries(data)) {
    if (key.startsWith('__')) continue
    if (!allowed.has(key)) {
      unknownKeys.push(key)
      continue
    }
    // Drop entries whose imported value doesn't match the in-memory shape.
    // Without this, a malformed backup could write `msgSendInterval = "5"`
    // and break the auto-send loop until the user resets the setting.
    if (!isValidImportedValue(key, val)) {
      skipped.push(key)
      continue
    }
    GM_setValue(key, val)
    toApply[key] = val
    count++
  }
  applyImportedSettings(toApply)
  return {
    ok: true,
    count,
    skipped: skipped.length > 0 ? skipped : undefined,
    unknownKeys: unknownKeys.length > 0 ? unknownKeys : undefined,
  }
}
