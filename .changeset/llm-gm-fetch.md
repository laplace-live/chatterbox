---
"laplace-chatterbox": patch
---

fix: LLM requests (model list and chat completions) now go through the userscript manager instead of the page's `fetch`, so OpenAI-compatible providers that block cross-origin browser requests (e.g. Gemini, Kimi, MiniMax, StepFun, Mistral, Zhipu GLM, Tencent Hunyuan) work; the first request to a new API host may show the manager's cross-origin permission prompt
