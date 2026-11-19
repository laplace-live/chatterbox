import { cn } from 'cn'

import type { FansMedal } from '../types'

/** B站 v2 fans medal pill: name and level over the medal's own gradient, led by its guard icon when it has one. */
export function FansMedalBadge({ medal, className }: { medal: FansMedal; className?: string }) {
  const gradient = `linear-gradient(45deg, ${medal.colorStart}, ${medal.colorEnd})`
  return (
    <span
      class={cn(
        'relative box-border inline-flex h-[15px] max-w-full min-w-0 shrink-0 items-center gap-[1.5px] rounded-full border-[0.5px] border-solid pr-[2.5px] text-[10px] leading-none whitespace-nowrap select-none',
        medal.guardIcon ? 'pl-[16.5px]' : 'pl-[3.5px]',
        className
      )}
      style={{
        // B站 paints the gradient twice (the pill and its hairline-border overlay), so the translucent fills read denser.
        backgroundImage: `${gradient}, ${gradient}`,
        borderColor: medal.colorBorder,
        color: medal.colorText,
      }}
    >
      {medal.guardIcon && (
        <img src={medal.guardIcon} alt='' class='absolute top-1/2 -left-[4.5px] size-[20px] -translate-y-1/2' />
      )}
      <span class='min-w-0 truncate'>{medal.medalName}</span>
      {/* `fonteditor` is the digit font B站's live page already loads for its own medal levels. */}
      <span class='shrink-0 font-[family-name:fonteditor,sans-serif] text-[11px] font-medium tracking-[-0.3px]'>
        {medal.level}
      </span>
    </span>
  )
}
