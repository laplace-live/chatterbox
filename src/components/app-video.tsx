import { ArchiveButton } from './archive-button'
import { CornerCluster } from './corner-cluster'

/**
 * Minimal app surface for `www.bilibili.com/video/*` pages.
 *
 * Unlike `<AppRoom />` (which boots the live-only send loop, danmaku
 * hijacks, audio-only, auto-seek, etc.) a video page has none of that
 * machinery — no live player, no room id, no chat. So we mount nothing
 * live-related here and expose only the LAPLACE ICU archive entry point.
 *
 * The BV id is parsed from the URL by `main.tsx` and passed in, so the
 * button can build its target URL synchronously at render without
 * touching the DOM.
 */
export function AppVideo({ bvid }: { bvid: string }) {
  return (
    <CornerCluster>
      <ArchiveButton bvid={bvid} />
    </CornerCluster>
  )
}
