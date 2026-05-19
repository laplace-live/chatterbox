// Coverage for `src/lib/meme-trending.ts` — the trending-meme map that backs
// the 🔥 badge in the meme library. Mirrors the radar-client test pattern:
// HTTP goes through the project's `_setGmXhrForTests` DI seam (no
// `mock.module` of internal project modules).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { installGmStoreMock } from './_gm-store'

const { reset: resetGmStore } = installGmStoreMock()

const { _setGmXhrForTests } = await import('../src/lib/gm-fetch')
const { _resetTrendingMemesForTests, buildTrendingMap, lookupTrendingMatch, refreshTrendingMemes, trendingMemeKeys } =
  await import('../src/lib/meme-trending')
const { radarBackendUrlOverride, radarConsultEnabled } = await import('../src/lib/store-radar')

interface CapturedReq {
  url: string
  method: string
}
const captured: CapturedReq[] = []

type Responder = (req: CapturedReq) => {
  status?: number
  statusText?: string
  body?: string
  delayMs?: number
  throwError?: string
}

let responder: Responder = _req => ({ status: 200, body: '{"items": []}' })

interface XhrOpts {
  method: string
  url: string
  data?: string
  onload?: (r: {
    status: number
    statusText: string
    responseText: string
    responseHeaders: string
    finalUrl: string
  }) => void
  onerror?: (e: { error?: string }) => void
  ontimeout?: () => void
  onabort?: () => void
}

beforeEach(() => {
  resetGmStore()
  captured.length = 0
  responder = () => ({ status: 200, body: '{"items": []}' })
  radarBackendUrlOverride.value = ''
  // refreshTrendingMemes is now gated by `radarConsultEnabled` (default OFF
  // for user-privacy opt-in). These tests exercise the *happy* network path
  // and need the gate open. A dedicated consent-off test below covers the
  // gated-out branch.
  radarConsultEnabled.value = true
  _resetTrendingMemesForTests()

  _setGmXhrForTests(((opts: XhrOpts) => {
    captured.push({ url: opts.url, method: opts.method })
    const r = responder({ url: opts.url, method: opts.method })
    setTimeout(() => {
      if (r.throwError) {
        opts.onerror?.({ error: r.throwError })
        return
      }
      const status = r.status ?? 200
      opts.onload?.({
        status,
        statusText: r.statusText ?? (status === 200 ? 'OK' : ''),
        responseText: r.body ?? '',
        responseHeaders: '',
        finalUrl: opts.url,
      })
    }, r.delayMs ?? 0)
    return undefined as unknown as Parameters<typeof _setGmXhrForTests>[0]
  }) as unknown as Parameters<typeof _setGmXhrForTests>[0])
})

afterEach(() => {
  _setGmXhrForTests(null)
  _resetTrendingMemesForTests()
})

describe('buildTrendingMap (pure)', () => {
  test('empty input → empty map', () => {
    const map = buildTrendingMap([])
    expect(map.size).toBe(0)
  })

  test('clusters keyed by normalized representativeText, rank = index+1', () => {
    const map = buildTrendingMap([
      {
        id: 1,
        representativeText: '冲',
        memberCount: 50,
        distinctRoomCount: 5,
        distinctUidCount: 30,
        heatScore: 9,
        slopeScore: 4,
        firstSeenTs: 1,
        lastSeenTs: 2,
        status: 'active',
      },
      {
        id: 2,
        representativeText: '上车',
        memberCount: 30,
        distinctRoomCount: 4,
        distinctUidCount: 20,
        heatScore: 6,
        slopeScore: 3,
        firstSeenTs: 1,
        lastSeenTs: 2,
        status: 'active',
      },
    ])
    expect(map.size).toBe(2)
    expect(map.get('冲')).toEqual({ rank: 1, clusterId: 1, heatScore: 9, slopeScore: 4 })
    expect(map.get('上车')).toEqual({ rank: 2, clusterId: 2, heatScore: 6, slopeScore: 3 })
  })

  test('whitespace + case variants in representativeText collapse to the same key', () => {
    const map = buildTrendingMap([
      {
        id: 1,
        representativeText: '  COOL  ',
        memberCount: 1,
        distinctRoomCount: 1,
        distinctUidCount: 1,
        heatScore: 0,
        slopeScore: 0,
        firstSeenTs: 1,
        lastSeenTs: 2,
        status: 'active',
      },
    ])
    // memeContentKey lowercases + collapses whitespace + trims
    expect(map.get('cool')).toEqual({ rank: 1, clusterId: 1, heatScore: 0, slopeScore: 0 })
  })

  test('first cluster wins on key collision (hotter rank kept)', () => {
    const map = buildTrendingMap([
      {
        id: 1,
        representativeText: '冲',
        memberCount: 50,
        distinctRoomCount: 5,
        distinctUidCount: 30,
        heatScore: 9,
        slopeScore: 4,
        firstSeenTs: 1,
        lastSeenTs: 2,
        status: 'active',
      },
      {
        // Same normalized key as cluster #1 but ranked lower — must NOT
        // overwrite the rank-1 entry.
        id: 99,
        representativeText: ' 冲 ',
        memberCount: 1,
        distinctRoomCount: 1,
        distinctUidCount: 1,
        heatScore: 0,
        slopeScore: 0,
        firstSeenTs: 1,
        lastSeenTs: 2,
        status: 'active',
      },
    ])
    expect(map.size).toBe(1)
    expect(map.get('冲')?.rank).toBe(1)
    expect(map.get('冲')?.clusterId).toBe(1)
  })
})

describe('refreshTrendingMemes — radarConsultEnabled gate (default OFF)', () => {
  test('consent off: short-circuits with no network and empty signal', async () => {
    radarConsultEnabled.value = false
    responder = () => ({
      status: 200,
      body: JSON.stringify({
        items: [
          {
            id: 9,
            representativeText: '冲',
            memberCount: 1,
            distinctRoomCount: 1,
            distinctUidCount: 1,
            heatScore: 1,
            slopeScore: 1,
            firstSeenTs: 0,
            lastSeenTs: 0,
            status: 'active',
          },
        ],
      }),
    })
    await refreshTrendingMemes()
    expect(captured.length).toBe(0)
    expect(trendingMemeKeys.value.size).toBe(0)
  })

  test('toggle-off clears already-loaded badges immediately', async () => {
    responder = () => ({
      status: 200,
      body: JSON.stringify({
        items: [
          {
            id: 11,
            representativeText: '冲',
            memberCount: 1,
            distinctRoomCount: 1,
            distinctUidCount: 1,
            heatScore: 1,
            slopeScore: 1,
            firstSeenTs: 0,
            lastSeenTs: 0,
            status: 'active',
          },
        ],
      }),
    })
    await refreshTrendingMemes()
    expect(trendingMemeKeys.value.size).toBe(1)
    radarConsultEnabled.value = false
    expect(trendingMemeKeys.value.size).toBe(0)
  })
})

describe('refreshTrendingMemes (network + signal)', () => {
  test('happy path: populates trendingMemeKeys signal from /clusters/today', async () => {
    responder = () => ({
      status: 200,
      body: JSON.stringify({
        items: [
          {
            id: 7,
            representativeText: '冲',
            memberCount: 50,
            distinctRoomCount: 5,
            distinctUidCount: 30,
            heatScore: 9,
            slopeScore: 4,
            firstSeenTs: 1,
            lastSeenTs: 2,
            status: 'active',
          },
        ],
      }),
    })
    await refreshTrendingMemes()

    expect(captured.length).toBe(1)
    expect(captured[0].url).toContain('/radar/clusters/today')
    expect(captured[0].method).toBe('GET')
    expect(trendingMemeKeys.value.size).toBe(1)
    expect(lookupTrendingMatch('冲')).toEqual({ rank: 1, clusterId: 7, heatScore: 9, slopeScore: 4 })
  })

  test('TTL gate: a second call within the window does NOT re-fetch', async () => {
    responder = () => ({ status: 200, body: '{"items": []}' })
    await refreshTrendingMemes()
    await refreshTrendingMemes()
    await refreshTrendingMemes()

    expect(captured.length).toBe(1)
  })

  test('force=true bypasses the TTL', async () => {
    responder = () => ({ status: 200, body: '{"items": []}' })
    await refreshTrendingMemes()
    await refreshTrendingMemes(true)

    expect(captured.length).toBe(2)
  })

  test('concurrent callers share the in-flight promise (one network round trip)', async () => {
    // Hold the responder open for ~10 ms so all three calls overlap during the
    // in-flight window. Without dedup we'd see 3 captures; with dedup we see 1.
    responder = () => ({ status: 200, body: '{"items": []}', delayMs: 10 })

    const a = refreshTrendingMemes()
    const b = refreshTrendingMemes()
    const c = refreshTrendingMemes()
    await Promise.all([a, b, c])

    expect(captured.length).toBe(1)
  })

  test('HTTP error: trendingMemeKeys stays empty, no throw', async () => {
    responder = () => ({ status: 500, statusText: 'Internal Server Error', body: 'oops' })
    await refreshTrendingMemes()

    expect(captured.length).toBe(1)
    expect(trendingMemeKeys.value.size).toBe(0)
  })

  test('network error: trendingMemeKeys stays empty, no throw', async () => {
    responder = () => ({ throwError: 'NetworkError' })
    await refreshTrendingMemes()

    expect(captured.length).toBe(1)
    expect(trendingMemeKeys.value.size).toBe(0)
  })

  test('malformed JSON: trendingMemeKeys stays empty, no throw', async () => {
    responder = () => ({ status: 200, body: 'not json at all' })
    await refreshTrendingMemes()

    expect(trendingMemeKeys.value.size).toBe(0)
  })
})

describe('lookupTrendingMatch (UI-side query)', () => {
  test('exact text match hits', async () => {
    responder = () => ({
      status: 200,
      body: JSON.stringify({
        items: [
          {
            id: 1,
            representativeText: '冲',
            memberCount: 1,
            distinctRoomCount: 1,
            distinctUidCount: 1,
            heatScore: 0,
            slopeScore: 0,
            firstSeenTs: 1,
            lastSeenTs: 2,
            status: 'active',
          },
        ],
      }),
    })
    await refreshTrendingMemes()
    expect(lookupTrendingMatch('冲')).not.toBeNull()
  })

  test('whitespace and case variants normalize through to a hit', async () => {
    responder = () => ({
      status: 200,
      body: JSON.stringify({
        items: [
          {
            id: 1,
            representativeText: '冲鸭',
            memberCount: 1,
            distinctRoomCount: 1,
            distinctUidCount: 1,
            heatScore: 0,
            slopeScore: 0,
            firstSeenTs: 1,
            lastSeenTs: 2,
            status: 'active',
          },
        ],
      }),
    })
    await refreshTrendingMemes()
    expect(lookupTrendingMatch('  冲鸭  ')).not.toBeNull()
  })

  test('non-matching content returns null', async () => {
    responder = () => ({
      status: 200,
      body: JSON.stringify({
        items: [
          {
            id: 1,
            representativeText: '冲',
            memberCount: 1,
            distinctRoomCount: 1,
            distinctUidCount: 1,
            heatScore: 0,
            slopeScore: 0,
            firstSeenTs: 1,
            lastSeenTs: 2,
            status: 'active',
          },
        ],
      }),
    })
    await refreshTrendingMemes()
    expect(lookupTrendingMatch('完全不在榜')).toBeNull()
  })

  test('empty content returns null without touching the map', () => {
    expect(lookupTrendingMatch('')).toBeNull()
    expect(lookupTrendingMatch('   ')).toBeNull()
  })
})
