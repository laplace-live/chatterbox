import { describe, expect, test } from 'bun:test'

import { encodeWav } from './wav'

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length))

describe('encodeWav', () => {
  test('writes a 44-byte RIFF/WAVE header with little-endian sizes', () => {
    const out = encodeWav(new Int16Array([0, 1, -1, 2]), 16000)
    const view = new DataView(out.buffer)

    expect(out.length).toBe(44 + 8)
    expect(ascii(out, 0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 8)
    expect(ascii(out, 8, 4)).toBe('WAVE')
    expect(ascii(out, 12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(ascii(out, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(8)
  })

  test('derives byte rate and block align from a mono s16 layout', () => {
    const view = new DataView(encodeWav(new Int16Array(0), 44100).buffer)
    expect(view.getUint32(24, true)).toBe(44100)
    expect(view.getUint32(28, true)).toBe(44100 * 2)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
  })

  test('round-trips sample data after the header', () => {
    const samples = new Int16Array([0, 32767, -32768, 1234])
    const out = encodeWav(samples, 16000)
    expect(Array.from(new Int16Array(out.buffer, 44))).toEqual(Array.from(samples))
  })

  test('handles an empty segment', () => {
    const out = encodeWav(new Int16Array(0), 16000)
    expect(out.length).toBe(44)
    expect(new DataView(out.buffer).getUint32(40, true)).toBe(0)
  })
})
