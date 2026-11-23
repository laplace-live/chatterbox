# @laplace.live/chatterbox-sdk

Send danmaku through [LAPLACE Chatterbox](https://laplace.live/chatterbox) from a web page. The userscript runs a
bridge on [LAPLACE Chat](https://chat.laplace.live) pages and hands each send to the viewer's open live-room tab,
which posts it as the account logged in there, through the same queue, replacement rules and length splitting as a
hand-typed danmaku. The page never sees cookies.

The viewer turns this on in Chatterbox under 设置 → 功能切换 → 允许控制台通过本脚本发送弹幕.

```ts
import { ChatterboxClient } from '@laplace.live/chatterbox-sdk'

const chatterbox = new ChatterboxClient()
const sendButton = document.querySelector<HTMLButtonElement>('#send')!
// null until Chatterbox announces itself on this page; sends before that settle as `unavailable`
chatterbox.onStatusChange(status => {
  sendButton.hidden = status === null
})
chatterbox.connect()

sendButton.onclick = async () => {
  const result = await chatterbox.send(21452505, '主播晚上好', {
    wrapBrackets: true, // 【主播晚上好】
    onProgress: ({ sent, total }) => console.log(`${sent}/${total}`),
  })
  // result.status: 'sent' | 'partial' | 'failed' | 'disabled' | 'no-room-tab' | 'no-response' | 'not-logged-in' | 'busy' | 'invalid' | 'unavailable'
}
```

`parseClientMessage` and `parseBridgeMessage` validate the raw page messages for code that speaks the protocol
directly.
