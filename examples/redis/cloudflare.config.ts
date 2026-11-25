import { bindings, defineConfig, exports, triggers } from 'cf/config'
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' }

const name = 'tcp-hono-redis'

export default defineConfig({
  worker: {
    name,
    compatibilityDate: '2026-11-17',
    entrypoint,
    // This is a demo without authentication. Use it locally or restrict the source addresses.
    // 6380 is used so that it does not conflict with a real Redis.
    triggers: [triggers.connect({ protocol: 'tcp', port: 6380 })],
    exports: {
      Store: exports.durableObject({ storage: 'sqlite' }),
    },
    env: {
      STORE: bindings.durableObject({ worker: name, exportName: 'Store' }),
    },
  },
})
