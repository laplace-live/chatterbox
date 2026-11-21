import { effect, untracked } from '@preact/signals'

import { autoBlendDecisionEnabled } from '../decision-settings'
import { aiChatEnabled, autoBlendEnabled, autoBlendYolo, visionClipEnabled, visionEnabled, visionMode } from '../store'
import { startCaptioner, stopCaptioner } from './captioner'
import { isClipRecordingSupported, startClipRecorder, stopClipRecorder } from './clip-recorder'
import { startFrameSampler, stopFrameSampler } from './frame-sampler'

interface Demand {
  sampler: boolean
  captioner: boolean
  clip: boolean
}

const IDLE: Demand = { sampler: false, captioner: false, clip: false }

let running = IDLE
let disposeEffect: (() => void) | null = null

/** Start and stop parts to match `next`; the captioner and clip recorder read the sampler, so they stop first and start last. */
function apply(next: Demand): void {
  if (running.clip && !next.clip) stopClipRecorder()
  if (running.captioner && !next.captioner) stopCaptioner()
  if (running.sampler && !next.sampler) stopFrameSampler()
  if (next.sampler && !running.sampler) startFrameSampler()
  if (next.captioner && !running.captioner) startCaptioner()
  if (next.clip && !running.clip) startClipRecorder()
  running = next
}

/** Signal-driven: starts/stops sampler, captioner and clip recorder from settings and consumer state. Idempotent. */
export function startVisionController(): void {
  if (disposeEffect) return
  disposeEffect = effect(() => {
    const enabled = visionEnabled.value
    const mode = visionMode.value
    const clipEnabled = visionClipEnabled.value
    const aiChat = aiChatEnabled.value
    const blendNotes = autoBlendEnabled.value && (autoBlendDecisionEnabled.value || autoBlendYolo.value)
    const next: Demand = {
      sampler: enabled && (mode === 'direct' ? aiChat : aiChat || blendNotes),
      captioner: enabled && mode === 'caption' && (aiChat || blendNotes),
      clip: enabled && mode === 'direct' && clipEnabled && aiChat && isClipRecordingSupported(),
    }
    // Parts read signals while starting; those must not re-run this effect.
    untracked(() => apply(next))
  })
}

/** Stops whatever `startVisionController` started. */
export function stopVisionController(): void {
  disposeEffect?.()
  disposeEffect = null
  apply(IDLE)
}
