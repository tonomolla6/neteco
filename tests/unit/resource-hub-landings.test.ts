import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resourceHubFixture, editorial } from './resource-hub-fixture'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { handleD1SeoRequest, type D1SeoDependencies } from '../../workers/catalog/seo-http'
import { listD1ResourceHub, listLandingCoverage, readD1ResourceHub } from '../../workers/content/resource-hub'
import { LANDING_MIN_TEXT_CHARS } from '../../shared/landing-quality'
import { cmsUtc } from './d1-cms-fixture'

const ORIGIN = 'https://neteco.es'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let blockSeq = 100
const h = (text: string) => ({ id: uuid(++blockSeq), type: 'heading', level: 'h2', text })
const p = (text: string) => ({ id: uuid(++blockSeq), type: 'paragraph', text })
const body = (seed: string) => {
  let i = 0
  const out: string[] = []
  while (out.join('').length < LANDING_MIN_TEXT_CHARS + 300) {
    out.push(`${seed} detalle${i++} específico del servicio de limpieza profesional con producto y pauta propia.`)
  }
  // paragraphs are capped at 5000 chars
  return p(out.join(' '))
}
const locations = (xml: string) => [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]!)

describe('SEO-028 landings with real value only', () => {
  let f: Awaited<ReturnType<typeof resourceHubFixture>>
  const ids = [uuid(9001), uuid(9002), uuid(9003), uuid(9004)]
  beforeEach(async () => {
    f = await resourceHubFixture()
    f.sqlite.exec(`INSERT INTO brands(id,name,slug,status) VALUES ('lb','NETECO','lb','published');
      INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES ('lt','LND21','IVA',2100,'2020-01-01T00:00:00Z');
      INSERT INTO shipping_profiles(id,code,name,kind) VALUES ('ls','LND','Paquete','parcel');
      INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES ('ll','LND-LOC','Almacén','warehouse',1,'2026-08-12T00:00:00Z');
      INSERT INTO categories(id,legacy_id,name,slug,status,sort_order) VALUES ('lc',70,'Cat','cat-landing','published',1);`)
    ids.forEach((id, i) => {
      const status = i === 3 ? 'draft' : 'published'
      f.sqlite
        .prepare(
          `INSERT INTO products(id,legacy_id,name,slug,category_id,brand_id,status) VALUES (?,?,?,?,'lc','lb',?)`
        )
        .run(id, 301 + i, `Producto ${i}`, `producto-${i}`, status)
      f.sqlite
        .prepare(
          `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents)
           VALUES (?,?,?,'lt','ls',?,'1 L','published',1210)`
        )
        .run(`lv-${i}`, 301 + i, id, `LND-${i}`)
      f.sqlite
        .prepare(
          `INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at)
           VALUES (?,'ll',10,0,1,'2026-08-12T00:00:00Z','2026-08-12T00:00:00Z')`
        )
        .run(`lv-${i}`)
    })
    await provisionPublicationValidityFixture(f.database, {
      productIds: ids,
      now: cmsUtc(-60000),
      validUntil: '2099-01-01T00:00:00Z'
    })
  })
  afterEach(() => f.sqlite.close())
  const seo = (noindex = false) => ({ title: 'Landing', description: 'Landing sintética con oferta real.', noindex })
  const landing = (slug: string, extra: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) =>
    f.resource({
      slug,
      title: `Landing ${slug}`,
      seo: seo(),
      blocks: [h('Casos de clientes del sector'), body(slug)],
      resourceHub: editorial({
        kind: 'landing',
        category: { slug: 'sector-hosteleria', label: 'Hostelería' },
        relatedProducts: [301, 302, 303],
        ...meta
      }),
      ...extra
    })

  it('noindexes a landing whose live offer is below the minimum', async () => {
    await landing('hosteleria', {}, { relatedProducts: [301, 302] })
    // only 2 live products: not enough -> noindex
    expect((await listD1ResourceHub(f.deps, {})).items[0]).toMatchObject({ slug: 'hosteleria', noindex: true })
  })
  it('only counts published, publication-valid products as offer (a draft product does not count)', async () => {
    await landing('con-borrador', {}, { relatedProducts: [301, 302, 304] })
    expect((await listD1ResourceHub(f.deps, {})).items[0]!.noindex).toBe(true)
    const coverage = await listLandingCoverage(f.deps)
    expect(coverage[0]).toMatchObject({ slug: 'con-borrador', indexable: false })
    expect(coverage[0]!.reasons).toContain('offer_missing')
  })
  it('indexes a complete landing in list, detail and sitemap; thin ones are noindex and absent from the sitemap', async () => {
    await landing(
      'sanidad-completa',
      {},
      { category: { slug: 'sector-sanidad', label: 'Sanidad' }, relatedProducts: [] }
    )
    await landing('delgada', { blocks: [p('Texto breve.')] })
    // complete: three live products (draft excluded -> only 301..303 exist as published)
    const ok = await landing(
      'completa-ok',
      {},
      { relatedProducts: [301, 302, 303], category: { slug: 'sector-industria', label: 'Industria' } }
    )
    expect(ok.pageId).toBeTruthy()
    const list = await listD1ResourceHub(f.deps, {})
    const flags = Object.fromEntries(list.items.map((i) => [i.slug, i.noindex]))
    expect(flags['completa-ok']).toBe(false)
    expect(flags['delgada']).toBe(true)
    expect(flags['sanidad-completa']).toBe(true)
    expect((await readD1ResourceHub(f.deps, 'delgada')).noindex).toBe(true)
    expect((await readD1ResourceHub(f.deps, 'completa-ok')).noindex).toBe(false)
    const deps: D1SeoDependencies = {
      database: f.database,
      origin: ORIGIN,
      environment: 'production',
      cmsPublication: f.deps
    }
    const response = await handleD1SeoRequest(new Request(`${ORIGIN}/sitemaps/content.xml`), deps)
    const paths = locations(await response!.text())
    expect(paths).toContain(`${ORIGIN}/recursos/completa-ok`)
    expect(paths).not.toContain(`${ORIGIN}/recursos/delgada`)
    expect(paths).not.toContain(`${ORIGIN}/recursos/sanidad-completa`)
    const index = await handleD1SeoRequest(new Request(`${ORIGIN}/sitemap.xml`), deps)
    expect(index!.status).toBe(200)
  })
  it('flags a duplicated landing set as doorway pages: only the earliest stays indexable', async () => {
    await landing(
      'zona-a',
      { blocks: [h('Casos de clientes'), body('mismo')] },
      { category: { slug: 'sector-a', label: 'A' } }
    )
    await landing(
      'zona-b',
      { blocks: [h('Casos de clientes'), body('mismo')] },
      { category: { slug: 'sector-b', label: 'B' } }
    )
    const flags = Object.fromEntries((await listD1ResourceHub(f.deps, {})).items.map((i) => [i.slug, i.noindex]))
    expect(flags).toEqual({ 'zona-a': false, 'zona-b': true })
  })
  it('never touches articles and pillars', async () => {
    await f.resource({ slug: 'articulo-corto', seo: seo(), resourceHub: editorial({ kind: 'article' }) })
    expect((await listD1ResourceHub(f.deps, {})).items[0]).toMatchObject({ slug: 'articulo-corto', noindex: false })
  })
  it('respects an explicit editorial noindex even for a complete landing', async () => {
    await landing('manual', { seo: seo(true) })
    expect((await listD1ResourceHub(f.deps, {})).items[0]!.noindex).toBe(true)
  })
})
