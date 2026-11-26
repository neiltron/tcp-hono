import { describe, expect, it } from 'vite-plus/test'
import { Hono, getConnection, tcp } from '../../index.ts'
import { createSocket, decodeAll } from '../../test-utils.ts'
import { format, irc, parse } from './index.ts'

describe('IRC', () => {
  it('Should parse a message', () => {
    expect(parse('PING')).toEqual({ command: 'PING', params: [] })
    expect(parse('privmsg #hono :Hello World')).toEqual({
      command: 'PRIVMSG',
      params: ['#hono', 'Hello World'],
    })
    expect(parse(':nick!user@host PRIVMSG #hono ::)')).toEqual({
      source: 'nick!user@host',
      command: 'PRIVMSG',
      params: ['#hono', ':)'],
    })
    expect(parse('TOPIC #hono :')).toEqual({ command: 'TOPIC', params: ['#hono', ''] })
    expect(parse('  USER  guest  0 *   :Real Name ')).toEqual({
      command: 'USER',
      params: ['guest', '0', '*', 'Real Name '],
    })
    expect(parse('')).toBeUndefined()
    expect(parse('@only=tags')).toBeUndefined()
  })

  it('Should parse message tags', () => {
    expect(
      parse('@time=2026-11-26T00:00:00.000Z;draft/flag;+a=b\\:c\\sd\\\\ :src TAGMSG #hono')
    ).toEqual({
      tags: { time: '2026-11-26T00:00:00.000Z', 'draft/flag': '', '+a': 'b;c d\\' },
      source: 'src',
      command: 'TAGMSG',
      params: ['#hono'],
    })
  })

  it('Should format a message', () => {
    expect(format({ command: 'PING', params: ['token'] })).toBe('PING token')
    expect(
      format({ source: 'irc.example', command: '001', params: ['nick', 'Welcome to IRC'] })
    ).toBe(':irc.example 001 nick :Welcome to IRC')
    expect(format({ command: 'TOPIC', params: ['#hono', ''] })).toBe('TOPIC #hono :')
    expect(format({ command: 'PRIVMSG', params: ['#hono', ':)'] })).toBe('PRIVMSG #hono ::)')
    expect(
      format({ tags: { time: 'now', flag: '', a: 'b;c d\\' }, command: 'PING', params: [] })
    ).toBe('@time=now;flag;a=b\\:c\\sd\\\\ PING')
  })

  it('Should not let a parameter inject a line', () => {
    expect(format({ command: 'PRIVMSG', params: ['#hono', 'a\r\nQUIT'] })).toBe(
      'PRIVMSG #hono :a  QUIT'
    )
  })

  it('Should round-trip', () => {
    for (const line of [
      '@a=b\\:c;d :nick!user@host PRIVMSG #hono :Hello World',
      ':irc.example 353 nick = #hono :@alice +bob carol',
      'JOIN #a,#b key',
    ]) {
      expect(format(parse(line)!)).toBe(line)
    }
  })

  it('Should decode messages', () => {
    expect(decodeAll(irc(), ['NICK alice\r\nUSER alice 0 * :Alice A\r\n'])).toEqual([
      ['NICK', 'alice'],
      ['USER', 'alice', '0', '*', 'Alice A'],
    ])
    expect(decodeAll(irc(), ['PRIVMSG #ho', 'no :Hi\n', '\r\n'])).toEqual([
      ['PRIVMSG', '#hono', 'Hi'],
    ])
  })

  it('Should route by the command and the parameters', async () => {
    const app = new Hono()
    app.on('TCP', '/PING/:token', (c) => c.text(`PONG :${c.req.param('token')}`))
    app.on('TCP', '/PRIVMSG/:target/:text', (c) => {
      const { target, text } = c.req.param()
      // IRC is not a request/response protocol. Most of the output is pushed.
      getConnection(c).send(`:me PRIVMSG ${target} :${text.toUpperCase()}\r\n`)
      return c.body(null)
    })
    app.on('TCP', '/TOPIC/:channel/*', async (c) => {
      const message = parse(await c.req.text())!
      return c.text(`params=${JSON.stringify(message.params)}`)
    })
    const client = createSocket()
    const done = tcp.socket(app, { protocol: irc() })(client.socket)
    void client.write('PING :a b\r\nPRIVMSG #hono :Hello World\r\nTOPIC #hono :\r\nBOGUS x\r\n')
    void client.end()
    expect(await client.text()).toBe(
      [
        'PONG :a b',
        ':me PRIVMSG #hono :HELLO WORLD',
        'params=["#hono",""]',
        '421 * BOGUS :Unknown command',
        '',
      ].join('\r\n')
    )
    await done
  })

  it('Should close the connection for a line that is too long', async () => {
    const client = createSocket()
    const done = tcp.socket(new Hono(), { protocol: irc({ maxLength: 16 }) })(client.socket)
    void client.write('PRIVMSG #hono :' + 'a'.repeat(32) + '\r\n')
    expect(await client.text()).toBe('ERROR :Line too long\r\n')
    await done
  })
})
