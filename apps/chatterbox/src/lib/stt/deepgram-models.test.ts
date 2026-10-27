import { expect, test } from 'bun:test'

import { loadWithFakeGm } from '../../testing/fake-gm'

const load = () => loadWithFakeGm<typeof import('./deepgram-models')>(new URL('./deepgram-models.ts', import.meta.url))

test('lists streaming models, authenticating with the trimmed key as a Token', async () => {
  const deepgram = await load()
  const pending = deepgram.fetchDeepgramModels(' key ')
  expect(deepgram.requests[0].options).toMatchObject({
    url: 'https://api.deepgram.com/v1/models',
    headers: { authorization: 'Token key' },
  })
  deepgram.requests[0].respond(
    200,
    JSON.stringify({
      stt: [
        { canonical_name: 'nova-3', name: 'Nova 3', streaming: true },
        { name: 'batch-only', streaming: false },
      ],
    })
  )
  await expect(pending).resolves.toEqual([{ id: 'nova-3', name: 'Nova 3' }])
})

test('HTTP errors keep the status and body; transport failures are network errors', async () => {
  const deepgram = await load()
  const unauthorized = deepgram.fetchDeepgramModels('key')
  deepgram.requests[0].respond(401, 'INVALID_AUTH')
  await expect(unauthorized).rejects.toThrow(/^HTTP 401 .*INVALID_AUTH/)
  const refused = deepgram.fetchDeepgramModels('key')
  deepgram.requests[1].fail()
  await expect(refused).rejects.toThrow('网络请求失败')
})
