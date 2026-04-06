import { BASE_URL } from './const'
import { cachedRoomId, cachedStreamerUid } from './store'
import { extractRoomNumber } from './utils'
import { cachedWbiKeys, encodeWbi } from './wbi'

/**
 * Gets the spm_prefix value from the meta tag for web_location.
 */
export function getSpmPrefix(): string {
  const metaTag = document.querySelector('meta[name="spm_prefix"]')
  return metaTag?.getAttribute('content') ?? '444.8'
}

/**
 * Gets the CSRF token from browser cookies (bili_jct).
 */
export function getCsrfToken(): string | undefined {
  return document.cookie
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith('bili_jct='))
    ?.split('bili_jct=')[1]
}

/**
 * Fetches the real room ID for a Bilibili live room from the API.
 */
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

/**
 * Returns the cached room ID, fetching and caching it if needed.
 */
export async function ensureRoomId(): Promise<number> {
  let roomId = cachedRoomId.value
  if (roomId === null) {
    roomId = await getRoomId()
    cachedRoomId.value = roomId
  }
  return roomId
}

export interface SendDanmakuResult {
  success: boolean
  message: string
  error?: string
}

/**
 * Sends a single danmaku message to the Bilibili live room.
 */
export async function sendDanmaku(message: string, roomId: number, csrfToken: string): Promise<SendDanmakuResult> {
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
        error: json.message,
      }
    }

    return {
      success: true,
      message,
    }
  } catch (err) {
    return {
      success: false,
      message,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
