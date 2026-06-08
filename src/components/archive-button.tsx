import { cn } from '../lib/cn'

/**
 * "LAPLACE ICU 存档" button, shown in the bottom-right corner cluster on
 * `www.bilibili.com/video/*` pages.
 *
 * LAPLACE ICU (https://laplace.icu) hosts archived copies of bilibili
 * videos keyed by BV id. The button just hands the current video's BV id
 * off to that service via the `https://laplace.icu/v/:bvid` URL template —
 * there's no live-room machinery involved, so this is a plain anchor
 * rather than a signal-wired toggle.
 *
 * Opens in a new tab so the user keeps their place on the video page.
 * Layout (fixed corner, z-index, spacing) is owned by `<CornerCluster />`.
 */
export function ArchiveButton({ bvid }: { bvid: string }) {
  return (
    <a
      id='laplace-icu-archive'
      href={`https://laplace.icu/v/${bvid}`}
      target='_blank'
      rel='noopener'
      title='在 LAPLACE ICU 查看 / 存档此视频'
      class={cn(
        'appearance-none border-none no-underline outline-none',
        'cursor-pointer select-none',
        'inline-flex h-6 items-center rounded px-2 text-white',
        'bg-brand'
      )}
    >
      存档该视频
    </a>
  )
}
