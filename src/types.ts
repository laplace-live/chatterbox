/**
 * Danmaku color entry from Bilibili API.
 */
export interface DanmakuColor {
  name: string
  color: string
  color_hex: string
  status: number
  weight: number
  color_id: number
  origin: number
}

/**
 * Group of danmaku colors.
 */
export interface DanmakuColorGroup {
  name: string
  sort: number
  color: DanmakuColor[]
}

/**
 * Danmaku display mode (scroll, bottom, top).
 */
export interface DanmakuMode {
  name: string
  mode: number
  type: string
  status: number
}

/**
 * Danmaku config payload (groups + modes).
 */
export interface DanmakuConfigData {
  group: DanmakuColorGroup[]
  mode: DanmakuMode[]
}

/**
 * API response wrapper for danmaku config.
 */
export interface DanmakuConfigResponse {
  code: number
  data: DanmakuConfigData
  message: string
  msg: string
}

/**
 * WBI signing keys extracted from Bilibili nav API.
 */
export interface BilibiliWbiKeys {
  img_key: string
  sub_key: string
}
