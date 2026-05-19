/**
 * Unit + integration coverage for `src/lib/llm-polish.ts` — the YOLO
 * orchestration layer that bridges HZM's persisted LLM config + the prompt
 * accessor + the `chatCompletionViaLlm` driver call.
 *
 * Two flavours of test in here:
 *   - **Pure config introspection** (isLlmApiConfigured / isLlmReady /
 *     describeLlmGap): no LLM call, just signal state.
 *   - **End-to-end polish** (polishWithLlm): drives the FULL stack via the
 *     gm-fetch DI hook (`_setGmXhrForTests`) — same approach as
 *     `tests/llm-driver.test.ts` style. We avoid `mock.module` on internal
 *     modules per `feedback_bun_test_mocks.md` (leakage across test files).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { installGmStoreMock } from './_gm-store'

const { reset: resetGmStore } = installGmStoreMock()

const { hzmLlmApiKey, hzmLlmApiKeyPersist, hzmLlmBaseURL, hzmLlmModel, hzmLlmProvider } = await import(
  '../src/lib/store-hzm'
)
const {
  llmActivePromptAutoBlend,
  llmActivePromptAutoSend,
  llmActivePromptGlobal,
  llmActivePromptNormalSend,
  llmPromptsAutoBlend,
  llmPromptsAutoSend,
  llmPromptsGlobal,
  llmPromptsNormalSend,
} = await import('../src/lib/store-llm')
const { describeLlmGap, isLlmApiConfigured, isLlmReady, polishWithLlm } = await import('../src/lib/llm-polish')
const { _setGmXhrForTests } = await import('../src/lib/gm-fetch')

// --- helpers --------------------------------------------------------------

function fillReadyConfig(): void {
  hzmLlmProvider.value = 'openai'
  hzmLlmApiKey.value = 'sk-test-key'
  hzmLlmModel.value = 'gpt-4o-mini'
  hzmLlmBaseURL.value = ''
  // Seed a feature prompt for autoBlend by default; specific tests override.
  llmPromptsAutoBlend.value = ['polish 自动跟车 prompt']
  llmActivePromptAutoBlend.value = 0
}

interface FakeXhrSpec {
  status: number
  body: string | object
}

/** Install a one-shot xhr fake that returns the given response. Captures the
 *  request payload so tests can assert what was sent. */
function installXhrFake(spec: FakeXhrSpec): { lastReq: { url?: string; body?: string; headers?: unknown } } {
  const captured: { url?: string; body?: string; headers?: unknown } = {}
  _setGmXhrForTests(((options: {
    url: string
    data?: string
    headers?: unknown
    onload: (r: { status: number; statusText: string; responseText: string; finalUrl: string }) => void
  }) => {
    captured.url = options.url
    captured.body = options.data
    captured.headers = options.headers
    setTimeout(() => {
      const text = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body)
      options.onload({
        status: spec.status,
        statusText: spec.status >= 200 && spec.status < 300 ? 'OK' : 'Error',
        responseText: text,
        finalUrl: options.url,
      })
    }, 0)
    // Return a dummy "abort handle" matching the GM_xmlhttpRequest shape.
    return { abort: () => {} }
  }) as unknown as Parameters<typeof _setGmXhrForTests>[0])
  return { lastReq: captured }
}

beforeEach(() => {
  resetGmStore()
  // Default: nothing configured. Each test seeds what it needs.
  hzmLlmProvider.value = 'openai'
  hzmLlmApiKey.value = ''
  hzmLlmModel.value = ''
  hzmLlmBaseURL.value = ''
  // Avoid the persistence effect from clobbering hzmLlmApiKey across tests.
  hzmLlmApiKeyPersist.value = false
  llmPromptsGlobal.value = []
  llmActivePromptGlobal.value = 0
  llmPromptsNormalSend.value = []
  llmActivePromptNormalSend.value = 0
  llmPromptsAutoBlend.value = []
  llmActivePromptAutoBlend.value = 0
  llmPromptsAutoSend.value = []
  llmActivePromptAutoSend.value = 0
})

afterEach(() => {
  _setGmXhrForTests(null)
})

// --- isLlmApiConfigured ---------------------------------------------------

describe('isLlmApiConfigured', () => {
  test('false when key is missing', () => {
    hzmLlmModel.value = 'm'
    expect(isLlmApiConfigured()).toBe(false)
  })

  test('false when model is missing', () => {
    hzmLlmApiKey.value = 'k'
    expect(isLlmApiConfigured()).toBe(false)
  })

  test('true for openai with key + model (no base URL needed)', () => {
    hzmLlmProvider.value = 'openai'
    hzmLlmApiKey.value = 'k'
    hzmLlmModel.value = 'm'
    expect(isLlmApiConfigured()).toBe(true)
  })

  test('true for anthropic with key + model (no base URL needed)', () => {
    hzmLlmProvider.value = 'anthropic'
    hzmLlmApiKey.value = 'k'
    hzmLlmModel.value = 'm'
    expect(isLlmApiConfigured()).toBe(true)
  })

  test('false for openai-compat without base URL', () => {
    hzmLlmProvider.value = 'openai-compat'
    hzmLlmApiKey.value = 'k'
    hzmLlmModel.value = 'm'
    hzmLlmBaseURL.value = ''
    expect(isLlmApiConfigured()).toBe(false)
  })

  test('true for openai-compat with key + model + baseURL', () => {
    hzmLlmProvider.value = 'openai-compat'
    hzmLlmApiKey.value = 'k'
    hzmLlmModel.value = 'm'
    hzmLlmBaseURL.value = 'https://example.com'
    expect(isLlmApiConfigured()).toBe(true)
  })

  test('whitespace-only fields are treated as missing', () => {
    hzmLlmApiKey.value = '   '
    hzmLlmModel.value = 'm'
    expect(isLlmApiConfigured()).toBe(false)
    hzmLlmApiKey.value = 'k'
    hzmLlmModel.value = '\t'
    expect(isLlmApiConfigured()).toBe(false)
  })
})

// --- describeLlmGap / isLlmReady -----------------------------------------

describe('describeLlmGap', () => {
  test('reports missing API key first (top-down order)', () => {
    expect(describeLlmGap('autoBlend')).toContain('API key')
  })

  test('then missing model', () => {
    hzmLlmApiKey.value = 'k'
    expect(describeLlmGap('autoBlend')).toContain('模型')
  })

  test('then missing base URL for openai-compat (anthropic / openai skip this gate)', () => {
    hzmLlmApiKey.value = 'k'
    hzmLlmModel.value = 'm'
    hzmLlmProvider.value = 'openai-compat'
    expect(describeLlmGap('autoBlend')).toContain('base URL')

    hzmLlmProvider.value = 'openai'
    // Pre-#21 this returned "请配置提示词"; after #21 the default per-feature
    // prompt kicks in so the gap closes cleanly when API config is complete.
    expect(describeLlmGap('autoBlend')).toBeNull()

    hzmLlmProvider.value = 'anthropic'
    expect(describeLlmGap('autoBlend')).toBeNull()
  })

  test('Jobs #21: empty user feature prompt no longer flagged — default kicks in', () => {
    // Pre-#21 this returned a "请配置提示词 - 手动发送" hint per feature.
    // After #21 DEFAULT_FEATURE_PROMPTS provides safe fallbacks, so users
    // with API configured but no custom prompt can still use AI 润色.
    hzmLlmApiKey.value = 'k'
    hzmLlmModel.value = 'm'
    hzmLlmProvider.value = 'openai'

    expect(describeLlmGap('normalSend')).toBeNull()
    expect(describeLlmGap('autoBlend')).toBeNull()
    expect(describeLlmGap('autoSend')).toBeNull()
  })

  test('returns null when everything is in place (api + matching feature prompt)', () => {
    fillReadyConfig()
    expect(describeLlmGap('autoBlend')).toBeNull()
  })

  test('Jobs #21: whitespace-only user prompt also falls back to default', () => {
    fillReadyConfig()
    llmPromptsAutoBlend.value = ['   \n  ']
    expect(describeLlmGap('autoBlend')).toBeNull()
  })

  test('Jobs #21: empty user feature + only global → default kicks in, gap closed', () => {
    fillReadyConfig()
    llmPromptsAutoSend.value = []
    llmPromptsGlobal.value = ['G']
    expect(describeLlmGap('autoSend')).toBeNull()
  })
})

describe('isLlmReady', () => {
  test('agrees with describeLlmGap (boolean === gap===null)', () => {
    // Pre-#21 only autoBlend was "ready" after fillReadyConfig (because only
    // its feature prompt was seeded). After #21 the per-feature defaults
    // close the gap for siblings too — once API config is in place, all
    // three features are ready unless the user explicitly disabled them via
    // some other mechanism. Test rewritten to assert the post-#21 contract.
    expect(isLlmReady('autoBlend')).toBe(false)
    fillReadyConfig()
    expect(isLlmReady('autoBlend')).toBe(true)
    expect(isLlmReady('autoSend')).toBe(true)
    expect(isLlmReady('normalSend')).toBe(true)
  })
})

// --- polishWithLlm (end-to-end via gm-fetch DI hook) ---------------------

describe('polishWithLlm', () => {
  test('Jobs #21: empty user feature prompt uses default — LLM is called, not skipped', async () => {
    fillReadyConfig()
    llmPromptsAutoBlend.value = []
    // Pre-#21 this test asserted polishWithLlm threw '当前功能未配置 LLM
    // 提示词'. After #21 the default per-feature prompt closes that gap —
    // we should see the fake xhr invoked (LLM actually called) and a result
    // returned. The default's specific wording is asserted in prompts.test.ts.
    const fakeRes = JSON.stringify({ choices: [{ message: { content: '666 (改) ' } }] })
    let xhrInvoked = 0
    _setGmXhrForTests(((options: {
      onload: (r: { status: number; statusText: string; responseText: string; finalUrl: string }) => void
    }) => {
      xhrInvoked++
      options.onload({ status: 200, responseText: fakeRes, finalUrl: '', statusText: 'OK' })
    }) as unknown as Parameters<typeof _setGmXhrForTests>[0])

    const out = await polishWithLlm('autoBlend', '666')
    expect(xhrInvoked).toBe(1)
    expect(out.length).toBeGreaterThan(0)
  })

  test('throws when user text is empty / whitespace (no LLM call)', async () => {
    fillReadyConfig()
    let xhrInvoked = 0
    _setGmXhrForTests(((options: { onload: (r: unknown) => void }) => {
      xhrInvoked++
      options.onload({ status: 200, responseText: '{}', finalUrl: '', statusText: '' })
    }) as unknown as Parameters<typeof _setGmXhrForTests>[0])

    await expect(polishWithLlm('autoBlend', '')).rejects.toThrow(/输入内容为空/)
    await expect(polishWithLlm('autoBlend', '   \n  ')).rejects.toThrow(/输入内容为空/)
    expect(xhrInvoked).toBe(0)
  })

  test('returns OpenAI content string trimmed (happy path)', async () => {
    fillReadyConfig()
    installXhrFake({
      status: 200,
      body: { choices: [{ message: { content: '  哥哥太厉害了  ' } }] },
    })
    const out = await polishWithLlm('autoBlend', '666')
    expect(out).toBe('哥哥太厉害了')
  })

  test('strips a layer of matched surrounding quotes from the LLM response', async () => {
    fillReadyConfig()
    installXhrFake({
      status: 200,
      body: { choices: [{ message: { content: '"包了引号"' } }] },
    })
    const out = await polishWithLlm('autoBlend', '666')
    expect(out).toBe('包了引号')
  })

  test('strips smart-quote variants too (“…” and 「…」)', async () => {
    fillReadyConfig()
    installXhrFake({
      status: 200,
      body: { choices: [{ message: { content: '“中文双引号”' } }] },
    })
    expect(await polishWithLlm('autoBlend', 'x')).toBe('中文双引号')

    installXhrFake({
      status: 200,
      body: { choices: [{ message: { content: '「书名号」' } }] },
    })
    expect(await polishWithLlm('autoBlend', 'x')).toBe('书名号')
  })

  test('does NOT strip mismatched / partial quotes', async () => {
    fillReadyConfig()
    installXhrFake({
      status: 200,
      body: { choices: [{ message: { content: '"unbalanced' } }] },
    })
    // Starts with " but doesn't end with one — leave it alone.
    expect(await polishWithLlm('autoBlend', 'x')).toBe('"unbalanced')
  })

  test('forwards the active feature prompt as the system message', async () => {
    fillReadyConfig()
    llmPromptsAutoBlend.value = ['SPECIFIC AUTOBLEND PROMPT']
    const captured = installXhrFake({
      status: 200,
      body: { choices: [{ message: { content: 'ok' } }] },
    })
    await polishWithLlm('autoBlend', 'hi')
    const body = JSON.parse(captured.lastReq.body ?? '{}') as {
      messages: Array<{ role: string; content: string }>
    }
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SPECIFIC AUTOBLEND PROMPT' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  test('joins global prompt onto feature prompt (separator + paragraph break)', async () => {
    fillReadyConfig()
    llmPromptsGlobal.value = ['GLOBAL_BASE']
    llmPromptsAutoBlend.value = ['FEATURE_TASK']
    const captured = installXhrFake({
      status: 200,
      body: { choices: [{ message: { content: 'ok' } }] },
    })
    await polishWithLlm('autoBlend', 'hi')
    const body = JSON.parse(captured.lastReq.body ?? '{}') as {
      messages: Array<{ role: string; content: string }>
    }
    const sys = body.messages[0]?.content ?? ''
    expect(sys.startsWith('GLOBAL_BASE')).toBe(true)
    expect(sys.endsWith('FEATURE_TASK')).toBe(true)
    expect(sys).toContain('以下是用户的修改提示')
  })

  test('forwards trimmed user text (input whitespace stripped before sending)', async () => {
    fillReadyConfig()
    const captured = installXhrFake({
      status: 200,
      body: { choices: [{ message: { content: 'x' } }] },
    })
    await polishWithLlm('autoBlend', '  上车  ')
    const body = JSON.parse(captured.lastReq.body ?? '{}') as {
      messages: Array<{ role: string; content: string }>
    }
    expect(body.messages[1].content).toBe('上车')
  })

  test('routes to anthropic endpoint when provider=anthropic (different request shape)', async () => {
    fillReadyConfig()
    hzmLlmProvider.value = 'anthropic'
    hzmLlmModel.value = 'claude-haiku-4-5'
    const captured = installXhrFake({
      status: 200,
      body: { content: [{ text: '哥哥太厉害了' }] },
    })
    const out = await polishWithLlm('autoBlend', '666')
    expect(out).toBe('哥哥太厉害了')
    expect(captured.lastReq.url).toContain('anthropic')
    const body = JSON.parse(captured.lastReq.body ?? '{}') as { system: unknown; messages: unknown }
    // Anthropic puts system as a separate field; messages are user-only.
    expect(body.system).toBeDefined()
    expect(body.messages).toBeDefined()
  })

  test('routes to openai-compat baseURL when provider=openai-compat', async () => {
    fillReadyConfig()
    hzmLlmProvider.value = 'openai-compat'
    hzmLlmBaseURL.value = 'https://api.deepseek.com'
    const captured = installXhrFake({
      status: 200,
      body: { choices: [{ message: { content: 'polished' } }] },
    })
    const out = await polishWithLlm('autoBlend', 'in')
    expect(out).toBe('polished')
    expect(captured.lastReq.url).toContain('api.deepseek.com')
    expect(captured.lastReq.url).toContain('chat/completions')
  })

  test('throws on HTTP 4xx with status surfaced in the error message', async () => {
    fillReadyConfig()
    installXhrFake({ status: 401, body: 'unauthorized' })
    await expect(polishWithLlm('autoBlend', 'x')).rejects.toThrow(/HTTP 401/)
  })

  test('throws on empty content (so caller can skip target instead of sending blank)', async () => {
    fillReadyConfig()
    installXhrFake({
      status: 200,
      body: { choices: [{ message: { content: '' } }] },
    })
    await expect(polishWithLlm('autoBlend', 'x')).rejects.toThrow(/返回内容为空/)
  })
})
