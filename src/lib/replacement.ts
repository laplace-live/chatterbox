import {
  cachedRoomId,
  localGlobalRules,
  localRoomRules,
  remoteKeywords,
  remoteRulesEnabled,
  replacementMap,
} from './store'

/**
 * Builds the replacement map from remote and local rules.
 * Priority: remote global < remote room < local global < local room.
 */
export function buildReplacementMap(): void {
  const map = new Map<string, string>()

  const rk = remoteRulesEnabled.value ? remoteKeywords.value : null
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

  for (const rule of localGlobalRules.value) {
    if (rule.from) map.set(rule.from, rule.to ?? '')
  }

  const rid = cachedRoomId.value
  if (rid !== null) {
    const roomRules = localRoomRules.value[String(rid)] ?? []
    for (const rule of roomRules) {
      if (rule.from) map.set(rule.from, rule.to ?? '')
    }
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
