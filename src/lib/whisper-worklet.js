/**
 * AudioWorklet processor source for Whisper PCM capture.
 *
 * Loaded as a `?raw` string (same pattern as `whisper-worker.ts`)
 * and registered via `AudioWorklet.addModule(blobUrl)`. The
 * processor runs on the audio thread and forwards every render
 * quantum (128 samples by default) of the input channel to the
 * main thread via `port.postMessage`.
 *
 * **CRITICAL:** body must be valid JavaScript — no TypeScript
 * syntax. Same rule as `whisper-worker.ts`. The file extension is
 * `.ts` only so it lives alongside its siblings in the linter /
 * type-checker; its contents are JS.
 *
 * Why AudioWorklet and not MediaRecorder:
 * - MediaRecorder emits compressed webm/opus chunks that have to
 *   be Blob-concatenated and decoded via `decodeAudioData` every
 *   pass. With a continuously-growing chunks array, that's an
 *   O(N) operation done N times per minute — quadratic CPU growth
 *   that surfaced as "the transcription slows down after 1 minute"
 *   in dogfood testing. Worse, the unbounded chunks array leaks
 *   memory linearly with session length.
 * - AudioWorklet hands us raw 32-bit float samples at the
 *   AudioContext's sample rate (16 kHz here). No decode step, no
 *   compressed-container intermediate. We maintain a fixed-size
 *   ring buffer on the main thread, so per-pass cost is constant
 *   regardless of session length.
 */

// Body is shipped as raw text to AudioWorklet — JSDoc-only typing.
// `AudioWorkletProcessor`, `registerProcessor`, and the global
// `currentTime` / `sampleRate` come from `@types/audioworklet`,
// which we register as a triple-slash reference here so this file
// can be `checkJs`-validated without polluting the project-wide
// DOM lib (the AudioWorklet globals collide with main-thread
// types).

/// <reference types="@types/audioworklet" />

class CaptureProcessor extends AudioWorkletProcessor {
  /**
   * @param {Float32Array[][]} inputs
   * @returns {boolean}
   */
  process(inputs) {
    // `inputs[0]` is the first connected input, `[0]` is the
    // first (and only) channel — we constrain `getUserMedia` to
    // mono so this is always a Float32Array of 128 samples per
    // call (default quantum) at the AudioContext's sample rate.
    const ch = inputs[0]?.[0]
    if (ch?.length) {
      // `slice()` is required: the Float32Array we receive is
      // backed by a buffer the audio runtime recycles between
      // render quanta. Posting the live view would deliver
      // garbage by the time the main thread reads it.
      this.port.postMessage(ch.slice())
    }
    return true
  }
}

registerProcessor('chatterbox-capture', CaptureProcessor)
