import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'

import { ensureRoomId, getCsrfToken, sendDanmaku } from '../api.js'
import { BASE_URL } from '../const.js'
import { buildReplacementMap } from '../replacement.js'
import {
  appendLog,
  cachedRoomId,
  danmakuDirectMode,
  forceScrollDanmaku,
  maxLogLines,
  optimizeLayout,
  remoteKeywords,
  remoteKeywordsLastSync,
  replacementRules,
} from '../store.js'

const SYNC_INTERVAL = 10 * 60 * 1000

interface RemoteKeywords {
  global?: { keywords?: Record<string, string> }
  rooms?: Array<{ room: string; keywords?: Record<string, string> }>
}

async function fetchRemoteKeywords(): Promise<RemoteKeywords> {
  const response = await fetch(BASE_URL.REMOTE_KEYWORDS)
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  return await response.json()
}

export function SettingsTab() {
  const syncStatus = useSignal('未同步')
  const syncStatusColor = useSignal('#666')
  const syncing = useSignal(false)
  const testingRemote = useSignal(false)
  const testingLocal = useSignal(false)
  const replaceFrom = useSignal('')
  const replaceTo = useSignal('')

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
      const rules = replacementRules.value.filter(r => r.from)
      if (rules.length === 0) {
        appendLog('⚠️ 没有本地替换词可供测试，请先添加本地替换规则')
        return
      }
      appendLog(`🔵 开始测试本地替换词 ${rules.length} 个`)
      let tested = 0
      let blocked = 0
      for (const rule of rules) {
        tested++
        appendLog(`[${tested}/${rules.length}] 测试: ${rule.from}`)
        const result = await testKeywordPair(rule.from ?? '', rule.to ?? '', roomId, csrfToken)
        blocked += logTestResult(result, rule.to ?? '')
        if (tested < rules.length) await new Promise(r => setTimeout(r, 2000))
      }
      appendLog(`\n🔵 本地测试完成！共测试 ${rules.length} 个词，其中 ${blocked} 个原词被屏蔽`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 测试出错：${msg}`)
    } finally {
      testingLocal.value = false
    }
  }

  const addRule = () => {
    if (!replaceFrom.value) {
      appendLog('⚠️ 替换前的内容不能为空')
      return
    }
    replacementRules.value = [...replacementRules.value, { from: replaceFrom.value, to: replaceTo.value }]
    buildReplacementMap()
    replaceFrom.value = ''
    replaceTo.value = ''
  }

  const removeRule = (index: number) => {
    const next = [...replacementRules.value]
    next.splice(index, 1)
    replacementRules.value = next
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

  const rules = replacementRules.value

  return (
    <>
      <div style={{ margin: '.5em 0', paddingBottom: '.5em', borderBottom: '1px solid var(--Ga2, #eee)' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '.5em' }}>
          云端规则替换{' '}
          <a
            href='https://github.com/laplace-live/public/blob/master/artifacts/livesrtream-keywords.json'
            target='_blank'
            style={{ color: '#288bb8', textDecoration: 'none' }}
            rel='noopener'
          >
            我要贡献规则
          </a>
        </div>
        <div style={{ marginBlock: '.5em', color: '#666' }}>每10分钟会自动同步云端替换规则</div>
        <div style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5em' }}>
          <button type='button' disabled={syncing.value} onClick={() => void syncRemote()}>
            {syncing.value ? '同步中…' : '同步'}
          </button>
          <button type='button' disabled={testingRemote.value} onClick={() => void testRemote()}>
            {testingRemote.value ? '测试中…' : '测试云端词库'}
          </button>
          <span style={{ color: syncStatusColor.value }}>{syncStatus.value}</span>
        </div>
      </div>

      <div style={{ margin: '.5em 0', paddingBottom: '.5em', borderBottom: '1px solid var(--Ga2, #eee)' }}>
        <div style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5em' }}>
          <div style={{ fontWeight: 'bold' }}>本地规则替换</div>
          <button type='button' disabled={testingLocal.value} onClick={() => void testLocal()}>
            {testingLocal.value ? '测试中…' : '测试本地词库'}
          </button>
        </div>
        <div style={{ marginBlock: '.5em', color: '#666' }}>规则从上至下执行；本地规则总是最后执行</div>
        <div style={{ marginBottom: '.5em', maxHeight: '160px', overflowY: 'auto' }}>
          {rules.length === 0 ? (
            <div style={{ color: '#999' }}>暂无替换规则，请在下方添加</div>
          ) : (
            rules.map((rule, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '.5em',
                  padding: '.2em',
                  borderBottom: '1px solid var(--Ga2, #eee)',
                }}
              >
                <span style={{ flex: 1, wordBreak: 'break-all', fontFamily: 'monospace' }}>
                  {rule.from ?? '(空)'} → {rule.to ?? '(空)'}
                </span>
                <button
                  type='button'
                  onClick={() => removeRule(i)}
                  style={{
                    cursor: 'pointer',
                    background: 'transparent',
                    color: 'red',
                    border: 'none',
                    borderRadius: '2px',
                  }}
                >
                  删除
                </button>
              </div>
            ))
          )}
        </div>
        <div style={{ display: 'flex', gap: '.25em', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            placeholder='替换前'
            style={{ flex: 1, minWidth: '80px' }}
            value={replaceFrom.value}
            onInput={e => {
              replaceFrom.value = (e.target as HTMLInputElement).value
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !(e as KeyboardEvent).isComposing) {
                e.preventDefault()
                addRule()
              }
            }}
          />
          <span>→</span>
          <input
            placeholder='替换后'
            style={{ flex: 1, minWidth: '80px' }}
            value={replaceTo.value}
            onInput={e => {
              replaceTo.value = (e.target as HTMLInputElement).value
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !(e as KeyboardEvent).isComposing) {
                e.preventDefault()
                addRule()
              }
            }}
          />
          <button type='button' onClick={addRule}>
            添加
          </button>
        </div>
      </div>

      <div style={{ margin: '.5em 0', paddingBottom: '.5em', borderBottom: '1px solid var(--Ga2, #eee)' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '.5em' }}>日志设置</div>
        <div style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor='maxLogLines' style={{ color: '#666' }}>
            最大日志行数:
          </label>
          <input
            id='maxLogLines'
            type='number'
            min='1'
            max='1000'
            style={{ width: '80px' }}
            value={maxLogLines.value}
            onChange={e => {
              let v = parseInt((e.target as HTMLInputElement).value, 10)
              if (Number.isNaN(v) || v < 1) v = 1
              else if (v > 1000) v = 1000
              maxLogLines.value = v
            }}
          />
          <span style={{ color: '#999', fontSize: '0.9em' }}>(1-1000)</span>
        </div>
      </div>

      <div style={{ margin: '.5em 0' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '.5em' }}>其他设置</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.5em' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='danmakuDirectMode'
              type='checkbox'
              checked={danmakuDirectMode.value}
              onInput={e => {
                danmakuDirectMode.value = (e.target as HTMLInputElement).checked
              }}
            />
            <label htmlFor='danmakuDirectMode'>+1模式（在聊天消息旁显示偷弹幕和+1按钮）</label>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='forceScrollDanmaku'
              type='checkbox'
              checked={forceScrollDanmaku.value}
              onInput={e => {
                forceScrollDanmaku.value = (e.target as HTMLInputElement).checked
              }}
            />
            <label htmlFor='forceScrollDanmaku'>脚本载入时强制配置弹幕位置为滚动方向</label>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='optimizeLayout'
              type='checkbox'
              checked={optimizeLayout.value}
              onInput={e => {
                optimizeLayout.value = (e.target as HTMLInputElement).checked
              }}
            />
            <label htmlFor='optimizeLayout'>优化布局</label>
          </span>
        </div>
      </div>
    </>
  )
}
