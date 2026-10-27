import { expect, test } from 'bun:test'

import type { ChatCompletionOptions } from './llm'

import { loadWithFakeGm } from '../testing/fake-gm'

const options: ChatCompletionOptions = {
  base: 'https://llm.test/v1',
  apiKey: 'key',
  model: 'model',
  messages: [{ role: 'user', content: '晚上好' }],
}

async function complete(body: unknown, status = 200): Promise<string> {
  const llm = await loadWithFakeGm<typeof import('./llm')>(new URL('./llm.ts', import.meta.url))
  const pending = llm.chatCompletion(options)
  llm.requests[0].respond(status, JSON.stringify(body))
  return pending
}

test('an empty reply resolves to an empty string so callers can treat it as a refusal', async () => {
  expect(await complete({ choices: [{ message: { role: 'assistant', content: '' } }] })).toBe('')
})

test('a reply without content is still an error', async () => {
  await expect(
    complete({ choices: [{ message: { role: 'assistant', content: null, refusal: '无法回答' } }] })
  ).rejects.toThrow('返回数据缺少 content 字段')
})

test('HTTP errors keep the status and body, which the response_format fallback matches on', async () => {
  await expect(complete({ error: { message: 'response_format is not supported' } }, 400)).rejects.toThrow(
    /^HTTP 400 .*response_format/
  )
})
