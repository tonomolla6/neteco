import assert from 'node:assert/strict'
import { test } from 'vitest'
import { applyDemoMainCatalog, planDemoMainCatalog } from '../../scripts/cloudflare-demo-remote'
import { CATALOG_PDF_PARENT_CATEGORY_ID, planCatalogPdf, withLoaderSession } from '../../scripts/lib/demo-catalog-pdf'
import { planCatalogPrices } from '../../scripts/lib/demo-catalog-prices'
import { renderD1CategorySeed, stableUuid } from '../../scripts/lib/d1-category-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import { renderD1InventorySeed } from '../../scripts/lib/d1-inventory-seed'
import { renderD1ShippingSeed } from '../../scripts/lib/d1-shipping-seed'
import { applyGeneratedSeed, d1OverSqlite, openAccountSecurityDatabase } from '../../tests/support/d1-sqlite'
import worker from '../../workers/canary'
import type { ProductListResponse } from '../../shared/types/catalog'
import { provisionPublicationValidityFixture } from '../../tests/support/publication-validity-fixture'

const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
// Minimal synthetic assortment: two populated children and 16 products per new root.
const families = [
  'Ollas y cazos',
  'Cuchillos',
  'Servicio de mesa',
  'Termos',
  'Moldes de repostería',
  'Repostería',
  'Básculas',
  'Utensilios de barbacoa'
]
const source = {
  productos: [
    ...families.flatMap((family) => Array.from({ length: 8 }, (_, index) => ({ family, index }))),
    { family: 'Utensilios profesionales', index: 0 }
  ].map(({ family, index }, position) => ({
    nombre: `${family} sintético ${index}`,
    familia: family,
    marca: 'Lacor' as const,
    descripcion: `Artículo sintético ${position} para comprobar la migración de familias.`,
    pagina_pdf: 18,
    referencia_imagen: `CATM${position}`,
    variantes: [0, 1].map((variant) => ({
      referencia: `CATM${position}-${variant}`,
      atributos: { unidad_venta: '1' },
      precio: null
    }))
  }))
}

const expected = [16, 16, 16, 16]
async function fixture(real = false) {
  const sqlite = await openAccountSecurityDatabase()
  for (const render of [renderD1CategorySeed, renderD1ProductSeed, renderD1InventorySeed, renderD1ShippingSeed])
    applyGeneratedSeed(sqlite, render())
  const db = d1OverSqlite(sqlite)
  const plan = planCatalogPdf(source)
  for (const c of plan.categories.filter((x) => !x.existing))
    sqlite
      .prepare("INSERT INTO categories(id,legacy_id,parent_id,name,slug,status) VALUES(?,?,?,?,?,'published')")
      .run(c.id, c.legacyId, CATALOG_PDF_PARENT_CATEGORY_ID, c.name, c.slug)
  for (const p of plan.products)
    sqlite
      .prepare(
        "INSERT INTO products(id,legacy_id,category_id,name,slug,status,source_version) VALUES(?,?,?,?,?,'published','catalog-pdf-2026-11-12')"
      )
      .run(p.id, p.legacyId, p.categoryId, p.name, p.slug)
  if (real) {
    const prices = new Map(planCatalogPrices(source).map((row) => [row.sku, row.grossCents]))
    for (const p of plan.products)
      for (const v of p.variants)
        sqlite
          .prepare(
            "INSERT INTO variants(id,legacy_id,product_id,sku,mpn,format,status,tax_class_id,shipping_profile_id,price_gross_cents,source_version,unit_base,unit_label,content_quantity) VALUES(?,?,?,?,?,?,'published',?,?,?,'catalog-pdf-2026-11-12','unit','ud',1)"
          )
          .run(
            v.id,
            v.legacyId,
            p.id,
            v.sku,
            v.mpn,
            v.format,
            stableUuid('tax:es-general-21'),
            stableUuid('shipping:parcel'),
            prices.get(v.sku)!
          )
    await provisionPublicationValidityFixture(db, { productIds: plan.products.map((p) => p.id), now })
  }
  return { sqlite, db }
}

test('plans four main families, two children each, at least 15 products and stable original identities', () => {
  const plan = planDemoMainCatalog(source)
  assert.deepEqual(
    plan.roots.map((x) => x.count),
    expected
  )
  assert.ok(plan.roots.every((x) => x.children.length >= 2 && x.children.length <= 6 && x.count >= 15))
  assert.equal(plan.creates.length, 7)
  assert.equal(plan.reparents.length, 5)
  assert.equal(plan.moves.length, 24)
  assert.deepEqual(planDemoMainCatalog(source), plan)
  assert.throws(
    () => planDemoMainCatalog({ productos: source.productos.slice(0, 5) }),
    /catalog_main_insufficient_products/
  )
  assert.throws(() => planDemoMainCatalog({ productos: [...source.productos, source.productos[0]] }), /duplicate/)
})

test('persists the complete published taxonomy and exposes images and positive prices through real Worker endpoints', async () => {
  const f = await fixture(true)
  try {
    const variantsBefore = f.sqlite.prepare('SELECT * FROM variants ORDER BY id').all()
    const productsBefore = f.sqlite
      .prepare('SELECT id,slug,status,published_at,attributes FROM products ORDER BY id')
      .all()
    await assert.rejects(applyDemoMainCatalog(f.db, null, source, { now }), { code: 'unauthenticated' })
    await withLoaderSession(f.db, now, async (actor) => {
      const first = await applyDemoMainCatalog(f.db, actor, source, { now })
      assert.equal(first.categoriesCreated, 7)
      assert.equal(first.categoriesMoved, 5)
      assert.equal(first.productsMoved, 24)
      assert.deepEqual(await applyDemoMainCatalog(f.db, actor, source, { now }), first)
      const changed = structuredClone(source)
      changed.productos[0].nombre += ' cambiado'
      await assert.rejects(applyDemoMainCatalog(f.db, actor, changed, { now }), { code: 'idempotency_conflict' })
    })
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM variants ORDER BY id').all(), variantsBefore)
    assert.deepEqual(
      f.sqlite.prepare('SELECT id,slug,status,published_at,attributes FROM products ORDER BY id').all(),
      productsBefore
    )
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM demo_catalog_main_changes').get()!.n, 36)
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM demo_catalog_main_runs').get()!.n, 1)
    const env = { DB: f.db, AUTH_ENABLED: 'false', REDSYS_ENABLED: 'false' } as CloudflareEnv
    const categoriesResponse = await worker.fetch(new Request('https://neteco.invalid/api/categories'), env)
    assert.equal(categoriesResponse.status, 200)
    const categories = (await categoriesResponse.json()) as {
      roots: Array<{ slug: string; count: number; children: unknown[] }>
    }
    for (const [index, root] of planDemoMainCatalog(source).roots.entries()) {
      const category = categories.roots.find((x) => x.slug === root.slug)
      assert.equal(category?.count, expected[index])
      assert.equal(category?.children.length, 2)
      const response = await worker.fetch(
        new Request(`https://neteco.invalid/api/products?category=${root.slug}&limit=24`),
        env
      )
      assert.equal(response.status, 200)
      const data = (await response.json()) as ProductListResponse
      assert.ok(data.items.length >= 15)
      assert.ok(data.items.every((x) => x.image && x.minPrice > 0))
    }
  } finally {
    f.sqlite.close()
  }
})

test('a concurrent product edit causes atomic CAS rejection, preserving that edit and leaving no taxonomy/audit changes', async () => {
  const f = await fixture()
  try {
    await withLoaderSession(f.db, now, async (actor) => {
      const original = f.db.batch.bind(f.db)
      let injected = false
      const raced = new Proxy(f.db, {
        get(target, key) {
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (
                !injected &&
                statements.some((s) =>
                  String((s as unknown as { sql?: string }).sql).includes('INSERT INTO demo_catalog_main_runs')
                )
              ) {
                injected = true
                f.sqlite
                  .prepare("UPDATE products SET short_description='Concurrent edit' WHERE id=?")
                  .run(planDemoMainCatalog(source).products[0]!.id)
              }
              return original(statements)
            }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await assert.rejects(applyDemoMainCatalog(raced, actor, source, { now }), { code: 'catalog_main_conflict' })
      assert.equal(f.sqlite.prepare('SELECT count(*) n FROM demo_catalog_main_runs').get()!.n, 0)
      assert.equal(f.sqlite.prepare("SELECT count(*) n FROM categories WHERE slug='cocina-profesional'").get()!.n, 0)
      assert.equal(
        f.sqlite.prepare("SELECT count(*) n FROM products WHERE short_description='Concurrent edit'").get()!.n,
        1
      )
    })
  } finally {
    f.sqlite.close()
  }
})

test('rejects a colliding root slug without moving published products', async () => {
  const f = await fixture()
  try {
    f.sqlite.exec(
      "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES('unrelated',9876,'Unrelated','cocina-profesional','published')"
    )
    await withLoaderSession(f.db, now, async (actor) => {
      await assert.rejects(applyDemoMainCatalog(f.db, actor, source, { now }), { code: 'category_identity_conflict' })
      assert.equal(f.sqlite.prepare('SELECT count(*) n FROM demo_catalog_main_runs').get()!.n, 0)
    })
  } finally {
    f.sqlite.close()
  }
})

test('requires MFA and every live capability, including on replay', async () => {
  const f = await fixture()
  try {
    await withLoaderSession(f.db, now, async (actor) => {
      f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(actor.sessionId)
      await assert.rejects(applyDemoMainCatalog(f.db, actor, source, { now }), { code: 'mfa_required' })
      f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(actor.sessionId)
      f.sqlite.exec(
        "DELETE FROM role_permissions WHERE role_code='demo_bootstrap' AND permission_code='catalog.publish'"
      )
      await assert.rejects(applyDemoMainCatalog(f.db, actor, source, { now }), { code: 'forbidden' })
      f.sqlite.exec(
        "INSERT INTO role_permissions(role_code,permission_code) VALUES('demo_bootstrap','catalog.publish')"
      )
      await applyDemoMainCatalog(f.db, actor, source, { now })
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(now, actor.sessionId)
      await assert.rejects(applyDemoMainCatalog(f.db, actor, source, { now }), { code: 'unauthenticated' })
      assert.equal(f.sqlite.prepare('SELECT count(*) n FROM demo_catalog_main_runs').get()!.n, 1)
      assert.throws(() => f.sqlite.exec('DELETE FROM demo_catalog_main_changes'), /immutable/)
    })
  } finally {
    f.sqlite.close()
  }
})

test('a session revocation between preflight and batch rolls back categories, products and audit', async () => {
  const f = await fixture()
  try {
    await withLoaderSession(f.db, now, async (actor) => {
      const original = f.db.batch.bind(f.db)
      const raced = new Proxy(f.db, {
        get(target, key) {
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (
                statements.some((s) =>
                  String((s as unknown as { sql?: string }).sql).includes('INSERT INTO demo_catalog_main_runs')
                )
              )
                f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(now, actor.sessionId)
              return original(statements)
            }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await assert.rejects(applyDemoMainCatalog(raced, actor, source, { now }), { code: 'unauthenticated' })
      assert.equal(f.sqlite.prepare('SELECT count(*) n FROM demo_catalog_main_runs').get()!.n, 0)
      assert.equal(f.sqlite.prepare('SELECT count(*) n FROM demo_catalog_main_changes').get()!.n, 0)
      assert.equal(f.sqlite.prepare("SELECT count(*) n FROM categories WHERE slug='cocina-profesional'").get()!.n, 0)
    })
  } finally {
    f.sqlite.close()
  }
})

test('two concurrent identical migrations share one receipt and one set of 36 audit entries', async () => {
  const f = await fixture()
  try {
    await withLoaderSession(f.db, now, async (actor) => {
      const [first, second] = await Promise.all([
        applyDemoMainCatalog(f.db, actor, source, { now }),
        applyDemoMainCatalog(f.db, actor, source, { now })
      ])
      assert.deepEqual(first, second)
      assert.equal(f.sqlite.prepare('SELECT count(*) n FROM demo_catalog_main_runs').get()!.n, 1)
      assert.equal(f.sqlite.prepare('SELECT count(*) n FROM demo_catalog_main_changes').get()!.n, 36)
    })
  } finally {
    f.sqlite.close()
  }
})

test('does not expose a subtree whose source parent is hidden', async () => {
  const f = await fixture()
  try {
    f.sqlite.prepare("UPDATE categories SET status='hidden' WHERE id=?").run(CATALOG_PDF_PARENT_CATEGORY_ID)
    await withLoaderSession(f.db, now, async (actor) => {
      await assert.rejects(applyDemoMainCatalog(f.db, actor, source, { now }), { code: 'parent_unavailable' })
      assert.equal(f.sqlite.prepare('SELECT count(*) n FROM demo_catalog_main_runs').get()!.n, 0)
    })
  } finally {
    f.sqlite.close()
  }
})
