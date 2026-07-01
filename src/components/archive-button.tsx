import { cn } from '../lib/cn'

/**
 * "LAPLACE ICU 存档" button linking to a bilibili video's archived copy on
 * LAPLACE ICU (https://laplace.icu), keyed by BV id via `https://laplace.icu/v/:bvid`.
 *
 * Plain anchor (no live-room machinery); opens in a new tab to keep the user's place.
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
