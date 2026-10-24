import { describe, expect, test } from 'bun:test'

import type { ActionDeliveryMessage, DanmakuAction, HelloMessage, Member } from './index'

import { isActionSource, PROTOCOL_VERSION, parseClientMessage, parseServerMessage, readHelloProtocol } from './index'

const hello: HelloMessage = {
  type: 'hello',
  protocol: PROTOCOL_VERSION,
  token: '',
  clientVersion: '4.4.0',
  uid: '12345',
  uname: '卡卡西',
  role: 'mirror',
  roomId: 21452505,
  visible: true,
  follow: false,
}

describe('parseClientMessage', () => {
  test('accepts a valid hello and drops unknown fields', () => {
    expect(parseClientMessage({ ...hello, extra: 'x' })).toEqual(hello)
  })

  test('rejects a non-numeric uid', () => {
    expect(parseClientMessage({ ...hello, uid: 'abc' })).toBeNull()
  })

  test('requires the follow flag on hello and presence', () => {
    const { follow: _, ...withoutFollow } = hello
    expect(parseClientMessage(withoutFollow)).toBeNull()
    expect(parseClientMessage({ type: 'presence', role: 'mirror', roomId: 1, visible: true })).toBeNull()
    expect(parseClientMessage({ type: 'presence', role: 'mirror', roomId: 1, visible: true, follow: true })).toEqual({
      type: 'presence',
      role: 'mirror',
      roomId: 1,
      visible: true,
      follow: true,
    })
  })

  test('accepts a null room for a tab that has not resolved its room yet', () => {
    expect(parseClientMessage({ ...hello, roomId: null })).not.toBeNull()
  })

  test('rejects an action with an unknown source or blank text', () => {
    const action: DanmakuAction = { kind: 'danmaku', roomId: 1, text: 'hi', source: 'manual' }
    expect(parseClientMessage({ type: 'action', action })).toEqual({ type: 'action', action })
    expect(parseClientMessage({ type: 'action', action: { ...action, source: 'gift' } })).toBeNull()
    expect(parseClientMessage({ type: 'action', action: { ...action, text: '   ' } })).toBeNull()
  })

  test('accepts an optional string result detail', () => {
    expect(parseClientMessage({ type: 'result', eventId: 'e1', status: 'sent' })).toEqual({
      type: 'result',
      eventId: 'e1',
      status: 'sent',
    })
    expect(parseClientMessage({ type: 'result', eventId: 'e1', status: 'failed', detail: 'muted' })).toEqual({
      type: 'result',
      eventId: 'e1',
      status: 'failed',
      detail: 'muted',
    })
    expect(parseClientMessage({ type: 'result', eventId: 'e1', status: 'failed', detail: 42 })).toBeNull()
  })
})

describe('readHelloProtocol', () => {
  test('reads the version even when the rest of the frame is unknown', () => {
    expect(readHelloProtocol({ type: 'hello', protocol: 99, shape: 'future' })).toBe(99)
    expect(readHelloProtocol({ type: 'presence', protocol: 1 })).toBeNull()
  })
})

describe('parseServerMessage', () => {
  test('rejects a roster when any member is malformed', () => {
    const member: Member = { uid: '1', uname: 'a', role: 'standby', roomIds: [5], tabs: 2 }
    expect(parseServerMessage({ type: 'roster', members: [member], masterRoomId: 5 })).toEqual({
      type: 'roster',
      members: [member],
      masterRoomId: 5,
    })
    const broken = { type: 'roster', members: [member, { ...member, tabs: -1 }], masterRoomId: 5 }
    expect(parseServerMessage(broken)).toBeNull()
  })

  test('parses an action delivery', () => {
    const msg: ActionDeliveryMessage = {
      type: 'action',
      eventId: 'e2',
      from: { uid: '9', uname: 'master' },
      action: { kind: 'danmaku', roomId: 3, text: '哈哈', source: 'loop' },
    }
    expect(parseServerMessage(msg)).toEqual(msg)
  })
})

test('isActionSource only accepts known sources', () => {
  expect(isActionSource('stt')).toBe(true)
  expect(isActionSource('copy')).toBe(false)
  expect(isActionSource(1)).toBe(false)
})
