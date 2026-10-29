import { afterEach, describe, expect, jest, test } from 'bun:test'

import type { SttChunk, SttEngineEvent } from './types'

import { createTranslationText } from './translation-text'

afterEach(() => jest.useRealTimers())

function setup() {
  const events: SttEngineEvent[] = []
  const stream = createTranslationText(event => events.push(event))
  const chunks = () => events.flatMap(event => (event.type === 'transcript' ? event.chunks : []))
  const finals = () =>
    chunks()
      .filter(chunk => chunk.isFinal)
      .map(chunk => chunk.text)
      .join('')
  return { stream, events, chunks, finals }
}

describe('translation text boundaries', () => {
  test('keeps split decimals and the next unfinished word out of sent text', () => {
    jest.useFakeTimers()
    const { stream, events, chunks, finals } = setup()
    stream.push('It costs 3.')
    jest.advanceTimersByTime(400)
    expect(finals()).toBe('')
    expect(events.some(event => event.type === 'endpoint')).toBe(false)
    stream.push('14 dollars. Nex')
    expect(finals()).toBe('It costs 3.14 dollars. ')
    expect(chunks().at(-1)).toEqual({ text: 'Nex', isFinal: false, kind: 'translation' })
    jest.advanceTimersByTime(400)
    expect(finals()).toBe('It costs 3.14 dollars. ')
    stream.push('t sentence.')
    expect(finals()).toBe('It costs 3.14 dollars. ')
    stream.flush()
    expect(finals()).toBe('It costs 3.14 dollars. Next sentence.')
  })

  test('holds split domains and versions until the following sentence boundary', () => {
    const { stream, finals } = setup()
    for (const delta of ['Visit example.', 'com for v1.', '2.', '3. ', 'Done!']) stream.push(delta)
    expect(finals()).toBe('Visit example.com for v1.2.3. Done!')
    stream.cancel()
  })

  test('flushes an unpunctuated tail after inactivity and clears its preview', () => {
    jest.useFakeTimers()
    const { stream, events, finals } = setup()
    stream.push('No punctuation')
    jest.advanceTimersByTime(4999)
    expect(finals()).toBe('')
    stream.push(' yet')
    jest.advanceTimersByTime(4999)
    expect(finals()).toBe('')
    jest.advanceTimersByTime(1)
    expect(finals()).toBe('No punctuation yet')
    expect(events.at(-1)).toEqual({ type: 'endpoint' })
    stream.flush()
    expect(finals()).toBe('No punctuation yet')
  })

  test('cancel discards only the pending preview and suppresses its idle callback', () => {
    jest.useFakeTimers()
    const { stream, events, finals } = setup()
    stream.push('Sent。Unfinished')
    expect(finals()).toBe('Sent。')
    const before = events.length
    stream.cancel()
    jest.advanceTimersByTime(10000)
    stream.flush()
    expect(events).toHaveLength(before)
  })

  test('emits final prefixes and partial remainders in one ordered update', () => {
    const { stream, events } = setup()
    stream.push('你好。下一')
    const expected: SttChunk[] = [
      { text: '你好。', isFinal: true, kind: 'translation' },
      { text: '下一', isFinal: false, kind: 'translation' },
    ]
    expect(events).toEqual([{ type: 'transcript', chunks: expected }, { type: 'endpoint' }])
    stream.cancel()
  })
})
