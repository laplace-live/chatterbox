import { activeTab, dialogOpen, optimizeLayout } from '../store'
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

  return (
    <div
      id='laplace-chatterbox-dialog'
      style={{
        position: 'fixed',
        right: '4px',
        bottom: 'calc(4px + 30px)',
        zIndex: 2147483647,
        background: 'var(--bg1, #fff)',
        display: visible ? (optimized ? 'flex' : 'block') : 'none',
        flexDirection: optimized ? 'column' : undefined,
        padding: '10px',
        boxShadow: '0 0 0 1px var(--Ga2, rgba(0, 0, 0, .2))',
        borderRadius: '4px',
        minWidth: '50px',
        height: optimized ? 'calc(100vh - 125px)' : undefined,
        maxHeight: optimized ? undefined : 'calc(100vh - 125px)',
        overflowY: optimized ? 'hidden' : 'auto',
        width: '300px',
      }}
    >
      <Tabs />

      <div
        style={{
          display: tab === 'dulunche' ? (optimized ? 'flex' : 'block') : 'none',
          flexDirection: optimized ? 'column' : undefined,
          flex: optimized ? 1 : undefined,
          minHeight: optimized ? 0 : undefined,
        }}
      >
        <AutoSendControls />
        <div
          style={{
            margin: '.5em 0',
            paddingTop: '.5em',
            borderTop: '1px solid var(--Ga2, #eee)',
            ...(optimized && { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }),
          }}
        >
          <MemesList />
        </div>
      </div>

      <div style={{ display: tab === 'fasong' ? 'block' : 'none' }}>
        <NormalSendTab />
      </div>

      <div style={{ display: tab === 'tongchuan' ? 'block' : 'none' }}>
        <SttTab />
      </div>

      <div style={{ display: tab === 'settings' ? 'block' : 'none' }}>
        <SettingsTab />
      </div>

      <LogPanel />
    </div>
  )
}
