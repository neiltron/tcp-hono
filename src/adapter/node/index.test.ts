import type { Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { Hono } from '../../index.ts'
import { listen, sendText as send } from '../../test-utils.ts'

describe('Hello over a real TCP connection', () => {
  const app = new Hono()
  app.on('TCP', '/PING', (c) => c.text('PONG'))
  app.on('TCP', '/HELLO/:name', (c) => c.text(`Hello, ${c.req.param('name')}!`))
  app.on('TCP', '/QUIT', (c) => c.text('BYE', 200, { Connection: 'close' }))

  let server: Server
  let port: number
  beforeAll(async () => {
    ;({ server, port } = await listen(app))
  })
  afterAll(() => {
    server.close()
  })

  it('Should return PONG', async () => {
    expect(await send(port, ['PING\n'])).toBe('PONG\n')
  })

  it('Should handle multiple requests on the same connection', async () => {
    expect(await send(port, ['PING\n', 'HELLO Hono\n', 'PING\r\n'])).toBe(
      'PONG\nHello, Hono!\nPONG\n'
    )
  })

  it('Should handle multiple messages in a chunk', async () => {
    expect(await send(port, ['PING\nHELLO Hono\nPING\n'])).toBe('PONG\nHello, Hono!\nPONG\n')
  })

  it('Should handle a message split into multiple chunks', async () => {
    expect(await send(port, ['PI', 'NG\nHEL', 'LO Ho', 'no\n'])).toBe('PONG\nHello, Hono!\n')
  })

  it('Should handle the last line without a line feed', async () => {
    expect(await send(port, ['PING'])).toBe('PONG\n')
  })

  it('Should return 404 Not Found for an unknown message', async () => {
    expect(await send(port, ['FOO\nPING\n'])).toBe('404 Not Found\nPONG\n')
  })

  it('Should close the connection by `Connection: close`', async () => {
    expect(await send(port, ['QUIT\nPING\n'])).toBe('BYE\n')
  })

  it('Should handle arguments including special characters', async () => {
    expect(await send(port, ['HELLO "Hono TCP"\n'])).toBe('Hello, Hono TCP!\n')
    expect(await send(port, ['HELLO a/b\n'])).toBe('Hello, a/b!\n')
    expect(await send(port, ['HELLO 100%\n'])).toBe('Hello, 100%!\n')
    expect(await send(port, ['HELLO %2F%20\n'])).toBe('Hello, %2F%20!\n')
    expect(await send(port, ['HELLO 炎🔥\n'])).toBe('Hello, 炎🔥!\n')
    expect(await send(port, ['HELLO ?a=b#c\n'])).toBe('Hello, ?a=b#c!\n')
  })

  it('Should handle a multi-byte character split into chunks', async () => {
    const bytes = new TextEncoder().encode('HELLO 炎\n')
    expect(await send(port, [bytes.subarray(0, 7), bytes.subarray(7)])).toBe('Hello, 炎!\n')
  })
})
