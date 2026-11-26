# tcp-hono

**Hono beyond HTTP.**

`tcp-hono` is a Preset and Adapters to use [Hono](https://hono.dev) as a TCP server. It is not a new framework. Routing, Context, Middleware, Validator, Renderer, and the types are Hono's own.

```ts
import { Hono, tcp } from 'tcp-hono'

const app = new Hono()

app.on('TCP', '/PING', (c) => {
  return c.text('PONG')
})

app.on('TCP', '/HELLO/:name', (c) => {
  return c.text(`Hello, ${c.req.param('name')}!`)
})

export default tcp(app)
```

```sh
$ nc localhost 3000
PING
PONG
HELLO Hono
Hello, Hono!
```

> [!WARNING]
> This is experimental. The API may change.

## Install

```sh
npm i tcp-hono hono
```

## Tiny

The core is about **280 lines** in four files. Everything else is Hono itself.

| File                                   | Lines | Role                                                   |
| -------------------------------------- | ----: | ------------------------------------------------------ |
| [`src/hono.ts`](./src/hono.ts)         |    23 | The preset                                             |
| [`src/router.ts`](./src/router.ts)     |    31 | `TCPRouter`, which delegates matching to a Hono router |
| [`src/get-path.ts`](./src/get-path.ts) |    74 | A TCP message to a `Request`, and `getPath`            |
| [`src/tcp.ts`](./src/tcp.ts)           |   152 | The loop that reads messages and writes responses      |

The size of each entry point, without `hono`:

| Entry            | Contents                                   | Minified | Minified + gzip |
| ---------------- | ------------------------------------------ | -------: | --------------: |
| `tcp-hono`       | Preset, router, adapter, and Line protocol |   2.6 kB |          1.4 kB |
| `tcp-hono/resp`  | RESP protocol and renderer                 |   2.5 kB |          1.3 kB |
| `tcp-hono/whois` | WHOIS protocol and renderer                |   1.2 kB |          0.7 kB |

It is small because it adds nothing to Hono. A message becomes a path, and Hono's router matches it. A message becomes a `Request`, and `app.fetch()` handles it. So `c.req.param()`, Validator, `c.render()`, and Middleware work without any change.

## How it works

1. A **Protocol** cuts out messages from the byte stream. `HELLO Hono` becomes the arguments `['HELLO', 'Hono']`.
2. The arguments become a path, `/HELLO/Hono`, and a Web Standard `Request` whose method is `TCP` is passed to `app.fetch()`. No HTTP communication happens. `Request` and `Response` are used as data structures.
3. The body of the `Response` is written back to the socket. The status code and the headers are not sent.

| Message       | Path           |
| ------------- | -------------- |
| `PING`        | `/PING`        |
| `HELLO Hono`  | `/HELLO/Hono`  |
| `GET foo`     | `/GET/foo`     |
| `SET foo bar` | `/SET/foo/bar` |

Each argument is percent-encoded into a path segment, and `c.req.param()` decodes it. So arguments including spaces, slashes, `%`, or Unicode are not broken:

```
HELLO "a b/c 100%"   ->   c.req.param('name') === 'a b/c 100%'
```

Path parameters, regular expressions, wildcards, `app.route()`, `basePath()`, `onError()`, and `notFound()` work as usual.

## HTTP and TCP on the same app

```ts
import { Hono, tcp } from 'tcp-hono'

const app = new Hono()

app.get('/', (c) => c.text('Hello HTTP!'))

app.on('TCP', '/PING', (c) => {
  return c.text('PONG')
})

export default {
  fetch: app.fetch,
  connect: tcp.socket(app),
}
```

- `tcp(app)` returns `{ connect }` for Cloudflare Workers.
- `tcp.socket(app)` returns the handler itself: `(socket, env, ctx) => Promise<void>`.

`Hono` of `tcp-hono` is a preset like `hono/tiny`. For HTTP, it uses the same routers as the standard `hono` (`SmartRouter` with `RegExpRouter` and `TrieRouter`), so HTTP routes behave the same. The `router`, `strict`, and `getPath` options are also available.

TCP routes can not be called from HTTP. Only the requests created from a socket reach them. An HTTP request with the `TCP` method gets `404` without running any handler or middleware.

Middleware registered with `app.use()` runs for both HTTP and TCP.

## Protocols

TCP is a byte stream and has no message boundaries. A protocol is responsible for framing, and it is replaceable.

```ts
export default tcp(app, { protocol: resp() })
```

### Line (default)

A message is a line of text terminated by LF or CRLF. It is split into arguments by whitespace. Quote an argument with `"` or `'` to include whitespace. The whole line is available as the body, e.g. `await c.req.text()`. A line feed is added to the response if it does not end with one.

```ts
import { line } from 'tcp-hono'

tcp(app, { protocol: line({ maxLength: 1024 }) }) // 65536 bytes by default
```

### WHOIS

[RFC 3912](https://www.rfc-editor.org/rfc/rfc3912). The first line is a query, and the connection is closed after the response. The query is split by whitespace and slashes, so `honojs/hono` is routed as `/honojs/hono`.

```ts
import { Hono, tcp } from 'tcp-hono'
import { whois, whoisRenderer } from 'tcp-hono/whois'

const app = new Hono()

app.use('*', whoisRenderer())

app.on('TCP', '/:owner/:repo', (c) => {
  const { owner, repo } = c.req.param()
  return c.render({
    Repository: `${owner}/${repo}`,
    Stars: 100,
  })
})

export default tcp(app, { protocol: whois() })
```

```sh
$ whois -h localhost -p 8043 honojs/hono
Repository: honojs/hono
Stars:      100
```

### RESP

[Redis Serialization Protocol](https://redis.io/docs/latest/develop/reference/protocol-spec/) (RESP2). It accepts arrays of bulk strings, which `redis-cli` sends, and inline commands. The command name is uppercased, so `set foo bar` is routed as `/SET/foo/bar`. The last argument is available as the body without being converted to a string, e.g. `await c.req.arrayBuffer()`.

```ts
import { Hono, tcp } from 'tcp-hono'
import { resp, respRenderer } from 'tcp-hono/resp'

const app = new Hono()

app.use('*', respRenderer())

app.on('TCP', '/PING', (c) => {
  return c.render({ simple: 'PONG' })
})

app.on('TCP', '/ECHO/:message', (c) => {
  return c.render(c.req.param('message'))
})

export default tcp(app, { protocol: resp() })
```

`c.render()` takes a value and you do not need to know the wire format:

| Value                                 | RESP             |
| ------------------------------------- | ---------------- |
| `'foo'`, `Uint8Array`                 | Bulk string      |
| `1`, `1n`, `true`                     | Integer          |
| `null`, `undefined`                   | Null bulk string |
| `['a', 1, null]`                      | Array            |
| `{ simple: 'OK' }`                    | Simple string    |
| `{ error: 'ERR Something is wrong' }` | Error            |

Responses that are not created by `c.render()` are also converted so that the client does not get broken: Not Found becomes `-ERR unknown command`, the other error responses become an error with the body as the message, and the rest become a bulk string.

### Closing the connection

Set the `Connection: close` header. The connection is closed after the response is written.

```ts
app.on('TCP', '/QUIT', (c) => {
  c.header('Connection', 'close')
  return c.text('Bye!')
})
```

### Writing a protocol

```ts
import type { Protocol } from 'tcp-hono'

const myProtocol = (): Protocol => ({
  // Called for each connection. The returned decoder has the state of the connection.
  decode: () => {
    return function* (chunk) {
      // `chunk` is `undefined` at the end of the stream.
      // Yield `{ args, body }` for each complete message. Throw an error for a malformed message.
    }
  },
  // Optional. Convert the Response from the app into the one written to the socket.
  respond: (res, message) => res,
  // Optional. Close the connection after the first response.
  once: false,
})
```

Connection handling:

- A message split into multiple chunks, and multiple messages in a chunk, are handled.
- Messages on a connection are processed one by one, and the responses are written in order.
- The next message is not processed until the response has been written to the socket. A streaming body, such as `c.body(readableStream)`, is piped with backpressure.
- When the client half-closes, the remaining responses are sent, and then the connection is closed.
- If a message is malformed or exceeds the size limit, an error is sent and the connection is closed.

## Server push

A response is written only for a message. To write to a socket at any other time, such as Pub/Sub, a chat, or a greeting, use the connection.

```ts
import { Hono, getConnection, tcp } from 'tcp-hono'
import type { Connection } from 'tcp-hono'

const app = new Hono()
const subscribers = new Set<Connection>()

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

export default tcp(app, {
  onOpen: (connection) => connection.send('Welcome!\n'),
  onClose: (connection) => void subscribers.delete(connection),
})
```

- `getConnection(c)` returns the `Connection` that the message came from. It has `send(data)`, `close()`, and `closed`.
- `onOpen` is called before the first message is read, and `onClose` is called once when either side closes the connection.
- `send()` takes a string or a `Uint8Array` and writes it as is. `respond()` of the protocol is not applied.
- The data is queued and written in order. It is not interleaved with a response, even a streaming one. The data sent in a handler is written before the response of the handler.
- `send()` does not wait for the client. If more than `maxBufferedBytes` (1 MiB by default) is waiting to be written, the client is disconnected.

The connections must live in the same isolate to reach each other. On Cloudflare Workers, hold them in a Durable Object: pipe the socket of the `connect()` handler of the Worker to the `connect()` handler of the object, and call `tcp.socket(app, options)` there.

## Renderer types

The renderers add a call signature to `ContextRenderer` of Hono, in the same way as the JSX Renderer. The signatures are merged as overloads, so `tcp-hono/resp`, `tcp-hono/whois`, and your own HTTP renderer can live in the same project.

## Node.js

```ts
import { Hono } from 'tcp-hono'
import { tcp } from 'tcp-hono/node'

const app = new Hono()

app.on('TCP', '/PING', (c) => c.text('PONG'))

tcp(app, { port: 3000 })
```

`tcp()` returns a `net.Server`. It takes `protocol`, `port`, and `hostname`.

## Other runtimes

The core depends only on Web Standard APIs and Web Streams. `tcp.socket(app)` takes any object that has this shape, so you can write an adapter for Deno or Bun in a few lines.

```ts
interface Socket {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  close(): void | Promise<void>
}
```

## Cloudflare Workers

See [Connect handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/connect/). For local development with `cf dev`, add a connect trigger to `cloudflare.config.ts`:

```ts
import { defineConfig, triggers } from 'cf/config'
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' }

export default defineConfig({
  worker: {
    name: 'my-app',
    compatibilityDate: '2026-11-17',
    entrypoint,
    triggers: [triggers.connect({ protocol: 'tcp', port: 3000 })],
  },
})
```

## Examples

- [examples/hello](./examples/hello) - HTTP and TCP on the same app. Cloudflare Workers and Node.js.
- [examples/github-whois](./examples/github-whois) - A WHOIS server that returns the information of a GitHub repository.
- [examples/redis](./examples/redis) - A Redis-compatible server backed by Durable Objects. It listens on 6380 so that it does not conflict with a real Redis. It has no authentication, so use it locally or restrict the source addresses.

```sh
pnpm install
pnpm build
cd examples/redis
pnpm dev

redis-cli -2 -p 6380 SET foo bar
```

The examples use the [`cf` CLI](https://developers.cloudflare.com/cf/) and the Cloudflare Vite plugin.

## Limitations

- An empty argument, such as `SET foo ""`, does not match a path parameter, the same as an empty path segment in HTTP. It results in Not Found.
- Path parameters are strings decoded as UTF-8. Use the body for binary data.
- There is no idle timeout and no limit on the number of connections.

## Development

The toolchain is pnpm and [Vite+](https://viteplus.dev).

```sh
pnpm install
pnpm test    # vp test
pnpm check   # vp check: format, lint, and type check
pnpm build   # vp pack
```

## Author

Yusuke Wada <https://github.com/yusukebe>

## License

MIT
