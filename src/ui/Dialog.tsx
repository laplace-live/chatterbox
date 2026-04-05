import { activeTab } from '../store.js'
import { AutoSendControls } from './AutoSendControls.js'
import { FasongTab } from './FasongTab.js'
import { LogPanel } from './LogPanel.js'
import { MemesList } from './MemesList.js'
import { SettingsTab } from './SettingsTab.js'
import { TabBar } from './TabBar.js'
import { TongchuanTab } from './TongchuanTab.js'

export function Dialog() {
  const tab = activeTab.value

  return (
    <div
      id='laplace-chatterbox-dialog'
      style={{
        position: 'fixed',
        right: '4px',
        bottom: 'calc(4px + 30px)',
        zIndex: 2147483647,
        background: 'var(--bg1, #fff)',
        display: 'none',
        padding: '10px',
        boxShadow: '0 0 0 1px var(--Ga2, rgba(0, 0, 0, .2))',
        borderRadius: '4px',
        minWidth: '50px',
        maxHeight: 'calc(100vh - 64px)',
        overflowY: 'auto',
        width: '300px',
      }}
    >
      <TabBar />

      <div style={{ display: tab === 'dulunche' ? 'block' : 'none' }}>
        <AutoSendControls />
        <div style={{ margin: '.5em 0', paddingTop: '.5em', borderTop: '1px solid var(--Ga2, #eee)' }}>
          <MemesList />
        </div>
      </div>

      <div style={{ display: tab === 'fasong' ? 'block' : 'none' }}>
        <FasongTab />
      </div>

      <div style={{ display: tab === 'tongchuan' ? 'block' : 'none' }}>
        <TongchuanTab />
      </div>

      <div style={{ display: tab === 'settings' ? 'block' : 'none' }}>
        <SettingsTab />
      </div>

      <LogPanel />
    </div>
  )
}
