import { useSignal } from '@preact/signals'

import type { MemeSource } from '../lib/meme-sources'

import { startHzmAutoDrive, stopHzmAutoDrive } from '../lib/hzm-auto-drive'
import { getMemeSourceForRoom } from '../lib/meme-sources'
import { warnIfOtherSourcesActive } from '../lib/multi-source-warning'
import {
  activeTab,
  cachedRoomId,
  currentMemesList,
  currentMemesListRoomId,
  getBlacklistTags,
  getDailyStats,
  getSelectedTags,
  type HzmDriveMode,
  type HzmDriveSendMode,
  hasConfirmedHzmRealFire,
  hzmActivityMinDanmu,
  hzmActivityMinDistinctUsers,
  hzmActivityWindowSec,
  hzmDriveEnabled,
  hzmDriveIntervalSec,
  hzmDriveMode,
  hzmDriveSendMode,
  hzmDriveStatusText,
  hzmLlmRatio,
  hzmPauseKeywordsOverride,
  hzmRateLimitPerMin,
  hzmStrictHeuristic,
  llmApiKey,
  sendMsg,
  setBlacklistTags,
  setSelectedTags,
} from '../lib/store'
import { extractRoomNumber } from '../lib/utils'
import { LlmApiConfigSummary } from './llm-api-config'
import { showConfirm } from './ui/alert-dialog'

/**
 * 智能辅助驾驶 独立面板。
 *
 * 设计：UIUX 镜像 `AutoBlendControls`：
 *  - 顶部：开车/停车按钮 + 状态指示点
 *  - 第二行：模式 segment（启发式 / LLM 智驾），仅切换模式偏好，不会启动
 *  - 试运行 复选框
 *  - 状态面板：今日已发 / 刚刚动作
 *  - 高级设置 折叠
 *  - LLM 配置 折叠（仅 mode=llm 时显示）
 */

const MODE_LABEL: Record<HzmDriveMode, string> = {
  heuristic: '启发式',
  llm: 'LLM 智驾',
}

const MODE_HINT: Record<HzmDriveMode, string> = {
  heuristic: '关键词触发，按 tag 命中本地梗库',
  llm: '由 LLM 阅读弹幕选梗，需要 API key',
}

const SEND_MODE_LABEL: Record<HzmDriveSendMode, string> = {
  dry: '🧪 试运行',
  candidate: '📝 候选',
  live: '🚗 直接发送',
}

const SEND_MODE_HINT: Record<HzmDriveSendMode, string> = {
  dry: '只在日志显示选中的梗,不发送、不入审',
  candidate: '选中的梗推到「AI 陪聊」面板,等你点确认才发(推荐)',
  live: '选中即发,与你手动发弹幕等同',
}

function modeButtonStyle(active: boolean) {
  return {
    fontWeight: active ? ('bold' as const) : undefined,
  }
}

/**
 * 在配置面板里挂载智驾——仅当当前房间在 meme-sources 注册表里有匹配源时显示。
 * 目前只有灰泽满（roomId 1713546334）。
 *
 * 立即可见性：cachedRoomId 要等 ensureRoomId() 的网络解析（room_init）回来才会
 * 被填上，开面板时会有一两秒空窗。对现代房间，URL slug 就是真实 room_id，
 * 所以先用 URL slug 同步查一次注册表——能命中就立即渲染，不必等 API。等
 * cachedRoomId 实际写入后，下面的 HzmDrivePanel 会自然重渲染拿到正确的统计。
 */
function resolveCurrentRoomIdSync(): number | null {
  const fromCache = cachedRoomId.value
  if (fromCache !== null) return fromCache
  try {
    const slug = extractRoomNumber(window.location.href)
    if (!slug) return null
    const n = Number(slug)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * 在任何房间没有 source 注册时合成一个最小可用的 MemeSource。这让智驾运行时
 * (startHzmAutoDrive 要求 roomId === source.roomId)能在非灰泽满房间起,且
 * 让面板内引用 source.name / pauseKeywords 的代码自然降级到中性默认值。
 *
 * listEndpoint 给空串 —— 智驾通过 memesProvider() callback 拿梗(memes-list
 * 已经在合并 LAPLACE/sbhzm/cb 后写入 currentMemesList),从不读这个字段。
 */
function makeSyntheticSource(roomId: number): MemeSource {
  return {
    roomId,
    name: '当前房间梗库',
    listEndpoint: '',
  }
}

/**
 * 一个房间至少要有 N 条梗,才有意义让 LLM 选 —— 太少的时候 LLM 选半天也只能
 * 反复挑那几条,体验差。10 是经验阈值,可以根据反馈调。
 */
export const MIN_MEMES_FOR_GENERIC_DRIVE = 10

/** 智驾面板挂载决策类型(给纯函数 + JSX caller 共用)。 */
export type HzmMountDecision =
  | { kind: 'none' }
  | { kind: 'native'; source: MemeSource }
  | { kind: 'synthetic'; roomId: number }

/**
 * 纯函数:根据 roomId + 注册源 + 当前梗库大小 + drive 是否在跑,决定面板该不该挂载、
 * 以及挂载时用什么 source。抽出来是为了在 tests/hzm-drive-panel-mount.test.ts 里能稳
 * 定断言这套决策,不需要起 Preact 渲染。
 *
 * 关键不变量:
 *  - 有注册源(灰泽满)→ 永远 native,与 memesCount / driveEnabled 无关。
 *  - 无注册源 + drive 已在跑 → synthetic 挂载,即使 memesCount=0(用户必须能看到停车按钮)。
 *  - 无注册源 + drive 没在跑 + memesCount≥10 → synthetic 挂载(常规入场),**但** memesCount
 *    必须来自当前房间(`memesRoomId === roomId`)。SPA 切房间到 loadMemes 完成是一个
 *    1–10s 异步窗口,期间 `currentMemesList` 还是前一个房间的数据。如果不校验房间
 *    归属,陈旧的 ≥10 会让 gate 通过 → 用户开车 → 智驾用旧房间的梗发到新房间(主播
 *    一脸懵 + 用户被拉黑)。见 Codex round-2 on PR #36。
 *  - 其他 → none。
 */
export function decideHzmMount(opts: {
  roomId: number | null
  source: MemeSource | null
  memesCount: number
  /** `currentMemesList` 对应的房间号(由 store-meme.ts 的 currentMemesListRoomId 提供)。
   *  若与 `roomId` 不匹配,memesCount 视为 0 —— 防止 SPA 切房间时陈旧 count 误通过 gate。 */
  memesRoomId: number | null
  driveEnabled: boolean
}): HzmMountDecision {
  if (opts.roomId === null) return { kind: 'none' }
  if (opts.source) return { kind: 'native', source: opts.source }
  // Stale-room guard:list 不属于当前房间时,把 count 视为 0。
  const effectiveCount = opts.memesRoomId === opts.roomId ? opts.memesCount : 0
  if (effectiveCount >= MIN_MEMES_FOR_GENERIC_DRIVE || opts.driveEnabled) {
    return { kind: 'synthetic', roomId: opts.roomId }
  }
  return { kind: 'none' }
}

export function HzmDrivePanelMount() {
  const roomId = resolveCurrentRoomIdSync()
  const decision = decideHzmMount({
    roomId,
    source: getMemeSourceForRoom(roomId),
    memesCount: currentMemesList.value.length,
    memesRoomId: currentMemesListRoomId.value,
    driveEnabled: hzmDriveEnabled.value,
  })
  if (decision.kind === 'none') return null
  if (decision.kind === 'native') return <HzmDrivePanel source={decision.source} hasNativeSource />
  return <HzmDrivePanel source={makeSyntheticSource(decision.roomId)} hasNativeSource={false} />
}

function HzmDrivePanel({ source, hasNativeSource }: { source: MemeSource; hasNativeSource: boolean }) {
  const roomId = cachedRoomId.value
  const stats = getDailyStats(roomId)
  const selected = getSelectedTags(roomId)
  const blacklist = getBlacklistTags(roomId)
  const isOn = hzmDriveEnabled.value
  // 无原生 source 的房间没有 keywordToTag,启发式会退化成纯随机 —— 强制 LLM。
  // 这覆盖了用户在持久化里曾经选过 'heuristic' 的情况。
  const mode: HzmDriveMode = hasNativeSource ? hzmDriveMode.value : 'llm'

  // 当前梗集里出现过的 tag（偏好 / 黑名单选项源）
  const memes = currentMemesList.value
  const tagOptions: string[] = (() => {
    const set = new Set<string>()
    for (const m of memes) {
      for (const t of m.tags) {
        if (t.name) set.add(t.name)
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  })()

  const advancedOpen = useSignal(false)

  const statusText = hzmDriveStatusText.value
  const statusColor = !isOn
    ? '#777'
    : statusText.includes('试运行')
      ? 'var(--cb-warning-text)'
      : statusText.includes('运行中')
        ? 'var(--cb-accent)'
        : 'var(--cb-success-text)'

  const sendMode = hzmDriveSendMode.value
  const isLive = sendMode === 'live'

  const toggleEnabled = async () => {
    if (isOn) {
      hzmDriveEnabled.value = false
      stopHzmAutoDrive()
      return
    }
    // Footgun #1:与文字独轮车同时开启会叠加每分钟限速。开车前强制二次确认。
    // 只在 live 模式下提示——dry/candidate 都不实际占用 B 站发送配额。
    if (sendMsg.value && isLive) {
      const ok = await showConfirm({
        title: '文字独轮车正在运行',
        body: '与智驾叠加后两边一起发，可能超过每分钟限速被风控/封禁。建议先停一边再开。继续吗？',
        confirmText: '我知道风险，继续开车',
        cancelText: '返回（先停一个）',
      })
      if (!ok) return
    }
    // Footgun #2:LLM 模式需要 API key。没填就开车会反复在日志报错或回落到启发式,
    // 用户摸不着头脑。提前拦住并跳设置。
    if (mode === 'llm' && llmApiKey.value.trim() === '') {
      const ok = await showConfirm({
        title: 'LLM 智驾需要 API key',
        body: '尚未配置 LLM 凭证。点「去设置」会跳到「设置 → LLM」填 key；点取消保持现状。',
        confirmText: '去设置',
        cancelText: '取消',
      })
      if (ok) activeTab.value = 'settings'
      return
    }
    // 关 → 开:只在 live 档且未确认过时弹真发提示。dry/candidate 不发到 B 站,
    // 不需要这一层确认。用 showConfirm 替代 native confirm() —— 后者在浏览器里
    // 会被 anti-popup 抑制 / 不参与暗色模式 / 没法做样式与 dialog 一致。
    if (isLive && !hasConfirmedHzmRealFire.value) {
      const ok = await showConfirm({
        title: '智能辅助驾驶将以你的账号真实发送弹幕',
        body: '当前已选「直接发送」。建议先用「候选」或「试运行」观察一段时间。是否继续直接开车？',
        confirmText: '我已了解，开车',
        cancelText: '取消',
      })
      if (!ok) return
      hasConfirmedHzmRealFire.value = true
    }
    hzmDriveEnabled.value = true
    void startHzmAutoDrive({ source, getMemes: () => currentMemesList.value })
    // 智驾 + 独轮车 已有显式 showConfirm 阻塞(Footgun #1);这里再补一条 toast
    // 兜底覆盖 智驾 + 自动跟车 / 智驾 + 任意其他组合的并发场景。
    void warnIfOtherSourcesActive('hzm')
  }

  const toggleSelectedTag = (tag: string) => {
    if (roomId === null) return
    setSelectedTags(roomId, selected.includes(tag) ? selected.filter(t => t !== tag) : [...selected, tag])
  }

  const toggleBlacklistTag = (tag: string) => {
    if (roomId === null) return
    setBlacklistTags(roomId, blacklist.includes(tag) ? blacklist.filter(t => t !== tag) : [...blacklist, tag])
  }

  const pauseDefault = (source.pauseKeywords ?? []).join(' / ')

  // Outer <details>/<summary>智能辅助驾驶（...）</summary>...</details>
  // removed: the configurator.tsx 🤖 wrapper is now bound to `hzmPanelOpen`
  // and owns the disclosure. Two nested toggles for the same panel was
  // redundant; the inner summary's only unique info (source.name +
  // running-state pill) is now rendered as a heading inside the panel
  // content.
  //
  // hzmPanelOpen is still read by the configurator wrapper to preserve
  // the GM-persisted open state across sessions, so the user's last view
  // of this panel is restored on next page load.
  return (
    <>
      <div className='cb-heading' style={{ display: 'flex', alignItems: 'center', gap: '.5em' }}>
        <span>智能辅助驾驶</span>
        {isOn && <span className='cb-soft'>运行中</span>}
      </div>
      <div className='cb-note' style={{ marginTop: '-.25em', marginBottom: '.25em' }}>
        当前梗源:{source.name}
      </div>
      <div className='cb-body cb-stack'>
        <div className='cb-note' style={{ marginBottom: '.25em' }}>
          条件满足时，会以你的账号自动从烂梗库挑选并发送弹幕。第一次开启建议先打开下方的「试运行」观察效果。
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '.5em', alignItems: 'center' }}>
          {/* skipcq: JS-0098 — `void` discards the floating Promise from the async toggle so the click handler stays sync-typed for React. */}
          <button type='button' className={isOn ? 'cb-danger' : 'cb-primary'} onClick={() => void toggleEnabled()}>
            {isOn ? '停车' : '开车'}
          </button>
          <span
            style={{
              color: statusColor,
              fontWeight: 'bold',
              whiteSpace: 'nowrap',
            }}
          >
            <span className='cb-status-dot' /> {statusText}
          </span>
        </div>

        {hasNativeSource ? (
          <div>
            <div className='cb-segment'>
              {(['heuristic', 'llm'] as const).map(m => (
                <button
                  key={m}
                  type='button'
                  aria-pressed={mode === m}
                  onClick={() => {
                    hzmDriveMode.value = m
                  }}
                  style={modeButtonStyle(mode === m)}
                  title={MODE_HINT[m]}
                >
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
            <div className='cb-note' style={{ marginTop: '.25em' }}>
              当前：{MODE_HINT[mode]}
            </div>
          </div>
        ) : (
          // 非注册源房间(无 keywordToTag)只显示 LLM 模式 —— 启发式会退化成随机选,
          // 体验差,索性不给这个选项。
          <div className='cb-note' style={{ marginTop: '.25em' }}>
            此房间无关键词配置,自动使用 LLM 模式选梗(需要 API key)
          </div>
        )}

        <div>
          <div className='cb-segment'>
            {(['dry', 'candidate', 'live'] as const).map(m => (
              <button
                key={m}
                type='button'
                aria-pressed={sendMode === m}
                onClick={() => {
                  hzmDriveSendMode.value = m
                }}
                style={modeButtonStyle(sendMode === m)}
                title={SEND_MODE_HINT[m]}
              >
                {SEND_MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <div className='cb-note' style={{ marginTop: '.25em' }}>
            {SEND_MODE_HINT[sendMode]}
            {sendMode === 'live' && (
              <span style={{ marginLeft: '.5em', color: 'var(--cb-warning-text)' }}>会真实发送弹幕</span>
            )}
          </div>
        </div>

        <div
          className='cb-panel'
          style={{
            color: isOn ? undefined : '#999',
            lineHeight: 1.6,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '4.5em 1fr', gap: '.25em' }}>
            <strong>今日</strong>
            <span>
              已发 <b>{stats.sent}</b> 条 · LLM 调用 <b>{stats.llmCalls}</b> 次
            </span>
          </div>
        </div>

        {sendMsg.value && (
          <div role='alert' style={{ color: 'var(--cb-danger)', fontSize: '12px', fontWeight: 650, lineHeight: 1.5 }}>
            ⚠️ 文字独轮车正在运行 —— 与智驾叠加会同时往 B 站发，极易超出限速被风控。开车前会再次确认；建议先停一边。
          </div>
        )}
        {mode === 'llm' && llmApiKey.value.trim() === '' && (
          <div role='alert' style={{ color: 'var(--cb-danger)', fontSize: '12px', fontWeight: 650, lineHeight: 1.5 }}>
            ⚠️ LLM 智驾未配置 API key。开车前请先到「设置 → LLM」填好 key，否则无法工作。
          </div>
        )}
      </div>

      <details
        open={advancedOpen.value}
        onToggle={e => {
          advancedOpen.value = e.currentTarget.open
        }}
        style={{ marginTop: '.5em' }}
      >
        <summary style={{ cursor: 'pointer', userSelect: 'none' }}>高级设置</summary>

        <div
          style={{
            margin: '.5em 0',
            display: 'grid',
            gap: '.5em',
            color: isOn ? undefined : '#999',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.25em' }}>
            <span>发送间隔</span>
            <input
              type='number'
              min='3'
              max='120'
              style={{ width: '40px' }}
              value={hzmDriveIntervalSec.value}
              onInput={e => {
                const v = Number.parseInt(e.currentTarget.value, 10)
                if (Number.isFinite(v) && v > 0) hzmDriveIntervalSec.value = v
              }}
              title='基础间隔（秒），实际会再加 0.7~1.5× 的随机抖动。建议 5–15。'
            />
            <span>秒，每分钟最多</span>
            <input
              type='number'
              min='1'
              max='20'
              style={{ width: '40px' }}
              value={hzmRateLimitPerMin.value}
              onInput={e => {
                const v = Number.parseInt(e.currentTarget.value, 10)
                if (Number.isFinite(v) && v > 0) hzmRateLimitPerMin.value = v
              }}
              title='硬限速。同时开文字独轮车会叠加发送量，建议保持 ≤6 单独使用。'
            />
            <span>条</span>
            {mode === 'llm' && (
              <>
                <span style={{ marginLeft: '.5em' }}>，LLM 每</span>
                <input
                  type='number'
                  min='1'
                  max='10'
                  style={{ width: '36px' }}
                  value={hzmLlmRatio.value}
                  onInput={e => {
                    const v = Number.parseInt(e.currentTarget.value, 10)
                    if (Number.isFinite(v) && v >= 1) hzmLlmRatio.value = v
                  }}
                  title='1=每次都用 LLM；3=每 3 次用 1 次（其它走启发式，省 API 费）'
                />
                <span>次</span>
              </>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.25em' }}>
            <span title='活跃度闸门：最近窗口内必须既有 ≥N 条公屏，又有 ≥M 个不同 uid，否则本 tick 不发——避免空屏照刷。'>
              活跃度 最近
            </span>
            <input
              type='number'
              min='10'
              max='300'
              style={{ width: '46px' }}
              value={hzmActivityWindowSec.value}
              onInput={e => {
                const v = Number.parseInt(e.currentTarget.value, 10)
                if (Number.isFinite(v) && v >= 10) hzmActivityWindowSec.value = v
              }}
              title='活跃度窗口（秒）。建议 30–90。'
            />
            <span>秒内 ≥</span>
            <input
              type='number'
              min='1'
              max='50'
              style={{ width: '40px' }}
              value={hzmActivityMinDanmu.value}
              onInput={e => {
                const v = Number.parseInt(e.currentTarget.value, 10)
                if (Number.isFinite(v) && v >= 1) hzmActivityMinDanmu.value = v
              }}
              title='窗口内最少弹幕条数。'
            />
            <span>条 / ≥</span>
            <input
              type='number'
              min='1'
              max='20'
              style={{ width: '36px' }}
              value={hzmActivityMinDistinctUsers.value}
              onInput={e => {
                const v = Number.parseInt(e.currentTarget.value, 10)
                if (Number.isFinite(v) && v >= 1) hzmActivityMinDistinctUsers.value = v
              }}
              title='窗口内最少不同人数。防一人独刷被当作活跃。'
            />
            <span>人在说话</span>
          </div>

          <label
            style={{ display: 'flex', alignItems: 'center', gap: '.4em', cursor: 'pointer' }}
            title='严格模式：弹幕里没匹配到关键词、用户也没勾偏好 tag 时，本 tick 不发。关掉则随机选一条（旧版行为）。'
          >
            <input
              type='checkbox'
              checked={hzmStrictHeuristic.value}
              onInput={e => {
                hzmStrictHeuristic.value = e.currentTarget.checked
              }}
            />
            <span>严格选梗（无信号时不随机兜底）</span>
          </label>

          {tagOptions.length > 0 ? (
            <>
              <div className='cb-row'>
                <span style={{ fontWeight: 'bold', minWidth: '4em' }} title='只从勾选 tag 的梗里选；空 = 全部'>
                  偏好 tag
                </span>
                {tagOptions.map(t => (
                  <button
                    key={t}
                    type='button'
                    className='cb-tag'
                    onClick={() => toggleSelectedTag(t)}
                    title={selected.includes(t) ? '已加入偏好，点击取消' : '点击加入偏好'}
                    style={{ '--cb-tag-bg': selected.includes(t) ? '#34c759' : undefined }}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div className='cb-row'>
                <span style={{ fontWeight: 'bold', minWidth: '4em' }} title='命中即跳过的 tag'>
                  黑名单
                </span>
                {tagOptions.map(t => (
                  <button
                    key={t}
                    type='button'
                    className='cb-tag'
                    onClick={() => toggleBlacklistTag(t)}
                    title={blacklist.includes(t) ? '已拉黑，点击取消' : '点击拉黑这个 tag'}
                    style={{ '--cb-tag-bg': blacklist.includes(t) ? 'var(--cb-danger)' : undefined }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className='cb-empty'>梗库还没加载到 tag。等列表载入后再来选偏好与黑名单。</div>
          )}

          <div className='cb-row'>
            <span style={{ fontWeight: 'bold', minWidth: '4em' }}>暂停词</span>
            <span style={{ fontSize: '10px', color: '#888' }}>
              每行一条正则；命中后 60s 不发。空 = 用默认（{pauseDefault || '无'}）
            </span>
          </div>
          <textarea
            rows={2}
            value={hzmPauseKeywordsOverride.value}
            onInput={e => {
              hzmPauseKeywordsOverride.value = e.currentTarget.value
            }}
            style={{ boxSizing: 'border-box', width: '100%', fontSize: '11px', resize: 'vertical' }}
            placeholder={(source.pauseKeywords ?? []).join('\n')}
          />
        </div>
      </details>

      {mode === 'llm' && (
        <div style={{ marginTop: '.5em' }}>
          <LlmApiConfigSummary
            onJumpToSettings={() => {
              activeTab.value = 'settings'
            }}
          />
        </div>
      )}
    </>
  )
}
