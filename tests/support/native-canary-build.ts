import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build, type BuildOptions, type Plugin } from 'esbuild'
import type { V4ModuleDefinition } from 'miniflare'

/** Native imports follow the same Data/CompiledWasm contract as Wrangler. */
export async function buildNativeCanary(options: BuildOptions & { write: false }) {
  const root = process.cwd()
  const assets = [
    {
      specifier: 'yoga-wasm-web/dist/yoga.wasm',
      file: 'node_modules/yoga-wasm-web/dist/yoga.wasm',
      name: 'yoga.wasm',
      type: 'CompiledWasm'
    },
    {
      specifier: '@resvg/resvg-wasm/index_bg.wasm',
      file: 'node_modules/@resvg/resvg-wasm/index_bg.wasm',
      name: 'resvg.wasm',
      type: 'CompiledWasm'
    },
    { specifier: '', file: 'workers/seo/og-assets/archivo-600.bin', name: 'archivo-600.bin', type: 'Data' },
    { specifier: '', file: 'workers/seo/og-assets/inter-400.bin', name: 'inter-400.bin', type: 'Data' }
  ] as const
  const used = new Set<(typeof assets)[number]>()
  const plugin: Plugin = {
    name: 'neteco-native-worker-assets',
    setup(builder) {
      builder.onResolve({ filter: /\.(?:wasm|bin)$/ }, (args) => {
        const asset = assets.find(
          (item) =>
            (item.specifier && args.path === item.specifier) ||
            resolve(args.resolveDir, args.path) === resolve(root, item.file)
        )
        if (!asset) return undefined
        used.add(asset)
        return { path: `./__native_assets/${asset.name}`, external: true }
      })
    }
  }
  const result = await build({ ...options, write: false, plugins: [...(options.plugins ?? []), plugin] })
  const modules: V4ModuleDefinition[] = [
    {
      type: 'ESModule',
      path: resolve(root, '__neteco_native_canary.mjs'),
      contents: result.outputFiles[0]!.text
    }
  ]
  for (const asset of used)
    modules.push({
      type: asset.type,
      path: resolve(root, '__native_assets', asset.name),
      contents: await readFile(resolve(root, asset.file))
    })
  return { ...result, nativeSource: { modules, modulesRoot: root } }
}
