import { describe, expect, test } from 'bun:test'

import { floatTo16, int16ToBase64 } from './audio'

// Scribe expects little-endian s16, so the base64 test decodes exact bytes.
describe('floatTo16', () => {
  test('maps silence, full-scale, and clamps out-of-range samples', () => {
    const out = floatTo16(new Float32Array([0, 1, -1, 2, -2]))
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(32767)
    expect(out[2]).toBe(-32768)
    expect(out[3]).toBe(32767)
    expect(out[4]).toBe(-32768)
  })

  test('produces an Int16Array of equal length', () => {
    expect(floatTo16(new Float32Array(320)).length).toBe(320)
  })
})

describe('int16ToBase64', () => {
  test('encodes little-endian bytes', () => {
    // 1 → 0x01 0x00, -1 → 0xff 0xff (little-endian s16)
    const decoded = atob(int16ToBase64(new Int16Array([1, -1])))
    expect(decoded.length).toBe(4)
    expect(decoded.charCodeAt(0)).toBe(0x01)
    expect(decoded.charCodeAt(1)).toBe(0x00)
    expect(decoded.charCodeAt(2)).toBe(0xff)
    expect(decoded.charCodeAt(3)).toBe(0xff)
  })

  test('handles an empty buffer', () => {
    expect(int16ToBase64(new Int16Array(0))).toBe('')
  })
})
