/**
 * @module
 * The preset that handles both HTTP and TCP.
 */

import { HonoBase } from 'hono/hono-base'
import type { HonoOptions } from 'hono/hono-base'
import type { BlankEnv, BlankSchema, Env, Schema } from 'hono/types'
import { getPath } from './get-path.ts'
import { TCPRouter } from './router.ts'

export class Hono<
  E extends Env = BlankEnv,
  S extends Schema = BlankSchema,
  BasePath extends string = '/',
> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router = new TCPRouter({ router: options.router })
    // `super()` has resolved `getPath` from the `strict` and `getPath` options. Use it for HTTP.
    ;(this as { getPath: unknown }).getPath = getPath(this.getPath)
  }
}
