/**
 * Regression tests for `decideHzmMount` —— 智驾面板挂载决策。
 *
 * Codex round-1 (PR #36): drive 跑着时 memesCount 跌破 10 不能 unmount,否则用户找不到停车按钮。
 * Codex round-2 (PR #36): `currentMemesList` 是全局 + 异步更新,SPA 切房间到 loadMemes 完成
 *   的窗口期里它仍然是前一个房间的数据;不校验 roomId 归属会让陈旧 count ≥10 误通过 gate,
 *   用户开车 → 智驾用旧房间的梗发到新房间。
 *
 * 把决策抽成纯函数 `decideHzmMount` + 暴露 `memesRoomId` 参数,就是为了能在这里稳定断言,
 * 不需要起 Preact 渲染。
 */

import { describe, expect, test } from 'bun:test'

import type { MemeSource } from '../src/lib/meme-sources'

import { decideHzmMount, MIN_MEMES_FOR_GENERIC_DRIVE } from '../src/components/hzm-drive-panel'

const NATIVE_SOURCE: MemeSource = {
  roomId: 1713546334,
  name: '灰泽满烂梗库',
  listEndpoint: 'https://sbhzm.cn/api/public/memes',
}

const FRESH = (roomId: number) => ({ memesRoomId: roomId }) // helper:list 属于当前房间

describe('decideHzmMount', () => {
  test('null roomId → none', () => {
    const result = decideHzmMount({
      roomId: null,
      source: null,
      memesCount: 100,
      memesRoomId: 99999,
      driveEnabled: false,
    })
    expect(result.kind).toBe('none')
  })

  test('native source: mounts regardless of memesCount / memesRoomId / driveEnabled', () => {
    for (const memesCount of [0, 5, 100]) {
      for (const driveEnabled of [false, true]) {
        for (const memesRoomId of [null, 1713546334, 99999]) {
          const result = decideHzmMount({
            roomId: 1713546334,
            source: NATIVE_SOURCE,
            memesCount,
            memesRoomId,
            driveEnabled,
          })
          expect(result).toEqual({ kind: 'native', source: NATIVE_SOURCE })
        }
      }
    }
  })

  test('no source + drive off + memesCount<10 → none', () => {
    const result = decideHzmMount({
      roomId: 99999,
      source: null,
      memesCount: MIN_MEMES_FOR_GENERIC_DRIVE - 1,
      ...FRESH(99999),
      driveEnabled: false,
    })
    expect(result.kind).toBe('none')
  })

  test('no source + drive off + memesCount≥10 + fresh roomId → synthetic', () => {
    const result = decideHzmMount({
      roomId: 99999,
      source: null,
      memesCount: MIN_MEMES_FOR_GENERIC_DRIVE,
      ...FRESH(99999),
      driveEnabled: false,
    })
    expect(result).toEqual({ kind: 'synthetic', roomId: 99999 })
  })

  test('REGRESSION (round-1): drive ON + memesCount<10 + fresh → still synthetic (panel must stay mounted)', () => {
    for (const memesCount of [0, 1, 5, MIN_MEMES_FOR_GENERIC_DRIVE - 1]) {
      const result = decideHzmMount({
        roomId: 99999,
        source: null,
        memesCount,
        ...FRESH(99999),
        driveEnabled: true,
      })
      expect(result).toEqual({ kind: 'synthetic', roomId: 99999 })
    }
  })

  // --- Codex round-2: stale-room guard ---

  test('REGRESSION (round-2): SPA 切房间窗口期 — 旧房间 memesCount=100,新房间 gate 必须 fail', () => {
    // 用户从 roomA(1000 条梗)SPA 切到 roomB,loadMemes 还没回来。
    // currentMemesList 仍然有 1000 条 roomA 的梗,memesRoomId 还是 roomA 的 id。
    // 期望:gate 把 memesCount 视为 0,返回 none。否则用户开车会把 roomA 的梗发到 roomB。
    const result = decideHzmMount({
      roomId: 99999, // 新房间 (roomB)
      source: null,
      memesCount: 1000, // 旧房间 (roomA) 的数据残留
      memesRoomId: 11111, // 旧房间 id
      driveEnabled: false,
    })
    expect(result.kind).toBe('none')
  })

  test('REGRESSION (round-2): memesRoomId=null (从未 load 过) + memesCount=N → 视为 0', () => {
    // 防御性:initial state 时 memesRoomId 是 null。memesCount 应该也是 0,
    // 但即使有上游 bug 让两者不同步,gate 也要 fail-closed。
    const result = decideHzmMount({
      roomId: 99999,
      source: null,
      memesCount: 50, // 不合常理但要 fail-closed
      memesRoomId: null,
      driveEnabled: false,
    })
    expect(result.kind).toBe('none')
  })

  test('round-2 + round-1 combined: stale memes + drive ON → still synthetic (drive 在跑必须可见)', () => {
    // 罕见但要正确:用户在 roomA 开了 drive 然后 SPA 切到 roomB。drive 还在跑(因为
    // hzmDriveEnabled 没有 auto-stop on room change —— 这是另一层 bug,但本测试只验证
    // gate 决策:drive 在跑时永远挂载,不看 memes 归属。
    const result = decideHzmMount({
      roomId: 99999,
      source: null,
      memesCount: 1000,
      memesRoomId: 11111, // 旧房间
      driveEnabled: true,
    })
    expect(result).toEqual({ kind: 'synthetic', roomId: 99999 })
  })

  test('exact threshold: memesCount = MIN_MEMES_FOR_GENERIC_DRIVE + fresh → synthetic (≥, not >)', () => {
    const result = decideHzmMount({
      roomId: 99999,
      source: null,
      memesCount: MIN_MEMES_FOR_GENERIC_DRIVE,
      ...FRESH(99999),
      driveEnabled: false,
    })
    expect(result.kind).toBe('synthetic')
  })

  test('synthetic decision carries roomId through (for makeSyntheticSource)', () => {
    const result = decideHzmMount({ roomId: 42, source: null, memesCount: 50, ...FRESH(42), driveEnabled: false })
    expect(result).toEqual({ kind: 'synthetic', roomId: 42 })
  })
})
