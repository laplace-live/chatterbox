import type { LlmPromptFeature } from '../lib/prompts'

import { describeLlmGap } from '../lib/llm-polish'
import { activeTab } from '../lib/store'

/**
 * 把"AI 润色（原 YOLO）已开但 LLM 还没配齐"这句话集中渲染。
 *
 * 文件名仍叫 `yolo-callout.tsx`、组件仍叫 `YoloCallout`——内部代号保持，
 * 用户面文案统一改成「AI 润色」。
 *
 * 每个 send 路径（auto-blend / auto-send / normal-send）都需要紧接 AI 润色复选框
 * 渲染同样的状态文字，原本是各自一段 inline JSX。问题：
 *  1. 三处文字略有差异（"已就绪：触发后…" vs "已就绪：每条…" vs "已就绪：手动发送…"）
 *  2. 配置缺失时只有一段 plain text，没有跳转手段——P0-4 中提到这点：用户看到
 *     "请到「设置 → LLM」中…" 但要自己手动找设置 tab、找到 LLM 区域、展开。
 *
 * 这个组件解决 #2：把 describeLlmGap 的字符串里的「设置 → LLM」高亮成一个按钮，
 * 点了就 `activeTab.value = 'settings'`，把用户直接送进设置页（LLM 区域是默认
 * 展开的，所以一跳就能看到）。
 */
export function YoloCallout({
  feature,
  enabled,
  readyText,
}: {
  feature: LlmPromptFeature
  enabled: boolean
  /** YOLO 配置齐全时显示的"已就绪"提示文字。 */
  readyText: string
}) {
  const gap = describeLlmGap(feature)
  // 即使 YOLO 没勾上,只要存在 LLM 配置缺口就显示一行弱提示——避免用户勾上
  // YOLO 后才发现"为什么没反应"。提示只显示"前往设置 →"按钮,文案极简。
  if (!enabled) {
    if (!gap) return null
    return (
      <div className='cb-note' style={{ paddingLeft: '1.4em', fontSize: '11px', color: '#999' }}>
        ⓘ {gap}
        <button
          type='button'
          style={{
            marginLeft: '.5em',
            background: 'none',
            border: 'none',
            padding: 0,
            color: 'var(--cb-accent)',
            cursor: 'pointer',
            fontSize: 'inherit',
            textDecoration: 'underline',
          }}
          onClick={() => {
            activeTab.value = 'settings'
          }}
        >
          前往设置 →
        </button>
      </div>
    )
  }
  if (!gap) {
    return (
      <div className='cb-note' style={{ paddingLeft: '1.4em' }}>
        {readyText}
      </div>
    )
  }
  return (
    <div className='cb-note' style={{ paddingLeft: '1.4em' }}>
      {gap}
      <button
        type='button'
        style={{
          marginLeft: '.5em',
          background: 'none',
          border: 'none',
          padding: 0,
          color: 'var(--cb-accent)',
          cursor: 'pointer',
          fontSize: 'inherit',
          textDecoration: 'underline',
        }}
        onClick={() => {
          activeTab.value = 'settings'
        }}
      >
        前往设置 →
      </button>
    </div>
  )
}
