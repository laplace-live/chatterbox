import { InfoItems } from './info-items'
import { StatusBar } from './status-bar'

/**
 * Minimal app surface for `www.bilibili.com/opus/*` pages: read-only 主播额外信息 status bar items only, no live modules.
 *
 * Opus URLs carry a POST id, not the uid, so `main.tsx` resolves the author uid from `__INITIAL_STATE__.detail` into `infoCurrentUid` before mounting.
 */
export function AppOpus() {
  return (
    <StatusBar>
      <InfoItems />
    </StatusBar>
  )
}
