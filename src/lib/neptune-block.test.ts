import { describe, expect, test } from 'bun:test'

import { installNeptuneBlockTrap, stripRoomBlock } from './neptune-block'

const NEPTUNE_KEY = '__NEPTUNE_IS_MY_WAIFU__'

/** Capture-shaped SSR global (references/blocked-room.html); only the block_info path is load-bearing. */
function makeNeptune(block: boolean) {
  return {
    roomInitRes: { data: { room_id: 456117, playurl_info: null } },
    roomInfoRes: {
      code: 0,
      data: {
        room_info: { title: 'test' },
        block_info: { block, desc: '非常抱歉，当前直播间暂时无法展示', business: 3 },
      },
    },
  }
}

function blockOf(n: unknown): boolean | undefined {
  return (n as { roomInfoRes?: { data?: { block_info?: { block?: boolean } } } } | null)?.roomInfoRes?.data?.block_info
    ?.block
}

describe('stripRoomBlock', () => {
  test('flips block true → false', () => {
    const n = makeNeptune(true)
    expect(stripRoomBlock(n)).toBe(true)
    expect(n.roomInfoRes.data.block_info.block).toBe(false)
  })

  test('already false → no-op, returns false', () => {
    const n = makeNeptune(false)
    expect(stripRoomBlock(n)).toBe(false)
    expect(n.roomInfoRes.data.block_info.block).toBe(false)
  })

  test('idempotent on repeat', () => {
    const n = makeNeptune(true)
    stripRoomBlock(n)
    expect(stripRoomBlock(n)).toBe(false)
    expect(n.roomInfoRes.data.block_info.block).toBe(false)
  })

  test('missing / malformed shape → no throw, false', () => {
    expect(stripRoomBlock({})).toBe(false)
    expect(stripRoomBlock({ roomInfoRes: { data: {} } })).toBe(false)
    expect(stripRoomBlock(null)).toBe(false)
    expect(stripRoomBlock(undefined)).toBe(false)
  })

  test('leaves desc/business untouched', () => {
    const n = makeNeptune(true)
    stripRoomBlock(n)
    expect(n.roomInfoRes.data.block_info.desc).toBe('非常抱歉，当前直播间暂时无法展示')
    expect(n.roomInfoRes.data.block_info.business).toBe(3)
  })
})

describe('installNeptuneBlockTrap', () => {
  test('strips an assignment made after install', () => {
    const win: Record<string, unknown> = {}
    installNeptuneBlockTrap(win, () => true)
    win[NEPTUNE_KEY] = makeNeptune(true)
    expect(blockOf(win[NEPTUNE_KEY])).toBe(false)
  })

  test('getter returns the same object identity B站 assigned', () => {
    const win: Record<string, unknown> = {}
    installNeptuneBlockTrap(win, () => true)
    const assigned = makeNeptune(true)
    win[NEPTUNE_KEY] = assigned
    expect(win[NEPTUNE_KEY]).toBe(assigned)
    expect(assigned.roomInfoRes.data.block_info.block).toBe(false)
  })

  test('gate off leaves block untouched', () => {
    const win: Record<string, unknown> = {}
    installNeptuneBlockTrap(win, () => false)
    win[NEPTUNE_KEY] = makeNeptune(true)
    expect(blockOf(win[NEPTUNE_KEY])).toBe(true)
  })

  test('already-present global stripped on install', () => {
    const win: Record<string, unknown> = { [NEPTUNE_KEY]: makeNeptune(true) }
    installNeptuneBlockTrap(win, () => true)
    expect(blockOf(win[NEPTUNE_KEY])).toBe(false)
  })

  test('already-present + gate off → untouched', () => {
    const win: Record<string, unknown> = { [NEPTUNE_KEY]: makeNeptune(true) }
    installNeptuneBlockTrap(win, () => false)
    expect(blockOf(win[NEPTUNE_KEY])).toBe(true)
  })
})
