# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository builds a Bilibili Live userscript named `弹幕助手 · 替你说，替你看` (Greasy Fork title still reads `B站独轮车 + 自动跟车` for SEO). Originally forked from [LAPLACE Chatterbox](https://github.com/laplace-live/chatterbox); product direction has diverged enough that wholesale sync is no longer practical, but **upstream cherry-picks are still welcome on a case-by-case basis** — if LAPLACE ships a bug fix or feature that's a clean win, port it. There is no formal "we are independent now" stance to defend; that kind of declaration only closes doors.

### Target user (anchor for every product decision)

**Heavy-active Bilibili-live viewer at shadow-ban / mute / blacklist risk.** Daily live-room dweller, very active in danmaku. Because they send a lot, they regularly get rate-limited, muted, shadow-banned, or blacklisted by streamers — so they need:

1. **Send-side acceleration**: auto-send loops (独轮车), auto-follow (跟车), one-line manual send (手动发送), +1, AI 润色, shadow-ban auto-rewrite.
2. **Self-defense visibility**: fan-medal inspection to see *which rooms have muted/restricted/blacklisted them today*.
3. **Better-reading affordance**: Chatterbox Chat for a cleaner right-side chat.

**Note on Guard Room / live-desk modules**: an earlier audit (2026-05-15) misread these as "guild administrator tooling" and queued them for spin-off. That was wrong. The real audience for Guard Room sync + live-desk heartbeat + monitoring-room agent is **the same heavy-active viewer above, watching multiple rooms simultaneously and hopping between them** — they need cross-room state sync, cross-tab handoff, and remote-pushed presets so all their open chatterbox instances stay coordinated. The spin-off has been reverted (`docs/guard-room-spinoff-plan.md` carries a DECISION REVERSED banner). The user-facing terminology ("保安室 / 监控室代理") **stays**: it's a deliberately concrete metaphor — picture an old guy sitting in a security guard's room watching N monitors and switching attention between them, which is exactly what a multi-room viewer does. The Apple-style precedent is Finder / Time Machine / Mission Control / Dashboard: a vivid noun beats a generic functional label every time. Don't flatten these names into "多房间观察台" or "跨房间挂机" — those describe the function, the original names evoke the experience.

**When in doubt about whether to add / keep a feature, ask:** *does this serve the heavy-active viewer who's worried about getting silenced?* If yes, keep it; if no, defer or remove from main UI surface.

### Capability surface

The product does **two things**: 替你说 (send) + 替你看 (read).

**替你说 (Tier 1, primary):**
- auto-send loops (`独轮车`)
- repeated-danmaku auto-follow (`自动跟车`) with broadcast verification
- one-line manual send (`手动发送`, formerly `普通发送`) with optional AI 润色 (single switch, user-supplied prompt via `PromptManager`) and shadow-ban candidates

**替你看 (Tier 1, supporting):**
- Chatterbox Chat — custom right-side live chat replacement (WS + DOM fallback, dark mode aware)
- fan-medal room mute/restriction inspection — slated to surface as a `我的状态` main-panel section

**Supporting / background machinery (Tier 2, mostly invisible to the user):**
- Smart Auto-Drive (`智能辅助驾驶`) — heuristic + optional LLM meme picker that runs alongside auto-follow
- Shadow-ban subsystem: send-broadcast verification, candidate rewrites, persistent observations, rule auto-learning (all backgrounded; no user-facing rule-editing UI)
- Multi-source meme library: LAPLACE + SBHZM + chatterbox-cloud aggregator + per-room community sources
- Soniox speech-to-text (`同传`)
- LLM provider matrix (Anthropic, OpenAI, OpenAI-compatible base URL) used by AI 润色 + AI evasion + Smart Auto-Drive

**Multi-room observation (`guard-room-*`, `live-desk-sync`):**
- Cross-room state sync to `bilibili-guard-room.vercel.app` dashboard so a viewer running chatterbox in N tabs / devices sees aggregated state in one place.
- Live-desk heartbeat from each room.
- Monitoring-room agent that pulls a unified control profile (auto-blend preset, dry-run, heartbeat cadence) and applies it to every chatterbox instance bound to the same sync key.
- URL handoff (`?guard_room_*` query params) so dashboard links can land you on a room with the right config pre-armed.

Most UI text is Chinese. Keep Markdown, HTML, and TypeScript files encoded as UTF-8.

## Development Commands

```bash
# Install dependencies
bun install

# Start development server
bun run dev

# Build production userscript and static release page
bun run build

# Preview production build
bun run preview

# Run client/userscript tests (bun, isolated, scoped to tests/)
bun run test:client

# Run server / chatterbox-cloud tests (vitest + @cloudflare/vitest-pool-workers)
bun run test:server

# Full release gate (mirrors CI): biome ci + client tests + server tests + version + build + artifact + bundle budget
bun run check

# Focused checks
bun run test:auto-blend
bun run verify:auto-blend-ui

# Property-based fuzz tests (fast-check). Default 100 runs/property; bump
# via FAST_CHECK_NUM_RUNS=N. CI runs 200 on PR, 10000 on weekly cron.
bun run test:fuzz

# Long-running soak: drives synthetic high-volume traffic through bounded
# data structures (FetchCache LRU, etc.) and asserts they stay within
# their declared cap. Default 30s; SOAK_DURATION_MS=300000 for 5 min.
bun run soak:cache

# HTTP load test against a running chatterbox-cloud backend (defaults to
# local wrangler dev on :8787). NEVER point at production. See
# scripts/load-test-backend.mjs for env knobs (LOAD_DURATION,
# LOAD_CONNECTIONS, LOAD_SCENARIO, LOAD_MAX_P99_MS).
bun run loadtest:server
```

Do NOT run bare `bun test` from the repo root. It (a) drops `--isolate`, so `mock.module(...)`
calls leak across test files, and (b) un-scopes discovery so it tries to load `server/src/**/*.test.ts`
under the bun runner, which fails on `import 'cloudflare:test'` (that module only exists inside the
Cloudflare Workers test pool). Use `bun run test:client` or `bun run test:server` instead.

The build output is written to `dist/`. The main userscript output is `dist/bilibili-live-wheel-auto-follow.user.js`.

## Architecture Overview

### Core Structure

- `src/main.tsx` mounts the app at `document-start` after the document body is available.
- `src/components/app.tsx` is the main application shell.
- `src/components/configurator.tsx` renders the floating panel and tab content.
- `src/components/*` contains feature UI for sending, auto-send, auto-follow, STT, settings, logs, memes, and about.
- `src/lib/*` contains the userscript integrations, Bilibili API helpers, state, send queue, replacement logic, custom chat, and auto-follow runtime.
- `src/types.ts` contains TypeScript interfaces for Bilibili/live-room data.
- `public/index.html` is the GitHub Pages / release landing page. Keep its copy aligned with `README.md`.

### Key Modules

Modules are grouped by subsystem. When adding a new file, drop it next to its peers and update this list.

#### State (`store-*.ts`, `gm-signal.ts`)

- `src/lib/store.ts` re-exports domain store modules and keeps only small cross-domain runtime glue. Add new persisted signals to the closest `store-*.ts` domain file (`store-auto-blend`, `store-chat`, `store-guard-room`, `store-hzm`, `store-meme`, `store-replacement`, `store-send`, `store-shadow-learn`, `store-stt`, `store-ui`) instead of growing `store.ts`.
- `src/lib/gm-signal.ts` binds `@preact/signals` to GM_getValue/setValue with type guards and clamping. All persisted state should go through it; do not move userscript settings into browser `localStorage`.

#### Auto-follow (`auto-blend-*.ts`)

- `src/lib/auto-blend.ts` is the auto-follow runtime: subscribes to `danmaku-stream`, runs windowed repetition + distinct-uid gates, applies cooldown and trend gating, and routes the chosen send through `verifyBroadcast` for shadow-ban handling.
- `src/lib/auto-blend-presets.ts` + `auto-blend-preset-config.ts` define `稳一点 / 正常 / 热闹` and the "Custom" preset that snapshots current values.
- `src/lib/auto-blend-status.ts` formats the status line shown in the auto-blend panel.
- `src/lib/auto-blend-trend.ts` implements trend / changepoint scoring for "this meme is heating up".
- `src/lib/auto-blend-blacklist.ts` is the in-memory UID blacklist used by the trend filter.
- `src/lib/auto-blend-toggle.ts` orchestrates start/stop side effects so the React/Preact tree only flips a signal.
- `src/lib/auto-blend-events.ts` is the internal event/log bridge. Prefer emitting events here over adding direct `appendLog()` calls inside `auto-blend.ts`.

#### Auto-send loop (`loop.ts`)

- `src/lib/loop.ts` handles auto-send loop behavior (the original 独轮车).
- `src/lib/loop-utils.ts` holds pure helpers (interval jitter, line splitting, color/character randomization) so `loop.ts` stays orchestration-only.

#### Smart Auto-Drive (`hzm-*`, `llm-driver.ts`)

- `src/lib/hzm-auto-drive.ts` is the meme-driver runtime: subscribes to `danmaku-stream`, runs activity-gate + pause-keyword + per-minute rate limit, picks a meme (heuristic by default; LLM every N ticks when `hzmDriveMode === 'llm'`), and enqueues via `send-queue` with `SendPriority.AUTO`. Coexists with `auto-blend` and `loop` through the shared queue.
- `src/lib/hzm-drive-status.ts` formats the status text shown in the HZM panel.
- `src/lib/llm-driver.ts` is the lazy-imported LLM client (Anthropic / OpenAI / OpenAI-compatible). Routed through `gm-fetch` to avoid CORS. Hard-caps the candidate count it ships in the prompt.
- `src/lib/store-hzm.ts` holds all HZM state (mode, dryRun, interval, rate limit, pause keywords, LLM key/model/baseURL, per-room selected/blacklist tags, recent sends, daily counters).

#### Send pipeline (`send-queue.ts`, `send-verification.ts`, `danmaku-*`, `ai-evasion.ts`, `replacement.ts`, `shadow-*`)

- `src/lib/send-queue.ts` serializes all send attempts into a single FIFO with priorities, preventing overlapping danmaku sends across loop / auto-blend / HZM / manual paths.
- `src/lib/send-verification.ts` exposes `waitForSentEcho` and `verifyBroadcast`: API success + WS/DOM echo wait. All four send paths route through this so a `code: 0` shadow-ban gets a `⚠️` log entry instead of being treated as success.
- `src/lib/danmaku-actions.ts` owns `sendManualDanmaku` and friends used by the panel and `+1`/steal buttons.
- `src/lib/danmaku-direct.ts` injects the inline `+1` / steal / copy buttons next to chat messages; `danmaku-direct-helpers.ts` holds pure helpers.
- `src/lib/replacement.ts` builds remote/local replacement maps. Remote keywords go through `remote-keywords-fetch.ts` + `remote-keywords-sanitize.ts` (size cap, length validation, type guards).
- `src/lib/ai-evasion.ts` checks and rewrites blocked danmaku via the configured LLM provider when AI evasion is enabled.
- `src/lib/shadow-suggestion.ts` produces heuristic rewrite candidates (`invisible` / `kou` / `space`) without calling any model.
- `src/lib/shadow-learn.ts` is the persistence side: when enabled, it promotes AI-evaded sensitive words into `localRoomRules` and mirrors them to Guard Room. `recordShadowBanObservation` accumulates observations into a capped persistent list. Both are no-ops when their respective gm-toggles are off — gating lives here, not at every callsite.
- `src/lib/store-shadow-learn.ts` owns the toggles (`autoLearnShadowRules`, `shadowBanMode: 'suggest' | 'auto-resend'`) and the observation list.

#### Meme library (`meme-*`, `*-client.ts`)

- `src/lib/meme-fetch.ts` is the main meme aggregator: fans out to LAPLACE + SBHZM + chatterbox-cloud + room-specific sources, per-source failure tolerance, unified sort by `sortBy`. Tests inject deps via `_setMemeFetchDepsForTests` (the same DI hook pattern as `gm-fetch`).
- `src/lib/meme-sources.ts` is the room-keyed source registry. Built-in (e.g. 灰泽满直播间) ships with the code; user entries via the `userMemeSources` GM key override the built-in for the same roomId.
- `src/lib/meme-room-filter.ts` filters backend-aggregated memes per room (e.g. SBHZM-exclusive memes only show in the SBHZM room).
- `src/lib/meme-content-key.ts` produces the cross-source dedup key (so the same meme from LAPLACE and chatterbox-cloud collapses into one).
- `src/lib/meme-contributor.ts` mines candidate memes from live danmaku for the contribution panel.
- `src/lib/laplace-client.ts` calls LAPLACE (`workers.vrp.moe`) over native fetch (CORS works) with a 30s `FetchCache`.
- `src/lib/sbhzm-client.ts` calls `sbhzm.cn` over `gm-fetch` (no CORS); pages and dedups, normalizes to LAPLACE shape with synthesized negative ids to avoid collisions, 30 min in-memory cache.
- `src/lib/sbhzm-freshness-probe.ts` checks SBHZM upstream freshness for the chatterbox-cloud cron mirror.
- `src/lib/cb-backend-client.ts` is the chatterbox-cloud client. Routed through `gm-fetch` for parity with `sbhzm-client` and to make local dev (`localhost:8787`) work without CORS.
- `src/lib/radar-report.ts` — opt-in trending-cluster observation aggregator. Subscribes to danmaku-stream + custom-chat-events while `radarReportEnabled` (default off) is true; per-message gate requires roomId + channelUid + lookupTrendingMatch hit. Buffers ≤30 deduped texts, flushes every 60s fire-and-forget to `/radar/report`. Drops buffer on toggle-off or room change. Lifecycle: `startRadarReportLoop()` is called once at boot from `components/app.tsx`.

#### Chatterbox Chat (`custom-chat-*`, `emote-*`)

- `src/lib/custom-chat.ts`, `custom-chat-dom.ts`, `custom-chat-events.ts`, `custom-chat-render.ts`, and `custom-chat-search.ts` implement Chatterbox Chat.
- `custom-chat-style.ts`, `custom-chat-virtualizer.ts`, `custom-chat-native-adapter.ts`, and `custom-chat-interaction.ts` hold extracted Custom Chat infrastructure. Keep future CSS, virtualization math, native DOM filtering, and button/a11y primitives there.
- `custom-chat-dom.ts` uses one shared RAF dispatcher for render/rerender work and debounces native DOM fallback scans. Keep new high-frequency UI work on that scheduler instead of adding standalone RAF loops.
- `src/lib/custom-chat-css-sanitize.ts` sanitizes user-supplied custom CSS (drops `@import`, hostile `url(...)` schemes, `expression(`, `behavior:`, caps total length to 256 KB) before it touches the stylesheet.
- `src/lib/custom-chat-presets.ts` holds named CSS presets (currently `MILK_GREEN_IMESSAGE_CSS`).
- `src/lib/custom-chat-pricing.ts`, `custom-chat-emoticons.ts` cover gift/SC pricing display and emoticon rendering.
- `src/components/emote-picker.tsx`, `emote-picker-mount.tsx`, `emote-picker-position.ts` are the portal-rendered emoji picker (lazy-loaded, no `backdrop-filter` clipping).
- See [docs/custom-chat-dom-refactor-plan.md](docs/custom-chat-dom-refactor-plan.md) for the in-progress decomposition of `custom-chat-dom.ts`.

#### Live event ingestion (`live-ws-source.ts`, `danmaku-stream.ts`, `fetch-*.ts`, `gm-fetch.ts`)

- `src/lib/live-ws-source.ts` connects directly to Bilibili Live WebSocket events. On close/error it sets `liveWsStatus.value = 'closed' | 'error'`, surfacing the WS-degraded banner and `⚠️` chip on the 发送 tab. Re-arms automatically on `visibilitychange` to recover from bfcache / mobile background freezes.
- `src/lib/danmaku-stream.ts` is a single shared `MutationObserver` over `.chat-items` with reference-counted lifecycle. Both `danmaku-direct` and `auto-blend` / HZM subscribe here so we don't run multiple observers on the same DOM node.
- `src/lib/fetch-hijack.ts` intercepts relevant XHR/Response prototypes early (with sentinels to avoid double-wrapping).
- `src/lib/gm-fetch.ts` wraps `GM_xmlhttpRequest` so cross-origin calls (LLM providers, `sbhzm.cn`, chatterbox-cloud, Guard Room) work without CORS. Tests inject a fake via `_setGmXhrForTests` — do not `mock.module('./gm-fetch')`, that pattern leaks across files in bun.
- `src/lib/fetch-cache.ts` is a generic TTL cache + in-flight dedup helper, used by `laplace-client`, `cb-backend-client`, etc. Failures don't enter the cache.

#### Bilibili API (`api.ts`, `wbi.ts`, `emoticon.ts`, `user-blacklist*.ts`)

- `src/lib/api.ts` wraps Bilibili live APIs: danmaku sending, room info, fan-medal rooms, restriction checks, anchor lookup. Uses `concurrency.mapWithConcurrency` to fan out without flooding endpoints.
- `src/lib/wbi.ts` handles Bilibili WBI signing.
- `src/lib/emoticon.ts` owns emoticon lookup, locked-emoticon detection, and rejection log text. Do not reintroduce emoticon helpers into `store.ts`.
- `src/lib/user-blacklist.ts` injects the auto-follow blacklist toggle into Bilibili's danmaku menu; `user-blacklist-parsers.ts` holds the pure parsers. Auto-follow / HZM must ignore blacklisted UIDs.
- `src/lib/moderation.ts` recursively scans risk-control / moderation fields with cycle protection.

#### Guard Room (`guard-room-*`, `live-desk-sync.ts`)

- `src/lib/guard-room-sync.ts` is the low-level sync client (POSTs summaries / shadow rules / live-desk heartbeats; HTTPS-only except loopback).
- `src/lib/guard-room-agent.ts` is the agent runtime: applies a Guard Room control profile (auto-blend preset, dry-run, heartbeat cadence, hot thresholds), syncs the watchlist of medal/follow rooms.
- `src/lib/guard-room-handoff.ts` reads `?guard_room_source=guard-room&guard_room_mode=...&guard_room_autostart=1` query params on page load to take over the live page (e.g. start auto-blend in dry-run).
- `src/lib/guard-room-live-desk-state.ts` holds live-desk runtime signals (session id, heartbeat, current risk level, watchlist).
- `src/lib/live-desk-sync.ts` runs the heartbeat loop based on custom-chat events.

#### Cross-cutting (`log.ts`, `app-lifecycle.ts`, `concurrency.ts`, `clipboard.ts`, `platform.ts`, `version-update.ts`, `backup.ts`)

- `src/lib/log.ts` owns `appendLog()` plus `notifyUser(level, message, detail?)` and the debug-log toggle. User-facing failures must use `notifyUser` instead of `alert()`.
- `src/lib/app-lifecycle.ts` keeps App-level side effects (panel styles, Custom Chat room rearm, optimized layout style, dark-mode listener) out of the Preact shell.
- `src/lib/concurrency.ts` exposes `mapWithConcurrency` (used by `api.ts`).
- `src/lib/clipboard.ts` is the cross-browser clipboard helper (Clipboard API → hidden textarea + `execCommand` fallback for HTTP / Firefox+Violentmonkey / older engines).
- `src/lib/platform.ts` detects mobile UA and emits a single console warning (it does not block the script).
- `src/lib/version-update.ts` decides whether to show the "🆕 已更新" badge on the About tab.
- `src/lib/backup.ts` powers the backup export/import section: per-field type validation, version-cap rejection, JSON parser error surfacing, drop-list of unrecognized keys.

#### UI primitives (`components/ui/`, `components/settings/`)

- `src/components/ui/` holds shared primitives (`button`, `textarea`, `native-select`, `alert-dialog`). Use these instead of bare HTML when adding new settings.
- `src/components/settings/` is the per-section split (custom-chat, danmaku-direct, layout, replacement, shadow-observation, medal-check, cb-backend, backup). Each section accepts a `query` prop for the keyword search filter; `visible` is computed from a search-friendly string.
- `src/components/error-boundary.tsx` wraps the app shell so a render error doesn't take down the whole panel.

### UI Notes

The floating panel has **no top-level Tab bar**. It's a single-page waterfall with a sticky status header. Settings and About are sub-pages reached via icon buttons, not Tabs.

- **Panel header** ([`src/components/panel-header.tsx`](src/components/panel-header.tsx)): sticky at top of the scrolling dialog. Shows "弹幕助手 · {roomId} · WS{dot}" + activity chips (独轮车/跟车/智驾/同传; dry-run variants in orange) + WS-degraded banner + ⚙ (settings) + ⓘ (about) icon buttons. On settings/about sub-pages it switches to a "← 返回" + page-title layout.
- **Activity chips** replace the old per-tab decorations (`· 车 / · 跟 / · 智 / · 开 / ⚠️`). Tab Bar with these decorations no longer exists — `tabs.tsx` is deleted.
- **Routing** still uses the `activeTab` signal for backward compatibility (callers like `onboarding.tsx`, `yolo-callout.tsx`, `hzm-drive-panel.tsx`, `danmaku-actions.ts` keep their `activeTab.value = 'settings' | 'about' | 'fasong'` calls). Valid values now: `'fasong'` (home waterfall), `'settings'` (drawer), `'about'` (drawer). Legacy `'tongchuan'` is auto-migrated to `'fasong'` on first render.
- **Three core primitive cards on the home page**, each visually paired with its supporting widget through a `<section class="cb-core-group">` wrapper:
  - `AutoSendControls` (独轮车) + `MemesList` as a `<details class="cb-supporting-feature">` summary "📚 从烂梗库挑模板"
  - `AutoBlendControls` (自动跟车) + `HzmDrivePanelMount` (智驾) as "🤖 用 LLM 选梗"
  - `NormalSendTab` (手动发送, formerly 普通发送/常规发送; +1 / 复制 / 影子屏蔽候选) + `SttTab` (同传) as "🎤 语音输入弹幕"
  Supporting features are visually subordinate (smaller, indented, dimmer background) — the design encodes "X serves Y" through layout, not through equal Tabs.
- **Settings page** ([`src/components/settings-tab.tsx`](src/components/settings-tab.tsx)): default view shows only 5 essential sections (Chatterbox Chat, +1 直接动作, 布局, 表情, 备份/恢复). A "▸ 显示高级设置" button reveals 10+ advanced sections (智能识别 / 替换规则 / 影子屏蔽 / LLM / 粉丝牌巡检 / chatterbox-cloud 后端 / 雷达 / 日志). Search query overrides the toggle — typing in the search box always matches across all sections. State lives in `settingsAdvancedVisible` ([`store-ui.ts`](src/lib/store-ui.ts)).
- **Esc key two-stage behavior** ([`src/components/toggle-button.tsx`](src/components/toggle-button.tsx)): on a sub-page (settings/about), Esc returns to home; on home, Esc closes the panel. Editable-field focus suppresses both (so Esc still clears inputs).
- `Onboarding` shows on the first panel open and offers a one-click 新手配置.
- `ShadowBypassChip` renders the candidate-rewrite chips next to the input in `NormalSendTab` when a shadow-ban is suspected — by default it suggests, never sends.
- Chatterbox Chat themes are `iMessage Dark` (`laplace`), `iMessage Light` (`light`), and `Compact Bubble` (`compact`); plus the milk-green iMessage CSS preset in `src/lib/custom-chat-presets.ts` that the user can apply into the custom-CSS textarea. The connection-status dot is green when the WS is healthy, animated orange while connecting, solid orange on fallback / warning.
- Dark mode: when the user's OS prefers dark, the panel, settings, panel-header, supporting-feature surfaces, and inputs flip to an iOS-style dark palette. Honor `prefers-color-scheme` instead of hard-coding light values when adding new visual surfaces. All dark overrides live in the `@media (prefers-color-scheme: dark)` block in [`src/lib/app-lifecycle.ts`](src/lib/app-lifecycle.ts).
- Accessibility: panel-header sub-page mode uses a back button with `aria-label='返回主页'`; activity chips use `role='status' aria-live='polite'`; controls have `:focus-visible` rings; the panel two-stage-Escapes (sub-page → home → close) but lets default behavior through when an input is focused.
- Keep the floating panel compact: it is meant to sit inside Bilibili Live's right-side area. Max height is 70vh (bumped from 50vh because the unified waterfall needs more vertical room than the old per-tab view).
- Panel styling now uses a mix of legacy `cb-*` classes and UnoCSS `lc-*` utilities. UnoCSS is configured with a prefix and no global reset; never add unprefixed utility classes that could leak into Bilibili's page.

## State and Persistence

- Reactive state uses `@preact/signals`.
- Persistent settings use GM storage through `src/lib/gm-signal.ts`; do not move persistent userscript data into browser `localStorage`.
- Runtime-only state should remain signal-based and should avoid expensive synchronous work in hot paths.
- Long-running chat data structures have hard caps; preserve those caps when touching Chatterbox Chat performance code.

## Build Process

- Vite and `vite-plugin-monkey` package the userscript.
- TypeScript compilation runs before Vite in `bun run build`.
- Soniox SDK is loaded externally to keep the userscript smaller.
- `public/` assets are copied into `dist/` during build.

## CI and Release Distribution

- `bun run release:check` is the canonical local gate. It runs install, biome ci, tests, version-consistency, build, artifact validation, and bundle-budget. Run it before tagging anything; CI runs the same script.
- Pull requests and pushes to non-master branches are validated by `.github/workflows/ci.yml` (job name `validate`).
- Pushes to master that are NOT release commits deploy the GitHub Pages landing page via `.github/workflows/pages-deploy.yml`. Release commits (commit message starts with `Release `) are skipped here and handled by the tag workflow.
- `.github/workflows/release.yml` is tag-driven — it triggers on `v*` tag pushes and `workflow_dispatch`. It runs `release:check` plus a strict `--mode post --expected-tag` version-consistency check before deploying.
- When changing `release.yml`'s trigger ref class (branch ↔ tag), update the `github-pages` environment's "Deployment branches and tags" allowlist correspondingly — otherwise the job fails before any step runs with "ref is not allowed to deploy". Settings → Environments → github-pages, or `gh api -X POST repos/<owner>/<repo>/environments/github-pages/deployment-branch-policies -f name='v*' -f type='tag'`.
- Distribution to users is two-stage: GitHub Pages serves `dist/bilibili-live-wheel-auto-follow.user.js` (Tampermonkey/Violentmonkey installs read it directly), and Greasy Fork auto-syncs from the same URL on its own ~24h cycle. There is no Chrome Web Store or app-store review step — this is a userscript, not an extension.
- To make `scripts/release.ts` print the Greasy Fork URL at the end of a release, add a `"greasyfork": { "scriptId": "<id>" }` field to `package.json`. If the field is absent, the URL is just skipped.
- Branch protection on `master` is **active** as a GitHub ruleset, not just documented. Required status check: `validate`; force-push and branch deletion are blocked; repository admin role is on the bypass list so `bun run release:patch` can still push directly. Full ruleset: [docs/branch-protection.md](docs/branch-protection.md).
- Coverage policy + whitelist: [docs/coverage-policy.md](docs/coverage-policy.md).

### Security & supply-chain workflows

Findings from these tools land in the GitHub repo's **Security** tab (Code scanning + Dependabot alerts), not in PR check status. They run on PR + push + cron and are non-blocking by default; flip to required checks per-tool once their backlog is cleaned.

- **CodeQL** — provided by GitHub's default-setup CodeQL (Settings → Code security & analysis), NOT a workflow file in this repo. Default setup is mutually exclusive with an "advanced configuration" workflow; we picked default for the lower maintenance burden. To switch to a custom query suite (e.g. `security-extended`), disable default setup first, then add a workflow file with `github/codeql-action/init` + `analyze`.
- `.github/workflows/osv-scanner.yml` — OSV.dev dependency vuln scan against `bun.lock` / `server/bun.lock`. PR + push + daily cron. Distinct from Dependabot: Dependabot opens upgrade PRs; OSV-Scanner produces a current-state SARIF report so unfixed transitive vulns stay visible.
- `.github/workflows/semgrep.yml` — Semgrep with `p/security-audit`, `p/owasp-top-ten`, `p/javascript`, `p/typescript`, plus any rule files under `.semgrep/`. Drop project-specific rules into that directory (template + examples in `.semgrep/README.md`).
- `.github/workflows/gitleaks.yml` — secrets scan over commit history.
- `.github/workflows/fuzz-and-soak.yml` — fast-check fuzz + soak + autocannon load test (see test-infrastructure section).

All third-party actions are SHA-pinned with `# vX.Y.Z` annotation comments; refresh by replacing the SHA from the `gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq .object.sha` command shown next to each pin.

## External Services

The script may call these services depending on enabled features. The `@connect` allowlist is generated by `vite-plugin-monkey` from `vite.config.ts`; keep that file as the source of truth.

- `api.live.bilibili.com` for live-room APIs and danmaku sending.
- `edge-workers.laplace.cn` for AI evasion checks (LAPLACE-hosted).
- `workers.vrp.moe` for remote replacement rules and the LAPLACE meme list.
- `sbhzm.cn` — community meme source for the 灰泽满直播间 (and whatever other rooms register through `meme-sources.ts`).
- `chatterbox-cloud.aijc-eric.workers.dev` (this repo's `server/`) — self-hosted meme aggregator that mirrors LAPLACE/SBHZM and accepts community contributions. Hardcoded default in `src/lib/const.ts` (`BASE_URL.CB_BACKEND`); overridable per-user via the `cbBackendUrlOverride` GM signal. Client wrapper lives in `src/lib/cb-backend-client.ts`.
- `api.anthropic.com` and `api.openai.com` — default LLM providers for AI evasion and Smart Auto-Drive.
- Any OpenAI-compatible base URL the user fills in (DeepSeek, Moonshot, OpenRouter, Ollama, 小米 mimo, ...). The `vite.config.ts` `connect` list ends with `'*'` so Tampermonkey doesn't silently reject these — the per-domain confirmation prompt is the user's last gate.
- `api.soniox.com` and `unpkg.com` for Soniox speech-to-text.
- A user-configured Guard Room endpoint for optional fan-medal inspection summary sync, shadow-rule sharing, and live-desk heartbeat. HTTPS-only except `localhost` for dev.

## Self-hosted Backend (`server/`)

The `server/` directory holds **chatterbox-cloud**, a Cloudflare Workers + Hono + D1 service that powers the meme aggregator. It is independent from the userscript build (`bun run build` does not touch it) and ships under `package.json` `name: "chatterbox-cloud"`.

- Entry point: `server/src/index.ts`. Routes split into `server/src/routes/public.ts` (anonymous) and `server/src/routes/admin.ts` (Bearer-token gated).
- Storage: D1 with migrations under `server/migrations/`. Six tables (`memes`, `tags`, `meme_tags`, `contributions`, `api_keys`, `upstream_sbhzm_cache`).
- Auth: SHA-256-hashed admin tokens in `api_keys`. Generate via `bun run gen-admin-key` (prints plaintext + INSERT statement once).
- Cron: `*/15 * * * *` pulls SBHZM into `upstream_sbhzm_cache`; `GET /memes` reads the newest cache row.
- Local dev: `cd server && bun run dev` (wrangler dev on `:8787`); set `cbBackendUrlOverride` in the userscript settings UI to point at it.
- Detailed protocol and deploy steps: [server/README.md](server/README.md).

## Important Notes

- This is an unofficial userscript, not a Bilibili official feature.
- Be careful with automated sending behavior. Prefer conservative defaults, cooldowns, and clear UI state.
- Avoid unrelated refactors in this fork; many modules are tuned for Bilibili Live's changing DOM.
- When updating README/release-page copy, keep `README.md`, `public/index.html`, and generated `dist/index.html` in sync by running `bun run build`.
