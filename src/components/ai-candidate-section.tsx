import { useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'

import {
  type AiCandidateHistoryEntry,
  type AiCandidateItem,
  acceptCandidate,
  aiCandidateHistory,
  aiCandidateLastGenAt,
  aiCandidateStatus,
  aiCandidateViewerCount,
  clearAiCandidateHistory,
  clearPendingCandidates,
  pendingCandidates,
  skipCandidate,
  triggerNow,
} from '../lib/ai-candidate'
import { describeLlmGap } from '../lib/llm-polish'
import {
  aiCandidateContextMaxChars,
  aiCandidateEnabled,
  aiCandidateMaxMessageLength,
  aiCandidateViewerInterval,
  aiCandidateViewerWindow,
  sttRunning,
} from '../lib/store'
import { Button } from './ui/button'

/**
 * AI 陪聊（Review-only）UI section，挂在同传 tab 底部。
 *
 * Review-only 设计约束（强制的产品边界）：
 * - 没有 "auto-send" 开关 —— 引擎只生成候选，**用户点确认才发**
 * - 默认 OFF；用户主动开启
 * - 候选队列里每条都需要一次明确操作（发 / 编辑后发 / 跳过）
 *
 * 跟 upstream chatterbox 的 `ai-chat-section.tsx` 的关键区别：
 * - 移除 `aiChatAutoSend` checkbox 及其 UI
 * - 候选列表始终可见（upstream 在 auto-send=true 时隐藏）
 * - 文案重新框出"候选"工具属性，避开"全自动陪你聊"暗示
 */

const SECTION_HEADING = '🤖 AI 陪聊（候选）'

function relativeTime(ts: number | null, now: number): string {
  if (ts === null) return '尚未生成'
  const sec = Math.max(0, Math.floor((now - ts) / 1000))
  if (sec < 5) return '刚刚'
  if (sec < 60) return `${sec} 秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  return `${hr} 小时前`
}

function statusPill(): { label: string; color: string } {
  switch (aiCandidateStatus.value) {
    case 'generating':
      return { label: '生成中…', color: '#36a185' }
    case 'waiting':
      return { label: '准备生成', color: '#c98a00' }
    case 'idle':
      return { label: '等待中', color: '#666' }
    case 'disabled':
      return { label: '未启用', color: '#888' }
  }
}

function truncate(text: string, max = 60): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

function HistoryRow({ entry }: { entry: AiCandidateHistoryEntry }) {
  // ✅ 发出 / ⏭ 跳过 / ❌ 失败
  const isSkip = !entry.message
  const icon = isSkip ? '⏭' : entry.sent ? '✅' : '❌'
  const color = isSkip ? '#888' : entry.sent ? '#36a185' : '#f44'
  return (
    <div style={{ borderBottom: '1px solid var(--cb-divider, #e0e0e0)', padding: '2px 0', fontSize: '0.9em' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px' }}>
        <span style={{ color }}>{icon}</span>
        {entry.message ? (
          <span style={{ flex: 1, wordBreak: 'break-all' }}>{entry.message}</span>
        ) : (
          <span style={{ flex: 1, wordBreak: 'break-all', color: '#888' }}>{entry.reason || '（无理由）'}</span>
        )}
      </div>
      {entry.transcript && (
        <div style={{ wordBreak: 'break-all', fontSize: '0.85em', color: '#888' }}>
          主播: {truncate(entry.transcript, 80)}
        </div>
      )}
    </div>
  )
}

export function AiCandidateSection() {
  // 本地 "now" tick，让相对时间标签每秒刷新（不污染全局 signal）。
  const now = useSignal(Date.now())
  useEffect(() => {
    const t = setInterval(() => {
      now.value = Date.now()
    }, 1000)
    return () => clearInterval(t)
  }, [now])

  const enabled = aiCandidateEnabled.value
  const candidates = pendingCandidates.value
  const history = aiCandidateHistory.value
  const pill = statusPill()
  const gap = describeLlmGap('aiCandidate')

  return (
    <div class='cb-supporting-feature' style={{ marginTop: '8px', padding: '6px 8px', borderTop: '1px dashed #ccc' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
        <strong style={{ fontSize: '0.95em' }}>{SECTION_HEADING}</strong>
        <span
          role='status'
          aria-live='polite'
          style={{
            display: 'inline-block',
            padding: '0 6px',
            borderRadius: '8px',
            fontSize: '0.8em',
            color: 'white',
            background: pill.color,
          }}
        >
          {pill.label}
        </span>
        <span style={{ flex: 1 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.9em' }}>
          <input
            type='checkbox'
            checked={enabled}
            onChange={(e: Event) => {
              aiCandidateEnabled.value = (e.currentTarget as HTMLInputElement).checked
            }}
          />
          启用
        </label>
      </div>

      <div style={{ fontSize: '0.85em', color: '#666', marginBottom: '6px' }}>
        AI 听主播 STT + 房间弹幕，生成候选弹幕放进下面的队列。**每条都需要你点确认才发** —— 不会自动发送。
      </div>

      {enabled && gap && <div style={{ fontSize: '0.85em', color: '#c98a00', marginBottom: '6px' }}>⚠️ {gap}</div>}

      {enabled && (
        <>
          <div style={{ fontSize: '0.8em', color: '#888', marginBottom: '4px' }}>
            上次生成：{relativeTime(aiCandidateLastGenAt.value, now.value)} · 自启动以来收到{' '}
            {aiCandidateViewerCount.value} 条观众弹幕 · 同传 {sttRunning.value ? '已启动' : '未启动'}
          </div>

          <div style={{ display: 'flex', gap: '4px', marginBottom: '6px', flexWrap: 'wrap' }}>
            <Button size='sm' onClick={() => triggerNow()} disabled={!!gap}>
              立即生成一条候选
            </Button>
            {candidates.length > 0 && (
              <Button size='sm' variant='ghost' onClick={() => clearPendingCandidates()}>
                清空候选（{candidates.length}）
              </Button>
            )}
            {history.length > 0 && (
              <Button size='sm' variant='ghost' onClick={() => clearAiCandidateHistory()}>
                清空历史
              </Button>
            )}
          </div>

          {candidates.length === 0 ? (
            <div style={{ fontSize: '0.85em', color: '#888', padding: '4px 0' }}>
              （候选队列空。主播说话或房间弹幕到了 viewer 阈值后会自动生成。）
            </div>
          ) : (
            <div style={{ marginBottom: '6px' }}>
              {candidates.map(c => (
                <CandidateRow key={c.id} cand={c} />
              ))}
            </div>
          )}

          {/* Settings 折叠 */}
          <details style={{ marginTop: '6px' }}>
            <summary style={{ cursor: 'pointer', fontSize: '0.85em', color: '#666' }}>⚙ 设置</summary>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '6px 0', fontSize: '0.85em' }}>
              <NumLabel
                label='候选字数上限'
                value={aiCandidateMaxMessageLength.value}
                min={5}
                max={100}
                onChange={v => {
                  aiCandidateMaxMessageLength.value = v
                }}
              />
              <NumLabel
                label='上下文字符预算'
                value={aiCandidateContextMaxChars.value}
                min={256}
                max={8192}
                onChange={v => {
                  aiCandidateContextMaxChars.value = v
                }}
              />
              <NumLabel
                label='Viewer 窗口'
                value={aiCandidateViewerWindow.value}
                min={5}
                max={200}
                onChange={v => {
                  aiCandidateViewerWindow.value = v
                }}
              />
              <NumLabel
                label='Viewer 触发间隔'
                value={aiCandidateViewerInterval.value}
                min={1}
                max={100}
                onChange={v => {
                  aiCandidateViewerInterval.value = v
                }}
              />
            </div>
          </details>

          {history.length > 0 && (
            <details style={{ marginTop: '6px' }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.85em', color: '#666' }}>
                历史决策（{history.length}）
              </summary>
              <div style={{ maxHeight: '160px', overflowY: 'auto', padding: '4px 0' }}>
                {history
                  .slice()
                  .reverse()
                  .map(entry => (
                    <HistoryRow key={entry.id} entry={entry} />
                  ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  )
}

function CandidateRow({ cand }: { cand: AiCandidateItem }) {
  const editing = useSignal(false)
  const draft = useSignal(cand.decision.message)

  return (
    <div
      style={{
        border: '1px solid #ddd',
        borderRadius: '4px',
        padding: '6px 8px',
        marginBottom: '4px',
        background: 'var(--cb-card-bg, #fafafa)',
      }}
    >
      {editing.value ? (
        <input
          type='text'
          value={draft.value}
          onInput={(e: Event) => {
            draft.value = (e.currentTarget as HTMLInputElement).value
          }}
          style={{ width: '100%', padding: '2px 4px', fontSize: '0.95em', marginBottom: '4px' }}
        />
      ) : (
        <div style={{ fontSize: '0.95em', wordBreak: 'break-all', marginBottom: '4px' }}>{cand.decision.message}</div>
      )}
      {cand.decision.reason && (
        <div style={{ fontSize: '0.8em', color: '#888', marginBottom: '4px' }}>理由：{cand.decision.reason}</div>
      )}
      {cand.transcript && (
        <div style={{ fontSize: '0.8em', color: '#888', marginBottom: '4px' }}>
          主播: {truncate(cand.transcript, 80)}
        </div>
      )}
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
        {editing.value ? (
          <>
            <Button
              size='sm'
              onClick={() => {
                acceptCandidate(cand.id, draft.value)
                editing.value = false
              }}
            >
              发送
            </Button>
            <Button
              size='sm'
              variant='ghost'
              onClick={() => {
                draft.value = cand.decision.message
                editing.value = false
              }}
            >
              取消编辑
            </Button>
          </>
        ) : (
          <>
            <Button size='sm' onClick={() => acceptCandidate(cand.id)}>
              发送
            </Button>
            <Button size='sm' variant='outline' onClick={() => (editing.value = true)}>
              编辑
            </Button>
            <Button size='sm' variant='ghost' onClick={() => skipCandidate(cand.id)}>
              跳过
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function NumLabel(props: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <span style={{ color: '#666' }}>{props.label}：</span>
      <input
        type='number'
        value={props.value}
        min={props.min}
        max={props.max}
        onChange={(e: Event) => {
          const raw = Number((e.currentTarget as HTMLInputElement).value)
          if (!Number.isFinite(raw)) return
          props.onChange(Math.max(props.min, Math.min(props.max, Math.round(raw))))
        }}
        style={{ width: '64px', padding: '2px 4px', fontSize: '0.9em' }}
      />
    </label>
  )
}
