import { audioOnlyEnabled } from '../lib/store'
import { Icon } from './ui/icon'

/**
 * 仅音频 toggle，渲染为面板头部右侧的图标按钮。
 *
 * **位置决策**（Jobs 审计后从浮动 dock 搬到 header）：
 *
 * 之前挂在 `弹幕助手` toggle button 的左兄弟（浮动 dock 里），跟主按钮并排。
 * 心智模型错位 —— AudioOnly 是**播放器节流模式**，跟 `弹幕助手`（弹幕工具入口）
 * 不是同一类东西。视觉权重平齐让用户误以为它是弹幕助手的子功能。
 *
 * 改放面板 header 的 actions row（⚙ / ⓘ 的左邻），把它框成「面板 chrome 里的
 * 一个 mode 开关」—— 跟 header 已有的状态 chips（独轮车 / 跟车 / 智驾 / 同传）
 * 性质对齐：「我现在处在某个模式」。代价：用户多点一次（先开面板再切换），但这
 * 是个 set-and-forget 场景（用户开了之后基本就走了去多任务），多 200ms 不痛。
 *
 * 给重度用户的逃生通道：Tampermonkey 菜单也注册了「切换仅音频」命令，零页面
 * 视觉成本。见 `main.tsx`。
 *
 * **为啥不塞回 B 站 player controls bar：**
 * - `livePlayer.stopPlayback()`（仅音频实际省带宽的那个调用）会摧毁
 *   `.web-player-controller-wrap` 整个子树，注入的按钮跟着没了。
 * - 其他 userscript（BLTH 自动画质模块、Pakku 等）也 stomp 这个子树，
 *   会跟我们的 MutationObserver 重注入路径打架。
 * - 放在**我们自己**的 DOM（panel header）里 → 它就是一个挂到 `audioOnlyEnabled`
 *   signal 的 Preact 组件，没 clone、没 observer、没追 Svelte class。
 *
 * 视觉状态：
 * - 关闭：灰色 speaker icon（融入 header）
 * - 开启：B 站品牌粉 #FF6699（明确"我现在在节流"的状态，跟 chips 的 ·on 色对齐）
 *
 * Cherry-picked from laplace-live/chatterbox@ecc1b22，位置经 Jobs 审计调整。
 */
export function AudioOnlyButton() {
  const active = audioOnlyEnabled.value
  const toggle = () => {
    audioOnlyEnabled.value = !audioOnlyEnabled.value
  }

  return (
    <button
      type='button'
      id='laplace-audio-only-toggle'
      className='cb-btn cb-panel-header-icon'
      onClick={toggle}
      title={active ? '仅音频模式：开启（点击恢复视频）' : '仅音频模式：关闭（点击切换，节省约 90% 带宽）'}
      aria-label={active ? '关闭仅音频模式' : '开启仅音频模式'}
      aria-pressed={active}
      style={active ? { color: '#FF6699' } : undefined}
    >
      <Icon name='volume' />
    </button>
  )
}
