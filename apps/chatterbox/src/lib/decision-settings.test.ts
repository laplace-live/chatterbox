import { describe, expect, test } from 'bun:test'

import type { DecisionPreset } from './decision-model'

import { loadWithFakeGm } from '../testing/fake-gm'

const V1_PRESETS: DecisionPreset[] = [
  {
    id: 'troll',
    name: '串子',
    instructions:
      '当候选弹幕结合上下文具有反串、反话、反讽或阴阳怪气的玩梗意味时发送。普通陈述、真诚赞美或单纯表达不同意见时不发送。',
  },
  {
    id: 'warm',
    name: '暖男',
    instructions:
      '当候选弹幕真诚地表达关心、安慰、鼓励或体贴，照顾主播或观众的感受时发送。讽刺性夸奖、阴阳怪气、反话或无关内容不发送。',
  },
  {
    id: 'comparison',
    name: '拉踩',
    instructions:
      '当候选弹幕通过比较主播、观众、作品或群体，抬高一方并贬低另一方时发送。单纯陈述差异、没有贬低意味的比较或无关内容不发送。',
  },
]

const loadDecisionSettings = (seed: Iterable<readonly [string, unknown]> = []) =>
  loadWithFakeGm<typeof import('./decision-settings')>(new URL('./decision-settings.ts', import.meta.url), seed)

describe('decisionPresets seeding and v2 migration', () => {
  test('fresh load seeds all 4 structured DEFAULT_DECISION_PRESETS as clones and marks decisionPresetsSeededV2', async () => {
    const settings = await loadDecisionSettings()
    expect(settings.DEFAULT_DECISION_PRESETS.map(preset => preset.id)).toEqual(['troll', 'warm', 'comparison', 'safe'])
    for (const preset of settings.DEFAULT_DECISION_PRESETS) {
      expect(preset.name.trim().length).toBeGreaterThan(0)
      expect(preset.instructions.trim().length).toBeGreaterThan(0)
      expect(preset.trueCriteria?.trim().length).toBeGreaterThan(0)
      expect(preset.falseCriteria?.trim().length).toBeGreaterThan(0)
    }
    expect(settings.decisionPresets.value).toEqual([...settings.DEFAULT_DECISION_PRESETS])
    expect(settings.store.get('decisionPresetsSeededV2')).toBe(true)
    expect(settings.store.get('decisionPresets')).toEqual([...settings.DEFAULT_DECISION_PRESETS])
    expect(settings.activeDecisionPreset.value?.id).toBe('troll')

    settings.decisionPresets.value[0].name = '篡改名称'
    expect(settings.DEFAULT_DECISION_PRESETS[0].name).toBe('串子')
  })

  test('migrates unmodified v1 presets in-place to structured v2 presets and appends safe', async () => {
    const v1Copy = V1_PRESETS.map(preset => ({ ...preset }))
    const settings = await loadDecisionSettings([['decisionPresets', v1Copy]])
    expect(settings.decisionPresets.value).toEqual([...settings.DEFAULT_DECISION_PRESETS])
    expect(settings.store.get('decisionPresets')).toEqual([...settings.DEFAULT_DECISION_PRESETS])
    expect(settings.store.get('decisionPresetsSeededV2')).toBe(true)
  })

  test('preserves custom instructions, custom criteria, custom names, user-added presets, and intentionally empty lists', async () => {
    const customLead: DecisionPreset = {
      id: 'custom-lead',
      name: '提问互动',
      instructions: '候选弹幕是否在向主播自然提问？',
    }
    const editedTroll: DecisionPreset = {
      id: 'troll',
      name: '串子',
      instructions: '用户改写过的反串规则',
    }
    const renamedWarm: DecisionPreset = {
      id: 'warm',
      name: '贴心老观众',
      instructions: V1_PRESETS[1].instructions,
    }
    const criteriaComparison: DecisionPreset = {
      id: 'comparison',
      name: '拉踩',
      instructions: V1_PRESETS[2].instructions,
      falseCriteria: '用户自定义反向排除项',
    }
    const customTail: DecisionPreset = {
      id: 'custom-tail',
      name: '玩梗王',
      instructions: '候选弹幕是否准确接住了主播刚抛出的梗？',
      trueCriteria: '紧接主播原话做谐音或反转',
    }

    const settings = await loadDecisionSettings([
      ['decisionPresets', [customLead, editedTroll, renamedWarm, criteriaComparison, customTail]],
    ])
    const expectedWarm = settings.DEFAULT_DECISION_PRESETS.find(preset => preset.id === 'warm')
    const expectedSafe = settings.DEFAULT_DECISION_PRESETS.find(preset => preset.id === 'safe')
    if (!expectedWarm || !expectedSafe) throw new Error('Missing expected built-in presets')
    expect(settings.decisionPresets.value).toEqual([
      customLead,
      editedTroll,
      { ...expectedWarm, name: '贴心老观众' },
      criteriaComparison,
      customTail,
      expectedSafe,
    ])

    const withTrueCriteriaAndCustomSafe = await loadDecisionSettings([
      [
        'decisionPresets',
        [
          { ...V1_PRESETS[0], trueCriteria: '用户自定义正向条件' },
          { ...V1_PRESETS[1], name: '   ' },
          { id: 'safe', name: '自定义安全预设', instructions: '自定义安全规则' },
        ],
      ],
    ])
    expect(withTrueCriteriaAndCustomSafe.decisionPresets.value).toEqual([
      { ...V1_PRESETS[0], trueCriteria: '用户自定义正向条件' },
      expectedWarm,
      { id: 'safe', name: '自定义安全预设', instructions: '自定义安全规则' },
    ])

    const emptied = await loadDecisionSettings([['decisionPresets', []]])
    expect(emptied.decisionPresets.value).toEqual([])
    expect(emptied.store.get('decisionPresets')).toEqual([])
    expect(emptied.store.get('decisionPresetsSeededV2')).toBe(true)
  })

  test('does not re-add deleted safe or overwrite edits once seeded', async () => {
    const initial = await loadDecisionSettings()
    initial.decisionPresets.value = initial.decisionPresets.value
      .filter(preset => preset.id !== 'safe')
      .map(preset => (preset.id === 'troll' ? { ...preset, instructions: '手动精简后的串子问题' } : preset))

    const reloaded = await loadDecisionSettings(initial.store)
    expect(reloaded.decisionPresets.value.map(preset => preset.id)).toEqual(['troll', 'warm', 'comparison'])
    expect(reloaded.decisionPresets.value[0].instructions).toBe('手动精简后的串子问题')
  })
})

describe('resetDecisionPresets', () => {
  test('restores cloned DEFAULT_DECISION_PRESETS and resets stale preset IDs while keeping valid default IDs', async () => {
    const settings = await loadDecisionSettings()
    settings.decisionPresets.value = [{ id: 'custom-only', name: '唯一预设', instructions: '自定义问题' }]
    settings.autoBlendDecisionPresetId.value = 'custom-only'

    settings.resetDecisionPresets()
    expect(settings.decisionPresets.value).toEqual([...settings.DEFAULT_DECISION_PRESETS])
    expect(settings.autoBlendDecisionPresetId.value).toBe('troll')

    settings.decisionPresets.value[0].name = '再次修改'
    expect(settings.DEFAULT_DECISION_PRESETS[0].name).toBe('串子')

    settings.autoBlendDecisionPresetId.value = 'warm'
    settings.decisionPresets.value = []
    settings.resetDecisionPresets()
    expect(settings.autoBlendDecisionPresetId.value).toBe('warm')
    expect(settings.decisionPresets.value).toEqual([...settings.DEFAULT_DECISION_PRESETS])
  })
})

describe('decision providers and configuration validation', () => {
  test('addDecisionProvider defaults to Gemini Decision 1 and manages active profile selection', async () => {
    const settings = await loadDecisionSettings()
    const first = settings.addDecisionProvider()
    expect(first.protocol).toBe('gemini')
    expect(first.apiBase).toBe('https://generativelanguage.googleapis.com')
    expect(first.model).toBe('gemini-decision-1')
    expect(first.apiKey).toBe('')
    expect(first.models).toEqual([])
    expect(settings.decisionActiveProviderId.value).toBe(first.id)
    expect(settings.activeDecisionProvider.value).toEqual(first)

    const second = settings.addDecisionProvider()
    expect(second.name).toBe('决策服务商 2')
    settings.updateDecisionProvider(second.id, { apiKey: 'test-key' })
    expect(settings.activeDecisionProvider.value?.apiKey).toBe('test-key')

    settings.removeDecisionProvider(second.id)
    expect(settings.decisionActiveProviderId.value).toBe(first.id)
  })

  test('resolveDecisionConfig and describeDecisionGap enforce Google host key, allow keyless local proxies, and return valid config', async () => {
    const settings = await loadDecisionSettings()
    expect(settings.describeDecisionGap()).toBe('请先在「设置 → 决策模型」中添加服务商')

    const provider = settings.addDecisionProvider()
    expect(settings.describeDecisionGap()).toBe('请填写决策模型 API Key')
    expect(settings.resolveDecisionConfig()).toBe('请填写决策模型 API Key')

    settings.updateDecisionProvider(provider.id, { apiBase: 'http://127.0.0.1:8787' })
    expect(settings.describeDecisionGap()).toBeNull()
    expect(settings.resolveDecisionConfig()).toEqual({
      provider: { ...provider, apiBase: 'http://127.0.0.1:8787' },
      preset: settings.DEFAULT_DECISION_PRESETS[0],
      threshold: 0.8,
    })

    settings.updateDecisionProvider(provider.id, {
      apiBase: 'https://generativelanguage.googleapis.com',
      apiKey: 'gemini-key',
    })
    expect(settings.describeDecisionGap()).toBeNull()
    expect(settings.resolveDecisionConfig()).toEqual({
      provider: { ...provider, apiBase: 'https://generativelanguage.googleapis.com', apiKey: 'gemini-key' },
      preset: settings.DEFAULT_DECISION_PRESETS[0],
      threshold: 0.8,
    })

    settings.updateDecisionProvider(provider.id, { model: 'models/' })
    expect(settings.describeDecisionGap()).toBe('请先在「设置 → 决策模型」中填写模型 ID')

    settings.updateDecisionProvider(provider.id, { model: 'gemini-decision-1' })
    settings.autoBlendDecisionPresetId.value = 'missing'
    expect(settings.describeDecisionGap()).toBe('请先选择一个决策预设')

    settings.decisionPresets.value = [{ id: 'incomplete', name: '未完成', instructions: '   ', trueCriteria: '有正例' }]
    settings.autoBlendDecisionPresetId.value = 'incomplete'
    expect(settings.describeDecisionGap()).toBe('请在「设置 → 决策模型」中补全所选预设的名称与核心判断问题')

    settings.resetDecisionPresets()
    settings.autoBlendDecisionPresetId.value = 'troll'
    settings.autoBlendDecisionThreshold.value = 0
    expect(settings.describeDecisionGap()).toBe('发送概率阈值须大于 0% 且不超过 100%')
  })
})
