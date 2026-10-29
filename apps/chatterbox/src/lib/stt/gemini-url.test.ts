import { describe, expect, test } from 'bun:test'

import { buildGeminiLiveUrl } from './gemini-url'

const LIVE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

describe('buildGeminiLiveUrl', () => {
  test('defaults to Google with the key as `key`', () => {
    expect(buildGeminiLiveUrl('', 'k1')).toBe(`${LIVE}?key=k1`)
    expect(buildGeminiLiveUrl('  ', 'k1')).toBe(`${LIVE}?key=k1`)
  })

  test("ignores any path pasted with Google's own host", () => {
    expect(buildGeminiLiveUrl('https://generativelanguage.googleapis.com/v1beta/openai/', 'k1')).toBe(`${LIVE}?key=k1`)
  })

  test('maps any Cloudflare AI Gateway URL onto its Google realtime route', () => {
    const route = 'wss://gateway.ai.cloudflare.com/v1/acct/gw/google?api_key=k1'
    expect(buildGeminiLiveUrl('https://gateway.ai.cloudflare.com/v1/acct/gw', 'k1')).toBe(route)
    expect(
      buildGeminiLiveUrl('https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/v1beta/openai', 'k1')
    ).toBe(route)
    expect(buildGeminiLiveUrl('https://gateway.ai.cloudflare.com/v1/acct/gw/compat/', 'k1')).toBe(route)
  })

  test('appends the Live path to a reverse-proxy root, keeping its scheme', () => {
    expect(buildGeminiLiveUrl('https://proxy.example.com/gemini/', 'k1')).toBe(
      'wss://proxy.example.com/gemini/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=k1'
    )
    expect(buildGeminiLiveUrl('http://127.0.0.1:8787', 'k1')).toBe(
      'ws://127.0.0.1:8787/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=k1'
    )
  })

  test('encodes the key', () => {
    expect(buildGeminiLiveUrl('', 'a b&c')).toBe(`${LIVE}?key=a+b%26c`)
  })

  test('rejects non-URLs and non-web schemes', () => {
    expect(() => buildGeminiLiveUrl('gateway.ai.cloudflare.com/v1/acct/gw', 'k1')).toThrow('接口地址无效')
    expect(() => buildGeminiLiveUrl('ftp://example.com', 'k1')).toThrow('接口地址须以 https:// 或 http:// 开头')
  })
})
