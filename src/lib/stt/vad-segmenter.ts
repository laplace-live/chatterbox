/**
 * Energy-VAD segmenter: turns a continuous PCM16 frame stream into speech
 * segments cut on silence, so a batch STT upload boundary never lands mid-word.
 * Pure (no DOM, no network) — frames in, segments out.
 */

/** RMS is measured per sub-block; capture frames (256 ms) are too coarse to place a cut. */
const SUB_BLOCK_MS = 64
/** Audio kept from before speech onset so the first phoneme isn't clipped. */
const PRE_ROLL_MS = 200
/** Trailing silence that closes a segment. */
const SILENCE_CLOSE_MS = 600
/** Segments with less speech than this are noise blips, not utterances. */
const MIN_SPEECH_MS = 1000
/** Force-flush cap so continuous speech still gets transcribed. */
const MAX_SEGMENT_MS = 15_000
/** Speech gate sits this far above the tracked noise floor. */
const GATE_RATIO = 3
/** Gate floor, so a near-silent input can't gate open. */
const ABSOLUTE_MIN_RMS = 0.004
/**
 * Noise floor snaps down to any new minimum and creeps up ~0.4%/sub-block (e-fold
 * ≈ 16 s). Tracked in every state: an EMA gated on "not speaking" would latch
 * forever the first time sustained background audio tripped the gate.
 */
const FLOOR_RISE_PER_BLOCK = 0.004

export interface VadSegmenterOptions {
  sampleRate: number
  /** Called with one closed segment of mono s16le PCM. */
  onSegment: (samples: Int16Array) => void
}

export interface VadSegmenter {
  /** Feed one capture frame. */
  push: (frame: Int16Array) => void
  /** Force-close the open segment (session end); emits it regardless of {@link MIN_SPEECH_MS} unless it holds no speech at all. */
  flush: () => void
}

/** Root-mean-square of an s16 block, normalized to 0…1. */
function rmsOf(block: Int16Array): number {
  let sum = 0
  for (let i = 0; i < block.length; i++) {
    const sample = block[i] / 0x8000
    sum += sample * sample
  }
  return Math.sqrt(sum / block.length)
}

function concat(blocks: Int16Array[], total: number): Int16Array {
  const out = new Int16Array(total)
  let offset = 0
  for (const block of blocks) {
    out.set(block, offset)
    offset += block.length
  }
  return out
}

export function createVadSegmenter(opts: VadSegmenterOptions): VadSegmenter {
  const perMs = opts.sampleRate / 1000
  const subBlockSamples = Math.max(1, Math.round(SUB_BLOCK_MS * perMs))
  const preRollBlocks = Math.ceil(PRE_ROLL_MS / SUB_BLOCK_MS)
  const silenceCloseSamples = SILENCE_CLOSE_MS * perMs
  const minSpeechSamples = MIN_SPEECH_MS * perMs
  const maxSegmentSamples = MAX_SEGMENT_MS * perMs

  // Seeded from the first sub-block: starting mid-sentence would otherwise read
  // speech as the floor until the first inter-word gap resets it.
  let noiseFloor = -1
  let inSpeech = false
  let segment: Int16Array[] = []
  let segmentSamples = 0
  let speechSamples = 0
  let silenceSamples = 0
  let preRoll: Int16Array[] = []
  // A force-flushed segment continues mid-utterance, so its tail isn't held to the min-speech rule.
  let continuation = false
  // Sub-block remainder carried between frames; frame size need not divide evenly.
  let pending: Int16Array[] = []
  let pendingSamples = 0

  const emit = (minSamples: number): void => {
    if (speechSamples >= minSamples && segmentSamples > 0) {
      opts.onSegment(concat(segment, segmentSamples))
    }
    segment = []
    segmentSamples = 0
    speechSamples = 0
    silenceSamples = 0
  }

  const endSegment = (minSamples: number): void => {
    emit(minSamples)
    continuation = false
    inSpeech = false
    preRoll = []
  }

  const handleSubBlock = (block: Int16Array): void => {
    const rms = rmsOf(block)
    const tracked = noiseFloor < 0 ? rms : Math.min(rms, noiseFloor * (1 + FLOOR_RISE_PER_BLOCK))
    noiseFloor = Math.max(tracked, ABSOLUTE_MIN_RMS)

    const isSpeech = rms > noiseFloor * GATE_RATIO

    if (!inSpeech) {
      if (!isSpeech) {
        preRoll.push(block)
        while (preRoll.length > preRollBlocks) preRoll.shift()
        return
      }
      inSpeech = true
      segment = [...preRoll, block]
      segmentSamples = segment.reduce((n, b) => n + b.length, 0)
      speechSamples = block.length
      silenceSamples = 0
      preRoll = []
      return
    }

    segment.push(block)
    segmentSamples += block.length
    if (isSpeech) {
      speechSamples += block.length
      silenceSamples = 0
    } else {
      silenceSamples += block.length
    }

    if (silenceSamples >= silenceCloseSamples) {
      // Continuation tails skip the min-speech rule but still need ≥1 speech sample — a pure-silence tail is Whisper's favorite hallucination input.
      endSegment(continuation ? 1 : minSpeechSamples)
      return
    }
    if (segmentSamples >= maxSegmentSamples) {
      emit(continuation ? 1 : minSpeechSamples)
      continuation = true
    }
  }

  return {
    push: (frame: Int16Array): void => {
      pending.push(frame)
      pendingSamples += frame.length
      if (pendingSamples < subBlockSamples) return

      // Common case: one whole frame, no copy. Sub-blocks are subarray views; floatTo16 hands over a fresh buffer per frame.
      const merged = pending.length === 1 ? pending[0] : concat(pending, pendingSamples)
      let offset = 0
      while (offset + subBlockSamples <= merged.length) {
        handleSubBlock(merged.subarray(offset, offset + subBlockSamples))
        offset += subBlockSamples
      }
      const rest = merged.subarray(offset)
      pending = rest.length > 0 ? [rest.slice()] : []
      pendingSamples = rest.length
    },

    flush: (): void => {
      if (!inSpeech) return
      // Ragged remainder retained by push(): under one sub-block, never gated — append raw so the tail isn't dropped.
      if (pendingSamples > 0) {
        segment.push(concat(pending, pendingSamples))
        segmentSamples += pendingSamples
        pending = []
        pendingSamples = 0
      }
      endSegment(1)
    },
  }
}
