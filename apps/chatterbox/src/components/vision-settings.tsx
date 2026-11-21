import type { VisionMode } from '../lib/store'

import { aiChatModelRejectsImages } from '../lib/ai-chat'
import { modelRejectsImages } from '../lib/llm'
import {
  llmProviders,
  settingsVisionOpen,
  visionCaptionModel,
  visionCaptionProvider,
  visionCaptionProviderId,
  visionClipEnabled,
  visionEnabled,
  visionMaxEdge,
  visionMaxFrames,
  visionMode,
  visionVisualTrigger,
} from '../lib/store'
import { describeAvailability, describeCaptionerStatus } from '../lib/vision/availability'
import { captionerStatus } from '../lib/vision/captioner'
import { isClipRecordingSupported } from '../lib/vision/clip-recorder'
import { clampVisionFrames, resolveVisionEdge, VISION_EDGES } from '../lib/vision/config'
import { visionAvailability } from '../lib/vision/frame-sampler'
import { sceneNotes } from '../lib/vision/scene-memory'
import { AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { NativeSelect } from './ui/native-select'
import { Separator } from './ui/separator'

const ROW_CLASS = 'mb-2 flex flex-wrap items-center gap-2'
const HINT_CLASS = 'mb-2 text-ga6'
const CHECKBOX_HINT_CLASS = 'my-2 text-ga6'
const ERROR_CLASS = 'mb-2 text-[red]'

const EDGE_LABELS: Record<number, string> = { 512: '低', 768: '中', 1024: '高' }

function isVisionMode(value: string): value is VisionMode {
  return value === 'direct' || value === 'caption'
}

/** What keeps caption mode from running, or null once its provider and model are usable. */
function describeCaptionGap(): string | null {
  const provider = visionCaptionProvider.value
  if (!provider) {
    return llmProviders.value.length > 0 ? '请选择描述模型服务商' : '请先在「设置 → LLM 设置」中添加服务商'
  }
  if (!provider.apiBase.trim() || !provider.apiKey.trim()) return '所选服务商未填写 API 地址或 API Key'
  const model = visionCaptionModel.value.trim() || provider.model.trim()
  if (!model) return '请填写描述模型'
  if (modelRejectsImages(provider.models, model)) return '所选模型不支持图片输入，请换用支持图片的模型'
  return null
}

/** Live readout; a separate component so status ticks don't re-render the form fields. */
function VisionStatus() {
  const caption = visionMode.value === 'caption'
  const availability = visionAvailability.value
  const latest = sceneNotes.value.at(-1)
  const running = availability !== 'off'
  const idleText = caption
    ? '未运行（开启「AI 融入」或「自动融入」的决策模型 / YOLO 后开始）'
    : '未运行（开启「AI 融入」后开始）'
  return (
    <div class='mt-2 rounded border border-solid border-ga2 bg-ga1 p-2'>
      <div class='flex flex-wrap gap-x-4 gap-y-1'>
        <span>画面：{running ? describeAvailability(availability) : idleText}</span>
        {caption && running && <span>描述：{describeCaptionerStatus(captionerStatus.value)}</span>}
      </div>
      {latest && (
        <div class='mt-1 break-all text-ga6'>
          最新记录（{new Date(latest.at).toLocaleTimeString('zh-CN', { hour12: false })}）：{latest.scene}
        </div>
      )}
    </div>
  )
}

/** Accordion section for stream vision (画面识别): how frames reach the models, plus live status. */
export function VisionSettings() {
  const enabled = visionEnabled.value
  const disabled = !enabled
  const direct = visionMode.value === 'direct'
  const captionProvider = visionCaptionProvider.value
  const captionGap = direct ? null : describeCaptionGap()
  const clipSupported = direct && isClipRecordingSupported()

  return (
    <AccordionItem
      open={settingsVisionOpen.value}
      onOpenChange={open => {
        settingsVisionOpen.value = open
      }}
      className='mb-1'
    >
      <AccordionTrigger>画面识别</AccordionTrigger>
      <AccordionContent className='pt-2 pb-2'>
        <div class={HINT_CLASS}>
          让「AI 融入」看到直播画面，并把画面要点提供给「自动融入」的决策模型与 YOLO。画面在本地截取，不会持续上传。
        </div>
        <Checkbox
          id='visionEnabled'
          checked={enabled}
          onInput={e => {
            visionEnabled.value = e.currentTarget.checked
          }}
          label='启用画面识别'
        />
        <div class={CHECKBOX_HINT_CLASS}>
          截图只会发送给你配置的模型服务商；标签页在后台、仅音频模式或画面暂停时自动暂停。
        </div>

        <div class={ROW_CLASS}>
          <Label htmlFor='visionMode' disabled={disabled}>
            接入方式
          </Label>
          <NativeSelect
            id='visionMode'
            className='min-w-25 flex-1'
            disabled={disabled}
            value={visionMode.value}
            onChange={e => {
              const mode = e.currentTarget.value
              if (isVisionMode(mode)) visionMode.value = mode
            }}
          >
            <option value='direct'>直接看图（AI 融入的模型需支持图片）</option>
            <option value='caption'>画面描述（由下方模型转成文字）</option>
          </NativeSelect>
        </div>
        {direct && enabled && aiChatModelRejectsImages() && (
          <div class={ERROR_CLASS}>
            「AI 融入」当前模型不支持图片输入，不会附带截图。请换用支持图片的模型，或改用「画面描述」。
          </div>
        )}

        {!direct && (
          <>
            <div class={ROW_CLASS}>
              <Label htmlFor='visionCaptionProvider' disabled={disabled}>
                描述模型服务商
              </Label>
              <NativeSelect
                id='visionCaptionProvider'
                className='min-w-25 flex-1'
                disabled={disabled}
                value={captionProvider?.id ?? ''}
                onChange={e => {
                  visionCaptionProviderId.value = e.currentTarget.value
                  // Model ids rarely carry over between providers.
                  visionCaptionModel.value = ''
                }}
              >
                <option value=''>未选择</option>
                {llmProviders.value.map(entry => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name || '未命名'}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div class={ROW_CLASS}>
              <Label htmlFor='visionCaptionModel' disabled={disabled || !captionProvider}>
                模型
              </Label>
              <Input
                id='visionCaptionModel'
                className='min-w-25 flex-1'
                disabled={disabled || !captionProvider}
                placeholder={captionProvider?.model || '模型 ID'}
                value={visionCaptionModel.value}
                onInput={e => {
                  visionCaptionModel.value = e.currentTarget.value
                }}
              />
            </div>
            <div class={HINT_CLASS}>
              服务商与「LLM 设置」共用，模型留空则沿用该服务商的模型。建议选择支持图片输入、响应快且便宜的模型。
            </div>
            {enabled && captionGap && <div class={ERROR_CLASS}>{captionGap}</div>}
          </>
        )}

        <div class={ROW_CLASS}>
          {direct && (
            <div class='flex items-center gap-1'>
              <Label htmlFor='visionMaxFrames' disabled={disabled}>
                每次最多
              </Label>
              <Input
                id='visionMaxFrames'
                type='number'
                min='1'
                max='4'
                step='1'
                className='w-12'
                disabled={disabled}
                value={clampVisionFrames(visionMaxFrames.value)}
                onInput={e => {
                  const value = e.currentTarget.valueAsNumber
                  if (Number.isFinite(value)) visionMaxFrames.value = clampVisionFrames(value)
                }}
              />
              <Label htmlFor='visionMaxFrames' disabled={disabled}>
                帧
              </Label>
            </div>
          )}
          <div class='flex items-center gap-1'>
            <Label htmlFor='visionMaxEdge' disabled={disabled}>
              清晰度
            </Label>
            <NativeSelect
              id='visionMaxEdge'
              disabled={disabled}
              value={resolveVisionEdge(visionMaxEdge.value)}
              onChange={e => {
                visionMaxEdge.value = resolveVisionEdge(Number(e.currentTarget.value))
              }}
            >
              {VISION_EDGES.map(edge => (
                <option key={edge} value={edge}>
                  {EDGE_LABELS[edge] ?? ''}（{edge}px）
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        <div class={HINT_CLASS}>
          {direct
            ? '只在「AI 融入」生成弹幕时附带截图，画面静止时只发一张，与上次相同则不再发送。帧数与清晰度越高，输入 token 越多。'
            : '画面明显变化、AI 融入生成前或约每 45 秒，把截图发给描述模型转成文字。清晰度越高，描述越准确，输入 token 也越多。'}
        </div>

        {direct && (
          <>
            <Checkbox
              id='visionClipEnabled'
              disabled={disabled || !clipSupported}
              checked={clipSupported && visionClipEnabled.value}
              onInput={e => {
                visionClipEnabled.value = e.currentTarget.checked
              }}
              label='视频片段（实验性）'
            />
            <div class={CHECKBOX_HINT_CLASS}>
              {clipSupported
                ? '用最近几秒的无声视频片段代替截图，仅部分模型支持；被拒绝时自动改用截图。'
                : '当前浏览器不支持录制视频片段。'}
            </div>
          </>
        )}

        <Checkbox
          id='visionVisualTrigger'
          disabled={disabled}
          checked={visionVisualTrigger.value}
          onInput={e => {
            visionVisualTrigger.value = e.currentTarget.checked
          }}
          label='画面变化时触发 AI 融入'
        />
        <div class={CHECKBOX_HINT_CLASS}>
          主播没说话时，画面突然大幅变化（如切换场景）也会触发一次生成，距上次生成至少间隔 1 分钟。
        </div>

        {enabled && (
          <>
            <Separator />
            <VisionStatus />
          </>
        )}
      </AccordionContent>
    </AccordionItem>
  )
}
