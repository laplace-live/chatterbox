import type { CopyStatus, MemberRole } from '@laplace.live/kakashi-protocol'
import { ACTION_SOURCES, DEFAULT_SERVER_URL } from '@laplace.live/kakashi-protocol'
import { cn } from 'cn'

import { resumeMirror } from '../lib/copy-ninja/mirror'
import {
  type CopyNinjaStatus,
  copyNinjaClaimedRole,
  copyNinjaDelayMaxSec,
  copyNinjaDelayMinSec,
  copyNinjaDropPercent,
  copyNinjaEffectiveRole,
  copyNinjaEnabled,
  copyNinjaFollowRoom,
  copyNinjaKanchi,
  copyNinjaPaused,
  copyNinjaResults,
  copyNinjaRoster,
  copyNinjaSelfUid,
  copyNinjaServerUrl,
  copyNinjaServerVersion,
  copyNinjaSources,
  copyNinjaStatus,
  copyNinjaStatusDetail,
  copyNinjaToken,
  isCopySourceEnabled,
  SOURCE_LABELS,
  setClaimedRole,
} from '../lib/copy-ninja/settings'
import { describeLlmGap, isLlmApiConfigured } from '../lib/llm-tasks'
import { aiChatEnabled, autoBlendEnabled, llmActivePromptKanchi, llmPromptsKanchi, sendMsg } from '../lib/store'
import { PromptPicker } from './prompt-picker'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { NativeSelect } from './ui/native-select'

const SECTION_CLASS = 'my-3 first:mt-1'
const HEADING_CLASS = 'mb-2 font-bold'
const ROW_CLASS = 'mb-2 flex flex-wrap items-center gap-2'
const HINT_CLASS = 'my-2 text-ga6'

const STATUS_TEXT: Record<CopyNinjaStatus, string> = {
  off: '未启用',
  connecting: '连接中…',
  connected: '已连接',
  error: '已停止',
}

const ROLE_TEXT: Record<MemberRole, string> = { master: '主控', standby: '待命', mirror: '分身' }

const RESULT_TEXT: Record<CopyStatus, string> = { sent: '已跟随', failed: '失败', dropped: '衰减忽略', skipped: '跳过' }

function NumberField({
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (n: number) => void
}) {
  return (
    <Input
      type='number'
      autocomplete='off'
      min={String(min)}
      max={String(max)}
      step={String(step)}
      className='w-14'
      value={value}
      onInput={e => {
        const n = Number(e.currentTarget.value)
        if (e.currentTarget.value !== '' && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)))
      }}
    />
  )
}

function MirrorSettings() {
  const localAutomation = [
    sendMsg.value && '独轮车',
    autoBlendEnabled.value && '自动融入',
    aiChatEnabled.value && 'AI 融入',
  ].filter(Boolean)
  const kanchiGap = copyNinjaKanchi.value ? describeLlmGap('kanchi') : null
  const showPromptPicker = isLlmApiConfigured() && llmPromptsKanchi.value.length > 0

  return (
    <div class={SECTION_CLASS}>
      <div class={HEADING_CLASS}>跟随设置</div>
      <div class={HINT_CLASS}>勾选要跟随的主控动作：</div>
      <div class='mb-2 flex flex-wrap gap-x-3 gap-y-1.5'>
        {ACTION_SOURCES.map(source => (
          <Checkbox
            key={source}
            id={`copyNinjaSource-${source}`}
            checked={isCopySourceEnabled(source)}
            onInput={e => {
              copyNinjaSources.value = { ...copyNinjaSources.value, [source]: e.currentTarget.checked }
            }}
            label={SOURCE_LABELS[source]}
          />
        ))}
      </div>
      <div class={ROW_CLASS}>
        <span>衰减：随机忽略</span>
        <NumberField
          value={copyNinjaDropPercent.value}
          min={0}
          max={100}
          onChange={n => {
            copyNinjaDropPercent.value = Math.round(n)
          }}
        />
        <span>% 的动作</span>
      </div>
      <div class={ROW_CLASS}>
        <span>随机延迟</span>
        <NumberField
          value={copyNinjaDelayMinSec.value}
          min={0}
          max={60}
          step={0.5}
          onChange={n => {
            copyNinjaDelayMinSec.value = n
          }}
        />
        <span>–</span>
        <NumberField
          value={copyNinjaDelayMaxSec.value}
          min={0}
          max={60}
          step={0.5}
          onChange={n => {
            copyNinjaDelayMaxSec.value = n
          }}
        />
        <span>秒</span>
      </div>
      <div class={ROW_CLASS}>
        <Checkbox
          id='copyNinjaKanchi'
          checked={copyNinjaKanchi.value}
          onInput={e => {
            copyNinjaKanchi.value = e.currentTarget.checked
          }}
          label='感知忍術（经 LLM 改写后再跟随）'
        />
        {showPromptPicker && (
          <PromptPicker
            className='min-w-10 truncate'
            title='切换感知忍術使用的提示词'
            prompts={llmPromptsKanchi.value}
            activeIndex={llmActivePromptKanchi.value}
            onActiveIndexChange={v => {
              llmActivePromptKanchi.value = v
            }}
            previewGraphemes={16}
          />
        )}
      </div>
      {kanchiGap && <div class='mb-2 text-[red]'>{kanchiGap}</div>}
      <Checkbox
        id='copyNinjaFollowRoom'
        checked={copyNinjaFollowRoom.value}
        onInput={e => {
          copyNinjaFollowRoom.value = e.currentTarget.checked
        }}
        label='跟随主控进入直播间'
      />
      {copyNinjaPaused.value && (
        <div class={cn(ROW_CLASS, 'mt-2')}>
          <span class='text-[red]'>连续发送失败，已暂停跟随</span>
          <Button variant='outline' size='sm' onClick={resumeMirror}>
            恢复
          </Button>
        </div>
      )}
      {localAutomation.length > 0 && (
        <div class={HINT_CLASS}>本账号的{localAutomation.join('、')}仍在运行，会与跟随共用发送频率。</div>
      )}
    </div>
  )
}

function Roster() {
  const roster = copyNinjaRoster.value
  const selfUid = copyNinjaSelfUid.value
  const results = copyNinjaResults.value
  const showResults = copyNinjaEffectiveRole.value === 'master'

  return (
    <div class={SECTION_CLASS}>
      <div class={HEADING_CLASS}>
        成员{roster.length > 0 && <span class='font-normal text-ga6'> ({roster.length})</span>}
      </div>
      {roster.length === 0 ? (
        <div class='text-ga4'>{copyNinjaStatus.value === 'connected' ? '暂无成员' : '未连接'}</div>
      ) : (
        roster.map(member => {
          const result = showResults ? results[member.uid] : undefined
          return (
            <div key={member.uid} class='flex items-center gap-2 py-[.2em]'>
              <span class={cn('shrink-0', member.role === 'master' && 'font-bold text-brand')}>
                {ROLE_TEXT[member.role]}
              </span>
              <span class='min-w-0 flex-1 truncate' title={member.uid}>
                {member.uname}
                {member.uid === selfUid && <span class='text-ga6'>（本账号）</span>}
              </span>
              <span class='shrink-0 font-mono text-[11px] text-ga6'>
                {member.roomIds.length > 0 ? member.roomIds.join(', ') : '—'}
                {member.tabs > 1 && ` · ${member.tabs} 页`}
              </span>
              {result && (
                <span
                  class={cn('shrink-0', result.status === 'failed' ? 'text-[red]' : 'text-ga6')}
                  title={result.detail}
                >
                  {RESULT_TEXT[result.status]}
                </span>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

export function CopyNinjaTab() {
  const status = copyNinjaStatus.value
  const detail = copyNinjaStatusDetail.value
  const uid = copyNinjaSelfUid.value
  const claimed = copyNinjaClaimedRole.value
  const enabled = copyNinjaEnabled.value

  return (
    <div class='pb-2'>
      <div class={SECTION_CLASS}>
        <Checkbox
          id='copyNinjaEnabled'
          checked={enabled}
          onInput={e => {
            copyNinjaEnabled.value = e.currentTarget.checked
          }}
          label='启用拷贝忍者'
        />
        <div class={HINT_CLASS}>
          多账号联动：每个浏览器（或浏览器用户）登录一个 B 站账号并连接同一个
          kakashi-server，主控账号发出的弹幕由分身账号跟随发送。
        </div>
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>服务器</div>
        <div class={ROW_CLASS}>
          <span class='shrink-0'>地址</span>
          <Input
            className='min-w-0 flex-1 font-mono'
            value={copyNinjaServerUrl.value}
            placeholder={DEFAULT_SERVER_URL}
            onChange={e => {
              copyNinjaServerUrl.value = e.currentTarget.value.trim() || DEFAULT_SERVER_URL
            }}
          />
        </div>
        <div class={ROW_CLASS}>
          <span class='shrink-0'>令牌</span>
          <Input
            type='password'
            autocomplete='off'
            className='min-w-0 flex-1'
            value={copyNinjaToken.value}
            placeholder='可选，与服务器的 --token 一致'
            onChange={e => {
              copyNinjaToken.value = e.currentTarget.value.trim()
            }}
          />
        </div>
        <div class={ROW_CLASS}>
          <span>
            状态：{enabled ? STATUS_TEXT[status] : STATUS_TEXT.off}
            {status === 'connected' && <span class='text-ga6'> · v{copyNinjaServerVersion.value}</span>}
          </span>
        </div>
        {enabled && detail && <div class={HINT_CLASS}>{detail}</div>}
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>本账号</div>
        <div class={ROW_CLASS}>
          <span class='font-mono text-ga6'>{uid ? `UID ${uid}` : '启用后识别'}</span>
          <NativeSelect
            value={claimed}
            disabled={!uid}
            onChange={e => {
              setClaimedRole(e.currentTarget.value === 'master' ? 'master' : 'mirror')
            }}
          >
            <option value='mirror'>分身（跟随主控）</option>
            <option value='master'>主控（被跟随）</option>
          </NativeSelect>
        </div>
        {claimed === 'master' && copyNinjaEffectiveRole.value === 'standby' && (
          <div class={HINT_CLASS}>已有其他主控在线，本账号待命，对方下线后自动接管。</div>
        )}
        {claimed === 'master' && (
          <div class={HINT_CLASS}>本账号成功发出的弹幕会广播给所有分身，由各分身按自己的跟随设置决定是否发送。</div>
        )}
      </div>

      {claimed === 'mirror' && <MirrorSettings />}

      <Roster />
    </div>
  )
}
