/**
 * Per-uid local user notes.
 *
 * Viewers can attach a free-form, multi-line note to any bilibili UID
 * (typically a streamer, but the storage doesn't care — anything with
 * a uid surface, including the space page, works). Notes are keyed by
 * `String(uid)` so they're stable across number ↔ string drift and
 * round-trip cleanly through JSON.
 *
 * Storage strategy
 * ----------------
 * One GM key holds the entire `Record<uid, UserNote>` so a single
 * reactive signal drives every consumer (info button face indicator,
 * popover editor, future surfaces). This trades per-uid write
 * granularity for trivially simple readers and import/export, which
 * fits a "a few hundred notes at most" workload comfortably.
 *
 * Notes are not size-capped at the API layer — the user explicitly
 * asked for "no length limit, or large enough for general use". GM
 * storage is JSON-serialised under the hood; in practice the
 * userscript host caps payloads in the low MB range, so even 10k
 * notes of a few hundred chars each fit. We don't trim or warn.
 *
 * Import / export
 * ---------------
 * Notes ride along with the existing whole-settings export by virtue
 * of being a plain GM key, but we ALSO ship a notes-only export
 * (`exportUserNotes` / `importUserNotes`) so a viewer can share their
 * curated set without leaking unrelated configuration (LLM keys,
 * blacklists, etc). The notes-only file format is intentionally
 * minimal — just `version`, `exportedAt`, and the `notes` map.
 *
 * Merge semantics on import: callers choose between `replace` (drop
 * everything currently stored and load the file's notes) and `merge`
 * (per-uid newest-`updatedAt` wins). Merge is the default for sharing
 * scenarios where overwriting your own notes would be a footgun.
 */

import { gmSignal } from './gm-signal'

export interface UserNote {
  /** Free-form note text. May contain newlines. No length limit. */
  note: string
  /** Unix ms timestamp of the last edit. Drives merge-import precedence. */
  updatedAt: number
}

/**
 * UID-keyed note map. Keyed by `String(uid)` so JSON round-trips don't
 * mutate the keys (object keys are always strings; explicit stringify
 * makes the intent obvious and protects against numeric coercion bugs
 * if a caller passes a string uid by accident).
 */
export const userNotes = gmSignal<Record<string, UserNote>>('userNotes', {})

/** Read the note for `uid`. Returns null when the uid has no note. */
export function getUserNote(uid: number | string | null | undefined): UserNote | null {
  if (uid === null || uid === undefined) return null
  const key = String(uid)
  const note = userNotes.value[key]
  // `hasOwn` so a uid named `toString` or `__proto__` (degenerate but
  // possible if a malformed import sneaks one in) can't return the
  // prototype method by accident.
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
  // Spread to a new object so the signal's identity changes and
  // downstream `useEffect` / `computed` consumers fire. Mutating the
  // existing object would write to GM storage (via the gmSignal
  // effect) but wouldn't trigger re-renders.
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

// Mirrors settings-io.ts's filename timestamp (filesystem-safe, local
// clock) so a viewer who downloads both files gets a consistent naming
// scheme.
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
 * Trigger a browser download of the current notes as JSON. Returns the
 * number of notes written. No-throw on empty (still emits a file with
 * `notes: {}`), so the caller can rely on a successful return meaning
 * "the file landed in Downloads".
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
 * Validate that `text` is a JSON-encoded `UserNotesFile`. Throws with a
 * user-facing message if malformed. Entries with the wrong shape are
 * silently dropped (rather than rejecting the whole file) so a single
 * corrupted record doesn't block importing the rest.
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
    // Skip blank entries on import too — they'd otherwise pollute the
    // store with indicators that show but reveal an empty editor.
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
 *
 * - `replace`: drop every existing note and load the file's verbatim.
 *   `skipped` is always 0 in this mode.
 * - `merge`: per-uid newest-`updatedAt` wins. Entries newer locally are
 *   skipped; entries newer in the file overwrite. Local-only entries
 *   are preserved. Use this for sharing scenarios where overwriting
 *   your own freshly-written notes with a stale shared file would be
 *   surprising.
 */
export function applyUserNotesFile(file: UserNotesFile, mode: UserNotesImportMode): UserNotesImportResult {
  const result: UserNotesImportResult = { added: 0, updated: 0, skipped: 0, removed: 0 }

  if (mode === 'replace') {
    result.removed = Object.keys(userNotes.value).length
    result.added = Object.keys(file.notes).length
    // Clone so consumers see a fresh object identity (gmSignal effect
    // writes to GM regardless, but `useEffect` deps need reference
    // change to fire).
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
