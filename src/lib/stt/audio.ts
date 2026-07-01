/** Pure, dependency-free PCM helpers for the raw ElevenLabs Scribe WebSocket. */

/** Float32 [-1, 1] → little-endian Int16 PCM (s16le); out-of-range samples clamp. */
export function floatTo16(input: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]))
    out[i] = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff)
  }
  return out
}

/** Int16 PCM → base64; chunked so large buffers can't overflow `String.fromCharCode` arg limit. */
export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
