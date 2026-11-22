import { beforeEach, describe, expect, test } from 'bun:test'

import { clearScenes, currentScene, latestScene, recordScene, recordSceneCut, sceneNotes } from './scene-memory'

beforeEach(clearScenes)

describe('recordScene', () => {
  test('trims and cuts notes to 60 characters', () => {
    recordScene(`  ${'a'.repeat(70)}  `, 'chat', 1_000)
    recordScene('画'.repeat(61), 'caption', 2_000)
    recordScene('😀'.repeat(61), 'caption', 3_000)
    expect(sceneNotes.value.map(note => note.scene)).toEqual(['a'.repeat(60), '画'.repeat(60), '😀'.repeat(60)])
    expect(sceneNotes.value[0]).toEqual({ at: 1_000, scene: 'a'.repeat(60), source: 'chat' })
  })

  test('ignores blank input', () => {
    recordScene('', 'chat', 1_000)
    recordScene(' \n\t ', 'caption', 2_000)
    expect(sceneNotes.value).toEqual([])
  })

  test('keeps the newest 20, oldest first', () => {
    for (let i = 1; i <= 25; i++) recordScene(`场景 ${i}`, 'caption', i * 1_000)
    expect(sceneNotes.value).toHaveLength(20)
    expect(sceneNotes.value[0].scene).toBe('场景 6')
    expect(sceneNotes.value.at(-1)?.scene).toBe('场景 25')
  })

  test('orders a late-recorded older note by its time', () => {
    recordScene('后', 'chat', 5_000)
    recordScene('先', 'caption', 3_000)
    expect(sceneNotes.value.map(note => note.scene)).toEqual(['先', '后'])
  })

  test('stamps Date.now() by default', () => {
    const before = Date.now()
    recordScene('主播在聊天', 'chat')
    const at = sceneNotes.value[0].at
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
    expect(latestScene(60_000)?.scene).toBe('主播在聊天')
  })
})

describe('latestScene', () => {
  test('returns the newest note while it is young enough', () => {
    recordScene('旧画面', 'caption', 1_000)
    recordScene('新画面', 'chat', 5_000)
    expect(latestScene(2_000, 6_000)?.scene).toBe('新画面')
    expect(latestScene(1_000, 6_000)?.scene).toBe('新画面')
    expect(latestScene(999, 6_000)).toBeNull()
  })

  test('is null when there are no notes, including after clearScenes', () => {
    expect(latestScene(60_000, 0)).toBeNull()
    recordScene('画面', 'chat', 1_000)
    clearScenes()
    expect(latestScene(60_000, 1_000)).toBeNull()
  })
})

describe('currentScene', () => {
  test('skips a note captured before the latest cut until a newer one arrives', () => {
    recordScene('打 Boss', 'caption', 1_000)
    expect(currentScene(10_000, 5_000)?.scene).toBe('打 Boss')
    recordSceneCut(2_000)
    expect(currentScene(10_000, 5_000)).toBeNull()
    expect(latestScene(10_000, 5_000)?.scene).toBe('打 Boss')
    recordScene('聊天', 'chat', 2_000)
    expect(currentScene(10_000, 5_000)?.scene).toBe('聊天')
  })

  test('clearScenes forgets the cut', () => {
    recordSceneCut(2_000)
    clearScenes()
    recordScene('打 Boss', 'caption', 1_000)
    expect(currentScene(10_000, 5_000)?.scene).toBe('打 Boss')
  })
})
