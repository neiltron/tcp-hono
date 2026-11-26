import { bindings, defineConfig, exports, triggers } from 'cf/config'
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' }

const name = 'tcp-hono-irc'

export default defineConfig({
  worker: {
    name,
    compatibilityDate: '2026-11-17',
    entrypoint,
    triggers: [triggers.connect({ protocol: 'tcp', port: 6667 })],
    exports: {
      Network: exports.durableObject({ storage: 'sqlite' }),
    },
    env: {
      NETWORK: bindings.durableObject({ worker: name, exportName: 'Network' }),
    },
  },
})
