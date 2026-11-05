---
"laplace-chatterbox": patch
---

Drop the `gateway.ai.cloudflare.com` URL rewrite for Google AI Studio (Gemini Live) STT and update the 接口地址 hint to recommend a reverse proxy (such as a Cloudflare Worker forwarding to `generativelanguage.googleapis.com`), since Cloudflare AI Gateway's Realtime WebSocket endpoint requires `cf-aig-authorization` and omits `Sec-WebSocket-Protocol` from its `101 Switching Protocols` response, causing browsers to fail the handshake per RFC 6455 §4.1.
