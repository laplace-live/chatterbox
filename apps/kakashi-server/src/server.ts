import { timingSafeEqual } from 'node:crypto'
import type { ServerMessage } from '@laplace.live/kakashi-protocol'
import { CloseCode, PROTOCOL_VERSION, parseClientMessage, readHelloProtocol } from '@laplace.live/kakashi-protocol'
import type { ServerWebSocket } from 'bun'

import { Hub, type HubOptions } from './hub'
import { isOriginAllowed } from './origin'

export interface KakashiServerOptions extends Omit<HubOptions, 'now'> {
  port: number
  hostname: string
  /** Empty = no token required. */
  token: string
  extraOrigins: readonly string[]
  version: string
}

interface SocketData {
  id: string
  authed: boolean
  helloTimer: ReturnType<typeof setTimeout> | null
}

const HELLO_TIMEOUT_MS = 10_000
const MAX_FRAME_BYTES = 16 * 1024

const noop = () => {}

function send(ws: ServerWebSocket<SocketData>, message: ServerMessage): void {
  ws.send(JSON.stringify(message))
}

function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Start the relay; `port: 0` picks a free port (tests). */
export function startKakashiServer(options: KakashiServerOptions) {
  const log = options.log ?? noop
  const debug = options.debug ?? noop
  const hub = new Hub({ masterGraceMs: options.masterGraceMs, log, debug })
  let nextId = 1

  const server = Bun.serve<SocketData>({
    port: options.port,
    hostname: options.hostname,
    fetch(req, srv) {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return Response.json({ name: 'kakashi-server', version: options.version, protocol: PROTOCOL_VERSION })
      }
      const origin = req.headers.get('origin')
      if (!isOriginAllowed(origin, options.extraOrigins)) {
        log(`⛔ Rejected origin ${origin} (allow it with --allow-origin)`)
        return new Response('Origin not allowed', { status: 403 })
      }
      const data: SocketData = { id: `tab-${nextId++}`, authed: false, helloTimer: null }
      return srv.upgrade(req, { data }) ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
    },
    websocket: {
      idleTimeout: 60,
      sendPings: true,
      maxPayloadLength: MAX_FRAME_BYTES,
      open(ws) {
        ws.data.helloTimer = setTimeout(() => ws.close(CloseCode.BAD_HELLO, 'hello timeout'), HELLO_TIMEOUT_MS)
      },
      message(ws, raw) {
        if (typeof raw !== 'string') return
        let json: unknown
        try {
          json = JSON.parse(raw)
        } catch {
          return
        }
        if (!ws.data.authed) {
          handleHello(ws, json)
          return
        }
        const msg = parseClientMessage(json)
        if (!msg) {
          debug(`Dropped malformed frame from ${ws.data.id}`)
          return
        }
        switch (msg.type) {
          case 'presence':
            hub.update(ws.data.id, msg)
            break
          case 'action':
            hub.action(ws.data.id, msg.action)
            break
          case 'result':
            hub.result(ws.data.id, msg.eventId, msg.status, msg.detail)
            break
          case 'hello':
            break
        }
      },
      close(ws) {
        if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer)
        hub.leave(ws.data.id)
      },
    },
  })

  function handleHello(ws: ServerWebSocket<SocketData>, json: unknown): void {
    const protocol = readHelloProtocol(json)
    if (protocol !== null && protocol !== PROTOCOL_VERSION) {
      log(`⛔ ${ws.data.id} speaks protocol ${protocol}, server speaks ${PROTOCOL_VERSION}`)
      ws.close(CloseCode.PROTOCOL_MISMATCH, `server protocol ${PROTOCOL_VERSION}`)
      return
    }
    const hello = parseClientMessage(json)
    if (hello?.type !== 'hello') {
      ws.close(CloseCode.BAD_HELLO, 'expected hello')
      return
    }
    if (options.token && !tokensMatch(hello.token, options.token)) {
      log(`⛔ Wrong token from ${hello.uname} (${hello.uid})`)
      ws.close(CloseCode.UNAUTHORIZED, 'wrong token')
      return
    }
    if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer)
    ws.data.helloTimer = null
    ws.data.authed = true
    send(ws, { type: 'welcome', serverVersion: options.version, protocol: PROTOCOL_VERSION })
    hub.join({
      id: ws.data.id,
      uid: hello.uid,
      uname: hello.uname,
      role: hello.role,
      roomId: hello.roomId,
      visible: hello.visible,
      follow: hello.follow,
      send: message => send(ws, message),
    })
  }

  return {
    server,
    hub,
    stop(): void {
      hub.stop()
      server.stop(true)
    },
  }
}
