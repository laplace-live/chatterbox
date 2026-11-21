import { describe, expect, test } from 'bun:test'

import type { ChatCompletionOptions, LlmContentPart } from './llm'

import { loadWithFakeGm } from '../testing/fake-gm'

const options: ChatCompletionOptions = {
  base: 'https://llm.test/v1',
  apiKey: 'key',
  model: 'model',
  messages: [{ role: 'user', content: '晚上好' }],
}

const load = () => loadWithFakeGm<typeof import('./llm')>(new URL('./llm.ts', import.meta.url))

async function complete(body: unknown, status = 200): Promise<string> {
  const llm = await load()
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

test('stalled requests time out with their own message: model list after 30 s, chat after 120 s', async () => {
  const llm = await load()
  const models = llm.fetchLlmModels('https://llm.test/v1', 'key')
  const chat = llm.chatCompletion(options)
  expect(llm.requests.map(request => request.options.timeout)).toEqual([30_000, 120_000])
  llm.requests[0].timeOut()
  await expect(models).rejects.toThrow('请求超时（30 秒）')
  llm.requests[1].timeOut()
  await expect(chat).rejects.toThrow('请求超时（120 秒）')
})

const reply = { choices: [{ message: { role: 'assistant', content: 'ok' } }] }

test('a plain-text request body is exactly model, messages, temperature and stream', async () => {
  const llm = await load()
  const pending = llm.chatCompletion(options)
  expect(JSON.parse(String(llm.requests[0].options.data))).toEqual({
    model: 'model',
    messages: [{ role: 'user', content: '晚上好' }],
    temperature: 0.7,
    stream: false,
  })
  llm.requests[0].respond(200, JSON.stringify(reply))
  expect(await pending).toBe('ok')
})

test('image and video parts reach the request body as given', async () => {
  const llm = await load()
  const content: LlmContentPart[] = [
    { type: 'text', text: '直播画面截图：' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA', detail: 'low' } },
    { type: 'video_url', video_url: { url: 'data:video/mp4;base64,BBBB' } },
  ]
  const messages: ChatCompletionOptions['messages'] = [
    { role: 'system', content: '你是观众' },
    { role: 'user', content },
  ]
  const pending = llm.chatCompletion({ ...options, messages })
  expect(JSON.parse(String(llm.requests[0].options.data)).messages).toEqual(messages)
  llm.requests[0].respond(200, JSON.stringify(reply))
  expect(await pending).toBe('ok')
})

test('onPromptTokens receives the prompt token count the response reports', async () => {
  const llm = await load()
  const counts: number[] = []
  const pending = llm.chatCompletion({ ...options, onPromptTokens: count => counts.push(count) })
  llm.requests[0].respond(
    200,
    JSON.stringify({ ...reply, usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 } })
  )
  await pending
  expect(counts).toEqual([1234])
})

test('onPromptTokens is skipped without a numeric prompt_tokens', async () => {
  const llm = await load()
  const counts: number[] = []
  const onPromptTokens = (count: number) => counts.push(count)
  const missing = llm.chatCompletion({ ...options, onPromptTokens })
  const textual = llm.chatCompletion({ ...options, onPromptTokens })
  const completionOnly = llm.chatCompletion({ ...options, onPromptTokens })
  llm.requests[0].respond(200, JSON.stringify(reply))
  llm.requests[1].respond(200, JSON.stringify({ ...reply, usage: { prompt_tokens: '12' } }))
  llm.requests[2].respond(200, JSON.stringify({ ...reply, usage: { completion_tokens: 56 } }))
  await Promise.all([missing, textual, completionOnly])
  expect(counts).toEqual([])
})

test('fetchLlmModels keeps non-empty architecture.input_modalities', async () => {
  const llm = await load()
  const pending = llm.fetchLlmModels('https://llm.test/v1', 'key')
  llm.requests[0].respond(
    200,
    JSON.stringify({
      data: [
        { id: 'vision', architecture: { input_modalities: ['text', 'image', '', 3, ' video '] } },
        { id: 'empty', architecture: { input_modalities: ['', null] } },
        { id: 'malformed', architecture: { input_modalities: 'text' } },
        { id: 'bare' },
      ],
    })
  )
  expect(await pending).toEqual([
    { id: 'bare' },
    { id: 'empty' },
    { id: 'malformed' },
    { id: 'vision', inputModalities: ['text', 'image', 'video'] },
  ])
})

const { classifyMediaRejection, modelRejectsImages } = await load()

describe('classifyMediaRejection', () => {
  test.each([
    [
      `HTTP 400 : {"error":{"message":"Invalid value: 'video_url'. Supported values are: 'text', 'image_url'"}}`,
      'video',
    ],
    ['HTTP 413 Payload Too Large: video exceeds the size limit', 'video'],
    ['HTTP 400 : unknown variant `image_url`, expected `text`', 'image'],
    ['HTTP 404 : No endpoints found that support image input', 'image'],
    ['HTTP 400 : this model does not support vision', 'image'],
    ['HTTP 400 : Multimodal input is not supported', 'image'],
    ['HTTP 413 Payload Too Large', 'payload'],
    ['HTTP 413 Payload Too Large: image exceeds the size limit', 'payload'],
    ['HTTP 413 ', 'payload'],
    ['HTTP 400 : response_format json_schema cannot be combined with image input', null],
    ['HTTP 400 : max_tokens is too large', null],
    ['HTTP 500 Internal Server Error: failed to decode image', null],
    ['HTTP 502 Bad Gateway: upstream answered HTTP 413 image too large', null],
    ['网络请求失败：video', null],
  ] as const)('%s', (message, expected) => {
    expect(classifyMediaRejection(new Error(message))).toBe(expected)
  })

  test('only Errors are classified', () => {
    expect(classifyMediaRejection('HTTP 400 : image_url is not supported')).toBeNull()
    expect(classifyMediaRejection({ message: 'HTTP 413 ' })).toBeNull()
    expect(classifyMediaRejection(null)).toBeNull()
  })

  test('classifies the error chatCompletion throws for a rejected image', async () => {
    const llm = await load()
    const pending = llm.chatCompletion(options)
    llm.requests[0].respond(
      400,
      JSON.stringify({ error: { message: 'image_url is only supported by certain models' } })
    )
    const err = await pending.then(
      () => null,
      (error: unknown) => error
    )
    expect(llm.classifyMediaRejection(err)).toBe('image')
  })
})

test('modelRejectsImages only when the cached entry lists input modalities without image', () => {
  const models = [
    { id: 'a', inputModalities: ['text', 'image'] },
    { id: 'b', inputModalities: ['text'] },
    { id: 'c', inputModalities: [] },
    { id: 'd' },
  ]
  expect(['a', 'b', 'c', 'd', 'missing'].map(id => modelRejectsImages(models, id))).toEqual([
    false,
    true,
    false,
    false,
    false,
  ])
})
