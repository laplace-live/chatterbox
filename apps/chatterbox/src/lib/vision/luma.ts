/** Change-detection grid width (px); 32×18 keeps 16:9. */
export const LUMA_WIDTH = 32
/** Change-detection grid height (px). */
export const LUMA_HEIGHT = 18
/** Sample diff at which a frame counts as visually new and is kept. */
export const KEEP_DIFF = 6
/** Diff below which two frames show the same picture. */
export const SAME_SCENE_DIFF = 4
/** Diff between consecutive samples that counts as a scene cut. */
export const SCENE_CUT_DIFF = 32
/** Variance below which a frame is blank (black preroll, solid cover). */
export const BLANK_VARIANCE = 25

/** Rec.601 luma of an RGBA buffer, one byte per pixel. */
export function rgbaToLuma(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const luma = new Uint8Array(Math.floor(rgba.length / 4))
  for (let i = 0; i < luma.length; i++) {
    const p = i * 4
    luma[i] = Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2])
  }
  return luma
}

/** Mean absolute difference, 0–255; buffers of different length → 255. */
export function lumaDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 255
  if (a.length === 0) return 0
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

/** Population variance of a luma buffer. */
export function lumaVariance(luma: Uint8Array): number {
  if (luma.length === 0) return 0
  let sum = 0
  for (const value of luma) sum += value
  const mean = sum / luma.length
  let squares = 0
  for (const value of luma) squares += (value - mean) ** 2
  return squares / luma.length
}
