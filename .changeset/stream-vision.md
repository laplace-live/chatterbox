---
"laplace-chatterbox": minor
---

Let AI 融入 see the stream with the new 画面识别 settings (off by default). Frames are sampled locally from the player. In the default 直接看图 mode they're uploaded only when AI 融入 is about to generate: up to a few frames from the moment the streamer or chat is reacting to, one frame for a static picture, and none when nothing changed since the last upload. The model keeps a short note of what it saw, and those notes also reach 自动融入's decision model and YOLO polish. 画面描述 mode instead sends frames to a separate vision model on scene changes, about every 45 seconds and before AI 融入 rounds, turning them into text for chat models that can't take images. An experimental mode sends a short silent clip instead of frames. Vision pauses in background tabs, 仅音频 mode, or when the picture stalls.
