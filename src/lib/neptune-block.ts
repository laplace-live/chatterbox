const NEPTUNE_KEY = '__NEPTUNE_IS_MY_WAIFU__'

/** Relevant slice of B站's SSR global; every field optional — we traverse defensively. */
interface NeptuneState {
  roomInfoRes?: {
    data?: {
      block_info?: { block?: boolean; desc?: string; business?: number }
    }
  }
}

/** Clear the room-display block (`roomInfoRes.data.block_info.block`) in place. Idempotent; true iff it changed something. */
export function stripRoomBlock(neptune: unknown): boolean {
  const blockInfo = (neptune as NeptuneState | null | undefined)?.roomInfoRes?.data?.block_info
  if (blockInfo?.block) {
    blockInfo.block = false
    console.log('[LAPLACE Chatterbox] Room display block removed (block_info)')
    return true
  }
  return false
}

/**
 * Trap `__NEPTUNE_IS_MY_WAIFU__` on `target` so B站's SSR assignment is stripped
 * before any consumer (SPA / player bootstrap) reads it. Install at document-start.
 * `isEnabled` is re-checked per assignment (toggling is 刷新生效); `onStripped` fires
 * only when a block was actually cleared. Fails open.
 */
export function installNeptuneBlockTrap(target: object, isEnabled: () => boolean, onStripped?: () => void): void {
  const win = target as Record<string, unknown>
  try {
    // Lost the race (global already assigned): strip in place, no trap needed.
    if (win[NEPTUNE_KEY]) {
      if (isEnabled() && stripRoomBlock(win[NEPTUNE_KEY])) onStripped?.()
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
        if (isEnabled() && stripRoomBlock(v)) onStripped?.()
        backing = v
      },
    })
  } catch (err) {
    console.error('[LAPLACE Chatterbox] Failed to install NEPTUNE block trap:', err)
  }
}
