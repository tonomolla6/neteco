import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { renderD1CategorySeed } from '../../scripts/lib/d1-category-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import { renderD1InventorySeed } from '../../scripts/lib/d1-inventory-seed'
import type { OgCardSpec } from '../../workers/seo/og-card'
import { applyGeneratedSeed, d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const rendered = vi.hoisted(() => [] as OgCardSpec[])
// Fake renderer: wasm/fonts only load in workerd; everything else (routing, data, publication gates) is the real worker.
vi.mock('../../workers/seo/og-image-runtime', () => ({
  ogImageRuntime: (origin: string, dispatch: (request: Request) => Promise<Response>) => ({
    fetchInternal: (path: string) => dispatch(new Request(new URL(path, origin).href)),
    render: async (spec: OgCardSpec) => {
      rendered.push(spec)
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    }
  })
}))
const { default: worker } = await import('../../workers/canary')

describe('canary worker serves dynamic Open Graph cards from the real publication gates', () => {
  let sqlite: DatabaseSync
  let env: CloudflareEnv
  let product: { slug: string; name: string }
  let category: { slug: string; name: string }
  const card = (path: string, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(`https://neteco.invalid${path}`, { headers }), env)

  beforeEach(async () => {
    rendered.length = 0
    sqlite = await openMigratedDatabase()
    applyGeneratedSeed(sqlite, renderD1CategorySeed())
    applyGeneratedSeed(sqlite, renderD1ProductSeed())
    applyGeneratedSeed(sqlite, renderD1InventorySeed())
    const database = d1OverSqlite(sqlite)
    await provisionPublicationValidityFixture(database, {
      productIds: sqlite
        .prepare("SELECT id FROM products WHERE status='published'")
        .all()
        .map((row) => String(row.id)),
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    env = { DB: database, AUTH_ENABLED: 'false', REDSYS_ENABLED: 'false' } as CloudflareEnv
    product = sqlite
      .prepare(
        `SELECT p.slug, p.name FROM products p JOIN categories c ON c.id = p.category_id
         WHERE p.status = 'published' AND c.status = 'published' ORDER BY p.legacy_id LIMIT 1`
      )
      .get() as typeof product
    category = sqlite
      .prepare(
        `SELECT slug, name FROM categories WHERE status = 'published' AND parent_id IS NULL ORDER BY sort_order LIMIT 1`
      )
      .get() as typeof category
  })
  afterEach(() => sqlite.close())

  it('renders a published product with its real name and public price, with cacheable headers', async () => {
    const response = await card(`/og/producto/${product.slug}.png`, {
      cookie: 'session=private',
      authorization: 'Bearer x'
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toContain('public')
    expect(response.headers.get('etag')).toBeTruthy()
    const spec = rendered[0]!
    expect(spec).toMatchObject({ kind: 'producto', title: product.name })
    const expectedMin = sqlite
      .prepare(
        `SELECT min(v.price_gross_cents) AS price FROM variants v JOIN products p ON p.id = v.product_id
         WHERE p.slug = ? AND v.status = 'published'`
      )
      .get(product.slug) as { price: number }
    expect(spec.kind === 'producto' && spec.fromPriceCents).toBe(expectedMin.price)
  })

  it.each(['draft', 'review', 'hidden', 'discontinued'])(
    'does not leak a %s product: 404 and nothing rendered',
    async (status) => {
      sqlite.prepare('UPDATE products SET status = ? WHERE slug = ?').run(status, product.slug)
      const response = await card(`/og/producto/${product.slug}.png`)
      expect(response.status).toBe(404)
      expect(rendered).toHaveLength(0)
    }
  )

  it('does not render a product whose variants are all unpublished or whose category is hidden', async () => {
    sqlite
      .prepare("UPDATE variants SET status = 'hidden' WHERE product_id = (SELECT id FROM products WHERE slug = ?)")
      .run(product.slug)
    expect((await card(`/og/producto/${product.slug}.png`)).status).toBe(404)
  })

  it('renders a published category with its product count and 404s once it is no longer published', async () => {
    expect((await card(`/og/categoria/${category.slug}.png`)).status).toBe(200)
    expect(rendered[0]).toMatchObject({ kind: 'categoria', title: category.name })
    sqlite.prepare("UPDATE categories SET status = 'draft' WHERE slug = ?").run(category.slug)
    expect((await card(`/og/categoria/${category.slug}.png`)).status).toBe(404)
  })

  it('falls back to the static card when the catalogue is unavailable', async () => {
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('d1 down')
        }
      }
    } as unknown as CloudflareEnv
    const response = await worker.fetch(new Request(`https://neteco.invalid/og/producto/${product.slug}.png`), broken)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://neteco.invalid/og/og-producto.jpg')
  })

  it('leaves unrelated /og paths to the static assets', async () => {
    const response = await card('/og/og-producto.jpg')
    expect(rendered).toHaveLength(0)
    expect(response.status).not.toBe(200)
  })
})
