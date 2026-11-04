---
"laplace-chatterbox": patch
---

Count `getDanmakuUnits` per Unicode code point rather than UTF-16 code unit so single-codepoint astral emojis (`U+10000..U+10FFFF`) weigh `2` half-width units (`1 字`, up to 40 per 80-unit danmaku) instead of `4` units (`2 字`), and use grapheme count for the 常规发送 character counter.
