---
"laplace-chatterbox": minor
---

Let AI 融入 see the stream with the new 画面识别 settings (off by default). Frames are sampled locally from the player and uploaded only when AI 融入 is about to generate: up to a few frames from the moment the streamer or chat is reacting to, one frame for a static picture, and none when nothing changed since the last upload. The model keeps a short note of what it saw, and those notes also reach 自动融入's decision model and YOLO polish. 画面描述 mode turns frames into text with a separate vision model for chat models that can't take images, and an experimental mode sends a short silent clip instead of frames. Vision pauses in background tabs, 仅音频 mode, or when the picture stalls.
