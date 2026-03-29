import { GM_getValue, GM_setValue } from '$'
import { ensureRoomId, getCsrfToken, sendDanmaku } from '../api.js'
import { BASE_URL } from '../const.js'
import { buildReplacementMap } from '../replacement.js'
import { cachedRoomId, setOnRoomIdReadyCallback } from '../state.js'
import { appendToLimitedLog } from '../utils.js'

const SYNC_INTERVAL = 10 * 60 * 1000

interface ReplacementRule {
  from?: string
  to?: string
}

interface RemoteKeywords {
  global?: { keywords?: Record<string, string> }
  rooms?: Array<{ room: string; keywords?: Record<string, string> }>
}

export function setupSettings(): void {
  const msgLogs = document.getElementById('msgLogs') as HTMLTextAreaElement
  const maxLogLines = GM_getValue<number>('maxLogLines', 1000)

  const replacementRules = GM_getValue<ReplacementRule[]>('replacementRules', [])

  const syncRemoteBtn = document.getElementById('syncRemoteBtn') as HTMLButtonElement
  const testRemoteBtn = document.getElementById('testRemoteBtn') as HTMLButtonElement
  const testLocalBtn = document.getElementById('testLocalBtn') as HTMLButtonElement
  const remoteKeywordsStatus = document.getElementById('remoteKeywordsStatus') as HTMLSpanElement
  const remoteKeywordsInfo = document.getElementById('remoteKeywordsInfo') as HTMLDivElement
  const replacementRulesList = document.getElementById('replacementRulesList') as HTMLDivElement
  const replaceFromInput = document.getElementById('replaceFrom') as HTMLInputElement
  const replaceToInput = document.getElementById('replaceTo') as HTMLInputElement
  const addRuleBtn = document.getElementById('addRuleBtn') as HTMLButtonElement
  const maxLogLinesInput = document.getElementById('maxLogLinesInput') as HTMLInputElement
  const forceScrollDanmakuInput = document.getElementById('forceScrollDanmaku') as HTMLInputElement

  async function fetchRemoteKeywords(): Promise<RemoteKeywords> {
    const response = await fetch(BASE_URL.REMOTE_KEYWORDS)
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    return await response.json()
  }

  async function syncRemoteKeywords(): Promise<void> {
    try {
      syncRemoteBtn.disabled = true
      syncRemoteBtn.textContent = '同步中…'
      remoteKeywordsStatus.textContent = '正在同步…'
      remoteKeywordsStatus.style.color = '#666'
      const data = await fetchRemoteKeywords()
      GM_setValue('remoteKeywords', data)
      GM_setValue('remoteKeywordsLastSync', Date.now())
      buildReplacementMap()
      updateRemoteKeywordsStatus()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      remoteKeywordsStatus.textContent = `同步失败: ${msg}`
      remoteKeywordsStatus.style.color = '#f44'
      appendToLimitedLog(msgLogs, `❌ 云端替换规则同步失败: ${msg}`, maxLogLines)
    } finally {
      syncRemoteBtn.disabled = false
      syncRemoteBtn.textContent = '同步'
    }
  }

  function updateRemoteKeywordsStatus(): void {
    const remoteKeywords = GM_getValue<RemoteKeywords | null>('remoteKeywords', null)
    const lastSync = GM_getValue<number | null>('remoteKeywordsLastSync', null)

    if (!remoteKeywords || !lastSync) {
      remoteKeywordsStatus.textContent = '未同步'
      remoteKeywordsStatus.style.color = '#666'
      remoteKeywordsInfo.textContent = ''
      return
    }

    const currentRoomId = cachedRoomId
    const globalCount = Object.keys(remoteKeywords.global?.keywords ?? {}).length
    let roomCount = 0
    if (currentRoomId !== null) {
      const roomData = remoteKeywords.rooms?.find(r => String(r.room) === String(currentRoomId))
      roomCount = Object.keys(roomData?.keywords ?? {}).length
    }
    const totalApplied = globalCount + roomCount
    const syncDate = new Date(lastSync)
    const timeStr = syncDate.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    remoteKeywordsStatus.textContent = `最后同步: ${timeStr}`
    remoteKeywordsStatus.style.color = '#36a185'
    remoteKeywordsInfo.textContent = `当前房间共 ${totalApplied} 条规则（全局 ${globalCount} + 当前房间 ${roomCount}）`
  }

  function updateReplacementRulesDisplay(): void {
    if (replacementRules.length === 0) {
      replacementRulesList.innerHTML = '<div style="color: #999;">暂无替换规则，请在下方添加</div>'
      return
    }
    replacementRulesList.innerHTML = replacementRules
      .map(
        (rule, index) =>
          `<div style="display: flex; align-items: center; gap: .5em; padding: .2em; border-bottom: 1px solid var(--Ga2, #eee);">
            <span style="flex: 1; word-break: break-all; font-family: monospace;">${rule.from ?? '(空)'} → ${rule.to ?? '(空)'}</span>
            <button class="remove-rule-btn" data-index="${index}" style="cursor: pointer; background: transparent; color: red; border: none; border-radius: 2px;">删除</button>
          </div>`
      )
      .join('')

    replacementRulesList.querySelectorAll('.remove-rule-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        const index = parseInt((e.currentTarget as HTMLElement).getAttribute('data-index') ?? '', 10)
        replacementRules.splice(index, 1)
        GM_setValue('replacementRules', replacementRules)
        buildReplacementMap()
        updateReplacementRulesDisplay()
      })
    })
  }

  addRuleBtn?.addEventListener('click', () => {
    const from = replaceFromInput.value
    const to = replaceToInput.value
    if (!from) {
      appendToLimitedLog(msgLogs, '⚠️ 替换前的内容不能为空', maxLogLines)
      return
    }
    replacementRules.push({ from, to })
    GM_setValue('replacementRules', replacementRules)
    buildReplacementMap()
    replaceFromInput.value = ''
    replaceToInput.value = ''
    updateReplacementRulesDisplay()
  })

  replaceFromInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      addRuleBtn.click()
    }
  })
  replaceToInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      addRuleBtn.click()
    }
  })

  syncRemoteBtn?.addEventListener('click', () => void syncRemoteKeywords())

  async function testKeywordPair(
    originalKeyword: string,
    replacedKeyword: string,
    roomId: number,
    csrfToken: string
  ): Promise<{
    originalBlocked: boolean
    replacedBlocked: boolean | null
    originalError?: string
    replacedError?: string
  }> {
    const originalResult = await sendDanmaku(originalKeyword, roomId, csrfToken)
    let replacedResult: { success: boolean; error?: string } | null = null
    if (!originalResult.success) {
      await new Promise(r => setTimeout(r, 2000))
      replacedResult = await sendDanmaku(replacedKeyword, roomId, csrfToken)
    }
    return {
      originalBlocked: !originalResult.success,
      replacedBlocked: replacedResult ? !replacedResult.success : null,
      originalError: originalResult.error,
      replacedError: replacedResult?.error,
    }
  }

  function logTestResult(
    result: {
      originalBlocked: boolean
      replacedBlocked: boolean | null
      originalError?: string
      replacedError?: string
    },
    replacedKeyword: string
  ): number {
    if (result.originalBlocked) {
      appendToLimitedLog(
        msgLogs,
        `  ✅ 原词被屏蔽 (错误: ${result.originalError})，测试替换词: ${replacedKeyword}`,
        maxLogLines
      )
      if (result.replacedBlocked) {
        appendToLimitedLog(msgLogs, `  ❌ 替换词也被屏蔽 (错误: ${result.replacedError})`, maxLogLines)
      } else {
        appendToLimitedLog(msgLogs, `  ✅ 替换词未被屏蔽`, maxLogLines)
      }
      return 1
    }
    appendToLimitedLog(msgLogs, `  ⚠️ 原词未被屏蔽，请考虑提交贡献词条`, maxLogLines)
    return 0
  }

  function getRemoteKeywords(): {
    globalKeywords: Array<{ from: string; to: string }>
    roomKeywords: Array<{ from: string; to: string }>
  } {
    const remoteKeywords = GM_getValue<RemoteKeywords | null>('remoteKeywords', null)
    const globalKeywords: Array<{ from: string; to: string }> = []
    const roomKeywords: Array<{ from: string; to: string }> = []
    if (remoteKeywords) {
      const globalKw = remoteKeywords.global?.keywords ?? {}
      for (const [from, to] of Object.entries(globalKw)) {
        if (from) globalKeywords.push({ from, to: to })
      }
      if (cachedRoomId !== null) {
        const roomData = remoteKeywords.rooms?.find(r => String(r.room) === String(cachedRoomId))
        const roomKw = roomData?.keywords ?? {}
        for (const [from, to] of Object.entries(roomKw)) {
          if (from) roomKeywords.push({ from, to: to })
        }
      }
    }
    return { globalKeywords, roomKeywords }
  }

  async function validateTestPrerequisites(): Promise<
    { valid: false } | { valid: true; roomId: number; csrfToken: string }
  > {
    const roomId = await ensureRoomId()
    const csrfToken = getCsrfToken()
    if (!csrfToken) {
      appendToLimitedLog(msgLogs, '❌ 未找到登录信息，请先登录 Bilibili', maxLogLines)
      return { valid: false }
    }
    return { valid: true, roomId, csrfToken }
  }

  async function testRemoteKeywords(): Promise<void> {
    const confirmed = confirm(
      '即将测试当前直播间的云端替换词，请避免在当前直播间正在直播时进行测试，否则可能会给主播造成困扰，是否继续？'
    )
    if (!confirmed) return
    testRemoteBtn.disabled = true
    testRemoteBtn.textContent = '测试中…'
    try {
      const pr = await validateTestPrerequisites()
      if (!pr.valid) return
      const { roomId, csrfToken } = pr
      const { globalKeywords, roomKeywords } = getRemoteKeywords()
      const totalCount = globalKeywords.length + roomKeywords.length
      if (totalCount === 0) {
        appendToLimitedLog(msgLogs, '⚠️ 没有云端替换词可供测试，请先同步云端规则', maxLogLines)
        return
      }
      appendToLimitedLog(
        msgLogs,
        `🔵 开始测试云端替换词 ${totalCount} 个（全局 ${globalKeywords.length} + 房间 ${roomKeywords.length}）`,
        maxLogLines
      )
      let testedCount = 0
      let totalBlockedCount = 0

      if (globalKeywords.length > 0) {
        appendToLimitedLog(msgLogs, `\n📡 测试云端全局替换词 (${globalKeywords.length} 个)`, maxLogLines)
        let blockedCount = 0
        for (const { from, to } of globalKeywords) {
          testedCount++
          appendToLimitedLog(msgLogs, `[${testedCount}/${totalCount}] 测试: ${from}`, maxLogLines)
          const result = await testKeywordPair(from, to, roomId, csrfToken)
          const blocked = logTestResult(result, to)
          blockedCount += blocked
          totalBlockedCount += blocked
          if (testedCount < totalCount) await new Promise(r => setTimeout(r, 2000))
        }
        appendToLimitedLog(
          msgLogs,
          `📡 全局替换词测试完成：${blockedCount}/${globalKeywords.length} 个原词被屏蔽`,
          maxLogLines
        )
      }

      if (roomKeywords.length > 0) {
        appendToLimitedLog(msgLogs, `\n🏠 测试云端房间专属替换词 (${roomKeywords.length} 个)`, maxLogLines)
        let blockedCount = 0
        for (const { from, to } of roomKeywords) {
          testedCount++
          appendToLimitedLog(msgLogs, `[${testedCount}/${totalCount}] 测试: ${from}`, maxLogLines)
          const result = await testKeywordPair(from, to, roomId, csrfToken)
          const blocked = logTestResult(result, to)
          blockedCount += blocked
          totalBlockedCount += blocked
          if (testedCount < totalCount) await new Promise(r => setTimeout(r, 2000))
        }
        appendToLimitedLog(
          msgLogs,
          `🏠 房间专属替换词测试完成：${blockedCount}/${roomKeywords.length} 个原词被屏蔽`,
          maxLogLines
        )
      }

      appendToLimitedLog(
        msgLogs,
        `\n🔵 云端测试完成！共测试 ${totalCount} 个词，其中 ${totalBlockedCount} 个原词被屏蔽`,
        maxLogLines
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendToLimitedLog(msgLogs, `🔴 测试出错：${msg}`, maxLogLines)
    } finally {
      testRemoteBtn.disabled = false
      testRemoteBtn.textContent = '测试云端词库'
    }
  }

  async function testLocalKeywords(): Promise<void> {
    const confirmed = confirm(
      '即将测试本地替换词，请避免在当前直播间正在直播时进行测试，否则可能会给主播造成困扰，是否继续？'
    )
    if (!confirmed) return
    testLocalBtn.disabled = true
    testLocalBtn.textContent = '测试中…'
    try {
      const pr = await validateTestPrerequisites()
      if (!pr.valid) return
      const { roomId, csrfToken } = pr
      const localRules = GM_getValue<ReplacementRule[]>('replacementRules', []).filter(rule => rule.from)
      if (localRules.length === 0) {
        appendToLimitedLog(msgLogs, '⚠️ 没有本地替换词可供测试，请先添加本地替换规则', maxLogLines)
        return
      }
      appendToLimitedLog(msgLogs, `🔵 开始测试本地替换词 ${localRules.length} 个`, maxLogLines)
      let testedCount = 0
      let blockedCount = 0
      for (const rule of localRules) {
        testedCount++
        appendToLimitedLog(msgLogs, `[${testedCount}/${localRules.length}] 测试: ${rule.from}`, maxLogLines)
        const result = await testKeywordPair(rule.from ?? '', rule.to ?? '', roomId, csrfToken)
        blockedCount += logTestResult(result, rule.to ?? '')
        if (testedCount < localRules.length) await new Promise(r => setTimeout(r, 2000))
      }
      appendToLimitedLog(
        msgLogs,
        `\n🔵 本地测试完成！共测试 ${localRules.length} 个词，其中 ${blockedCount} 个原词被屏蔽`,
        maxLogLines
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendToLimitedLog(msgLogs, `🔴 测试出错：${msg}`, maxLogLines)
    } finally {
      testLocalBtn.disabled = false
      testLocalBtn.textContent = '测试本地词库'
    }
  }

  testRemoteBtn?.addEventListener('click', () => void testRemoteKeywords())
  testLocalBtn?.addEventListener('click', () => void testLocalKeywords())

  maxLogLinesInput?.addEventListener('change', () => {
    let value = parseInt(maxLogLinesInput.value, 10)
    if (Number.isNaN(value) || value < 1) value = 1
    else if (value > 1000) value = 1000
    maxLogLinesInput.value = String(value)
    GM_setValue('maxLogLines', value)
  })

  forceScrollDanmakuInput?.addEventListener('input', () => {
    GM_setValue('forceScrollDanmaku', forceScrollDanmakuInput.checked)
  })

  setOnRoomIdReadyCallback(updateRemoteKeywordsStatus)
  updateReplacementRulesDisplay()

  ;(async () => {
    const lastSync = GM_getValue<number | null>('remoteKeywordsLastSync', null)
    const now = Date.now()
    if (!lastSync || now - lastSync > SYNC_INTERVAL) {
      await syncRemoteKeywords()
    } else {
      updateRemoteKeywordsStatus()
    }
  })()

  setInterval(() => void syncRemoteKeywords(), SYNC_INTERVAL)
}
