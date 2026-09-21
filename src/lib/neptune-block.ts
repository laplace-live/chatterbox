import { isRecord, readPath } from './utils'

const NEPTUNE_KEY = '__NEPTUNE_IS_MY_WAIFU__'

/** Clear the room-display block (`roomInfoRes.data.block_info.block`) in place. Idempotent; true iff it changed something. */
export function stripRoomBlock(neptune: unknown): boolean {
  const blockInfo = readPath(neptune, 'roomInfoRes', 'data', 'block_info')
  if (isRecord(blockInfo) && blockInfo.block) {
    blockInfo.block = false
    console.log('[LAPLACE Chatterbox] Room display block removed (block_info)')
    return true
  }
  return false
}

/**
 * Trap `__NEPTUNE_IS_MY_WAIFU__` on `target` so B站's SSR assignment is stripped
 * before any consumer (SPA / player bootstrap) reads it. Install at document-start.
 * `onStripped` fires only when a block was actually cleared. Fails open.
 */
export function installNeptuneBlockTrap(target: object, onStripped?: () => void): void {
  try {
    // Lost the race (global already assigned): strip in place, no trap needed.
    if (NEPTUNE_KEY in target && target[NEPTUNE_KEY]) {
      if (stripRoomBlock(target[NEPTUNE_KEY])) onStripped?.()
      return
    }
    let backing: unknown
    Object.defineProperty(target, NEPTUNE_KEY, {
      configurable: true,
      enumerable: true,
      get() {
        return backing
      },
      set(v: unknown) {
        if (stripRoomBlock(v)) onStripped?.()
        backing = v
      },
    })
  } catch (err) {
    console.error('[LAPLACE Chatterbox] Failed to install NEPTUNE block trap:', err)
  }
}
