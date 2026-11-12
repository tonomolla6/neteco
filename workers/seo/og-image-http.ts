import { ogStaticFallback, ogVersion, parseOgImagePath, type OgKind } from '../../shared/og-image'
import type { OgCardSpec, OgPhoto } from './og-card'
import { toOgPhoto } from './og-photo'

/** Súbelo cuando cambie el diseño de las tarjetas: invalida ETag y caché de golpe. */
export const OG_DESIGN_VERSION = 'd1'

const IMAGE_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
const FALLBACK_CACHE_CONTROL = 'public, max-age=300, s-maxage=300'
const NOT_FOUND_CACHE_CONTROL = 'public, max-age=60, s-maxage=60'
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'none'; sandbox",
  'cross-origin-resource-policy': 'cross-origin',
  'referrer-policy': 'no-referrer'
}
const MAX_PHOTO_BYTES = 1_500_000
// Solo estas rutas internas pueden servir fotos; nunca una URL que venga de los datos.
const PHOTO_PATH = /^\/(?:media\/[0-9a-f-]{36}\/image|api\/content-media\/[0-9a-f-]{36}\/image)\?w=\d+&format=jpeg$/
const PHOTO_WIDTH = 400

export interface OgImageDependencies {
  /** GET interno al propio Worker, sin cookies ni cabeceras del visitante: siempre contenido público anónimo. */
  fetchInternal(path: string): Promise<Response>
  render(spec: OgCardSpec): Promise<Uint8Array>
  cache?: Pick<Cache, 'match' | 'put'>
  log?: (event: string, detail: Record<string, string | number>) => void
}

interface OgSource {
  /** Todo lo textual que se dibuja más las rutas de foto: de aquí sale el ETag. */
  version: string
  build(photos: OgPhoto[]): OgCardSpec
  photoPaths: string[]
}

type Loaded = { status: 'ok'; source: OgSource } | { status: 'not_found' } | { status: 'unavailable' }
const NOT_FOUND: Loaded = { status: 'not_found' }
const UNAVAILABLE: Loaded = { status: 'unavailable' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max = 600) => (typeof value === 'string' ? value.slice(0, max) : '')

function photoPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null
  const path = value.replace(/\bw=\d+/, `w=${PHOTO_WIDTH}`).replace(/&format=\w+/, '&format=jpeg')
  return PHOTO_PATH.test(path) ? path : null
}

async function getJson(deps: OgImageDependencies, path: string): Promise<{ status: number; body: unknown }> {
  const response = await deps.fetchInternal(path)
  if (!response.ok) {
    await response.body?.cancel()
    return { status: response.status, body: null }
  }
  return { status: response.status, body: await response.json().catch(() => null) }
}

function classify(status: number): Loaded {
  return status === 404 || status === 410 ? NOT_FOUND : UNAVAILABLE
}

async function loadProduct(deps: OgImageDependencies, slug: string): Promise<Loaded> {
  const { status, body } = await getJson(deps, `/api/products/${slug}`)
  if (!isRecord(body)) return classify(status)
  const variants = Array.isArray(body.variants) ? body.variants.filter(isRecord) : []
  const name = text(body.name)
  if (!name || !variants.length) return NOT_FOUND
  // Precio público anónimo (sin sesión): solo importes positivos y enteros; si no, no se muestra precio.
  const prices = variants
    .map((variant) => Number(variant.price))
    .filter((price) => Number.isInteger(price) && price > 0)
  const fromPriceCents = prices.length ? Math.min(...prices) : null
  const brand = text(body.brand, 120) || null
  const reference = variants.length === 1 ? text(variants[0]!.sku, 80) || null : null
  const photo = photoPath(body.image)
  return {
    status: 'ok',
    source: {
      version: ogVersion('producto', name, brand, variants.length, fromPriceCents, reference, photo),
      photoPaths: photo ? [photo] : [],
      build: (photos) => ({
        kind: 'producto',
        title: name,
        brand,
        formats: variants.length,
        fromPriceCents,
        reference,
        photo: photos[0] ?? null
      })
    }
  }
}

async function loadCategory(deps: OgImageDependencies, slug: string): Promise<Loaded> {
  const categories = await getJson(deps, '/api/categories')
  if (!isRecord(categories.body)) return classify(categories.status)
  const flat = Array.isArray(categories.body.flat) ? categories.body.flat.filter(isRecord) : []
  const category = flat.find((entry) => entry.slug === slug)
  if (!category) return NOT_FOUND
  const name = text(category.name, 200)
  if (!name) return NOT_FOUND
  const products = await getJson(deps, `/api/products?category=${encodeURIComponent(slug)}&limit=12&page=1`)
  if (!isRecord(products.body)) return classify(products.status)
  const items = Array.isArray(products.body.items) ? products.body.items.filter(isRecord) : []
  const total = Number.isInteger(products.body.total) ? Number(products.body.total) : items.length
  const photos = items
    .map((item) => photoPath(item.image))
    .filter((path): path is string => path !== null)
    .slice(0, 4)
  return {
    status: 'ok',
    source: {
      version: ogVersion('categoria', name, total, ...photos),
      photoPaths: photos,
      build: (loaded) => ({ kind: 'categoria', title: name, productCount: total, photos: loaded })
    }
  }
}

async function loadTemplate(deps: OgImageDependencies, slug: string): Promise<Loaded> {
  const { status, body } = await getJson(deps, `/api/templates/${slug}`)
  if (!isRecord(body)) return classify(status)
  const title = text(body.title, 200)
  if (!title || body.status !== 'published') return NOT_FOUND
  const subtitle = text(body.description) || null
  return {
    status: 'ok',
    source: {
      version: ogVersion('plantilla', title, subtitle, body.version as number, body.updatedAt as string),
      photoPaths: [],
      build: () => ({ kind: 'plantilla', title, subtitle, photo: null })
    }
  }
}

async function loadContent(deps: OgImageDependencies, slug: string): Promise<Loaded> {
  const { status, body } = await getJson(deps, `/api/content/${slug}`)
  if (!isRecord(body)) return classify(status)
  const title = text(body.title, 200)
  // Solo páginas publicadas: nunca vistas previas ni borradores.
  if (!title || body.preview === true || (body.status !== undefined && body.status !== 'published')) return NOT_FOUND
  const seo = isRecord(body.seo) ? body.seo : {}
  const subtitle = text(seo.description) || null
  const media = isRecord(body.media) ? body.media : {}
  const firstImage = (Array.isArray(body.blocks) ? body.blocks : [])
    .filter(isRecord)
    .find((block) => block.type === 'image' && typeof block.id === 'string' && block.id in media)
  const photo = firstImage ? photoPath(media[firstImage.id as string]) : null
  return {
    status: 'ok',
    source: {
      version: ogVersion('contenido', title, subtitle, body.version as number, photo),
      photoPaths: photo ? [photo] : [],
      build: (photos) => ({ kind: 'contenido', title, subtitle, photo: photos[0] ?? null })
    }
  }
}

const LOADERS: Record<OgKind, (deps: OgImageDependencies, slug: string) => Promise<Loaded>> = {
  producto: loadProduct,
  categoria: loadCategory,
  plantilla: loadTemplate,
  contenido: loadContent
}

async function loadPhoto(deps: OgImageDependencies, path: string): Promise<OgPhoto | null> {
  try {
    const response = await deps.fetchInternal(path)
    if (!response.ok) {
      await response.body?.cancel()
      return null
    }
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_PHOTO_BYTES) {
      await response.body?.cancel()
      return null
    }
    return toOgPhoto(new Uint8Array(await response.arrayBuffer()))
  } catch {
    return null
  }
}

function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false
  if (header.trim() === '*') return true
  return header.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === etag)
}

function imageHeaders(etag: string, length?: number): Headers {
  const headers = new Headers({
    'content-type': 'image/png',
    'cache-control': IMAGE_CACHE_CONTROL,
    etag,
    ...SECURITY_HEADERS
  })
  if (length !== undefined) headers.set('content-length', String(length))
  return headers
}

function fallback(request: Request, kind: OgKind, slug: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: new URL(ogStaticFallback(kind, slug), request.url).href,
      'cache-control': FALLBACK_CACHE_CONTROL,
      'x-og-fallback': 'static',
      ...SECURITY_HEADERS
    }
  })
}

/**
 * GET /og/<tipo>/<slug>.png: tarjeta Open Graph generada al vuelo. Solo contenido público y anónimo (los datos salen
 * de las mismas rutas públicas que las páginas, sin cookies), caché por ETag de contenido y, ante cualquier fallo,
 * redirección a la tarjeta estática equivalente. Devuelve null si la ruta no es de este módulo.
 */
export async function handleOgImageHttp(request: Request, deps: OgImageDependencies): Promise<Response | null> {
  const route = parseOgImagePath(new URL(request.url).pathname)
  if (!route) return null
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, {
      status: 405,
      headers: { allow: 'GET, HEAD', 'cache-control': 'no-store', ...SECURITY_HEADERS }
    })
  }
  const head = request.method === 'HEAD'
  try {
    const loaded = await LOADERS[route.kind](deps, route.slug)
    if (loaded.status === 'not_found') {
      return new Response(head ? null : JSON.stringify({ error: { code: 'not_found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json', 'cache-control': NOT_FOUND_CACHE_CONTROL, ...SECURITY_HEADERS }
      })
    }
    if (loaded.status === 'unavailable') {
      deps.log?.('og.unavailable', { kind: route.kind })
      return fallback(request, route.kind, route.slug)
    }
    const { source } = loaded
    const etag = `"${OG_DESIGN_VERSION}-${source.version}"`
    if (matchesEtag(request.headers.get('if-none-match'), etag)) {
      const headers = imageHeaders(etag)
      headers.delete('content-type')
      return new Response(null, { status: 304, headers })
    }
    const cacheKey = new Request(
      new URL(`/__og-cache/${route.kind}/${route.slug}/${OG_DESIGN_VERSION}-${source.version}`, request.url).href
    )
    const cached = await deps.cache?.match(cacheKey).catch(() => undefined)
    if (cached) {
      const bytes = await cached.arrayBuffer()
      return new Response(head ? null : bytes, { status: 200, headers: imageHeaders(etag, bytes.byteLength) })
    }
    const photos = (await Promise.all(source.photoPaths.map((path) => loadPhoto(deps, path)))).filter(
      (photo): photo is OgPhoto => photo !== null
    )
    const png = await deps.render(source.build(photos))
    const body = png.slice().buffer as ArrayBuffer
    if (deps.cache) {
      // Un fallo de caché nunca rompe la respuesta; solo cuesta volver a dibujar.
      await deps.cache
        .put(
          cacheKey,
          new Response(body.slice(0), {
            headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' }
          })
        )
        .catch(() => undefined)
    }
    return new Response(head ? null : body, { status: 200, headers: imageHeaders(etag, body.byteLength) })
  } catch (error) {
    deps.log?.('og.render_failed', {
      kind: route.kind,
      error: error instanceof Error ? error.message.slice(0, 120) : 'unknown'
    })
    return fallback(request, route.kind, route.slug)
  }
}
