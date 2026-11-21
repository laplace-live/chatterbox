import { signal } from '@preact/signals'

import type { SceneNote } from './types'

const MAX_NOTES = 20
const MAX_SCENE_CHARS = 60

/** Recent scene notes, oldest first, capped at 20. */
export const sceneNotes = signal<SceneNote[]>([])

/** Append a trimmed note (cut to 60 chars); blank input is ignored. `at` defaults to Date.now(). */
export function recordScene(scene: string, source: SceneNote['source'], at = Date.now()): void {
  // Cut by code point so an emoji is never split into a lone surrogate.
  const text = Array.from(scene.trim()).slice(0, MAX_SCENE_CHARS).join('')
  if (!text) return
  const notes = [...sceneNotes.peek(), { at, scene: text, source }].sort((a, b) => a.at - b.at)
  sceneNotes.value = notes.slice(-MAX_NOTES)
}

/** Newest note whose age (now − at) ≤ maxAgeMs, else null. `now` defaults to Date.now(). */
export function latestScene(maxAgeMs: number, now = Date.now()): SceneNote | null {
  const newest = sceneNotes.value.at(-1)
  return newest && now - newest.at <= maxAgeMs ? newest : null
}

/** Forget every scene note. */
export function clearScenes(): void {
  sceneNotes.value = []
}
