import { sValidator } from '@hono/standard-validator'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'
import * as v from 'valibot'
import { RegExpRouter } from 'hono/router/reg-exp-router'
import { Hono as StandardHono } from 'hono'
import { Hono, TCPRouter, tcp } from './index.ts'
import { createRequest } from './get-path.ts'
import { createSocket } from './test-utils.ts'

/** Send a message through `tcp.socket()` with an in-memory socket. */
const request = async (app: Hono<any, any, any>, data: string, env?: unknown) => {
  const client = createSocket()
  const done = tcp.socket(app)(client.socket, env)
  await client.write(data)
  await client.end()
  const text = await client.text()
  await done
  return text
}

describe('Preset', () => {
  it('Should use TCPRouter', () => {
    const app = new Hono()
    expect(app.router).toBeInstanceOf(TCPRouter)
    expect(app.router.name).toBe('TCPRouter')
  })

  it('Should route by the path made of the arguments', async () => {
    const app = new Hono()
    app.on('TCP', '/PING', (c) => c.text('PONG'))
    app.on('TCP', '/GET/:key', (c) => c.text(c.req.param('key')))
    app.on('TCP', '/SET/:key/:value', (c) => c.json(c.req.param()))
    app.on('TCP', '/ECHO/*', (c) => c.text(c.req.path))
    app.on('TCP', '/INCR/:n{[0-9]+}', (c) => c.text(`${Number(c.req.param('n')) + 1}`))

    expect(await request(app, 'PING\n')).toBe('PONG\n')
    expect(await request(app, 'GET foo\n')).toBe('foo\n')
    expect(JSON.parse(await request(app, 'SET foo bar\n'))).toEqual({ key: 'foo', value: 'bar' })
    expect(await request(app, 'ECHO a b c\n')).toBe('/ECHO/a/b/c\n')
    expect(await request(app, 'INCR 41\n')).toBe('42\n')
    expect(await request(app, 'INCR abc\n')).toBe('404 Not Found\n')
    expect(await request(app, 'GET\n')).toBe('404 Not Found\n')
    expect(await request(app, 'GET a b\n')).toBe('404 Not Found\n')
  })

  it('Should not break parameters including special characters', async () => {
    const app = new Hono()
    app.on('TCP', '/SET/:key/:value', (c) => c.json(c.req.param()))
    const set = async (key: string, value: string) =>
      (await app.fetch(createRequest({ args: ['SET', key, value] }))).json()

    for (const value of [
      'a b',
      'a/b',
      '/',
      '100%',
      '%2F',
      '%E3%81%82',
      'あ🔥',
      '?q=1#h',
      '*',
      ':id',
      '..',
      'a\tb',
      '\\',
    ]) {
      expect(await set(value, value)).toEqual({ key: value, value })
    }
  })

  it('Should pass the message as the body in binary', async () => {
    const app = new Hono()
    app.on('TCP', '/ECHO/*', async (c) => c.body(await c.req.arrayBuffer()))
    app.on('TCP', '/LEN', async (c) => c.text(`${(await c.req.arrayBuffer()).byteLength}`))
    expect(await request(app, 'ECHO  keep   spaces\n')).toBe('ECHO  keep   spaces\n')

    const body = new Uint8Array([0, 255, 254, 10, 13])
    const res = await app.fetch(createRequest({ args: ['LEN'], body }))
    expect(await res.text()).toBe('5')
  })

  it('Should write a binary response as is', async () => {
    const app = new Hono()
    const bytes = new Uint8Array([0, 255, 128, 10])
    app.on('TCP', '/BIN', (c) => c.body(bytes))
    const client = createSocket()
    const done = tcp.socket(app)(client.socket)
    await client.write('BIN\n')
    await client.end()
    expect(await client.bytes()).toEqual(bytes)
    await done
  })

  it('Should run middleware and handlers in the registration order', async () => {
    const app = new Hono()
    const log: string[] = []
    app.use('*', async (_, next) => {
      log.push('a:before')
      await next()
      log.push('a:after')
    })
    app.use('/PING', async (_, next) => {
      log.push('b:before')
      await next()
      log.push('b:after')
    })
    app.on('TCP', '/PING', (c) => {
      log.push('handler')
      return c.text('PONG')
    })
    app.use('*', async (_, next) => {
      log.push('never')
      await next()
    })
    expect(await request(app, 'PING\n')).toBe('PONG\n')
    expect(log).toEqual(['a:before', 'b:before', 'handler', 'b:after', 'a:after'])
  })

  it('Should pass env and support variables, onError, and notFound', async () => {
    const app = new Hono<{ Bindings: { NAME: string }; Variables: { greeting: string } }>()
    app.use(async (c, next) => {
      c.set('greeting', 'Hello')
      await next()
    })
    app.on('TCP', '/HELLO', (c) => c.text(`${c.get('greeting')}, ${c.env.NAME}!`))
    app.on('TCP', '/ERROR', () => {
      throw new Error('Oops')
    })
    app.onError((err, c) => c.text(`ERR ${err.message}`, 500))
    app.notFound((c) => c.text(`Unknown: ${c.req.path}`, 404))

    expect(await request(app, 'HELLO\n', { NAME: 'Hono' })).toBe('Hello, Hono!\n')
    expect(await request(app, 'ERROR\nHELLO\n', { NAME: 'Hono' })).toBe('ERR Oops\nHello, Hono!\n')
    expect(await request(app, 'FOO bar\n')).toBe('Unknown: /FOO/bar\n')
  })

  it('Should support app.route() and basePath()', async () => {
    const sub = new Hono()
    sub.on('TCP', '/GET/:key', (c) => c.text(`config:${c.req.param('key')}`))
    const app = new Hono()
    app.route('/CONFIG', sub)
    const based = new Hono().basePath('/ADMIN')
    based.on('TCP', '/PING', (c) => c.text('ADMIN PONG'))
    app.route('/', based)

    expect(await request(app, 'CONFIG GET maxmemory\n')).toBe('config:maxmemory\n')
    expect(await request(app, 'ADMIN PING\n')).toBe('ADMIN PONG\n')
  })

  it('Should accept the router option', async () => {
    const app = new Hono({ router: new RegExpRouter() })
    app.on('TCP', '/PING', (c) => c.text('PONG'))
    expect(app.router).toBeInstanceOf(TCPRouter)
    expect(await request(app, 'PING\n')).toBe('PONG\n')
  })

  it('Should infer the types of parameters', () => {
    const app = new Hono()
    app.on('TCP', '/SET/:key/:value', (c) => {
      expectTypeOf(c.req.param('key')).toEqualTypeOf<string>()
      expectTypeOf(c.req.param()).toEqualTypeOf<{ key: string; value: string }>()
      return c.text('OK')
    })
  })

  it('Should work with Standard Validator', async () => {
    const app = new Hono()
    const schema = v.object({
      key: v.pipe(v.string(), v.maxLength(5)),
      ttl: v.pipe(v.string(), v.regex(/^\d+$/), v.transform(Number)),
    })
    app.on(
      'TCP',
      '/EXPIRE/:key/:ttl',
      sValidator('param', schema, (result, c) => {
        if (!result.success) {
          return c.text('ERR Invalid arguments', 400)
        }
      }),
      (c) => {
        const { key, ttl } = c.req.valid('param')
        expectTypeOf(key).toEqualTypeOf<string>()
        expectTypeOf(ttl).toEqualTypeOf<number>()
        return c.text(`${key}:${ttl + 1}`)
      }
    )
    expect(await request(app, 'EXPIRE foo 10\n')).toBe('foo:11\n')
    expect(await request(app, 'EXPIRE foo ten\n')).toBe('ERR Invalid arguments\n')
    expect(await request(app, 'EXPIRE toolong 10\n')).toBe('ERR Invalid arguments\n')
  })
})

describe('HTTP and TCP on the same app', () => {
  const app = new Hono()
  const log: string[] = []
  app.use('*', async (c, next) => {
    log.push(c.req.method)
    await next()
  })
  app.get('/', (c) => c.text('Hello HTTP!'))
  app.get('/PING', (c) => c.text('HTTP PONG'))
  app.get('/users/:id', (c) => c.json({ id: c.req.param('id'), q: c.req.query('q') }))
  app.post('/echo', async (c) => c.json(await c.req.json()))
  app.all('/ANY', (c) => c.text(`ANY ${c.req.method}`))
  app.on('TCP', '/PING', (c) => c.text('PONG'))
  app.on('TCP', '/SECRET/:key', (c) => c.text(`secret ${c.req.param('key')}`))
  app.on('TCP', '*', (c) => c.text('TCP fallback'))

  it('Should keep the behavior of HTTP', async () => {
    expect(await (await app.request('/')).text()).toBe('Hello HTTP!')
    expect(await (await app.request('/PING')).text()).toBe('HTTP PONG')
    expect(await (await app.request('/users/a%20b?q=1')).json()).toEqual({ id: 'a b', q: '1' })
    expect(await (await app.request('/users/a%2Fb')).json()).toEqual({ id: 'a/b' })
    const res = await app.request('/echo', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(await res.json()).toEqual({ a: 1 })
    expect((await app.request('/not-found')).status).toBe(404)
    expect((await app.request('/', { method: 'HEAD' })).status).toBe(200)
    expect((await app.request('/SECRET/foo')).status).toBe(404)
  })

  it('Should behave the same as the standard Hono for HTTP', async () => {
    const standard = new StandardHono()
    standard.get('/users/:id', (c) => c.json({ id: c.req.param('id'), q: c.req.query('q') }))
    for (const path of [
      '/users/1',
      '/users/a%20b?q=1',
      '/users/%E3%81%82',
      '/users/1/',
      '/users',
    ]) {
      const [a, b] = await Promise.all([app.request(path), standard.request(path)])
      expect(a.status).toBe(b.status)
      if (a.ok) {
        expect(await a.json()).toEqual(await b.json())
      }
    }
  })

  it('Should handle TCP', async () => {
    expect(await request(app, 'PING\n')).toBe('PONG\n')
    expect(await request(app, 'SECRET foo\n')).toBe('secret foo\n')
    expect(await request(app, 'ANY\n')).toBe('ANY TCP\n')
    expect(await request(app, 'users 1\n')).toBe('TCP fallback\n')
  })

  it('Should share middleware between HTTP and TCP', async () => {
    log.length = 0
    await app.request('/')
    await request(app, 'PING\n')
    expect(log).toEqual(['GET', 'TCP'])
  })

  it('Should not call TCP routes or middleware from an HTTP request with the TCP method', async () => {
    log.length = 0
    for (const path of ['/PING', '/SECRET/foo', '/ANY', '/', '/anything']) {
      const res = await app.request(path, { method: 'TCP' })
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('404 Not Found')
    }
    const res = await app.fetch(new Request('tcp://localhost/SECRET/foo', { method: 'TCP' }))
    expect(res.status).toBe(404)
    expect(log).toEqual([])
  })

  it('Should support strict: false for HTTP', async () => {
    const app = new Hono({ strict: false })
    app.get('/hello', (c) => c.text('Hello'))
    app.on('TCP', '/PING', (c) => c.text('PONG'))
    expect((await app.request('/hello/')).status).toBe(200)
    expect(await request(app, 'PING\n')).toBe('PONG\n')
    expect((await app.request('/PING', { method: 'TCP' })).status).toBe(404)
  })

  it('Should support the getPath option for HTTP', async () => {
    const app = new Hono({
      getPath: (req) => '/' + req.headers.get('host') + new URL(req.url).pathname,
    })
    app.get('/www.example.com/hello', (c) => c.text('Hello'))
    app.on('TCP', '/PING', (c) => c.text('PONG'))
    const res = await app.request('/hello', { headers: { host: 'www.example.com' } })
    expect(await res.text()).toBe('Hello')
    expect(await request(app, 'PING\n')).toBe('PONG\n')
  })
})
