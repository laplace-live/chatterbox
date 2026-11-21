import { afterEach, describe, expect, test } from 'bun:test'
import * as signals from '@preact/signals'

import type { VisionMode } from '../store'

import { loadWithMocks } from '../../testing/load-with-mocks'

interface Settings {
  visionEnabled: boolean
  visionMode: VisionMode
  visionClipEnabled: boolean
  aiChatEnabled: boolean
  autoBlendEnabled: boolean
  autoBlendDecisionEnabled: boolean
  autoBlendYolo: boolean
}

const cleanups: (() => void)[] = []

async function createHarness(initial: Partial<Settings> = {}, clipSupported = true) {
  const { signal } = signals
  const settings = {
    visionEnabled: signal(false),
    visionMode: signal<VisionMode>('direct'),
    visionClipEnabled: signal(false),
    aiChatEnabled: signal(false),
    autoBlendEnabled: signal(false),
    autoBlendDecisionEnabled: signal(false),
    autoBlendYolo: signal(false),
  }
  // Stands in for appendLog: parts read and write signals while starting.
  const logLines = signal<string[]>([])
  const events: string[] = []
  const part = (name: string) => ({
    start: () => {
      events.push(`start ${name}`)
      logLines.value = [...logLines.value, name]
    },
    stop: () => events.push(`stop ${name}`),
  })
  const sampler = part('sampler')
  const captioner = part('captioner')
  const clip = part('clip')
  let clipChecks = 0
  const controller = await loadWithMocks<typeof import('./controller')>(new URL('./controller.ts', import.meta.url), {
    '@preact/signals': signals,
    '../decision-settings': { autoBlendDecisionEnabled: settings.autoBlendDecisionEnabled },
    '../store': settings,
    './captioner': { startCaptioner: captioner.start, stopCaptioner: captioner.stop },
    './clip-recorder': {
      isClipRecordingSupported: () => {
        clipChecks++
        return clipSupported
      },
      startClipRecorder: clip.start,
      stopClipRecorder: clip.stop,
    },
    './frame-sampler': { startFrameSampler: sampler.start, stopFrameSampler: sampler.stop },
  })
  cleanups.push(() => controller.stopVisionController())

  function set(values: Partial<Settings>) {
    signals.batch(() => {
      for (const [name, value] of Object.entries(values)) {
        const target = Reflect.get(settings, name)
        if (target instanceof signals.Signal) target.value = value
      }
    })
  }

  /** Parts started and not yet stopped; throws on a double start or a stop without a start. */
  function running(): string[] {
    const active = new Set<string>()
    for (const event of events) {
      const [action, name] = event.split(' ')
      if (action === 'start' ? active.has(name) : !active.has(name)) throw new Error(`Unpaired: ${event}`)
      if (action === 'start') active.add(name)
      else active.delete(name)
    }
    return [...active].sort()
  }

  set(initial)
  return { ...controller, events, logLines, set, running, clipChecks: () => clipChecks }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('vision demand', () => {
  test.each<[string, Partial<Settings>, string[], boolean?]>([
    [
      'vision off',
      { aiChatEnabled: true, autoBlendEnabled: true, autoBlendDecisionEnabled: true, visionClipEnabled: true },
      [],
    ],
    ['direct + AI 融入', { visionEnabled: true, aiChatEnabled: true }, ['sampler']],
    [
      'direct + AI 融入 + clip',
      { visionEnabled: true, aiChatEnabled: true, visionClipEnabled: true },
      ['clip', 'sampler'],
    ],
    [
      'direct + clip the browser cannot record',
      { visionEnabled: true, aiChatEnabled: true, visionClipEnabled: true },
      ['sampler'],
      false,
    ],
    [
      'direct + 自动融入 notes only',
      { visionEnabled: true, autoBlendEnabled: true, autoBlendDecisionEnabled: true, autoBlendYolo: true },
      [],
    ],
    [
      'caption + AI 融入 (no clip)',
      { visionEnabled: true, visionMode: 'caption', aiChatEnabled: true, visionClipEnabled: true },
      ['captioner', 'sampler'],
    ],
    [
      'caption + 自动融入 decision',
      { visionEnabled: true, visionMode: 'caption', autoBlendEnabled: true, autoBlendDecisionEnabled: true },
      ['captioner', 'sampler'],
    ],
    [
      'caption + 自动融入 YOLO',
      { visionEnabled: true, visionMode: 'caption', autoBlendEnabled: true, autoBlendYolo: true },
      ['captioner', 'sampler'],
    ],
    ['caption + plain 自动融入', { visionEnabled: true, visionMode: 'caption', autoBlendEnabled: true }, []],
    [
      'caption + note settings while 自动融入 is off',
      { visionEnabled: true, visionMode: 'caption', autoBlendDecisionEnabled: true, autoBlendYolo: true },
      [],
    ],
  ])('%s', async (_label, settings, expected, clipSupported = true) => {
    const h = await createHarness(settings, clipSupported)
    h.startVisionController()
    expect(h.running()).toEqual(expected)
  })
})

describe('start and stop pairing', () => {
  test('follows settings changes, sampler first on start and last on stop', async () => {
    const h = await createHarness({ visionEnabled: true, visionMode: 'caption', aiChatEnabled: true })
    h.startVisionController()
    expect(h.events).toEqual(['start sampler', 'start captioner'])
    h.set({ visionMode: 'direct', visionClipEnabled: true })
    expect(h.events.slice(2)).toEqual(['stop captioner', 'start clip'])
    h.set({ aiChatEnabled: false, autoBlendEnabled: true, autoBlendYolo: true })
    expect(h.events.slice(4)).toEqual(['stop clip', 'stop sampler'])
    h.set({ visionMode: 'caption' })
    expect(h.events.slice(6)).toEqual(['start sampler', 'start captioner'])
    h.set({ autoBlendYolo: false, autoBlendDecisionEnabled: true })
    expect(h.events).toHaveLength(8)
    h.stopVisionController()
    expect(h.events.slice(8)).toEqual(['stop captioner', 'stop sampler'])
    expect(h.running()).toEqual([])
  })

  test('starting and stopping the controller is idempotent', async () => {
    const h = await createHarness({ visionEnabled: true, aiChatEnabled: true })
    h.stopVisionController()
    expect(h.events).toEqual([])
    h.startVisionController()
    h.startVisionController()
    expect(h.events).toEqual(['start sampler'])
    h.stopVisionController()
    h.stopVisionController()
    expect(h.events).toEqual(['start sampler', 'stop sampler'])
    h.set({ aiChatEnabled: false })
    h.set({ aiChatEnabled: true })
    expect(h.events).toHaveLength(2)
    h.startVisionController()
    expect(h.events).toEqual(['start sampler', 'stop sampler', 'start sampler'])
  })

  test('signals a part touches while starting do not re-run the demand effect', async () => {
    const h = await createHarness({ visionEnabled: true, aiChatEnabled: true, visionClipEnabled: true })
    h.startVisionController()
    expect(h.clipChecks()).toBe(1)
    h.logLines.value = []
    expect(h.clipChecks()).toBe(1)
    expect(h.running()).toEqual(['clip', 'sampler'])
  })
})
