import { defineConfig } from 'tsup'

export default defineConfig([
  {
    // Library: dual package (ESM + CJS + types)
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    target: 'node18',
    platform: 'node',
    clean: false,
    sourcemap: false,
    splitting: false,
  },
  {
    // CLI: CommonJS so it can `require()` the user's config and register tsx
    entry: { cli: 'src/cli.ts' },
    format: ['cjs'],
    target: 'node18',
    platform: 'node',
    clean: false,
    external: ['tsx', 'tsx/cjs'],
  },
])
