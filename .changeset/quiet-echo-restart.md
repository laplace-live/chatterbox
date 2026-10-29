---
'laplace-chatterbox': patch
---

Keep independent AI chat echo markers from dispatch through engine restarts, so queued sends do not suppress viewer messages and cancelling one send does not expose another send's delayed echo.
