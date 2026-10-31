import { computed } from '@preact/signals'

import {
  cachedRoomId,
  localGlobalRules,
  localRoomRules,
  remoteKeywords,
  remoteRulesEnabled,
  replacementMap,
} from './store'

function computeReplacementMap(): Map<string, string> {
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
}

const fallbackReplacementMap = computed(computeReplacementMap)

/** Build the replacement map; priority: remote global < remote room < local global < local room. */
export function buildReplacementMap(): void {
  replacementMap.value = computeReplacementMap()
}

function replaceWithMap(text: string, map: Map<string, string>): string {
  let result = text
  for (const [from, to] of map.entries()) {
    result = result.split(from).join(to)
  }
  return result
}

/** Apply all replacement rules to the text using the cached map. */
export function applyReplacements(text: string): string {
  let map = replacementMap.value
  if (map === null) {
    map = computeReplacementMap()
    replacementMap.value = map
  }
  return replaceWithMap(text, map)
}

/** Pure read-only replacement pass safe for Preact render (never mutates `replacementMap`). */
export function previewReplacements(text: string): string {
  return replaceWithMap(text, replacementMap.value ?? fallbackReplacementMap.value)
}
