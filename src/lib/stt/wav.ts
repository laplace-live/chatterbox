/** Pure RIFF/WAV writer for batch STT endpoints that take a file upload instead of a stream. */

/** Bytes of RIFF header preceding the sample data. */
const HEADER_BYTES = 44

/**
 * Wrap mono s16le PCM in a WAV container. `samples` must already be at `sampleRate`.
 *
 * Sample bytes are copied via `Int16Array.set`, so this assumes a little-endian
 * host — same assumption `int16ToBase64` already makes.
 */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2
  const out = new Uint8Array(HEADER_BYTES + dataBytes)
  const view = new DataView(out.buffer)

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')

  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)

  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)

  new Int16Array(out.buffer, HEADER_BYTES).set(samples)
  return out
}
