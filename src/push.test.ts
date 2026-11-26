import { describe, expect, it } from 'vite-plus/test'
import { Hono, getConnection, tcp } from './index.ts'
import type { Connection } from './index.ts'
import { createSocket } from './test-utils.ts'

const decoder = new TextDecoder()

/** Read the socket until the text ends with `end`. */
const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, end: string) => {
  let text = ''
  while (!text.endsWith(end)) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    text += decoder.decode(value)
  }
  return text
}

describe('Server push', () => {
  it('Should write to the other connections', async () => {
    const subscribers = new Set<Connection>()
    const app = new Hono()
    app.on('TCP', '/SUBSCRIBE', (c) => {
      subscribers.add(getConnection(c))
      return c.text('OK')
    })
    app.on('TCP', '/PUBLISH/:message', (c) => {
      for (const subscriber of subscribers) {
        subscriber.send(`MESSAGE ${c.req.param('message')}\n`)
      }
      return c.text(String(subscribers.size))
    })
    const handler = tcp.socket(app, {
      onClose: (connection) => void subscribers.delete(connection),
    })

    const a = createSocket()
    const b = createSocket()
    const doneA = handler(a.socket)
    const doneB = handler(b.socket)
    const readerA = a.readable.getReader()
    const readerB = b.readable.getReader()

    void a.write('SUBSCRIBE\n')
    expect(await readUntil(readerA, '\n')).toBe('OK\n')
    void b.write('PUBLISH hello\n')
    expect(await readUntil(readerB, '\n')).toBe('1\n')
    expect(await readUntil(readerA, '\n')).toBe('MESSAGE hello\n')

    void a.end()
    void readerA.read()
    await doneA
    expect(subscribers.size).toBe(0)
    void b.end()
    void readerB.read()
    await doneB
  })

  it('Should call onOpen before the first message and onClose once', async () => {
    const events: string[] = []
    const app = new Hono()
    app.on('TCP', '/PING', (c) => {
      events.push('message')
      return c.text('PONG')
    })
    const client = createSocket()
    const done = tcp.socket(app, {
      onOpen: (connection) => {
        events.push('open')
        connection.send('220 Ready\n')
      },
      onClose: (connection) => {
        events.push(`close ${connection.closed}`)
      },
    })(client.socket)
    void client.write('PING\n')
    void client.end()
    expect(await client.text()).toBe('220 Ready\nPONG\n')
    await done
    expect(events).toEqual(['open', 'message', 'close true'])
  })

  it('Should write the data sent in a handler before its response', async () => {
    const app = new Hono()
    app.on('TCP', '/JOIN', (c) => {
      getConnection(c).send('pushed\n')
      return c.text('response')
    })
    const client = createSocket()
    const done = tcp.socket(app)(client.socket)
    void client.write('JOIN\n')
    void client.end()
    expect(await client.text()).toBe('pushed\nresponse\n')
    await done
  })

  it('Should not interleave a push with a streamed response', async () => {
    let connection: Connection | undefined
    let resume = () => {}
    const app = new Hono()
    app.on('TCP', '/STREAM', (c) => {
      connection = getConnection(c)
      return c.body(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('first '))
            await new Promise<void>((resolve) => (resume = resolve))
            controller.enqueue(new TextEncoder().encode('second'))
            controller.close()
          },
        })
      )
    })
    const client = createSocket()
    const done = tcp.socket(app)(client.socket)
    const reader = client.readable.getReader()
    void client.write('STREAM\n')
    expect(await readUntil(reader, 'first ')).toBe('first ')
    connection!.send('pushed\n')
    resume()
    expect(await readUntil(reader, 'pushed\n')).toBe('second\npushed\n')
    void client.end()
    void reader.read()
    await done
  })

  it('Should close the connection after the queued data is written', async () => {
    const app = new Hono()
    const client = createSocket()
    const done = tcp.socket(app, {
      onOpen: (connection) => {
        setTimeout(() => {
          connection.send('Bye\n')
          connection.close()
          connection.send('discarded\n')
        }, 10)
      },
    })(client.socket)
    // The client does not close its side.
    expect(await client.text()).toBe('Bye\n')
    await done
    expect(client.closed).toBe(true)
  })

  it('Should disconnect a client that does not read', async () => {
    let connection: Connection | undefined
    let closed = false
    const client = createSocket()
    const done = tcp.socket(new Hono(), {
      maxBufferedBytes: 1024,
      onOpen: (c) => void (connection = c),
      onClose: () => void (closed = true),
    })(client.socket)
    await new Promise((r) => setTimeout(r, 10))
    for (let i = 0; i < 5; i++) {
      connection!.send(new Uint8Array(512))
    }
    await done
    expect(closed).toBe(true)
    expect(connection!.closed).toBe(true)
  })

  it('Should throw for a request that does not come from a socket', async () => {
    const app = new Hono()
    app.get('/', (c) => c.text(String(getConnection(c).closed)))
    const res = await app.request('/')
    expect(res.status).toBe(500)
  })
})
