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
  /** Usage permission: `1` sendable, `0` locked. Only on live `GetEmoticons` response. */
  perm?: number
  /** Identity tier to unlock: `1` 总督 / `2` 提督 / `3` 舰长 / `4` 粉丝团 / `99` 公开. */
  identity?: number
  /** Fan-club level required to unlock (0 when not gated by level). */
  unlock_need_level?: number
  /** Gift id required to unlock (0 when not gated by gift). */
  unlock_need_gift?: number
  /** Human-readable unlock requirement (e.g. `粉丝团`, `lv.5`, `舰长`); empty when unlocked for all. */
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

/** User-pinned emote, persisted across sessions/rooms. Self-contained snapshot so it renders even when its source package isn't loaded. */
export interface FavoriteEmote {
  emoticon_unique: string
  url: string
  emoji: string
  descript?: string
}
