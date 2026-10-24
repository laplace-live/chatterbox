---
"laplace-chatterbox": patch
---

fix: stopping 独轮车, 自动融入 or AI 融入 now cancels messages still waiting to send, a manual send preempts an automatic one waiting out the rate-limit gap, a non-zero code from Bilibili counts as a failed send, and network or CSRF errors are no longer reported as shield-word hits
