# laplace-chatterbox

## 5.0.1

### Patch Changes

- 25c939c: Move audio-only volume slider and controls (`AudioOnlyControls`) into the fold group (`StatusBarFold`) in live rooms so they collapse and expand together with streamer info items.

## 5.0.0

### Major Changes

- 8c72340: Let AI 融入 see the stream with the new 画面识别 settings (off by default). Frames are sampled locally from the player. In the default 直接看图 mode they're uploaded only when AI 融入 is about to generate: up to a few frames from the moment the streamer or chat is reacting to, one frame for a static picture, and none when nothing changed since the last upload. The model keeps a short note of what it saw, and those notes also reach 自动融入's decision model and YOLO polish. 画面描述 mode instead sends frames to a separate vision model on scene changes, about every 45 seconds and before AI 融入 rounds, turning them into text for chat models that can't take images. An experimental mode sends a short silent clip instead of frames. Vision pauses in background tabs, 仅音频 mode, or when the picture stalls.

### Minor Changes

- 6e69fba: Add Perplexity Decisions (`pplx-decider-latest`, `POST /v1/decisions`), OpenAI Decisions (`gpt-6-luna`, `POST /v1/decisions` with a single `predicate` question whose instructions carry `trueCriteria` / `falseCriteria`, since predicates have no `criteria` field) and Cloudflare Workers AI (`@cf/cloudflare/clef` on an account-scoped `…/accounts/{account_id}/ai` base that also accepts a pasted `…/ai/run/@cf/cloudflare/<model>` URL, with the REST `result` envelope unwrapped) as decision providers; rename the TypeSafe protocol to System One（TypeSafe 及兼容服务）, since Vercel AI Gateway, Liquid AI, 阿里云百炼, Ollama and other `POST /systemone` services speak it too (the stored `typesafe` id is unchanged, so saved profiles and settings backups keep working); move the OpenRouter default model from the pinned `typesafe/jev-1.13` to the `~typesafe/jev-latest` alias, leaving saved profiles on their model; report a `refusal` answer as 决策模型拒绝判断该弹幕 instead of an invalid send decision; and hide the model picker and 刷新列表 for providers without a decision-model list (Perplexity, OpenAI, Cloudflare), keeping the 模型 ID field.
- 868aa98: Add the 读空气融入 persona to AI 融入. It follows what recent viewer chat is saying and copies the room's length, slang, punctuation and mood, joining a running wave as it is instead of inventing a line of its own, and skips when there's nothing to follow or the room turns hostile. Existing users find it appended to their AI 融入 prompt list once.

  Across all personas, AI 融入 now treats the speech transcript only as a hint of what the streamer is talking about: speech recognition mishears words and turns Japanese or English into similar-sounding Chinese, so replies no longer quote it and take specific names and terms from viewer chat or the picture instead. Replies also stay consistent with the persona's own earlier messages, including review-mode candidates: a candidate you edit counts as the text actually sent, and one you skip no longer counts as said. AI 融入 also keeps the newest viewer messages that fit its context budget instead of dropping the whole viewer chat block when a busy room overflows it, and shows a taller 候选弹幕 list.

## 4.13.1

### Patch Changes

- 25a0461: Raise the floating danmaku input box and the 粉丝勋章 switcher to the 13px text the configurator and status bar popovers use (secondary details to 11px), and grow the box's default height to 84px and its minimum to 66px so the draft still shows two full lines by default and one at the minimum.

## 4.13.0

### Minor Changes

- cbdf19c: Add an optional floating danmaku input box for live rooms (Settings → 功能切换) that shares 常规发送's draft and send pipeline, can be moved and resized with its position remembered across reloads, and is shown or hidden from an icon-only status bar toggle next to the 视频 picker. Both composers gain a fans medal switcher beside 表情, drawn like B站's own medals (level colors, lit state, guard icon) and showing the medal displayed in the current room; its list loads more as you scroll, can load everything for search, and links to each streamer's space and live room and to B站's 我的勋章 page. Both composers also polish with Alt+Enter, and 常规发送 moves YOLO and its prompt picker to their own row.

### Patch Changes

- 3f0e83b: Give the configurator, popovers and nested lists slim, theme-tinted scrollbars through a shared `ScrollArea`: every configurator tab (or the whole window when 优化布局 is off), the 表情 picker's package tabs and emote grid, dropdown comboboxes, the 粉丝勋章 switcher, 烂梗库, replacement rules, 自动融入 blacklists, 同传 transcripts and AI 融入's 候选弹幕 / 最近决策. Text boxes keep their native scrollbars.

## 4.12.1

### Patch Changes

- 937e977: Reuse `FoldableInfoItems` in `AppSpace` (`space.bilibili.com`) and `AppOpus` (`www.bilibili.com/opus/*`) so the status bar's 主播信息 items fold away to the right on space and opus pages too, sharing the remembered fold state with live rooms.

## 4.12.0

### Minor Changes

- f7100bc: Add Google AI Studio (`Gemini Decisions API` / `gemini-decision-1`) as the default new decision provider (`POST /v1beta/decisions` and `GET /v1beta/models` with `x-goog-api-key` auth, reverse-proxy base URL support, and `prompt_feedback.block_reason` handling), and upgrade decision presets across Google AI Studio, TypeSafe, and OpenRouter Decisions to structured `noul` `instructions` plus optional `trueCriteria` / `falseCriteria` boundary fields mapped to each protocol's native `criteria` wire keys (`true_description` / `false_description` on Gemini, `true` / `false` on TypeSafe and OpenRouter), with curated default presets (`串子`, `暖男`, `拉踩`, `安全跟风`), automatic v1 preset migration, and a `恢复默认` preset action.

## 4.11.0

### Minor Changes

- f01d52f: Fold the status bar's 主播信息 items (魔法期 / 公会 / MCN / 用户备注) away to the right with a chevron beside the 视频 picker, and remember the last fold state across rooms and reloads.

## 4.10.0

### Minor Changes

- e3e88ef: Redesign the bottom-right status bar: split the 「ⓘ」 主播额外信息 popover into separate 魔法期 / 公会 / MCN / 用户备注 items that show their current value (fertility status, current guild and MCN name, first note line) directly on the bar with full details in each item's own popover, keep the audio-only volume slider always visible beside the mute button so hovering no longer shifts the mute target, and collapse the bar to icon-only items (with a vertical hover volume slider) whenever the expanded bar would overflow the viewport.

## 4.9.4

### Patch Changes

- c9949ba: Drop the `gateway.ai.cloudflare.com` URL rewrite for Google AI Studio (Gemini Live) STT and update the 接口地址 hint to recommend a reverse proxy (such as a Cloudflare Worker forwarding to `generativelanguage.googleapis.com`), since Cloudflare AI Gateway's Realtime WebSocket endpoint requires `cf-aig-authorization` and omits `Sec-WebSocket-Protocol` from its `101 Switching Protocols` response, causing browsers to fail the handshake per RFC 6455 §4.1.

## 4.9.3

### Patch Changes

- ce11d72: Count `getDanmakuUnits` per Unicode code point rather than UTF-16 code unit so single-codepoint astral emojis (`U+10000..U+10FFFF`) weigh `2` half-width units (`1 字`, up to 40 per 80-unit danmaku) instead of `4` units (`2 字`), and use grapheme count for the 常规发送 character counter.

## 4.9.2

### Patch Changes

- 95ae8e4: Support audio-only mode (`仅音频` / `自动音频`) in low-viewer rooms without server-side video transcodes (`accept_qn: [10000]`), walk all available codec slots (`codec=0,1`), and automatically fail over to backup CDN hosts when the primary edge fails or times out.

## 4.9.1

### Patch Changes

- 6bb3257: Limit 路怒模式 (`normalSendRoadRage`) repeat detection to a 5-second window (`ROAD_RAGE_WINDOW_MS = 5000`) so identical manual messages sent after Bilibili's duplicate-filter interval expires are posted cleanly without injecting an invisible character.

## 4.9.0

### Minor Changes

- 2d7d13c: Add a 「获取网页声音」 (`__web_audio__`) audio input option across all 7 STT providers to capture live-player audio (`#lc-audio-only-stream` or streaming `#live-player video`) directly via `HTMLMediaElement.captureStream()` with stereo-to-mono downmixing and event-driven hot-swapping across audio-only toggles and stream reloads, and migrate Soniox STT from the runtime `@soniox/client` CDN bundle to a direct WebSocket + `AudioWorklet` PCM16 implementation sharing the unified capture pipeline.

## 4.8.0

### Minor Changes

- 023881d: Auto-detect the viewer's per-room danmaku unit limit from Bilibili's `getInfoByUser` response (`data.property.danmu.length`, fallback `80` half-width units = `40` 字) and measure/split danmaku with Bilibili's `utilDanmuLength` weights (printable ASCII = 1, BMP non-ASCII = 2, astral emoji = 4) across 常规发送, 独轮车, 烂梗库, 自动融入, 拷贝忍者, and AI规避 without GM migrations, display full-width 字 (`40`) in 独轮车's optional `autoSendMaxLength` override, and show a live `x 条` segment count in 常规发送 when an input will split into multiple messages.

## 4.7.1

### Patch Changes

- 74c61e4: Keep independent AI chat echo markers from dispatch through engine restarts, so queued sends do not suppress viewer messages and cancelling one send does not expose another send's delayed echo.

## 4.7.0

### Minor Changes

- 73b5e61: feat: Google AI Studio as a 同传 speech-to-text provider over the Gemini Live API, using an AI Studio API key; the model defaults to `gemini-3.5-transcribe-live` and can be typed or picked from the account's model list, an optional API address routes it through a Cloudflare AI Gateway (with gateway authentication off) or a reverse proxy where Google is unreachable, and the Live API's ~10-minute connection limit is bridged by reconnecting at a pause mid-session
- 2c03e47: Add model-aware simultaneous translation to the shared 同传 tab: Gladia live translation, Gemini Live Translate, ElevenLabs enterprise Realtime Translation, OpenAI Realtime Translation, and English translation through compatible Whisper backends. Preserve transcription-only modes and existing Soniox settings, distinguish original transcripts from translated output, and send the selected output as danmaku.

## 4.6.1

### Patch Changes

- f3d1962: fix: LLM requests (model list and chat completions) now go through the userscript manager instead of the page's `fetch`, so OpenAI-compatible providers that block cross-origin browser requests (e.g. Gemini, Kimi, MiniMax, StepFun, Mistral, Zhipu GLM, Tencent Hunyuan) work; the first request to a new API host may show the manager's cross-origin permission prompt

## 4.6.0

### Minor Changes

- 8d5846f: feat: 贡献烂梗 in the chat-item menu (after the 自动融入 blacklist toggles) and the player danmaku right-click menu (after 偷弹幕, with +1模式 on) opens the laplace.live contribution form prefilled with the current streamer and that danmaku

## 4.5.1

### Patch Changes

- 7e949ec: refactor: simplify Copy Ninja; mirrors read real tab visibility even when an anti-AFK script fakes it, and 独轮车 no longer piles up abort listeners over a long run
- 40e48bd: fix: stopping 独轮车, 自动融入 or AI 融入 now cancels messages still waiting to send, a manual send preempts an automatic one waiting out the rate-limit gap, a non-zero code from Bilibili counts as a failed send, and network or CSRF errors are no longer reported as shield-word hits

## 4.5.0

### Minor Changes

- d5ba5ff: feat: 感知忍術 (Kanchi Ninjutsu) for Copy Ninja mirrors: instead of copying the master verbatim, a mirror can reword each action through its own LLM with a dedicated prompt (设置 → LLM 提示词 → 感知忍術); emotes are still copied as-is

## 4.4.1

### Patch Changes

- 07fd0c4: chore: update @soniox/client to 2.4.0 (and its CDN build), cn to 0.5.0 and @types/bun to 1.4.3

## 4.4.0

### Minor Changes

- 67eed99: feat: 拷贝忍者 (Copy Ninja) multi-account mirroring: sends from a master account are copied by mirror accounts in other browsers through kakashi-server, with per-mirror action toggles, decay (random skip + delay) and room following
