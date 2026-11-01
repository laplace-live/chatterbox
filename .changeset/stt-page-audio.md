---
'laplace-chatterbox': minor
---

Add a 「获取网页声音」 (`__web_audio__`) audio input option across all 7 STT providers (Soniox, ElevenLabs, Deepgram, Gladia, Gemini Live, OpenAI Realtime Translation, and OpenAI-compatible / Whisper) to capture live-player audio (`#lc-audio-only-stream` or streaming `#live-player video`) directly via `HTMLMediaElement.captureStream()` with stereo-to-mono downmixing and event-driven hot-swapping across audio-only toggles and stream reloads.
