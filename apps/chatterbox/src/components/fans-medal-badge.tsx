import { cn } from 'cn'

import type { FansMedal } from '../types'

/** B站 v2 fans medal pill: name and level over the medal's own gradient. */
export function FansMedalBadge({ medal, className }: { medal: FansMedal; className?: string }) {
  return (
    <span
      class={cn(
        'box-border inline-flex h-[16px] max-w-full min-w-0 shrink-0 items-center gap-[3px] rounded-full border border-solid px-[5px] text-[10px] leading-none whitespace-nowrap select-none',
        className
      )}
      style={{
        backgroundImage: `linear-gradient(45deg, ${medal.colorStart}, ${medal.colorEnd})`,
        borderColor: medal.colorBorder,
        color: medal.colorText,
      }}
    >
      <span class='min-w-0 truncate'>{medal.medalName}</span>
      <span class='shrink-0 font-semibold'>{medal.level}</span>
    </span>
  )
}
