import type { Plugin } from 'rollup'

const STUB_ID = '\0neteco-og-unavailable-in-nitro'
const RUNTIME_LOADER = /[\\/]workers[\\/]seo[\\/]og-image-runtime\.ts$/
const WORKER_ONLY_MODULES = new Set(['./og-render', './og-assets'])

/**
 * The Nitro (SSR) bundle reaches workers/canary.ts through the D1 API bridge, but it only dispatches /api/*.
 * Open Graph cards (/og/*) are answered by the Worker before Nitro, and their fonts (.bin) and satori/resvg
 * wasm can only be loaded by wrangler/workerd. Inside Nitro the lazy renderer import becomes a stub that
 * fails, so the card handler falls back to the static image and Rollup never parses binary assets.
 */
export function nitroOgIsolation(): Plugin {
  return {
    name: 'neteco-nitro-og-isolation',
    resolveId(source, importer) {
      return importer && RUNTIME_LOADER.test(importer) && WORKER_ONLY_MODULES.has(source) ? STUB_ID : null
    },
    load(id) {
      if (id !== STUB_ID) return null
      return [
        "const unavailable = () => { throw new Error('og_render_unavailable_in_nitro') }",
        'export const createOgRenderer = unavailable',
        'export const OG_RENDER_ASSETS = undefined'
      ].join('\n')
    }
  }
}
