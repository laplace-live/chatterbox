import { ArchiveButton } from './archive-button'
import { CornerCluster } from './corner-cluster'

/** Minimal app surface for `www.bilibili.com/video/*` pages: archive entry point only. */
export function AppVideo({ bvid }: { bvid: string }) {
  return (
    <CornerCluster>
      <ArchiveButton bvid={bvid} />
    </CornerCluster>
  )
}
