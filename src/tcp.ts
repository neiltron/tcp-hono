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
    let buffered = 0
    let queue: Promise<unknown> = Promise.resolve()

    // All the writes go through the queue, so a push is never interleaved with a response.
    const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
      const result = queue.then(task)
      queue = result.catch(noop)
      return result
    }

    // `close()` wakes the loop from a pending read without canceling the reader,
    // because canceling it destroys the whole socket on Node.js before the queued data is written.
    let wake = noop
    const read = () =>
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        wake = () => resolve({ done: true, value: undefined })
        reader.read().then(resolve, reject)
      })

    // The body of the response being written, which may never end.
    let body: ReadableStreamDefaultReader<Uint8Array> | undefined

    // Disconnect at once. Give up the response being written, and close the socket
    // so that a write waiting for the client ends, then the loop and `onClose` follow.
    const stop = () => {
      closed = true
      wake()
      void body?.cancel().catch(noop)
      void writer.abort().catch(noop)
      // In a promise, because `close()` may throw when called from another request on Workers.
      void Promise.resolve()
        .then(() => socket.close())
        .catch(noop)
    }

    const connection: Connection = {
      send: (data) => {
        if (closed) {
          return
        }
        const bytes = typeof data === 'string' ? encode(data) : data
        buffered += bytes.length
        // A single large message is not a sign of a slow client, so only the data queued before it counts.
        if (buffered > maxBufferedBytes && buffered > bytes.length) {
          // The client does not read. Give up the queued data so that it does not use up the memory.
          stop()
          return
        }
        void enqueue(() => writer.write(bytes))
          .catch(stop)
          .finally(() => (buffered -= bytes.length))
      },
      close: () => {
        if (!closed) {
          // The loop ends, and the queued data is written before the socket is closed.
          closed = true
          wake()
        }
      },
      get closed() {
        return closed
      },
    }

    const send = async (res: Response, message?: Message) => {
      res = protocol.respond ? await protocol.respond(res, message) : res
      if (res.body) {
        const current = res.body.getReader()
        await enqueue(async () => {
          body = current
          for (;;) {
            const { value, done } = await current.read()
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
      loop: while (!closed) {
        // The next chunk is not read until all the messages in the current chunk are processed.
        const { value, done } = await read()
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
      // Called even if `onOpen` has thrown, so that it can undo what `onOpen` has done.
      // In a promise, so that an error thrown by `onClose` does not skip closing the socket.
      await Promise.resolve()
        .then(() => options.onClose?.(connection))
        .catch(noop)
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
