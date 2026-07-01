import { CornerCluster } from './corner-cluster'
import { InfoButton } from './info-button'

/**
 * Minimal app surface for `space.bilibili.com`.
 *
 * Live-only modules are kept out of the tree entirely here; they'd crash
 * against a space page (no `.chat-items`, no `livePlayer`, no `ensureRoomId`).
 * `main.tsx` writes the URL-parsed uid into `infoCurrentUid` before render.
 */
export function AppSpace() {
  return (
    <CornerCluster>
      <InfoButton />
    </CornerCluster>
  )
}
