import { defineConfig, defineProject } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'
import { resolve } from 'node:path'
import { unitProject, coverage } from './vitest.node.config'

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': resolve('tests/support/cloudflare-workers.ts')
    }
  },
  test: {
    projects: [
      unitProject,
      await defineVitestProject({
        test: {
          name: 'nuxt',
          // Exercise the actual root runtimeConfig in a small Nuxt app shell.
          // Configuration tests do not need to compile every storefront route.
          environmentOptions: {
            nuxt: {
              overrides: {
                srcDir: resolve('tests/fixtures/runtime-config-app'),
                buildDir: resolve('.nuxt/runtime-config-fixture')
              }
            }
          },
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
          // Nuxt's bootstrap hook may exceed the 10s Vitest default on the
          // shared development host. Behavior tests retain their own timeout.
          hookTimeout: 30_000,
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
    coverage
  }
})
