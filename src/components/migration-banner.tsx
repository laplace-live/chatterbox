import { cn } from '../lib/cn'
import { DOCUMENT_URL, SELF_HOSTED_INSTALL_URL } from '../lib/const'
import { migrationNoticeDismissed } from '../lib/store'
import { Button } from './ui/button'

// Final-edition migration notice shown only in the (frozen) Greasy Fork
// build. Drives users to install the self-hosted build, which — sharing
// master's @name + @namespace — cleanly replaces this script on install.
// Lives only on the `greasyfork` branch; never merged to master.
export function MigrationBanner() {
  if (migrationNoticeDismissed.value) return null

  return (
    <div class='mx-[10px] mt-2 mb-1 rounded bg-ga1s p-2.5'>
      <div class='mb-1 font-bold'>本脚本已迁移至独立站点</div>
      <div class='mb-2 text-ga6'>Greasy Fork 版本不再更新。请安装新版以继续获得更新与新功能。</div>
      <div class='flex items-center gap-2'>
        {/* Install needs <a href> semantics so the userscript manager
            intercepts the navigation to the .user.js — Button renders a
            <button> and can't carry an href, so we mirror its default
            (brand) variant classes here. */}
        <a
          href={SELF_HOSTED_INSTALL_URL}
          target='_blank'
          rel='noopener'
          class={cn(
            'inline-flex items-center justify-center gap-1 rounded',
            'border border-brand border-solid bg-brand px-2.5 py-1 text-white no-underline',
            'cursor-pointer select-none whitespace-nowrap leading-[1.2] transition',
            '[&:active]:brightness-[.9] [&:hover]:brightness-[.96]'
          )}
        >
          立即安装新版
        </a>
        <a href={DOCUMENT_URL} target='_blank' rel='noopener' class='text-link no-underline'>
          迁移说明
        </a>
        <Button
          variant='ghost'
          size='sm'
          className='ml-auto'
          onClick={() => {
            migrationNoticeDismissed.value = true
          }}
        >
          知道了
        </Button>
      </div>
    </div>
  )
}
