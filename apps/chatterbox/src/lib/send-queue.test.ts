import { describe, expect, mock, test } from 'bun:test'

import type { SendDanmakuResult } from './api'
import type { SentDanmaku } from './send-queue'

const source = await Bun.file(new URL('./send-queue.ts', import.meta.url)).text()
let moduleId = 0

/** Fresh queue module per test, with `sendDanmaku` stubbed through globalThis. */
async function loadQueue() {
  const sendDanmaku = mock(
    async (message: string): Promise<SendDanmakuResult> => ({ success: true, message, isEmoticon: false })
  )
  const key = `__sendQueueTest${++moduleId}`
  Reflect.set(globalThis, key, { sendDanmaku })
  // Transpile first so type-only specifiers are gone before the import is swapped.
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const injected = js.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\/api["'];?/,
    (_match, names) => `const {${names}} = globalThis[${JSON.stringify(key)}];`
  )
  try {
    const queue: typeof import('./send-queue') = await import(
      `data:text/javascript;base64,${Buffer.from(injected).toString('base64')}`
    )
    return { queue, sendDanmaku }
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}

describe('enqueueDanmaku guard', () => {
  test('a failing guard cancels the send without posting or notifying', async () => {
    const { queue, sendDanmaku } = await loadQueue()
    const sent = mock((_sent: SentDanmaku) => {})
    queue.onDanmakuSent(sent)
    const result = await queue.enqueueDanmaku('hi', 1, 'csrf', queue.SendPriority.COPY, 'copy', () => false)
    expect(result).toMatchObject({ success: false, cancelled: true })
    expect(sendDanmaku).not.toHaveBeenCalled()
    expect(sent).not.toHaveBeenCalled()
  })

  test('a throwing guard rejects only its own item and the queue keeps draining', async () => {
    const { queue, sendDanmaku } = await loadQueue()
    const broken = queue.enqueueDanmaku('broken', 1, 'csrf', queue.SendPriority.COPY, 'copy', () => {
      throw new Error('boom')
    })
    const next = queue.enqueueDanmaku('next', 1, 'csrf', queue.SendPriority.COPY, 'copy')
    await expect(broken).rejects.toThrow('boom')
    expect(await next).toMatchObject({ success: true })
    expect(sendDanmaku.mock.calls.map(call => call[0])).toEqual(['next'])
  })

  test('the guard runs at dispatch, after the rate-limit wait, not at enqueue', async () => {
    const { queue, sendDanmaku } = await loadQueue()
    let allowed = true
    const first = queue.enqueueDanmaku('first', 1, 'csrf', queue.SendPriority.MANUAL, 'manual')
    const second = queue.enqueueDanmaku('second', 1, 'csrf', queue.SendPriority.COPY, 'copy', () => allowed)
    await first
    allowed = false
    expect(await second).toMatchObject({ cancelled: true })
    expect(sendDanmaku.mock.calls.map(call => call[0])).toEqual(['first'])
  })
})

test('a manual send preempts an automatic one waiting out the rate-limit gap', async () => {
  const { queue, sendDanmaku } = await loadQueue()
  await queue.enqueueDanmaku('first', 1, 'csrf', queue.SendPriority.AUTO, 'loop')
  const waiting = queue.enqueueDanmaku('waiting', 1, 'csrf', queue.SendPriority.AUTO, 'loop')
  const manual = queue.enqueueDanmaku('manual', 1, 'csrf', queue.SendPriority.MANUAL, 'manual')
  expect(await waiting).toMatchObject({ cancelled: true, error: 'preempted' })
  expect(await manual).toMatchObject({ success: true })
  expect(sendDanmaku.mock.calls.map(call => call[0])).toEqual(['first', 'manual'])
})

test('onDanmakuSent reports accepted sends with their source', async () => {
  const { queue, sendDanmaku } = await loadQueue()
  sendDanmaku.mockImplementationOnce(async message => ({ success: false, message, isEmoticon: false, error: 'f' }))
  const sent = mock((_sent: SentDanmaku) => {})
  queue.onDanmakuSent(sent)
  await queue.enqueueDanmaku('rejected', 1, 'csrf', queue.SendPriority.MANUAL, 'manual')
  await queue.enqueueDanmaku('accepted', 1, 'csrf', queue.SendPriority.AUTO, 'loop')
  expect(sent.mock.calls).toEqual([[{ message: 'accepted', roomId: 1, source: 'loop' }]])
})
