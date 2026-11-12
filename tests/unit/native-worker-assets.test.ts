import { expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { buildNativeCanary } from '../support/native-canary-build'

it('bundles real Open Graph fonts and precompiled Wasm as native workerd modules', async () => {
  const bundle = await buildNativeCanary({
    stdin: {
      contents: `import { OG_RENDER_ASSETS as assets } from './workers/seo/og-assets';
        export default { fetch() { return Response.json({
          fonts: [assets.archivo600, assets.inter400].map(font => ({
            arrayBuffer: font instanceof ArrayBuffer, size: font.byteLength,
            signature: [...new Uint8Array(font).slice(0,4)]
          })),
          yoga: assets.yogaWasm instanceof WebAssembly.Module,
          resvg: assets.resvgWasm instanceof WebAssembly.Module
        }); } };`,
      resolveDir: process.cwd(),
      sourcefile: 'native-assets-entry.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent'
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      ...bundle.nativeSource,
      compatibilityDate: '2026-08-15',
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog()
    })
  )
  try {
    const response = await runtime.dispatchFetch('https://native-assets.neteco.test')
    expect(response.status).toBe(200)
    const result = (await response.json()) as {
      fonts: Array<{ arrayBuffer: boolean; size: number; signature: number[] }>
      yoga: boolean
      resvg: boolean
    }
    expect(result.yoga).toBe(true)
    expect(result.resvg).toBe(true)
    expect(result.fonts).toHaveLength(2)
    for (const font of result.fonts) {
      expect(font.arrayBuffer).toBe(true)
      expect(font.size).toBeGreaterThan(1000)
      expect(font.signature).toEqual([0, 1, 0, 0])
    }
  } finally {
    await runtime.dispose()
  }
})
