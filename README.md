# LAPLACE Chatterbox

A userscript for Bilibili Live that adds danmaku (chat message) utilities — auto-send loops, speech-to-text, meme lists, AI evasion, Copy Ninja multi-account mirroring, and more.

## Install

Requires a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).

Install from [LAPLACE Live!](https://laplace.live/chatterbox).

Copy Ninja (拷贝忍者) also needs [kakashi-server](apps/kakashi-server) running on the same machine.

## Layout

| Package                                                  | What                                                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [`apps/chatterbox`](apps/chatterbox)                     | The userscript (`laplace-chatterbox`)                                                                           |
| [`apps/kakashi-server`](apps/kakashi-server)             | Copy Ninja relay, shipped as signed standalone binaries                                                         |
| [`packages/kakashi-protocol`](packages/kakashi-protocol) | WebSocket protocol shared by the two                                                                            |
| [`packages/chatterbox-sdk`](packages/chatterbox-sdk)     | `@laplace.live/chatterbox-sdk` on npm: lets a web page such as LAPLACE Chat send danmaku through the userscript |

## Development

```bash
bun install
bun run dev          # userscript dev server
bun run dev:server   # kakashi-server in watch mode
bun run lint && bun run typecheck && bun test
bun run build        # userscript → apps/chatterbox/dist
bun run build:sdk    # SDK → packages/chatterbox-sdk/dist (in-repo code imports its source)
```

## Releasing

Releases use [changesets](https://github.com/changesets/changesets). Run `bunx changeset` to describe a change. On merge to master, the Release workflow keeps a Version Packages PR open. Merging that PR:

- tags each bumped package and publishes its GitHub Release;
- deploys the userscript when `laplace-chatterbox` was bumped;
- publishes `@laplace.live/chatterbox-sdk` to npm when it was bumped;
- builds and signs the server binaries when `@laplace.live/kakashi-server` was bumped, then publishes its release with them attached.

Releases are immutable once published (enforced for the laplace-live org), so every release is published whole: nothing can be attached afterwards.

## Credits

- The auto-seek (自动追帧) algorithm — buffer thresholds, speed ladder,
  slowdown semantics, and default values — is adapted from c-basalt's
  [`Bilibili 直播自动追帧`](https://github.com/c-basalt/bilibili-live-seeker-script)
  userscript (GPL-3.0). Our reimplementation is event-driven rather than
  interval-polled and shares no code with the upstream, but the algorithm
  belongs to them.

## License

AGPL-3.0
