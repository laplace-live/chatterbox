import { describe, expect, test } from 'bun:test'

import type { DecisionPreset, DecisionProviderProfile } from './decision-model'

const provider: DecisionProviderProfile = {
  id: 'test',
  name: 'TypeSafe',
  protocol: 'typesafe',
  apiBase: 'https://api.typesafe.ai/v1',
  apiKey: 'test-key',
  model: 'jev-latest',
  models: [],
}
const preset: DecisionPreset = { id: 'warm', name: '暖男', instructions: '只发送真诚关心、鼓励或安慰的弹幕。' }
const state = { candidate: '辛苦了，早点休息', recentMessages: ['今天有点累'] }
const source = await Bun.file(new URL('./decision-model.ts', import.meta.url)).text()
let harnessId = 0

interface MockRequest {
  aborted: number
  options: {
    url: string
    method: string
    headers: Record<string, string>
    data?: string
    timeout: number
    onload: (response: { status: number; responseText: string }) => void
    onabort: () => void
    onerror: () => void
    ontimeout: () => void
  }
}

async function harness() {
  // Each data-URL module owns its transport; Bun's global module cache stays untouched.
  const transportUrl = `data:text/javascript;base64,${Buffer.from(`
    export const requests = [];
    export function GM_xmlhttpRequest(options) {
      const request = { options, aborted: 0 };
      requests.push(request);
      return { abort() { request.aborted++; options.onabort(); } };
    }
    // instance ${harnessId++}
  `).toString('base64')}`
  const transport = (await import(transportUrl)) as { requests: MockRequest[] }
  const testSource = source
    .replace("from '$'", `from '${transportUrl}'`)
    .replace("from './utils'", `from '${new URL('./utils.ts', import.meta.url).href}'`)
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(testSource)
  const client = (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )) as typeof import('./decision-model')
  return {
    ...client,
    requests: transport.requests,
    respond(json: unknown, status = 200) {
      transport.requests.at(-1)?.options.onload({ status, responseText: JSON.stringify(json) })
    },
  }
}

describe('evaluateDecision', () => {
  test('sends a single preset question and returns its send probability', async () => {
    const client = await harness()
    const pending = client.evaluateDecision({ provider, preset, state })
    const request = client.requests[0].options
    expect(request.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(request.method).toBe('POST')
    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.timeout).toBe(8_000)
    const body = JSON.parse(request.data ?? '{}')
    expect(body.model).toBe('jev-latest')
    expect(body.state).toEqual(state)
    expect(Object.keys(body.questions)).toEqual(['send'])
    expect(body.questions.send.type).toBe('noul')
    expect(body.questions.send.instructions).toContain(preset.instructions)
    expect(body.questions.send.instructions).toContain('只判断 `candidate` 本身')
    client.respond({ answers: { send: { type: 'noul', noul: 0.85 } } })
    await expect(pending).resolves.toEqual({ sendProbability: 0.85 })
  })

  test.each([
    ['https://openrouter.ai/api', 'https://openrouter.ai/api/alpha/decisions'],
    ['https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/alpha/decisions'],
    ['https://openrouter.ai/', 'https://openrouter.ai/api/alpha/decisions'],
    ['http://localhost:8080/proxy/v1/', 'http://localhost:8080/proxy/alpha/decisions'],
  ])('normalizes OpenRouter base %s', async (apiBase, expectedUrl) => {
    const client = await harness()
    const pending = client.evaluateDecision({
      provider: { ...provider, protocol: 'openrouter', apiBase, model: 'typesafe/jev-1.13' },
      preset,
      state,
    })
    expect(client.requests[0].options.url).toBe(expectedUrl)
    client.respond({ answers: { send: { type: 'noul', noul: 1 } } })
    await expect(pending).resolves.toEqual({ sendProbability: 1 })
  })

  test('allows custom model IDs and unauthenticated local services', async () => {
    const client = await harness()
    const pending = client.evaluateDecision({
      provider: { ...provider, apiBase: 'http://127.0.0.1:8080/v1///', apiKey: '', model: 'custom-decision' },
      preset,
      state,
    })
    expect(client.requests[0].options.url).toBe('http://127.0.0.1:8080/v1/systemone')
    expect(client.requests[0].options.headers.Authorization).toBeUndefined()
    expect(JSON.parse(client.requests[0].options.data ?? '{}').model).toBe('custom-decision')
    client.respond({ answers: { send: { type: 'noul', noul: 0 } } })
    await expect(pending).resolves.toEqual({ sendProbability: 0 })
  })

  test.each([
    {},
    { answers: {} },
    { answers: { send: { type: 'choice', noul: 1 } } },
    { answers: { send: { type: 'noul', noul: '0.9' } } },
    { answers: { send: { type: 'noul', noul: null } } },
    { answers: { send: { type: 'noul', noul: -0.1 } } },
    { answers: { send: { type: 'noul', noul: 1.1 } } },
  ])('rejects invalid send answer %#', async response => {
    const client = await harness()
    const pending = client.evaluateDecision({ provider, preset, state })
    client.respond(response)
    await expect(pending).rejects.toThrow('发送判断无效')
  })

  test('rejects infinite JSON number', async () => {
    const client = await harness()
    const pending = client.evaluateDecision({ provider, preset, state })
    client.requests[0].options.onload({
      status: 200,
      responseText: '{"answers":{"send":{"type":"noul","noul":1e999}}}',
    })
    await expect(pending).rejects.toThrow('发送判断无效')
  })

  test.each([
    { apiBase: '' },
    { apiBase: 'not a URL' },
    { apiBase: 'file:///tmp/local' },
    { apiBase: 'https://key:secret@example.com/v1' },
    { apiBase: 'https://example.com/v1?api_key=secret' },
    { apiBase: 'https://example.com/v1#secret' },
    { apiKey: '' },
    { model: '' },
    { protocol: 'unsupported' },
  ])('rejects invalid configuration before a request %#', async overrides => {
    const client = await harness()
    await expect(
      client.evaluateDecision({ provider: { ...provider, ...overrides } as DecisionProviderProfile, preset, state })
    ).rejects.toThrow()
    expect(client.requests).toHaveLength(0)
  })

  test('rejects empty preset and candidate', async () => {
    const client = await harness()
    await expect(client.evaluateDecision({ provider, preset: { ...preset, instructions: '' }, state })).rejects.toThrow(
      '判断条件'
    )
    await expect(client.evaluateDecision({ provider, preset, state: { ...state, candidate: ' ' } })).rejects.toThrow(
      '弹幕不能为空'
    )
    expect(client.requests).toHaveLength(0)
  })

  test('bounds recent context without truncating the candidate', async () => {
    const client = await harness()
    const candidate = '候选'.repeat(300)
    const pending = client.evaluateDecision({
      provider,
      preset,
      state: { candidate, recentMessages: Array.from({ length: 30 }, (_, i) => `${i}:${'x'.repeat(600)}`) },
    })
    const sentState = JSON.parse(client.requests[0].options.data ?? '{}').state
    expect(sentState.candidate).toBe(candidate)
    expect(sentState.recentMessages).toHaveLength(20)
    expect(sentState.recentMessages[0]).toStartWith('10:')
    expect(sentState.recentMessages[0]).toHaveLength(500)
    client.respond({ answers: { send: { type: 'noul', noul: 0.5 } } })
    await pending
  })

  test('aborts the GM request and ignores late success', async () => {
    const client = await harness()
    const controller = new AbortController()
    const pending = client.evaluateDecision({ provider, preset, state, signal: controller.signal })
    controller.abort()
    client.respond({ answers: { send: { type: 'noul', noul: 1 } } })
    await expect(pending).rejects.toHaveProperty('name', 'AbortError')
    expect(client.requests[0].aborted).toBe(1)
  })

  test('already aborted signals do not create a request', async () => {
    const client = await harness()
    await expect(
      client.evaluateDecision({ provider, preset, state, signal: AbortSignal.abort() })
    ).rejects.toHaveProperty('name', 'AbortError')
    expect(client.requests).toHaveLength(0)
  })

  test('times out without retrying', async () => {
    const client = await harness()
    const pending = client.evaluateDecision({ provider, preset, state })
    client.requests[0].options.ontimeout()
    await expect(pending).rejects.toThrow('超时')
    expect(client.requests).toHaveLength(1)
    expect(client.requests[0].aborted).toBe(1)
  })

  test('reports HTTP failures without echoing response secrets', async () => {
    const client = await harness()
    const pending = client.evaluateDecision({ provider, preset, state })
    client.respond({ error: 'secret-key' }, 401)
    await expect(pending).rejects.toThrow('决策模型请求失败：HTTP 401')
    expect(client.requests).toHaveLength(1)
  })
})

describe('fetchDecisionModels', () => {
  test('reads, deduplicates, and sorts the TypeSafe model names', async () => {
    const client = await harness()
    const pending = client.fetchDecisionModels(provider)
    expect(client.requests[0].options.url).toBe('https://api.typesafe.ai/v1/models')
    expect(client.requests[0].options.method).toBe('GET')
    client.respond({ models: [{ name: 'jev-preview' }, { name: 'jev-latest' }, { name: 'jev-latest' }, null, {}] })
    await expect(pending).resolves.toEqual([{ id: 'jev-latest' }, { id: 'jev-preview' }])
  })

  test('requests decision models and excludes explicit text-only models from OpenRouter', async () => {
    const client = await harness()
    const pending = client.fetchDecisionModels({
      ...provider,
      protocol: 'openrouter',
      apiBase: 'https://openrouter.ai/api/v1/',
    })
    expect(client.requests[0].options.url).toBe('https://openrouter.ai/api/v1/models?output_modalities=decisions')
    client.respond({
      data: [
        { id: 'text-model', architecture: { output_modalities: ['text'] } },
        { id: 'typesafe/jev-1.13', name: 'Jev 1.13', architecture: { output_modalities: ['decisions'] } },
        { id: 'custom-no-metadata' },
      ],
    })
    await expect(pending).resolves.toEqual([
      { id: 'custom-no-metadata' },
      { id: 'typesafe/jev-1.13', name: 'Jev 1.13' },
    ])
  })

  test.each([{}, { models: [] }, { models: [{}] }])('rejects unusable model lists %#', async response => {
    const client = await harness()
    const pending = client.fetchDecisionModels(provider)
    client.respond(response)
    await expect(pending).rejects.toThrow()
  })
})
