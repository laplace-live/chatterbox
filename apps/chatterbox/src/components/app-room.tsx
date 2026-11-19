import { IconChevronUp } from '@tabler/icons-preact'
import { cn } from 'cn'
import { useEffect, useRef } from 'preact/hooks'

import { startAiChatEngine, stopAiChatEngine } from '../lib/ai-chat'
import { startAudioOnly, stopAudioOnly } from '../lib/audio-only'
import { startAutoBlend, stopAutoBlend } from '../lib/auto-blend'
import { startAutoQuality, stopAutoQuality } from '../lib/auto-quality'
import { startAutoSeek, stopAutoSeek } from '../lib/auto-seek'
import { startCopyNinja, stopCopyNinja } from '../lib/copy-ninja/client'
import { copyNinjaEnabled, copyNinjaServerUrl, copyNinjaToken } from '../lib/copy-ninja/settings'
import { startDanmakuDirect, stopDanmakuDirect } from '../lib/danmaku-direct'
import { loop } from '../lib/loop'
import { PLAYER_WATERMARK_SELECTOR } from '../lib/player-dom'
import {
  aiChatEnabled,
  autoBlendEnabled,
  danmakuDirectMode,
  dialogOpen,
  dialogWidth,
  floatingInputEnabled,
  floatingInputMinimized,
  hideUidWatermark,
  optimizeLayout,
} from '../lib/store'
import { startUserBlacklistHijack, stopUserBlacklistHijack } from '../lib/user-blacklist'
import { AudioOnlyControls } from './audio-only-controls'
import { AudioOnlyModeSelect } from './audio-only-mode-select'
import { Configurator, clampWidth } from './configurator'
import { ConfiguratorButton } from './configurator-button'
import { FloatingInputBox } from './floating-input-box'
import { FoldableInfoItems } from './info-items'
import { STATUS_BAR_BUTTON_CLASS, StatusBar } from './status-bar'
import { AlertDialog } from './ui/alert-dialog'

export function AppRoom() {
  useEffect(() => {
    void loop()
  }, [])

  useEffect(() => {
    if (danmakuDirectMode.value) {
      startDanmakuDirect()
    } else {
      stopDanmakuDirect()
    }
    return () => stopDanmakuDirect()
  }, [danmakuDirectMode.value])

  useEffect(() => {
    if (autoBlendEnabled.value) {
      startAutoBlend()
    } else {
      stopAutoBlend()
    }
    return () => stopAutoBlend()
  }, [autoBlendEnabled.value])

  // Start/stop is ref-counted inside the engine so strict-mode double-effect can't
  // tear down a still-needed subscription; unmount stops (not no-op) so HMR reload
  // doesn't leak a danmaku-stream subscription on an old effect.
  useEffect(() => {
    if (aiChatEnabled.value) {
      startAiChatEngine()
    } else {
      stopAiChatEngine()
    }
    return () => stopAiChatEngine()
  }, [aiChatEnabled.value])

  // Reconnects when the URL or token is committed (inputs write on change, not per keystroke).
  useEffect(() => {
    if (!copyNinjaEnabled.value) return
    startCopyNinja()
    return () => stopCopyNinja()
  }, [copyNinjaEnabled.value, copyNinjaServerUrl.value, copyNinjaToken.value])

  // Always-on so users can pre-blacklist spammers via the chat-item menu even while 自动融入 is off.
  useEffect(() => {
    startUserBlacklistHijack()
    return () => stopUserBlacklistHijack()
  }, [])

  // Signal-driven and idempotent; mounted unconditionally so the 视频/仅音频/自动音频 picker always works.
  useEffect(() => {
    startAudioOnly()
    return () => stopAudioOnly()
  }, [])

  // Signal-driven (reads `autoSeekEnabled`) and a no-op while off; mounted unconditionally so the setting flips without a reload.
  useEffect(() => {
    startAutoSeek()
    return () => stopAutoSeek()
  }, [])

  // One-shot: polls for `livePlayer`, switches to 原画, stops. Runtime toggling intentionally
  // does NOT re-fire (applies on next reload); internal `started` guard makes remounts safe.
  useEffect(() => {
    startAutoQuality()
    return () => stopAutoQuality()
  }, [])

  // B站 re-applies inline styles on `.app-body` post-hydration, so use a !important <style>
  // rule its inline writes can't clobber; rule text is rewritten reactively via `textContent`.
  const layoutStyleRef = useRef<HTMLStyleElement | null>(null)
  useEffect(() => {
    // Clear stale inline margin from older versions; match the exact old value ('1rem') so we don't wipe one B站 set.
    const stale = document.querySelector<HTMLElement>('.app-body')
    if (stale?.style.marginLeft === '1rem') stale.style.marginLeft = ''

    if (!optimizeLayout.value) return
    const style = document.createElement('style')
    layoutStyleRef.current = style
    document.head.appendChild(style)
    return () => {
      style.remove()
      layoutStyleRef.current = null
    }
  }, [optimizeLayout.value])

  // Cap `max-width`, not `margin-right`: B站 pins width via JS keyed to `window.innerWidth`, so a
  // margin frees no space. `calc(100% - …)` stays responsive without a resize listener; +24 covers
  // the dialog's `right-1` offset plus a gap, and `clampWidth` matches the dialog so reserve can't drift.
  useEffect(() => {
    const style = layoutStyleRef.current
    if (!style) return
    const rules = ['margin-left: 1rem !important']
    if (dialogOpen.value) {
      rules.push(`max-width: calc(100% - ${clampWidth(dialogWidth.value) + 24}px) !important`)
    }
    style.textContent = `.app-body { ${rules.join('; ')}; }`
  }, [optimizeLayout.value, dialogOpen.value, dialogWidth.value])

  useEffect(() => {
    if (!hideUidWatermark.value) return
    const style = document.createElement('style')
    style.textContent = `${PLAYER_WATERMARK_SELECTOR} { display: none !important; }`
    document.head.appendChild(style)
    return () => style.remove()
  }, [hideUidWatermark.value])

  const showRestoreInput = floatingInputEnabled.value && floatingInputMinimized.value

  return (
    <>
      {/* Mount order + z-index (2147483645) keep FloatingInputBox below Configurator (2147483646) and StatusBar (2147483647). */}
      <FloatingInputBox />
      <StatusBar>
        <FoldableInfoItems
          foldHoverAction={
            showRestoreInput ? (
              <div
                class={cn(
                  'invisible absolute bottom-full left-1/2 z-0 -translate-x-1/2 pb-1',
                  'translate-y-4 opacity-0 transition-[translate,opacity,visibility] delay-150 duration-500 ease-out',
                  'group-hover/fold:visible group-hover/fold:translate-y-0 group-hover/fold:opacity-100 group-hover/fold:delay-0',
                  'group-has-focus-visible/fold:visible group-has-focus-visible/fold:translate-y-0 group-has-focus-visible/fold:opacity-100 group-has-focus-visible/fold:delay-0',
                  'pointer-coarse:group-focus-within/fold:visible pointer-coarse:group-focus-within/fold:translate-y-0 pointer-coarse:group-focus-within/fold:opacity-100 pointer-coarse:group-focus-within/fold:delay-0'
                )}
              >
                <button
                  type='button'
                  onClick={() => {
                    floatingInputMinimized.value = false
                  }}
                  title='恢复悬浮输入框'
                  aria-label='恢复悬浮输入框'
                  class={cn(
                    STATUS_BAR_BUTTON_CLASS,
                    'h-6 w-7 justify-center px-0 shadow-md ring-1 ring-white/25',
                    'bg-ga6'
                  )}
                >
                  <IconChevronUp size={15} stroke={2.2} aria-hidden='true' />
                </button>
              </div>
            ) : null
          }
        />
        <AudioOnlyControls />
        <AudioOnlyModeSelect />
        <ConfiguratorButton />
      </StatusBar>
      <Configurator />
      <AlertDialog />
    </>
  )
}
