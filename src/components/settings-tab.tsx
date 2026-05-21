import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'

import { ensureRoomId, getCsrfToken, sendDanmaku } from '../lib/api'
import { cn } from '../lib/cn'
import { BASE_URL } from '../lib/const'
import { fetchLlmModels, formatLlmPricing } from '../lib/llm'
import { appendLog, maxLogLines } from '../lib/log'
import { buildReplacementMap } from '../lib/replacement'
import { applySettingsFile, exportSettings, parseSettingsFile } from '../lib/settings-io'
import {
  autoBlendMessageBlacklist,
  autoBlendUserBlacklist,
  autoQualityEnabled,
  autoSeekBufferThreshold,
  autoSeekCurrentBufferLen,
  autoSeekCurrentRate,
  autoSeekEnabled,
  cachedRoomId,
  danmakuDirectAlwaysShow,
  danmakuDirectConfirm,
  danmakuDirectMode,
  forceScrollDanmaku,
  infoFertilityEnabled,
  infoGuildEnabled,
  infoMcnEnabled,
  llmActivePromptAiChat,
  llmActivePromptAutoBlend,
  llmActivePromptAutoSend,
  llmActivePromptGlobal,
  llmActivePromptNormalSend,
  llmApiBase,
  llmApiKey,
  llmModel,
  llmModels,
  llmPromptsAiChat,
  llmPromptsAutoBlend,
  llmPromptsAutoSend,
  llmPromptsGlobal,
  llmPromptsNormalSend,
  localGlobalRules,
  localRoomRules,
  optimizeLayout,
  remoteKeywords,
  remoteKeywordsLastSync,
  unlockLiveBlock,
  unlockSpaceBlock,
} from '../lib/store'
import {
  applyUserNotesFile,
  exportUserNotes,
  parseUserNotesFile,
  type UserNotesImportMode,
  userNotes,
} from '../lib/user-notes'
import { PromptManager } from './prompt-manager'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Combobox } from './ui/combobox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { NativeSelect } from './ui/native-select'

const SYNC_INTERVAL = 10 * 60 * 1000

// Section visual rhythm shared across every block (heading + body + bottom
// divider).
const SECTION_CLASS = 'my-2 pb-4 border-b border-b-solid border-b-ga2'
const HEADING_CLASS = 'font-bold mb-2'
const ROW_CLASS = 'flex gap-2 items-center flex-wrap mb-2'
const HINT_CLASS = 'my-2 text-ga6'
const EMPTY_CLASS = 'text-ga4'
const LINK_CLASS = 'text-link no-underline'

// Each rule / blacklist row shares the same divider-separated layout.
const LIST_ROW_CLASS = 'flex items-center gap-2 py-[.2em] border-b border-b-solid border-b-ga2'
const LIST_ROW_TEXT = 'flex-1 break-all font-mono'
const ADD_ROW_CLASS = 'flex gap-1 items-center flex-wrap'
const FILL_INPUT_CLASS = 'flex-1 min-w-[80px]'

// Used as the destructive-action color on `ghost` Buttons in lists.
const DELETE_BTN_CLASS = 'text-[red]'

interface RemoteKeywords {
  global?: { keywords?: Record<string, string> }
  rooms?: Array<{ room: string; keywords?: Record<string, string> }>
}

async function fetchRemoteKeywords(): Promise<RemoteKeywords> {
  const response = await fetch(BASE_URL.REMOTE_KEYWORDS)
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  return await response.json()
}

interface AutoSeekMetricsProps {
  bufferLen: number
  rate: number
  threshold: number
}

/**
 * Live readout for the auto-seek section. Re-renders whenever any of
 * its props (all signal-backed) changes — no `useEffect`/setInterval
 * needed, because the seeker module publishes the metrics through
 * signals already and Preact tracks the dependency.
 *
 * Colour code mirrors the seeker's ladder semantics:
 *   - red   = below slowdown threshold (about to stall)
 *   - amber = significantly above target (we're catching up)
 *   - green = within ~0.5s of target (the "comfortable" zone)
 */
function AutoSeekMetrics(props: AutoSeekMetricsProps) {
  const { bufferLen, rate, threshold } = props
  const delta = bufferLen - threshold
  const bufferColor = bufferLen < 0.2 ? '#f44' : delta > 1 ? '#e8a200' : '#36a185'
  const rateColor = Math.abs(rate - 1) < 0.005 ? '#666' : rate > 1 ? '#e8a200' : '#f44'
  return (
    <div class='rounded border border-ga2 border-solid bg-ga1 p-2'>
      <div class='flex flex-wrap gap-x-4 gap-y-1'>
        <div>
          当前延迟 <span style={{ color: bufferColor, fontWeight: 600 }}>{bufferLen.toFixed(2)} 秒</span>
          <span class='text-ga6'>
            {' '}
            (目标 {threshold.toFixed(2)}，差 {delta >= 0 ? '+' : ''}
            {delta.toFixed(2)})
          </span>
        </div>
        <div>
          当前播放速度 <span style={{ color: rateColor, fontWeight: 600 }}>{rate.toFixed(2)}×</span>
        </div>
      </div>
    </div>
  )
}

export function SettingsTab() {
  const syncStatus = useSignal('未同步')
  const syncStatusColor = useSignal('#666')
  const syncing = useSignal(false)
  const testingRemote = useSignal(false)
  const testingLocal = useSignal(false)

  const globalReplaceFrom = useSignal('')
  const globalReplaceTo = useSignal('')

  const roomReplaceFrom = useSignal('')
  const roomReplaceTo = useSignal('')
  const editingRoomId = useSignal(cachedRoomId.value !== null ? String(cachedRoomId.value) : '')
  const newRoomId = useSignal('')

  const messageBlacklistInput = useSignal('')

  // Local string mirror of `autoSeekBufferThreshold` so the user can type
  // intermediate values like "1." (which `parseFloat` collapses to `1`)
  // without the controlled input rewriting the field mid-keystroke and
  // eating the dot. We write back to the signal only when the buffer
  // parses to a complete in-range number; `onBlur` normalises whatever
  // is left in the field and re-syncs from the canonical value.
  const autoSeekThresholdDraft = useSignal(autoSeekBufferThreshold.value.toString())

  // LLM section: visibility toggle on the password field, plus a tiny
  // status state machine for the "fetch models" call (idle / loading /
  // success / error). Status is colour-coded the same way the remote
  // keyword sync line is, so the user gets the same visual feedback.
  const llmKeyVisible = useSignal(false)
  const llmFetching = useSignal(false)
  const llmFetchStatus = useSignal('')
  const llmFetchStatusColor = useSignal('#666')

  const refreshLlmModels = async () => {
    if (llmFetching.value) return
    llmFetching.value = true
    llmFetchStatus.value = '正在获取模型列表…'
    llmFetchStatusColor.value = '#666'
    try {
      const ids = await fetchLlmModels(llmApiBase.value, llmApiKey.value)
      llmModels.value = ids
      // If the previously selected model isn't in the freshly fetched
      // list (renamed / removed), keep the old id around so the user
      // can SEE that it's stale (rendered via the same "saved but
      // missing" sentinel option as Soniox uses for unplugged mics).
      // The user can switch away themselves; we don't auto-clobber.
      llmFetchStatus.value = `已获取 ${ids.length} 个模型`
      llmFetchStatusColor.value = '#36a185'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      llmFetchStatus.value = `获取失败：${msg}`
      llmFetchStatusColor.value = '#f44'
      appendLog(`❌ LLM 模型列表获取失败：${msg}`)
    } finally {
      llmFetching.value = false
    }
  }

  const updateRemoteStatus = () => {
    const rk = remoteKeywords.value
    const ls = remoteKeywordsLastSync.value
    if (!rk || !ls) {
      syncStatus.value = '未同步'
      syncStatusColor.value = '#666'
      return
    }
    const rid = cachedRoomId.value
    const globalCount = Object.keys(rk.global?.keywords ?? {}).length
    let roomCount = 0
    if (rid !== null) {
      const roomData = rk.rooms?.find(r => String(r.room) === String(rid))
      roomCount = Object.keys(roomData?.keywords ?? {}).length
    }
    const timeStr = new Date(ls).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    syncStatus.value = `最后同步: ${timeStr}，当前房间共 ${globalCount + roomCount} 条规则（全局 ${globalCount} + 当前房间 ${roomCount}）`
    syncStatusColor.value = '#36a185'
  }

  const syncRemote = async () => {
    syncing.value = true
    syncStatus.value = '正在同步…'
    syncStatusColor.value = '#666'
    try {
      const data = await fetchRemoteKeywords()
      remoteKeywords.value = data
      remoteKeywordsLastSync.value = Date.now()
      buildReplacementMap()
      updateRemoteStatus()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      syncStatus.value = `同步失败: ${msg}`
      syncStatusColor.value = '#f44'
      appendLog(`❌ 云端替换规则同步失败: ${msg}`)
    } finally {
      syncing.value = false
    }
  }

  const testKeywordPair = async (
    original: string,
    replaced: string,
    roomId: number,
    csrfToken: string
  ): Promise<{
    originalBlocked: boolean
    replacedBlocked: boolean | null
    originalError?: string
    replacedError?: string
  }> => {
    const originalResult = await sendDanmaku(original, roomId, csrfToken)
    let replacedResult: { success: boolean; error?: string } | null = null
    if (!originalResult.success) {
      await new Promise(r => setTimeout(r, 2000))
      replacedResult = await sendDanmaku(replaced, roomId, csrfToken)
    }
    return {
      originalBlocked: !originalResult.success,
      replacedBlocked: replacedResult ? !replacedResult.success : null,
      originalError: originalResult.error,
      replacedError: replacedResult?.error,
    }
  }

  const logTestResult = (
    result: {
      originalBlocked: boolean
      replacedBlocked: boolean | null
      originalError?: string
      replacedError?: string
    },
    replacedKeyword: string
  ): number => {
    if (result.originalBlocked) {
      appendLog(`  ✅ 原词被屏蔽 (错误: ${result.originalError})，测试替换词: ${replacedKeyword}`)
      if (result.replacedBlocked) {
        appendLog(`  ❌ 替换词也被屏蔽 (错误: ${result.replacedError})`)
      } else {
        appendLog('  ✅ 替换词未被屏蔽')
      }
      return 1
    }
    appendLog('  ⚠️ 原词未被屏蔽，请考虑提交贡献词条')
    return 0
  }

  const testRemote = async () => {
    if (
      !confirm(
        '即将测试当前直播间的云端替换词，请避免在当前直播间正在直播时进行测试，否则可能会给主播造成困扰，是否继续？'
      )
    )
      return
    testingRemote.value = true
    try {
      const roomId = await ensureRoomId()
      const csrfToken = getCsrfToken()
      if (!csrfToken) {
        appendLog('❌ 未找到登录信息，请先登录 Bilibili')
        return
      }
      const rk = remoteKeywords.value
      const globalKw = Object.entries(rk?.global?.keywords ?? {})
        .filter(([f]) => f)
        .map(([from, to]) => ({ from, to }))
      const rid = cachedRoomId.value
      const roomKw =
        rid !== null
          ? Object.entries(rk?.rooms?.find(r => String(r.room) === String(rid))?.keywords ?? {})
              .filter(([f]) => f)
              .map(([from, to]) => ({ from, to }))
          : []
      const total = globalKw.length + roomKw.length
      if (total === 0) {
        appendLog('⚠️ 没有云端替换词可供测试，请先同步云端规则')
        return
      }
      appendLog(`🔵 开始测试云端替换词 ${total} 个（全局 ${globalKw.length} + 房间 ${roomKw.length}）`)
      let tested = 0
      let totalBlocked = 0

      if (globalKw.length > 0) {
        appendLog(`\n📡 测试云端全局替换词 (${globalKw.length} 个)`)
        let blockedCount = 0
        for (const { from, to } of globalKw) {
          tested++
          appendLog(`[${tested}/${total}] 测试: ${from}`)
          const result = await testKeywordPair(from, to, roomId, csrfToken)
          const b = logTestResult(result, to)
          blockedCount += b
          totalBlocked += b
          if (tested < total) await new Promise(r => setTimeout(r, 2000))
        }
        appendLog(`📡 全局替换词测试完成：${blockedCount}/${globalKw.length} 个原词被屏蔽`)
      }

      if (roomKw.length > 0) {
        appendLog(`\n🏠 测试云端房间专属替换词 (${roomKw.length} 个)`)
        let blockedCount = 0
        for (const { from, to } of roomKw) {
          tested++
          appendLog(`[${tested}/${total}] 测试: ${from}`)
          const result = await testKeywordPair(from, to, roomId, csrfToken)
          const b = logTestResult(result, to)
          blockedCount += b
          totalBlocked += b
          if (tested < total) await new Promise(r => setTimeout(r, 2000))
        }
        appendLog(`🏠 房间专属替换词测试完成：${blockedCount}/${roomKw.length} 个原词被屏蔽`)
      }

      appendLog(`\n🔵 云端测试完成！共测试 ${total} 个词，其中 ${totalBlocked} 个原词被屏蔽`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 测试出错：${msg}`)
    } finally {
      testingRemote.value = false
    }
  }

  const testLocal = async () => {
    if (!confirm('即将测试本地替换词，请避免在当前直播间正在直播时进行测试，否则可能会给主播造成困扰，是否继续？'))
      return
    testingLocal.value = true
    try {
      const roomId = await ensureRoomId()
      const csrfToken = getCsrfToken()
      if (!csrfToken) {
        appendLog('❌ 未找到登录信息，请先登录 Bilibili')
        return
      }
      const globalRules = localGlobalRules.value.filter(r => r.from)
      const rid = cachedRoomId.value
      const roomRules = rid !== null ? (localRoomRules.value[String(rid)] ?? []).filter(r => r.from) : []
      const total = globalRules.length + roomRules.length
      if (total === 0) {
        appendLog('⚠️ 没有本地替换词可供测试，请先添加本地替换规则')
        return
      }
      appendLog(`🔵 开始测试本地替换词 ${total} 个（全局 ${globalRules.length} + 当前房间 ${roomRules.length}）`)
      let tested = 0
      let totalBlocked = 0

      if (globalRules.length > 0) {
        appendLog(`\n📋 测试本地全局替换词 (${globalRules.length} 个)`)
        let blockedCount = 0
        for (const rule of globalRules) {
          tested++
          appendLog(`[${tested}/${total}] 测试: ${rule.from}`)
          const result = await testKeywordPair(rule.from ?? '', rule.to ?? '', roomId, csrfToken)
          const b = logTestResult(result, rule.to ?? '')
          blockedCount += b
          totalBlocked += b
          if (tested < total) await new Promise(r => setTimeout(r, 2000))
        }
        appendLog(`📋 本地全局替换词测试完成：${blockedCount}/${globalRules.length} 个原词被屏蔽`)
      }

      if (roomRules.length > 0) {
        appendLog(`\n🏠 测试本地房间替换词 (${roomRules.length} 个)`)
        let blockedCount = 0
        for (const rule of roomRules) {
          tested++
          appendLog(`[${tested}/${total}] 测试: ${rule.from}`)
          const result = await testKeywordPair(rule.from ?? '', rule.to ?? '', roomId, csrfToken)
          const b = logTestResult(result, rule.to ?? '')
          blockedCount += b
          totalBlocked += b
          if (tested < total) await new Promise(r => setTimeout(r, 2000))
        }
        appendLog(`🏠 本地房间替换词测试完成：${blockedCount}/${roomRules.length} 个原词被屏蔽`)
      }

      appendLog(`\n🔵 本地测试完成！共测试 ${total} 个词，其中 ${totalBlocked} 个原词被屏蔽`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 测试出错：${msg}`)
    } finally {
      testingLocal.value = false
    }
  }

  const addGlobalRule = () => {
    if (!globalReplaceFrom.value) {
      appendLog('⚠️ 替换前的内容不能为空')
      return
    }
    localGlobalRules.value = [...localGlobalRules.value, { from: globalReplaceFrom.value, to: globalReplaceTo.value }]
    buildReplacementMap()
    globalReplaceFrom.value = ''
    globalReplaceTo.value = ''
  }

  const removeGlobalRule = (index: number) => {
    const next = [...localGlobalRules.value]
    next.splice(index, 1)
    localGlobalRules.value = next
    buildReplacementMap()
  }

  const addRoomRule = () => {
    const rid = editingRoomId.value
    if (!rid) {
      appendLog('⚠️ 请先选择一个直播间')
      return
    }
    if (!roomReplaceFrom.value) {
      appendLog('⚠️ 替换前的内容不能为空')
      return
    }
    const all = { ...localRoomRules.value }
    const existing = all[rid] ?? []
    all[rid] = [...existing, { from: roomReplaceFrom.value, to: roomReplaceTo.value }]
    localRoomRules.value = all
    buildReplacementMap()
    roomReplaceFrom.value = ''
    roomReplaceTo.value = ''
  }

  const removeRoomRule = (index: number) => {
    const rid = editingRoomId.value
    if (!rid) return
    const all = { ...localRoomRules.value }
    const existing = [...(all[rid] ?? [])]
    existing.splice(index, 1)
    if (existing.length === 0) {
      delete all[rid]
    } else {
      all[rid] = existing
    }
    localRoomRules.value = all
    buildReplacementMap()
  }

  const addRoom = () => {
    const rid = newRoomId.value.trim()
    if (!rid) return
    if (knownRoomIds.includes(rid)) {
      editingRoomId.value = rid
      newRoomId.value = ''
      return
    }
    const all = { ...localRoomRules.value }
    all[rid] = all[rid] ?? []
    localRoomRules.value = all
    editingRoomId.value = rid
    newRoomId.value = ''
  }

  const deleteRoom = (rid: string) => {
    const all = { ...localRoomRules.value }
    delete all[rid]
    localRoomRules.value = all
    if (editingRoomId.value === rid) {
      editingRoomId.value = cachedRoomId.value !== null ? String(cachedRoomId.value) : ''
    }
    buildReplacementMap()
  }

  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    const ls = remoteKeywordsLastSync.value
    if (!ls || Date.now() - ls > SYNC_INTERVAL) {
      void syncRemote()
    } else {
      updateRemoteStatus()
    }
    const timer = setInterval(() => void syncRemote(), SYNC_INTERVAL)
    return () => clearInterval(timer)
  }, [])

  // cachedRoomId is resolved lazily by ensureRoomId(), so it may still be null
  // when this component first mounts. Sync it to the room-rule editor once
  // available, but only if the user hasn't already picked a room manually.
  useEffect(() => {
    if (editingRoomId.value) return
    const rid = cachedRoomId.value
    if (rid !== null) {
      editingRoomId.value = String(rid)
    }
  }, [editingRoomId.value, cachedRoomId.value])

  const globalRules = localGlobalRules.value
  const knownRoomIds = Object.keys(localRoomRules.value)
  const currentRoomStr = cachedRoomId.value !== null ? String(cachedRoomId.value) : null
  if (currentRoomStr && !knownRoomIds.includes(currentRoomStr)) {
    knownRoomIds.unshift(currentRoomStr)
  }
  const editingRules = editingRoomId.value ? (localRoomRules.value[editingRoomId.value] ?? []) : []

  const blacklistEntries = Object.entries(autoBlendUserBlacklist.value).sort(([uidA, unameA], [uidB, unameB]) =>
    (unameA || uidA).localeCompare(unameB || uidB, 'zh-Hans-CN')
  )

  const removeFromBlacklist = (uid: string) => {
    const next = { ...autoBlendUserBlacklist.value }
    const removedUname = next[uid]
    delete next[uid]
    autoBlendUserBlacklist.value = next
    appendLog(`🚲 已解除融入黑名单：${removedUname || uid}`)
  }

  const clearBlacklist = () => {
    if (!confirm(`确定清空 ${blacklistEntries.length} 个黑名单用户？`)) return
    autoBlendUserBlacklist.value = {}
    appendLog('🚲 已清空融入黑名单')
  }

  // Sort lexicographically (zh-Hans-CN locale) so the list is stable across
  // adds — the underlying Record key order is insertion-defined and would
  // otherwise reshuffle every time the user added an entry.
  const messageBlacklistEntries = Object.keys(autoBlendMessageBlacklist.value).sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN')
  )

  const addToMessageBlacklist = () => {
    // Match the same trim semantics auto-blend uses to key counters; an
    // entry added with a trailing space would otherwise never match an
    // incoming danmaku.
    const text = messageBlacklistInput.value.trim()
    if (!text) {
      appendLog('⚠️ 消息黑名单内容不能为空')
      return
    }
    // `Object.hasOwn` (not `in`) — see auto-blend.ts for the prototype-chain
    // gotcha. Without this, typing e.g. "toString" would always claim the
    // entry already exists and silently swallow the input.
    if (Object.hasOwn(autoBlendMessageBlacklist.value, text)) {
      appendLog(`🚲 已在融入消息黑名单：${text}`)
      messageBlacklistInput.value = ''
      return
    }
    autoBlendMessageBlacklist.value = { ...autoBlendMessageBlacklist.value, [text]: 1 }
    appendLog(`🚲 已加入融入消息黑名单：${text}`)
    messageBlacklistInput.value = ''
  }

  const removeFromMessageBlacklist = (text: string) => {
    const next = { ...autoBlendMessageBlacklist.value }
    delete next[text]
    autoBlendMessageBlacklist.value = next
    appendLog(`🚲 已解除融入消息黑名单：${text}`)
  }

  const clearMessageBlacklist = () => {
    if (!confirm(`确定清空 ${messageBlacklistEntries.length} 条黑名单消息？`)) return
    autoBlendMessageBlacklist.value = {}
    appendLog('🚲 已清空融入消息黑名单')
  }

  // Hidden file input that the import button drives via .click(). We keep
  // it mounted (rather than constructing one ad-hoc) so the picker stays
  // anchored inside the dialog and we can reset .value after each pick.
  const importFileInputRef = useRef<HTMLInputElement>(null)
  // Separate input for the notes-only import. Sharing one input across
  // both flows would force us to multiplex on the file content shape;
  // a second hidden input keeps each handler single-purpose.
  const importNotesInputRef = useRef<HTMLInputElement>(null)

  const handleExport = () => {
    try {
      const count = exportSettings()
      appendLog(`💾 已导出 ${count} 项设置`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`❌ 导出设置失败：${msg}`)
    }
  }

  const handleImportClick = () => {
    importFileInputRef.current?.click()
  }

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text()
      const parsed = parseSettingsFile(text)
      const count = Object.keys(parsed.data).length
      const exportedAt = parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleString('zh-CN') : '未知时间'
      // Confirm AFTER parsing so we can show real numbers, and so an
      // unparsable file fails fast without nagging the user.
      const ok = confirm(
        `即将导入 ${count} 项设置（导出于 ${exportedAt}）。\n\n此操作将覆盖当前所有设置且无法撤销，导入完成后页面会自动刷新，是否继续？`
      )
      if (!ok) return
      applySettingsFile(parsed)
      // Signals from gmSignal cache their initial value at module load,
      // so reload to pick up the freshly written GM values. Reload before
      // any signal write-back can clobber the imported data.
      location.reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      alert(`导入设置失败：${msg}`)
      appendLog(`❌ 导入设置失败：${msg}`)
    }
  }

  // === User notes import / export ======================================
  //
  // Notes round-trip through their own JSON file so a viewer can share a
  // curated set without leaking unrelated settings (LLM keys, etc.). The
  // export emits a fresh download immediately; import opens a confirm
  // with two modes (merge vs replace) so the destructive path is opt-in.

  const handleNotesExport = () => {
    try {
      const count = exportUserNotes()
      if (count === 0) {
        appendLog('📝 暂无备注可导出（已生成空文件）')
      } else {
        appendLog(`📝 已导出 ${count} 条用户备注`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`❌ 导出备注失败：${msg}`)
    }
  }

  const handleNotesImportClick = () => {
    importNotesInputRef.current?.click()
  }

  const handleNotesImportFile = async (file: File) => {
    try {
      const text = await file.text()
      const parsed = parseUserNotesFile(text)
      const count = Object.keys(parsed.notes).length
      const exportedAt = parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleString('zh-CN') : '未知时间'
      const existing = Object.keys(userNotes.value).length
      // Three-way prompt: 合并 keeps the user's local notes and applies
      // the file on top using newest-`updatedAt` precedence; 覆盖 wipes
      // local notes first. `confirm` only has two buttons, so we use a
      // staged prompt — first confirm import, then pick mode.
      const ok = confirm(
        `即将导入备注文件\n\n文件包含 ${count} 条备注（导出于 ${exportedAt}），本地现有 ${existing} 条。\n\n点击「确定」继续选择导入方式。`
      )
      if (!ok) return
      let mode: UserNotesImportMode = 'merge'
      if (existing > 0) {
        // Two staged confirms because the browser `confirm` API only
        // exposes two buttons. The user already opted into importing;
        // this second prompt only picks the additive vs destructive
        // mode. 确定 maps to the safe additive merge (the default
        // recommendation); 取消 escalates to the destructive overwrite.
        const merge = confirm(
          `请选择导入方式：\n\n确定 = 合并（同 UID 取较新版本，本地独有备注会保留）\n取消 = 覆盖（删除现有 ${existing} 条本地备注，仅保留文件中的备注）`
        )
        mode = merge ? 'merge' : 'replace'
      }
      const result = applyUserNotesFile(parsed, mode)
      const summary =
        mode === 'replace'
          ? `覆盖完成：导入 ${result.added} 条，删除 ${result.removed} 条`
          : `合并完成：新增 ${result.added} 条，更新 ${result.updated} 条，跳过 ${result.skipped} 条（本地更新）`
      appendLog(`📝 ${summary}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      alert(`导入备注失败：${msg}`)
      appendLog(`❌ 导入备注失败：${msg}`)
    }
  }

  return (
    <>
      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>
          云端规则替换{' '}
          <a
            href='https://github.com/laplace-live/public/blob/master/artifacts/livesrtream-keywords.json'
            target='_blank'
            class={LINK_CLASS}
            rel='noopener'
          >
            我要贡献规则
          </a>
        </div>
        <div class={HINT_CLASS}>每10分钟会自动同步云端替换规则</div>
        <div class={ROW_CLASS}>
          <Button variant='outline' size='sm' disabled={syncing.value} onClick={() => void syncRemote()}>
            {syncing.value ? '同步中…' : '同步'}
          </Button>
          <Button variant='outline' size='sm' disabled={testingRemote.value} onClick={() => void testRemote()}>
            {testingRemote.value ? '测试中…' : '测试云端词库'}
          </Button>
          {/* Status text colour cycles through neutral/success/error driven by
              the sync state machine; keeping it as inline color avoids
              enumerating each state as a class. */}
          <span style={{ color: syncStatusColor.value }}>{syncStatus.value}</span>
        </div>
      </div>

      <div class={SECTION_CLASS}>
        <div class={ROW_CLASS}>
          <div class='font-bold'>本地全局规则</div>
          <Button variant='outline' size='sm' disabled={testingLocal.value} onClick={() => void testLocal()}>
            {testingLocal.value ? '测试中…' : '测试本地词库'}
          </Button>
        </div>
        <div class={HINT_CLASS}>适用于所有直播间，优先级高于云端规则</div>
        <div class='mb-2 max-h-40 overflow-y-auto'>
          {globalRules.length === 0 ? (
            <div class={EMPTY_CLASS}>暂无全局替换规则，请在下方添加</div>
          ) : (
            globalRules.map((rule, i) => (
              <div key={i} class={LIST_ROW_CLASS}>
                <span class={LIST_ROW_TEXT}>
                  {rule.from ?? '(空)'} → {rule.to ?? '(空)'}
                </span>
                <Button variant='ghost' size='sm' className={DELETE_BTN_CLASS} onClick={() => removeGlobalRule(i)}>
                  删除
                </Button>
              </div>
            ))
          )}
        </div>
        <div class={ADD_ROW_CLASS}>
          <Input
            placeholder='替换前'
            className={FILL_INPUT_CLASS}
            value={globalReplaceFrom.value}
            onInput={e => {
              globalReplaceFrom.value = e.currentTarget.value
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault()
                addGlobalRule()
              }
            }}
          />
          <span>→</span>
          <Input
            placeholder='替换后'
            className={FILL_INPUT_CLASS}
            value={globalReplaceTo.value}
            onInput={e => {
              globalReplaceTo.value = e.currentTarget.value
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault()
                addGlobalRule()
              }
            }}
          />
          <Button variant='outline' size='sm' onClick={addGlobalRule}>
            添加
          </Button>
        </div>
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>本地直播间规则</div>
        <div class={HINT_CLASS}>仅在对应直播间生效；优先级高于全局规则</div>
        <div class={ROW_CLASS}>
          <NativeSelect
            value={editingRoomId.value}
            onChange={e => {
              editingRoomId.value = e.currentTarget.value
            }}
            className='min-w-30'
          >
            <option value='' disabled>
              选择直播间
            </option>
            {knownRoomIds.map(rid => (
              <option key={rid} value={rid}>
                {rid}
                {rid === currentRoomStr ? ' (当前)' : ''}
              </option>
            ))}
          </NativeSelect>
          <div class='flex items-center gap-1'>
            <Input
              placeholder='房间号'
              className='w-20'
              value={newRoomId.value}
              onInput={e => {
                newRoomId.value = e.currentTarget.value.replace(/\D/g, '')
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.isComposing) {
                  e.preventDefault()
                  addRoom()
                }
              }}
            />
            <Button variant='outline' size='sm' onClick={addRoom}>
              添加房间
            </Button>
          </div>
          {editingRoomId.value && editingRoomId.value !== currentRoomStr && (
            <Button
              variant='ghost'
              size='sm'
              className={DELETE_BTN_CLASS}
              onClick={() => deleteRoom(editingRoomId.value)}
            >
              删除此房间
            </Button>
          )}
        </div>

        {editingRoomId.value ? (
          <>
            <div class='mb-2 max-h-40 overflow-y-auto'>
              {editingRules.length === 0 ? (
                <div class={EMPTY_CLASS}>暂无此房间的替换规则，请在下方添加</div>
              ) : (
                editingRules.map((rule, i) => (
                  <div key={i} class={LIST_ROW_CLASS}>
                    <span class={LIST_ROW_TEXT}>
                      {rule.from ?? '(空)'} → {rule.to ?? '(空)'}
                    </span>
                    <Button variant='ghost' size='sm' className={DELETE_BTN_CLASS} onClick={() => removeRoomRule(i)}>
                      删除
                    </Button>
                  </div>
                ))
              )}
            </div>
            <div class={ADD_ROW_CLASS}>
              <Input
                placeholder='替换前'
                className={FILL_INPUT_CLASS}
                value={roomReplaceFrom.value}
                onInput={e => {
                  roomReplaceFrom.value = e.currentTarget.value
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.isComposing) {
                    e.preventDefault()
                    addRoomRule()
                  }
                }}
              />
              <span>→</span>
              <Input
                placeholder='替换后'
                className={FILL_INPUT_CLASS}
                value={roomReplaceTo.value}
                onInput={e => {
                  roomReplaceTo.value = e.currentTarget.value
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.isComposing) {
                    e.preventDefault()
                    addRoomRule()
                  }
                }}
              />
              <Button variant='outline' size='sm' onClick={addRoomRule}>
                添加
              </Button>
            </div>
          </>
        ) : (
          <div class={EMPTY_CLASS}>请选择或添加一个直播间</div>
        )}
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>
          自动融入观众黑名单
          {blacklistEntries.length > 0 && <span class='font-normal text-ga6'> ({blacklistEntries.length})</span>}
        </div>
        <div class={HINT_CLASS}>
          名单中的用户发送的弹幕不会计入「自动融入」统计。在弹幕框点击用户名可将该用户加入 / 移出名单。
        </div>
        <div class='mb-2 max-h-50 overflow-y-auto'>
          {blacklistEntries.length === 0 ? (
            <div class={EMPTY_CLASS}>暂无黑名单用户</div>
          ) : (
            blacklistEntries.map(([uid, uname]) => (
              <div key={uid} class={LIST_ROW_CLASS}>
                <span class='flex flex-1 items-baseline gap-2 break-all'>
                  <a href={`https://space.bilibili.com/${uid}`} target='_blank' rel='noopener' class={LINK_CLASS}>
                    {uname || '(无昵称)'}
                  </a>
                  <span class='font-mono text-[11px] text-ga6'>{uid}</span>
                </span>
                <Button variant='ghost' size='sm' className={DELETE_BTN_CLASS} onClick={() => removeFromBlacklist(uid)}>
                  移出
                </Button>
              </div>
            ))
          )}
        </div>
        {blacklistEntries.length > 0 && (
          <Button variant='outline' size='sm' onClick={clearBlacklist}>
            清空名单
          </Button>
        )}
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>
          自动融入消息黑名单
          {messageBlacklistEntries.length > 0 && (
            <span class='font-normal text-ga6'> ({messageBlacklistEntries.length})</span>
          )}
        </div>
        <div class={HINT_CLASS}>
          与名单中弹幕完全一致的消息不会计入「自动融入」统计（精确匹配）。在弹幕框点击弹幕可将该消息加入 /
          移出名单，或在下方手动添加。
        </div>
        <div class='mb-2 max-h-50 overflow-y-auto'>
          {messageBlacklistEntries.length === 0 ? (
            <div class={EMPTY_CLASS}>暂无黑名单消息</div>
          ) : (
            messageBlacklistEntries.map(text => (
              <div key={text} class={LIST_ROW_CLASS}>
                <span class={LIST_ROW_TEXT}>{text}</span>
                <Button
                  variant='ghost'
                  size='sm'
                  className={DELETE_BTN_CLASS}
                  onClick={() => removeFromMessageBlacklist(text)}
                >
                  移出
                </Button>
              </div>
            ))
          )}
        </div>
        <div class={ADD_ROW_CLASS}>
          <Input
            placeholder='输入弹幕内容（精确匹配）'
            className={FILL_INPUT_CLASS}
            value={messageBlacklistInput.value}
            onInput={e => {
              messageBlacklistInput.value = e.currentTarget.value
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault()
                addToMessageBlacklist()
              }
            }}
          />
          <Button variant='outline' size='sm' onClick={addToMessageBlacklist}>
            添加
          </Button>
          {messageBlacklistEntries.length > 0 && (
            <Button variant='outline' size='sm' onClick={clearMessageBlacklist}>
              清空名单
            </Button>
          )}
        </div>
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>LLM 设置</div>
        <div class={HINT_CLASS}>
          配置兼容 OpenAI API 的大语言模型，用于 AI 集成。模型列表通过 <code>GET {'{API 地址}'}/models</code>{' '}
          获取，因此需要服务端允许浏览器跨域访问
        </div>
        <div class={ROW_CLASS}>
          <Label htmlFor='llmApiBase'>API 地址</Label>
          <Input
            id='llmApiBase'
            placeholder='https://api.openai.com/v1'
            className='min-w-37.5 flex-1'
            value={llmApiBase.value}
            onInput={e => {
              llmApiBase.value = e.currentTarget.value
            }}
          />
        </div>
        <div class={ROW_CLASS}>
          <Label htmlFor='llmApiKey'>API Key</Label>
          <Input
            id='llmApiKey'
            // Visibility toggle mirrors Soniox: password by default so the
            // key isn't shoulder-surfable, but reveal-on-demand keeps it
            // editable / verifiable without copy-paste gymnastics.
            type={llmKeyVisible.value ? 'text' : 'password'}
            placeholder='sk-...'
            className='min-w-37.5 flex-1'
            value={llmApiKey.value}
            onInput={e => {
              llmApiKey.value = e.currentTarget.value
            }}
          />
          <Button
            variant='outline'
            size='sm'
            onClick={() => {
              llmKeyVisible.value = !llmKeyVisible.value
            }}
          >
            {llmKeyVisible.value ? '隐藏' : '显示'}
          </Button>
        </div>
        <div class={ROW_CLASS}>
          <Label htmlFor='llmModel'>模型</Label>
          <Combobox
            id='llmModel'
            className='min-w-37.5 flex-1'
            value={llmModel.value}
            // Map LlmModel → ComboboxOption + carry the rich payload
            // through so renderItem below can read pricing without a
            // second lookup. Building the array inline is fine here:
            // llmModels only changes when the user clicks 刷新, and the
            // Combobox's filter/highlight effects already deal with
            // identity changes across renders.
            options={llmModels.value.map(m => {
              const priceStr = formatLlmPricing(m.pricing)
              return {
                value: m.id,
                // Default trigger text + filter target. We DON'T use
                // `m.name` as the label even when it exists, because
                // OpenRouter's friendly names ("OpenAI: GPT-4o") are
                // longer than the id and would push pricing off-row.
                // The friendly name still feeds searchText.
                label: m.id,
                // Filter haystack: id + friendly name + pricing
                // string, so a query of "free" or "$2.5" or
                // "OpenAI" all surface the right rows.
                searchText: [m.id, m.name, priceStr].filter(Boolean).join(' '),
                model: m,
                priceStr,
              }
            })}
            onChange={v => {
              llmModel.value = v
            }}
            placeholder='选择模型'
            searchPlaceholder='输入关键词过滤模型…'
            emptyText='未找到匹配模型'
            unloadedText='请点击「刷新」获取模型列表'
            // Stale-but-persisted sentinel — same pattern the STT tab
            // uses for an unplugged audio device: surface the saved id
            // so the user can SEE what's selected and pick something
            // else, rather than silently falling back to placeholder.
            missingLabel={v => `${v}（已保存，不在当前列表中）`}
            renderItem={opt => (
              <div class='flex flex-col gap-0.5'>
                <span class={cn('break-all', opt.value === llmModel.value && 'font-bold')}>{opt.value}</span>
                {opt.priceStr && <span class='text-ga6'>{opt.priceStr}</span>}
              </div>
            )}
          />
          <Button
            variant='outline'
            size='sm'
            disabled={llmFetching.value || !llmApiBase.value.trim() || !llmApiKey.value.trim()}
            onClick={() => void refreshLlmModels()}
          >
            {llmFetching.value ? '加载中…' : '刷新'}
          </Button>
        </div>
        {llmFetchStatus.value && (
          // Status colour cycles through neutral / success / error driven
          // by the fetch state machine; inline color matches the remote
          // keyword sync line above so the same visual language repeats.
          <div style={{ color: llmFetchStatusColor.value }}>{llmFetchStatus.value}</div>
        )}
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>LLM 提示词</div>
        <div class={HINT_CLASS}>
          全局提示词会自动拼接到每个功能特定提示词的前面，作为所有 LLM
          调用的统一前缀（例如设定角色、风格规范、安全约束等）。每条提示词的第一行会作为列表中的预览名称，列表中选中的那条会被使用。可以为同一个范围保存多条提示词在不同场景间切换。
        </div>

        {/* Global subsection: pinned to the top because its contents
            apply to every feature below. Visual order matches "global
            first, then specifics" so the user reads the chain in the
            same order the LLM ultimately does. The bottom divider
            visually splits "shared baseline" from "per-feature
            instructions" so the hierarchy is obvious at a glance. */}
        <div class='mb-3 border-b border-b-ga2 border-b-solid pb-3'>
          <Label htmlFor='llmPromptGlobal' className='mb-1 block font-bold'>
            全局提示词
          </Label>
          <div class='mb-1 text-ga6'>
            会拼接到下方每个功能提示词的前面。常用于设置统一的角色、语气、安全规则等。留空则只发送对应功能的提示词
          </div>
          <PromptManager
            selectId='llmPromptGlobal'
            prompts={llmPromptsGlobal.value}
            activeIndex={llmActivePromptGlobal.value}
            onPromptsChange={v => {
              llmPromptsGlobal.value = v
            }}
            onActiveIndexChange={v => {
              llmActivePromptGlobal.value = v
            }}
            placeholder='例如：你是一个哔哩哔哩弹幕助手，回复需保持简短、自然、避免敏感词，并不要使用表情符号…'
          />
        </div>

        {/* Per-feature subsection layout. The triple repeats the same
            shape (label + hint + PromptManager) so the user can scan
            top-to-bottom and trust that "find the right block, edit the
            prompt" works the same way for every feature. */}
        <div class='mb-3'>
          <Label htmlFor='llmPromptNormalSend' className='mb-1 block font-bold'>
            常规发送
          </Label>
          <div class='mb-1 text-ga6'>用于常规发送 / +1 / 偷弹幕等手动发送动作的 LLM 改写</div>
          <PromptManager
            selectId='llmPromptNormalSend'
            prompts={llmPromptsNormalSend.value}
            activeIndex={llmActivePromptNormalSend.value}
            onPromptsChange={v => {
              llmPromptsNormalSend.value = v
            }}
            onActiveIndexChange={v => {
              llmActivePromptNormalSend.value = v
            }}
            placeholder='例如：用最少的改动，略微修改原文内容，保证原文意思不变'
          />
        </div>

        <div class='mb-3'>
          <Label htmlFor='llmPromptAutoBlend' className='mb-1 block font-bold'>
            自动融入
          </Label>
          <div class='mb-1 text-ga6'>用于「自动融入」检测到趋势后调用 LLM 生成跟随弹幕的提示词</div>
          <PromptManager
            selectId='llmPromptAutoBlend'
            prompts={llmPromptsAutoBlend.value}
            activeIndex={llmActivePromptAutoBlend.value}
            onPromptsChange={v => {
              llmPromptsAutoBlend.value = v
            }}
            onActiveIndexChange={v => {
              llmActivePromptAutoBlend.value = v
            }}
            placeholder='例如：你是一个龟龟暖男，把所有输入内容改写成暖男弹幕'
          />
        </div>

        <div class='mb-3'>
          <Label htmlFor='llmPromptAutoSend' className='mb-1 block font-bold'>
            独轮车
          </Label>
          <div class='mb-1 text-ga6'>用于独轮车自动发送时，让 LLM 在每轮发送前对模板进行改写</div>
          <PromptManager
            selectId='llmPromptAutoSend'
            prompts={llmPromptsAutoSend.value}
            activeIndex={llmActivePromptAutoSend.value}
            onPromptsChange={v => {
              llmPromptsAutoSend.value = v
            }}
            onActiveIndexChange={v => {
              llmActivePromptAutoSend.value = v
            }}
            placeholder='例如：你是一个猫娘，所有弹幕最后都要加「喵～」'
          />
        </div>

        <div>
          <Label htmlFor='llmPromptAiChat' className='mb-1 block font-bold'>
            AI 陪聊
          </Label>
          <div class='mb-1 text-ga6'>
            用于「同传 → AI 陪聊」根据语音转录和观众弹幕生成模拟观众弹幕的角色设定与生成规则
          </div>
          <PromptManager
            selectId='llmPromptAiChat'
            prompts={llmPromptsAiChat.value}
            activeIndex={llmActivePromptAiChat.value}
            onPromptsChange={v => {
              llmPromptsAiChat.value = v
            }}
            onActiveIndexChange={v => {
              llmActivePromptAiChat.value = v
            }}
            placeholder='例如：你是一位幽默的成年观众，喜欢用简短中文吐槽…'
          />
        </div>
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>播放器追帧</div>
        <div class={HINT_CLASS}>
          自动微调播放速度以追上直播实时位置，减少观看延迟。事件驱动（无定时轮询），同时支持视频和仅音频模式。
        </div>
        <div class='flex flex-col gap-2'>
          <Checkbox
            id='autoQualityEnabled'
            checked={autoQualityEnabled.value}
            onInput={e => {
              autoQualityEnabled.value = e.currentTarget.checked
            }}
            label='进入直播间时自动切换到最高画质'
          />
          <Checkbox
            id='autoSeekEnabled'
            checked={autoSeekEnabled.value}
            onInput={e => {
              autoSeekEnabled.value = e.currentTarget.checked
            }}
            label='启用自动追帧'
          />
          <div class='flex items-center gap-1'>
            <Label htmlFor='autoSeekBufferThreshold'>目标延迟</Label>
            <Input
              id='autoSeekBufferThreshold'
              type='number'
              min='0.3'
              max='10'
              step='0.1'
              className='w-20'
              // Bind to the local string draft, not the float signal.
              // Typing "1." would otherwise round-trip as `value={1}`
              // and erase the dot before the user can type the "5".
              value={autoSeekThresholdDraft.value}
              disabled={!autoSeekEnabled.value}
              onInput={e => {
                const raw = e.currentTarget.value
                autoSeekThresholdDraft.value = raw
                // Only commit to the persisted signal when the field
                // parses to a complete, in-range number. Mid-typing
                // states (empty, "1.", ".5") are kept in the draft
                // but don't overwrite the threshold yet.
                const v = parseFloat(raw)
                if (Number.isFinite(v) && v >= 0.3 && v <= 10) {
                  autoSeekBufferThreshold.value = v
                }
              }}
              onBlur={() => {
                // Normalise on commit: clamp out-of-range / unparsable
                // input, then re-render the draft from the canonical
                // value so the field always reads back exactly what's
                // persisted.
                let v = parseFloat(autoSeekThresholdDraft.value)
                if (!Number.isFinite(v) || v < 0.3) v = 0.3
                else if (v > 10) v = 10
                autoSeekBufferThreshold.value = v
                autoSeekThresholdDraft.value = v.toString()
              }}
            />
            <Label htmlFor='autoSeekBufferThreshold'>秒（延迟过低容易卡顿）</Label>
          </div>
          {autoSeekEnabled.value && (
            <AutoSeekMetrics
              bufferLen={autoSeekCurrentBufferLen.value}
              rate={autoSeekCurrentRate.value}
              threshold={autoSeekBufferThreshold.value}
            />
          )}
        </div>
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>其他设置</div>
        <div class='flex flex-col gap-2'>
          <Checkbox
            id='danmakuDirectMode'
            checked={danmakuDirectMode.value}
            onInput={e => {
              danmakuDirectMode.value = e.currentTarget.checked
            }}
            label='+1模式（在聊天消息旁显示偷弹幕和+1按钮）'
          />
          <div class='flex pl-5'>
            <Checkbox
              id='danmakuDirectConfirm'
              checked={danmakuDirectConfirm.value}
              disabled={!danmakuDirectMode.value}
              onInput={e => {
                danmakuDirectConfirm.value = e.currentTarget.checked
              }}
              label='+1弹幕发送前需确认（防误触）'
            />
          </div>
          <div class='flex pl-5'>
            <Checkbox
              id='danmakuDirectAlwaysShow'
              checked={danmakuDirectAlwaysShow.value}
              disabled={!danmakuDirectMode.value}
              onInput={e => {
                danmakuDirectAlwaysShow.value = e.currentTarget.checked
              }}
              label='总是显示偷/+1按钮'
            />
          </div>
          <Checkbox
            id='forceScrollDanmaku'
            checked={forceScrollDanmaku.value}
            onInput={e => {
              forceScrollDanmaku.value = e.currentTarget.checked
            }}
            label='脚本载入时强制配置弹幕位置为滚动方向'
          />
          <Checkbox
            id='unlockLiveBlock'
            checked={unlockLiveBlock.value}
            onInput={e => {
              unlockLiveBlock.value = e.currentTarget.checked
            }}
            label='直播间拉黑解锁（刷新生效，仅布局解锁）'
          />
          <Checkbox
            id='unlockSpaceBlock'
            checked={unlockSpaceBlock.value}
            onInput={e => {
              unlockSpaceBlock.value = e.currentTarget.checked
            }}
            label='空间拉黑解锁（刷新生效，仅布局解锁）'
          />
          <Checkbox
            id='optimizeLayout'
            checked={optimizeLayout.value}
            onInput={e => {
              optimizeLayout.value = e.currentTarget.checked
            }}
            label='优化布局'
          />
        </div>
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>主播额外信息</div>
        <div class={HINT_CLASS}>
          在右下角按钮组中显示一个「ⓘ」按钮，点开可查看当前主播的额外信息。数据来自 LAPLACE Live!
          的公开聚合接口，按需启用所需类目，未启用的类目不会发起任何请求
        </div>
        <div class='flex flex-col gap-1'>
          <Checkbox
            id='infoFertilityEnabled'
            checked={infoFertilityEnabled.value}
            onInput={e => {
              infoFertilityEnabled.value = e.currentTarget.checked
            }}
            label='显示魔法期'
          />
          <Checkbox
            id='infoGuildEnabled'
            checked={infoGuildEnabled.value}
            onInput={e => {
              infoGuildEnabled.value = e.currentTarget.checked
            }}
            label='显示公会信息'
          />
          <Checkbox
            id='infoMcnEnabled'
            checked={infoMcnEnabled.value}
            onInput={e => {
              infoMcnEnabled.value = e.currentTarget.checked
            }}
            label='显示 MCN 信息'
          />
        </div>
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>用户备注</div>
        <div class={HINT_CLASS}>
          为 UID 添加本地备注，可在主播信息面板中查看与编辑。当前 UID
          存在备注时，按钮上会显示备注图标作为提示。直播间页面以主播 UID 为索引、个人空间页面以页面 UID
          为索引。备注仅保存在本地，可单独导入导出便于分享或备份
        </div>
        <div class='mb-2 text-ga6'>本地已保存 {Object.keys(userNotes.value).length} 条备注</div>
        <div class={ROW_CLASS}>
          <Button variant='outline' size='sm' onClick={handleNotesExport}>
            导出备注
          </Button>
          <Button variant='outline' size='sm' onClick={handleNotesImportClick}>
            导入备注
          </Button>
          <input
            ref={importNotesInputRef}
            type='file'
            accept='application/json,.json'
            class='hidden'
            onChange={e => {
              const input = e.currentTarget
              const file = input.files?.[0]
              input.value = ''
              if (file) void handleNotesImportFile(file)
            }}
          />
        </div>
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>日志设置</div>
        <div class='flex flex-wrap items-center gap-2'>
          <Label htmlFor='maxLogLines'>最大日志行数:</Label>
          <Input
            id='maxLogLines'
            type='number'
            min='1'
            max='1000'
            className='w-20'
            value={maxLogLines.value}
            onChange={e => {
              let v = parseInt(e.currentTarget.value, 10)
              if (Number.isNaN(v) || v < 1) v = 1
              else if (v > 1000) v = 1000
              maxLogLines.value = v
            }}
          />
          <span class='text-ga6'>(1-1000)</span>
        </div>
      </div>

      <div class={'my-2 pb-4'}>
        <div class={HEADING_CLASS}>导入 / 导出设置</div>
        <div class={HINT_CLASS}>
          导出当前所有设置（包括替换规则、自动融入黑名单等）为 JSON 文件。导入会覆盖当前所有设置。
        </div>
        <div class={ROW_CLASS}>
          <Button variant='outline' size='sm' onClick={handleExport}>
            导出设置
          </Button>
          <Button variant='outline' size='sm' onClick={handleImportClick}>
            导入设置
          </Button>
          {/* The picker itself is hidden; the import button drives it via
              .click(). Resetting .value after each pick lets the user
              re-select the same file (e.g. after editing it). */}
          <input
            ref={importFileInputRef}
            type='file'
            accept='application/json,.json'
            class='hidden'
            onChange={e => {
              const input = e.currentTarget
              const file = input.files?.[0]
              input.value = ''
              if (file) void handleImportFile(file)
            }}
          />
        </div>
      </div>
    </>
  )
}
