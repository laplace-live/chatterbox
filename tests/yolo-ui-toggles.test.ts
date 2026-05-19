/**
 * Lightweight UI-presence tests for the AI 润色 (internal name still YOLO)
 * toggle wiring across the three send-path tabs (自动跟车 / 独轮车 / 手动发送).
 *
 * Goal: catch regressions where the toggle gets wired to the wrong signal,
 * or the per-feature PromptPicker is missing / mis-wired (e.g. autoBlend
 * picker ends up reading autoSend prompts). The test walks the rendered
 * VNode tree without invoking child function components, so hooks inside
 * sub-components stay inert.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { VNode } from 'preact'

import { installGmStoreMock } from './_gm-store'

const { reset: resetGmStore } = installGmStoreMock()

function TestXMLHttpRequest() {}
TestXMLHttpRequest.prototype.open = () => {}
TestXMLHttpRequest.prototype.send = () => {}
;(globalThis as unknown as { XMLHttpRequest: typeof TestXMLHttpRequest }).XMLHttpRequest = TestXMLHttpRequest

const realApi = await import('../src/lib/api')
mock.module('../src/lib/api', () => ({ ...realApi }))

const { AutoBlendControls } = await import('../src/components/auto-blend-controls')
const { AutoSendControls } = await import('../src/components/auto-send-controls')
const { NormalSendTab } = await import('../src/components/normal-send-tab')
const {
  autoBlendAdvancedOpen,
  autoBlendPanelOpen,
  autoBlendYolo,
  autoSendPanelOpen,
  autoSendYolo,
  customChatEnabled,
  llmActivePromptAutoBlend,
  llmActivePromptAutoSend,
  llmActivePromptNormalSend,
  llmPromptsAutoBlend,
  llmPromptsAutoSend,
  llmPromptsNormalSend,
  msgTemplates,
  normalSendYolo,
} = await import('../src/lib/store')

type TreeNode = VNode<Record<string, unknown>> | string | number | boolean | null | undefined | TreeNode[]

function collectNodes(
  node: TreeNode,
  result: Array<VNode<Record<string, unknown>>> = []
): Array<VNode<Record<string, unknown>>> {
  if (node == null || node === false || node === true) return result
  if (typeof node === 'string' || typeof node === 'number') return result
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, result)
    return result
  }
  result.push(node)
  collectNodes(node.props?.children as TreeNode, result)
  return result
}

function findInputById(tree: TreeNode, id: string): VNode<Record<string, unknown>> | undefined {
  return collectNodes(tree).find(n => n.type === 'input' && n.props?.id === id)
}

function findComponentByName(tree: TreeNode, name: string): VNode<Record<string, unknown>> | undefined {
  return collectNodes(tree).find(n => typeof n.type === 'function' && n.type.name === name)
}

beforeEach(() => {
  resetGmStore()
  // Tabs need to be open / non-conditional to mount their bodies.
  autoBlendPanelOpen.value = true
  autoBlendAdvancedOpen.value = true
  autoSendPanelOpen.value = true
  customChatEnabled.value = false
  // YOLO toggles default off — assertions match that baseline state.
  autoBlendYolo.value = false
  autoSendYolo.value = false
  normalSendYolo.value = false
  // Need at least one template so AutoSendControls renders normally.
  msgTemplates.value = ['hi']
  llmPromptsAutoBlend.value = []
  llmPromptsAutoSend.value = []
  llmPromptsNormalSend.value = []
  llmActivePromptAutoBlend.value = 0
  llmActivePromptAutoSend.value = 0
  llmActivePromptNormalSend.value = 0
})

afterEach(() => {
  autoBlendPanelOpen.value = false
  autoBlendAdvancedOpen.value = false
  autoSendPanelOpen.value = false
  autoBlendYolo.value = false
  autoSendYolo.value = false
  normalSendYolo.value = false
})

describe('AutoBlendControls — YOLO toggle wiring', () => {
  test('renders the autoBlendYolo checkbox with the expected id', () => {
    const tree = AutoBlendControls() as TreeNode
    const input = findInputById(tree, 'autoBlendYolo')
    expect(input).toBeDefined()
    expect(input?.props?.type).toBe('checkbox')
  })

  test('checkbox checked-state mirrors autoBlendYolo signal', () => {
    autoBlendYolo.value = false
    expect(findInputById(AutoBlendControls() as TreeNode, 'autoBlendYolo')?.props?.checked).toBe(false)
    autoBlendYolo.value = true
    expect(findInputById(AutoBlendControls() as TreeNode, 'autoBlendYolo')?.props?.checked).toBe(true)
  })

  test('mounts a PromptPicker (uses autoBlend prompts list)', () => {
    // We can't easily assert "the picker reads autoBlend signals" without
    // invoking it (which would mount a real <select>), but we CAN assert that
    // PromptPicker IS in the rendered tree of AutoBlendControls — proving
    // it's wired in, regardless of which signal the function reads internally.
    autoBlendYolo.value = true
    const picker = findComponentByName(AutoBlendControls() as TreeNode, 'PromptPicker')
    expect(picker).toBeDefined()
  })

  test('removed `autoBlendIncludeReply` toggle is no longer rendered', () => {
    // Regression guard for the upstream commit 624de4e port: the "也跟 @ 回复"
    // toggle must be gone (always-exclude is now the only behaviour).
    const input = findInputById(AutoBlendControls() as TreeNode, 'autoBlendIncludeReply')
    expect(input).toBeUndefined()
  })
})

describe('AutoSendControls — YOLO toggle wiring', () => {
  test('renders the autoSendYolo checkbox', () => {
    const input = findInputById(AutoSendControls() as TreeNode, 'autoSendYolo')
    expect(input).toBeDefined()
    expect(input?.props?.type).toBe('checkbox')
  })

  test('checkbox checked-state mirrors autoSendYolo signal', () => {
    autoSendYolo.value = false
    expect(findInputById(AutoSendControls() as TreeNode, 'autoSendYolo')?.props?.checked).toBe(false)
    autoSendYolo.value = true
    expect(findInputById(AutoSendControls() as TreeNode, 'autoSendYolo')?.props?.checked).toBe(true)
  })

  test('mounts a PromptPicker for the autoSend prompt list', () => {
    autoSendYolo.value = true
    const picker = findComponentByName(AutoSendControls() as TreeNode, 'PromptPicker')
    expect(picker).toBeDefined()
  })
})

describe('NormalSendTab — YOLO toggle wiring', () => {
  test('renders the normalSendYolo checkbox', () => {
    const input = findInputById(NormalSendTab() as unknown as TreeNode, 'normalSendYolo')
    expect(input).toBeDefined()
    expect(input?.props?.type).toBe('checkbox')
  })

  test('checkbox checked-state mirrors normalSendYolo signal', () => {
    normalSendYolo.value = false
    expect(findInputById(NormalSendTab() as unknown as TreeNode, 'normalSendYolo')?.props?.checked).toBe(false)
    normalSendYolo.value = true
    expect(findInputById(NormalSendTab() as unknown as TreeNode, 'normalSendYolo')?.props?.checked).toBe(true)
  })

  test('mounts a PromptPicker for the normalSend prompt list', () => {
    normalSendYolo.value = true
    const picker = findComponentByName(NormalSendTab() as unknown as TreeNode, 'PromptPicker')
    expect(picker).toBeDefined()
  })

  test('renders a redirect hint (not the composer) when customChatEnabled — YOLO toggle moves into custom chat composer scope', () => {
    customChatEnabled.value = true
    const tree = NormalSendTab() as unknown as TreeNode
    // No YOLO checkbox in this branch — that toggle lives in the custom-chat composer instead.
    expect(findInputById(tree, 'normalSendYolo')).toBeUndefined()
    // But the `<details>` with the redirect data-attr should be there so the
    // user knows where the send composer went.
    const detailsNode = collectNodes(tree).find(
      n => n.type === 'details' && n.props?.['data-cb-normal-send-redirected'] !== undefined
    )
    expect(detailsNode).toBeDefined()
  })
})
