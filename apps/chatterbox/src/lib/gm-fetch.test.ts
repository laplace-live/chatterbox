import { expect, test } from 'bun:test'

import type { FakeGmRequest } from '../testing/fake-gm-transport'

import { loadWithFakeGm } from '../testing/fake-gm'

const load = () => loadWithFakeGm<typeof import('./gm-fetch')>(new URL('./gm-fetch.ts', import.meta.url))

/** The rejection, or `'pending'` after `ms`: `expect().rejects` on a never-settling promise hangs `bun test`. */
const settleWithin = (promise: Promise<unknown>, ms = 100) =>
  Promise.race([
    promise.then(
      () => 'resolved',
      (err: unknown) => err
    ),
    Bun.sleep(ms).then(() => 'pending'),
  ])

test('forwards the request without cookies and resolves error statuses as readable responses', async () => {
  const { gmFetch, requests } = await load()
  const pending = gmFetch('https://llm.test/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer key', 'Content-Type': 'application/json' },
    body: '{"model":"m"}',
  })
  expect(requests[0].options).toMatchObject({
    url: 'https://llm.test/v1/chat/completions',
    method: 'POST',
    headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
    data: '{"model":"m"}',
    anonymous: true,
  })
  requests[0].respond(401, '{"error":"bad key"}', { 'Content-Type': 'application/json' })
  const response = await pending
  expect(response.ok).toBe(false)
  expect(response.status).toBe(401)
  expect(response.headers.get('content-type')).toBe('application/json')
  expect(await response.json()).toEqual({ error: 'bad key' })
})

test('sends cookies only with credentials: include, and passes form data through as-is', async () => {
  const { gmFetch, requests } = await load()
  const form = new FormData()
  gmFetch('https://a.test', { method: 'POST', body: form, credentials: 'include' })
  gmFetch('https://a.test')
  expect(requests[0].options).toMatchObject({ anonymous: false, data: form })
  expect(requests[1].options).toMatchObject({ method: 'GET', anonymous: true })
})

test('a 204 resolves with a null body', async () => {
  const { gmFetch, requests } = await load()
  const pending = gmFetch('https://a.test')
  requests[0].respond(204)
  expect((await pending).body).toBeNull()
})

test("aborting rejects with the signal's reason, cancels the request, and ignores a late response", async () => {
  const { gmFetch, requests } = await load()
  const controller = new AbortController()
  const pending = gmFetch('https://a.test', { signal: controller.signal })
  const reason = new DOMException('timed out', 'TimeoutError')
  controller.abort(reason)
  requests[0].respond(200, 'late')
  await expect(pending).rejects.toBe(reason)
  expect(requests[0].aborted).toBe(1)
})

test('an already-aborted signal sends nothing', async () => {
  const { gmFetch, requests } = await load()
  await expect(gmFetch('https://a.test', { signal: AbortSignal.abort() })).rejects.toHaveProperty('name', 'AbortError')
  expect(requests).toHaveLength(0)
})

test('a timeout rejects with a TimeoutError and cancels the request; the manager gets the same timeout', async () => {
  const { gmFetch, requests } = await load()
  const pending = gmFetch('https://a.test', { timeout: 5 })
  expect(requests[0].options.timeout).toBe(5)
  expect(await settleWithin(pending)).toHaveProperty('name', 'TimeoutError')
  expect(requests[0].aborted).toBe(1)
})

test('a zero or negative timeout (an exhausted budget) times out without sending anything', async () => {
  const { gmFetch, requests } = await load()
  expect(await settleWithin(gmFetch('https://a.test', { timeout: 0 }))).toHaveProperty('name', 'TimeoutError')
  expect(await settleWithin(gmFetch('https://a.test', { timeout: -5 }))).toHaveProperty('name', 'TimeoutError')
  expect(requests).toHaveLength(0)
})

test("the manager's own timeout rejects the same way", async () => {
  const { gmFetch, requests } = await load()
  const pending = gmFetch('https://a.test', { timeout: 60_000 })
  requests[0].timeOut()
  await expect(pending).rejects.toHaveProperty('name', 'TimeoutError')
})

const transportFailures: [string, (request: FakeGmRequest) => void, string][] = [
  [
    'a denied @connect prompt',
    request => request.fail('Refused to connect to "a.test"'),
    'Refused to connect to "a.test"',
  ],
  ['a failure without a message', request => request.fail(), 'Failed to fetch'],
  [
    'an abort the manager starts itself',
    request => request.options.onabort?.(),
    'Request aborted by the userscript manager',
  ],
  ['status 0', request => request.respond(0), 'Failed to fetch'],
  ['a non-numeric status', request => request.respond(Number.NaN), 'Failed to fetch'],
]

test.each(transportFailures)('%s rejects with a TypeError', async (_label, settle, message) => {
  const { gmFetch, requests } = await load()
  const pending = gmFetch('https://a.test')
  settle(requests[0])
  const error = await pending.catch((err: unknown) => err)
  expect(error).toBeInstanceOf(TypeError)
  expect(error).toHaveProperty('message', message)
})
