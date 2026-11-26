/**
 * The minimum socket interface that `tcp-hono` depends on.
 * The `Socket` of Cloudflare Workers satisfies it as is.
 */
export interface Socket {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  close(): void | Promise<void>
}

/**
 * A message cut out from the byte stream by a protocol.
 *
 * `args` becomes the routing path: `['HELLO', 'Hono']` is routed as `/HELLO/Hono`.
 * `body` becomes the body of the `Request`, so it is available as binary data.
 */
export type Message = {
  args: string[]
  body?: Uint8Array
}

/**
 * A decoder holds the state of one connection.
 * It receives a chunk and yields the complete messages. `undefined` means the end of the stream.
 * Throwing an error means the message is malformed. The connection will be closed.
 */
export type Decoder = (chunk?: Uint8Array) => Iterable<Message>

export interface Protocol {
  /** Create a decoder for a new connection. */
  decode(): Decoder
  /** Convert the `Response` returned from the app into the one written to the socket. */
  respond?(res: Response, message?: Message): Response | Promise<Response>
  /** Close the connection after the first response. */
  once?: boolean
}

/**
 * A connection, which lives longer than a message.
 * It is used to write to the socket without a message from the client, i.e. server push.
 * Get it with `getConnection(c)` in a handler, or from the `onOpen` and `onClose` hooks.
 */
export interface Connection {
  /**
   * Write data to the socket. It is not a response, so `respond()` of the protocol is not applied.
   * The data is queued and written in order. It is never interleaved with a response.
   * The data is discarded if the connection is closed.
   */
  send(data: string | Uint8Array): void
  /** Close the connection after the queued data has been written. */
  close(): void
  readonly closed: boolean
}

export type TCPOptions = {
  /** @default line() */
  protocol?: Protocol
  /** Called when a client has connected, before the first message is read. */
  onOpen?(connection: Connection): void | Promise<void>
  /** Called once when the connection is closed by either side. */
  onClose?(connection: Connection): void | Promise<void>
  /**
   * The max size in bytes of the data queued by `send()` that the client has not received yet.
   * A client that does not read fast enough to stay below it is disconnected.
   * @default 1048576
   */
  maxBufferedBytes?: number
}
