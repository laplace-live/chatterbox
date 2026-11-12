---
"laplace-chatterbox": minor
---

Add Google AI Studio (`Gemini Decisions API` / `gemini-decision-1`) as the default new decision provider (`POST /v1beta/decisions` and `GET /v1beta/models` with `x-goog-api-key` auth, reverse-proxy base URL support, and `prompt_feedback.block_reason` handling), and upgrade decision presets across Google AI Studio, TypeSafe, and OpenRouter Decisions to structured `noul` `instructions` plus optional `trueCriteria` / `falseCriteria` boundary fields mapped to each protocol's native `criteria` wire keys (`true_description` / `false_description` on Gemini, `true` / `false` on TypeSafe and OpenRouter), with curated default presets (`串子`, `暖男`, `拉踩`, `安全跟风`), automatic v1 preset migration, and a `恢复默认` preset action.
