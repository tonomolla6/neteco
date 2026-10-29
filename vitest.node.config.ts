import { defineConfig, defineProject } from 'vitest/config'
import { resolve } from 'node:path'
import coveragePolicy from './docs/testing/coverage-policy.json' with { type: 'json' }

/** Shared by the full matrix and the fast Node-only entry point. */
export const unitProject = defineProject({
  resolve: {
    alias: {
      '~~': resolve('.'),
      'cloudflare:workers': resolve('tests/support/cloudflare-workers.ts')
    }
  },
  test: {
    name: 'unit',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/support/no-external-network.ts'],
    environment: 'node',
    testTimeout: 10_000
  }
})

export const coverage = {
  provider: 'v8' as const,
  reporter: ['text', 'json-summary', 'html', 'lcov'] as ['text', 'json-summary', 'html', 'lcov'],
  include: coveragePolicy.include,
  exclude: coveragePolicy.exclusions.map((exclusion) => exclusion.pattern),
  thresholds: coveragePolicy.thresholds
}

export default defineConfig({ test: { projects: [unitProject], coverage } })
