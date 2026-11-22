import { describe, expect, test } from 'bun:test'

import { loadWithFakeGm } from '../testing/fake-gm'

const loadStore = (seed: Iterable<readonly [string, unknown]> = []) =>
  loadWithFakeGm<typeof import('./store')>(new URL('./store.ts', import.meta.url), seed)

/** The shipped prompt, read from a fresh install (importing `./prompts` here would pull in the real `$`). */
async function readTheRoomPrompt(): Promise<string> {
  const prompt = (await loadStore()).llmPromptsAiChat.value.at(-1)
  if (!prompt) throw new Error('No default AI 融入 prompts')
  return prompt
}

describe('读空气融入 AI 融入 prompt seeding', () => {
  test('new users get it as the last default persona', async () => {
    const mod = await loadStore()
    expect(mod.llmPromptsAiChat.value.at(-1)?.split('\n')[0]).toBe('读空气融入')
    expect(mod.store.get('aiChatReadTheRoomSeeded')).toBe(true)
  })

  test('a list saved before it shipped gets it appended once, keeping the active prompt', async () => {
    const mod = await loadStore([
      ['llmPromptsAiChat', ['我的人设', '吐槽役']],
      ['llmActivePromptAiChat', 1],
    ])
    expect(mod.llmPromptsAiChat.value).toEqual(['我的人设', '吐槽役', await readTheRoomPrompt()])
    expect(mod.llmActivePromptAiChat.value).toBe(1)
    expect(mod.store.get('aiChatReadTheRoomSeeded')).toBe(true)
  })

  test('deleting it after the seed sticks', async () => {
    const mod = await loadStore([
      ['aiChatReadTheRoomSeeded', true],
      ['llmPromptsAiChat', ['我的人设']],
    ])
    expect(mod.llmPromptsAiChat.value).toEqual(['我的人设'])
  })

  test('an emptied list stays empty', async () => {
    const mod = await loadStore([['llmPromptsAiChat', []]])
    expect(mod.llmPromptsAiChat.value).toEqual([])
    expect(mod.store.get('aiChatReadTheRoomSeeded')).toBe(true)
  })
})
