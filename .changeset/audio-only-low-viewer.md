---
'laplace-chatterbox': patch
---

Support audio-only mode (`仅音频` / `自动音频`) in low-viewer rooms without server-side video transcodes (`accept_qn: [10000]`), walk all available codec slots (`codec=0,1`), and automatically fail over to backup CDN hosts when the primary edge fails or times out.
