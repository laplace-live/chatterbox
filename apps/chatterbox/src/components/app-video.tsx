import { ArchiveButton } from './archive-button'
import { StatusBar } from './status-bar'

/** Minimal app surface for `www.bilibili.com/video/*` pages: archive entry point only. */
export function AppVideo({ bvid }: { bvid: string }) {
  return (
    <StatusBar>
      <ArchiveButton bvid={bvid} />
    </StatusBar>
  )
}
