import { useEffect, useRef } from 'preact/hooks'

import { reconnectLiveWsNow } from '../lib/live-ws-source'
import { notifyUser } from '../lib/log'
import {
  activeTab,
  autoBlendDryRun,
  autoBlendEnabled,
  cachedRoomId,
  hzmDriveEnabled,
  hzmDryRun,
  liveWsStatus,
  sendMsg,
  sttRunning,
} from '../lib/store'
import { extractRoomNumber } from '../lib/utils'
import { Icon } from './ui/icon'

/**
 * 面板顶部常驻状态条 + 导航入口。
 *
 * 替代原有的 4-Tab 系统（发送/同传/设置/关于）。设计原则：
 *  - 状态一目了然：直播间号 / WS 状态 / 哪些自动功能在跑 / 是否试运行。
 *  - 导航降为图标：⚙ 进设置抽屉，ⓘ 进关于抽屉，← 返回主页。
 *  - 试运行用每个功能 chip 自己的 `·试` 后缀（橙色）指示——不再叠加单独的
 *    "⚠ 试运行" 强调 chip（双重视觉指示是冗余）。
 *
 * 内部仍复用 `activeTab` 信号——'fasong'=主页，'settings'/'about'=抽屉视图。
 * 旧版 'tongchuan' tab 已被 Configurator 迁移到 'fasong'。
 *
 * 焦点管理：进设置/关于子页时，把焦点跳到「← 返回」按钮——键盘用户立刻能 Esc
 * 或 Enter 退回；屏幕阅读器也会朗读子页标题。回主页时不主动移焦点，避免抢用户
 * 当前操作（鼠标 / 键盘 trigger 各自结束）。
 */
export function PanelHeader() {
  const tab = activeTab.value
  const onSubPage = tab === 'settings' || tab === 'about'

  const backBtnRef = useRef<HTMLButtonElement>(null)

  // 进子页后把焦点跳到「← 返回」。activeTab 变到 settings/about → 重渲染
  // → 此 effect 跑 → backBtnRef 此时已挂上新渲染的 ← 按钮。
  useEffect(() => {
    if (onSubPage && backBtnRef.current) {
      backBtnRef.current.focus()
    }
  }, [onSubPage, tab])

  if (onSubPage) {
    return (
      <div className='cb-panel-header cb-panel-header--sub' data-on-sub-page='true'>
        <button
          ref={backBtnRef}
          type='button'
          // Share padding + font-size with ⚙ / ⓘ icon buttons (cb-panel-header-icon)
          // so the chrome looks consistent across home + sub-pages.
          // cb-panel-header-back remains as a hook for back-specific overrides.
          className='cb-btn cb-panel-header-icon cb-panel-header-back'
          onClick={() => {
            activeTab.value = 'fasong'
          }}
          aria-label='返回主页'
          title='返回主页 (Esc)'
        >
          <Icon name='arrow-left' /> 返回
        </button>
        <strong className='cb-panel-header-title'>{tab === 'settings' ? '设置' : '关于'}</strong>
      </div>
    )
  }

  // 房间号：优先用 store 里缓存的（其它子系统通过 ensureRoomId() 拉到的），
  // 但如果还没人拉过（首屏 / 没有 Chatterbox Chat / 没有自动功能在跑），
  // 直接从 URL 兜底解出来——header 是面板第一眼能看到的东西，不应该等
  // 任何副作用就该显示房间号。这只是显示用的派生值，不写回全局 store
  // （避免跟 cachedRoomSlug 的副作用耦合）。
  const fallbackRoomFromUrl = (() => {
    try {
      const fromUrl = extractRoomNumber(window.location.href)
      if (!fromUrl) return null
      const parsed = Number.parseInt(fromUrl, 10)
      // `0` (or any non-positive int) is never a real Bilibili room ID; treat
      // it as "no room" rather than rendering "· 0". Number.parseInt also
      // returns NaN for malformed input, which `> 0` rejects.
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null
    } catch {
      return null
    }
  })()
  // Use `?? `(only on null/undefined) rather than `||` so a real cachedRoomId
  // of 0 (impossible, but defensive) doesn't fall through silently. Then the
  // JSX guard `displayRoomId !== null` skips invalid values cleanly.
  const cachedId = cachedRoomId.value
  const displayRoomId = cachedId !== null && cachedId > 0 ? cachedId : fallbackRoomFromUrl

  const ws = liveWsStatus.value
  // WS 状态徽章现在默认隐藏——只在用户需要注意/可操作时显示。
  // 见下面 JSX 处的判断。两个可见态：
  //   - connecting：1~3 秒短暂提示握手中（橙脉冲）
  //   - error/closed：红色 + 重连按钮
  // healthy('live') / idle('off') 都不显示——这些是用户不需要知道的实现细节。
  //
  // 历史 bug：原本写成 `ws === 'open'`——这个值在 CustomChatWsStatus 枚举里
  // 根本不存在，所以永远不匹配，连上 WS 后 header 仍然显示「WS 未连」，跟日志
  // 「🟢 已连接」直接打架。正确的健康值是 'live'。
  const wsDegraded = ws === 'error' || ws === 'closed'
  const wsConnecting = ws === 'connecting'
  const wsLabel = wsDegraded ? 'WS 断开' : 'WS 连接中…'
  const wsTitle = wsDegraded ? 'WS 已断开，已退回 DOM 抓取' : '正在握手，通常 1~3 秒'

  const isLoop = sendMsg.value
  const isBlend = autoBlendEnabled.value
  const isHzm = hzmDriveEnabled.value
  const isStt = sttRunning.value
  const blendDry = isBlend && autoBlendDryRun.value
  const hzmDry = isHzm && hzmDryRun.value
  const hasAnyActive = isLoop || isBlend || isHzm || isStt

  return (
    <div className='cb-panel-header'>
      <div className='cb-panel-header-row'>
        <div className='cb-panel-header-status'>
          <strong className='cb-panel-header-title'>弹幕助手</strong>
          {displayRoomId !== null && (
            <span className='cb-panel-header-roomid' title={`当前直播间 ${displayRoomId}`}>
              · {displayRoomId}
            </span>
          )}
          {/*
            WS 状态徽章默认隐藏——只在需要用户注意的两种状态时才显示：
              - connecting：短暂安抚（橙脉冲），握手 1~3 秒内自动隐藏
              - degraded（closed/error）：红色 + 重连按钮，actionable
            Healthy（live）和 idle（off/未启用）都是"用户不需要知道"的实现细节，
            出现在 header 只是噪声。Jobs 的状态指示器哲学：除非有事让用户做，
            否则别显示。
            Title 仍保留为 wsTitle——降级显示在父元素 hover 时也能解释当前态。
          */}
          {(wsConnecting || wsDegraded) && (
            <span
              className={
                wsDegraded
                  ? 'cb-panel-header-ws cb-panel-header-ws--bad'
                  : 'cb-panel-header-ws cb-panel-header-ws--connecting'
              }
              title={wsTitle}
            >
              <span className='cb-panel-header-ws-dot' />
              {wsLabel}
            </span>
          )}
          {wsDegraded && (
            <button
              type='button'
              className='cb-panel-header-reconnect'
              onClick={() => {
                const ok = reconnectLiveWsNow()
                if (!ok) {
                  // WS 从未启动（极少见，正常加载流程会自启动）。仍然给用户反馈
                  // 不要静默吞了。
                  notifyUser('warning', '直播 WS 尚未启动', '请刷新页面以重新初始化连接。')
                }
              }}
              aria-label='立即重新连接 WebSocket'
              title='立即重连（撕掉指数退避，马上发起新连接）'
            >
              ↻ 重连
            </button>
          )}
        </div>
        <div className='cb-panel-header-actions'>
          <button
            type='button'
            className='cb-btn cb-panel-header-icon'
            onClick={() => {
              activeTab.value = 'settings'
            }}
            aria-label='打开设置'
            title='设置'
          >
            <Icon name='settings' />
          </button>
          <button
            type='button'
            className='cb-btn cb-panel-header-icon'
            onClick={() => {
              activeTab.value = 'about'
            }}
            aria-label='打开关于'
            title='关于 / 隐私 / 版本'
          >
            <Icon name='info' />
          </button>
        </div>
      </div>

      {hasAnyActive && (
        <div className='cb-panel-header-chips' role='status' aria-live='polite' aria-label='当前运行中的功能'>
          {isLoop && <span className='cb-panel-header-chip cb-panel-header-chip--on'>独轮车</span>}
          {isBlend && (
            <span
              className={`cb-panel-header-chip ${blendDry ? 'cb-panel-header-chip--dry' : 'cb-panel-header-chip--on'}`}
              title={blendDry ? '自动跟车试运行中（不会真发）' : '自动跟车真发中'}
            >
              跟车{blendDry ? '·试' : ''}
            </span>
          )}
          {isHzm && (
            <span
              className={`cb-panel-header-chip ${hzmDry ? 'cb-panel-header-chip--dry' : 'cb-panel-header-chip--on'}`}
              title={hzmDry ? '智驾试运行中（不会真发）' : '智驾真发中'}
            >
              智驾{hzmDry ? '·试' : ''}
            </span>
          )}
          {isStt && <span className='cb-panel-header-chip cb-panel-header-chip--on'>同传</span>}
          {/*
           * 试运行视觉指示一律走每个功能的 chip 后缀（跟车·试 / 智驾·试），不再
           * 叠加一个独立的"⚠ 试运行"强调 chip——双重指示是视觉冗余，单 chip
           * 已经足够橙色 + ·试 后缀提示用户。
           */}
        </div>
      )}

      {wsDegraded && (
        <div
          className='cb-ws-degraded-banner'
          role='status'
          aria-live='polite'
          title='直播 WebSocket 断开，自动跟车与 Chatterbox Chat 已退化为 DOM 抓取模式（高峰期可能漏事件）。刷新页面通常可恢复。'
        >
          <Icon name='warning' aria-hidden={true} /> 直播 WS 已断开 · 已退回 DOM 抓取（高峰期可能漏事件）
        </div>
      )}
    </div>
  )
}
