# LAPLACE Kakashi Server

The local relay behind Copy Ninja (拷贝忍者) in [LAPLACE Chatterbox](https://laplace.live/chatterbox). Log a different Bilibili account into each browser or browser profile, connect them all to this server, and the mirror accounts (分身) copy what the master account (主控) sends.

## How it works

- Every live-room tab running Chatterbox connects over WebSocket and reports its account, room and role.
- When the master's send succeeds, the server delivers it to exactly one tab per mirror account in that room. The master's own tabs never receive it back.
- Each mirror decides locally what to do with it: which actions to follow (常规发送, 独轮车, …), how much to decay (randomly skip a share and add a random delay), whether to reword it through its own LLM (感知忍術) instead of copying it verbatim, and whether to follow the master into other rooms.
- Mirrors report each result back to the master's panel.
- Only one master account is active at a time. A second account set to 主控 waits on standby. The master's seat is held for 15 s while it reloads, so a page reload doesn't hand control to the standby.
- Cookies and CSRF tokens never leave the browser. The server only relays the final message text and room id.

## Download

Grab the binary for your platform from the [releases](https://github.com/laplace-live/chatterbox/releases) tagged `@laplace.live/kakashi-server@…`. Windows builds are Authenticode-signed; macOS builds are signed and notarized.

```bash
# macOS / Linux
chmod +x ./kakashi-server-darwin-arm64
./kakashi-server-darwin-arm64
```

On Windows, double-click `kakashi-server-windows-x64.exe`. Keep the console window open while you use Copy Ninja.

## Usage

```
kakashi-server [--port 9697] [--host 127.0.0.1] [--token <token>] [--allow-origin <origin>] [--debug]
```

| Flag             | Env                     | Default     | Notes                                                  |
| ---------------- | ----------------------- | ----------- | ------------------------------------------------------ |
| `--port`         | `KAKASHI_PORT`          | `9697`      |                                                        |
| `--host`         | `KAKASHI_HOST`          | `127.0.0.1` | Anything but loopback requires `--token`               |
| `--token`        | `KAKASHI_TOKEN`         | (none)      | Every tab must send it (Chatterbox → 忍者 → 令牌)      |
| `--allow-origin` | `KAKASHI_ALLOW_ORIGINS` | (none)      | Extra WebSocket origins; repeatable or comma-separated |
| `--debug`        | `DEBUG=1`               | off         | Logs every copy result and follow                      |

Then, in each browser, open a Bilibili live room → Chatterbox → **忍者** tab:

1. Tick **启用拷贝忍者**. The default address `ws://127.0.0.1:9697` matches the server defaults.
2. Set one account to **主控** and leave the others as **分身**.
3. On each 分身, pick the actions to follow, the decay %, and the delay range. Tick **感知忍術** to have that mirror reword each copy with its LLM prompt (设置 → LLM 提示词 → 感知忍術).

`GET http://127.0.0.1:9697/` returns `{ name, version, protocol }`, which is handy to check the server is up.

## Things to know

- **Run it on the same machine as the browsers.** Bilibili pages are HTTPS, and browsers only let them open unencrypted WebSockets to loopback, so browsers on other machines would need `wss://` behind a TLS proxy.
- **Chrome asks once per profile.** Chrome 147+ shows a "local network access" prompt the first time a live room connects to the server. Allow it. If you denied it, re-enable it in the site settings for live.bilibili.com.
- **Origins are checked.** The server only accepts handshakes from `https://live.bilibili.com`, so other websites, sandboxed pages and unrelated extensions can't connect and drive your accounts. If your userscript manager connects from its own extension origin instead, the server logs the rejected origin. Allow that exact origin with `--allow-origin`.
- **Keep mirror tabs alive.** Background tabs get throttled and Chrome's Memory Saver may discard them. Exempt live.bilibili.com if mirrors drop out.
- **Mirrors pause themselves** after 3 consecutive failed copies (mute, risk control). Resume from the 忍者 tab.
- **Decay and 感知忍術 are not anonymity.** They make copies less alike in content and timing. Bilibili can still link accounts by IP and device, so mirror accounts can get muted or banned.

## Development

```bash
bun run dev:server            # from the repo root, watch mode with --debug
bun test apps/kakashi-server
bun run build:server          # host binary in apps/kakashi-server/dist
bun run --cwd apps/kakashi-server build --all   # every release target
```

The wire protocol lives in [`@laplace.live/kakashi-protocol`](../../packages/kakashi-protocol). Bump `PROTOCOL_VERSION` on breaking changes; mismatched peers are refused with a readable error.

## License

AGPL-3.0
