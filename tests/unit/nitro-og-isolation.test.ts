import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { rollup, type Plugin } from 'rollup'
import { transform } from 'esbuild'
import { nitroOgIsolation } from '../../scripts/lib/nitro-og-isolation'

/** Minimal TypeScript loader so Rollup sees the same module graph Nitro does. */
const typescript: Plugin = {
  name: 'test-typescript',
  resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return null
    const base = resolve(importer, '..', source)
    return /\.[a-z]+$/.test(source) ? base : `${base}.ts`
  },
  async transform(code, id) {
    if (!id.endsWith('.ts')) return null
    return { code: (await transform(code, { loader: 'ts', format: 'esm' })).code }
  }
}

const runtime = resolve('workers/seo/og-image-runtime.ts')

async function bundle(plugins: Plugin[]) {
  const build = await rollup({
    input: runtime,
    plugins,
    // Bare packages (satori, wasm glue) stay external here; Nitro bundles them.
    external: (id) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0'),
    onwarn: () => {}
  })
  const { output } = await build.generate({ format: 'esm', inlineDynamicImports: true })
  await build.close()
  return output.map((chunk) => ('code' in chunk ? chunk.code : '')).join('\n')
}

describe('Nitro bundle isolation of Open Graph render assets', () => {
  it('reproduces the Rollup failure on Worker-only binary/wasm OG assets without isolation', async () => {
    await expect(bundle([typescript])).rejects.toThrow(/Unexpected character|PARSE_ERROR/)
  })

  it('replaces the OG renderer and assets with a failing stub inside Nitro', async () => {
    const code = await bundle([nitroOgIsolation(), typescript])
    expect(code).not.toMatch(/og-assets|\.wasm|\.bin|satori|resvg/)
    expect(code).toContain('og_render_unavailable_in_nitro')
  })

  it('only intercepts the OG runtime loader, never other modules', () => {
    const plugin = nitroOgIsolation()
    const resolveId = plugin.resolveId as (source: string, importer?: string) => unknown
    expect(resolveId('./og-assets', resolve('workers/seo/other.ts'))).toBeNull()
    expect(resolveId('./og-render', resolve('workers/seo/og-card.ts'))).toBeNull()
    expect(resolveId('./og-assets', runtime)).toEqual(expect.any(String))
    expect(resolveId('./og-render', runtime)).toEqual(expect.any(String))
  })
})

describe('Cloudflare Nuxt profile wiring', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('defineNuxtConfig', (configuration: unknown) => configuration)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('registers the isolation plugin in the Cloudflare Nitro build only', async () => {
    vi.stubEnv('NETECO_RUNTIME', 'cloudflare')
    const cloudflare = (await import('../../nuxt.config')).default as {
      nitro: { rollupConfig?: { plugins?: Array<{ name?: string }> } }
    }
    expect(cloudflare.nitro.rollupConfig?.plugins?.map((plugin) => plugin.name)).toContain('neteco-nitro-og-isolation')
    vi.resetModules()
    vi.stubEnv('NETECO_RUNTIME', 'node')
    const node = (await import('../../nuxt.config')).default as { nitro: { rollupConfig?: unknown } }
    expect(node.nitro.rollupConfig).toBeUndefined()
  })
})
