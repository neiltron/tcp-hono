import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    entry: {
      index: 'src/index.ts',
      'protocols/resp/index': 'src/protocols/resp/index.ts',
      'protocols/whois/index': 'src/protocols/whois/index.ts',
      'adapter/node/index': 'src/adapter/node/index.ts',
    },
    format: 'esm',
    dts: true,
    fixedExtension: false,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
  fmt: {
    printWidth: 100,
    semi: false,
    singleQuote: true,
    trailingComma: 'es5',
    ignorePatterns: ['dist', '**/.cloudflare'],
  },
  lint: {
    ignorePatterns: ['dist', 'examples'],
    options: { typeAware: true, typeCheck: true },
  },
})
