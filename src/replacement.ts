import { GM_getValue } from '$'
import { cachedRoomId, replacementMap, setReplacementMap } from './state.js'

/**
 * Builds the replacement map from remote and local rules.
 * Priority: remote global < remote room-specific < local rules.
 */
export function buildReplacementMap(): void {
  const map = new Map<string, string>()

  const remoteKeywords = GM_getValue<{
    global?: { keywords?: Record<string, string> }
    rooms?: Array<{ room: string; keywords?: Record<string, string> }>
  } | null>('remoteKeywords', null)

  if (remoteKeywords) {
    const globalKeywords = remoteKeywords.global?.keywords ?? {}
    for (const [from, to] of Object.entries(globalKeywords)) {
      if (from) map.set(from, to)
    }

    if (cachedRoomId !== null) {
      const roomData = remoteKeywords.rooms?.find(r => String(r.room) === String(cachedRoomId))
      const roomKeywords = roomData?.keywords ?? {}
      for (const [from, to] of Object.entries(roomKeywords)) {
        if (from) map.set(from, to)
      }
    }
  }

  const localRules = GM_getValue<Array<{ from?: string; to?: string }>>('replacementRules', [])
  for (const rule of localRules) {
    if (rule.from) map.set(rule.from, rule.to ?? '')
  }

  setReplacementMap(map)
}

/**
 * Applies all replacement rules to the given text using the cached map.
 */
export function applyReplacements(text: string): string {
  if (replacementMap === null) {
    buildReplacementMap()
  }
  let result = text
  for (const [from, to] of (replacementMap ?? new Map<string, string>()).entries()) {
    result = result.split(from).join(to)
  }
  return result
}
