/** Supported long edges (px) for uploaded frames. */
export const VISION_EDGES: readonly number[] = [512, 768, 1024]

const DEFAULT_VISION_EDGE = 768
const DEFAULT_VISION_FRAMES = 2

/** Coerce a stored long-edge setting to a supported value (default 768). */
export function resolveVisionEdge(value: number): number {
  return VISION_EDGES.includes(value) ? value : DEFAULT_VISION_EDGE
}

/** Clamp frames-per-call to 1–4; non-finite → 2. */
export function clampVisionFrames(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VISION_FRAMES
  return Math.min(4, Math.max(1, Math.round(value)))
}

/** `width`×`height` scaled down (never up) so the long edge is at most `edge`, rounded to multiples of `step` px. */
export function fitLongEdge(width: number, height: number, edge: number, step = 1): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height, 1))
  const fit = (side: number) => Math.max(step, Math.round((side * scale) / step) * step)
  return { width: fit(width), height: fit(height) }
}
