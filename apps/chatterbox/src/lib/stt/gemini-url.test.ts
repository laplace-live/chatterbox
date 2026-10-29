import { describe, expect, test } from 'bun:test'

import { buildGeminiLiveUrl, buildGeminiModelsUrl } from './gemini-url'

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

  test('allows plain HTTP only for loopback roots', () => {
    const path = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=k1'
    expect(buildGeminiLiveUrl('http://localhost:8787', 'k1')).toBe(`ws://localhost:8787${path}`)
    expect(buildGeminiLiveUrl('http://gemini.localhost', 'k1')).toBe(`ws://gemini.localhost${path}`)
    expect(buildGeminiLiveUrl('http://[::1]:8787', 'k1')).toBe(`ws://[::1]:8787${path}`)
    for (const remote of ['http://proxy.example.com', 'http://192.168.1.10:8787', 'ws://example.com/gemini']) {
      expect(() => buildGeminiLiveUrl(remote, 'k1')).toThrow('非本机接口地址须使用 https://')
      expect(() => buildGeminiModelsUrl(remote)).toThrow('非本机接口地址须使用 https://')
    }
  })

  test('encodes the key', () => {
    expect(buildGeminiLiveUrl('', 'a b&c')).toBe(`${LIVE}?key=a+b%26c`)
  })

  test('rejects non-URLs and non-web schemes', () => {
    expect(() => buildGeminiLiveUrl('gateway.ai.cloudflare.com/v1/acct/gw', 'k1')).toThrow('接口地址无效')
    expect(() => buildGeminiLiveUrl('ftp://example.com', 'k1')).toThrow('接口地址须以 https:// 或 http:// 开头')
  })
})

describe('buildGeminiModelsUrl', () => {
  test('lists from the same root as the Live socket', () => {
    expect(buildGeminiModelsUrl('')).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000')
    expect(buildGeminiModelsUrl('https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/v1beta/openai')).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/v1beta/models?pageSize=1000'
    )
    expect(buildGeminiModelsUrl('wss://proxy.example.com/gemini/')).toBe(
      'https://proxy.example.com/gemini/v1beta/models?pageSize=1000'
    )
    expect(buildGeminiModelsUrl('ws://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/v1beta/models?pageSize=1000')
  })

  test('rejects an unusable root', () => {
    expect(() => buildGeminiModelsUrl('ftp://example.com')).toThrow('接口地址须以 https:// 或 http:// 开头')
  })
})
