import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** Post-build contracts: requesting this suite without the real artifact fails. */
export default defineConfig({
  resolve: {
    alias: {
      '~~': resolve('.'),
      'cloudflare:workers': resolve('tests/support/cloudflare-workers.ts')
    }
  },
  test: {
    name: 'compiled',
    include: ['tests/compiled/**/*.test.ts'],
    setupFiles: ['tests/support/no-external-network.ts'],
    environment: 'node',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 30_000
  }
})
