import { tcp } from 'tcp-hono/node'
import app from './app.ts'

// Node.js
tcp(app, { port: 3000 }, (info) => {
  console.log(`Listening on tcp://localhost:${info.port}`)
})
