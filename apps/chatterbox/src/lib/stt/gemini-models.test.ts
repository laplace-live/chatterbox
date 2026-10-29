import { expect, test } from 'bun:test'

import { loadWithFakeGm } from '../../testing/fake-gm'

const load = () => loadWithFakeGm<typeof import('./gemini-models')>(new URL('./gemini-models.ts', import.meta.url))

test('lists Live transcription models through the configured root, keying with the trimmed header', async () => {
  const gemini = await load()
  const pending = gemini.fetchGeminiModels(' key ', 'https://gateway.ai.cloudflare.com/v1/acct/gw')
  expect(gemini.requests[0].options).toMatchObject({
    url: 'https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/v1beta/models?pageSize=1000',
    headers: { 'x-goog-api-key': 'key' },
    timeout: 15_000,
  })
  gemini.requests[0].respond(
    200,
    JSON.stringify({
      models: [
        { name: 'models/gemini-3.5-transcribe-live', supportedGenerationMethods: ['bidiGenerateContent'] },
        { name: 'models/gemini-3.8-live', supportedGenerationMethods: ['bidiGenerateContent'] },
      ],
    })
  )
  await expect(pending).resolves.toEqual([{ id: 'gemini-3.5-transcribe-live' }])
})

test('HTTP errors keep the status and body; transport failures and timeouts get their own messages', async () => {
  const gemini = await load()
  const rejected = gemini.fetchGeminiModels('key', '')
  gemini.requests[0].respond(400, '{"error":{"message":"API key not valid."}}')
  await expect(rejected).rejects.toThrow(/^HTTP 400 .*API key not valid/)
  const refused = gemini.fetchGeminiModels('key', '')
  gemini.requests[1].fail()
  await expect(refused).rejects.toThrow('网络请求失败')
  const stalled = gemini.fetchGeminiModels('key', '')
  gemini.requests[2].timeOut()
  await expect(stalled).rejects.toThrow('请求超时（15 秒）')
})

test('a list without transcription models is an error, and so is a missing key', async () => {
  const gemini = await load()
  const pending = gemini.fetchGeminiModels('key', '')
  gemini.requests[0].respond(200, JSON.stringify({ models: [] }))
  await expect(pending).rejects.toThrow('返回列表中没有实时转录或翻译模型')
  await expect(gemini.fetchGeminiModels('  ', '')).rejects.toThrow('请填写 Google AI Studio API Key')
  expect(gemini.requests).toHaveLength(1)
})
