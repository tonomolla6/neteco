import { Window } from 'happy-dom'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createCompiledShopFixture } from '../support/compiled-shop-fixture'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { renderD1CategorySeed } from '../../scripts/lib/d1-category-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'

const pageSchema = z
  .object({
    items: z.array(z.object({ id: z.number().int().positive(), name: z.string(), slug: z.string() }).passthrough()),
    total: z.number().int(),
    page: z.number().int(),
    pages: z.number().int()
  })
  .passthrough()

// Actual compiled HTTP + initial SSR. DOM parsing is inert: no browser,
// hydration, script payload or fabricated API response establishes these rows.
it('renders only page two across search, catalogue and category SSR with filter-preserving navigation', async () => {
  const fixture = await createCompiledShopFixture()
  let window: Window | undefined
  try {
    window = new Window({
      settings: {
        disableJavaScriptEvaluation: true,
        disableJavaScriptFileLoading: true,
        disableCSSFileLoading: true
      }
    })
    const db = fixture.database
    for (const render of [renderD1CategorySeed, renderD1ProductSeed]) {
      const statements = splitDemoSql(render())
      for (let offset = 0; offset < statements.length; offset += 75) {
        const results = await db.batch(statements.slice(offset, offset + 75).map((sql) => db.prepare(sql)))
        expect(results.every((result) => result.success)).toBe(true)
      }
    }
    const category = await db
      .prepare(
        "SELECT id, slug FROM categories WHERE status='published' AND parent_id IS NULL ORDER BY legacy_id LIMIT 1"
      )
      .first<{ id: string; slug: string }>()
    if (!category) throw new Error('Published synthetic category is required')
    // Explicit synthetic names and a common category are assigned BEFORE canonical publication
    // approvals; no existing publication is overwritten or treated as valid.
    await db
      .prepare("UPDATE products SET name='Guantes de paginación ' || legacy_id, category_id=?1")
      .bind(category.id)
      .run()
    const selected = await db.prepare('SELECT id FROM products ORDER BY legacy_id').all<{ id: string }>()
    expect(selected.results).toHaveLength(20)
    await provisionPublicationValidityFixture(db, {
      productIds: selected.results.map((row) => row.id),
      now: (await fixture.readServerClock())(-60_000)
    })
    const surfaces = [
      { path: '/buscar', filter: ['q', 'guantes'], navigation: 'Páginas de resultados de búsqueda', noindex: true },
      { path: '/catalogo', filter: null, navigation: 'Paginación del catálogo', noindex: false },
      {
        path: '/categoria/' + category.slug,
        filter: ['category', category.slug],
        navigation: 'Paginación de la categoría',
        noindex: false
      }
    ] as const
    for (const surface of surfaces) {
      async function api(page: number) {
        const query = new URLSearchParams({
          brand: 'NETECO',
          page: String(page),
          limit: '12',
          facets: '1',
          sort: 'featured'
        })
        if (surface.filter) query.set(surface.filter[0], surface.filter[1])
        const response = await fixture.dispatch('/api/products?' + query.toString())
        expect(response.status).toBe(200)
        return pageSchema.parse(await response.json())
      }
      const first = await api(1),
        second = await api(2)
      expect(first).toMatchObject({ total: 20, page: 1, pages: 2 })
      expect(first.items).toHaveLength(12)
      expect(second).toMatchObject({ total: 20, page: 2, pages: 2 })
      expect(second.items).toHaveLength(8)
      expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(20)
      const pageQuery = new URLSearchParams({ brand: 'NETECO', page: '2' })
      if (surface.path === '/buscar') pageQuery.set('q', 'guantes')
      const response = await fixture.dispatch(surface.path + '?' + pageQuery.toString(), {
        headers: {
          accept: 'text/html',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'sec-fetch-site': 'none'
        }
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      const document = new window.DOMParser().parseFromString(await response.text(), 'text/html')
      for (const script of document.querySelectorAll('script')) script.remove()
      const links = [...document.querySelectorAll('a[href^="/producto/"]')]
      expect(links.map((link) => link.getAttribute('href')).sort()).toEqual(
        second.items.map((item) => '/producto/' + item.slug).sort()
      )
      for (const item of second.items) expect(document.body.textContent).toContain(item.name)
      for (const item of first.items) {
        expect(links.some((link) => link.getAttribute('href') === '/producto/' + item.slug)).toBe(false)
      }
      const navigation = document.querySelector(`nav[aria-label="${surface.navigation}"]`)
      expect(navigation).not.toBeNull()
      const previous = [...navigation!.querySelectorAll('a')].find((link) => link.textContent.trim() === 'Anterior')
      expect(previous).toBeDefined()
      const target = new URL(previous!.getAttribute('href')!, fixture.origin)
      expect(target.pathname).toBe(surface.path)
      const previousQuery = new URLSearchParams({ brand: 'NETECO' })
      if (surface.path === '/buscar') previousQuery.set('q', 'guantes')
      expect([...target.searchParams.entries()].sort()).toEqual([...previousQuery.entries()].sort())
      expect([...navigation!.querySelectorAll('a')].some((link) => link.textContent.trim() === 'Siguiente')).toBe(false)
      if (surface.noindex)
        expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex')
    }
    expect(fixture.outbound.requests).toBe(0)
  } finally {
    try {
      await window?.happyDOM.close()
    } finally {
      await fixture.dispose()
    }
  }
}, 120_000)
