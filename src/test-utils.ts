import { connect } from 'node:net'
import type { AddressInfo, Server } from 'node:net'
import { tcp } from './adapter/node/index.ts'
import type { Message, Protocol, Socket, TCPOptions } from './index.ts'

type App = Parameters<typeof tcp>[0]

/** Start a server on a random port. */
export const listen = async (app: App, options: TCPOptions = {}) => {
  const server = await new Promise<Server>((resolve) => {
    const server = tcp(app, { ...options, port: 0, hostname: '127.0.0.1' }, () => resolve(server))
  })
  return { server, port: (server.address() as AddressInfo).port }
}

/** Send chunks over a real TCP connection, half-close, and collect everything until the server closes. */
export const send = (port: number, chunks: (string | Uint8Array)[], delay = 10) =>
  new Promise<Buffer>((resolve, reject) => {
    const client = connect({ port, host: '127.0.0.1', allowHalfOpen: true })
    const received: Buffer[] = []
    client.on('data', (data) => received.push(data))
    client.on('end', () => {
      client.end()
      resolve(Buffer.concat(received))
    })
    client.on('error', reject)
    client.on('connect', async () => {
      for (const chunk of chunks) {
        client.write(chunk)
        await new Promise((r) => setTimeout(r, delay))
      }
      client.end()
    })
  })

export const sendText = async (port: number, chunks: (string | Uint8Array)[]) =>
  (await send(port, chunks)).toString()

/** An in-memory socket built only on Web Streams. */
export const createSocket = () => {
  const input = new TransformStream<Uint8Array, Uint8Array>()
  const output = new TransformStream<Uint8Array, Uint8Array>()
  let closed = false
  const socket: Socket = {
    readable: input.readable,
    writable: output.writable,
    close: () => {
      closed = true
    },
  }
  const writer = input.writable.getWriter()
  const encoder = new TextEncoder()
  return {
    socket,
    write: (data: string | Uint8Array) =>
      writer.write(typeof data === 'string' ? encoder.encode(data) : data),
    end: () => writer.close(),
    readable: output.readable,
    text: () => new Response(output.readable).text(),
    bytes: async () => new Uint8Array(await new Response(output.readable).arrayBuffer()),
    get closed() {
      return closed
    },
  }
}

export const encoder = new TextEncoder()

/** Decode chunks with a new decoder of the protocol and return the arguments of the messages. */
export const decodeAll = (protocol: Protocol, chunks: (string | undefined)[]) => {
  const decode = protocol.decode()
  const messages: Message[] = []
  for (const chunk of chunks) {
    messages.push(...decode(chunk === undefined ? undefined : encoder.encode(chunk)))
  }
  return messages.map((m) => m.args)
}
