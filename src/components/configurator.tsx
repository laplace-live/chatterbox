import { cn } from '../lib/cn'
import { activeTab, dialogOpen, optimizeLayout } from '../lib/store'
import { AboutTab } from './about-tab'
import { AutoBlendControls } from './auto-blend-controls'
import { AutoSendControls } from './auto-send-controls'
import { LogPanel } from './log-panel'
import { MemesList } from './memes-list'
import { NormalSendTab } from './normal-send-tab'
import { SettingsTab } from './settings-tab'
import { SttTab } from './stt-tab'
import { Tabs } from './tabs'

export function Configurator() {
  const tab = activeTab.value
  const visible = dialogOpen.value
  const optimized = optimizeLayout.value

  // Three layout shapes for the dialog:
  // 1. Hidden when `dialogOpen` is false.
  // 2. Visible + optimized: full-height flex column with hidden overflow
  //    (children opt back into scroll where appropriate).
  // 3. Visible + non-optimized: legacy block layout that grows to its
  //    content up to the viewport height.
  const dialogClass = cn(
    'lc-fixed lc-right-1 lc-bottom-[calc(4px_+_30px)] lc-z-[2147483647]',
    'lc-bg-bg1 lc-rounded lc-min-w-[50px] lc-w-[300px]',
    'lc-shadow-[0_0_0_1px_var(--Ga2,rgba(0,0,0,.2))]',
    !visible && 'lc-hidden',
    visible && optimized && 'lc-flex lc-flex-col lc-h-[calc(100vh_-_110px)] lc-overflow-hidden',
    visible && !optimized && 'lc-block lc-max-h-[calc(100vh_-_110px)] lc-overflow-y-auto'
  )

  // All four tab panels share the visibility/layout shape: in optimized
  // mode the panel itself owns the vertical scroll (since the dialog is
  // overflow-hidden), and in legacy mode the dialog scrolls and the panel
  // grows naturally. Fasong's meme list still has its own internal scroll
  // container (capped at lc-max-h-[240px]) so a long meme list doesn't
  // monopolize the panel viewport.
  const panelClass = (active: boolean) =>
    cn(
      // `<Tabs />` already lives inside the dialog, so panel-level horizontal
      // padding belongs here on the per-tab wrapper rather than the dialog.
      'lc-px-[10px]',
      !active && 'lc-hidden',
      active && optimized && 'lc-flex-1 lc-min-h-0 lc-overflow-y-auto',
      active && !optimized && 'lc-block'
    )

  return (
    <div id='laplace-chatterbox-dialog' class={dialogClass}>
      <Tabs />

      <div class={panelClass(tab === 'fasong')}>
        <AutoSendControls />
        <div class='lc-my-1'>
          <AutoBlendControls />
        </div>
        <div class='lc-my-1'>
          <MemesList />
        </div>
        <NormalSendTab />
      </div>

      <div class={panelClass(tab === 'tongchuan')}>
        <SttTab />
      </div>

      <div class={panelClass(tab === 'settings')}>
        <SettingsTab />
      </div>

      <div class={panelClass(tab === 'about')}>
        <AboutTab />
      </div>

      <div class='lc-px-[10px] lc-pb-[5px]'>
        <LogPanel />
      </div>
    </div>
  )
}
