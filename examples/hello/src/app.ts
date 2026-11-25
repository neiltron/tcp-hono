import { Hono } from 'tcp-hono'

const app = new Hono()

app.get('/', (c) => c.text('Hello HTTP!'))

app.on('TCP', '/PING', (c) => {
  return c.text('PONG')
})

app.on('TCP', '/HELLO/:name', (c) => {
  return c.text(`Hello, ${c.req.param('name')}!`)
})

app.on('TCP', '/QUIT', (c) => {
  return c.text('Bye!', 200, { Connection: 'close' })
})

export default app
