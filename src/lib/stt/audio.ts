/**
 * PCM audio helpers for the raw ElevenLabs Scribe WebSocket.
 *
 * Pure and dependency-free (no DOM, no SDK) so they're unit-testable under
 * Bun. The engine captures mic audio as Float32 frames via an AudioWorklet
 * and uses these to produce the base64 PCM16 the wire protocol expects.
 */

/**
 * Float32 samples in [-1, 1] → little-endian Int16 PCM (s16le), the encoding
 * ElevenLabs' `audio_format=pcm_16000` expects. Out-of-range samples clamp.
 */
export function floatTo16(input: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]))
    out[i] = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff)
  }
  return out
}

/**
 * Int16 PCM → base64 of its raw little-endian bytes, for the `audio_base_64`
 * field. Encoded in chunks so a large buffer can't overflow the argument limit
 * of `String.fromCharCode`.
 */
export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
