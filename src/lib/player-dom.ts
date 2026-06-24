/**
 * Single source of truth for reaching into bilibili's native live player
 * DOM. The player container id and its `<video>` element are referenced
 * from several modules (`audio-only`, `auto-quality`, `auto-seek`) as both
 * the player-ready proxy and the actual media target; before this they
 * were hardcoded in each file (and the selector constant was even
 * redeclared verbatim in two of them, with a "kept in sync intentionally"
 * comment). Centralizing means a future bilibili DOM shake-up is a
 * one-line change here.
 *
 * Pure value constants + thin DOM accessors — no app state, no signals —
 * so any player-touching module can depend on it without coupling.
 */

/** bilibili's live player container. */
export const PLAYER_CONTAINER_SELECTOR = '#live-player'

/**
 * The player's `<video>` element. Its presence is also our cheap proxy
 * for "bilibili's player bundle has initialised far enough that
 * `window.livePlayer` should be available", which is why a few callers
 * use it purely as a mount sentinel inside MutationObserver filters.
 */
export const PLAYER_VIDEO_SELECTOR = `${PLAYER_CONTAINER_SELECTOR} video`

/** The native player's `<video>` element, or `null` when not mounted. */
export function getPlayerVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>(PLAYER_VIDEO_SELECTOR)
}

/**
 * Whether bilibili's native player is actively pulling the live stream.
 *
 * The tell is the `<video>` src: a `blob:` URL means a MediaSource is
 * attached and streaming. After `livePlayer.stopPlayback()` the src
 * reverts to a static poster `.mp4`, and a reset / un-mounted element has
 * an empty src — both read as "not streaming". audio-only's watchdog uses
 * this to detect another script re-engaging the player, and its
 * volume-restore uses it to wait until `reload()` has actually resumed
 * playback before writing the volume back.
 */
export function isNativePlayerStreaming(video: HTMLVideoElement): boolean {
  return video.src.startsWith('blob:')
}

/**
 * The slice of a frame `window` that {@link resolveLivePlayer} reads:
 * bilibili's optional `livePlayer` global and the `parent` link up the frame
 * tree. Structural and tiny on purpose — a real `Window` (and a test double)
 * satisfies it without a cast, so callers pass `unsafeWindow` directly.
 */
interface PlayerFrame {
  livePlayer?: unknown
  parent?: PlayerFrame
}

/**
 * Locate bilibili's `livePlayer` control global by walking up the frame
 * ancestor chain from `start`, returning the first one whose `stopPlayback`
 * is callable (our "this is the real, ready player" signal) — or `null`.
 *
 * Why a walk and not just `unsafeWindow.livePlayer`:
 *
 *   - On a normal live room, `livePlayer` is installed on the room's own
 *     window, so the walk resolves on its first step (depth 0).
 *   - On promotion / activity pages (e.g. `live.bilibili.com/55` KPL, the
 *     concert event rooms) bilibili uses a micro-frontend layout: the real
 *     room — and this userscript — runs inside a same-origin `/blanc/<id>`
 *     iframe, but the shell installs `livePlayer` on the TOP frame. The
 *     `<video>` we hide and control still lives in our iframe (verified: the
 *     top frame's `livePlayer.getVideoEl()` returns the iframe's
 *     `#live-player video`), so the player we need is one (or more) frames
 *     up. Without walking up we'd never find it and `stopPlayback()` would
 *     never fire — the native HLS pull keeps running and audio-only "does
 *     nothing".
 *
 * Returned as `object | null` — we've verified it's a non-null object with a
 * callable `stopPlayback`. Each caller assigns it straight to its own minimal
 * `LivePlayerLike`: those interfaces are all-optional, so `object` is
 * assignable to them with no cast. That keeps `audio-only` and `auto-quality`
 * on their own per-module player shapes rather than widening one to satisfy
 * the other.
 *
 * The reads are same-origin (the shell and `/blanc/` iframe share an
 * origin), so they don't throw; the `try`/`catch` is a guard for a
 * hypothetical future layout that nests a cross-origin frame between us and
 * the shell — we simply stop the walk there. `maxDepth` bounds the loop so a
 * pathological ancestor cycle can't spin.
 */
export function resolveLivePlayer(start: PlayerFrame, maxDepth = 5): object | null {
  let win: PlayerFrame = start
  for (let depth = 0; depth < maxDepth; depth++) {
    try {
      const candidate = win.livePlayer
      // A callable `stopPlayback` is our "real, ready player" signal; the
      // typeof / `in` narrowing reads it off `unknown` without a cast.
      if (
        typeof candidate === 'object' &&
        candidate !== null &&
        'stopPlayback' in candidate &&
        typeof candidate.stopPlayback === 'function'
      ) {
        return candidate
      }
    } catch {
      // Cross-origin ancestor: its globals aren't readable from here, and
      // nothing beyond that boundary will be either. Stop walking.
      break
    }
    const parent = win.parent
    // `window.parent === window` at the top frame — that's our terminator.
    if (!parent || parent === win) break
    win = parent
  }
  return null
}
