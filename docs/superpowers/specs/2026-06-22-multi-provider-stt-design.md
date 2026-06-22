# Multi-Provider STT: add ElevenLabs alongside Soniox

Date: 2026-06-22
Status: approved, implementing

## Goal

The 同传 (STT) tab currently supports exactly one provider — Soniox — hardcoded
through `useSonioxRecording`. Add **ElevenLabs Scribe v2 Realtime** as a second
provider behind a clean, DRY abstraction. Soniox stays the default; existing
users see no behavior change.

## Decisions (from brainstorming)

1. **Fish Audio is out.** The user originally asked for Fish Audio, but its only
   STT is a one-shot REST endpoint (`POST /v1/asr`, file upload). It has **no
   realtime websocket ASR** (verified: the STT API ref shows only the batch
   endpoint; `…/websocket/asr-live` 404s; the "real-time streaming" guide is
   TTS-only; the official TS SDK's ASR is batch + Node-only). The live-captions
   use case is inherently realtime, so Fish Audio doesn't fit. Skipped.
2. **ElevenLabs qualifies.** Scribe v2 Realtime is a true realtime websocket STT.
3. **Integrate ElevenLabs via a raw WebSocket (no SDK).** Initially we tried
   the official `@elevenlabs/client` SDK loaded from esm.sh, but it bundles
   `livekit-client`, whose webrtc-adapter shim runs at import time and throws
   (`Cannot use 'in' operator to search for 'ontrack' in undefined`) in the
   bilibili page context — Scribe realtime is a plain WebSocket that never needs
   WebRTC. So we speak the documented protocol directly: mint a single-use
   token over HTTP, open `wss://api.elevenlabs.io/v1/speech-to-text/realtime`
   with `?token=&model_id=&audio_format=pcm_16000&commit_strategy=vad`, and
   stream base64 PCM16 captured via an AudioContext (pinned to 16 kHz) + a
   `ScriptProcessorNode` (no AudioWorklet blob → no host-page CSP surprises).
   Zero third-party runtime deps; the SDK + livekit are removed entirely.

## Architecture — Approach A: engine abstraction + one hook

A typed `SttEngine` contract + normalized event model. One `useSttRecording`
hook drives whichever engine the active provider selects; one consumer in
`stt-tab.tsx` handles transcripts for both providers.

```
SttSessionParams ─▶ createSonioxEngine ─┐
                    createElevenLabsEngine ─┴▶ SttEngine  ──(SttEngineEvent)──▶ useSttRecording ──▶ SttTab consumer
```

### New / changed files

| File | Role |
|---|---|
| `src/lib/stt/types.ts` (new) | `SttProvider`, `SttRecordingState`, `SttChunk`, discriminated-union `SttEngineEvent`, `SttSessionParams`, `SttEngine`, `SttEngineFactory`. |
| `src/lib/stt/normalize.ts` (new) | Pure mappers: `sonioxResultToChunks`, `elevenLabsTextToChunk`, `reduceChunks`, `isSingleUseTokenResponse`, `readStringField`. No `$`/SDK runtime deps → unit-testable. |
| `src/lib/stt/normalize.test.ts` (new) | TDD coverage for the pure mappers + guards. |
| `src/lib/stt/audio.ts` (new) | Pure PCM helpers `floatTo16` + `int16ToBase64` (Float32 → base64 s16le). |
| `src/lib/stt/audio.test.ts` (new) | TDD coverage for the PCM helpers (incl. little-endian byte order). |
| `src/lib/stt/soniox-engine.ts` (new) | `createSonioxEngine` — SDK logic lifted from the old hook. |
| `src/lib/stt/elevenlabs-engine.ts` (new) | `createElevenLabsEngine` — token mint → raw WebSocket + ScriptProcessor PCM pipeline → event mapping. |
| `src/lib/stt/elevenlabs-token.ts` (new) | `mintElevenLabsToken` via plain `fetch` (ElevenLabs CORS is open — no `GM_xmlhttpRequest`/`@connect` needed), validated with `isSingleUseTokenResponse`. |
| `src/lib/use-stt-recording.ts` (new, replaces `use-soniox-recording.ts`) | One hook, instantiates the active engine, exposes unified control surface. |
| `src/components/stt-tab.tsx` (edit) | Provider selector + conditional settings + unified chunk consumer. |
| `src/components/about-tab.tsx` (edit) | ElevenLabs websocket + token-mint privacy disclosure. |
| `src/lib/store.ts` (edit) | `sttProvider`, `elevenLabs*` keys, shared keys migrated to neutral `stt*`. |
| `src/lib/const.ts` (edit) | `ELEVENLABS_WS_URL`, `ELEVENLABS_API_BASE`. |

(No `src/lib/elevenlabs.ts` SDK loader and no `@elevenlabs/client` dependency — both removed after the raw-WebSocket pivot.)

## Transcript normalization (the key seam)

Each engine emits `{ type: 'transcript', chunks: SttChunk[] }` where
`SttChunk = { text; isFinal; kind: 'original' | 'translation' }`, plus
`endpoint` / `connected` / `finished` / `error` / `state`.

- **Soniox:** tokens map 1:1 (`is_final → isFinal`, `translation_status → kind`).
- **ElevenLabs:** `PARTIAL_TRANSCRIPT → {isFinal:false}`; `COMMITTED_TRANSCRIPT →
  {isFinal:true}` followed by an `endpoint` (VAD-driven); `kind` always
  `'original'` (Scribe realtime is transcription-only).

The consumer reduces each event's chunks with `reduceChunks(chunks,
translationEnabled)`: when translating, only `translation` chunks count;
otherwise only `original`. Final text appends to the display + danmaku buffer +
AI-chat buffer; non-final replaces the provisional display.

## ElevenLabs specifics (from official docs)

- WebSocket: `wss://api.elevenlabs.io/v1/speech-to-text/realtime` with
  `?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad`
  (+ optional `language_code`). Server messages: `partial_transcript {text}`,
  `committed_transcript {text}`, `*_error {error}`.
- Audio: `getUserMedia` (DSP off — `echoCancellation/noiseSuppression/
  autoGainControl: false` — + configurable `deviceId`, matching Soniox) →
  `AudioContext({ sampleRate: 16000 })` (browser resamples) →
  `ScriptProcessorNode` (4096) → `floatTo16` + `int16ToBase64` → base64
  `input_audio_chunk` messages. ScriptProcessor over AudioWorklet to avoid
  blob-module/CSP issues on the host page.
- Auth: browsers can't set the `xi-api-key` header on a WebSocket, so we mint a
  single-use token (`POST /v1/single-use-token/realtime_scribe`, header
  `xi-api-key`, response `{ token }`, 15-min expiry) and pass it as the
  `?token=` query param. Minted via plain `fetch` (ElevenLabs returns
  `access-control-allow-origin: *`, so no `GM_xmlhttpRequest`/`@connect`), a
  fresh token per connect.
- Model: hardcoded to `scribe_v2_realtime` (shown read-only). ElevenLabs has no
  API to list STT models and it's the only realtime one, so there's nothing to
  fetch or configure.
- `pause`/`resume` gate chunk sending (socket stays open); `finalize` is a
  no-op (VAD auto-commits; the UI doesn't call it). Only fatal `*_error`
  messages end the session — transient warnings are ignored.

## Settings

- New: `sttProvider` (default `'soniox'`); `elevenLabsApiKey`,
  `elevenLabsLanguageCode` (empty = auto). (No `elevenLabsModel` — the model id
  is hardcoded, see ElevenLabs specifics above.)
- Shared output/capture settings promoted to neutral `stt*` keys with one-time
  migration from the old `soniox*` names: `sttAutoSend`, `sttMaxLength`,
  `sttWrapBrackets`, `sttAudioDeviceId`.
- Soniox-specific stays: `sonioxModel`, `sonioxModels`, `sonioxLanguageHints`,
  `sonioxTranslation*`. Translation UI is hidden when provider = ElevenLabs.

## Dev rules honored

- **DRY:** one hook, one consumer, one event model, shared danmaku/capture
  settings, shared mappers.
- **No `any` / no `as`:** discriminated-union events; SDK usage validated by
  installing `@elevenlabs/client` types (build-time check); token response
  parsed through a type guard (`in`-narrowing, not casts).

## Testing

`bun test` covers the pure mappers + token guard. The CDN load, microphone, and
WebSocket paths can't be exercised here → require a real-browser smoke test in a
bilibili live room (start ElevenLabs STT, confirm partial + committed captions,
auto-send to danmaku, error on bad key).
