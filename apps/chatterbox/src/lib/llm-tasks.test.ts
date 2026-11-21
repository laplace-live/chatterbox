import { describe, expect, mock, test } from 'bun:test'
import { signal } from '@preact/signals'

import type { ChatCompletionOptions, LlmChatMessage } from './llm'
import type { LlmProviderProfile } from './store'

import { loadWithMocks } from '../testing/load-with-mocks'

const FEATURE_PROMPT = '把弹幕改得更自然'
const provider: LlmProviderProfile = {
  id: 'test',
  name: 'Test',
  apiBase: 'https://llm.test/v1',
  apiKey: 'key',
  model: 'model',
  models: [],
}

// Mocked imports, not loadWithFakeGm: from this entry store.ts evaluates before prompts.ts and trips their import cycle.
async function loadLlmTasks() {
  const complete = mock(async (_options: ChatCompletionOptions) => '好耶！')
  const tasks = await loadWithMocks<typeof import('./llm-tasks')>(new URL('./llm-tasks.ts', import.meta.url), {
    './llm': { chatCompletion: complete },
    './prompts': { getActiveLlmPrompt: () => FEATURE_PROMPT },
    './store': { activeLlmProvider: signal(provider) },
  })
  return { tasks, complete }
}

describe('polishWithLlm', () => {
  test('appends a non-blank scene to the system prompt as context', async () => {
    const { tasks, complete } = await loadLlmTasks()
    const controller = new AbortController()
    await tasks.polishWithLlm('autoBlend', '好耶', { signal: controller.signal, scene: ' 主播在打 Boss ' })
    const options = complete.mock.calls[0]?.[0]
    expect(options?.messages).toEqual([
      { role: 'system', content: `${FEATURE_PROMPT}\n\n当前直播画面（仅供理解语境，不要描述画面）：主播在打 Boss` },
      { role: 'user', content: '好耶' },
    ])
    expect(options?.signal).toBe(controller.signal)
  })

  test('keeps the plain system prompt without a non-blank scene', async () => {
    const { tasks, complete } = await loadLlmTasks()
    for (const opts of [undefined, { scene: undefined }, { scene: '' }, { scene: ' \n ' }]) {
      await tasks.polishWithLlm('autoBlend', '好耶', opts)
    }
    const plain: LlmChatMessage[] = [
      { role: 'system', content: FEATURE_PROMPT },
      { role: 'user', content: '好耶' },
    ]
    expect(complete.mock.calls.map(([options]) => options.messages)).toEqual([plain, plain, plain, plain])
  })
})
