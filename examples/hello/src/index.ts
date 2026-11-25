import { tcp } from 'tcp-hono'
import app from './app.ts'

// Cloudflare Workers: HTTP and TCP on the same app
export default {
  fetch: app.fetch,
  connect: tcp.socket(app),
}
