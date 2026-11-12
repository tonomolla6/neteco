import { beforeAll, describe, expect, it, vi } from 'vitest'
import { OG_DESIGN_VERSION, handleOgImageHttp, type OgImageDependencies } from '../../workers/seo/og-image-http'
import type { OgCardSpec } from '../../workers/seo/og-card'
import { createOgRenderer } from '../../workers/seo/og-render'
import { PNG_SIGNATURE, loadOgRenderAssets, pngSize, syntheticPhoto } from '../support/og-render-assets'
import sharp from 'sharp'

const ORIGIN = 'https://neteco.example'
const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const UUID = '0b1f5c0e-6a1c-4f5a-9d47-2a9a0f3f1c11'
const PHOTO = `/media/${UUID}/image?w=800&format=jpeg`
const PHOTO_400 = `/media/${UUID}/image?w=400&format=jpeg`

const productBody = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'Guante de nitrilo azul',
  slug: 'guante-nitrilo',
  brand: 'NETECO',
  image: PHOTO,
  variants: [
    { sku: 'GN-100', price: 1250, priceTiers: [{ min: 10, price: 900 }], compareAtPrice: 2000 },
    { sku: 'GN-200', price: 2100 }
  ],
  ...overrides
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fakeCache() {
  const store = new Map<string, Response>()
  return {
    store,
    match: vi.fn(async (request: Request | string) =>
      store.get(typeof request === 'string' ? request : request.url)?.clone()
    ),
    put: vi.fn(async (request: Request | string, response: Response) => {
      store.set(typeof request === 'string' ? request : request.url, response.clone())
    })
  }
}

function setup(
  routes: Record<string, () => Response | Promise<Response>>,
  overrides: Partial<OgImageDependencies> = {}
) {
  const calls: string[] = []
  const render = vi.fn(async (_spec: OgCardSpec) => PNG_STUB)
  const deps: OgImageDependencies = {
    fetchInternal: async (...args: [string]) => {
      expect(args).toHaveLength(1)
      calls.push(args[0])
      const route = routes[args[0]]
      return route ? route() : new Response('nope', { status: 404 })
    },
    render,
    ...overrides
  }
  return { deps, calls, render }
}
const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`${ORIGIN}${path}`, { method, headers })

describe('GET /og/producto/:slug.png', () => {
  it('renders a public product card with strong cache headers and an ETag', async () => {
    const { deps, render, calls } = setup({
      '/api/products/guante-nitrilo': () => json(productBody()),
      [PHOTO_400]: async () =>
        new Response(
          Buffer.from(
            await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } })
              .jpeg()
              .toBuffer()
          ),
          { headers: { 'content-type': 'image/jpeg' } }
        )
    })
    const response = await handleOgImageHttp(get('/og/producto/guante-nitrilo.png'), deps)
    expect(response!.status).toBe(200)
    expect(response!.headers.get('content-type')).toBe('image/png')
    expect(response!.headers.get('cache-control')).toMatch(
      /^public, max-age=\d+, s-maxage=\d+, stale-while-revalidate=\d+$/
    )
    expect(response!.headers.get('etag')).toMatch(new RegExp(`^"${OG_DESIGN_VERSION}-[a-z0-9]+"$`))
    expect(response!.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response!.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(response!.headers.get('set-cookie')).toBeNull()
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(PNG_STUB)
    expect(calls).toEqual(['/api/products/guante-nitrilo', PHOTO_400])
    const spec = render.mock.calls[0]![0]
    expect(spec).toMatchObject({
      kind: 'producto',
      title: 'Guante de nitrilo azul',
      brand: 'NETECO',
      formats: 2,
      fromPriceCents: 1250,
      reference: null
    })
    expect(spec.kind === 'producto' && spec.photo).toMatchObject({ width: 40, height: 40 })
  })

  it('uses only the public minimum price and never tiers, compare-at or B2B data', async () => {
    const { deps, render } = setup({ '/api/products/guante-nitrilo': () => json(productBody({ image: null })) })
    await handleOgImageHttp(get('/og/producto/guante-nitrilo.png'), deps)
    const spec = render.mock.calls[0]![0]
    expect(JSON.stringify(spec)).not.toMatch(/900|2000|priceTiers|compareAt/)
  })

  it('shows no price when no public price exists, and the reference only for single-variant products', async () => {
    const { deps, render } = setup({
      '/api/products/a': () => json(productBody({ image: null, variants: [{ sku: 'REF-1', price: 0 }] })),
      '/api/products/b': () =>
        json(productBody({ image: null, variants: [{ sku: 'REF-1', price: null }, { sku: 'R2' }] }))
    })
    await handleOgImageHttp(get('/og/producto/a.png'), deps)
    await handleOgImageHttp(get('/og/producto/b.png'), deps)
    expect(render.mock.calls[0]![0]).toMatchObject({ fromPriceCents: null, reference: 'REF-1', formats: 1 })
    expect(render.mock.calls[1]![0]).toMatchObject({ fromPriceCents: null, reference: null, formats: 2 })
  })

  it('never forwards visitor credentials: internal requests are plain paths and cookies cannot change the output', async () => {
    const { deps, calls } = setup({ '/api/products/guante-nitrilo': () => json(productBody({ image: null })) })
    const anonymous = await handleOgImageHttp(get('/og/producto/guante-nitrilo.png'), deps)
    const withSession = await handleOgImageHttp(
      get('/og/producto/guante-nitrilo.png', { cookie: 'neteco-session=secret', authorization: 'Bearer secret' }),
      deps
    )
    expect(anonymous!.headers.get('etag')).toBe(withSession!.headers.get('etag'))
    expect(withSession!.headers.get('vary')).toBeNull()
    expect(calls.every((path) => path.startsWith('/api/') || path.startsWith('/media/'))).toBe(true)
  })

  it('returns 404 for unpublished or unknown products, without rendering and without leaking details', async () => {
    const { deps, render } = setup({})
    const response = await handleOgImageHttp(get('/og/producto/borrador.png'), deps)
    expect(response!.status).toBe(404)
    expect(await response!.json()).toEqual({ error: { code: 'not_found' } })
    expect(response!.headers.get('cache-control')).toMatch(/max-age=60/)
    expect(render).not.toHaveBeenCalled()
  })

  it('ignores photo URLs that are not the governed media routes', async () => {
    const { deps, calls } = setup({
      '/api/products/x': () => json(productBody({ image: 'https://evil.example/a.jpg' })),
      '/api/products/y': () => json(productBody({ image: '/api/admin/secret?w=800&format=jpeg' })),
      '/api/products/z': () => json(productBody({ image: '/img/products/x.jpg' }))
    })
    for (const slug of ['x', 'y', 'z']) await handleOgImageHttp(get(`/og/producto/${slug}.png`), deps)
    expect(calls.filter((path) => !path.startsWith('/api/products/'))).toEqual([])
  })

  it('renders without a photo when the media route refuses it', async () => {
    const { deps, render } = setup({
      '/api/products/guante-nitrilo': () => json(productBody()),
      [PHOTO_400]: () => new Response('forbidden', { status: 403 })
    })
    const response = await handleOgImageHttp(get('/og/producto/guante-nitrilo.png'), deps)
    expect(response!.status).toBe(200)
    expect(render.mock.calls[0]![0]).toMatchObject({ photo: null })
  })
})

describe('caching and invalidation', () => {
  const routes = (name = 'Guante') => ({ '/api/products/g': () => json(productBody({ name, image: null })) })

  it('answers 304 to a matching If-None-Match without rendering', async () => {
    const { deps, render } = setup(routes())
    const first = await handleOgImageHttp(get('/og/producto/g.png'), deps)
    const etag = first!.headers.get('etag')!
    render.mockClear()
    for (const header of [etag, `W/${etag}`, `"zzz", ${etag}`, '*']) {
      const response = await handleOgImageHttp(get('/og/producto/g.png', { 'if-none-match': header }), deps)
      expect(response!.status).toBe(304)
      expect(response!.headers.get('etag')).toBe(etag)
      expect(response!.headers.get('cache-control')).toContain('public')
      expect(await response!.text()).toBe('')
    }
    expect(render).not.toHaveBeenCalled()
    const stale = await handleOgImageHttp(get('/og/producto/g.png', { 'if-none-match': '"old"' }), deps)
    expect(stale!.status).toBe(200)
  })

  it('does not re-render when the cache has the card, and re-renders when the content version changes', async () => {
    const cache = fakeCache()
    const a = setup(routes('Guante'), { cache })
    const first = await handleOgImageHttp(get('/og/producto/g.png'), a.deps)
    expect(a.render).toHaveBeenCalledTimes(1)
    const second = await handleOgImageHttp(get('/og/producto/g.png'), a.deps)
    expect(a.render).toHaveBeenCalledTimes(1)
    expect(second!.headers.get('etag')).toBe(first!.headers.get('etag'))
    expect(new Uint8Array(await second!.arrayBuffer())).toEqual(PNG_STUB)
    const changed = setup(routes('Guante renombrado'), { cache })
    const third = await handleOgImageHttp(get('/og/producto/g.png'), changed.deps)
    expect(changed.render).toHaveBeenCalledTimes(1)
    expect(third!.headers.get('etag')).not.toBe(first!.headers.get('etag'))
  })

  it('changes the ETag when the public price changes', async () => {
    const price = (cents: number) => ({
      '/api/products/g': () => json(productBody({ image: null, variants: [{ sku: 'A', price: cents }] }))
    })
    const one = await handleOgImageHttp(get('/og/producto/g.png'), setup(price(1000)).deps)
    const two = await handleOgImageHttp(get('/og/producto/g.png'), setup(price(1100)).deps)
    expect(one!.headers.get('etag')).not.toBe(two!.headers.get('etag'))
  })

  it('survives a failing cache', async () => {
    const cache = {
      match: vi.fn(async () => {
        throw new Error('cache down')
      }),
      put: vi.fn(async () => {
        throw new Error('cache down')
      })
    }
    const response = await handleOgImageHttp(get('/og/producto/g.png'), setup(routes(), { cache }).deps)
    expect(response!.status).toBe(200)
  })

  it('serves HEAD with the same headers and no body', async () => {
    const response = await handleOgImageHttp(get('/og/producto/g.png', {}, 'HEAD'), setup(routes()).deps)
    expect(response!.status).toBe(200)
    expect(response!.headers.get('content-type')).toBe('image/png')
    expect(await response!.text()).toBe('')
  })
})

describe('fallback to the static card', () => {
  it('redirects to the equivalent static card when rendering fails', async () => {
    const log = vi.fn()
    const { deps } = setup(
      { '/api/products/g': () => json(productBody({ image: null })) },
      {
        render: async () => {
          throw new Error('wasm exploded')
        },
        log
      }
    )
    const response = await handleOgImageHttp(get('/og/producto/g.png'), deps)
    expect(response!.status).toBe(302)
    expect(response!.headers.get('location')).toBe(`${ORIGIN}/og/og-producto.jpg`)
    expect(response!.headers.get('cache-control')).toMatch(/max-age=300/)
    expect(response!.headers.get('x-og-fallback')).toBe('static')
    expect(log).toHaveBeenCalledWith('og.render_failed', expect.objectContaining({ kind: 'producto' }))
  })

  it.each([
    ['categoria', 'productos-quimicos', '/og/og-categoria-productos-quimicos.jpg'],
    ['categoria', 'otra', '/og-default.jpg'],
    ['plantilla', 'checklist', '/og/og-plantillas.jpg'],
    ['contenido', 'guia', '/og-default.jpg']
  ])('maps %s/%s to %s when the data source is down', async (kind, slug, target) => {
    const { deps } = setup({}, { fetchInternal: async () => new Response('boom', { status: 503 }) })
    const response = await handleOgImageHttp(get(`/og/${kind}/${slug}.png`), deps)
    expect(response!.status).toBe(302)
    expect(response!.headers.get('location')).toBe(`${ORIGIN}${target}`)
  })

  it('falls back when the data fetch throws or returns garbage', async () => {
    const thrower = setup(
      {},
      {
        fetchInternal: async () => {
          throw new Error('network')
        }
      }
    )
    expect((await handleOgImageHttp(get('/og/producto/g.png'), thrower.deps))!.status).toBe(302)
    const garbage = setup({ '/api/products/g': () => new Response('not json', { status: 200 }) })
    expect((await handleOgImageHttp(get('/og/producto/g.png'), garbage.deps))!.status).toBe(302)
  })
})

describe('routing', () => {
  it('ignores paths it does not own and rejects write methods', async () => {
    const { deps } = setup({})
    expect(await handleOgImageHttp(get('/og/og-producto.jpg'), deps)).toBeNull()
    expect(await handleOgImageHttp(get('/api/products'), deps)).toBeNull()
    const post = await handleOgImageHttp(get('/og/producto/g.png', {}, 'POST'), deps)
    expect(post!.status).toBe(405)
    expect(post!.headers.get('allow')).toBe('GET, HEAD')
  })
})

describe('category, template and content cards', () => {
  const categories = { flat: [{ id: 1, name: 'Productos químicos', slug: 'productos-quimicos', count: 57 }] }
  const item = (n: number) => ({ image: `/media/${UUID}/image?w=800&format=jpeg`, name: `p${n}` })

  it('builds a category card from the published tree and up to 4 product photos', async () => {
    const { deps, render } = setup({
      '/api/categories': () => json(categories),
      '/api/products?category=productos-quimicos&limit=12&page=1': () =>
        json({ items: [item(1), item(2), { image: null }, item(3), item(4), item(5)], total: 57 }),
      [PHOTO_400]: async () =>
        new Response(
          Buffer.from(
            await sharp({ create: { width: 30, height: 60, channels: 3, background: '#fff' } })
              .jpeg()
              .toBuffer()
          )
        )
    })
    const response = await handleOgImageHttp(get('/og/categoria/productos-quimicos.png'), deps)
    expect(response!.status).toBe(200)
    const spec = render.mock.calls[0]![0]
    expect(spec).toMatchObject({ kind: 'categoria', title: 'Productos químicos', productCount: 57 })
    expect(spec.kind === 'categoria' && spec.photos).toHaveLength(4)
  })

  it('supports categories with 0 to 2 products', async () => {
    const { deps, render } = setup({
      '/api/categories': () =>
        json({
          flat: [
            { name: 'Vacía', slug: 'vacia' },
            { name: 'Dos', slug: 'dos' }
          ]
        }),
      '/api/products?category=vacia&limit=12&page=1': () => json({ items: [], total: 0 }),
      '/api/products?category=dos&limit=12&page=1': () => json({ items: [{ image: null }, { image: null }], total: 2 })
    })
    expect((await handleOgImageHttp(get('/og/categoria/vacia.png'), deps))!.status).toBe(200)
    expect((await handleOgImageHttp(get('/og/categoria/dos.png'), deps))!.status).toBe(200)
    expect(render.mock.calls[0]![0]).toMatchObject({ productCount: 0, photos: [] })
    expect(render.mock.calls[1]![0]).toMatchObject({ productCount: 2, photos: [] })
  })

  it('returns 404 for categories that are not in the published tree', async () => {
    const { deps } = setup({ '/api/categories': () => json(categories) })
    expect((await handleOgImageHttp(get('/og/categoria/oculta.png'), deps))!.status).toBe(404)
  })

  it('builds a template card only for published templates', async () => {
    const { deps, render } = setup({
      '/api/templates/checklist': () =>
        json({
          title: 'Checklist APPCC',
          description: 'Plantilla para hostelería',
          status: 'published',
          version: 2,
          updatedAt: '2026-01-01T00:00:00Z'
        }),
      '/api/templates/borrador': () =>
        json({ title: 'Borrador', description: 'x', status: 'draft', version: 1, updatedAt: '2026-01-01T00:00:00Z' })
    })
    expect((await handleOgImageHttp(get('/og/plantilla/checklist.png'), deps))!.status).toBe(200)
    expect(render.mock.calls[0]![0]).toMatchObject({
      kind: 'plantilla',
      title: 'Checklist APPCC',
      subtitle: 'Plantilla para hostelería'
    })
    expect((await handleOgImageHttp(get('/og/plantilla/borrador.png'), deps))!.status).toBe(404)
  })

  it('builds a content card from the first published image and refuses previews', async () => {
    const mediaId = '5d3f0b1e-0a5c-4d7e-8a1b-3c2d1e0f9a8b'
    const body = {
      title: 'Guía de dosificación',
      slug: 'guia',
      status: 'published',
      preview: false,
      version: 3,
      seo: { title: 'Guía', description: 'Cómo dosificar', noindex: false },
      blocks: [
        { type: 'text', id: 'a' },
        { type: 'image', id: mediaId }
      ],
      media: { [mediaId]: `/api/content-media/${mediaId}/image?w=800&format=jpeg` }
    }
    const { deps, render, calls } = setup({
      '/api/content/guia': () => json(body),
      '/api/content/previa': () => json({ ...body, status: 'preview', preview: true }),
      [`/api/content-media/${mediaId}/image?w=400&format=jpeg`]: async () =>
        new Response(
          Buffer.from(
            await sharp({ create: { width: 64, height: 48, channels: 3, background: '#fff' } })
              .jpeg()
              .toBuffer()
          )
        )
    })
    expect((await handleOgImageHttp(get('/og/contenido/guia.png'), deps))!.status).toBe(200)
    expect(render.mock.calls[0]![0]).toMatchObject({
      kind: 'contenido',
      title: 'Guía de dosificación',
      subtitle: 'Cómo dosificar',
      photo: { width: 64, height: 48 }
    })
    expect(calls).toContain(`/api/content-media/${mediaId}/image?w=400&format=jpeg`)
    expect((await handleOgImageHttp(get('/og/contenido/previa.png'), deps))!.status).toBe(404)
  })
})

describe('end to end with the real renderer', () => {
  let render: OgImageDependencies['render']
  beforeAll(async () => {
    render = createOgRenderer(await loadOgRenderAssets()).render
  })

  it('serves a real 1200x630 PNG under 300 KB for a hostile product name', async () => {
    const photo = await syntheticPhoto(300, 900)
    expect(photo.width).toBe(300)
    const { deps } = setup(
      {
        '/api/products/x': () =>
          json(productBody({ name: 'Ñandú '.repeat(60) + ' 清洁 ' + 'a'.repeat(40), image: PHOTO })),
        [PHOTO_400]: async () =>
          new Response(
            Buffer.from(
              await sharp({ create: { width: 300, height: 900, channels: 3, background: '#fff' } })
                .jpeg()
                .toBuffer()
            )
          )
      },
      { render }
    )
    const response = await handleOgImageHttp(get('/og/producto/x.png'), deps)
    expect(response!.status).toBe(200)
    const png = new Uint8Array(await response!.arrayBuffer())
    expect(pngSize(png)).toEqual({ signature: PNG_SIGNATURE, width: 1200, height: 630 })
    expect(png.byteLength).toBeLessThanOrEqual(300 * 1024)
    expect(Number(response!.headers.get('content-length'))).toBe(png.byteLength)
  })
})
