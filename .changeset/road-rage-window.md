---
'laplace-chatterbox': patch
---

Limit 路怒模式 (`normalSendRoadRage`) repeat detection to a 5-second window (`ROAD_RAGE_WINDOW_MS = 5000`) so identical manual messages sent after Bilibili's duplicate-filter interval expires are posted cleanly without injecting an invisible character.
