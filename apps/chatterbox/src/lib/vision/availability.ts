import type { CaptionerStatus, VisionAvailability } from './types'

const AVAILABILITY_TEXT: Record<VisionAvailability, string> = {
  off: '未启用',
  ok: '可用',
  hidden: '标签页在后台',
  'audio-only': '仅音频模式',
  'no-video': '未找到直播画面',
  paused: '直播未在播放',
  stalled: '画面未更新',
  blank: '画面为空',
  error: '无法读取画面',
}

const CAPTIONER_STATUS_TEXT: Record<CaptionerStatus, string> = {
  off: '未启用',
  idle: '待命',
  captioning: '描述中…',
  error: '出错',
  unsupported: '模型不支持图片',
}

/** Chinese status text for frame availability. */
export function describeAvailability(a: VisionAvailability): string {
  return AVAILABILITY_TEXT[a]
}

/** Chinese status text for the caption model. */
export function describeCaptionerStatus(s: CaptionerStatus): string {
  return CAPTIONER_STATUS_TEXT[s]
}
