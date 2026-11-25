import { connect } from 'node:net'
import type { Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { Hono } from '../../index.ts'
import { decodeAll, listen, sendText } from '../../test-utils.ts'
import { whois, whoisRenderer } from './index.ts'

describe('WHOIS', () => {
  it('Should decode a query', () => {
    expect(decodeAll(whois(), ['honojs/hono\r\n'])).toEqual([['honojs', 'hono']])
    expect(decodeAll(whois(), ['example', '.com\r\n'])).toEqual([['example.com']])
    expect(decodeAll(whois(), ['\r\n'])).toEqual([[]])
  })

  describe('Over a real TCP connection', () => {
    const app = new Hono()
    app.use('*', whoisRenderer())
    app.on('TCP', '/', (c) => c.text('Usage: whois owner/repo'))
    app.on('TCP', '/:owner/:repo', (c) => {
      const { owner, repo } = c.req.param()
      return c.render({
        Repository: `${owner}/${repo}`,
        Stars: 100,
        Description: null,
        Topic: ['a', 'b'],
      })
    })
    app.on('TCP', '/text', (c) => c.render('plain'))

    let server: Server
    let port: number
    beforeAll(async () => {
      ;({ server, port } = await listen(app, { protocol: whois() }))
    })
    afterAll(() => {
      server.close()
    })

    it('Should respond and close the connection', async () => {
      expect(await sendText(port, ['honojs/hono\r\n'])).toBe(
        'Repository: honojs/hono\r\nStars:      100\r\nTopic:      a\r\nTopic:      b\r\n'
      )
    })

    it('Should handle only the first query', async () => {
      expect(await sendText(port, ['\r\nhonojs/hono\r\n'])).toBe('Usage: whois owner/repo\r\n')
      expect(await sendText(port, ['text\r\n'])).toBe('plain\r\n')
      expect(await sendText(port, ['a/b/c\r\n'])).toBe('404 Not Found\r\n')
    })

    it('Should close the connection even if the client keeps it open', async () => {
      const client = connect({ port, host: '127.0.0.1' })
      const closed = new Promise((resolve) => client.on('close', resolve))
      client.resume()
      client.write('text\r\n')
      await closed
    })

    it('Should reject a too long query', async () => {
      expect(await sendText(port, ['a'.repeat(2000)])).toBe('Line too long\r\n')
    })
  })
})
