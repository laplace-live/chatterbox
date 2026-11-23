---
"@laplace.live/chatterbox-sdk": minor
---

First release of `@laplace.live/chatterbox-sdk`, the page protocol and `ChatterboxClient` that let a web page such as LAPLACE Chat send danmaku through LAPLACE Chatterbox: it tracks whether the userscript's bridge is on the page and whether 允许控制台通过本脚本发送弹幕 is on, and sends text from the viewer's open live-room tab with progress and a per-send result. The userscript speaks the same protocol from this package, so the two can't drift apart.
