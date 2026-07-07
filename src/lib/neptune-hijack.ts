import { unsafeWindow } from '$'
import { installNeptuneBlockTrap } from './neptune-block'
import { unlockLiveBlock } from './store'

// `block_info.block` ships only in live rooms' SSR `__NEPTUNE_IS_MY_WAIFU__`.
if (location.hostname === 'live.bilibili.com') {
  console.log('[LAPLACE Chatterbox] neptune-hijack loaded')
  installNeptuneBlockTrap(unsafeWindow, () => unlockLiveBlock.value)
}
