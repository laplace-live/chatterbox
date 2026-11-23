import { CLIENT_SOURCE, type ClientMessage, PROTOCOL_VERSION, parseBridgeMessage, type SendStatus } from './protocol.ts'

/** What a compatible bridge announced. */
export interface ChatterboxStatus {
  /** Userscript version. */
  version: string
  /** The 允许控制台通过本脚本发送弹幕 setting; sends fail with `disabled` while it's off. */
  enabled: boolean
}

export interface SendProgress {
  sent: number
  /** 0 until the room tab has split the text. */
  total: number
}

export interface SendResult extends SendProgress {
  /** `unavailable` = no compatible Chatterbox on this page, or the client disconnected. */
  status: SendStatus | 'unavailable'
  /** Bilibili's reason for the first rejected segment. */
  error?: string
}

export interface SendOptions {
  /** Wrap every split segment in 【】. */
  wrapBrackets?: boolean
  onProgress?: (progress: SendProgress) => void
}

interface PageMessage {
  source: unknown
  origin: string
  data: unknown
}

/** The parts of `window` the client uses. */
export interface ChatterboxWindow {
  addEventListener(type: 'message', listener: (event: PageMessage) => void): void
  removeEventListener(type: 'message', listener: (event: PageMessage) => void): void
  postMessage(message: unknown, targetOrigin: string): void
  location: { origin: string }
}

export interface ChatterboxClientOptions {
  /** Defaults to the global `window`. */
  target?: ChatterboxWindow
  /** Fallback for a bridge gone silent mid-send, restarted by each progress message; generous because sends queue in the room tab. */
  timeoutMs?: number
}

interface Pending {
  resolve: (result: SendResult) => void
  onProgress?: (progress: SendProgress) => void
  progress: SendProgress
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Talks to the bridge LAPLACE Chatterbox runs on this page: tracks whether it's there, and sends danmaku through the
 * viewer's open live-room tab as the account logged in there.
 */
export class ChatterboxClient {
  readonly #target?: ChatterboxWindow
  readonly #timeoutMs: number
  #status: ChatterboxStatus | null = null
  #listening = false
  readonly #listeners = new Set<(status: ChatterboxStatus | null) => void>()
  readonly #pending = new Map<string, Pending>()

  constructor(options: ChatterboxClientOptions = {}) {
    this.#target = options.target
    this.#timeoutMs = options.timeoutMs ?? 3 * 60_000
  }

  /** What the bridge last announced; null until a compatible Chatterbox has announced itself. Stable between changes. */
  get status(): ChatterboxStatus | null {
    return this.#status
  }

  /** Subscribe to status changes; returns the unsubscribe function. */
  onStatusChange(listener: (status: ChatterboxStatus | null) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Listen for the bridge and ask it to announce itself; calling again only re-asks. */
  connect(): void {
    if (!this.#listening) {
      this.#window().addEventListener('message', this.#onMessage)
      this.#listening = true
    }
    this.#post({ source: CLIENT_SOURCE, type: 'ping' })
  }

  /** Stop listening; sends still in flight settle as `unavailable`. */
  disconnect(): void {
    if (!this.#listening) return
    this.#window().removeEventListener('message', this.#onMessage)
    this.#listening = false
    for (const [id, entry] of this.#pending) this.#settle(id, { status: 'unavailable', ...entry.progress })
    this.#setStatus(null)
  }

  /** Have Chatterbox send `text` as danmaku in `roomId`, split at the viewer's length cap, from the tab showing that room. */
  send(roomId: number, text: string, { wrapBrackets = false, onProgress }: SendOptions = {}): Promise<SendResult> {
    if (!this.#status) return Promise.resolve({ status: 'unavailable', sent: 0, total: 0 })
    const id = crypto.randomUUID()
    return new Promise(resolve => {
      const entry: Pending = { resolve, onProgress, progress: { sent: 0, total: 0 } }
      this.#pending.set(id, entry)
      this.#armTimeout(id, entry)
      this.#post({ source: CLIENT_SOURCE, type: 'send', protocol: PROTOCOL_VERSION, id, roomId, text, wrapBrackets })
    })
  }

  #window(): ChatterboxWindow {
    return this.#target ?? window
  }

  #post(message: ClientMessage): void {
    const target = this.#window()
    target.postMessage(message, target.location.origin)
  }

  #setStatus(status: ChatterboxStatus | null): void {
    if (status?.version === this.#status?.version && status?.enabled === this.#status?.enabled) return
    this.#status = status
    for (const listener of this.#listeners) listener(status)
  }

  #settle(id: string, result: SendResult): void {
    const entry = this.#pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.#pending.delete(id)
    entry.resolve(result)
  }

  #armTimeout(id: string, entry: Pending): void {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => this.#settle(id, { status: 'no-response', ...entry.progress }), this.#timeoutMs)
  }

  readonly #onMessage = (event: PageMessage): void => {
    const target = this.#window()
    if (event.source !== target || event.origin !== target.location.origin) return
    const message = parseBridgeMessage(event.data)
    if (!message) return
    if (message.type === 'status') {
      const compatible = message.protocol === PROTOCOL_VERSION
      this.#setStatus(compatible ? { version: message.version, enabled: message.enabled } : null)
      return
    }
    const entry = this.#pending.get(message.id)
    if (!entry) return
    if (message.type === 'progress') {
      // The bridge re-posts progress as a heartbeat while a send is queued: it restarts the timeout, but only changes notify.
      this.#armTimeout(message.id, entry)
      if (message.sent === entry.progress.sent && message.total === entry.progress.total) return
      entry.progress = { sent: message.sent, total: message.total }
      entry.onProgress?.(entry.progress)
      return
    }
    const { status, sent, total, error } = message
    this.#settle(message.id, { status, sent, total, error })
  }
}
