---
'laplace-chatterbox': minor
---

Add a "获取网页声音" audio source for STT: capture the live player's audio via `captureStream()` instead of the microphone, with hot reconnect, watchdog self-heal, startup retry, and Soniox fallback protection.
