import { describe, expect, test } from 'bun:test'

import { loadWithFakeGm } from '../testing/fake-gm'

const loadStore = (seed: Iterable<readonly [string, unknown]> = []) =>
  loadWithFakeGm<typeof import('./store')>(new URL('./store.ts', import.meta.url), seed)

describe('floatingInputEnabled default and migration', () => {
  test('new users start enabled and minimized', async () => {
    const mod = await loadStore()
    expect(mod.floatingInputEnabled.value).toBe(true)
    expect(mod.floatingInputMinimized.value).toBe(true)
    expect(mod.store.get('floatingInputEnabled')).toBe(true)
    expect(mod.store.get('floatingInputMinimized')).toBe(true)
    expect(mod.store.get('floatingInputDefaultMigrated')).toBe(true)
  })

  test('updated users with legacy false persisted are migrated to enabled and minimized', async () => {
    const mod = await loadStore([['floatingInputEnabled', false]])
    expect(mod.floatingInputEnabled.value).toBe(true)
    expect(mod.floatingInputMinimized.value).toBe(true)
    expect(mod.store.get('floatingInputEnabled')).toBe(true)
    expect(mod.store.get('floatingInputDefaultMigrated')).toBe(true)
  })

  test('updated users who already enabled it start minimized once and keep enabled', async () => {
    const mod = await loadStore([['floatingInputEnabled', true]])
    expect(mod.floatingInputEnabled.value).toBe(true)
    expect(mod.floatingInputMinimized.value).toBe(true)
    expect(mod.store.get('floatingInputDefaultMigrated')).toBe(true)
  })

  test('post-migration opt-out and expanded state persist across reloads', async () => {
    const optedOut = await loadStore([
      ['floatingInputDefaultMigrated', true],
      ['floatingInputEnabled', false],
    ])
    expect(optedOut.floatingInputEnabled.value).toBe(false)

    const expanded = await loadStore([
      ['floatingInputDefaultMigrated', true],
      ['floatingInputEnabled', true],
      ['floatingInputMinimized', false],
    ])
    expect(expanded.floatingInputEnabled.value).toBe(true)
    expect(expanded.floatingInputMinimized.value).toBe(false)
  })
})
