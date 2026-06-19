import { GM_deleteValue, GM_getValue, GM_listValues, GM_setValue } from '$'
import { VERSION } from './version'

/** Schema version of the export file format itself. Bumped only if the
 *  structure changes in a non-backwards-compatible way. */
const FILE_VERSION = 1
const FILE_PREFIX = 'laplace-chatterbox-settings'

export interface SettingsFile {
  version: number
  /** Userscript version that produced this file (informational only). */
  scriptVersion: string
  exportedAt: string
  data: Record<string, unknown>
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// Filesystem-safe local timestamp, e.g. "2026-05-01-23-43-00". We avoid
// `:` because Windows / macOS Finder reject it in filenames, and we use
// the local clock so the filename matches what the user just clicked.
function buildTimestamp(d = new Date()): string {
  return [
    d.getFullYear(),
    pad2(d.getMonth() + 1),
    pad2(d.getDate()),
    pad2(d.getHours()),
    pad2(d.getMinutes()),
    pad2(d.getSeconds()),
  ].join('-')
}

/**
 * Snapshots every key in GM storage into a JSON file and triggers a browser
 * download named `laplace-chatterbox-settings-<timestamp>.json`. Returns
 * the number of keys written.
 */
export function exportSettings(): number {
  const keys = GM_listValues()
  const data: Record<string, unknown> = {}
  for (const key of keys) {
    data[key] = GM_getValue(key)
  }
  const payload: SettingsFile = {
    version: FILE_VERSION,
    scriptVersion: VERSION,
    exportedAt: new Date().toISOString(),
    data,
  }
  const json = JSON.stringify(payload, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${FILE_PREFIX}-${buildTimestamp()}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return keys.length
}

/**
 * Validates that `text` is a JSON-encoded SettingsFile and returns the
 * parsed value. Throws with a user-facing message if malformed.
 */
export function parseSettingsFile(text: string): SettingsFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('设置文件格式无效')
  }
  const obj = parsed as Record<string, unknown>
  const data = obj.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('设置文件缺少 data 字段')
  }
  return {
    version: typeof obj.version === 'number' ? obj.version : 0,
    scriptVersion: typeof obj.scriptVersion === 'string' ? obj.scriptVersion : '',
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
    data: data as Record<string, unknown>,
  }
}

/**
 * Replaces every value in GM storage with the contents of `file`. Keys that
 * exist in storage but not in `file.data` are deleted so the import acts as
 * a full restore (rather than a merge). Reactive signals from `gmSignal`
 * are *not* updated in place — callers are expected to reload the page
 * after applying so the signals re-initialise from the freshly written GM
 * values.
 */
export function applySettingsFile(file: SettingsFile): { imported: number; cleared: number } {
  const before = GM_listValues()
  const incoming = new Set(Object.keys(file.data))
  let cleared = 0
  for (const key of before) {
    if (!incoming.has(key)) {
      GM_deleteValue(key)
      cleared++
    }
  }
  let imported = 0
  for (const [key, value] of Object.entries(file.data)) {
    GM_setValue(key, value)
    imported++
  }
  return { imported, cleared }
}
