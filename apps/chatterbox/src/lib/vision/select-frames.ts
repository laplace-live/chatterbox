import type { LabeledFrame, VisionFrame } from './types'

import { KEEP_DIFF, lumaDiff } from './luma'

/** 'N 秒前' (rounded, min 1) for past frames, '当前' when `at >= currentAt`. */
export function frameLabel(at: number, currentAt: number): string {
  if (at >= currentAt) return '当前'
  return `${Math.max(1, Math.round((currentAt - at) / 1000))} 秒前`
}

/** `current` plus up to `max − 1` kept frames from `[from, current.at)`, greedily the farthest in luma from those picked until under KEEP_DIFF; oldest first, labelled. */
export function selectFrames(opts: {
  kept: readonly VisionFrame[]
  current: VisionFrame
  from: number
  max: number
}): LabeledFrame[] {
  const { kept, current, from, max } = opts
  const picked = [current]
  const candidates = kept.filter(frame => frame.at >= from && frame.at < current.at)
  while (picked.length < max && candidates.length > 0) {
    let bestIndex = 0
    let bestDistance = -1
    for (const [index, frame] of candidates.entries()) {
      const distance = Math.min(...picked.map(pick => lumaDiff(frame.luma, pick.luma)))
      if (distance > bestDistance) {
        bestIndex = index
        bestDistance = distance
      }
    }
    if (bestDistance < KEEP_DIFF) break
    picked.push(...candidates.splice(bestIndex, 1))
  }
  return picked.sort((a, b) => a.at - b.at).map(frame => ({ ...frame, label: frameLabel(frame.at, current.at) }))
}
