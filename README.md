# LAPLACE Chatterbox

A userscript for Bilibili Live that adds danmaku (chat message) utilities — auto-send loops, speech-to-text, meme lists, AI evasion, and more.

## Install

Requires a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).

Install from [LAPLACE Live!](https://laplace.live/chatterbox).

## Credits

- The auto-seek (自动追帧) algorithm — buffer thresholds, speed ladder,
  slowdown semantics, and default values — is adapted from c-basalt's
  [`Bilibili 直播自动追帧`](https://github.com/c-basalt/bilibili-live-seeker-script)
  userscript (GPL-3.0). Our reimplementation is event-driven rather than
  interval-polled and shares no code with the upstream, but the algorithm
  belongs to them.

## License

AGPL-3.0
