import { connect } from 'node:net'
import { describe, expect, it } from 'vite-plus/test'
import { Hono, tcp } from './index.ts'
import { createSocket, listen, send, sendText } from './test-utils.ts'

describe('Connection', () => {
  it('Should send all the responses after the client half-closes', async () => {
    const app = new Hono()
    app.on('TCP', '/SLOW/:n', async (c) => {
      await new Promise((r) => setTimeout(r, 30))
      return c.text(c.req.param('n'))
    })
    const { server, port } = await listen(app)
    expect(await sendText(port, ['SLOW 1\nSLOW 2\nSLOW 3\n'])).toBe('1\n2\n3\n')
    server.close()
  })

  it('Should not process the next message until the response is written (backpressure)', async () => {
    const app = new Hono()
    let count = 0
    app.on('TCP', '/DATA', (c) => {
      count++
      return c.body(new Uint8Array(1024))
    })
    const client = createSocket()
    const done = tcp.socket(app)(client.socket)
    void client.write('DATA\nDATA\nDATA\n')
    await new Promise((r) => setTimeout(r, 30))
    // Nobody reads the socket, so the first write is pending.
    expect(count).toBe(1)
    void client.end()
    expect((await client.bytes()).length).toBe(1025 * 3)
    await done
    expect(count).toBe(3)
    expect(client.closed).toBe(true)
  })

  it('Should stream a large response', async () => {
    const app = new Hono()
    app.on('TCP', '/STREAM', (c) => {
      let i = 0
      return c.body(
        new ReadableStream({
          pull(controller) {
            if (i++ < 64) {
              controller.enqueue(new Uint8Array(65536).fill(97))
            } else {
              controller.close()
            }
          },
        })
      )
    })
    const { server, port } = await listen(app)
    expect((await send(port, ['STREAM\n'])).length).toBe(64 * 65536 + 1)
    server.close()
  })

  it('Should survive a client that disconnects without reading', async () => {
    const app = new Hono()
    app.on('TCP', '/PING', (c) => c.text('PONG'))
    app.on('TCP', '/BIG', (c) => c.body(new Uint8Array(8 * 1024 * 1024)))
    const { server, port } = await listen(app)
    await new Promise<void>((resolve) => {
      const client = connect({ port, host: '127.0.0.1' }, () => {
        client.write('BIG\n')
        setTimeout(() => {
          client.destroy()
          resolve()
        }, 20)
      })
    })
    expect(await sendText(port, ['PING\n'])).toBe('PONG\n')
    server.close()
  })

  it('Should handle concurrent connections separately', async () => {
    const app = new Hono()
    app.on('TCP', '/ECHO/:value', (c) => c.text(c.req.param('value')))
    const { server, port } = await listen(app)
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => sendText(port, [`ECHO ${i}`, `-a\nECHO `, `${i}-b\n`]))
    )
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => `${i}-a\n${i}-b\n`))
    server.close()
  })
})
