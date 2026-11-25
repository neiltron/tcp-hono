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

export type TCPOptions = {
  /** @default line() */
  protocol?: Protocol
}
