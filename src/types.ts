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

export interface BilibiliEmoticon {
  emoji: string
  descript: string
  url: string
  emoticon_unique: string
  emoticon_id: number
  /**
   * Per-emoticon usage permission, computed by the server based on the
   * current user's level / fan-club / guard status. `1` = the user can send
   * this emote, `0` = locked. Optional because it's only present on the live
   * `GetEmoticons` response (older responses or other shapes may omit it).
   */
  perm?: number
  /**
   * Identity tier required to unlock. Observed values: `1` 总督 / `2` 提督 /
   * `3` 舰长 / `4` 粉丝团 / `99` 公开. Used purely for log/UI hints.
   */
  identity?: number
  /** Fan-club level required to unlock (0 when not gated by level). */
  unlock_need_level?: number
  /** Gift id required to unlock (0 when not gated by gift). */
  unlock_need_gift?: number
  /**
   * Human-readable unlock requirement shown by Bilibili itself, e.g. `粉丝团`,
   * `lv.5`, `舰长`, `提督`, `总督`. Empty string when unlocked for all.
   */
  unlock_show_text?: string
  /** Hex color string Bilibili uses for the unlock badge (e.g. `#FF6699`). */
  unlock_show_color?: string
}

export interface BilibiliEmoticonPackage {
  pkg_id: number
  pkg_name: string
  pkg_type: number
  pkg_descript: string
  emoticons: BilibiliEmoticon[]
}

export interface BilibiliGetEmoticonsResponse {
  code: number
  data: {
    data: BilibiliEmoticonPackage[]
  }
}
