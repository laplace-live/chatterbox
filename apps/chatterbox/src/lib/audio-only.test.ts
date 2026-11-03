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

const PRIMARY_HOST = 'd1--ov-gotcha07.bilivideo.com'
const BACKUP_HOST = 'd1--ov-gotcha07b.bilivideo.com'

/** Build a `RoomPlayInfoResponse` fixture wrapping the given FLV codec entries. */
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
  fakeTimers?: boolean
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

interface ScheduledTimer {
  id: number
  dueAt: number
  delay: number
  fn: () => void
}

/** Load an isolated `audio-only` module instance with mocked DOM, fetch, timers, and `mpegts.js`. */
async function loadAudioOnly(opts: LoadAudioOnlyOptions = {}) {
  const logs: string[] = []
  const logListeners = new Set<() => void>()
  const createdPlayers: FakeMpegtsPlayer[] = []
  const playerListeners = new Set<() => void>()
  let activeUrl = ''
  let pendingPlayReject: ((err: unknown) => void) | null = null

  let nowMs = 1_000_000
  let nextTimerId = 1
  const scheduledTimers = new Map<number, ScheduledTimer>()

  const fakeDate = {
    now: () => (opts.fakeTimers ? nowMs : Date.now()),
  }

  const fakeSetTimeout = ((fn: () => void, ms = 0): unknown => {
    if (!opts.fakeTimers || ms <= 0) {
      return setTimeout(fn, ms)
    }
    const id = nextTimerId++
    scheduledTimers.set(id, { id, dueAt: nowMs + ms, delay: ms, fn })
    return id
  }) as typeof setTimeout

  const fakeClearTimeout = ((id: unknown): void => {
    if (typeof id === 'number' && scheduledTimers.delete(id)) return
    clearTimeout(id as ReturnType<typeof setTimeout>)
  }) as typeof clearTimeout

  async function flushMicrotasks(ticks = 6): Promise<void> {
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve()
    }
  }

  async function advanceTimersBy(deltaMs: number): Promise<void> {
    const targetMs = nowMs + deltaMs
    while (true) {
      await flushMicrotasks()
      let earliest: ScheduledTimer | undefined
      for (const timer of scheduledTimers.values()) {
        if (timer.dueAt <= targetMs && (!earliest || timer.dueAt < earliest.dueAt)) {
          earliest = timer
        }
      }
      if (!earliest) break
      scheduledTimers.delete(earliest.id)
      nowMs = earliest.dueAt
      earliest.fn()
    }
    nowMs = targetMs
    await flushMicrotasks()
  }

  function waitForLog(predicate: (msg: string) => boolean): Promise<string> {
    const existing = logs.find(predicate)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise(resolve => {
      const check = () => {
        const match = logs.find(predicate)
        if (match !== undefined) {
          logListeners.delete(check)
          resolve(match)
        }
      }
      logListeners.add(check)
    })
  }

  function waitForPlayers(count: number): Promise<void> {
    if (createdPlayers.length >= count) return Promise.resolve()
    return new Promise(resolve => {
      const check = () => {
        if (createdPlayers.length >= count) {
          playerListeners.delete(check)
          resolve()
        }
      }
      playerListeners.add(check)
    })
  }

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
      for (const notify of playerListeners) notify()
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
              { host: `http://${PRIMARY_HOST}`, extra: 'ptype=1&order=1' },
              { host: `http://${BACKUP_HOST}`, extra: 'ptype=1&order=2' },
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
    './log': {
      appendLog: (msg: string) => {
        logs.push(msg)
        for (const notify of logListeners) notify()
      },
    },
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
  Reflect.set(globalThis, key, {
    fetch: fetchMock,
    document: fakeDocument,
    Date: fakeDate,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    dependencies,
  })
  const injected = transpiled.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
    if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
    return `const {${names}} = globalThis[${JSON.stringify(key)}].dependencies[${JSON.stringify(path)}];`
  })
  const code = `const { fetch, document, Date, setTimeout, clearTimeout } = globalThis[${JSON.stringify(key)}];\n${injected}`
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
      advanceTimersBy,
      flushMicrotasks,
      waitForLog,
      waitForPlayers,
      getNowMs: () => nowMs,
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
            { host: `http://${PRIMARY_HOST}`, extra: 'ptype=1&order=1' },
            { host: `http://${BACKUP_HOST}`, extra: 'ptype=1&order=2' },
          ],
        },
      ])
    )

    expect(result).toEqual({
      urls: [
        `https://${PRIMARY_HOST}/live-bvc/750834/live_2159091008_41443140.flv?ptype=1&order=1`,
        `https://${BACKUP_HOST}/live-bvc/750834/live_2159091008_41443140.flv?ptype=1&order=2`,
      ],
    })
  })

  test('orders hostname CDN edges ahead of raw-IP edges across active codec slots and deduplicates', () => {
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
        {
          current_qn: 250,
          accept_qn: [10000, 250],
          is_pushing: true,
          base_url: '/live-bvc/111/live_1_1_1500_prohevc.flv?',
          url_info: [{ host: 'http://cn-jsnt-ct-01-32.bilivideo.com:4463', extra: 'ptype=1&order=1' }],
        },
      ])
    )

    expect(result).toEqual({
      urls: [
        'https://cn-jsnt-ct-01-32.bilivideo.com:4463/live-bvc/111/live_1_1_1500.flv?ptype=1&order=2',
        'https://cn-jsnt-ct-01-32.bilivideo.com:4463/live-bvc/111/live_1_1_1500_prohevc.flv?ptype=1&order=1',
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
        if (new URL(url).hostname === PRIMARY_HOST) {
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

    const { mod, createdPlayers, stopPlayback, logs, audioOnlyMode, audioOnlyActive, waitForLog } = loadedModule
    audioOnlyMode.value = 'on'
    audioOnlyActive.value = true
    mod.startAudioOnly()

    await waitForLog(msg => msg.includes('已开启仅音频模式'))

    expect(createdPlayers.map(p => p.url)).toEqual([
      `https://${PRIMARY_HOST}/live-bvc/123/live_1_2.flv?ptype=1&order=1`,
      `https://${BACKUP_HOST}/live-bvc/123/live_1_2.flv?ptype=1&order=2`,
    ])
    expect(createdPlayers[0]?.destroyed).toBe(true)
    expect(createdPlayers[1]?.destroyed).toBe(false)
    expect(stopPlayback).toHaveBeenCalledTimes(1)
    expect(logs).toContain('🎧 已开启仅音频模式')

    mod.stopAudioOnly()
  })

  test('falls back to backup CDN host when primary host hangs past its attempt timeout', async () => {
    let loadedModule: Awaited<ReturnType<typeof loadAudioOnly>> | null = null
    loadedModule = await loadAudioOnly({
      fakeTimers: true,
      playImpl(url) {
        if (new URL(url).hostname === PRIMARY_HOST) {
          return new Promise<void>((_resolve, reject) => {
            loadedModule?.setPendingPlayReject(reject)
          })
        }
        return Promise.resolve()
      },
    })

    const { mod, createdPlayers, stopPlayback, logs, audioOnlyMode, audioOnlyActive, waitForPlayers, advanceTimersBy } =
      loadedModule
    audioOnlyMode.value = 'on'
    audioOnlyActive.value = true
    mod.startAudioOnly()

    await waitForPlayers(1)
    expect(createdPlayers).toHaveLength(1)
    expect(createdPlayers[0]?.destroyed).toBe(false)

    // 2 candidates share the 10_000ms SWAP_TIMEOUT_MS budget → primary times out at 5000ms.
    await advanceTimersBy(5000)

    expect(createdPlayers.map(p => p.url)).toEqual([
      `https://${PRIMARY_HOST}/live-bvc/123/live_1_2.flv?ptype=1&order=1`,
      `https://${BACKUP_HOST}/live-bvc/123/live_1_2.flv?ptype=1&order=2`,
    ])
    expect(createdPlayers[0]?.destroyed).toBe(true)
    expect(createdPlayers[1]?.destroyed).toBe(false)
    expect(stopPlayback).toHaveBeenCalledTimes(1)
    expect(logs).toContain('🎧 已开启仅音频模式')

    mod.stopAudioOnly()
  })

  test('destroys all candidate players and fails within SWAP_TIMEOUT_MS when all hosts hang', async () => {
    let loadedModule: Awaited<ReturnType<typeof loadAudioOnly>> | null = null
    loadedModule = await loadAudioOnly({
      fakeTimers: true,
      playImpl() {
        return new Promise<void>((_resolve, reject) => {
          loadedModule?.setPendingPlayReject(reject)
        })
      },
    })

    const {
      mod,
      createdPlayers,
      stopPlayback,
      logs,
      audioOnlyMode,
      audioOnlyActive,
      waitForPlayers,
      advanceTimersBy,
      getNowMs,
    } = loadedModule
    const startMs = getNowMs()
    audioOnlyMode.value = 'on'
    audioOnlyActive.value = true
    mod.startAudioOnly()

    await waitForPlayers(1)
    await advanceTimersBy(5000)
    expect(createdPlayers).toHaveLength(2)
    expect(createdPlayers[0]?.destroyed).toBe(true)
    expect(createdPlayers[1]?.destroyed).toBe(false)

    await advanceTimersBy(5000)
    expect(getNowMs() - startMs).toBeLessThanOrEqual(10_000)
    expect(createdPlayers[1]?.destroyed).toBe(true)
    expect(stopPlayback).not.toHaveBeenCalled()
    expect(logs).toContain('⚠️ 仅音频模式启动失败：仅音频流未能开始播放')

    mod.stopAudioOnly()
  })

  test('does not advance to backup candidate when stopAudioOnly runs mid-preroll', async () => {
    let loadedModule: Awaited<ReturnType<typeof loadAudioOnly>> | null = null
    loadedModule = await loadAudioOnly({
      playImpl() {
        return new Promise<void>((_resolve, reject) => {
          loadedModule?.setPendingPlayReject(reject)
        })
      },
    })

    const { mod, createdPlayers, stopPlayback, audioOnlyMode, audioOnlyActive, waitForPlayers, flushMicrotasks } =
      loadedModule
    audioOnlyMode.value = 'on'
    audioOnlyActive.value = true
    mod.startAudioOnly()

    await waitForPlayers(1)
    expect(createdPlayers).toHaveLength(1)

    mod.stopAudioOnly()
    await flushMicrotasks()

    expect(createdPlayers).toHaveLength(1)
    expect(createdPlayers[0]?.destroyed).toBe(true)
    expect(stopPlayback).not.toHaveBeenCalled()
  })

  test('rotates away from the failed primary CDN host when recovering from a mid-stream drop', async () => {
    const loadedModule = await loadAudioOnly({ fakeTimers: true })
    const { mod, createdPlayers, logs, audioOnlyMode, audioOnlyActive, waitForLog, advanceTimersBy } = loadedModule

    audioOnlyMode.value = 'on'
    audioOnlyActive.value = true
    mod.startAudioOnly()

    await waitForLog(msg => msg.includes('已开启仅音频模式'))
    expect(createdPlayers).toHaveLength(1)
    expect(new URL(createdPlayers[0]?.url ?? '').hostname).toBe(PRIMARY_HOST)

    for (const fn of createdPlayers[0]?.listeners.error ?? []) {
      fn('NetworkError', 'UnrecoverableEarlyEof')
    }
    expect(logs.some(msg => msg.includes('第 1/20 次重连'))).toBe(true)

    await advanceTimersBy(2000)

    expect(createdPlayers).toHaveLength(2)
    expect(new URL(createdPlayers[1]?.url ?? '').hostname).toBe(BACKUP_HOST)

    mod.stopAudioOnly()
  })
})
