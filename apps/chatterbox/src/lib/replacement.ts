import { computed } from '@preact/signals'

import { cachedRoomId, localGlobalRules, localRoomRules, remoteKeywords, remoteRulesEnabled } from './store'

/** Active replacement map; priority: remote global < remote room < local global < local room. */
const replacementMap = computed(() => {
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

  return map
})

/** Apply all active replacement rules to `text` (pure and safe for Preact render). */
export function applyReplacements(text: string): string {
  let result = text
  for (const [from, to] of replacementMap.value.entries()) {
    result = result.split(from).join(to)
  }
  return result
}
