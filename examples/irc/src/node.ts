import { tcp } from 'tcp-hono/node'
import { createServer } from './server.ts'

// Node.js
const server = createServer()

tcp(server.app, { ...server.options, port: 6667 }, (info) => {
  console.log(`Listening on irc://localhost:${info.port}`)
})
setInterval(server.tick, 30_000)
