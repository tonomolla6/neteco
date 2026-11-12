import type { OgImageDependencies } from './og-image-http'
import type { createOgRenderer } from './og-render'

let renderer: Promise<ReturnType<typeof createOgRenderer>> | undefined

// Carga diferida: fuentes y wasm (importables solo en workerd/wrangler) no entran en la evaluación del módulo,
// de modo que los tests de Node que importan el router no necesitan cargadores de .wasm/.bin.
async function loadRenderer() {
  const [{ createOgRenderer }, { OG_RENDER_ASSETS }] = await Promise.all([import('./og-render'), import('./og-assets')])
  return createOgRenderer(OG_RENDER_ASSETS)
}

/**
 * Dependencias de producción de las tarjetas OG. Las lecturas son GET internos sin cabeceras del visitante (ni
 * cookies ni Authorization): la tarjeta se genera siempre con la vista pública anónima del contenido.
 */
export function ogImageRuntime(origin: string, dispatch: (request: Request) => Promise<Response>): OgImageDependencies {
  return {
    fetchInternal: (path) => dispatch(new Request(new URL(path, origin).href, { method: 'GET' })),
    render: async (spec) => (await (renderer ??= loadRenderer())).render(spec),
    cache: typeof caches === 'undefined' ? undefined : (caches as unknown as { default: Cache }).default,
    log: (event, detail) => console.warn(JSON.stringify({ event, ...detail }))
  }
}
