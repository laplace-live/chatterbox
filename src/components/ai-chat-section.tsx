import { useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'

import {
  type AiChatHistoryEntry,
  acceptCandidate,
  aiChatHistory,
  aiChatLastGenAt,
  aiChatStatus,
  aiChatViewerCount,
  clearAiChatHistory,
  pendingCandidates,
  skipCandidate,
  triggerNow,
} from '../lib/ai-chat'
import { describeLlmGap } from '../lib/llm-tasks'
import {
  aiChatAutoSend,
  aiChatContextMaxChars,
  aiChatEnabled,
  aiChatMaxMessageLength,
  aiChatTemperature,
  aiChatViewerInterval,
  aiChatViewerWindow,
  llmActivePromptAiChat,
  llmPromptsAiChat,
  sttRunning,
} from '../lib/store'
import { PromptPicker } from './prompt-picker'
import { AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'

// Match the existing section visual rhythm in stt-tab.tsx so this block
// reads as a native part of the 同传 tab rather than a bolted-on extra.
const SECTION_CLASS = 'lc-my-2 lc-pb-2 lc-border-b lc-border-b-solid lc-border-b-ga2'
const HEADING_CLASS = 'lc-font-bold lc-mb-2'
const ROW_CLASS = 'lc-flex lc-gap-2 lc-items-center lc-flex-wrap lc-mb-2'

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

/** Map the engine status signal to a (label, color) pair for the
 *  status pill in the section header. */
function statusPill(): { label: string; color: string } {
  switch (aiChatStatus.value) {
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

function truncateForRow(text: string, max = 60): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…`
}

function HistoryRow({ entry }: { entry: AiChatHistoryEntry }) {
  // Visual encoding: ✅ sent (green) / ⏭ skipped (gray) / ❌ failed (red).
  // sent=true,message=non-empty   → ✅
  // sent=false,message=non-empty  → ❌ (we tried but enqueue failed)
  // sent=false,message=empty      → ⏭ (LLM or user chose to skip)
  const isSkip = !entry.message
  const icon = isSkip ? '⏭' : entry.sent ? '✅' : '❌'
  const color = isSkip ? '#888' : entry.sent ? '#36a185' : '#f44'
  return (
    <div class='lc-py-0.5 lc-border-b lc-border-b-solid lc-border-b-ga2 lc-text-[.9em]'>
      <div class='lc-flex lc-gap-1 lc-items-baseline lc-flex-wrap'>
        <span style={{ color }}>{icon}</span>
        {entry.message ? (
          <span class='lc-flex-1 lc-break-all'>{entry.message}</span>
        ) : (
          <span class='lc-flex-1 lc-break-all lc-text-ga6'>{entry.reason || '（无理由）'}</span>
        )}
      </div>
      {entry.transcript && (
        <div class='lc-text-ga6 lc-text-[.85em] lc-break-all'>主播: {truncateForRow(entry.transcript, 80)}</div>
      )}
    </div>
  )
}

export function AiChatSection() {
  // Tick a local "now" signal every second so the relative-time labels
  // ("上次生成 N 秒前") refresh without the whole section re-rendering
  // on every signal write. setInterval cleaned up on unmount.
  const now = useSignal(Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      now.value = Date.now()
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // Inline edit state for the candidate list. One row at a time —
  // matches how the candidate list reads visually (always one decision
  // in focus) and avoids a per-row signal explosion.
  const editingId = useSignal<number | null>(null)
  const editingText = useSignal('')

  const gap = describeLlmGap('aiChat')
  const llmReady = gap === null
  const enabled = aiChatEnabled.value
  const autoSend = aiChatAutoSend.value
  const candidates = pendingCandidates.value
  const history = aiChatHistory.value
  const pill = statusPill()

  const handleEdit = (id: number, initial: string) => {
    editingId.value = id
    editingText.value = initial
  }

  const handleConfirmEdit = () => {
    if (editingId.value === null) return
    const id = editingId.value
    const text = editingText.value
    editingId.value = null
    editingText.value = ''
    acceptCandidate(id, text)
  }

  const handleCancelEdit = () => {
    editingId.value = null
    editingText.value = ''
  }

  return (
    <div class={SECTION_CLASS} data-section='ai-chat'>
      <div class={`${HEADING_CLASS} lc-flex lc-items-center lc-gap-2 lc-flex-wrap`}>
        <span>AI 陪聊</span>
        <span class='lc-text-[.85em] lc-font-normal' style={{ color: pill.color }}>
          · {pill.label}
        </span>
      </div>

      <div class={ROW_CLASS}>
        <Checkbox
          id='aiChatEnabled'
          checked={enabled}
          onInput={e => {
            aiChatEnabled.value = e.currentTarget.checked
          }}
          label='启用 AI 陪聊'
        />
        {/* Auto / Review toggle. Variant flip mirrors the YOLO toggles
            in 常规发送 / 自动融入 / 独轮车 — filled when active. The
            user still benefits from seeing both modes in the DOM
            (instead of a single combined switch) because the
            "current mode" question is the most important thing to
            see at a glance when scanning a panel full of AI controls. */}
        <Button
          variant={autoSend ? 'default' : 'outline'}
          size='sm'
          disabled={!enabled || !llmReady}
          onClick={() => {
            aiChatAutoSend.value = !aiChatAutoSend.value
          }}
          title={autoSend ? '当前：自动发送（点击切换到候选审核）' : '当前：候选审核（点击切换到自动发送）'}
        >
          {autoSend ? '自动发送' : '候选审核'}
        </Button>
        <Button
          variant='outline'
          size='sm'
          disabled={!enabled || !llmReady}
          onClick={() => triggerNow()}
          title='立即触发一次 LLM 生成（无论缓冲区状态如何）'
        >
          立即生成
        </Button>
      </div>

      {!llmReady && enabled && <div class='lc-mb-2 lc-text-[.9em] lc-text-[#f44]'>{gap ?? 'LLM 未就绪'}</div>}

      <div class={`${ROW_CLASS} lc-text-ga6 lc-text-[.9em]`}>
        <span>同传：{sttRunning.value ? '已启动' : '未启动'}</span>
        <span>·</span>
        <span>本次观众消息：{aiChatViewerCount.value}</span>
        <span>·</span>
        <span>上次生成：{relativeTime(aiChatLastGenAt.value, now.value)}</span>
      </div>

      {/* Pending candidates (Review mode only). Empty state surfaces an
          actionable hint so the user understands they need either the
          streamer to speak or viewers to chat. */}
      {!autoSend && (
        <div class='lc-mb-2'>
          <div class='lc-font-bold lc-mb-1 lc-text-[.9em]'>
            候选弹幕
            {candidates.length > 0 && <span class='lc-text-ga6 lc-font-normal'> ({candidates.length})</span>}
          </div>
          {candidates.length === 0 ? (
            <div class='lc-text-ga4 lc-text-[.9em]'>暂无候选 — 等待主播说话或观众消息触发生成</div>
          ) : (
            <div class='lc-max-h-[180px] lc-overflow-y-auto'>
              {/* Newest-first ordering: engine appends to the end (so the
                  ring buffer drops the oldest when capped), but the user
                  cares about the freshest candidate, so reverse here for
                  display. Matches the 最近决策 feed below which does the
                  same with `[...history].reverse()`. */}
              {[...candidates].reverse().map(cand => (
                <div key={cand.id} class='lc-py-1 lc-border-b lc-border-b-solid lc-border-b-ga2'>
                  {editingId.value === cand.id ? (
                    <div class='lc-flex lc-gap-1 lc-items-center lc-flex-wrap'>
                      <Input
                        className='lc-flex-1 lc-min-w-[160px]'
                        value={editingText.value}
                        onInput={e => {
                          editingText.value = e.currentTarget.value
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.isComposing) {
                            e.preventDefault()
                            handleConfirmEdit()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            handleCancelEdit()
                          }
                        }}
                      />
                      <Button variant='default' size='sm' onClick={handleConfirmEdit}>
                        发送
                      </Button>
                      <Button variant='outline' size='sm' onClick={handleCancelEdit}>
                        取消
                      </Button>
                    </div>
                  ) : (
                    <div>
                      <div class='lc-flex lc-gap-1 lc-items-baseline lc-flex-wrap'>
                        <span class='lc-flex-1 lc-break-all'>{cand.decision.message}</span>
                        <Button variant='default' size='sm' onClick={() => acceptCandidate(cand.id)}>
                          发送
                        </Button>
                        <Button variant='outline' size='sm' onClick={() => handleEdit(cand.id, cand.decision.message)}>
                          编辑
                        </Button>
                        <Button variant='ghost' size='sm' onClick={() => skipCandidate(cand.id)}>
                          跳过
                        </Button>
                      </div>
                      {cand.transcript && (
                        <div class='lc-text-ga6 lc-text-[.85em] lc-break-all'>
                          主播: {truncateForRow(cand.transcript, 80)}
                        </div>
                      )}
                      {cand.decision.reason && (
                        <div class='lc-text-ga6 lc-text-[.85em] lc-break-all'>理由: {cand.decision.reason}</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Decision feed — surfaces last N gens for both Auto and Review
          modes. Folded into an Accordion (closed by default in Auto
          mode where the section is busy with auto-sent danmaku
          showing up in the main log too) to keep the panel's
          default height in check. */}
      <AccordionItem className='lc-mb-2'>
        <AccordionTrigger>
          最近决策
          {history.length > 0 && <span class='lc-text-ga6 lc-font-normal'> ({history.length})</span>}
        </AccordionTrigger>
        <AccordionContent>
          <div class='lc-max-h-[160px] lc-overflow-y-auto'>
            {history.length === 0 ? (
              <div class='lc-text-ga4 lc-text-[.9em]'>暂无决策记录</div>
            ) : (
              [...history].reverse().map(entry => <HistoryRow key={entry.id} entry={entry} />)
            )}
          </div>
          {history.length > 0 && (
            <div class='lc-mt-1'>
              <Button variant='outline' size='sm' onClick={() => clearAiChatHistory()}>
                清空记录
              </Button>
            </div>
          )}
        </AccordionContent>
      </AccordionItem>

      {/* Prompt picker. Shown unconditionally because Auto mode users
          may want to hot-swap personas mid-stream too — the gate from
          /常规发送 / 独轮车 ("only when LLM api is configured") doesn't
          apply here because picking a different prompt is also how
          you SET an active prompt that makes the LLM usable. */}
      <div class={ROW_CLASS}>
        <Label htmlFor='aiChatPrompt'>提示词：</Label>
        <PromptPicker
          id='aiChatPrompt'
          className='lc-flex-1 lc-min-w-[120px] lc-truncate'
          prompts={llmPromptsAiChat.value}
          activeIndex={llmActivePromptAiChat.value}
          onActiveIndexChange={v => {
            llmActivePromptAiChat.value = v
          }}
          emptyText='暂无提示词，请前往「设置 → LLM 提示词 → AI 陪聊」添加'
          previewGraphemes={20}
        />
      </div>

      <AccordionItem>
        <AccordionTrigger>陪聊高级设置</AccordionTrigger>
        <AccordionContent>
          <div class='lc-grid lc-grid-cols-2 lc-gap-2 lc-mt-1'>
            <div class='lc-flex lc-gap-1 lc-items-center'>
              <Label htmlFor='aiChatMaxMsgLen'>弹幕最长</Label>
              <Input
                id='aiChatMaxMsgLen'
                type='number'
                min='1'
                max='200'
                className='lc-w-[60px]'
                value={aiChatMaxMessageLength.value}
                onInput={e => {
                  const v = parseInt(e.currentTarget.value, 10)
                  aiChatMaxMessageLength.value = Number.isFinite(v) ? Math.max(1, Math.min(200, v)) : 30
                }}
              />
              <span>字</span>
            </div>
            <div class='lc-flex lc-gap-1 lc-items-center'>
              <Label htmlFor='aiChatViewerInterval'>每</Label>
              <Input
                id='aiChatViewerInterval'
                type='number'
                min='1'
                max='1000'
                className='lc-w-[60px]'
                value={aiChatViewerInterval.value}
                onInput={e => {
                  const v = parseInt(e.currentTarget.value, 10)
                  aiChatViewerInterval.value = Number.isFinite(v) ? Math.max(1, Math.min(1000, v)) : 10
                }}
              />
              <span>条弹幕触发</span>
            </div>
            <div class='lc-flex lc-gap-1 lc-items-center'>
              <Label htmlFor='aiChatViewerWindow'>观众窗口</Label>
              <Input
                id='aiChatViewerWindow'
                type='number'
                min='1'
                max='500'
                className='lc-w-[60px]'
                value={aiChatViewerWindow.value}
                onInput={e => {
                  const v = parseInt(e.currentTarget.value, 10)
                  aiChatViewerWindow.value = Number.isFinite(v) ? Math.max(1, Math.min(500, v)) : 50
                }}
              />
              <span>条</span>
            </div>
            <div class='lc-flex lc-gap-1 lc-items-center'>
              <Label htmlFor='aiChatContextMax'>上下文上限</Label>
              <Input
                id='aiChatContextMax'
                type='number'
                min='256'
                max='32768'
                step='128'
                className='lc-w-[80px]'
                value={aiChatContextMaxChars.value}
                onInput={e => {
                  const v = parseInt(e.currentTarget.value, 10)
                  aiChatContextMaxChars.value = Number.isFinite(v) ? Math.max(256, Math.min(32_768, v)) : 2048
                }}
              />
              <span>字</span>
            </div>
            <div class='lc-flex lc-gap-1 lc-items-center'>
              <Label htmlFor='aiChatTemperature'>采样温度</Label>
              <Input
                id='aiChatTemperature'
                type='number'
                min='0'
                max='2'
                step='0.1'
                className='lc-w-[60px]'
                value={aiChatTemperature.value}
                onInput={e => {
                  const v = parseFloat(e.currentTarget.value)
                  aiChatTemperature.value = Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 0.7
                }}
              />
            </div>
          </div>
          <div class='lc-mt-2 lc-text-ga6 lc-text-[.85em]'>
            观众触发：累积一定数量的新观众弹幕后自动调用 LLM。观众窗口：每次提示词中携带的最近 N
            条观众消息。上下文上限：发送到 LLM 的上下文（历史 + 观众）字符总数预算。
          </div>
        </AccordionContent>
      </AccordionItem>
    </div>
  )
}
