import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const nuxtProject = vi.hoisted(() => vi.fn((options) => options))
vi.mock('@nuxt/test-utils/config', () => ({ defineVitestProject: nuxtProject }))

describe('Node-only Vitest entry point', () => {
  it('discovers exactly the same unit files without loading any Nuxt dependency', async () => {
    const nodeConfig = (await import('../../vitest.node.config')).default
    expect(nuxtProject).not.toHaveBeenCalled()
    const rootConfig = (await import('../../vitest.config')).default
    expect(rootConfig.test?.projects?.[0]).toBe(nodeConfig.test?.projects?.[0])
    expect(rootConfig.test?.coverage).toBe(nodeConfig.test?.coverage)
    const projects = rootConfig.test?.projects as Array<{ test: { name: string; setupFiles: string[] } }>
    expect(projects.map((project) => project.test.name)).toEqual(['unit', 'nuxt', 'component', 'integration'])
    expect(projects.every((project) => project.test.setupFiles.includes('tests/support/no-external-network.ts'))).toBe(
      true
    )

    // Real CLI discovery, with Node rejecting Nuxt dependency loading. This
    // must stay possible even when the Nuxt runtime cannot be bootstrapped.
    const hook = `import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        if (result.url.includes('/node_modules/@nuxt/') || result.url.includes('/node_modules/nuxt/'))
          throw new Error('Nuxt dependency loaded during Node-only tests');
        return result;
      }});`
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent(hook)}`,
        resolve('node_modules/vitest/vitest.mjs'),
        'list',
        '--config',
        'vitest.node.config.ts',
        '--project',
        'unit',
        '--filesOnly',
        '--json'
      ],
      { encoding: 'utf8', timeout: 8_000 }
    )
    const discovered = JSON.parse(output) as Array<{ file: string }>
    const expected = readdirSync(resolve('tests/unit'), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.test.ts'))
      .map((file) => resolve('tests/unit', file))
      .sort()
    expect(discovered.map((entry) => entry.file).sort()).toEqual(expected)
  })

  it('keeps the effective network guard fail-closed for external URLs', () => {
    expect(() => fetch('https://network-forbidden.example.invalid')).toThrow('External network access is forbidden')
  })
})
