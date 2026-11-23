---
"laplace-chatterbox": minor
---

Let the LAPLACE Chat dashboard send superchats as danmaku through Chatterbox: with the new 允许控制台通过本脚本发送弹幕 setting on (设置 → 功能切换 → LAPLACE Chat 控制台, off by default), the dashboard's 作为弹幕发送 menu item hands the superchat's text to the tab where that live room is open, which sends it as the logged-in account through the same send queue, replacement rules and AI 规避 as 常规发送, wrapping every segment in 【】 and splitting at the room's length cap. Superchats relayed back to back go out one after another without interleaving their segments, and Copy Ninja mirrors don't copy them. To bridge the two pages through userscript storage, the userscript now also runs on the dashboard's sites (chat.laplace.live, chat-dev.laplace.live, chat.vrp.moe, laplace.chat), where it adds no UI and leaves the page's network responses alone; cookies never leave the browser. Settings backups skip the bridge's temporary state.
