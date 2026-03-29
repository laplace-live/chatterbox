/**
 * Splits a string into grapheme clusters (user-perceived characters).
 */
export function getGraphemes(str: string): string[] {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })
  return Array.from(segmenter.segment(str), ({ segment }) => segment)
}

/**
 * Emoji-safe split of text into parts by maximum grapheme length.
 */
export function trimText(text: string, maxLength: number): string[] {
  if (!text) return [text]

  const graphemes = getGraphemes(text)
  if (graphemes.length <= maxLength) return [text]

  const parts: string[] = []
  let currentPart: string[] = []
  let currentLength = 0

  for (const char of graphemes) {
    if (currentLength >= maxLength) {
      parts.push(currentPart.join(''))
      currentPart = [char]
      currentLength = 1
    } else {
      currentPart.push(char)
      currentLength++
    }
  }

  if (currentPart.length > 0) {
    parts.push(currentPart.join(''))
  }

  return parts
}

/**
 * Strips trailing punctuation (for live captions).
 */
export function stripTrailingPunctuation(text: string): string {
  if (!text) return text
  return text.replace(/[.,!?;:。，、！？；：…]+$/, '')
}

/**
 * Appends a message to a textarea log with a maximum line limit.
 */
export function appendToLimitedLog(logElement: HTMLTextAreaElement, message: string, maxLines: number): void {
  const lines = logElement.value.split('\n')
  if (lines.length >= maxLines) {
    lines.splice(0, lines.length - maxLines + 1)
  }
  lines.push(message)
  logElement.value = lines.join('\n')
  logElement.scrollTop = logElement.scrollHeight
}

/**
 * Extracts the room number from a Bilibili live room URL.
 */
export function extractRoomNumber(url: string): string | undefined {
  const urlObj = new URL(url)
  const pathSegments = urlObj.pathname.split('/').filter(segment => segment !== '')
  return pathSegments.find(segment => Number.isInteger(Number(segment)))
}

/**
 * Inserts a random soft hyphen in the text (for evasion).
 */
export function addRandomCharacter(text: string): string {
  if (!text || text.length === 0) return text

  const graphemes = getGraphemes(text)
  const randomIndex = Math.floor(Math.random() * (graphemes.length + 1))
  graphemes.splice(randomIndex, 0, '­')
  return graphemes.join('')
}

/**
 * Splits lines, optionally adds random chars, trims to max length per message.
 */
export function processMessages(text: string, maxLength: number, addRandomChar = false): string[] {
  return text
    .split('\n')
    .flatMap(line => {
      let l = line
      if (addRandomChar && l?.trim()) {
        l = addRandomCharacter(l)
      }
      return trimText(l, maxLength)
    })
    .filter(line => line?.trim())
}
