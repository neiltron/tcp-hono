import type { Result, Router } from 'hono/router'
import { RegExpRouter } from 'hono/router/reg-exp-router'
import { SmartRouter } from 'hono/router/smart-router'
import { TrieRouter } from 'hono/router/trie-router'
import { PATH_BLOCKED } from './get-path.ts'

/**
 * A router for both HTTP and TCP routes.
 *
 * TCP routes are registered as ordinary routes with the `TCP` method, e.g. `/SET/:key/:value`,
 * so the matching is delegated to a Hono router. HTTP and TCP routes live in the same router and
 * the registration order of handlers and middleware is kept.
 * The only thing it adds is rejecting `TCP` method requests that do not come from a socket.
 */
export class TCPRouter<T> implements Router<T> {
  name: string = 'TCPRouter'
  #router: Router<T>

  constructor(init: { router?: Router<T> } = {}) {
    this.#router =
      init.router ?? new SmartRouter({ routers: [new RegExpRouter(), new TrieRouter()] })
  }

  add(method: string, path: string, handler: T) {
    this.#router.add(method, path, handler)
  }

  match(method: string, path: string): Result<T> {
    return path === PATH_BLOCKED ? [[]] : this.#router.match(method, path)
  }
}
