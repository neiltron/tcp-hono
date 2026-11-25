import { defineConfig, triggers } from 'cf/config'
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' }

export default defineConfig({
  worker: {
    name: 'tcp-hono-hello',
    compatibilityDate: '2026-11-17',
    entrypoint,
    // HTTP is served by the dev server, and TCP on 3000.
    triggers: [triggers.connect({ protocol: 'tcp', port: 3000 })],
  },
})
