import { RESP_CONTENT_TYPE, respResponse } from './renderer.ts'
import type { Message, Protocol } from '../../types.ts'
import { concat, decode, encode } from '../../utils.ts'
import { tokenize } from '../line/index.ts'

type Parsed = [parts: Uint8Array[], consumed: number] | undefined

const empty = new Uint8Array(0)

// Returns a line and the position of the next line. `undefined` means more data is needed.
const readLine = (buffer: Uint8Array, from: number): [string, number] | undefined => {
  const i = buffer.indexOf(10, from)
  if (i !== -1) {
    return [decode(buffer.subarray(from, buffer[i - 1] === 13 ? i - 1 : i)), i + 1]
  }
}

const readLength = (str: string, max: number, name: string): number => {
  const length = /^-?\d+$/.test(str) ? Number(str) : NaN
  if (!(length <= max)) {
    throw new Error(`ERR Protocol error: invalid ${name} length`)
  }
  return length
}

// *2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n
const parseArray = (buffer: Uint8Array, maxSize: number): Parsed => {
  let line = readLine(buffer, 1)
  if (!line) {
    return
  }
  const count = readLength(line[0], maxSize, 'multibulk')
  const parts: Uint8Array[] = []
  let pos = line[1]
  for (let i = 0; i < count; i++) {
    if (pos >= buffer.length) {
      return
    }
    if (buffer[pos] !== 36) {
      throw new Error(`ERR Protocol error: expected '$', got '${String.fromCharCode(buffer[pos])}'`)
    }
    line = readLine(buffer, pos + 1)
    if (!line) {
      return
    }
    const end = line[1] + Math.max(readLength(line[0], maxSize, 'bulk'), 0)
    if (buffer.length < end + 2) {
      return
    }
    parts.push(buffer.subarray(line[1], end))
    pos = end + 2
  }
  return [parts, pos]
}

// Inline command: GET foo\r\n
const parseInline = (buffer: Uint8Array): Parsed => {
  const line = readLine(buffer, 0)
  return line && [tokenize(line[0]).map(encode), line[1]]
}

export type RESPOptions = {
  /**
   * The max size of a request in bytes.
   * @default 1048576
   */
  maxSize?: number
}

/**
 * RESP (Redis Serialization Protocol). It accepts arrays of bulk strings and inline commands.
 *
 * `SET foo bar` is routed as `/SET/foo/bar`. The command name is uppercased.
 * The last argument is available as the body without being converted to a string.
 *
 * Responses that are not rendered by `c.render()` are also converted into RESP:
 * an error response becomes an error, and the others become a bulk string.
 */
export const resp = (options: RESPOptions = {}): Protocol => {
  const maxSize = options.maxSize ?? 1024 * 1024
  return {
    decode: () => {
      let buffer: Uint8Array = empty
      return function* (chunk): Generator<Message> {
        if (!chunk) {
          return
        }
        buffer = buffer.length ? concat(buffer, chunk) : chunk
        while (buffer.length) {
          const parsed = buffer[0] === 42 ? parseArray(buffer, maxSize) : parseInline(buffer)
          if (!parsed) {
            break
          }
          const [parts, consumed] = parsed
          buffer = buffer.subarray(consumed)
          if (parts.length) {
            const args = parts.map(decode)
            args[0] = args[0].toUpperCase()
            yield { args, body: parts[parts.length - 1] }
          }
        }
        if (buffer.length > maxSize) {
          throw new Error('ERR Protocol error: too big request')
        }
      }
    },
    respond: async (res, message) => {
      if (res.headers.get('Content-Type') === RESP_CONTENT_TYPE) {
        return res
      }
      if (res.status === 404) {
        return respResponse(
          { error: `ERR unknown command '${message?.args[0]}' or wrong number of arguments` },
          res
        )
      }
      if (!res.ok) {
        const text = await res.text()
        return respResponse({ error: /^[A-Z]+ /.test(text) ? text : `ERR ${text}` }, res)
      }
      return respResponse(new Uint8Array(await res.arrayBuffer()), res)
    },
  }
}
