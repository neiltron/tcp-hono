import { DurableObject } from 'cloudflare:workers'

/**
 * The storage of the Redis-compatible server. There is no Redis behind it.
 */
export class Store extends DurableObject {
  get(key: string): string | undefined {
    return this.ctx.storage.kv.get<string>(key)
  }

  set(key: string, value: string): void {
    this.ctx.storage.kv.put(key, value)
  }

  del(key: string): number {
    return this.ctx.storage.kv.delete(key) ? 1 : 0
  }

  exists(key: string): number {
    return this.ctx.storage.kv.get(key) === undefined ? 0 : 1
  }

  /** Returns `undefined` if the value is not an integer. */
  incrBy(key: string, increment: number): number | undefined {
    const value = Number(this.ctx.storage.kv.get<string>(key) ?? '0') + increment
    if (!Number.isSafeInteger(value)) {
      return
    }
    this.ctx.storage.kv.put(key, String(value))
    return value
  }
}
