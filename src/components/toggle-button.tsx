import { useCallback, useEffect, useRef } from 'preact/hooks'

import { activeTab, dialogOpen, sendMsg } from '../lib/store'
import { AudioOnlyButton } from './audio-only-button'

export function ToggleButton() {
  const btnRef = useRef<HTMLButtonElement>(null)

  const toggle = useCallback(() => {
    dialogOpen.value = !dialogOpen.value
  }, [])

  // Esc 两阶段行为（capture phase，抢在 B 站自己的 Esc handler 之前）：
  //   1) 当前在设置/关于子页 → Esc 先返回主页（不关面板）。这是抽屉式导航的标准
  //      退路；用户通常想"退回上一层"，而不是"一键关掉整个面板"。
  //   2) 在主页（或已经在主页）→ Esc 关掉面板。
  //
  // 焦点在 input/textarea/select 等可编辑控件时不响应——用户清输入框的 Esc
  // 应该让默认行为通过。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!dialogOpen.value) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return
      // 在子页面：第一次 Esc 返回主页。
      if (activeTab.value === 'settings' || activeTab.value === 'about') {
        e.stopPropagation()
        activeTab.value = 'fasong'
        return
      }
      // 在主页：Esc 关闭面板。
      e.stopPropagation()
      dialogOpen.value = false
      btnRef.current?.focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  // 浮窗外点击关闭(Jobs 式 #19):键盘用户走 Esc,鼠标用户走"点空白处"。
  // 与 Esc 行为对称——两条路都通,触感符合直觉。
  //
  // 实现细节:capture-phase mousedown,因为 B 站直播页本身有大量内置 click
  // handler(打开礼物面板、关注、举报等),capture 可以在它们看到事件之前
  // 决定"是否要关浮窗"——我们不 stopPropagation,只是 close 浮窗,让 B 站
  // 自己的 click 照常发生(用户在浮窗外按了别处,本来就预期那里有点击行为)。
  //
  // 关闭判定:点击落在浮窗 dialog 或 toggle button 任一子树内 → 不关。
  // 否则关。用 closest() 而不是手动 walk parent chain,既简洁又能正确处理
  // 被 portal 渲染出去的子节点(emote picker 之类)——portal 节点不在
  // dialog DOM 子树里,会被识别为"外面",这是已知 trade-off:它们也算
  // 外部,确实可能导致 emote picker 打开的同时关掉浮窗。所以 portal 类组件
  // 自己负责在挂载时把 self 的 click 加到 cb-no-outside-close 白名单。
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!dialogOpen.value) return
      const target = e.target as HTMLElement | null
      if (!target) return
      // 已经在 dialog 或 toggle 按钮内 → 不关。
      if (
        target.closest('#laplace-chatterbox-dialog') ||
        target.closest('#laplace-chatterbox-toggle') ||
        target.closest('.cb-no-outside-close')
      ) {
        return
      }
      // 在主页 + 外部点击:关闭面板。子页(settings/about)外部点击:回主页,
      // 与 Esc 的两阶段对称——鼠标用户也能"逐层退"。
      if (activeTab.value === 'settings' || activeTab.value === 'about') {
        activeTab.value = 'fasong'
        return
      }
      dialogOpen.value = false
    }
    document.addEventListener('mousedown', onMouseDown, true)
    return () => document.removeEventListener('mousedown', onMouseDown, true)
  }, [])

  const sending = sendMsg.value
  const open = dialogOpen.value

  // 右下角按钮簇：`弹幕助手`（打开面板）+ 任何想跟它共享 z-index 与边距
  // 的兄弟按钮（目前只有「仅音频」）。包一层 fixed div 比给每个按钮独立
  // 算位置好维护 —— flex 自动排齐。
  //
  // `cb-no-outside-close` 让按钮簇内部的点击不触发外部点击关闭面板的
  // capture-phase 监听（见上面的 mousedown effect）。注意 dialog 的关闭
  // 检测用的是 `closest('#laplace-chatterbox-toggle')`，单按 ID 不够覆盖
  // 兄弟按钮，必须靠这个 class。
  return (
    <div
      class='cb-no-outside-close'
      style={{
        position: 'fixed',
        right: '8px',
        bottom: '8px',
        zIndex: 2147483647,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <AudioOnlyButton />
      <button
        ref={btnRef}
        type='button'
        id='laplace-chatterbox-toggle'
        data-open={open}
        data-sending={sending}
        aria-label={open ? '关闭弹幕助手面板（按 Esc 关闭）' : '打开弹幕助手面板'}
        aria-expanded={open}
        aria-controls='laplace-chatterbox-dialog'
        title={open ? 'Esc 关闭面板' : '点击打开弹幕助手'}
        onClick={toggle}
      >
        弹幕助手
      </button>
    </div>
  )
}
