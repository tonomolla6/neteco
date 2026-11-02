import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { compileScript, parse } from '@vue/compiler-sfc'
import { expect, it, vi } from 'vitest'
import type { Component } from 'vue'

it('renders confirmed editorial content and author in initial SSR HTML from the actual component source', async () => {
  // Compile the production SFCs for SSR, not Nuxt's happy-dom/client transform.
  // Both the compiled component and renderer load the same Node Vue instance.
  const root = process.cwd()
  const bundled = await build({
    entryPoints: [resolve(root, 'app/components/ResourceHubPanel.vue')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vue', 'vue/server-renderer', '@vue/server-renderer'],
    alias: { '~~': root },
    plugins: [
      {
        name: 'actual-resource-sfc-ssr',
        setup(builder) {
          builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
            let source = await readFile(path, 'utf8')
            if (path === resolve(root, 'app/components/ResourceHubPanel.vue')) {
              // Only the Nuxt Vue autoimports are supplied by this standalone harness.
              source = source.replace(
                '<script setup lang="ts">',
                '<script setup lang="ts">\nimport { computed, ref, shallowRef, watch, onBeforeUnmount } from "vue"'
              )
            }
            const parsed = parse(source, { filename: path })
            expect(parsed.errors).toEqual([])
            const compiled = compileScript(parsed.descriptor, {
              id: path,
              inlineTemplate: true,
              templateOptions: { ssr: true }
            })
            return { contents: compiled.content, loader: 'ts', resolveDir: resolve(path, '..') }
          })
        }
      }
    ]
  })
  const request = vi.fn(async (path: string) => {
    expect(path).toBe('/api/resources/guia-profesional')
    await Promise.resolve()
    return {
      source: 'cloudflare',
      slug: 'guia-profesional',
      title: 'Guía profesional',
      description: 'Guía sintética de limpieza profesional.',
      version: 1,
      preview: false,
      publishedAt: '2026-10-09T01:00:00Z',
      canonicalPath: '/recursos/guia-profesional',
      noindex: false,
      editorial: {
        kind: 'article',
        category: { slug: 'limpieza', label: 'Limpieza' },
        author: { name: 'Autora sintética', experience: 'Experiencia profesional sintética para pruebas.' },
        reviewedAt: '2026-10-09T00:00:00Z',
        reviewDueAt: '2027-10-09T00:00:00Z',
        pillarSlug: null,
        relatedProducts: [],
        relatedCategories: [],
        relatedResources: []
      },
      blocks: [
        { id: '10000000-0000-4000-8000-000000000001', type: 'paragraph', text: 'Contenido revisado sintético.' }
      ],
      media: {},
      relatedProducts: [],
      relatedCategories: [],
      relatedResources: []
    }
  })
  const require = createRequire(import.meta.url)
  const vue: typeof import('vue') = require('vue')
  const renderer: typeof import('@vue/server-renderer') = require('@vue/server-renderer')
  const module = { exports: {} as { default: Component } }
  const code = bundled.outputFiles[0]!.text
  // Nuxt supplies these composables; the initial SSR request has an empty query.
  const route = { query: {}, fullPath: '/recursos' },
    router = { resolve: () => ({ fullPath: '/recursos' }), replace: vi.fn(), push: vi.fn() }
  new Function('require', 'module', 'useRequestFetch', 'useRoute', 'useRouter', code)(
    require,
    module,
    () => request,
    () => route,
    () => router
  )
  const app = vue.createSSRApp(module.exports.default, { enabled: true, slug: 'guia-profesional' })
  const html = await renderer.renderToString(app)
  expect(request).toHaveBeenCalledTimes(1)
  expect(html).toContain('Contenido revisado sintético.')
  expect(html).toContain('Autora sintética')
  expect(html).not.toContain('Confirmando contenido publicado')
})
