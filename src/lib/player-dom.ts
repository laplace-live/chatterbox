/** Single source of truth for reaching into bilibili's native live player DOM. */

/** bilibili's live player container. */
export const PLAYER_CONTAINER_SELECTOR = '#live-player'

/** The player's `<video>`; its presence also proxies "player bundle initialised". */
export const PLAYER_VIDEO_SELECTOR = `${PLAYER_CONTAINER_SELECTOR} video`

/** The native player's `<video>` element, or `null` when not mounted. */
export function getPlayerVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>(PLAYER_VIDEO_SELECTOR)
}

/**
 * Whether bilibili's native player is actively pulling the live stream.
 *
 * A `blob:` src means a MediaSource is attached and streaming; after
 * `stopPlayback()` the src reverts to a static poster `.mp4` and a reset
 * element is empty — both "not streaming".
 */
export function isNativePlayerStreaming(video: HTMLVideoElement): boolean {
  return video.src.startsWith('blob:')
}

/** The slice of a frame `window` that {@link resolveLivePlayer} reads. */
interface PlayerFrame {
  livePlayer?: unknown
  parent?: PlayerFrame
}

/**
 * Locate bilibili's `livePlayer` global by walking up the frame ancestor
 * chain from `start`, returning the first with a callable `stopPlayback`.
 *
 * The walk is required for micro-frontend activity pages (e.g. KPL rooms):
 * the room runs in a same-origin `/blanc/<id>` iframe but the shell installs
 * `livePlayer` on the TOP frame, so the player is one or more frames up.
 * `maxDepth` bounds the loop against a pathological ancestor cycle.
 */
export function resolveLivePlayer(start: PlayerFrame, maxDepth = 5): object | null {
  let win: PlayerFrame = start
  for (let depth = 0; depth < maxDepth; depth++) {
    try {
      const candidate = win.livePlayer
      if (
        typeof candidate === 'object' &&
        candidate !== null &&
        'stopPlayback' in candidate &&
        typeof candidate.stopPlayback === 'function'
      ) {
        return candidate
      }
    } catch {
      // Cross-origin ancestor: unreadable, and nothing beyond it is reachable.
      break
    }
    const parent = win.parent
    // `window.parent === window` at the top frame — terminator.
    if (!parent || parent === win) break
    win = parent
  }
  return null
}
