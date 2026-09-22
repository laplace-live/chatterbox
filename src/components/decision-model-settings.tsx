import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'

import type { DecisionPreset, DecisionProtocol, DecisionProviderProfile } from '../lib/decision-model'

import { DECISION_PROVIDER_DEFAULTS, fetchDecisionModels } from '../lib/decision-model'
import {
  activeDecisionProvider,
  addDecisionProvider,
  autoBlendDecisionPresetId,
  autoBlendDecisionThreshold,
  decisionActiveProviderId,
  decisionPresets,
  decisionProviders,
  removeDecisionProvider,
  settingsDecisionOpen,
  updateDecisionProvider,
} from '../lib/decision-settings'
import { AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Combobox } from './ui/combobox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { NativeSelect } from './ui/native-select'
import { Separator } from './ui/separator'
import { Textarea } from './ui/textarea'

export function DecisionModelSettings() {
  const keyVisible = useSignal(false)
  const fetching = useSignal(false)
  const fetchStatus = useSignal('')
  const fetchFailed = useSignal(false)
  const request = useRef<AbortController | null>(null)
  const provider = activeDecisionProvider.value
  const preset = decisionPresets.value.find(entry => entry.id === autoBlendDecisionPresetId.value)

  useEffect(() => () => request.current?.abort(), [])

  const resetRequest = () => {
    request.current?.abort()
    request.current = null
    fetching.value = false
    fetchStatus.value = ''
    fetchFailed.value = false
  }

  const resetProvider = () => {
    resetRequest()
    keyVisible.value = false
  }

  const updateConnection = (patch: Partial<Omit<DecisionProviderProfile, 'id'>>) => {
    if (!provider) return
    resetRequest()
    updateDecisionProvider(provider.id, { ...patch, models: [] })
  }

  const refreshModels = async () => {
    const current = activeDecisionProvider.value
    if (!current || fetching.value) return
    const controller = new AbortController()
    request.current = controller
    fetching.value = true
    fetchStatus.value = '正在获取模型列表…'
    fetchFailed.value = false
    try {
      const models = await fetchDecisionModels(current, controller.signal)
      if (request.current !== controller || controller.signal.aborted) return
      updateDecisionProvider(current.id, { models })
      fetchStatus.value = `已获取 ${models.length} 个模型`
    } catch (error) {
      if (request.current !== controller || controller.signal.aborted) return
      fetchFailed.value = true
      fetchStatus.value = `获取失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      if (request.current === controller) {
        request.current = null
        fetching.value = false
      }
    }
  }

  const patchPreset = (id: string, patch: Partial<Omit<DecisionPreset, 'id'>>) => {
    decisionPresets.value = decisionPresets.value.map(preset => (preset.id === id ? { ...preset, ...patch } : preset))
  }

  return (
    <AccordionItem
      open={settingsDecisionOpen.value}
      onOpenChange={open => {
        settingsDecisionOpen.value = open
      }}
      className='mb-1'
    >
      <AccordionTrigger>决策模型</AccordionTrigger>
      <AccordionContent className='pt-2 pb-2'>
        <div class='mb-2 text-ga6'>
          判断自动融入候选弹幕是否发送。可保存多个服务商配置，当前支持 Jev，API 地址与模型 ID 均可自定义。
        </div>
        <div class='mb-2 flex flex-wrap items-center gap-2'>
          <Label htmlFor='decisionProvider'>服务商</Label>
          {decisionProviders.value.length > 0 && (
            <NativeSelect
              id='decisionProvider'
              className='min-w-25 flex-1'
              value={provider?.id ?? ''}
              onChange={e => {
                resetProvider()
                decisionActiveProviderId.value = e.currentTarget.value
              }}
            >
              {decisionProviders.value.map(entry => (
                <option key={entry.id} value={entry.id}>
                  {entry.name || '未命名'}
                </option>
              ))}
            </NativeSelect>
          )}
          <Button
            variant='outline'
            size='sm'
            onClick={() => {
              resetProvider()
              addDecisionProvider()
            }}
          >
            添加
          </Button>
          {provider && (
            <Button
              variant='outline'
              size='sm'
              className='text-[red]'
              onClick={() => {
                if (!confirm(`确定删除决策服务商「${provider.name || '未命名'}」？其 API Key 与模型配置将一并删除。`))
                  return
                resetProvider()
                removeDecisionProvider(provider.id)
              }}
            >
              删除
            </Button>
          )}
        </div>

        {provider ? (
          <div class='mb-2 flex flex-col gap-2'>
            <div class='flex flex-wrap items-center gap-2'>
              <Label htmlFor='decisionProviderName'>名称</Label>
              <Input
                id='decisionProviderName'
                className='min-w-25 flex-1'
                value={provider.name}
                onInput={e => updateDecisionProvider(provider.id, { name: e.currentTarget.value })}
              />
            </div>
            <div class='flex flex-wrap items-center gap-2'>
              <Label htmlFor='decisionProtocol'>API 协议</Label>
              <NativeSelect
                id='decisionProtocol'
                className='min-w-25 flex-1'
                value={provider.protocol}
                onChange={e => {
                  const protocol = e.currentTarget.value as DecisionProtocol
                  updateConnection({ protocol, ...DECISION_PROVIDER_DEFAULTS[protocol] })
                }}
              >
                <option value='typesafe'>TypeSafe</option>
                <option value='openrouter'>OpenRouter Decisions</option>
              </NativeSelect>
            </div>
            <div class='flex flex-wrap items-center gap-2'>
              <Label htmlFor='decisionApiBase'>API 地址</Label>
              <Input
                id='decisionApiBase'
                className='min-w-25 flex-1'
                placeholder={DECISION_PROVIDER_DEFAULTS[provider.protocol]?.apiBase}
                value={provider.apiBase}
                onInput={e => updateConnection({ apiBase: e.currentTarget.value })}
              />
            </div>
            <div class='text-ga6'>自定义地址须兼容所选决策 API 协议。</div>
            <div class='flex flex-wrap items-center gap-2'>
              <Label htmlFor='decisionApiKey'>API Key</Label>
              <Input
                id='decisionApiKey'
                type={keyVisible.value ? 'text' : 'password'}
                className='min-w-25 flex-1'
                placeholder='本地免认证服务可留空'
                value={provider.apiKey}
                autocomplete='off'
                onInput={e => updateConnection({ apiKey: e.currentTarget.value })}
              />
              <Button
                variant='outline'
                size='sm'
                onClick={() => {
                  keyVisible.value = !keyVisible.value
                }}
              >
                {keyVisible.value ? '隐藏' : '显示'}
              </Button>
            </div>
            <div class='flex flex-wrap items-center gap-2'>
              <Label htmlFor='decisionModel'>模型 ID</Label>
              <Input
                id='decisionModel'
                className='min-w-25 flex-1'
                value={provider.model}
                placeholder={DECISION_PROVIDER_DEFAULTS[provider.protocol]?.model}
                onInput={e => updateDecisionProvider(provider.id, { model: e.currentTarget.value })}
              />
            </div>
            <div class='flex flex-wrap items-center gap-2'>
              <Combobox
                id='decisionModelPicker'
                title='从模型列表选择'
                className='min-w-25 flex-1'
                value={provider.model}
                options={provider.models.map(model => ({ value: model.id, label: model.name || model.id }))}
                onChange={model => updateDecisionProvider(provider.id, { model })}
                placeholder='从模型列表选择'
                unloadedText='可手动填写模型 ID，或刷新列表'
                missingLabel={model => `${model}（手动填写）`}
              />
              <Button
                variant='outline'
                size='sm'
                disabled={fetching.value || !provider.apiBase.trim()}
                onClick={() => void refreshModels()}
              >
                {fetching.value ? '加载中…' : '刷新列表'}
              </Button>
            </div>
            {fetchStatus.value && (
              <div class={fetchFailed.value ? 'break-words text-[red]' : 'text-ga6'}>{fetchStatus.value}</div>
            )}
          </div>
        ) : (
          <div class='mb-2 text-ga4'>暂无服务商，点击「添加」创建配置</div>
        )}

        <Separator />

        <div class='my-2 font-bold'>判断预设</div>
        <div class='mb-2 text-ga6'>选择一个可编辑的预设，描述何时发送、何时跳过。此选择与「自动融入」同步。</div>
        <div class='mb-2 flex flex-wrap items-center gap-2'>
          <NativeSelect
            aria-label='编辑判断预设'
            className='min-w-25 flex-1'
            value={autoBlendDecisionPresetId.value}
            onChange={e => {
              autoBlendDecisionPresetId.value = e.currentTarget.value
            }}
          >
            {!preset && <option value={autoBlendDecisionPresetId.value}>请选择判断预设</option>}
            {decisionPresets.value.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.name || '未命名预设'}
              </option>
            ))}
          </NativeSelect>
          <Button
            variant='outline'
            size='sm'
            onClick={() => {
              const preset = { id: crypto.randomUUID(), name: '', instructions: '' }
              decisionPresets.value = [...decisionPresets.value, preset]
              autoBlendDecisionPresetId.value = preset.id
            }}
          >
            添加预设
          </Button>
          {preset && (
            <Button
              variant='outline'
              size='sm'
              className='text-[red]'
              onClick={() => {
                const remaining = decisionPresets.value.filter(entry => entry.id !== preset.id)
                decisionPresets.value = remaining
                autoBlendDecisionPresetId.value = remaining[0]?.id ?? ''
              }}
            >
              删除
            </Button>
          )}
        </div>
        {preset && (
          <div class='flex flex-col gap-2'>
            <Input
              aria-label='判断预设名称'
              placeholder='预设名称，例如：串子'
              value={preset.name}
              onInput={e => patchPreset(preset.id, { name: e.currentTarget.value })}
            />
            <Textarea
              aria-label={`「${preset.name || '未命名'}」的发送条件`}
              rows={4}
              placeholder='描述哪些情况下应该发送候选弹幕，哪些情况下应该跳过'
              value={preset.instructions}
              onInput={e => patchPreset(preset.id, { instructions: e.currentTarget.value })}
            />
          </div>
        )}
        {decisionPresets.value.length === 0 && <div class='text-ga4'>暂无预设，点击「添加预设」创建发送条件</div>}
        <div class='my-2 flex flex-wrap items-center gap-2'>
          <Label htmlFor='decisionThreshold'>发送概率阈值</Label>
          <Input
            id='decisionThreshold'
            className='w-16'
            type='number'
            min='1'
            max='100'
            step='1'
            value={Math.round(autoBlendDecisionThreshold.value * 100)}
            onInput={e => {
              const value = e.currentTarget.valueAsNumber
              if (Number.isFinite(value)) autoBlendDecisionThreshold.value = Math.min(100, Math.max(1, value)) / 100
            }}
          />
          <span>%</span>
        </div>
        <div class='text-ga6'>模型判断应该发送的概率达到阈值才发送。提高阈值会更谨慎。</div>
      </AccordionContent>
    </AccordionItem>
  )
}
