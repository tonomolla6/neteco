import { createServer } from 'vite'
import { describe, expect, it } from 'vitest'
import { unitProject } from '../../vitest.node.config'

describe('Vite dependency discovery of Cloudflare Open Graph assets', () => {
  it('loads real font bytes and compiled Wasm modules with the Worker import types', async () => {
    const { OG_RENDER_ASSETS } = await import('../../workers/seo/og-assets')
    for (const font of [OG_RENDER_ASSETS.archivo600, OG_RENDER_ASSETS.inter400]) {
      expect(font).toBeInstanceOf(ArrayBuffer)
      expect(Array.from(new Uint8Array(font).slice(0, 4))).toEqual([0, 1, 0, 0])
      expect(font.byteLength).toBeGreaterThan(1000)
    }
    expect(OG_RENDER_ASSETS.yogaWasm).toBeInstanceOf(WebAssembly.Module)
    expect(OG_RENDER_ASSETS.resvgWasm).toBeInstanceOf(WebAssembly.Module)
  })
  it.each([
    '/workers/seo/og-assets/archivo-600.bin',
    '/workers/seo/og-assets/inter-400.bin',
    '/node_modules/yoga-wasm-web/dist/yoga.wasm',
    '/node_modules/@resvg/resvg-wasm/index_bg.wasm'
  ])('transforms %s as an asset rather than parsing binary bytes as JavaScript', async (path) => {
    const server = await createServer({
      ...unitProject,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true, watch: null },
      optimizeDeps: { noDiscovery: true }
    })
    try {
      const result = await server.transformRequest(path)
      expect(result?.code).toContain('export default')
      expect(result?.code).not.toContain('\u0000')
    } finally {
      await server.close()
    }
  })
})
