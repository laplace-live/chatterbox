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
