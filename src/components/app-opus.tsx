import { CornerCluster } from './corner-cluster'
import { InfoButton } from './info-button'

/**
 * Minimal app surface for `www.bilibili.com/opus/*` (图文动态 / 专栏) pages.
 *
 * Same shape as `<AppSpace />`: an opus page has none of the live-room
 * machinery (no send loop, no player, no chat), so we mount only the
 * read-only 主播额外信息 popover and skip every live-only module.
 *
 * Identity differs from the space page though. Space URLs start with the
 * uid (`/${uid}/dynamic`), so `main.tsx` parses it straight from the path.
 * An opus URL carries the POST id instead (`/opus/${opusId}`), so `main.tsx`
 * resolves the author's uid from the page's SSR snapshot
 * (`__INITIAL_STATE__.detail`) via `extractOpusAuthorUid` and writes it into
 * `infoCurrentUid` before mounting this surface.
 */
export function AppOpus() {
  return (
    <CornerCluster>
      <InfoButton />
    </CornerCluster>
  )
}
