import { useComputed, useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'

import { checkMedalRoomRestriction, fetchMedalRooms, getDedeUid, type MedalRestrictionCheck } from '../../lib/api'
import { copyTextToClipboard } from '../../lib/clipboard'
import { VERSION } from '../../lib/const'
import {
  guardRoomAgentConnected,
  guardRoomAgentLastSyncAt,
  guardRoomAgentLiveCount,
  guardRoomAgentStatusText,
  guardRoomAgentWatchlistCount,
  guardRoomAppliedProfile,
  guardRoomLiveDeskHeartbeatSec,
  guardRoomLiveDeskSessionId,
} from '../../lib/guard-room-live-desk-state'
import { appendLog } from '../../lib/log'
// 共享状态(原本是本文件的私有 const,Jobs 式 #8 把主面板的"我的状态" section
// 接进来后,提到了 lib/medal-check-state.ts)。helpers + GM signals + 一次性
// migration 都在那边——本文件只负责完整设置 UI(发起巡检、Guard Room 同步、
// 详细列表/筛选)。
import {
  getFilteredMedalResults,
  getMedalCheckCounts,
  type MedalCheckFilter,
  medalCheckFilterByUid,
  medalCheckResultsByUid,
  medalCheckStatusByUid,
  medalFilterLabel,
  medalStatusColor,
  medalStatusTitle,
} from '../../lib/medal-check-state'
import {
  clearGuardRoomSyncKey,
  guardRoomEndpoint,
  guardRoomHandoffActive,
  guardRoomSyncKey,
  guardRoomSyncKeyPersist,
  guardRoomWebsiteControlEnabled,
} from '../../lib/store'
import { matchesSearchQuery } from './search'

const DEFAULT_STATUS = '尚未巡检 — 点击「检查粉丝牌禁言」开始'
const NOT_LOGGED_IN_STATUS = '未登录 Bilibili — 请先登录再执行巡检'

/**
 * The guard-room client refuses non-HTTPS endpoints except loopback. Surface
 * that contract in the UI so the user fixes the URL before saving, instead of
 * silently shipping every sync attempt to a dead config.
 */
function validateGuardRoomEndpoint(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'URL 格式不合法（缺少协议或主机名）'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return '只支持 http:// 或 https:// 协议'
  }
  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
  if (url.protocol === 'http:' && !isLoopback) {
    return 'HTTP 仅限 localhost / 127.0.0.1；公网请用 https://'
  }
  return null
}

function signalKindLabel(kind: string): string {
  if (kind === 'muted') return '房间禁言'
  if (kind === 'blocked') return '房间屏蔽/拉黑'
  if (kind === 'account') return '账号风控'
  if (kind === 'rate-limit') return '频率限制'
  if (kind === 'deactivated') return '主播已注销'
  return '未知信号'
}

function formatCheckTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatMedalResultLine(result: MedalRestrictionCheck): string {
  const room = `${result.room.anchorName} / ${result.room.medalName}`
  const header = `${medalStatusTitle(result.status)}｜${room}｜房间号：${result.room.roomId}｜检查时间：${formatCheckTime(result.checkedAt)}`
  if (result.signals.length === 0) return `${header}\n${result.note ?? '接口未发现禁言/封禁信号'}`
  const details = result.signals
    .map(
      signal => `${signalKindLabel(signal.kind)}：${signal.message}；时长：${signal.duration}；来源：${signal.source}`
    )
    .join('\n')
  return `${header}\n${details}`
}

function formatMedalCheckReport(
  results: MedalRestrictionCheck[],
  status: string,
  filter: MedalCheckFilter,
  uidLabel: string
): string {
  const counts = getMedalCheckCounts(results)
  const shown = getFilteredMedalResults(results, filter)
  return [
    '粉丝牌禁言巡检',
    `登录账号：${uidLabel}`,
    status,
    `统计：限制 ${counts.restricted}，未知 ${counts.unknown}，主播注销 ${counts.deactivated}，正常 ${counts.ok}`,
    `当前复制范围：${medalFilterLabel(filter)}（${shown.length} 条）`,
    '',
    ...shown.map(formatMedalResultLine),
  ].join('\n\n')
}

function normalizeGuardRoomEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '')
}

function buildGuardRoomInspectionRun(results: MedalRestrictionCheck[]) {
  const checkedAtValues = results.map(result => result.checkedAt)
  const startedAt = checkedAtValues.length > 0 ? Math.min(...checkedAtValues) : Date.now()
  const finishedAt = checkedAtValues.length > 0 ? Math.max(...checkedAtValues) : Date.now()
  return {
    runId: `chatterbox-${Date.now()}`,
    scriptVersion: VERSION,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    results: results.map(result => ({
      roomId: result.room.roomId,
      anchorName: result.room.anchorName,
      anchorUid: result.room.anchorUid,
      medalName: result.room.medalName,
      status: result.status,
      signals: result.signals.map(signal => ({
        kind: signal.kind,
        message: signal.message,
        duration: signal.duration,
        source: signal.source,
      })),
      checkedAt: new Date(result.checkedAt).toISOString(),
      note: result.note,
    })),
  }
}

export function MedalCheckSection({ query = '' }: { query?: string }) {
  const checkingMedalRooms = useSignal(false)
  const medalCheckCopyStatus = useSignal('')
  const guardRoomSyncing = useSignal(false)
  const guardRoomSyncStatus = useSignal('')

  // Track the cookie-derived B 站 UID reactively so the panel switches to the
  // active account's cached results whenever the user logs in/out or swaps
  // accounts in another tab. Cookie reads are cheap; a 5 s tick + visibility
  // change listener keeps this responsive without observable cost.
  const currentUid = useSignal<string | null>(getDedeUid() ?? null)
  useEffect(() => {
    const tick = () => {
      const next = getDedeUid() ?? null
      if (currentUid.value !== next) currentUid.value = next
    }
    tick()
    const id = setInterval(tick, 5000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const medalCheckStatus = useComputed(() => {
    const uid = currentUid.value
    if (!uid) return NOT_LOGGED_IN_STATUS
    return medalCheckStatusByUid.value[uid] ?? DEFAULT_STATUS
  })
  const medalCheckResults = useComputed<MedalRestrictionCheck[]>(() => {
    const uid = currentUid.value
    if (!uid) return []
    return medalCheckResultsByUid.value[uid] ?? []
  })
  const medalCheckFilter = useComputed<MedalCheckFilter>(() => {
    const uid = currentUid.value
    if (!uid) return 'issues'
    return medalCheckFilterByUid.value[uid] ?? 'issues'
  })

  const writeFilter = (val: MedalCheckFilter) => {
    const uid = currentUid.value
    if (!uid) return
    medalCheckFilterByUid.value = { ...medalCheckFilterByUid.value, [uid]: val }
  }

  if (
    !matchesSearchQuery(
      '粉丝牌禁言巡检 禁言 粉丝牌 直播间 巡检 medal 保安室 guard room sync 同步 账号 登录 uid 风控 moderation',
      query
    )
  )
    return null

  const checkMedalRooms = async () => {
    // Capture the UID at start so all writes from this run land in the slot
    // for the account that was logged in when the user clicked the button.
    // If the cookie changes mid-run we still finish writing under the
    // original UID — that matches what the API requests actually queried.
    const uid = currentUid.value
    if (!uid) {
      appendLog('禁言巡检：未登录 Bilibili')
      return
    }
    const writeStatus = (val: string) => {
      medalCheckStatusByUid.value = { ...medalCheckStatusByUid.value, [uid]: val }
    }
    const writeResults = (val: MedalRestrictionCheck[]) => {
      medalCheckResultsByUid.value = { ...medalCheckResultsByUid.value, [uid]: val }
    }
    checkingMedalRooms.value = true
    writeResults([])
    writeStatus('正在获取粉丝牌…')
    try {
      const rooms = await fetchMedalRooms()
      if (rooms.length === 0) {
        writeStatus('没有找到粉丝牌直播间')
        appendLog('禁言巡检：没有找到粉丝牌直播间')
        return
      }

      appendLog(`禁言巡检：找到 ${rooms.length} 个粉丝牌直播间，开始检查（账号 UID ${uid}）`)
      const results: MedalRestrictionCheck[] = []
      for (let i = 0; i < rooms.length; i++) {
        const room = rooms[i]
        writeStatus(`检查中 ${i + 1}/${rooms.length}：${room.anchorName}（${room.medalName}）`)
        const result = await checkMedalRoomRestriction(room)
        results.push(result)
        writeResults([...results])
        const label = `${room.anchorName} / ${room.medalName} / ${room.roomId}`
        if (result.status === 'restricted') {
          const detail = result.signals
            .map(signal => `${signalKindLabel(signal.kind)}：${signal.message}，时长：${signal.duration}`)
            .join('；')
          appendLog(`禁言巡检：发现限制 - ${label}：${detail}`)
        } else if (result.status === 'deactivated') {
          appendLog(`禁言巡检：主播已注销 - ${label}`)
        } else if (result.status === 'unknown') {
          appendLog(`禁言巡检：无法确认 - ${label}：${result.note ?? '接口未返回明确结果'}`)
        } else {
          appendLog(`禁言巡检：正常 - ${label}`)
        }
        if (i < rooms.length - 1) await new Promise(r => setTimeout(r, 500))
      }

      const counts = getMedalCheckCounts(results)
      writeStatus(
        `完成：${rooms.length} 个房间，${counts.restricted} 个限制，${counts.deactivated} 个主播注销，${counts.unknown} 个无法确认`
      )
      appendLog(
        `禁言巡检完成：${rooms.length} 个房间，${counts.restricted} 个限制，${counts.deactivated} 个主播注销，${counts.unknown} 个无法确认`
      )
      if (guardRoomSyncKey.value.trim()) await syncGuardRoomInspection(results)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      writeStatus(`检查失败：${msg}`)
      appendLog(`禁言巡检失败：${msg}`)
    } finally {
      checkingMedalRooms.value = false
    }
  }

  const syncGuardRoomInspection = async (results = medalCheckResults.value) => {
    if (results.length === 0) {
      guardRoomSyncStatus.value = '还没有巡检结果'
      return
    }
    const endpoint = normalizeGuardRoomEndpoint(guardRoomEndpoint.value)
    const syncKey = guardRoomSyncKey.value.trim()
    if (!endpoint || !syncKey) {
      guardRoomSyncStatus.value = '缺少保安室地址或同步密钥'
      return
    }
    guardRoomSyncing.value = true
    guardRoomSyncStatus.value = '同步中…'
    try {
      const response = await fetch(`${endpoint}/api/inspection-runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sync-key': syncKey,
        },
        body: JSON.stringify(buildGuardRoomInspectionRun(results)),
      })
      const json: { message?: string } = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(json.message ?? `HTTP ${response.status}`)
      guardRoomSyncStatus.value = '已同步到直播间保安室'
      appendLog('直播间保安室：巡检结果已同步')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      guardRoomSyncStatus.value = `同步失败：${msg}。请检查保安室地址（必须是 https://）和同步密钥，或稍后重试。`
      appendLog(`直播间保安室：同步失败：${msg}`)
    } finally {
      guardRoomSyncing.value = false
    }
  }

  const uidLabelForReport = () => currentUid.value ?? '未登录'

  const copyMedalCheckResults = async () => {
    const results = medalCheckResults.value
    if (results.length === 0) {
      medalCheckCopyStatus.value = '还没有巡检结果'
      return
    }
    const ok = await copyTextToClipboard(
      formatMedalCheckReport(results, medalCheckStatus.value, medalCheckFilter.value, uidLabelForReport())
    )
    if (ok) {
      medalCheckCopyStatus.value = `已复制${medalFilterLabel(medalCheckFilter.value)}结果`
      setTimeout(() => {
        medalCheckCopyStatus.value = ''
      }, 1800)
    } else {
      medalCheckCopyStatus.value = '复制失败，请检查浏览器剪贴板权限，或改用「下载报告」'
    }
  }

  const downloadMedalCheckResults = () => {
    const results = medalCheckResults.value
    if (results.length === 0) {
      medalCheckCopyStatus.value = '还没有巡检结果'
      return
    }
    const report = formatMedalCheckReport(results, medalCheckStatus.value, 'all', uidLabelForReport())
    const blob = new Blob([report], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `禁言巡检_${new Date().toISOString().slice(0, 10)}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    medalCheckCopyStatus.value = '已下载报告'
    setTimeout(() => {
      medalCheckCopyStatus.value = ''
    }, 1800)
  }

  return (
    <details className='cb-settings-accordion' open>
      <summary>粉丝牌禁言巡检</summary>
      <div
        className='cb-section cb-stack'
        style={{ margin: '.5em 0', paddingBottom: '1em', borderBottom: '1px solid var(--Ga2, #eee)' }}
      >
        <div className='cb-heading' style={{ fontWeight: 'bold', marginBottom: '.5em' }}>
          粉丝牌禁言巡检
        </div>
        <div className='cb-note' style={{ marginBlock: '.5em', color: '#666' }}>
          只读取 B 站接口，不发送弹幕。结果会按限制、无法确认、主播注销、正常排序；上次巡检按账号分别保留。
        </div>
        <div
          className='cb-note'
          role='status'
          aria-live='polite'
          style={{
            marginBlock: '.25em',
            padding: '.35em .55em',
            borderRadius: '4px',
            background: currentUid.value ? 'rgba(10, 127, 85, .08)' : 'rgba(161, 92, 0, .08)',
            color: currentUid.value ? 'var(--cb-success-text)' : 'var(--cb-warning-text)',
          }}
        >
          {currentUid.value
            ? `当前账号 UID：${currentUid.value}（巡检与缓存只针对该账号）`
            : '未登录 Bilibili — 请先登录后再执行巡检'}
        </div>
        <details className='cb-panel cb-stack' style={{ marginBottom: '.5em' }}>
          <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 'bold' }} className='cb-heading'>
            直播间保安室同步（外部服务 · 可选）
          </summary>
          <div className='cb-note' style={{ color: '#666', marginTop: '.5em' }}>
            保安室是独立的开源项目，需要自行搭建或加入。同步会上传：房间号、主播昵称、粉丝牌、限制信号、脚本版本。
            <strong>不会上传 cookie、csrf、localStorage 或完整接口数据。</strong>
            填写密钥后，每次完成巡检会自动同步一次。
          </div>
          <label htmlFor='guardRoomEndpoint' className='cb-note' style={{ color: '#666' }}>
            保安室地址（必须是 https://，例外：localhost）
          </label>
          <input
            id='guardRoomEndpoint'
            type='url'
            placeholder='https://bilibili-guard-room.vercel.app'
            value={guardRoomEndpoint.value}
            onInput={e => {
              guardRoomEndpoint.value = e.currentTarget.value
            }}
          />
          {(() => {
            const v = guardRoomEndpoint.value.trim()
            if (v === '') return null
            const warn = validateGuardRoomEndpoint(v)
            if (!warn) return null
            return (
              <span role='status' aria-live='polite' style={{ color: 'var(--cb-warning-text)', fontSize: '0.8em' }}>
                ⚠️ {warn}
              </span>
            )
          })()}
          <label htmlFor='guardRoomSyncKey' className='cb-note' style={{ color: '#666' }}>
            同步密钥（在保安室项目首页注册空间后获得，格式：spaceId@syncSecret）
          </label>
          <input
            id='guardRoomSyncKey'
            type='text'
            placeholder='spaceId@syncSecret'
            value={guardRoomSyncKey.value}
            onInput={e => {
              guardRoomSyncKey.value = e.currentTarget.value
            }}
          />
          <div className='cb-row' style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <label
              htmlFor='guardRoomSyncKeyPersist'
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                color: '#666',
                fontSize: '0.85em',
                cursor: 'pointer',
              }}
            >
              <input
                id='guardRoomSyncKeyPersist'
                type='checkbox'
                checked={guardRoomSyncKeyPersist.value}
                onInput={e => {
                  guardRoomSyncKeyPersist.value = e.currentTarget.checked
                }}
              />
              <span title='不勾：密钥仅留在内存，刷新页面就清空，GM 存储里的旧值也立即抹掉'>
                保存到 GM 存储（关闭后仅本次会话有效）
              </span>
            </label>
            <button
              type='button'
              disabled={!guardRoomSyncKey.value}
              onClick={() => clearGuardRoomSyncKey()}
              style={{ fontSize: '11px', marginLeft: 'auto' }}
              title='把密钥从内存和 GM 存储里都抹掉'
            >
              清除
            </button>
          </div>
          {guardRoomSyncKeyPersist.value && guardRoomSyncKey.value && (
            <div
              role='status'
              aria-live='polite'
              style={{
                color: 'var(--cb-danger-text)',
                background: 'rgba(176,0,32,.08)',
                border: '1px solid rgba(176,0,32,.25)',
                padding: '6px 8px',
                borderRadius: '4px',
                fontSize: '12px',
                fontWeight: 600,
                lineHeight: 1.45,
                marginTop: '.25em',
              }}
            >
              ⚠️ 保安室同步密钥已明文存进浏览器 GM 存储。共用电脑、浏览器同步、其他扩展、备份导出都能直接读到。
              担心泄漏：上面取消勾选「保存到 GM 存储」改为仅本会话。
            </div>
          )}
          <div className='cb-row'>
            <button
              type='button'
              disabled={guardRoomSyncing.value || medalCheckResults.value.length === 0}
              title={medalCheckResults.value.length === 0 ? '需要先完成一次巡检' : undefined}
              onClick={() => void syncGuardRoomInspection()}
            >
              {guardRoomSyncing.value ? '同步中…' : '同步当前结果'}
            </button>
            {guardRoomSyncStatus.value && (
              <span className='cb-note' role='status' aria-live='polite'>
                {guardRoomSyncStatus.value}
              </span>
            )}
          </div>
        </details>
        <details className='cb-panel cb-stack' style={{ marginBottom: '.5em' }}>
          <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 'bold' }} className='cb-heading'>
            高级：监控室代理（默认折叠）
          </summary>
          <div className='cb-note' style={{ color: '#666', marginTop: '.5em' }}>
            连接到保安室网站后用于远程协调监控。普通用户通常不需要打开。
          </div>
          <div className='cb-note'>
            监控、推荐、跳转和统一跟车配置现在都以网站为准。脚本这边只负责同步牌子房/关注房清单、拉取网站配置，并在当前直播页执行试运行。
          </div>
          <label className='cb-note cb-switch-row'>
            <input
              type='checkbox'
              checked={guardRoomWebsiteControlEnabled.value}
              onChange={e => {
                guardRoomWebsiteControlEnabled.value = e.currentTarget.checked
              }}
            />
            <span title='开启后，连接的保安室网站可以远程下发预设和试运行开关；关闭后保留你的本地参数。'>
              允许直播间保安室远程下发自动跟车预设和试运行开关
            </span>
          </label>
          {!guardRoomWebsiteControlEnabled.value && (
            <div className='cb-note'>关闭时仍会同步监控状态，但不会把你的本地自定义参数改回 normal / 试运行。</div>
          )}
          {guardRoomHandoffActive.value && (
            <div className='cb-note'>当前页是从监控室接管跳转进来的，本页仍会按监控室指令执行试运行/自动启动。</div>
          )}
          <div className='cb-row' style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap' }}>
            <label className='cb-note' style={{ display: 'inline-flex', alignItems: 'center', gap: '.4em' }}>
              心跳间隔
              <input
                type='number'
                min='10'
                max='120'
                value={guardRoomLiveDeskHeartbeatSec.value}
                onInput={e => {
                  const value = Number(e.currentTarget.value)
                  guardRoomLiveDeskHeartbeatSec.value = Number.isFinite(value) ? Math.max(10, Math.min(120, value)) : 30
                }}
                style={{ width: '64px' }}
              />
              秒
            </label>
          </div>
          <div className='cb-note'>
            连接状态（网站主控版）：{guardRoomAgentConnected.value ? '已连接' : '未连接'} ·{' '}
            {guardRoomAgentStatusText.value}
          </div>
          <div className='cb-note'>当前会话：{guardRoomLiveDeskSessionId.value || '暂无活动监控会话'}</div>
          <div className='cb-note'>
            最近同步：
            {guardRoomAgentLastSyncAt.value
              ? new Date(guardRoomAgentLastSyncAt.value).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })
              : '暂无'}
          </div>
          <div className='cb-note'>
            当前监控清单：{guardRoomAgentWatchlistCount.value} 间 · 开播 {guardRoomAgentLiveCount.value} 间
          </div>
          <div className='cb-note'>
            网站下发配置：
            {guardRoomAppliedProfile.value
              ? `${guardRoomAppliedProfile.value.dryRunDefault ? '默认试运行' : '默认真发'} / ${guardRoomAppliedProfile.value.autoBlendEnabled ? '允许自动跟车' : '只观察'} / ${guardRoomAppliedProfile.value.conservativeMode} 档`
              : '尚未收到'}
          </div>
        </details>
        <div
          className='cb-row'
          style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5em' }}
        >
          <button
            type='button'
            disabled={checkingMedalRooms.value || !currentUid.value}
            title={!currentUid.value ? '需要先登录 Bilibili 账号' : undefined}
            onClick={() => void checkMedalRooms()}
          >
            {checkingMedalRooms.value ? '检查中…' : '检查粉丝牌禁言'}
          </button>
          <button
            type='button'
            disabled={medalCheckResults.value.length === 0}
            onClick={() => void copyMedalCheckResults()}
          >
            复制巡检结果
          </button>
          <button type='button' disabled={medalCheckResults.value.length === 0} onClick={downloadMedalCheckResults}>
            下载报告
          </button>
          <span
            role='status'
            aria-live='polite'
            style={{ color: medalCheckStatus.value.includes('发现限制') ? 'var(--cb-warning-text)' : '#666' }}
          >
            {medalCheckStatus.value}
          </span>
          {medalCheckCopyStatus.value && (
            <span className='cb-note' role='status' aria-live='polite'>
              {medalCheckCopyStatus.value}
            </span>
          )}
        </div>
        {medalCheckResults.value.length > 0 && (
          <div className='cb-stack'>
            {(() => {
              const counts = getMedalCheckCounts(medalCheckResults.value)
              const filter = medalCheckFilter.value
              const shownCount = getFilteredMedalResults(medalCheckResults.value, filter).length
              const filterButtonStyle = (
                active: boolean,
                color?: string
              ): Record<string, string | number | undefined> => ({
                minHeight: '24px',
                padding: '2px 6px',
                borderColor: active ? color : undefined,
                background: active ? 'rgba(0, 122, 255, .08)' : undefined,
                color,
                boxShadow: active ? 'inset 0 0 0 1px currentColor' : undefined,
              })
              return (
                <div className='cb-panel' style={{ display: 'grid', gap: '6px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' }}>
                    <button
                      type='button'
                      aria-pressed={filter === 'issues'}
                      onClick={() => writeFilter('issues')}
                      style={filterButtonStyle(filter === 'issues', 'var(--cb-warning-text)')}
                    >
                      异常 {counts.restricted + counts.unknown + counts.deactivated}
                    </button>
                    <button
                      type='button'
                      aria-pressed={filter === 'all'}
                      onClick={() => writeFilter('all')}
                      style={filterButtonStyle(filter === 'all')}
                    >
                      全部 {medalCheckResults.value.length}
                    </button>
                    <button
                      type='button'
                      aria-pressed={filter === 'restricted'}
                      onClick={() => writeFilter('restricted')}
                      style={filterButtonStyle(filter === 'restricted', 'var(--cb-warning-text)')}
                    >
                      限制 {counts.restricted}
                    </button>
                    <button
                      type='button'
                      aria-pressed={filter === 'unknown'}
                      onClick={() => writeFilter('unknown')}
                      style={filterButtonStyle(filter === 'unknown', '#666')}
                    >
                      未知 {counts.unknown}
                    </button>
                    <button
                      type='button'
                      aria-pressed={filter === 'deactivated'}
                      onClick={() => writeFilter('deactivated')}
                      style={filterButtonStyle(filter === 'deactivated', '#8e8e93')}
                    >
                      注销 {counts.deactivated}
                    </button>
                    <button
                      type='button'
                      aria-pressed={filter === 'ok'}
                      onClick={() => writeFilter('ok')}
                      style={filterButtonStyle(filter === 'ok', 'var(--cb-success-text)')}
                    >
                      正常 {counts.ok}
                    </button>
                  </div>
                  <div className='cb-note'>
                    当前显示：{medalFilterLabel(filter)} {shownCount} / {medalCheckResults.value.length} 条
                  </div>
                </div>
              )
            })()}
            <div style={{ maxHeight: '220px', overflowY: 'auto', display: 'grid', gap: '.35em' }}>
              {getFilteredMedalResults(medalCheckResults.value, medalCheckFilter.value).map(result => {
                const color = medalStatusColor(result.status)
                const title = medalStatusTitle(result.status)
                return (
                  <div
                    key={result.room.roomId}
                    className='cb-panel'
                    style={{
                      display: 'grid',
                      gap: '.25em',
                      borderColor: result.status === 'restricted' ? '#f0b35a' : undefined,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '.5em' }}>
                      <strong style={{ wordBreak: 'break-all' }}>
                        {result.room.anchorName} / {result.room.medalName}
                      </strong>
                      <span style={{ color, whiteSpace: 'nowrap' }}>{title}</span>
                    </div>
                    <div className='cb-note'>
                      房间号：{result.room.roomId} · 检查时间：{formatCheckTime(result.checkedAt)}
                    </div>
                    {result.signals.length > 0 ? (
                      result.signals.map((signal, index) => (
                        <div key={index} style={{ color, wordBreak: 'break-all', lineHeight: 1.5 }}>
                          {signalKindLabel(signal.kind)}：{signal.message}
                          <br />
                          时长：{signal.duration} · 来源：{signal.source}
                        </div>
                      ))
                    ) : (
                      <div className='cb-note'>{result.note ?? '接口未发现禁言/封禁信号'}</div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </details>
  )
}
