import { useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'

import { computeAutoCooldownSec, getCurrentCpm } from '../lib/auto-blend'
import { AUTO_BLEND_PRESETS } from '../lib/auto-blend-preset-config'
import { applyAutoBlendPreset } from '../lib/auto-blend-presets'
import { decideAutoBlendToggle } from '../lib/auto-blend-toggle'
import { appendLog } from '../lib/log'
import { warnIfOtherSourcesActive } from '../lib/multi-source-warning'
import {
  autoBlendAdvancedOpen,
  autoBlendAvoidRepeat,
  autoBlendBurstSettleMs,
  autoBlendCandidateProgress,
  autoBlendCooldownAuto,
  autoBlendCooldownSec,
  autoBlendDriftFromPreset,
  autoBlendDryRun,
  autoBlendEnabled,
  autoBlendLastActionText,
  autoBlendMessageBlacklist,
  autoBlendMinDistinctUsers,
  autoBlendPanelOpen,
  autoBlendPreset,
  autoBlendRateLimitStopThreshold,
  autoBlendRateLimitWindowMin,
  autoBlendRequireDistinctUsers,
  autoBlendRoutineIntervalSec,
  autoBlendSendAllTrending,
  autoBlendSendCount,
  autoBlendStatusText,
  autoBlendThreshold,
  autoBlendUseReplacements,
  autoBlendUserBlacklist,
  autoBlendWindowSec,
  autoBlendYolo,
  hasConfirmedAutoBlendRealFire,
  lastAutoBlendRealFireConfirmAt,
  llmActivePromptAutoBlend,
  llmPromptsAutoBlend,
  msgSendInterval,
} from '../lib/store'
import { PromptPicker } from './prompt-picker'
import { showConfirm } from './ui/alert-dialog'
import { YoloCallout } from './yolo-callout'

function NumberInput({
  value,
  min,
  max,
  width = '40px',
  disabled,
  onChange,
}: {
  value: number
  min: number
  max?: number
  width?: string
  disabled?: boolean
  onChange: (n: number) => void
}) {
  const rangeText = max !== undefined ? `${min}–${max}` : `≥${min}`
  const rangeHint = max !== undefined ? `允许范围：${min}–${max}` : `最小值：${min}`
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
      <input
        type='number'
        autocomplete='off'
        min={String(min)}
        max={max !== undefined ? String(max) : undefined}
        title={rangeHint}
        aria-label={rangeHint}
        style={{ width }}
        value={value}
        disabled={disabled}
        onInput={e => {
          let v = Number.parseInt(e.currentTarget.value, 10)
          if (Number.isNaN(v) || v < min) v = min
          if (max !== undefined && v > max) v = max
          onChange(v)
        }}
      />
      <span className='cb-soft' aria-hidden='true' style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
        {rangeText}
      </span>
    </span>
  )
}

/**
 * 调过参所以切到 custom——只在调整后的值真的偏离了当前预设基线时才把
 * 预设标签换成「自定义」。这样用户把一个值从 35 改回 35，或者切到隐藏
 * 的等值时，仍然保留「正常」/「稳一点」标签。
 *
 * 实现：onChange 调到这里时，对应的 signal 已被赋值（callsite 顺序：先 set,
 * 再 markCustomIfDrifted）。读所有 preset signals 与 baseline 比对。
 *
 * 仅用于 AUTO_BLEND_PRESETS 包含的字段。dryRun / yolo / cooldownAuto /
 * avoidRepeat 这种 preset 之外的开关不在预设定义里，改它们不影响预设标签。
 */
function markCustomIfDrifted(): void {
  const preset = autoBlendPreset.peek()
  if (preset === 'custom') return
  const baseline = AUTO_BLEND_PRESETS[preset]
  // 完整 preset values 包括 require/sendCount/sendAllTrending/useReplacements,
  // 它们在 getAutoBlendPresetValues 里有默认值。但这些"扩展字段"在三档之间
  // 共享同一默认（requireDistinctUsers=true, sendCount=1, sendAllTrending=false,
  // useReplacements=true），所以直接硬编码这些默认作为基线。
  if (
    autoBlendWindowSec.peek() !== baseline.windowSec ||
    autoBlendThreshold.peek() !== baseline.threshold ||
    autoBlendCooldownSec.peek() !== baseline.cooldownSec ||
    autoBlendRoutineIntervalSec.peek() !== baseline.routineIntervalSec ||
    autoBlendMinDistinctUsers.peek() !== baseline.minDistinctUsers ||
    autoBlendBurstSettleMs.peek() !== baseline.burstSettleMs ||
    autoBlendRateLimitWindowMin.peek() !== baseline.rateLimitWindowMin ||
    autoBlendRateLimitStopThreshold.peek() !== baseline.rateLimitStopThreshold ||
    autoBlendRequireDistinctUsers.peek() !== true ||
    autoBlendSendCount.peek() !== 1 ||
    autoBlendSendAllTrending.peek() !== false ||
    autoBlendUseReplacements.peek() !== true
  ) {
    autoBlendPreset.value = 'custom'
  }
}

function modeButtonStyle(active: boolean) {
  return {
    fontWeight: active ? 'bold' : undefined,
  }
}

function SettingHint({ children }: { children: string }) {
  return (
    <div className='cb-note' style={{ marginTop: '-.25em' }}>
      {children}
    </div>
  )
}

function BlacklistPanel() {
  const addUid = useSignal('')
  const addUname = useSignal('')
  const list = autoBlendUserBlacklist.value
  const entries = Object.entries(list)

  const handleAdd = () => {
    const uid = addUid.value.trim().replace(/\D/g, '')
    if (!uid) return
    if (uid in list) {
      appendLog(`⚠️ UID ${uid} 已在黑名单中`)
      return
    }
    const next = { ...list, [uid]: addUname.value.trim() }
    autoBlendUserBlacklist.value = next
    appendLog(`🚲 已加入融入黑名单：${addUname.value.trim() || uid}`)
    addUid.value = ''
    addUname.value = ''
  }

  const handleRemove = (uid: string) => {
    const next = { ...list }
    const display = next[uid] || uid
    delete next[uid]
    autoBlendUserBlacklist.value = next
    appendLog(`🚲 已解除融入黑名单：${display}`)
  }

  return (
    <details style={{ marginTop: '.5em' }}>
      <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
        融入黑名单
        {entries.length > 0 && <span className='cb-soft'> ({entries.length})</span>}
      </summary>

      <div style={{ margin: '.5em 0', display: 'grid', gap: '.35em' }}>
        <div className='cb-note'>黑名单用户的弹幕不会触发自动跟车。也可在弹幕右键菜单中添加。</div>

        {entries.length > 0 ? (
          <div style={{ maxHeight: '150px', overflowY: 'auto', display: 'grid', gap: '.25em' }}>
            {entries.map(([uid, uname]) => (
              <div
                key={uid}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '.5em',
                  padding: '2px 4px',
                  borderRadius: '3px',
                  background: 'rgba(0,0,0,.04)',
                }}
              >
                <span
                  style={{
                    flex: 1,
                    fontSize: '12px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {uname || '(未记录昵称)'}
                  <span style={{ color: '#999', marginLeft: '.4em' }}>UID {uid}</span>
                </span>
                <button
                  type='button'
                  className='cb-rule-remove'
                  style={{ minHeight: 'unset', padding: '1px 6px', fontSize: '11px' }}
                  onClick={() => handleRemove(uid)}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className='cb-empty'>暂无黑名单用户</div>
        )}

        <div style={{ display: 'flex', gap: '.35em', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type='text'
            placeholder='UID'
            style={{ width: '80px' }}
            value={addUid.value}
            onInput={e => {
              addUid.value = e.currentTarget.value.replace(/\D/g, '')
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault()
                handleAdd()
              }
            }}
          />
          <input
            type='text'
            placeholder='备注名（可选）'
            style={{ flex: 1, minWidth: '60px' }}
            value={addUname.value}
            onInput={e => {
              addUname.value = e.currentTarget.value
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault()
                handleAdd()
              }
            }}
          />
          <button type='button' onClick={handleAdd} style={{ whiteSpace: 'nowrap' }}>
            添加
          </button>
        </div>
      </div>
    </details>
  )
}

/**
 * Text-based blacklist (parallel to BlacklistPanel which is UID-based). Exact
 * trim() match against incoming danmaku. 用来挡 "666"、"+1"、"哈哈哈"
 * 这种万能水——已经达标也不要跟。Object.hasOwn 在过滤函数里防原型链
 * 误命中，UI 这边只管增删。
 */
function MessageBlacklistPanel() {
  const addText = useSignal('')
  const list = autoBlendMessageBlacklist.value
  const entries = Object.keys(list)

  const handleAdd = () => {
    const text = addText.value.trim()
    if (!text) return
    if (Object.hasOwn(list, text)) {
      appendLog(`⚠️ 文本"${text}"已在融入文本黑名单中`)
      return
    }
    autoBlendMessageBlacklist.value = { ...list, [text]: true }
    appendLog(`🚲 已加入融入文本黑名单：${text}`)
    addText.value = ''
  }

  const handleRemove = (text: string) => {
    const next = { ...list }
    delete next[text]
    autoBlendMessageBlacklist.value = next
    appendLog(`🚲 已解除融入文本黑名单：${text}`)
  }

  return (
    <details style={{ marginTop: '.5em' }}>
      <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
        融入文本黑名单
        {entries.length > 0 && <span className='cb-soft'> ({entries.length})</span>}
      </summary>

      <div style={{ margin: '.5em 0', display: 'grid', gap: '.35em' }}>
        <div className='cb-note'>
          {
            '黑名单中的弹幕(精确匹配,trim 后)永远不会触发自动跟车。适合屏蔽 "666"、"+1"、"哈哈哈" 这类无意义高频水弹幕。'
          }
        </div>

        {entries.length > 0 ? (
          <div style={{ maxHeight: '150px', overflowY: 'auto', display: 'grid', gap: '.25em' }}>
            {entries.map(text => (
              <div
                key={text}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '.5em',
                  padding: '2px 4px',
                  borderRadius: '3px',
                  background: 'rgba(0,0,0,.04)',
                }}
              >
                <span
                  style={{
                    flex: 1,
                    fontSize: '12px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    wordBreak: 'break-all',
                  }}
                  title={text}
                >
                  {text}
                </span>
                <button
                  type='button'
                  className='cb-rule-remove'
                  style={{ minHeight: 'unset', padding: '1px 6px', fontSize: '11px' }}
                  onClick={() => handleRemove(text)}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className='cb-empty'>暂无文本黑名单</div>
        )}

        <div style={{ display: 'flex', gap: '.35em', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type='text'
            placeholder='要屏蔽的弹幕原文(精确匹配)'
            style={{ flex: 1, minWidth: '60px' }}
            value={addText.value}
            onInput={e => {
              addText.value = e.currentTarget.value
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault()
                handleAdd()
              }
            }}
          />
          <button type='button' onClick={handleAdd} style={{ whiteSpace: 'nowrap' }}>
            添加
          </button>
        </div>
      </div>
    </details>
  )
}

/**
 * Compact progress row for the leading trending candidate. Shows "正在刷"
 * label, the short text, and a count + bar. Color shifts orange→red as the
 * fill ratio approaches 1 so users see "almost triggering" at a glance.
 * Uses the AND-bottleneck fillRatio so the bar reflects whichever of count
 * or distinct-users is the limiter.
 */
function CandidateProgressRow() {
  const progress = autoBlendCandidateProgress.value
  const labelStyle = { wordBreak: 'break-all', overflowWrap: 'anywhere' as const }

  if (!progress?.text) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '4.5em 1fr', gap: '.25em' }}>
        <strong>正在刷</strong>
        <span style={labelStyle}>暂无</span>
      </div>
    )
  }

  const fill = Math.max(0, Math.min(1, progress.fillRatio))
  // Hue: 30 (orange) → 0 (red) as fill grows. Lower than ~0.4 stays muted.
  const hue = Math.round(30 * (1 - fill))
  const sat = fill < 0.4 ? 25 : 60
  const barFg = `hsl(${hue}, ${sat}%, 50%)`
  const barBg = 'rgba(0,0,0,.08)'
  const usersFragment = progress.requireDistinctUsers ? ` · ${progress.uniqueUsers}/${progress.minUsers} 人` : ''

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '4.5em 1fr', gap: '.25em' }}>
      <strong>正在刷</strong>
      <span style={labelStyle}>
        <span>{progress.shortText}</span>
        <span className='cb-soft' style={{ marginLeft: '.4em', fontSize: '11px' }}>
          {progress.totalCount}/{progress.threshold} 条{usersFragment}
        </span>
        <span
          aria-hidden='true'
          style={{
            display: 'inline-block',
            verticalAlign: 'middle',
            marginLeft: '.4em',
            width: '60px',
            height: '6px',
            background: barBg,
            borderRadius: '3px',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              display: 'block',
              width: `${Math.round(fill * 100)}%`,
              height: '100%',
              background: barFg,
              transition: 'width 200ms ease, background 200ms ease',
            }}
          />
        </span>
      </span>
    </div>
  )
}

/**
 * Tick a counter on a setInterval so the panel re-reads getCurrentCpm /
 * computeAutoCooldownSec every couple seconds for the auto-cooldown live
 * readout. Cheap (just a setState every 2s); no-op when the panel is not
 * visible because <details> closes Preact subtree rendering.
 */
function useTick(intervalMs: number): number {
  const tick = useSignal(0)
  useEffect(() => {
    const id = setInterval(() => {
      tick.value++
    }, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return tick.value
}

/**
 * Live "auto-tuning ~Xs (CPM=Y)" readout. Pulled out of the cooldown row so
 * the row's NumberInput disabled state stays observable in the static VNode
 * tree (this component owns the hook; the row stays hook-free and inlined
 * directly in AutoBlendControls).
 */
function LiveCooldownReadout() {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  useTick(2000) // re-render every 2s for the live numbers
  if (!autoBlendCooldownAuto.value) return null
  const text = autoBlendEnabled.value
    ? (() => {
        const now = Date.now()
        const cpm = getCurrentCpm(now)
        const sec = computeAutoCooldownSec(cpm)
        return `自动调节中（约 ${sec} 秒，CPM=${cpm}）`
      })()
    : '启动后按弹幕速率自动调节'
  return (
    <span className='cb-soft' style={{ flexBasis: '100%', fontSize: '11px', marginTop: '-.15em' }}>
      {text}
    </span>
  )
}

export function AutoBlendControls() {
  const isOn = autoBlendEnabled.value
  const currentPreset = autoBlendPreset.value
  const drift = autoBlendDriftFromPreset.value
  const presetHint =
    currentPreset === 'safe' || currentPreset === 'normal' || currentPreset === 'hot'
      ? AUTO_BLEND_PRESETS[currentPreset].hint
      : drift.baselinePreset
        ? `自定义（基于「${AUTO_BLEND_PRESETS[drift.baselinePreset].label}」档 ${drift.driftPercent >= 0 ? '+' : ''}${drift.driftPercent}% 激进）`
        : '自定义参数'
  const statusColor = !isOn
    ? '#777'
    : autoBlendStatusText.value.includes('冷却')
      ? 'var(--cb-warning-text)'
      : autoBlendStatusText.value.includes('跟车')
        ? 'var(--cb-accent)'
        : 'var(--cb-success-text)'

  const toggleEnabled = async () => {
    // 第一步：纯函数判定要不要弹 confirm（保留可单元测试的决策点）。
    // 第二步：用 showConfirm() 而不是 native confirm()——后者在浏览器里会被
    // anti-popup 抑制 / 不参与暗色模式 / 没法做样式与 dialog 一致。同样的
    // 安全护栏要用同一种 UI primitive。
    let confirmed = true
    let markConfirmedAfter = false
    // Footgun: send-count × per-send-interval 超过冷却窗口，等同于忽略冷却
    // 一直刷，极易被风控。开启前强制二次确认。
    if (!autoBlendEnabled.value && !autoBlendDryRun.value) {
      const requiredSec = autoBlendSendCount.value * msgSendInterval.value
      if (requiredSec > autoBlendCooldownSec.value) {
        const ok = await showConfirm({
          title: '当前参数会绕过冷却',
          body: `每次发 ${autoBlendSendCount.value} 遍 × 间隔 ${msgSendInterval.value}s = ${requiredSec}s，已超过冷却 ${autoBlendCooldownSec.value}s。继续会几乎不停地发，极易被风控/封禁。建议把「每次发X遍」调小，或把冷却调大。`,
          confirmText: '我知道风险，继续',
          cancelText: '返回调整',
        })
        if (!ok) return
      }
    }
    // 30 天 TTL：超过这个时间窗口的旧确认视为过期,重新弹窗。即使
    // hasConfirmedAutoBlendRealFire=true 也要看 lastAutoBlendRealFireConfirmAt
    // 是否在 TTL 内。这样用户半年前点过"我知道"之后,再开车仍会被重新提醒。
    const CONFIRM_TTL_MS = 30 * 24 * 60 * 60 * 1000
    const confirmRecent =
      hasConfirmedAutoBlendRealFire.value &&
      lastAutoBlendRealFireConfirmAt.value > 0 &&
      Date.now() - lastAutoBlendRealFireConfirmAt.value < CONFIRM_TTL_MS
    const decision = decideAutoBlendToggle(
      {
        currentlyEnabled: autoBlendEnabled.value,
        dryRun: autoBlendDryRun.value,
        hasConfirmedRealFire: confirmRecent,
      },
      // sync stub —— 实际 confirm 在外面做。返回 true 让 helper 走"用户已确认"
      // 分支，proceed/markConfirmed 我们自己再决定。
      () => true
    )
    if (decision.markConfirmed) {
      const ttlNote = hasConfirmedAutoBlendRealFire.value ? '（距上次确认已超过 30 天，再次提醒）' : ''
      confirmed = await showConfirm({
        title: `自动跟车将以你的账号真实发送弹幕${ttlNote}`,
        body: '试运行已关闭。建议先打开「试运行」观察一段时间。是否继续直接开启？',
        confirmText: '我已了解，开始跟车',
        cancelText: '取消',
      })
      markConfirmedAfter = confirmed
    }
    if (!confirmed || !decision.proceed) return
    if (markConfirmedAfter) {
      hasConfirmedAutoBlendRealFire.value = true
      lastAutoBlendRealFireConfirmAt.value = Date.now()
    }
    const willBeOn = !autoBlendEnabled.value
    autoBlendEnabled.value = willBeOn
    if (willBeOn) void warnIfOtherSourcesActive('blend')
  }

  return (
    <details
      open={autoBlendPanelOpen.value}
      onToggle={e => {
        autoBlendPanelOpen.value = e.currentTarget.open
      }}
    >
      <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 'bold' }}>
        <span>自动跟车</span>
        {isOn && <span className='cb-soft'>运行中</span>}
      </summary>

      <div className='cb-body cb-stack'>
        <div className='cb-note' style={{ color: '#666', fontSize: '0.9em', marginBottom: '.25em' }}>
          条件满足时，会以你的账号自动发送弹幕。第一次开启建议先打开下方的「试运行」观察效果。
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '.5em', alignItems: 'center' }}>
          {/* skipcq: JS-0098 — `void` discards the floating Promise from the async toggle so the click handler stays sync-typed for React. */}
          <button type='button' className={isOn ? 'cb-danger' : 'cb-primary'} onClick={() => void toggleEnabled()}>
            {isOn ? '停止跟车' : '开始跟车'}
          </button>
          <span
            style={{
              color: statusColor,
              fontWeight: 'bold',
              whiteSpace: 'nowrap',
            }}
          >
            <span className='cb-status-dot' /> {autoBlendStatusText.value}
          </span>
        </div>

        <div>
          <div className='cb-segment'>
            {(['safe', 'normal', 'hot'] as const).map(preset => (
              <button
                key={preset}
                type='button'
                aria-pressed={currentPreset === preset}
                onClick={() => applyAutoBlendPreset(preset)}
                style={modeButtonStyle(currentPreset === preset)}
              >
                {AUTO_BLEND_PRESETS[preset].label}
              </button>
            ))}
            <button
              type='button'
              aria-pressed={currentPreset === 'custom'}
              onClick={() => {
                autoBlendPreset.value = 'custom'
                autoBlendAdvancedOpen.value = true
              }}
              style={modeButtonStyle(currentPreset === 'custom')}
              title='保留当前数值并切到自定义；点击后会展开高级设置以便调参。'
            >
              自定义
            </button>
          </div>
          <div
            className='cb-note'
            style={{ marginTop: '.25em', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.4em' }}
          >
            <span>当前：{presetHint}</span>
            {currentPreset === 'custom' && drift.baselinePreset && (
              <button
                type='button'
                onClick={() => applyAutoBlendPreset(drift.baselinePreset as 'safe' | 'normal' | 'hot')}
                style={{ minHeight: 'unset', padding: '1px 6px', fontSize: '11px' }}
                title={`一键回到「${AUTO_BLEND_PRESETS[drift.baselinePreset].label}」档（丢弃当前自定义数值）`}
              >
                ↺ 回到「{AUTO_BLEND_PRESETS[drift.baselinePreset].label}」
              </button>
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
          <CandidateProgressRow />
          <div style={{ display: 'grid', gridTemplateColumns: '4.5em 1fr', gap: '.25em' }}>
            <strong>刚刚</strong>
            <span style={{ wordBreak: 'break-all', overflowWrap: 'anywhere' }}>{autoBlendLastActionText.value}</span>
          </div>
        </div>
      </div>

      <details
        open={autoBlendAdvancedOpen.value}
        onToggle={e => {
          autoBlendAdvancedOpen.value = e.currentTarget.open
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
            <span>触发条件：</span>
            <NumberInput
              value={autoBlendWindowSec.value}
              min={3}
              onChange={v => {
                autoBlendWindowSec.value = v
                markCustomIfDrifted()
              }}
            />
            <span>秒内刷出</span>
            <NumberInput
              value={autoBlendThreshold.value}
              min={2}
              onChange={v => {
                autoBlendThreshold.value = v
                markCustomIfDrifted()
              }}
            />
            <span>条相同弹幕</span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '.25em',
              marginLeft: '4.5em',
              opacity: autoBlendRequireDistinctUsers.value ? 1 : 0.55,
            }}
          >
            <input
              id='autoBlendRequireDistinctUsers'
              type='checkbox'
              checked={autoBlendRequireDistinctUsers.value}
              onInput={e => {
                autoBlendRequireDistinctUsers.value = e.currentTarget.checked
                markCustomIfDrifted()
              }}
            />
            <label htmlFor='autoBlendRequireDistinctUsers'>且至少</label>
            <NumberInput
              value={autoBlendMinDistinctUsers.value}
              min={2}
              width='40px'
              disabled={!autoBlendRequireDistinctUsers.value}
              onChange={v => {
                autoBlendMinDistinctUsers.value = v
                markCustomIfDrifted()
              }}
            />
            <span>人都在刷</span>
          </div>
          <SettingHint>条数和人数都满足才会跟车（且关系）；阈值越低越积极。</SettingHint>

          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.25em' }}>
            <span>节奏：</span>
            <span>冷却</span>
            <NumberInput
              value={autoBlendCooldownSec.value}
              min={4}
              width='50px'
              disabled={autoBlendCooldownAuto.value}
              onChange={v => {
                autoBlendCooldownSec.value = v
                markCustomIfDrifted()
              }}
            />
            <span>秒，补跟</span>
            <NumberInput
              value={autoBlendRoutineIntervalSec.value}
              min={10}
              width='50px'
              onChange={v => {
                autoBlendRoutineIntervalSec.value = v
                markCustomIfDrifted()
              }}
            />
            <span>秒</span>
            <LiveCooldownReadout />
          </div>
          <SettingHint>冷却是每次发完的停顿；补跟是没刷屏时定时回头看热门的间隔。</SettingHint>

          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.25em' }}>
            <span>凑齐刷屏的窗口</span>
            <NumberInput
              value={autoBlendBurstSettleMs.value}
              min={0}
              max={10000}
              width='58px'
              onChange={v => {
                autoBlendBurstSettleMs.value = v
                markCustomIfDrifted()
              }}
            />
            <span>毫秒</span>
          </div>
          <SettingHint>检测到刷屏后先等一小会儿，把同一波里的其它高频弹幕一起纳入判断。</SettingHint>

          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.25em' }}>
            <span>失败熔断：</span>
            <NumberInput
              value={autoBlendRateLimitWindowMin.value}
              min={1}
              max={60}
              width='44px'
              onChange={v => {
                autoBlendRateLimitWindowMin.value = v
                markCustomIfDrifted()
              }}
            />
            <span>分钟内</span>
            <NumberInput
              value={autoBlendRateLimitStopThreshold.value}
              min={1}
              max={20}
              width='40px'
              onChange={v => {
                autoBlendRateLimitStopThreshold.value = v
                markCustomIfDrifted()
              }}
            />
            <span>次后停车</span>
          </div>
          <SettingHint>连续失败/风控达到次数会自动停车，并按禁言/账号风控/频率限制给出建议。</SettingHint>

          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.25em' }}>
            <span>每次发：</span>
            <NumberInput
              value={autoBlendSendCount.value}
              min={1}
              max={20}
              width='40px'
              disabled={autoBlendSendAllTrending.value}
              onChange={v => {
                autoBlendSendCount.value = v
                markCustomIfDrifted()
              }}
            />
            <span>遍</span>
          </div>
          {autoBlendSendAllTrending.value ? (
            <SettingHint>已被「多句一起跟」覆盖：突发命中时一波内每句各发 1 次。</SettingHint>
          ) : autoBlendSendCount.value > 1 ? (
            <SettingHint>
              {`同一句被选中后重复发送 ${autoBlendSendCount.value} 次。注意：每发一遍都会延续一次冷却，所以下一波命中要等约 ${autoBlendSendCount.value * autoBlendCooldownSec.value} 秒（${autoBlendSendCount.value} × ${autoBlendCooldownSec.value}s）。`}
            </SettingHint>
          ) : (
            <SettingHint>同一句被选中后重复发送的次数；建议配合发送间隔和冷却一起调。</SettingHint>
          )}
        </div>

        <div style={{ margin: '.5em 0', display: 'grid', gap: '.35em' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='autoBlendDryRun'
              type='checkbox'
              checked={autoBlendDryRun.value}
              onInput={e => {
                // dryRun 不在预设定义里（三档预设都不指定 dryRun 值），改它不应
                // 把预设标签变成「自定义」。
                autoBlendDryRun.value = e.currentTarget.checked
              }}
            />
            <label
              htmlFor='autoBlendDryRun'
              title='开启后只在日志里显示会发送什么，不会真的发出。关闭后会真实发送弹幕。'
            >
              试运行（只观察，不发送）
            </label>
            {!autoBlendDryRun.value && (
              <span
                style={{ color: 'var(--cb-warning-text)', fontSize: '0.85em' }}
                title='当前关闭试运行，会真实发送弹幕。'
              >
                关闭后会真实发送
              </span>
            )}
          </span>

          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='autoBlendUseReplacements'
              type='checkbox'
              checked={autoBlendUseReplacements.value}
              onInput={e => {
                autoBlendUseReplacements.value = e.currentTarget.checked
                markCustomIfDrifted()
              }}
            />
            <label htmlFor='autoBlendUseReplacements'>套用替换规则</label>
          </span>

          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em', flexWrap: 'wrap' }}>
            <input
              id='autoBlendYolo'
              type='checkbox'
              checked={autoBlendYolo.value}
              onInput={e => {
                autoBlendYolo.value = e.currentTarget.checked
              }}
            />
            <label
              htmlFor='autoBlendYolo'
              title='AI 润色（原 YOLO）：触发后用 LLM 把要发的文本改写一遍再发。LLM 凭证在「设置 → LLM」里集中配置。'
            >
              🤖 AI 润色（LLM 改写后再发）
            </label>
            <PromptPicker
              prompts={llmPromptsAutoBlend.value}
              activeIndex={llmActivePromptAutoBlend.value}
              onActiveIndexChange={i => {
                llmActivePromptAutoBlend.value = i
              }}
              previewGraphemes={12}
              className='lc-min-w-[120px] lc-max-w-[180px] lc-truncate'
              title='当前提示词（在「设置 → LLM 提示词 → 自动跟车」里管理）'
              emptyText='暂无提示词，请到设置里添加'
              disabled={!autoBlendYolo.value}
            />
          </span>
          <YoloCallout
            feature='autoBlend'
            enabled={autoBlendYolo.value}
            readyText='已就绪：触发后会先用 LLM 润色再发。每条触发都会调用一次 LLM（产生 token 消耗）。'
          />

          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='autoBlendAvoidRepeat'
              type='checkbox'
              checked={autoBlendAvoidRepeat.value}
              onInput={e => {
                // avoidRepeat 不在预设定义里，改它不应换预设标签。
                autoBlendAvoidRepeat.value = e.currentTarget.checked
              }}
            />
            <label
              htmlFor='autoBlendAvoidRepeat'
              title='开启后,与上次自动跟车发出的弹幕完全相同的新弹幕不再计入候选,避免冷却结束后被同一句话立刻再次刷上去。'
            >
              不重复上次自动发送
            </label>
          </span>

          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='autoBlendCooldownAuto'
              type='checkbox'
              checked={autoBlendCooldownAuto.value}
              onInput={e => {
                // cooldownAuto 不在预设定义里，改它不应换预设标签。
                autoBlendCooldownAuto.value = e.currentTarget.checked
              }}
            />
            <label
              htmlFor='autoBlendCooldownAuto'
              title='开启后按当前房间弹幕速率(CPM)动态算冷却,冷场拉长(上限 60 秒),高峰压短(下限 2 秒)。开启时上面的固定冷却数值会被忽略。'
            >
              自动冷却（按弹幕速率）
            </label>
          </span>

          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='autoBlendSendAllTrending'
              type='checkbox'
              checked={autoBlendSendAllTrending.value}
              onInput={e => {
                autoBlendSendAllTrending.value = e.currentTarget.checked
                markCustomIfDrifted()
              }}
            />
            <label
              htmlFor='autoBlendSendAllTrending'
              title='命中后把同一波里达标的几句各发 1 次（覆盖「每次发X遍」）。'
            >
              多句一起跟
            </label>
            <span
              style={{ color: 'var(--cb-warning-text)' }}
              title='更激进：命中一波后会连发多条达标弹幕，更容易被风控。'
            >
              （更激进）
            </span>
          </span>
        </div>

        {autoBlendSendAllTrending.value && (
          <div style={{ color: 'var(--cb-warning-text)', fontSize: '12px', lineHeight: 1.5, marginBottom: '.25em' }}>
            会把同一波里达标的几句话依次发出去；此时「每次发X遍」被覆盖为 1。
          </div>
        )}

        {autoBlendSendCount.value * msgSendInterval.value > autoBlendCooldownSec.value && (
          <div
            role='alert'
            style={{
              color: 'var(--cb-danger)',
              fontSize: '12px',
              fontWeight: 650,
              lineHeight: 1.5,
              marginBottom: '.25em',
            }}
          >
            ⚠️ 当前要发 {autoBlendSendCount.value * msgSendInterval.value}s，超过冷却 {autoBlendCooldownSec.value}s
            ——开启时会再次确认；建议把「每次发X遍」调小或把冷却调大。
          </div>
        )}

        <BlacklistPanel />
        <MessageBlacklistPanel />
      </details>
    </details>
  )
}
