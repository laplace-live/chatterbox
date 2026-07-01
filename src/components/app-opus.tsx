import { CornerCluster } from './corner-cluster'
import { InfoButton } from './info-button'

/**
 * Minimal app surface for `www.bilibili.com/opus/*` pages: read-only 主播额外信息 popover only, no live modules.
 *
 * Opus URLs carry a POST id, not the uid, so `main.tsx` resolves the author uid from `__INITIAL_STATE__.detail` into `infoCurrentUid` before mounting.
 */
export function AppOpus() {
  return (
    <CornerCluster>
      <InfoButton />
    </CornerCluster>
  )
}
