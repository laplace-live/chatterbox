import { describe, expect, mock, test } from 'bun:test'
import { signal } from '@preact/signals'

import type { RoomPlayInfoResponse } from './audio-only'
import type { AudioOnlyMode } from './store'

import * as audioOnlyVolume from './audio-only-volume'
import * as constants from './const'
import * as playerDom from './player-dom'
import * as utils from './utils'

const source = await Bun.file(new URL('./audio-only.ts', import.meta.url)).text()
const transpiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
let moduleId = 0

function makePlayInfo(
  codec: Array<{
    current_qn?: number
    accept_qn?: number[]
    is_pushing?: boolean
    base_url?: string
    url_info?: Array<{ host?: string; extra?: string }>
  }>
): RoomPlayInfoResponse {
  return {
    code: 0,
    data: {
      live_status: 1,
      playurl_info: {
        playurl: {
          stream: [
            {
              protocol_name: 'http_stream',
              format: [{ format_name: 'flv', codec }],
            },
          ],
        },
      },
    },
  }
}

interface LoadAudioOnlyOptions {
  playInfoResponse?: unknown
  playImpl?: (url: string) => Promise<void>
}

interface FakeMpegtsPlayer {
  url: string
  listeners: Record<string, Array<(...args: unknown[]) => void>>
  destroyed: boolean
  on: (event: string, listener: (...args: unknown[]) => void) => void
  attachMediaElement: (el: unknown) => void
  load: () => void
  pause: () => void
  unload: () => void
  detachMediaElement: () => void
  destroy: () => void
}

interface FakeAudioElement {
  id: string
  style: { display: string }
  volume: number
  muted: boolean
  paused: boolean
  play: () => Promise<void>
  pause: () => void
  removeAttribute: (name: string) => void
  remove: () => void
  toggleAttribute: (name: string, force?: boolean) => boolean
}

async function loadAudioOnly(opts: LoadAudioOnlyOptions = {}) {
  const logs: string[] = []
  const createdPlayers: FakeMpegtsPlayer[] = []
  let activeUrl = ''
  let pendingPlayReject: ((err: unknown) => void) | null = null

  const stopPlayback = mock(() => {})
  const livePlayer = {
    getPlayerInfo: () => ({ volume: { value: 80, disabled: false } }),
    stopPlayback,
    reload() {},
  }

  const audioOnlyMode = signal<AudioOnlyMode>('off')
  const audioOnlyActive = signal(false)
  const audioOnlyVolumeSig = signal(1)
  const audioOnlyMutedSig = signal(false)

  const fakeAudio: FakeAudioElement = {
    id: '',
    style: { display: '' },
    volume: 1,
    muted: false,
    paused: true,
    play() {
      this.paused = false
      if (opts.playImpl) return opts.playImpl(activeUrl)
      return Promise.resolve()
    },
    pause() {
      this.paused = true
      if (pendingPlayReject) {
        const reject = pendingPlayReject
        pendingPlayReject = null
        reject(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'))
      }
    },
    removeAttribute() {},
    remove() {},
    toggleAttribute() {
      return false
    },
  }

  const fakeDocument = {
    pictureInPictureElement: null,
    documentElement: {
      classList: {
        toggle() {},
        remove() {},
      },
    },
    head: {
      appendChild() {},
    },
    body: {
      appendChild() {},
    },
    getElementById() {
      return null
    },
    createElement(tag: string) {
      if (tag === 'audio') return fakeAudio
      return { id: '', textContent: '', style: {}, remove() {} }
    },
    addEventListener() {},
    removeEventListener() {},
  }

  const mpegtsEvents = {
    ERROR: 'error',
    LOADING_COMPLETE: 'loading_complete',
    MEDIA_INFO: 'media_info',
  }

  const mpegts = {
    Events: mpegtsEvents,
    createPlayer(config: { url: string }) {
      activeUrl = config.url
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
      const player: FakeMpegtsPlayer = {
        url: config.url,
        listeners,
        destroyed: false,
        on(event, listener) {
          listeners[event] ??= []
          listeners[event].push(listener)
        },
        attachMediaElement() {},
        load() {},
        pause() {},
        unload() {},
        detachMediaElement() {},
        destroy() {
          this.destroyed = true
        },
      }
      createdPlayers.push(player)
      return player
    },
  }

  const fetchMock = mock(async () =>
    Response.json(
      opts.playInfoResponse ??
        makePlayInfo([
          {
            current_qn: 10000,
            accept_qn: [10000],
            is_pushing: true,
            base_url: '/live-bvc/123/live_1_2.flv?',
            url_info: [
              { host: 'http://d1--ov-gotcha07.bilivideo.com', extra: 'ptype=1&order=1' },
              { host: 'http://d1--ov-gotcha07b.bilivideo.com', extra: 'ptype=1&order=2' },
            ],
          },
        ])
    )
  )

  const dependencies: Record<string, unknown> = {
    '@preact/signals': {
      effect: (fn: () => void) => {
        fn()
        return () => {}
      },
    },
    $: { unsafeWindow: { livePlayer } },
    './api': { ensureRoomId: async () => 959831 },
    './audio-only-volume': audioOnlyVolume,
    './const': constants,
    './load-script': { loadUmdScript: async () => mpegts },
    './log': { appendLog: (msg: string) => logs.push(msg) },
    './page-visibility': { isTabHidden: () => false },
    './player-dom': {
      ...playerDom,
      getPlayerVideo: () => null,
      resolveLivePlayer: () => livePlayer,
    },
    './store': {
      audioOnlyActive,
      audioOnlyMode,
      audioOnlyMuted: audioOnlyMutedSig,
      audioOnlyVolume: audioOnlyVolumeSig,
    },
    './utils': utils,
  }

  const key = `__audioOnlyTest${++moduleId}`
  Reflect.set(globalThis, key, { fetch: fetchMock, document: fakeDocument, dependencies })
  const injected = transpiled.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
    if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
    return `const {${names}} = globalThis[${JSON.stringify(key)}].dependencies[${JSON.stringify(path)}];`
  })
  const code = `const { fetch, document } = globalThis[${JSON.stringify(key)}];\n${injected}`
  try {
    const mod: typeof import('./audio-only') = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
    )
    return {
      mod,
      fetchMock,
      logs,
      createdPlayers,
      stopPlayback,
      audioOnlyMode,
      audioOnlyActive,
      setPendingPlayReject(reject: (err: unknown) => void) {
        pendingPlayReject = reject
      },
    }
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}

describe('extractAudioOnlyStreamInfo', async () => {
  const { mod } = await loadAudioOnly()

  test('accepts low-viewer original-only rooms (accept_qn=[10000]) when is_pushing is true', () => {
    const result = mod.extractAudioOnlyStreamInfo(
      makePlayInfo([
        {
          current_qn: 10000,
          accept_qn: [10000],
          is_pushing: true,
          base_url: '/live-bvc/750834/live_2159091008_41443140.flv?',
          url_info: [
            { host: 'http://d1--ov-gotcha07.bilivideo.com', extra: 'ptype=1&order=1' },
            { host: 'http://d1--ov-gotcha07b.bilivideo.com', extra: 'ptype=1&order=2' },
          ],
        },
      ])
    )

    expect(result).toEqual({
      urls: [
        'https://d1--ov-gotcha07.bilivideo.com/live-bvc/750834/live_2159091008_41443140.flv?ptype=1&order=1',
        'https://d1--ov-gotcha07b.bilivideo.com/live-bvc/750834/live_2159091008_41443140.flv?ptype=1&order=2',
      ],
    })
  })

  test('orders hostname CDN edges ahead of raw-IP edges and deduplicates', () => {
    const result = mod.extractAudioOnlyStreamInfo(
      makePlayInfo([
        {
          current_qn: 250,
          accept_qn: [10000, 250],
          is_pushing: true,
          base_url: '/live-bvc/111/live_1_1_1500.flv?',
          url_info: [
            { host: 'http://114.230.222.34:4463', extra: 'ptype=1&order=1' },
            { host: 'http://cn-jsnt-ct-01-32.bilivideo.com:4463', extra: 'ptype=1&order=2' },
            { host: 'https://cn-jsnt-ct-01-32.bilivideo.com:4463', extra: 'ptype=1&order=2' },
          ],
        },
      ])
    )

    expect(result).toEqual({
      urls: [
        'https://cn-jsnt-ct-01-32.bilivideo.com:4463/live-bvc/111/live_1_1_1500.flv?ptype=1&order=2',
        'https://114.230.222.34:4463/live-bvc/111/live_1_1_1500.flv?ptype=1&order=1',
      ],
    })
  })

  test('skips dead codec slots (is_pushing=false) to reach a later active codec', () => {
    const result = mod.extractAudioOnlyStreamInfo(
      makePlayInfo([
        {
          current_qn: 10000,
          accept_qn: [10000],
          is_pushing: false,
          base_url: '/live-bvc/dead.flv?',
          url_info: [{ host: 'https://d1--cn-gotcha07.bilivideo.com', extra: 'ptype=1' }],
        },
        {
          current_qn: 10000,
          accept_qn: [10000],
          is_pushing: true,
          base_url: '/live-bvc/alive_hevc.flv?',
          url_info: [{ host: 'https://d1--cn-gotcha07b.bilivideo.com', extra: 'ptype=1' }],
        },
      ])
    )

    expect(result).toEqual({
      urls: ['https://d1--cn-gotcha07b.bilivideo.com/live-bvc/alive_hevc.flv?ptype=1'],
    })
  })

  test('marks off-air, carousel, or non-pushing rooms as unavailable', () => {
    expect(mod.extractAudioOnlyStreamInfo({ code: 0, data: { live_status: 0 } })).toEqual({
      urls: [],
      unavailable: true,
    })
    expect(mod.extractAudioOnlyStreamInfo({ code: 0, data: { live_status: 2 } })).toEqual({
      urls: [],
      unavailable: true,
    })
    expect(
      mod.extractAudioOnlyStreamInfo(
        makePlayInfo([
          {
            current_qn: 10000,
            accept_qn: [10000],
            is_pushing: false,
            base_url: '/live-bvc/dead.flv?',
            url_info: [{ host: 'https://d1--cn-gotcha07.bilivideo.com', extra: '' }],
          },
        ])
      )
    ).toEqual({
      urls: [],
      unavailable: true,
    })
  })
})

describe('engageAudioOnly candidate failover', () => {
  test('falls back to backup CDN host when primary host fails during preroll', async () => {
    let loadedModule: Awaited<ReturnType<typeof loadAudioOnly>> | null = null
    loadedModule = await loadAudioOnly({
      playImpl(url) {
        if (url.includes('gotcha07.bilivideo.com')) {
          return new Promise<void>((_resolve, reject) => {
            loadedModule?.setPendingPlayReject(reject)
            const current = loadedModule?.createdPlayers.at(-1)
            for (const fn of current?.listeners.error ?? []) {
              fn('NetworkError', 'HttpStatusCodeInvalid')
            }
          })
        }
        return Promise.resolve()
      },
    })

    const { mod, createdPlayers, stopPlayback, logs, audioOnlyMode, audioOnlyActive } = loadedModule
    audioOnlyMode.value = 'on'
    audioOnlyActive.value = true
    mod.startAudioOnly()

    await Bun.sleep(30)

    expect(createdPlayers.map(p => p.url)).toEqual([
      'https://d1--ov-gotcha07.bilivideo.com/live-bvc/123/live_1_2.flv?ptype=1&order=1',
      'https://d1--ov-gotcha07b.bilivideo.com/live-bvc/123/live_1_2.flv?ptype=1&order=2',
    ])
    expect(createdPlayers[0]?.destroyed).toBe(true)
    expect(createdPlayers[1]?.destroyed).toBe(false)
    expect(stopPlayback).toHaveBeenCalledTimes(1)
    expect(logs).toContain('🎧 已开启仅音频模式')

    mod.stopAudioOnly()
  })
})
