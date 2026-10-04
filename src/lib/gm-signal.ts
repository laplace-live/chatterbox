import { effect, signal } from '@preact/signals'

import { GM_deleteValue, GM_getValue, GM_setValue } from '$'

/** Signal whose value is read from and persisted to GM storage under `key`. */
export function gmSignal<T>(key: string, defaultValue: T) {
  const s = signal<T>(GM_getValue(key, defaultValue))
  effect(() => GM_setValue(key, s.value))
  return s
}

/**
 * Copy `oldKey` into `newKey` (only if unset), then delete `oldKey`; re-runs if a pre-upgrade backup is re-imported.
 * Call before `gmSignal(newKey, …)`, which persists its default on creation.
 */
export function migrateGmKey(oldKey: string, newKey: string, map: (value: unknown) => unknown = v => v): void {
  const missing = Symbol()
  const oldValue = GM_getValue<unknown>(oldKey, missing)
  if (oldValue === missing) return
  if (GM_getValue<unknown>(newKey, missing) === missing) GM_setValue(newKey, map(oldValue))
  GM_deleteValue(oldKey)
}
