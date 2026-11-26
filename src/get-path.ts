import type { Connection, Message } from './types.ts'

export const METHOD_NAME_TCP = 'TCP'

/**
 * The path for a request whose method is `TCP` but that does not come from a socket.
 * `TCPRouter` never matches it.
 */
export const PATH_BLOCKED = '\0'

/**
 * A `Request` made from a TCP message. It is just a data structure. No HTTP communication happens.
 *
 * Some runtimes, such as workerd, do not allow creating a `Request` with a non-HTTP method,
 * so it is created as `POST` and `method` is overridden.
 */
class TCPRequest extends Request {
  path: string
  connection?: Connection

  constructor(path: string, body?: Uint8Array, connection?: Connection) {
    super(`tcp://localhost${path}`, { method: 'POST', body: body as Uint8Array<ArrayBuffer> })
    this.path = path
    this.connection = connection
  }

  get method() {
    return METHOD_NAME_TCP
  }
}

/**
 * Create a `Request` from a TCP message.
 *
 * Each argument is percent-encoded and becomes a path segment,
 * so `c.req.param()` returns the original value even if it contains spaces, slashes, or `%`.
 */
export const createRequest = (message: Message, connection?: Connection): Request =>
  new TCPRequest('/' + message.args.map(encodeURIComponent).join('/'), message.body, connection)

/**
 * Get the connection that the message came from.
 *
 * @example
 * ```ts
 * app.on('TCP', '/SUBSCRIBE', (c) => {
 *   subscribers.add(getConnection(c))
 *   return c.text('OK')
 * })
 * ```
 */
export const getConnection = (c: { req: { raw: Request } }): Connection => {
  const connection = c.req.raw instanceof TCPRequest ? c.req.raw.connection : undefined
  if (!connection) {
    throw new Error('The request does not come from a TCP connection')
  }
  return connection
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetPath = (request: Request, options?: { env?: any }) => string

/**
 * Wrap the `getPath` for HTTP.
 * Only the requests created by `createRequest()` can reach TCP routes.
 */
export const getPath =
  (httpGetPath: GetPath): GetPath =>
  (request, options) =>
    request instanceof TCPRequest
      ? request.path
      : request.method === METHOD_NAME_TCP
        ? PATH_BLOCKED
        : httpGetPath(request, options)
