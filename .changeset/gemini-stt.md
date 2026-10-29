---
"laplace-chatterbox": minor
---

feat: Google AI Studio as a 同传 speech-to-text provider over the Gemini Live API, using an AI Studio API key; the model defaults to `gemini-3.5-transcribe-live` and can be typed or picked from the account's model list, an optional API address routes it through a Cloudflare AI Gateway (with gateway authentication off) or a reverse proxy where Google is unreachable, and the Live API's ~10-minute connection limit is bridged by reconnecting at a pause mid-session
