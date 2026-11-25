import type { Message, Protocol } from '../../types.ts'
import { decode, endWith } from '../../utils.ts'
import { splitLines } from '../line/index.ts'

export type WhoisOptions = {
  /**
   * The max length of a query in bytes.
   * @default 1024
   */
  maxLength?: number
}

/**
 * WHOIS protocol (RFC 3912). The first line is a query. The connection is closed after the response.
 *
 * The query is split by whitespace and slashes: `honojs/hono` is routed as `/honojs/hono`.
 * The whole query is available as the body.
 */
export const whois = (options: WhoisOptions = {}): Protocol => ({
  decode: () => {
    const split = splitLines(options.maxLength ?? 1024)
    return function* (chunk): Generator<Message> {
      for (const body of split(chunk)) {
        yield {
          args: decode(body)
            .split(/[\s/]+/)
            .filter(Boolean),
          body,
        }
      }
    }
  },
  respond: (res) => endWith(res, '\r\n'),
  once: true,
})
