// Import from 'hono' so that the module augmentation below is applied reliably.
import type { ContextRenderer, MiddlewareHandler } from 'hono'

export type WhoisValue = string | Record<string, unknown>

declare module 'hono' {
  interface ContextRenderer {
    (value: WhoisValue): Response
  }
}

const format = (value: WhoisValue): string => {
  if (typeof value === 'string') {
    return value
  }
  const entries = Object.entries(value).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : [value])
      .filter((v) => v !== null && v !== undefined)
      .map((v) => [`${key}:`, String(v)])
  )
  const width = Math.max(0, ...entries.map(([key]) => key.length))
  return entries.map(([key, v]) => `${key.padEnd(width)} ${v}\r\n`).join('')
}

/**
 * Renderer Middleware for WHOIS. `c.render()` takes an object and renders it as `Key: value` lines.
 *
 * @example
 * ```ts
 * app.use('*', whoisRenderer())
 * app.on('TCP', '/:domain', (c) => c.render({ Domain: c.req.param('domain') }))
 * ```
 */
export const whoisRenderer = (): MiddlewareHandler => (c, next) => {
  c.setRenderer(((value: WhoisValue) => c.text(format(value))) as ContextRenderer)
  return next()
}
