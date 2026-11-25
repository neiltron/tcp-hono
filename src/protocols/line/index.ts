import type { Message, Protocol } from '../../types.ts'
import { concat, decode, endWith } from '../../utils.ts'

const empty = new Uint8Array(0)

/**
 * Create a function that cuts out lines from chunks. Both LF and CRLF are accepted.
 * The rest of the stream without a line terminator is treated as the last line.
 */
export const splitLines = (maxLength: number) => {
  let buffer: Uint8Array = empty
  const trim = (bytes: Uint8Array) => (bytes.at(-1) === 13 ? bytes.subarray(0, -1) : bytes)

  return function* (chunk?: Uint8Array): Generator<Uint8Array> {
    if (!chunk) {
      if (buffer.length) {
        yield trim(buffer)
        buffer = empty
      }
      return
    }
    buffer = buffer.length ? concat(buffer, chunk) : chunk
    for (let i; (i = buffer.indexOf(10)) !== -1;) {
      if (i > maxLength) {
        break
      }
      const bytes = trim(buffer.subarray(0, i))
      buffer = buffer.subarray(i + 1)
      yield bytes
    }
    if (buffer.length > maxLength) {
      throw new Error('Line too long')
    }
  }
}

/**
 * Split a line into arguments by whitespace.
 * Quote an argument with `"` or `'` to include whitespace. `\` escapes a character in `"`.
 */
export const tokenize = (str: string): string[] => {
  const args: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/gs
  for (const [, double, single, bare] of str.matchAll(re)) {
    args.push(bare ?? single ?? double.replace(/\\(.)/gs, '$1'))
  }
  return args
}

export type LineOptions = {
  /**
   * The max length of a line in bytes.
   * @default 65536
   */
  maxLength?: number
}

/**
 * Line protocol. A message is a line of text, and the response is terminated with a line feed.
 *
 * `HELLO Hono` is routed as `/HELLO/Hono`. The whole line is available as the body.
 */
export const line = (options: LineOptions = {}): Protocol => ({
  decode: () => {
    const split = splitLines(options.maxLength ?? 65536)
    return function* (chunk): Generator<Message> {
      for (const body of split(chunk)) {
        const args = tokenize(decode(body))
        if (args.length) {
          yield { args, body }
        }
      }
    }
  },
  respond: (res) => endWith(res, '\n'),
})
