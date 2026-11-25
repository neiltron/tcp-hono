import { Hono, tcp } from 'tcp-hono'
import { whois, whoisRenderer } from 'tcp-hono/whois'

type Repository = {
  full_name: string
  description: string | null
  language: string | null
  stargazers_count: number
  forks_count: number
  license: { spdx_id: string } | null
  html_url: string
  created_at: string
  pushed_at: string
}

const app = new Hono()

app.use('*', whoisRenderer())

app.on('TCP', '/:owner/:repo', async (c) => {
  const { owner, repo } = c.req.param()

  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      headers: {
        'User-Agent': 'tcp-hono',
      },
    }
  )

  if (!res.ok) {
    return c.text(res.status === 404 ? 'Not found' : `GitHub API error: ${res.status}`)
  }

  const data = await res.json<Repository>()

  return c.render({
    Repository: data.full_name,
    Description: data.description,
    Language: data.language,
    Stars: data.stargazers_count,
    Forks: data.forks_count,
    License: data.license?.spdx_id,
    URL: data.html_url,
    Created: data.created_at,
    Pushed: data.pushed_at,
  })
})

app.notFound((c) => c.text('Usage: whois -h <host> -p <port> <owner>/<repo>'))

export default tcp(app, { protocol: whois() })
