/**
 * Tests for the shared lazy CDN-script loader (`src/lib/load-script.ts`).
 *
 * Pin the three behaviours that protect callers from real-world failure:
 *   1. **In-flight dedup** — two concurrent loadScript() calls for the same
 *      URL must share a single `<script>` injection and a single Promise,
 *      else the first audio-only toggle could trigger two parallel fetches
 *      of mpegts.js.
 *   2. **Already-loaded short-circuit** — if the probe returns a non-null
 *      global synchronously, no `<script>` is appended (zero DOM noise
 *      when the page already has the lib via @require, another script,
 *      or a previous successful load).
 *   3. **Error eviction** — onerror rejects AND removes the URL from the
 *      in-flight cache so a retry can re-fetch. Without this, a transient
 *      CDN blip would lock the URL into the failed promise for the rest
 *      of the page lifetime.
 *
 * Bonus: locks the "script loaded but global missing" error path (e.g. a
 * 200 with empty body would otherwise silently 'succeed').
 *
 * Implementation note: we deliberately AVOID happy-dom here. happy-dom's
 * HTMLScriptElement tries to fetch `src` when the element is connected to
 * the document — that explodes in the test environment with no network.
 * A hand-built fake document is smaller, faster, and gives us exact
 * control over when `onload` / `onerror` fire.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

/** Shape of the elements our fake document.createElement returns. */
interface FakeScriptElement {
  src: string
  crossOrigin: string
  onload: ((ev?: unknown) => void) | null
  onerror: ((ev?: unknown) => void) | null
}

/** Track every script ever created so tests can locate and trigger them. */
const createdScripts: FakeScriptElement[] = []
/** Track which scripts have been appended to head (vs created and discarded). */
const appendedScripts: FakeScriptElement[] = []

const fakeDocument = {
  createElement(tag: string): FakeScriptElement {
    if (tag !== 'script') throw new Error(`fake document only handles 'script', got ${tag}`)
    const el: FakeScriptElement = { src: '', crossOrigin: '', onload: null, onerror: null }
    createdScripts.push(el)
    return el
  },
  head: {
    appendChild(el: FakeScriptElement): FakeScriptElement {
      appendedScripts.push(el)
      return el
    },
  },
}

// Install BEFORE importing the module under test so the closure-captured
// `document` inside load-script.ts (if any) resolves to ours.
;(globalThis as unknown as { document: typeof fakeDocument }).document = fakeDocument

import { loadScript } from '../src/lib/load-script'

function findAppendedFor(url: string): FakeScriptElement {
  const match = appendedScripts.find(s => s.src === url)
  if (!match) throw new Error(`no <script> appended with src=${url}`)
  return match
}

function countAppendedFor(url: string): number {
  return appendedScripts.filter(s => s.src === url).length
}

interface FakeGlobal {
  tag: string
}

let installed: FakeGlobal | null = null
const probe = (): FakeGlobal | null => installed

describe('loadScript', () => {
  beforeEach(() => {
    installed = null
    createdScripts.length = 0
    appendedScripts.length = 0
  })

  afterEach(() => {
    installed = null
  })

  test('short-circuits when the global is already present (no <script> appended)', async () => {
    installed = { tag: 'preexisting' }
    const result = await loadScript<FakeGlobal>('https://cdn.example.com/lib.js', probe)
    expect(result.tag).toBe('preexisting')
    // The whole createElement path was bypassed.
    expect(createdScripts.length).toBe(0)
    expect(appendedScripts.length).toBe(0)
  })

  test('appends a <script> with crossorigin=anonymous when global is missing', () => {
    const url = 'https://cdn.example.com/lib-cors.js'
    void loadScript<FakeGlobal>(url, probe)
    const script = findAppendedFor(url)
    expect(script.src).toBe(url)
    expect(script.crossOrigin).toBe('anonymous')
  })

  test('onload + global present → resolves with the global', async () => {
    const url = 'https://cdn.example.com/lib-ok.js'
    const promise = loadScript<FakeGlobal>(url, probe)
    // Simulate the CDN fetch completing + the library installing its global.
    installed = { tag: 'after-load' }
    findAppendedFor(url).onload?.()
    const result = await promise
    expect(result.tag).toBe('after-load')
  })

  test('onload + global still null → rejects (script ran but did nothing)', async () => {
    const url = 'https://cdn.example.com/lib-empty.js'
    const promise = loadScript<FakeGlobal>(url, probe)
    // Onload fires but the global never appeared (200 with empty body).
    // installed stays null.
    findAppendedFor(url).onload?.()
    await expect(promise).rejects.toThrow(/script loaded but expected global not found/)
  })

  test('onload + global still null also evicts so a retry can re-fetch (PR #34 Codex P2 regression)', async () => {
    // Same shape as the onerror eviction test but for the failure mode where
    // the script reports onload but the expected global never installed
    // (200 + empty body, CDN serving the wrong bundle, etc.). Without
    // evicting in this branch, the next call returns the cached rejected
    // promise forever — toggling the feature off + on again can never retry.
    const url = 'https://cdn.example.com/lib-empty-then-retry.js'
    const failed = loadScript<FakeGlobal>(url, probe)
    findAppendedFor(url).onload?.()
    await expect(failed).rejects.toThrow(/script loaded but expected global not found/)

    // Retry should inject a fresh <script>, not reuse the failed promise.
    const before = countAppendedFor(url)
    const retried = loadScript<FakeGlobal>(url, probe)
    const after = countAppendedFor(url)
    expect(after).toBe(before + 1)

    // Resolve the retry so the test ends cleanly.
    installed = { tag: 'retry-after-empty' }
    const scripts = appendedScripts.filter(s => s.src === url)
    scripts[scripts.length - 1].onload?.()
    const result = await retried
    expect(result.tag).toBe('retry-after-empty')
  })

  test('two concurrent loadScript() calls for the same URL share one <script> and one Promise', () => {
    const url = 'https://cdn.example.com/lib-dedup.js'
    const p1 = loadScript<FakeGlobal>(url, probe)
    const p2 = loadScript<FakeGlobal>(url, probe)
    // Exactly the same Promise instance (in-flight cache hit, not a
    // structural-equality coincidence).
    expect(p1).toBe(p2)
    // And only one <script> was appended.
    expect(countAppendedFor(url)).toBe(1)
  })

  test('onerror rejects and evicts the URL so a retry can re-fetch', async () => {
    const url = 'https://cdn.example.com/lib-flaky.js'
    const failed = loadScript<FakeGlobal>(url, probe)
    findAppendedFor(url).onerror?.()
    await expect(failed).rejects.toThrow(/failed to load script/)

    // Retry: must inject a NEW <script>, not share the previous failed Promise.
    const before = countAppendedFor(url)
    const retried = loadScript<FakeGlobal>(url, probe)
    const after = countAppendedFor(url)
    expect(after).toBe(before + 1)

    // Resolve the retry so the test ends cleanly.
    installed = { tag: 'retry-ok' }
    // The newest appended script for this URL is the retry's element.
    const scripts = appendedScripts.filter(s => s.src === url)
    scripts[scripts.length - 1].onload?.()
    const result = await retried
    expect(result.tag).toBe('retry-ok')
  })

  test('after successful load, subsequent call resolves instantly with cached global (no new <script>)', async () => {
    const url = 'https://cdn.example.com/lib-cached.js'
    const first = loadScript<FakeGlobal>(url, probe)
    installed = { tag: 'first-load' }
    findAppendedFor(url).onload?.()
    await first

    const countAfterFirst = countAppendedFor(url)
    const second = await loadScript<FakeGlobal>(url, probe)
    const countAfterSecond = countAppendedFor(url)

    expect(second.tag).toBe('first-load')
    expect(countAfterSecond).toBe(countAfterFirst)
  })
})
