import type { Message, Protocol } from '../../types.ts'
import { decode, endWith } from '../../utils.ts'
import { splitLines } from '../line/index.ts'

/**
 * An IRC message: `@tags :source COMMAND param param :trailing param`.
 */
export type IRCMessage = {
  /** IRCv3 message tags. A tag without a value is an empty string. */
  tags?: Record<string, string>
  /** The prefix without the leading `:`, e.g. `nick!user@host` or a server name. */
  source?: string
  /** Uppercased for a message parsed by `parse()`. */
  command: string
  params: string[]
}

const unescapes: Record<string, string> = { ':': ';', s: ' ', r: '\r', n: '\n' }
const escapes: Record<string, string> = { ';': '\\:', ' ': '\\s', '\r': '\\r', '\n': '\\n' }

const unescapeTag = (value: string) => value.replace(/\\(.?)/g, (_, c: string) => unescapes[c] ?? c)
const escapeTag = (value: string) => value.replace(/[; \r\n\\]/g, (c) => escapes[c] ?? '\\\\')

/**
 * Parse a line without the line terminator. Returns `undefined` if the line has no command.
 */
export const parse = (line: string): IRCMessage | undefined => {
  let rest = line.replace(/^ +/, '')
  // Cut out the first word and the spaces that follow it.
  const word = () => {
    const i = rest.indexOf(' ')
    const value = i === -1 ? rest : rest.slice(0, i)
    rest = i === -1 ? '' : rest.slice(i).replace(/^ +/, '')
    return value
  }

  let tags: Record<string, string> | undefined
  if (rest[0] === '@') {
    tags = {}
    for (const tag of word().slice(1).split(';')) {
      const i = tag.indexOf('=')
      const key = i === -1 ? tag : tag.slice(0, i)
      if (key) {
        tags[key] = i === -1 ? '' : unescapeTag(tag.slice(i + 1))
      }
    }
  }
  const source = rest[0] === ':' ? word().slice(1) : undefined
  const command = word().toUpperCase()
  if (!command) {
    return
  }
  const params: string[] = []
  while (rest) {
    if (rest[0] === ':') {
      params.push(rest.slice(1))
      break
    }
    params.push(word())
  }
  return { ...(tags && { tags }), ...(source !== undefined && { source }), command, params }
}

// A line terminator in a parameter would let a client inject a message.
const clean = (value: string) => value.replace(/[\r\n\0]/g, ' ')

/**
 * Format a message into a line without the line terminator.
 * The last parameter is sent as a trailing parameter if it is empty, has a space, or starts with `:`.
 */
export const format = (message: IRCMessage): string => {
  const parts: string[] = []
  const tags = Object.entries(message.tags ?? {})
  if (tags.length) {
    parts.push('@' + tags.map(([k, v]) => (v === '' ? k : `${k}=${escapeTag(v)}`)).join(';'))
  }
  if (message.source !== undefined) {
    parts.push(':' + clean(message.source))
  }
  parts.push(message.command)
  message.params.forEach((param, i) => {
    param = clean(param)
    const trailing =
      i === message.params.length - 1 && (param === '' || param.includes(' ') || param[0] === ':')
    parts.push(trailing ? ':' + param : param)
  })
  return parts.join(' ')
}

export type IRCOptions = {
  /**
   * The max length of a line in bytes, including the message tags.
   * @default 8703 (8191 for the tags and 512 for the rest)
   */
  maxLength?: number
}

/**
 * IRC protocol. A message is a line terminated by CRLF or LF.
 *
 * The command is uppercased and the parameters follow it: `PRIVMSG #hono :Hello World` is routed
 * as `/PRIVMSG/#hono/Hello World`. The whole line is available as the body. Use `parse()` to get
 * the tags, the source, and the parameters that a path can not express, such as an empty one.
 *
 * IRC is not a request/response protocol, so most of the output is written with `send()` of
 * the connection. A response without a body, e.g. `c.body(null)`, writes nothing.
 */
export const irc = (options: IRCOptions = {}): Protocol => ({
  decode: () => {
    const split = splitLines(options.maxLength ?? 8703)
    return function* (chunk): Generator<Message> {
      for (const body of split(chunk)) {
        const message = parse(decode(body))
        if (message) {
          yield { args: [message.command, ...message.params], body }
        }
      }
    }
  },
  respond: async (res, message) => {
    if (res.status === 404) {
      // The app does not have a route for the command and does not have its own `notFound()`.
      return new Response(`421 * ${message?.args[0] ?? '*'} :Unknown command\r\n`)
    }
    if (res.status === 400 && !message) {
      // A malformed message. The connection is closed after this.
      return new Response(`ERROR :${await res.text()}\r\n`)
    }
    return endWith(res, '\r\n')
  },
})
