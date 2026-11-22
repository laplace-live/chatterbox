/** One sampled player frame. */
export interface VisionFrame {
  /** Wall-clock capture time (ms). */
  at: number
  /** LUMA_WIDTH×LUMA_HEIGHT luma, one byte per pixel. */
  luma: Uint8Array
  /** JPEG data URL at the configured long edge. */
  dataUrl: string
  /** ~160 px JPEG data URL for the UI. */
  thumbUrl: string
}

/** A sampled picture's capture time and luma, without the JPEGs. */
export type LumaSample = Pick<VisionFrame, 'at' | 'luma'>

/** A frame chosen for a call, with its time label. */
export interface LabeledFrame extends VisionFrame {
  /** '当前' or 'N 秒前'. */
  label: string
}

/** Whether frames can be read right now, or why not. */
export type VisionAvailability =
  | 'off'
  | 'ok'
  | 'hidden'
  | 'audio-only'
  | 'no-video'
  | 'paused'
  | 'stalled'
  | 'blank'
  | 'error'

/** A big picture change between consecutive samples. */
export interface SceneCutEvent {
  at: number
  /** Last kept frame before the cut, or null. */
  before: VisionFrame | null
  after: VisionFrame
}

/** A finalized recording of the last few seconds. */
export interface RecentClip {
  /** `data:` URL using the base mime type. */
  dataUrl: string
  /** Base mime type, without a codecs parameter. */
  mimeType: string
  durationMs: number
  /** Wall-clock ms the recording ended. */
  endedAt: number
}

/** Short text note about the picture. */
export interface SceneNote {
  at: number
  scene: string
  /** 'chat' = AI 融入's own `scene` field; 'caption' = the caption model. */
  source: 'chat' | 'caption'
}

/** Caption model state for the UI. */
export type CaptionerStatus = 'off' | 'idle' | 'captioning' | 'error' | 'unsupported'
