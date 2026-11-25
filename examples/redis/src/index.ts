import { sValidator } from '@hono/standard-validator'
import { Hono, tcp } from 'tcp-hono'
import { resp, respRenderer } from 'tcp-hono/resp'
import { incrBySchema, setSchema } from './schema.ts'
import type { Env } from './types.ts'

export { Store } from './store.ts'

const app = new Hono<Env>()

app.use('*', respRenderer())

app.on('TCP', '/PING', (c) => {
  return c.render({ simple: 'PONG' })
})

app.on('TCP', '/PING/:message', (c) => {
  return c.render(c.req.param('message'))
})

app.on('TCP', '/ECHO/:message', (c) => {
  return c.render(c.req.param('message'))
})

app.on(
  'TCP',
  '/SET/:key/:value',
  sValidator('param', setSchema, (result, c) => {
    if (!result.success) {
      return c.render({ error: 'ERR Invalid arguments' })
    }
  }),
  async (c) => {
    const { key, value } = c.req.valid('param')

    await c.env.STORE.getByName('default').set(key, value)

    return c.render({ simple: 'OK' })
  }
)

app.on('TCP', '/GET/:key', async (c) => {
  const value = await c.env.STORE.getByName('default').get(c.req.param('key'))

  return c.render(value ?? null)
})

app.on('TCP', '/DEL/:key', async (c) => {
  const count = await c.env.STORE.getByName('default').del(c.req.param('key'))

  return c.render(count)
})

app.on('TCP', '/EXISTS/:key', async (c) => {
  const count = await c.env.STORE.getByName('default').exists(c.req.param('key'))

  return c.render(count)
})

app.on('TCP', '/INCR/:key', async (c) => {
  const value = await c.env.STORE.getByName('default').incrBy(c.req.param('key'), 1)

  return c.render(value ?? { error: 'ERR value is not an integer or out of range' })
})

app.on(
  'TCP',
  '/INCRBY/:key/:increment',
  sValidator('param', incrBySchema, (result, c) => {
    if (!result.success) {
      return c.render({ error: 'ERR value is not an integer or out of range' })
    }
  }),
  async (c) => {
    const { key, increment } = c.req.valid('param')
    const value = await c.env.STORE.getByName('default').incrBy(key, increment)

    return c.render(value ?? { error: 'ERR value is not an integer or out of range' })
  }
)

// Commands that clients such as redis-cli send on connecting
app.on('TCP', '/COMMAND/*', (c) => c.render([]))
app.on('TCP', '/CLIENT/*', (c) => c.render({ simple: 'OK' }))
app.on('TCP', '/HELLO/*', (c) => c.render({ error: 'NOPROTO only RESP2 is supported' }))

app.on('TCP', '/QUIT', (c) => {
  c.header('Connection', 'close')
  return c.render({ simple: 'OK' })
})

export default tcp(app, { protocol: resp() })
