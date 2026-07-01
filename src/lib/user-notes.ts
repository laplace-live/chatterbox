/**
 * Per-uid local user notes, keyed by `String(uid)` for stable JSON round-trips.
 * The whole `Record<uid, UserNote>` lives under one GM key so a single signal
 * drives every consumer. Notes are not size-capped. A notes-only export exists
 * alongside the whole-settings export so a curated set can be shared without
 * leaking other config.
 */

import { gmSignal } from './gm-signal'

export interface UserNote {
  /** Free-form note text. May contain newlines. No length limit. */
  note: string
  /** Unix ms timestamp of the last edit. Drives merge-import precedence. */
  updatedAt: number
}

/** UID-keyed note map. Keyed by `String(uid)` so JSON round-trips don't mutate keys. */
export const userNotes = gmSignal<Record<string, UserNote>>('userNotes', {})

/** Read the note for `uid`. Returns null when the uid has no note. */
export function getUserNote(uid: number | string | null | undefined): UserNote | null {
  if (uid === null || uid === undefined) return null
  const key = String(uid)
  const note = userNotes.value[key]
  // `hasOwn` so a uid like `toString`/`__proto__` can't return a prototype method.
  if (!Object.hasOwn(userNotes.value, key)) return null
  return note ?? null
}

/** True if `uid` has a non-empty stored note. Whitespace-only counts as empty. */
export function hasUserNote(uid: number | string | null | undefined): boolean {
  const n = getUserNote(uid)
  return n !== null && n.note.trim().length > 0
}

/**
 * Upsert the note for `uid`. Empty / whitespace-only `note` deletes the
 * entry instead of storing a blank, so the indicator stays accurate.
 */
export function setUserNote(uid: number | string, note: string): void {
  const key = String(uid)
  const trimmed = note.trim()
  if (trimmed.length === 0) {
    deleteUserNote(uid)
    return
  }
  // New object identity so `useEffect`/`computed` consumers fire; mutating in place wouldn't.
  userNotes.value = {
    ...userNotes.value,
    [key]: { note, updatedAt: Date.now() },
  }
}

/** Remove the note for `uid`. No-op when the uid has no note. */
export function deleteUserNote(uid: number | string): void {
  const key = String(uid)
  if (!Object.hasOwn(userNotes.value, key)) return
  const { [key]: _removed, ...rest } = userNotes.value
  userNotes.value = rest
}

// === Import / export ====================================================

/** Notes-only export file format. Bumped only on breaking shape changes. */
const FILE_VERSION = 1
const FILE_PREFIX = 'laplace-chatterbox-user-notes'

export interface UserNotesFile {
  /** Schema version of THIS file format (not the userscript version). */
  version: number
  exportedAt: string
  notes: Record<string, UserNote>
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// Mirrors settings-io.ts's filename timestamp (filesystem-safe, local clock).
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
 * Trigger a browser download of the current notes as JSON; returns the count written.
 * Empty is fine (emits `notes: {}`), so a successful return means the file downloaded.
 */
export function exportUserNotes(): number {
  const notes = userNotes.value
  const payload: UserNotesFile = {
    version: FILE_VERSION,
    exportedAt: new Date().toISOString(),
    notes,
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
  return Object.keys(notes).length
}

/**
 * Parse `text` as a `UserNotesFile`; throws a user-facing message if malformed.
 * Wrong-shape entries are dropped individually rather than rejecting the whole file.
 */
export function parseUserNotesFile(text: string): UserNotesFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('备注文件格式无效')
  }
  const obj = parsed as Record<string, unknown>
  const rawNotes = obj.notes
  if (!rawNotes || typeof rawNotes !== 'object' || Array.isArray(rawNotes)) {
    throw new Error('备注文件缺少 notes 字段')
  }
  const notes: Record<string, UserNote> = {}
  for (const [key, value] of Object.entries(rawNotes as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    const note = typeof v.note === 'string' ? v.note : null
    const updatedAt = typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt) ? v.updatedAt : Date.now()
    if (note === null) continue
    // Skip blank entries: they'd show an indicator but reveal an empty editor.
    if (note.trim().length === 0) continue
    notes[key] = { note, updatedAt }
  }
  return {
    version: typeof obj.version === 'number' ? obj.version : 0,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
    notes,
  }
}

export type UserNotesImportMode = 'merge' | 'replace'

export interface UserNotesImportResult {
  /** Notes added (uid wasn't present before). */
  added: number
  /** Notes overwritten (uid was present and the incoming entry won). */
  updated: number
  /** Notes the incoming file had but were SKIPPED because the local copy was newer. */
  skipped: number
  /** Notes removed from the local store (only in `replace` mode). */
  removed: number
}

/**
 * Apply a parsed notes file to local storage.
 * - `replace`: drop all existing notes and load the file's; `skipped` is always 0.
 * - `merge`: per-uid newest-`updatedAt` wins; local-only entries are preserved.
 */
export function applyUserNotesFile(file: UserNotesFile, mode: UserNotesImportMode): UserNotesImportResult {
  const result: UserNotesImportResult = { added: 0, updated: 0, skipped: 0, removed: 0 }

  if (mode === 'replace') {
    result.removed = Object.keys(userNotes.value).length
    result.added = Object.keys(file.notes).length
    // Clone for fresh object identity so `useEffect` deps fire.
    userNotes.value = { ...file.notes }
    return result
  }

  // merge
  const next = { ...userNotes.value }
  for (const [uid, incoming] of Object.entries(file.notes)) {
    const existing = next[uid]
    if (!existing) {
      next[uid] = incoming
      result.added++
    } else if (incoming.updatedAt > existing.updatedAt) {
      next[uid] = incoming
      result.updated++
    } else {
      result.skipped++
    }
  }
  userNotes.value = next
  return result
}
