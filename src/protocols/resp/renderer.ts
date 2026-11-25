// Import from 'hono' so that the module augmentation below is applied reliably.
import type { ContextRenderer, MiddlewareHandler } from 'hono'
import { concat, encode } from '../../utils.ts'

/**
 * A value rendered as RESP2.
 *
 * - `string`, `Uint8Array`: Bulk string
 * - `number` (integer), `bigint`, `boolean`: Integer
 * - `null`, `undefined`: Null bulk string
 * - Array: Array
 * - `{ simple: 'OK' }`: Simple string
 * - `{ error: 'ERR message' }`: Error
 */
export type RESPValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Uint8Array
  | RESPValue[]
  | { simple: string }
  | { error: string }

declare module 'hono' {
  interface ContextRenderer {
    (value: RESPValue): Response
  }
}

export const RESP_CONTENT_TYPE = 'application/x-resp'

const CRLF = encode('\r\n')
const line = (str: string) => encode(`${str.replace(/[\r\n]+/g, ' ')}\r\n`)

const push = (chunks: Uint8Array[], value: RESPValue): void => {
  if (value === null || value === undefined) {
    chunks.push(line('$-1'))
  } else if (Array.isArray(value)) {
    chunks.push(line(`*${value.length}`))
    for (const v of value) {
      push(chunks, v)
    }
  } else if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) {
    chunks.push(line(`:${value}`))
  } else if (typeof value === 'boolean') {
    chunks.push(line(`:${value ? 1 : 0}`))
  } else if (typeof value === 'object' && 'simple' in value) {
    chunks.push(line(`+${value.simple}`))
  } else if (typeof value === 'object' && 'error' in value) {
    chunks.push(line(`-${value.error}`))
  } else {
    const bytes = value instanceof Uint8Array ? value : encode(String(value as string | number))
    chunks.push(line(`$${bytes.length}`), bytes, CRLF)
  }
}

/**
 * Encode a value into the RESP2 wire format.
 */
export const encodeRESP = (value: RESPValue): Uint8Array<ArrayBuffer> => {
  const chunks: Uint8Array[] = []
  push(chunks, value)
  return concat(...chunks)
}

export const respResponse = (value: RESPValue, init?: ResponseInit): Response => {
  const res = new Response(encodeRESP(value), init)
  res.headers.set('Content-Type', RESP_CONTENT_TYPE)
  return res
}

/**
 * Renderer Middleware for RESP. `c.render()` takes a value and renders it as RESP2.
 *
 * @example
 * ```ts
 * app.use('*', respRenderer())
 * app.on('TCP', '/PING', (c) => c.render({ simple: 'PONG' }))
 * ```
 */
export const respRenderer = (): MiddlewareHandler => (c, next) => {
  c.setRenderer(((value: RESPValue) =>
    c.body(encodeRESP(value), {
      headers: { 'Content-Type': RESP_CONTENT_TYPE },
    })) as ContextRenderer)
  return next()
}
