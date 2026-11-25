import { createRequest } from './get-path.ts'
import { line } from './protocols/line/index.ts'
import type { Message, Socket, TCPOptions } from './types.ts'

type App = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetch: (request: Request, env?: any, executionCtx?: any) => Response | Promise<Response>
}

type SocketHandler = (socket: Socket, env?: unknown, executionCtx?: unknown) => Promise<void>

const noop = () => {}

const socket = (app: App, options: TCPOptions = {}): SocketHandler => {
  const protocol = options.protocol ?? line()

  return async (socket, env, executionCtx) => {
    const decode = protocol.decode()
    const reader = socket.readable.getReader()
    const writer = socket.writable.getWriter()

    const send = async (res: Response, message?: Message) => {
      res = protocol.respond ? await protocol.respond(res, message) : res
      if (res.body) {
        const body = res.body.getReader()
        for (;;) {
          const { value, done } = await body.read()
          if (done) {
            break
          }
          // Awaiting `write()` applies the backpressure of the socket to the handler.
          await writer.write(value)
        }
      }
      return res
    }

    try {
      loop: for (;;) {
        // The next chunk is not read until all the messages in the current chunk are processed.
        const { value, done } = await reader.read()
        try {
          for (const message of decode(done ? undefined : value)) {
            const res = await send(
              await app.fetch(createRequest(message), env, executionCtx),
              message
            )
            if (protocol.once || res.headers.get('Connection') === 'close') {
              break loop
            }
          }
        } catch (e) {
          // A malformed message or an error that the app can not handle.
          await send(new Response(e instanceof Error ? e.message : 'Bad Request', { status: 400 }))
          break
        }
        if (done) {
          // The client closed its writable side (half-close). All the responses have been sent.
          break
        }
      }
    } catch {
      // The client has gone.
    } finally {
      // Close the writable side first to flush the responses.
      await writer.close().catch(noop)
      await reader.cancel().catch(noop)
      await Promise.resolve(socket.close()).catch(noop)
    }
  }
}

/**
 * Create a handler for Cloudflare Workers from the app.
 *
 * @example
 * ```ts
 * export default tcp(app)
 *
 * // With HTTP
 * export default {
 *   fetch: app.fetch,
 *   connect: tcp.socket(app),
 * }
 * ```
 */
export const tcp: {
  (app: App, options?: TCPOptions): { connect: SocketHandler }
  socket: typeof socket
} = Object.assign((app: App, options?: TCPOptions) => ({ connect: socket(app, options) }), {
  socket,
})
