import { effect } from '@preact/signals'

import { GM_getValue } from '$'
import { cachedRoomId, localGlobalRules, localRoomRules, remoteKeywords, replacementMap } from './store'

/**
 * 未文档化的"少数派"GM 键。Jobs 式审计后把替换规则的可见 UI 全部砍掉了
 * (云端规则隐形、永远开),个别 power user 想关掉云端规则只用本地的,
 * 给他们一个 escape hatch。没有 UI 入口(Apple 风格的 hidden defaults)。
 */
function isCloudReplacementDisabled(): boolean {
  return GM_getValue<boolean>('disableCloudReplacement', false) === true
}

/**
 * Builds the replacement map from remote and local rules.
 * Priority: remote global < remote room < local global < local room.
 *
 * Skips the write when `cachedRoomId` is mid-resolution (null) so we don't
 * clobber a previously-correct map with one missing the room-specific rules.
 * The effect below re-runs when the room id resolves.
 *
 * 云端规则可被 hidden `disableCloudReplacement` GM 键关掉(默认开)。
 */
export function buildReplacementMap(): void {
  // Touch all 4 signals up-front so the @preact/signals `effect` that wraps
  // this function subscribes to all of them, regardless of which branches
  // the body actually walks. Otherwise, when rid is null we skip the
  // localRoomRules read entirely and a later edit to room rules wouldn't
  // re-fire the effect.
  const rid = cachedRoomId.value
  const rk = remoteKeywords.value
  const localGlobal = localGlobalRules.value
  const localRoom = localRoomRules.value

  if (rid === null && replacementMap.value !== null) return

  const map = new Map<string, string>()

  if (rk && !isCloudReplacementDisabled()) {
    const globalKeywords = rk.global?.keywords ?? {}
    for (const [from, to] of Object.entries(globalKeywords)) {
      if (from) map.set(from, to)
    }

    if (rid !== null) {
      const roomData = rk.rooms?.find(r => String(r.room) === String(rid))
      const roomKeywords = roomData?.keywords ?? {}
      for (const [from, to] of Object.entries(roomKeywords)) {
        if (from) map.set(from, to)
      }
    }
  }

  for (const rule of localGlobal) {
    if (rule.from) map.set(rule.from, rule.to ?? '')
  }

  if (rid !== null) {
    const roomRules = localRoom[String(rid)] ?? []
    for (const rule of roomRules) {
      if (rule.from) map.set(rule.from, rule.to ?? '')
    }
  }

  replacementMap.value = map
}

// Auto-rebuild whenever the cached room id, remote keywords, or local rules
// change. This makes manual `buildReplacementMap()` calls idempotent and
// guarantees the map tracks the active room across SPA navigation. The
// effect's subscriptions come from `buildReplacementMap` reading all four
// signals up-front (see comment inside the function).
effect(() => {
  buildReplacementMap()
})

/**
 * Hard upper bound on the post-replacement string length. Bilibili danmaku
 * have a low character cap (≤ 30 in normal rooms, slightly higher with
 * privileges), so this 4096-char ceiling is roughly 100× the longest message
 * a user could realistically want — it only fires when overlapping rules
 * (e.g. "a" → "aa") cause exponential growth, and is far below any size that
 * would freeze the UI or exhaust GM storage.
 */
export const REPLACEMENT_MAX_OUTPUT_LENGTH = 4096

/**
 * Applies all replacement rules to the given text using the cached map.
 *
 * Bails out early if the output exceeds {@link REPLACEMENT_MAX_OUTPUT_LENGTH}.
 * Without this guard, a user-authored map containing pathological rules
 * (`from` is a substring of its `to`, or two rules form a cycle) can amplify
 * a short input into a multi-megabyte string in a few iterations, freezing
 * the loop and the send queue. The caller still sees a string, just one
 * truncated to the cap — `processMessages` will then chunk it normally.
 */
export function applyReplacements(text: string): string {
  if (replacementMap.value === null) {
    buildReplacementMap()
  }
  let result = text
  for (const [from, to] of (replacementMap.value ?? new Map<string, string>()).entries()) {
    if (!from) continue
    result = result.split(from).join(to)
    if (result.length > REPLACEMENT_MAX_OUTPUT_LENGTH) {
      return result.slice(0, REPLACEMENT_MAX_OUTPUT_LENGTH)
    }
  }
  return result
}
