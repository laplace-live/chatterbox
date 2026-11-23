import { describe, expect, test } from 'bun:test'

import type { ProgressMessage, ResultMessage, SendMessage, StatusMessage } from './protocol.ts'

import { MAX_SEND_TEXT, parseBridgeMessage, parseClientMessage } from './protocol.ts'

const send = {
  source: 'laplace-chat',
  type: 'send',
  protocol: 1,
  id: 'a',
  roomId: 1,
  text: 'hi',
  wrapBrackets: true,
} satisfies SendMessage

describe('parseClientMessage', () => {
  test('accepts pings and sends, dropping unknown fields', () => {
    expect(parseClientMessage({ source: 'laplace-chat', type: 'ping', extra: 1 })).toEqual({
      source: 'laplace-chat',
      type: 'ping',
    })
    expect(parseClientMessage({ ...send, extra: 1 })).toEqual(send)
  })

  test('rejects other senders and malformed sends', () => {
    expect(parseClientMessage({ ...send, source: 'laplace-chatterbox' })).toBeNull()
    expect(parseClientMessage({ ...send, text: '   ' })).toBeNull()
    expect(parseClientMessage({ ...send, text: 'x'.repeat(MAX_SEND_TEXT + 1) })).toBeNull()
    expect(parseClientMessage({ ...send, roomId: '1' })).toBeNull()
    expect(parseClientMessage({ ...send, id: '' })).toBeNull()
  })
})

describe('parseBridgeMessage', () => {
  test('parses status, progress and result messages', () => {
    const status = {
      source: 'laplace-chatterbox',
      type: 'status',
      protocol: 1,
      version: '5.1.0',
      enabled: true,
    } satisfies StatusMessage
    expect(parseBridgeMessage(status)).toEqual(status)
    const progress = {
      source: 'laplace-chatterbox',
      type: 'progress',
      id: 'a',
      sent: 1,
      total: 2,
    } satisfies ProgressMessage
    expect(parseBridgeMessage(progress)).toEqual(progress)
    const result = {
      source: 'laplace-chatterbox',
      type: 'result',
      id: 'a',
      status: 'partial',
      sent: 1,
      total: 2,
      error: 'k - 包含房间屏蔽词',
    } satisfies ResultMessage
    expect(parseBridgeMessage(result)).toEqual(result)
  })

  test('rejects client messages and malformed ones', () => {
    expect(parseBridgeMessage(send)).toBeNull()
    expect(
      parseBridgeMessage({
        source: 'laplace-chatterbox',
        type: 'result',
        id: 'a',
        status: 'exploded',
        sent: 0,
        total: 0,
      })
    ).toBeNull()
    expect(
      parseBridgeMessage({ source: 'laplace-chatterbox', type: 'progress', id: 'a', sent: -1, total: 0 })
    ).toBeNull()
    expect(parseBridgeMessage('laplace-chatterbox')).toBeNull()
  })
})
