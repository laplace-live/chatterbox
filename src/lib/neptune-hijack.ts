import { effect } from '@preact/signals'

import { unsafeWindow } from '$'
import { createLiveBlockPill } from './live-block-pill'
import { installNeptuneBlockTrap } from './neptune-block'
import { unlockLiveBlock } from './store'

// `block_info.block` ships only in live rooms' SSR `__NEPTUNE_IS_MY_WAIFU__`.
if (location.hostname === 'live.bilibili.com') {
  console.log('[LAPLACE Chatterbox] neptune-hijack loaded')

  // Own pill instance (distinct id from fetch-hijack's forbid_live pill) so the two
  // block bypasses never remove each other's indicator.
  const pill = createLiveBlockPill({
    id: 'laplace-chatterbox-room-block-indicator',
    text: '✽ 屏蔽已解锁',
    title: 'LAPLACE 直播助手已解除该直播间的展示限制',
  })

  installNeptuneBlockTrap(
    unsafeWindow,
    () => unlockLiveBlock.value,
    () => pill.ensure(() => unlockLiveBlock.value)
  )

  // Toggle-off drops the pill immediately; re-shows on next refresh.
  effect(() => {
    if (!unlockLiveBlock.value) pill.remove()
  })
}
