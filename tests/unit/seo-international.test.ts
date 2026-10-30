import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bvFixture, CLAIMS, ID, utc } from './bv-fixture'
import { executeMarketCatalogCommand } from '../../workers/catalog/market-catalog'
import { buildHreflangSet, HreflangError } from '../../shared/seo-international'
import { resolveProductHreflang, reviewMarketTranslation } from '../../workers/catalog/seo-international'

const ORIGIN = 'https://neteco.example'
const options = { now: () => utc() }

describe('SEO-033 buildHreflangSet (pure)', () => {
  const alternates = [
    { marketCode: 'FR', locale: 'fr-FR', slug: 'nettoyant' },
    { marketCode: 'DE', locale: 'de-DE', slug: 'reiniger' }
  ]

  it('emits the same full set from every page so alternates are reciprocal', () => {
    const set = buildHreflangSet(ORIGIN, { slug: 'limpiador' }, alternates)
    expect(set.links.map((l) => l.hreflang).sort()).toEqual(['de-DE', 'es-ES', 'fr-FR', 'x-default'])
    const hrefs = new Map(set.links.map((l) => [l.hreflang, l.href]))
    expect(hrefs.get('es-ES')).toBe(`${ORIGIN}/producto/limpiador`)
    expect(hrefs.get('fr-FR')).toBe(`${ORIGIN}/fr-fr/producto/nettoyant`)
    expect(hrefs.get('x-default')).toBe(hrefs.get('es-ES'))
  })

  it('gives each market a self-referencing canonical that is also one of the alternates', () => {
    const set = buildHreflangSet(ORIGIN, { slug: 'limpiador' }, alternates)
    expect(Object.keys(set.canonicalByMarket).sort()).toEqual(['DE', 'ES', 'FR'])
    for (const href of Object.values(set.canonicalByMarket)) expect(set.links.some((l) => l.href === href)).toBe(true)
    expect(new Set(Object.values(set.canonicalByMarket)).size).toBe(3)
  })

  it('drops a second market that would repeat an hreflang value, deterministically by market code', () => {
    const set = buildHreflangSet(ORIGIN, { slug: 'x' }, [
      { marketCode: 'PT', locale: 'pt-PT', slug: 'b' },
      { marketCode: 'AO', locale: 'pt-PT', slug: 'a' }
    ])
    expect(set.links.filter((l) => l.hreflang === 'pt-PT')).toHaveLength(1)
    expect(set.excluded).toEqual([{ marketCode: 'PT', reason: 'duplicate_hreflang' }])
  })

  it('treats an es-ES alternate as the base market and never duplicates it', () => {
    const set = buildHreflangSet(ORIGIN, { slug: 'x' }, [{ marketCode: 'ES', locale: 'es-ES', slug: 'otro' }])
    expect(set.links.filter((l) => l.hreflang === 'es-ES')).toHaveLength(1)
    expect(set.links.find((l) => l.hreflang === 'es-ES')!.href).toBe(`${ORIGIN}/producto/x`)
  })

  it('encodes slugs and rejects unsafe slugs or origins', () => {
    const set = buildHreflangSet(ORIGIN, { slug: 'x' }, [{ marketCode: 'FR', locale: 'fr-FR', slug: 'a b/../c' }])
    expect(set.links.some((l) => l.href.includes('a b'))).toBe(false)
    expect(set.excluded).toEqual([{ marketCode: 'FR', reason: 'invalid_slug' }])
    expect(() => buildHreflangSet('javascript:alert(1)', { slug: 'x' }, [])).toThrow(HreflangError)
  })

  it('rejects malformed locales instead of emitting an invalid hreflang', () => {
    const set = buildHreflangSet(ORIGIN, { slug: 'x' }, [{ marketCode: 'FR', locale: 'fr_FR!', slug: 'a' }])
    expect(set.excluded).toEqual([{ marketCode: 'FR', reason: 'invalid_locale' }])
  })
})

describe('SEO-033 market hreflang from catalog data', () => {
  let f: Awaited<ReturnType<typeof bvFixture>>
  beforeEach(async () => {
    f = await bvFixture()
  })
  afterEach(() => f.sqlite.close())

  let counter = 100
  const config = (over: Record<string, unknown> = {}) => ({
    action: 'configure' as const,
    expectedVersion: 0,
    marketCode: 'FR',
    locale: 'fr-FR',
    title: 'Nettoyant',
    description: 'Description fr',
    slug: 'nettoyant-1',
    isAvailable: true,
    isCompliant: true,
    availabilityStatus: 'available' as const,
    ...over
  })
  const configure = (over: Record<string, unknown> = {}, productId = 'p-1') =>
    executeMarketCatalogCommand(f.database, CLAIMS, productId, ID(++counter), config(over), options)
  const review = (over: Record<string, unknown> = {}, id = ID(++counter)) =>
    reviewMarketTranslation(
      f.database,
      CLAIMS,
      id,
      'p-1',
      { marketCode: 'FR', reviewedConfigVersion: 1, locale: 'fr-FR', reviewerName: 'Claire Dupont', ...over },
      options
    )
  const resolve = (market?: string) =>
    resolveProductHreflang(f.database, { origin: ORIGIN, slug: 'producto-1', market }, options)

  it('returns only es-ES and x-default for a product with no market content', async () => {
    const result = await resolve()
    expect(result.links.map((l) => l.hreflang).sort()).toEqual(['es-ES', 'x-default'])
    expect(result.canonical).toBe(`${ORIGIN}/producto/producto-1`)
  })

  it('does not publish a market whose translation has not been reviewed by a human', async () => {
    await configure()
    const result = await resolve()
    expect(result.links.some((l) => l.hreflang === 'fr-FR')).toBe(false)
    expect(result.excluded).toContainEqual({ marketCode: 'FR', reason: 'translation_not_reviewed' })
  })

  it('publishes the market after a human review and returns the market canonical', async () => {
    await configure()
    await review()
    const result = await resolve('FR')
    expect(result.links.find((l) => l.hreflang === 'fr-FR')!.href).toBe(`${ORIGIN}/fr-fr/producto/nettoyant-1`)
    expect(result.canonical).toBe(`${ORIGIN}/fr-fr/producto/nettoyant-1`)
    const es = await resolve('ES')
    expect(es.canonical).toBe(`${ORIGIN}/producto/producto-1`)
    expect(es.links).toEqual(result.links)
  })

  it('invalidates the review when the market content changes afterwards', async () => {
    await configure()
    await review()
    await configure({ expectedVersion: 1, description: 'Texto nuevo sin revisar' })
    const result = await resolve()
    expect(result.excluded).toContainEqual({ marketCode: 'FR', reason: 'translation_not_reviewed' })
  })

  it.each([
    ['unavailable', { isAvailable: false }, 'not_available'],
    ['non compliant', { isAvailable: false, isCompliant: false }, 'not_available'],
    ['restricted', { availabilityStatus: 'restricted' }, 'not_publicly_sellable'],
    ['b2b only', { availabilityStatus: 'b2b_only' }, 'not_publicly_sellable'],
    ['discontinued', { availabilityStatus: 'discontinued' }, 'not_publicly_sellable']
  ])('excludes a %s market even if the translation is reviewed', async (_name, over, reason) => {
    await configure(over)
    await review()
    const result = await resolve()
    expect(result.links.some((l) => l.hreflang === 'fr-FR')).toBe(false)
    expect(result.excluded).toContainEqual({ marketCode: 'FR', reason })
  })

  it('excludes a hazardous market listing that has no safety data sheet', async () => {
    await configure({ clpWarnings: ['H314'] })
    await review()
    expect((await resolve()).excluded).toContainEqual({ marketCode: 'FR', reason: 'sds_missing' })
  })

  it('includes a hazardous market listing once the SDS URL exists', async () => {
    await configure({ clpWarnings: ['H314'], sdsUrl: 'https://cdn.example/sds/fr.pdf' })
    await review()
    expect((await resolve()).links.some((l) => l.hreflang === 'fr-FR')).toBe(true)
  })

  it('excludes inactive markets', async () => {
    await configure()
    await review()
    f.sqlite.exec("UPDATE catalog_markets SET is_active=0, updated_at=updated_at WHERE code='FR'")
    expect((await resolve()).excluded).toContainEqual({ marketCode: 'FR', reason: 'market_inactive' })
  })

  it('returns not_found for unknown, unpublished products and markets outside the published set', async () => {
    await expect(resolveProductHreflang(f.database, { origin: ORIGIN, slug: 'nope' }, options)).rejects.toMatchObject({
      code: 'not_found'
    })
    f.sqlite.exec("UPDATE products SET status='draft' WHERE id='p-1'")
    await expect(resolve()).rejects.toMatchObject({ code: 'not_found' })
    f.sqlite.exec("UPDATE products SET status='published' WHERE id='p-1'")
    await expect(resolve('FR')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects malformed product references and market codes', async () => {
    await expect(resolveProductHreflang(f.database, { origin: ORIGIN, market: 'fr' }, options)).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(
      resolveProductHreflang(f.database, { origin: ORIGIN, slug: 'producto-1', market: "FR'; DROP" }, options)
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  describe('reviewMarketTranslation', () => {
    it('is idempotent for the same command and rejects the same command with a different payload', async () => {
      await configure()
      const id = ID(900)
      const first = await review({}, id)
      expect(await review({}, id)).toEqual(first)
      await expect(review({ reviewerName: 'Otra Persona' }, id)).rejects.toMatchObject({ code: 'conflict' })
    })

    it('rejects a second review of an already reviewed version and a review of a stale version', async () => {
      await configure()
      await review()
      await expect(review()).rejects.toMatchObject({ code: 'conflict' })
      await configure({ expectedVersion: 1, description: 'v2' })
      await expect(review()).rejects.toMatchObject({ code: 'conflict' })
      await expect(review({ reviewedConfigVersion: 2, locale: 'de-DE' })).rejects.toMatchObject({ code: 'conflict' })
      await expect(review({ reviewedConfigVersion: 2 })).resolves.toMatchObject({ reviewedConfigVersion: 2 })
    })

    it('requires an authenticated administrator with MFA and live permission', async () => {
      await configure()
      await expect(
        reviewMarketTranslation(f.database, null, ID(801), 'p-1', {
          marketCode: 'FR',
          reviewedConfigVersion: 1,
          locale: 'fr-FR',
          reviewerName: 'Claire Dupont'
        })
      ).rejects.toMatchObject({ code: 'unauthenticated' })
      await expect(
        reviewMarketTranslation(f.database, f.plainClaims, ID(802), 'p-1', {
          marketCode: 'FR',
          reviewedConfigVersion: 1,
          locale: 'fr-FR',
          reviewerName: 'Claire Dupont'
        })
      ).rejects.toMatchObject({ code: 'forbidden' })
      f.sqlite.exec(`UPDATE auth_sessions SET revoked_at='${utc()}' WHERE id='${CLAIMS.sessionId}'`)
      await expect(review()).rejects.toMatchObject({ code: 'unauthenticated' })
    })

    it('validates input and unknown product/market', async () => {
      await configure()
      await expect(review({ reviewerName: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(review({ reviewedConfigVersion: 0 })).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(review({ marketCode: 'ZZ' })).rejects.toMatchObject({ code: 'not_found' })
      await expect(
        reviewMarketTranslation(
          f.database,
          CLAIMS,
          'not-a-uuid',
          'p-1',
          { marketCode: 'FR', reviewedConfigVersion: 1, locale: 'fr-FR', reviewerName: 'Claire Dupont' },
          options
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })
    })

    it('keeps the review log append-only', async () => {
      await configure()
      await review()
      expect(() => f.sqlite.exec('DELETE FROM catalog_market_translation_reviews')).toThrow(/immutable/)
      expect(() => f.sqlite.exec("UPDATE catalog_market_translation_reviews SET reviewer_name='Zed Zed'")).toThrow(
        /immutable/
      )
    })
  })
})
