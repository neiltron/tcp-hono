import { defineConfig, triggers } from 'cf/config'
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' }

export default defineConfig({
  worker: {
    name: 'tcp-hono-github-whois',
    compatibilityDate: '2026-11-17',
    entrypoint,
    triggers: [triggers.connect({ protocol: 'tcp', port: 8043 })],
  },
})
