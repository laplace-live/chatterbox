---
"laplace-chatterbox": minor
---

feat: Google AI Studio as a 同传 speech-to-text provider (Gemini `gemini-3.5-transcribe-live` over the Live API), using an AI Studio API key; an optional API address routes it through a Cloudflare AI Gateway (with gateway authentication off) or a reverse proxy where Google is unreachable, and the Live API's ~10-minute connection limit is bridged by reconnecting automatically mid-session
