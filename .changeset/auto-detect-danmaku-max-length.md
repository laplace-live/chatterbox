---
'laplace-chatterbox': minor
---

Auto-detect the viewer's per-room danmaku unit limit from Bilibili's `getInfoByUser` response (`data.property.danmu.length`, fallback `80` half-width units = `40` 字) and measure/split danmaku with Bilibili's `utilDanmuLength` weights (printable ASCII = 1, BMP non-ASCII = 2, astral emoji = 4) across 常规发送, 独轮车, 烂梗库, 自动融入, 拷贝忍者, and AI规避 without GM migrations, while displaying full-width 字 (`40`) in 独轮车's optional `autoSendMaxLength` override.
