import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'

import { ensureRoomId, getCsrfToken, sendDanmaku } from '../lib/api'
import { BASE_URL } from '../lib/const'
import { appendLog, maxLogLines } from '../lib/log'
import { buildReplacementMap } from '../lib/replacement'
import {
  autoBlendUserBlacklist,
  cachedRoomId,
  danmakuDirectAlwaysShow,
  danmakuDirectConfirm,
  danmakuDirectMode,
  forceScrollDanmaku,
  localGlobalRules,
  localRoomRules,
  optimizeLayout,
  remoteKeywords,
  remoteKeywordsLastSync,
  unlockLiveBlock,
  unlockSpaceBlock,
} from '../lib/store'
import { EmoteIds } from './emote-ids'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { NativeSelect } from './ui/native-select'

const SYNC_INTERVAL = 10 * 60 * 1000

// Section visual rhythm shared across every block (heading + body + bottom
// divider). The last section drops the divider via SECTION_NO_BORDER.
const SECTION_CLASS = 'lc-my-2 lc-pb-4 lc-border-b lc-border-b-solid lc-border-b-ga2'
const SECTION_NO_BORDER = 'lc-my-2 lc-pb-4'
const HEADING_CLASS = 'lc-font-bold lc-mb-2'
const ROW_CLASS = 'lc-flex lc-gap-2 lc-items-center lc-flex-wrap lc-mb-2'
const HINT_CLASS = 'lc-my-2 lc-text-ga6'
const EMPTY_CLASS = 'lc-text-ga4'
const LINK_CLASS = 'lc-text-link lc-no-underline'

// Each rule / blacklist row shares the same divider-separated layout.
const LIST_ROW_CLASS = 'lc-flex lc-items-center lc-gap-2 lc-py-[.2em] lc-border-b lc-border-b-solid lc-border-b-ga2'
const LIST_ROW_TEXT = 'lc-flex-1 lc-break-all lc-font-mono'
const ADD_ROW_CLASS = 'lc-flex lc-gap-1 lc-items-center lc-flex-wrap'
const FILL_INPUT_CLASS = 'lc-flex-1 lc-min-w-[80px]'

// Used as the destructive-action color on `ghost` Buttons in lists.
const DELETE_BTN_CLASS = 'lc-text-[red]'

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

  const globalReplaceFrom = useSignal('')
  const globalReplaceTo = useSignal('')

  const roomReplaceFrom = useSignal('')
  const roomReplaceTo = useSignal('')
  const editingRoomId = useSignal(cachedRoomId.value !== null ? String(cachedRoomId.value) : '')
  const newRoomId = useSignal('')

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
          <div class='lc-font-bold'>本地全局规则</div>
          <Button variant='outline' size='sm' disabled={testingLocal.value} onClick={() => void testLocal()}>
            {testingLocal.value ? '测试中…' : '测试本地词库'}
          </Button>
        </div>
        <div class={HINT_CLASS}>适用于所有直播间，优先级高于云端规则</div>
        <div class='lc-mb-2 lc-max-h-[160px] lc-overflow-y-auto'>
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
            className='lc-min-w-[120px]'
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
          <div class='lc-flex lc-gap-1 lc-items-center'>
            <Input
              placeholder='房间号'
              className='lc-w-[80px]'
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
            <div class='lc-mb-2 lc-max-h-[160px] lc-overflow-y-auto'>
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
          自动融入黑名单
          {blacklistEntries.length > 0 && <span class='lc-text-ga6 lc-font-normal'> ({blacklistEntries.length})</span>}
        </div>
        <div class={HINT_CLASS}>
          名单中的用户发送的弹幕不会计入「自动融入」统计。在弹幕框点击用户名可将该用户加入 / 移出名单。
        </div>
        <div class='lc-mb-2 lc-max-h-[200px] lc-overflow-y-auto'>
          {blacklistEntries.length === 0 ? (
            <div class={EMPTY_CLASS}>暂无黑名单用户</div>
          ) : (
            blacklistEntries.map(([uid, uname]) => (
              <div key={uid} class={LIST_ROW_CLASS}>
                <span class='lc-flex-1 lc-break-all lc-flex lc-items-baseline lc-gap-2'>
                  <a href={`https://space.bilibili.com/${uid}`} target='_blank' rel='noopener' class={LINK_CLASS}>
                    {uname || '(无昵称)'}
                  </a>
                  <span class='lc-text-ga6 lc-text-[11px] lc-font-mono'>{uid}</span>
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
        <div class={HEADING_CLASS}>表情（复制后可在独轮车或常规发送中直接发送）</div>
        <div class='lc-max-h-[200px] lc-overflow-y-auto'>
          <EmoteIds />
        </div>
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>其他设置</div>
        <div class='lc-flex lc-flex-col lc-gap-2'>
          <Checkbox
            id='danmakuDirectMode'
            checked={danmakuDirectMode.value}
            onInput={e => {
              danmakuDirectMode.value = e.currentTarget.checked
            }}
            label='+1模式（在聊天消息旁显示偷弹幕和+1按钮）'
          />
          <div class='lc-pl-[1.5em]'>
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
          <div class='lc-pl-[1.5em]'>
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

      <div class={SECTION_NO_BORDER}>
        <div class={HEADING_CLASS}>日志设置</div>
        <div class='lc-flex lc-gap-2 lc-items-center lc-flex-wrap'>
          <Label htmlFor='maxLogLines'>最大日志行数:</Label>
          <Input
            id='maxLogLines'
            type='number'
            min='1'
            max='1000'
            className='lc-w-[80px]'
            value={maxLogLines.value}
            onChange={e => {
              let v = parseInt(e.currentTarget.value, 10)
              if (Number.isNaN(v) || v < 1) v = 1
              else if (v > 1000) v = 1000
              maxLogLines.value = v
            }}
          />
          <span class='lc-text-ga6 lc-text-[.9em]'>(1-1000)</span>
        </div>
      </div>
    </>
  )
}
