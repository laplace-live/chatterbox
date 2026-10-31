# laplace-chatterbox

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
