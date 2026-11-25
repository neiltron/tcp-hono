import type { Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vite-plus/test'
import { Hono } from '../../index.ts'
import { decodeAll, encoder, listen, send, sendText } from '../../test-utils.ts'
import { encodeRESP, resp, respRenderer } from './index.ts'

describe('RESP', () => {
  it('Should encode values', () => {
    const text = (value: Parameters<typeof encodeRESP>[0]) =>
      new TextDecoder().decode(encodeRESP(value))
    expect(text({ simple: 'OK' })).toBe('+OK\r\n')
    expect(text({ error: 'ERR bad\r\nthing' })).toBe('-ERR bad thing\r\n')
    expect(text('bar')).toBe('$3\r\nbar\r\n')
    expect(text('あ')).toBe('$3\r\nあ\r\n')
    expect(text('')).toBe('$0\r\n\r\n')
    expect(text(new Uint8Array([97, 98]))).toBe('$2\r\nab\r\n')
    expect(text(42)).toBe(':42\r\n')
    expect(text(-1n)).toBe(':-1\r\n')
    expect(text(1.5)).toBe('$3\r\n1.5\r\n')
    expect(text(true)).toBe(':1\r\n')
    expect(text(null)).toBe('$-1\r\n')
    expect(text(undefined)).toBe('$-1\r\n')
    expect(text([])).toBe('*0\r\n')
    expect(text(['a', 1, null, ['b', { simple: 'OK' }]])).toBe(
      '*4\r\n$1\r\na\r\n:1\r\n$-1\r\n*2\r\n$1\r\nb\r\n+OK\r\n'
    )
  })

  it('Should decode commands from chunks', () => {
    expect(decodeAll(resp(), ['*1\r\n$4\r\nping\r\n'])).toEqual([['PING']])
    expect(
      decodeAll(resp(), [
        '*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$7\r\nb r\r\n/%\r\n*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n',
      ])
    ).toEqual([
      ['SET', 'foo', 'b r\r\n/%'],
      ['GET', 'foo'],
    ])
    const bytes = '*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n'
    for (let i = 1; i < bytes.length; i++) {
      expect(decodeAll(resp(), [bytes.slice(0, i), bytes.slice(i)])).toEqual([
        ['SET', 'foo', 'bar'],
      ])
    }
    expect(decodeAll(resp(), bytes.split(''))).toEqual([['SET', 'foo', 'bar']])
    expect(decodeAll(resp(), ['*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$0\r\n\r\n'])).toEqual([
      ['SET', 'foo', ''],
    ])
    expect(decodeAll(resp(), ['*0\r\n*-1\r\n\r\n*1\r\n$4\r\nPING\r\n'])).toEqual([['PING']])
  })

  it('Should decode inline commands', () => {
    expect(decodeAll(resp(), ['ping\r\nset foo "hello world"\n'])).toEqual([
      ['PING'],
      ['SET', 'foo', 'hello world'],
    ])
  })

  it('Should pass the last argument as binary', () => {
    const decode = resp().decode()
    const chunk = new Uint8Array([
      ...encoder.encode('*2\r\n$4\r\nECHO\r\n$3\r\n'),
      0,
      255,
      10,
      13,
      10,
    ])
    const [message] = [...decode(chunk)]
    expect(message.body).toEqual(new Uint8Array([0, 255, 10]))
  })

  it('Should throw for malformed messages', () => {
    expect(() => decodeAll(resp(), ['*x\r\n'])).toThrow('invalid multibulk length')
    expect(() => decodeAll(resp(), ['*1\r\n:1\r\n'])).toThrow("expected '$', got ':'")
    expect(() => decodeAll(resp(), ['*1\r\n$x\r\n'])).toThrow('invalid bulk length')
    expect(() => decodeAll(resp({ maxSize: 16 }), ['*1\r\n$100\r\n'])).toThrow(
      'invalid bulk length'
    )
    expect(() => decodeAll(resp({ maxSize: 16 }), ['*99999\r\n'])).toThrow(
      'invalid multibulk length'
    )
    expect(() => decodeAll(resp({ maxSize: 16 }), ['a'.repeat(17)])).toThrow('too big request')
  })

  describe('Over a real TCP connection', () => {
    const app = new Hono()
    app.use('*', respRenderer())
    app.on('TCP', '/PING', (c) => c.render({ simple: 'PONG' }))
    app.on('TCP', '/ECHO/:message', (c) => c.render(c.req.param('message')))
    app.on('TCP', '/BIN/:data', async (c) => c.render(new Uint8Array(await c.req.arrayBuffer())))
    app.on('TCP', '/TEXT', (c) => c.text('plain'))
    app.on('TCP', '/ERROR', () => {
      throw new Error('Oops')
    })
    app.on('TCP', '/QUIT', (c) => {
      c.header('Connection', 'close')
      return c.render({ simple: 'OK' })
    })

    let server: Server
    let port: number
    beforeAll(async () => {
      ;({ server, port } = await listen(app, { protocol: resp() }))
    })
    afterAll(() => {
      server.close()
    })

    const command = (...args: string[]) =>
      `*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')}`

    it('Should respond in RESP', async () => {
      expect(await sendText(port, [command('PING')])).toBe('+PONG\r\n')
      expect(await sendText(port, [command('ECHO', 'a b/c%\r\nあ')])).toBe(
        '$11\r\na b/c%\r\nあ\r\n'
      )
    })

    it('Should handle pipelining in order', async () => {
      expect(
        await sendText(port, [command('ECHO', '1') + command('PING') + command('ECHO', '2')])
      ).toBe('$1\r\n1\r\n+PONG\r\n$1\r\n2\r\n')
    })

    it('Should handle binary data', async () => {
      const data = new Uint8Array([0, 255, 13, 10, 128])
      const res = await send(port, [
        Buffer.concat([Buffer.from('*2\r\n$3\r\nBIN\r\n$5\r\n'), data, Buffer.from('\r\n')]),
      ])
      expect(new Uint8Array(res)).toEqual(
        new Uint8Array([...Buffer.from('$5\r\n'), ...data, 13, 10])
      )
    })

    it('Should convert responses that are not rendered', async () => {
      expect(await sendText(port, [command('TEXT')])).toBe('$5\r\nplain\r\n')
      expect(await sendText(port, [command('FOO', 'bar')])).toBe(
        "-ERR unknown command 'FOO' or wrong number of arguments\r\n"
      )
      expect(await sendText(port, [command('ERROR')])).toBe('-ERR Internal Server Error\r\n')
    })

    it('Should return an error and close the connection for a malformed message', async () => {
      expect(await sendText(port, [command('PING') + '*1\r\n:1\r\n' + command('PING')])).toBe(
        "+PONG\r\n-ERR Protocol error: expected '$', got ':'\r\n"
      )
    })

    it('Should close the connection by `Connection: close`', async () => {
      expect(await sendText(port, [command('QUIT') + command('PING')])).toBe('+OK\r\n')
    })
  })

  it('Should type c.render()', () => {
    const app = new Hono()
    app.on('TCP', '/PING', (c) => {
      expectTypeOf(c.render).toBeCallableWith({ simple: 'PONG' })
      expectTypeOf(c.render).toBeCallableWith(null)
      expectTypeOf(c.render).toBeCallableWith(['a', 1])
      expectTypeOf(c.render).toBeCallableWith({ Repository: 'honojs/hono' })
      // @ts-expect-error a function is neither a RESP value nor a WHOIS value
      void (() => c.render(() => {}))
      return c.text('OK')
    })
  })
})
