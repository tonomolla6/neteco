import type { Plugin } from 'vite'

/** Match Cloudflare's Data/CompiledWasm imports in the Node test runtime and
 * in Vitest's dependency walker (including Stryker's related-test discovery).
 */
export function workerAssetsPlugin(): Plugin {
  const dataPattern = /(?:^|\/)og-assets\/(?:archivo-600|inter-400)\.bin$/
  const wasmPattern = /(?:^|\/)(?:yoga-wasm-web\/dist\/yoga|@resvg\/resvg-wasm\/index_bg)\.wasm$/
  return {
    name: 'neteco-test-worker-assets',
    enforce: 'pre',
    load(id) {
      const wasm = wasmPattern.test(id)
      if (!dataPattern.test(id) && !wasm) return null
      return `import { readFileSync } from 'node:fs';
        const bytes = readFileSync(${JSON.stringify(id)});
        export default ${wasm ? 'new WebAssembly.Module(bytes)' : 'bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)'};`
    }
  }
}
