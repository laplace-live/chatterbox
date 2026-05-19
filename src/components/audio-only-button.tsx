import { audioOnlyEnabled } from '../lib/store'

/**
 * 仅音频模式 toggle，渲染为 `弹幕助手` ToggleButton 的左侧兄弟。
 *
 * 为啥不塞进 B 站自己的 player controls bar？
 *
 *  - `livePlayer.stopPlayback()`（仅音频实际省带宽的那个调用）会摧毁
 *    `.web-player-controller-wrap` 整个子树，注入的按钮跟着没了。
 *  - 其他 userscript（BLTH 自动画质模块、Pakku 等）也 stomp 这个子树，
 *    会跟我们的 MutationObserver 重注入路径打架。
 *  - 放在**我们自己**的 DOM 里 → 它就是一个挂到 `audioOnlyEnabled`
 *    signal 的 Preact 组件，没 clone、没 observer、没追 Svelte class。
 *
 * 文本随 signal 翻面，一个按钮服务两个方向：
 * - 视频模式时显示「仅音频」（点击切到 audio-only）
 * - 仅音频模式时显示「恢复视频」（点击回来）
 * 跟 B 站手机 app 的仅音频 toggle 同一个文案模式。
 *
 * Cherry-picked from laplace-live/chatterbox@ecc1b22.
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
      onClick={toggle}
      title={active ? '点击恢复视频流' : '点击切换为仅音频模式（节省约 90% 带宽）'}
      aria-pressed={active}
      style={{
        appearance: 'none',
        border: 'none',
        outline: 'none',
        cursor: 'pointer',
        userSelect: 'none',
        borderRadius: '4px',
        padding: '6px 8px',
        marginRight: '4px',
        color: 'white',
        // 仅音频开启时用 B 站品牌粉色，让"我现在不在看视频"的状态显眼；
        // 关闭时灰色，让主按钮 `弹幕助手` 保持视觉优先级。
        background: active ? '#FF6699' : '#777',
        fontSize: '13px',
        lineHeight: '1.2',
      }}
    >
      {active ? '恢复视频' : '仅音频'}
    </button>
  )
}
