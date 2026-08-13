import { defineConfig, defineProject } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'
import coveragePolicy from './docs/testing/coverage-policy.json' with { type: 'json' }

export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          setupFiles: ['tests/support/no-external-network.ts'],
          environment: 'node',
          testTimeout: 10_000
        }
      }),
      await defineVitestProject({
        test: {
          name: 'nuxt',
          include: ['tests/nuxt/**/*.test.ts'],
          setupFiles: ['tests/support/no-external-network.ts'],
          environment: 'nuxt',
          testTimeout: 20_000
        }
      }),
      await defineVitestProject({
        test: {
          name: 'component',
          include: ['tests/components/**/*.test.ts'],
          setupFiles: ['tests/support/no-external-network.ts'],
          environment: 'nuxt',
          testTimeout: 20_000
        }
      }),
      defineProject({
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          setupFiles: ['tests/support/no-external-network.ts'],
          globalSetup: ['tests/support/integration-global-setup.ts'],
          environment: 'node',
          hookTimeout: 30_000,
          testTimeout: 30_000,
          sequence: { concurrent: false }
        }
      })
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      include: coveragePolicy.include,
      exclude: coveragePolicy.exclusions.map((exclusion) => exclusion.pattern),
      thresholds: coveragePolicy.thresholds
    }
  }
})
