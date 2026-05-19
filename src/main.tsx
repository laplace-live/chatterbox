import { render } from 'preact'

import { GM_registerMenuCommand } from '$'
import 'virtual:uno.css'
import './lib/fetch-hijack'

import { App } from './components/app'
import { warnIfDegraded } from './lib/platform'
import { audioOnlyEnabled } from './lib/store'

function mount() {
  const app = document.createElement('div')
  document.body.append(app)
  render(<App />, app)
}

/**
 * Tampermonkey 菜单命令：仅音频 toggle 的"逃生通道"。
 *
 * 面板里的图标按钮是主入口（panel-header 的 actions row）。这里再注册一份
 * 进 Tampermonkey 菜单 (`点扩展图标 → 切换仅音频`)，给两类人用：
 *  - 重度用户：知道 TM 菜单，不愿意为开关多点开面板
 *  - 全屏状态：B 站全屏时我们的面板可能被遮住，TM 菜单还能用
 *
 * 注册一次（顶层 module init），signal 直接 mutate。
 */
function registerAudioOnlyMenuCommand() {
  if (typeof GM_registerMenuCommand !== 'function') return
  GM_registerMenuCommand('切换仅音频模式', () => {
    audioOnlyEnabled.value = !audioOnlyEnabled.value
  })
}

const isLiveHost = location.hostname === 'live.bilibili.com'

// The userscript runs at document-start so the WBI XHR interceptor (wbi.ts)
// can patch XMLHttpRequest before the page fires /x/web-interface/nav.
// At that point document.body may not exist yet, so we defer mounting until
// the browser creates <body>.
if (isLiveHost) {
  // Surface a single console warning when we detect a mobile UA. Users on
  // unsupported platforms get an up-front explanation in their bug reports
  // instead of mysterious "button didn't work" tickets.
  warnIfDegraded()
  registerAudioOnlyMenuCommand()
  if (document.body) {
    mount()
  } else {
    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect()
        mount()
      }
    })
    observer.observe(document.documentElement, { childList: true })
  }
}
