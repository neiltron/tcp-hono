import { createServer } from 'node:net'
import type { AddressInfo, Server } from 'node:net'
import { Duplex } from 'node:stream'
import { tcp as core } from '../../tcp.ts'
import type { Socket, TCPOptions } from '../../types.ts'

export type NodeTCPOptions = TCPOptions & {
  /** @default 3000 */
  port?: number
  hostname?: string
}

/**
 * Start a TCP server on Node.js.
 *
 * @example
 * ```ts
 * tcp(app, { port: 3000 })
 * ```
 */
export const tcp = (
  app: Parameters<typeof core.socket>[0],
  options: NodeTCPOptions = {},
  listeningListener?: (info: AddressInfo) => void
): Server => {
  const handler = core.socket(app, options)
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('error', () => {})
    const { readable, writable } = Duplex.toWeb(socket) as unknown as Socket
    void handler({ readable, writable, close: () => void socket.destroy() })
  })
  server.listen(options.port ?? 3000, options.hostname, () => {
    listeningListener?.(server.address() as AddressInfo)
  })
  return server
}
