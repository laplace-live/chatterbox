import { cachedRoomId, remoteKeywords, replacementMap, replacementRules } from './store.js'

/**
 * Builds the replacement map from remote and local rules.
 * Priority: remote global < remote room-specific < local rules.
 */
export function buildReplacementMap(): void {
  const map = new Map<string, string>()

  const rk = remoteKeywords.value
  if (rk) {
    const globalKeywords = rk.global?.keywords ?? {}
    for (const [from, to] of Object.entries(globalKeywords)) {
      if (from) map.set(from, to)
    }

    const rid = cachedRoomId.value
    if (rid !== null) {
      const roomData = rk.rooms?.find(r => String(r.room) === String(rid))
      const roomKeywords = roomData?.keywords ?? {}
      for (const [from, to] of Object.entries(roomKeywords)) {
        if (from) map.set(from, to)
      }
    }
  }

  for (const rule of replacementRules.value) {
    if (rule.from) map.set(rule.from, rule.to ?? '')
  }

  replacementMap.value = map
}

/**
 * Applies all replacement rules to the given text using the cached map.
 */
export function applyReplacements(text: string): string {
  if (replacementMap.value === null) {
    buildReplacementMap()
  }
  let result = text
  for (const [from, to] of (replacementMap.value ?? new Map<string, string>()).entries()) {
    result = result.split(from).join(to)
  }
  return result
}
