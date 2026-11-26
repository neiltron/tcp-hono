import { createRequest } from './get-path.ts'
import { line } from './protocols/line/index.ts'
import type { Connection, Message, Socket, TCPOptions } from './types.ts'
import { encode } from './utils.ts'

type App = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetch: (request: Request, env?: any, executionCtx?: any) => Response | Promise<Response>
}

type SocketHandler = (socket: Socket, env?: unknown, executionCtx?: unknown) => Promise<void>

const noop = () => {}

const socket = (app: App, options: TCPOptions = {}): SocketHandler => {
  const protocol = options.protocol ?? line()
  const maxBufferedBytes = options.maxBufferedBytes ?? 1048576

  return async (socket, env, executionCtx) => {
    const decode = protocol.decode()
    const reader = socket.readable.getReader()
    const writer = socket.writable.getWriter()

    let closed = false
    let opened = false
    let buffered = 0
    let queue: Promise<unknown> = Promise.resolve()

    // All the writes go through the queue, so a push is never interleaved with a response.
    const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
      const result = queue.then(task)
      queue = result.catch(noop)
      return result
    }

    // Stop reading. A pending `read()` is resolved and the loop ends.
    const stop = () => {
      closed = true
      void reader.cancel().catch(noop)
    }

    const connection: Connection = {
      send: (data) => {
        if (closed) {
          return
        }
        const bytes = typeof data === 'string' ? encode(data) : data
        buffered += bytes.length
        if (buffered > maxBufferedBytes) {
          // The client does not read. Give up the queued data so that it does not use up the memory.
          stop()
          void writer.abort().catch(noop)
          return
        }
        void enqueue(() => writer.write(bytes))
          .catch(stop)
          .finally(() => (buffered -= bytes.length))
      },
      close: () => {
        if (!closed) {
          closed = true
          void enqueue(() => reader.cancel()).catch(noop)
        }
      },
      get closed() {
        return closed
      },
    }

    const send = async (res: Response, message?: Message) => {
      res = protocol.respond ? await protocol.respond(res, message) : res
      if (res.body) {
        const body = res.body.getReader()
        await enqueue(async () => {
          for (;;) {
            const { value, done } = await body.read()
            if (done) {
              break
            }
            // Awaiting `write()` applies the backpressure of the socket to the handler.
            await writer.write(value)
          }
        })
      }
      return res
    }

    try {
      await options.onOpen?.(connection)
      opened = true
      loop: for (;;) {
        // The next chunk is not read until all the messages in the current chunk are processed.
        const { value, done } = await reader.read()
        if (closed) {
          break
        }
        try {
          for (const message of decode(done ? undefined : value)) {
            const res = await send(
              await app.fetch(createRequest(message, connection), env, executionCtx),
              message
            )
            if (closed || protocol.once || res.headers.get('Connection') === 'close') {
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
      closed = true
      if (opened) {
        await Promise.resolve(options.onClose?.(connection)).catch(noop)
      }
      // Wait for the queued data, and close the writable side first to flush it.
      await queue
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
