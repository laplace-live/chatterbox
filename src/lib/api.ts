import type { BilibiliGetEmoticonsResponse } from '../types'

import { BASE_URL } from './const'
import { isEmoticonUnique } from './emoticon'
import { buildReplacementMap } from './replacement'
import { availableDanmakuColors, cachedEmoticonPackages, cachedRoomId, cachedStreamerUid } from './store'
import { extractRoomNumber } from './utils'
import { cachedWbiKeys, encodeWbi } from './wbi'

/** Default Bilibili danmaku color palette (used when room config not loaded). */
const DEFAULT_DANMAKU_COLORS = [
  '0xe33fff',
  '0x54eed8',
  '0x58c1de',
  '0x455ff6',
  '0x975ef9',
  '0xc35986',
  '0xff8c21',
  '0x00fffc',
  '0x7eff00',
  '0xffed4f',
  '0xff9800',
]

/** Reads a single cookie value by name from `document.cookie`. */
function getCookie(name: string): string | undefined {
  const prefix = `${name}=`
  return document.cookie
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(prefix))
    ?.slice(prefix.length)
}

/** Gets the spm_prefix value from the meta tag for web_location. */
export function getSpmPrefix(): string {
  const metaTag = document.querySelector('meta[name="spm_prefix"]')
  return metaTag?.getAttribute('content') ?? '444.8'
}

/** Gets the CSRF token from browser cookies (bili_jct). */
export function getCsrfToken(): string | undefined {
  return getCookie('bili_jct')
}

/** Gets the logged-in user's UID from browser cookies (DedeUserID). */
export function getDedeUid(): string | undefined {
  return getCookie('DedeUserID')
}

/** Fetches the real room ID for a Bilibili live room from the API. */
export async function getRoomId(url = window.location.href): Promise<number> {
  const shortUid = extractRoomNumber(url)

  const room = await fetch(`${BASE_URL.BILIBILI_ROOM_INIT}?id=${shortUid}`, {
    method: 'GET',
    credentials: 'include',
  })

  if (!room.ok) {
    throw new Error(`HTTP ${room.status}: ${room.statusText}`)
  }

  const roomData: { data: { room_id: number; uid: number } } = await room.json()
  cachedStreamerUid.value = roomData.data.uid
  return roomData.data.room_id
}

/** Returns the cached room ID, fetching and caching it if needed. */
export async function ensureRoomId(): Promise<number> {
  let roomId = cachedRoomId.value
  if (roomId === null) {
    roomId = await getRoomId()
    cachedRoomId.value = roomId
    // Room-specific replacement rules depend on the resolved room id.
    buildReplacementMap()
  }
  return roomId
}

export async function fetchEmoticons(roomId: number): Promise<void> {
  const resp = await fetch(`${BASE_URL.BILIBILI_GET_EMOTICONS}?platform=pc&room_id=${roomId}`, {
    method: 'GET',
    credentials: 'include',
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
  const json: BilibiliGetEmoticonsResponse = await resp.json()
  if (json?.code === 0 && json.data?.data) {
    // 把傻逼b豆表情移除（pkg_id === 100）
    cachedEmoticonPackages.value = json.data.data.filter(pkg => pkg.pkg_id !== 100)
  }
}

export interface SendDanmakuResult {
  success: boolean
  message: string
  isEmoticon: boolean
  error?: string
  /** Set when preempted by a higher-priority send; treat as benign skip, not failure. */
  cancelled?: boolean
}

/** Sends a single danmaku message to the Bilibili live room. */
export async function sendDanmaku(message: string, roomId: number, csrfToken: string): Promise<SendDanmakuResult> {
  const emoticon = isEmoticonUnique(message)

  const form = new FormData()
  form.append('bubble', '2')
  form.append('msg', message)
  form.append('color', '16777215')
  form.append('mode', '1')
  form.append('room_type', '0')
  form.append('jumpfrom', '0')
  form.append('reply_mid', '0')
  form.append('reply_attr', '0')
  form.append('replay_dmid', '')
  form.append('statistics', '{"appId":100,"platform":5}')
  form.append('fontsize', '25')
  form.append('rnd', String(Math.floor(Date.now() / 1000)))
  form.append('roomid', String(roomId))
  form.append('csrf', csrfToken)
  form.append('csrf_token', csrfToken)

  if (emoticon) {
    form.append('dm_type', '1')
    // Bilibili's API requires this empty object.
    form.append('emoticon_options', '{}')
  }

  try {
    let query = ''
    if (cachedWbiKeys) {
      query = encodeWbi(
        {
          web_location: getSpmPrefix(),
        },
        cachedWbiKeys
      )
    }

    const url = `${BASE_URL.BILIBILI_MSG_SEND}?${query}`
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })

    const json: { message?: string } = await resp.json()

    if (json.message) {
      return {
        success: false,
        message,
        isEmoticon: emoticon,
        error: json.message,
      }
    }

    return {
      success: true,
      message,
      isEmoticon: emoticon,
    }
  } catch (err) {
    return {
      success: false,
      message,
      isEmoticon: emoticon,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Sets the danmaku display mode (e.g. '1' = scroll); errors swallowed as best-effort. */
export async function setDanmakuMode(roomId: number, csrfToken: string, mode: string): Promise<void> {
  const form = new FormData()
  form.append('room_id', String(roomId))
  form.append('mode', mode)
  form.append('csrf_token', csrfToken)
  form.append('csrf', csrfToken)
  form.append('visit_id', '')
  try {
    await fetch(BASE_URL.BILIBILI_MSG_CONFIG, { method: 'POST', credentials: 'include', body: form })
  } catch {
    // non-critical
  }
}

/** Applies a random danmaku color from the room palette (or default); errors swallowed as best-effort. */
export async function setRandomDanmakuColor(roomId: number, csrfToken: string): Promise<void> {
  const colorSet = availableDanmakuColors.value ?? DEFAULT_DANMAKU_COLORS
  const color = colorSet[Math.floor(Math.random() * colorSet.length)] ?? '0xffffff'
  const form = new FormData()
  form.append('room_id', String(roomId))
  form.append('color', color)
  form.append('csrf_token', csrfToken)
  form.append('csrf', csrfToken)
  form.append('visit_id', '')
  try {
    await fetch(BASE_URL.BILIBILI_MSG_CONFIG, { method: 'POST', credentials: 'include', body: form })
  } catch {
    // non-critical
  }
}
