# Local / OpenAI-compatible STT provider

Date: 2026-07-25
Status: approved, implementing

## Goal

Add a fifth STT provider that talks the OpenAI `/v1/audio/transcriptions` REST
shape, so 同传 can run against a **self-hosted Whisper** (whisper.cpp
`whisper-server`, faster-whisper-server, LM Studio) with no cloud key and no
per-minute cost. Because the base URL is user-supplied, the same provider also
covers OpenAI-compatible cloud hosts (Groq `whisper-large-v3`, OpenAI itself)
for free. Existing providers and defaults are untouched.

Prompted by [PR #19](https://github.com/laplace-live/chatterbox/pull/19), whose
local-Whisper idea is worth having; none of its code is reused. See
[Rejected from PR #19](#rejected-from-pr-19).

## Decisions (from brainstorming)

1. **Generic, not localhost-only.** One provider (`openai-compat`) with a
   user-supplied base URL + optional API key, defaulting to
   `http://127.0.0.1:8080/v1`. Covers local and cloud with one code path.
2. **Energy-VAD segmentation, not fixed windows.** A batch endpoint has no
   streaming, so we choose the cut points. Cutting on detected silence keeps
   words intact and makes the emitted `endpoint` event mean what it says.
   Fixed ~5s windows (PR #19) cut mid-word; overlap+dedup was rejected because
   text-level dedup on Chinese ASR output eats legitimately repeated speech.
3. **`GM_xmlhttpRequest`, `@connect localhost, 127.0.0.1, *`.** A plain `fetch`
   to a local server is blocked three different ways — mixed content, CORS, and
   Chrome's Private Network Access preflight. `GM_xmlhttpRequest` bypasses all
   three and is already the repo's pattern (`deepgram-models.ts`). The wildcard
   is required because the host is whatever the user typed; local hosts are
   listed explicitly so the common case needs no manager prompt.

## Architecture

Registers in `ENGINE_FACTORIES` like any other provider — no special-casing in
`use-stt-recording.ts`, no magic strings.

```
pcm-capture ──(Int16 frames, 256ms)──▶ vad-segmenter ──(speech segments)──▶ FIFO queue (1 in flight)
                                                                                  │
                                          SttEngineEvent ◀── openai-compat-engine ─┴─▶ transcribe (GM_xhr)
```

### New / changed files

| File | Role |
|---|---|
| `src/lib/stt/wav.ts` (+ `.test.ts`) (new) | Pure `encodeWav(samples, sampleRate) → Uint8Array` (44-byte RIFF header + s16le data). |
| `src/lib/stt/vad-segmenter.ts` (+ `.test.ts`) (new) | `createVadSegmenter({ sampleRate, onSegment })` → `{ push(frame), flush() }`. No DOM/network. |
| `src/lib/stt/openai-compat-transcribe.ts` (new) | `transcribe(params, wavBytes)` via `GM_xmlhttpRequest`; response parsed through a type guard. |
| `src/lib/stt/openai-compat-engine.ts` (new) | `createOpenAiCompatEngine` — wires capture → segmenter → queue → transcribe → events. |
| `src/lib/stt/types.ts` (edit) | `SttProvider` gains `'openai-compat'`; `SttSessionParams` gains optional `baseUrl?: string`. |
| `src/lib/use-stt-recording.ts` (edit) | One `ENGINE_FACTORIES` entry. |
| `src/lib/store.ts` (edit) | `openaiSttBaseUrl`, `openaiSttApiKey`, `openaiSttModel`, `openaiSttLanguage`. |
| `src/lib/const.ts` (edit) | `OPENAI_STT_DEFAULT_BASE_URL`, `OPENAI_STT_DEFAULT_MODEL`. |
| `src/components/stt-tab.tsx` (edit) | Provider option + `PROVIDER_META`, base-URL field, optional-key start gate, free-text model field, latency hint. |
| `src/components/about-tab.tsx` (edit) | Disclosure: audio leaves the machine only if a non-local base URL is configured. |
| `vite.config.ts` (edit) | `connect: ['api.deepgram.com', 'localhost', '127.0.0.1', '*']`. |

`SttSessionParams.baseUrl` is the only shared-contract change; every other
provider ignores it.

## VAD segmenter

Frames arrive every 256 ms (`FRAME_SAMPLES = 4096` @ 16 kHz), too coarse to
place a cut, so RMS is computed per **64 ms sub-block** within each frame.

- **Adaptive noise floor** — snaps down to any new minimum, creeps up ~0.4% per
  sub-block, and is seeded from the first sub-block. Gate is
  `rms > floor × GATE_RATIO`, with the floor clamped to `ABSOLUTE_MIN_RMS`. No
  user-facing threshold, and it self-adjusts between mic and page-audio levels.
  *(Implementation note: an EMA updated only while not in speech — the first
  design — latches permanently the first time sustained background audio trips
  the gate, because it then stops updating forever. Tracking in every state
  fixes it.)*
- **Pre-roll** — a 200 ms ring buffer prepended on speech onset so the first
  phoneme isn't clipped.
- **Close** — after 600 ms below gate: emit the segment, then `endpoint`.
- **Discard** — segments with under 1 s of speech (noise blips, door slams).
- **Force-flush** — at 15 s, so continuous speech still gets transcribed.

| Constant | Value |
|---|---|
| `SUB_BLOCK_MS` | 64 |
| `PRE_ROLL_MS` | 200 |
| `SILENCE_CLOSE_MS` | 600 |
| `MIN_SPEECH_MS` | 1000 |
| `MAX_SEGMENT_MS` | 15000 |
| `GATE_RATIO` | 3 |
| `ABSOLUTE_MIN_RMS` | 0.004 (floor so a silent input can't gate open) |
| `FLOOR_RISE_PER_BLOCK` | 0.004 (e-fold ≈ 16 s) |

## Request path

`POST ${baseUrl}/audio/transcriptions`, `multipart/form-data`:

| Field | Value |
|---|---|
| `file` | `segment.wav`, `audio/wav`, from `encodeWav` |
| `model` | `openaiSttModel` (default `whisper-1`) |
| `language` | `params.languageHints[0]`, omitted when empty |
| `response_format` | `json` |
| `temperature` | `0` |

`Authorization: Bearer <key>` only when a key is set. Response `{ text }`, read
through a type guard.

The body is a plain `FormData`, and **no `Content-Type` header is set** — the
boundary is generated with the body, so setting the header by hand corrupts the
request. An earlier revision hand-encoded the multipart body on the theory that
`FormData` support varies across userscript managers; that was dropped as
unevidenced paranoia (Tampermonkey and Violentmonkey both document `FormData`
in `data`) and removed ~110 lines. If a manager does turn out to mishandle it,
the failure will be a 4xx from the server, not silent corruption.

**Correction (verified against `examples/server/server.cpp`):** whisper.cpp does
*not* expose an OpenAI-compatible alias. It registers exactly one inference
route, `request_path + inference_path`, defaulting to `"" + "/inference"`. Both
halves are flags, so it must be started with
`--request-path /v1 --inference-path /audio/transcriptions` to match our default
base URL. Its form fields (`file`, `language`, `temperature`,
`response_format`) and its default `{"text": …}` JSON response do match what we
send and parse, so no code change is needed — only the start command.

**Strictly one request in flight, FIFO.** Parallel requests would deliver
transcripts out of order and scramble the buffer. The backlog is capped at 4
segments; when full the oldest is dropped with a `console.warn` (engines emit
only `SttEngineEvent`s and never touch `appendLog`), so memory and lag stay
bounded on a server that can't keep up.

## Lifecycle

- `start` — `state: 'connecting'`, start capture, then `connected` +
  `state: 'recording'`. No health probe; a dead server surfaces via the first
  request (below).
- `stop` — `state: 'stopping'`, stop capture, flush the segmenter, let the
  queue drain (8 s cap — must stay under `stt-tab.tsx`'s 10 s force-cancel, or
  the tab kills the session just as the drain completes) then `finished`.
  A `stopping` flag also keeps a late-resolving mic permission from flipping the
  state back to `recording`.
- `cancel` — discard queue and in-flight results immediately.
- `finalize` — flush the segmenter.
- `pause` / `resume` — gate `push` into the segmenter.

## Errors

- **Network-level failure** (`status === 0` — server not running, wrong port) →
  `error` immediately. Continuing would be silent dead air.
- **HTTP error status** → tolerate 3 consecutive, then `error`. Survives a
  transient blip without hiding a real misconfiguration.

## Hallucination guard

Whisper invents subtitle credits ("字幕由…提供", "请不吝赐教", "Amara.org") on
near-silence. VAD removes most of the cause by never sending silence; on top of
that, a segment is dropped only when its **entire trimmed text** matches a known
pattern — anchored, never substring. PR #19's substring blacklist would eat any
legitimate line containing 翻译 or 观看.

## Settings

New, following the existing per-provider convention:

- `openaiSttBaseUrl` — default `http://127.0.0.1:8080/v1`
- `openaiSttApiKey` — default `''` (optional; local servers need none)
- `openaiSttModel` — default `whisper-1`
- `openaiSttLanguage` — default `'zh'`, `''` = auto-detect

VAD constants are not exposed — the adaptive noise floor removes the need.

## UI

- Provider `<option>` + `PROVIDER_META` entry labelled 本地 / OpenAI 兼容, whose
  required `signupUrl` points at whisper.cpp's releases page (the setup the
  default base URL assumes) rather than a signup page.
- A 服务地址 input above the key field; key labelled optional.
- The start gate at `stt-tab.tsx:406` requires **base URL** instead of API key
  for this provider.
- Model is a free-text `Input`, not a fetched dropdown — servers differ on
  whether `/models` exists or lists STT models at all.
- Hint under the provider selector: `分段识别，延迟约 1–4 秒，无实时预览`.

## Known trade-offs

Batch transcription adds **1–4 s latency** and produces **no interim text**, so
the tab shows nothing between segments. Both are inherent to a non-streaming
endpoint and apply to any local Whisper integration, which is why the hint is
UI-visible rather than buried in docs.

## Rejected from PR #19

| PR approach | Why rejected |
|---|---|
| Activation by typing `laplace` into the Soniox key field | Bypasses `ENGINE_FACTORIES`; leaves inert Soniox model/translation UI on screen. Ours is a real `SttProvider`. |
| Hardcoded `http://127.0.0.1:8080/inference` | No port or host config. Ours is a base-URL setting. |
| Fixed 4.6 s windows | Cuts mid-word; fabricates an `endpoint` every 4.6 s; backlog grows unbounded on a slow server. |
| `console.error` only | Dead server is indistinguishable from a quiet streamer. Ours emits `error`. |
| Substring noise blacklist | Drops legitimate lines containing 翻译 / 观看. |
| Hardcoded `language: "zh"` | Ignores `languageHints`. |
| Bare `GM_xmlhttpRequest` + `@ts-ignore`, no `@connect` | Breaks vite-plugin-monkey's auto-`@grant`. Ours imports from `$`. |

## Out of scope

Page-audio capture (`captureStream` on the player `<video>`), the AI-chat
cooldown / min-chars throttle, and the self-UID danmaku filter are separate
changes. This provider composes with page-audio capture later without either
side knowing about the other.

## Dev rules honored

- **No `any`, no `as`, no `@ts-ignore`** — `GM_xmlhttpRequest` imported from
  `$`; the response parsed through a type guard.
- **DRY** — reuses `startPcmCapture`, the `SttEngine` contract, and the existing
  `useSttRecording` consumer unchanged.
- **Isolation** — WAV encoding and VAD are pure and independently testable;
  the engine only wires them.

## Testing

`bun test` covers the three pure units:

- `wav.test.ts` — exact RIFF header bytes, little-endian sizes, sample round-trip.
- `vad-segmenter.test.ts` — synthetic RMS sequences: silence→speech→silence
  emits one segment; sub-minimum blips discarded; 15 s force-flush; pre-roll
  included; adaptive floor tracks a rising noise level.

Microphone, `GM_xmlhttpRequest`, and a live server can't be exercised here →
real-browser smoke test in a bilibili live room against a running
`whisper-server`: start 同传, confirm segments transcribe, confirm auto-send to
danmaku, confirm a stopped server surfaces an error rather than silence.
