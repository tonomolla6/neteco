import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import {
  executeMarketCatalogCommand,
  readProductMarketConfigs,
  resolveProductForMarket,
  seedDefaultMarkets
} from '../../workers/catalog/market-catalog'
import { MarketCatalogError } from '../../shared/catalog-markets'

const MIGRATION_PATH = 'db/d1/migrations/0120_market_catalog_international_shipping.sql'
const options = { now: () => utc() }

describe('CAT-022: Catálogo por mercado/idioma', () => {
  let f: Awaited<ReturnType<typeof returnsFixture>>
  const productId = 'p-1' // standard test product from fixtures
  const commandId1 = '11111111-1111-4111-8111-111111111111'
  const commandId2 = '22222222-2222-4222-8222-222222222222'

  beforeEach(async () => {
    f = await returnsFixture()
    f.sqlite.exec(await readFile(MIGRATION_PATH, 'utf8'))
    await seedDefaultMarkets(f.database, options)
  })

  afterEach(() => {
    f?.sqlite.close()
  })

  it('configures availability, localized content, and chemical compliance for a market without cloning product', async () => {
    const input = {
      action: 'configure' as const,
      expectedVersion: 0,
      marketCode: 'FR',
      locale: 'fr-FR',
      isAvailable: true,
      availabilityStatus: 'available' as const,
      minOrderQuantity: 1,
      maxOrderQuantity: 50,
      title: 'Nettoyant Industriel Professionnel',
      description: 'Solution dégraissante concentrée pour ateliers et usines.',
      slug: 'nettoyant-industriel-pro',
      metaTitle: 'Nettoyant Industriel Pro | Neteco France',
      metaDescription: 'Commandez en ligne votre nettoyant industriel professionnel.',
      usageInstructions: 'Diluer à 5% dans de l eau tiède.',
      isCompliant: true,
      clpWarnings: ['H314', 'H318', 'P280'],
      ufiCode: 'UFI-FR-8899-AAAA',
      registrationNumber: 'REACH-FR-102938',
      sdsUrl: 'https://cdn.neteco.es/sds/fr/nettoyant-pro.pdf',
      complianceNotes: 'Enregistré auprès de l INRS'
    }

    const result = await executeMarketCatalogCommand(f.database, CLAIMS, productId, commandId1, input, options)
    expect(result).toMatchObject({
      commandId: commandId1,
      productId,
      marketCode: 'FR',
      version: 1
    })

    // Read back market configuration
    const configs = await readProductMarketConfigs(f.database, productId)
    expect(configs).toHaveLength(1)
    expect(configs[0]).toMatchObject({
      productId,
      marketCode: 'FR',
      locale: 'fr-FR',
      title: 'Nettoyant Industriel Professionnel',
      slug: 'nettoyant-industriel-pro',
      isAvailable: 1,
      isCompliant: 1,
      ufiCode: 'UFI-FR-8899-AAAA'
    })
    expect(configs[0]?.clpWarnings).toEqual(['H314', 'H318', 'P280'])

    // Base product was NOT cloned: only 1 row in products table
    const productCount = f.sqlite.prepare('SELECT count(*) as count FROM products WHERE id=?').get(productId) as {
      count: number
    }
    expect(productCount.count).toBe(1)
  })

  it('resolves product storefront view localized by market and locale without cloning', async () => {
    // Configure ES and PT markets for same product
    await executeMarketCatalogCommand(
      f.database,
      CLAIMS,
      productId,
      commandId1,
      {
        action: 'configure',
        expectedVersion: 0,
        marketCode: 'ES',
        locale: 'es-ES',
        isAvailable: true,
        availabilityStatus: 'available',
        minOrderQuantity: 1,
        title: 'Desengrasante Alcalino ES',
        description: 'Fórmula profesional España',
        slug: 'desengrasante-alcalino-es',
        isCompliant: true,
        clpWarnings: ['H315'],
        ufiCode: 'UFI-ES-1234'
      },
      options
    )

    await executeMarketCatalogCommand(
      f.database,
      CLAIMS,
      productId,
      commandId2,
      {
        action: 'configure',
        expectedVersion: 0,
        marketCode: 'PT',
        locale: 'pt-PT',
        isAvailable: true,
        availabilityStatus: 'available',
        minOrderQuantity: 2,
        title: 'Desengordurante Alcalino PT',
        description: 'Fórmula profissional Portugal',
        slug: 'desengordurante-alcalino-pt',
        isCompliant: true,
        clpWarnings: ['H315'],
        ufiCode: 'UFI-PT-5678'
      },
      options
    )

    const resolvedES = await resolveProductForMarket(f.database, {
      slug: 'desengrasante-alcalino-es',
      marketCode: 'ES'
    })
    expect(resolvedES).toMatchObject({
      productId,
      marketCode: 'ES',
      title: 'Desengrasante Alcalino ES',
      minOrderQuantity: 1
    })

    const resolvedPT = await resolveProductForMarket(f.database, {
      slug: 'desengordurante-alcalino-pt',
      marketCode: 'PT'
    })
    expect(resolvedPT).toMatchObject({
      productId,
      marketCode: 'PT',
      title: 'Desengordurante Alcalino PT',
      minOrderQuantity: 2
    })
  })

  it('enforces idempotency on duplicate command ID with same payload hash', async () => {
    const payload = {
      action: 'configure' as const,
      expectedVersion: 0,
      marketCode: 'DE',
      locale: 'de-DE',
      isAvailable: true,
      availabilityStatus: 'available' as const,
      minOrderQuantity: 1,
      title: 'Industriereiniger DE',
      description: 'Starke Reinigungskraft',
      slug: 'industriereiniger-de',
      isCompliant: true,
      clpWarnings: ['H314']
    }

    const first = await executeMarketCatalogCommand(f.database, CLAIMS, productId, commandId1, payload, options)
    const second = await executeMarketCatalogCommand(f.database, CLAIMS, productId, commandId1, payload, options)
    expect(second).toEqual(first)
  })

  it('rejects conflicting command ID with different payload', async () => {
    const payload1 = {
      action: 'configure' as const,
      expectedVersion: 0,
      marketCode: 'DE',
      locale: 'de-DE',
      isAvailable: true,
      availabilityStatus: 'available' as const,
      minOrderQuantity: 1,
      title: 'Industriereiniger DE',
      description: 'Starke Reinigungskraft',
      slug: 'industriereiniger-de',
      isCompliant: true,
      clpWarnings: []
    }
    await executeMarketCatalogCommand(f.database, CLAIMS, productId, commandId1, payload1, options)

    const payload2 = {
      ...payload1,
      title: 'Different Title'
    }
    await expect(
      executeMarketCatalogCommand(f.database, CLAIMS, productId, commandId1, payload2, options)
    ).rejects.toThrowError(MarketCatalogError)
  })

  it('rejects optimistic CAS update when expectedVersion does not match', async () => {
    const payload1 = {
      action: 'configure' as const,
      expectedVersion: 0,
      marketCode: 'FR',
      locale: 'fr-FR',
      isAvailable: true,
      availabilityStatus: 'available' as const,
      minOrderQuantity: 1,
      title: 'Nettoyant FR',
      description: 'Desc FR',
      slug: 'nettoyant-fr',
      isCompliant: true,
      clpWarnings: []
    }
    await executeMarketCatalogCommand(f.database, CLAIMS, productId, commandId1, payload1, options)

    // Stale expectedVersion: expecting 0 instead of 1
    const stalePayload = {
      ...payload1,
      expectedVersion: 0,
      title: 'Nettoyant FR Updated'
    }
    await expect(
      executeMarketCatalogCommand(f.database, CLAIMS, productId, commandId2, stalePayload, options)
    ).rejects.toThrowError(MarketCatalogError)
  })

  it('prevents making a product available in a market if not compliant', async () => {
    const nonCompliant = {
      action: 'configure' as const,
      expectedVersion: 0,
      marketCode: 'IT',
      locale: 'it-IT',
      isAvailable: true, // cannot be available if isCompliant = false
      availabilityStatus: 'available' as const,
      minOrderQuantity: 1,
      title: 'Sgrassatore IT',
      description: 'Desc IT',
      slug: 'sgrassatore-it',
      isCompliant: false,
      clpWarnings: []
    }

    await expect(
      executeMarketCatalogCommand(f.database, CLAIMS, productId, commandId1, nonCompliant, options)
    ).rejects.toThrow()
  })

  it('denies access to non-admin identities', async () => {
    const payload = {
      action: 'configure' as const,
      expectedVersion: 0,
      marketCode: 'FR',
      locale: 'fr-FR',
      isAvailable: true,
      availabilityStatus: 'available' as const,
      minOrderQuantity: 1,
      title: 'Nettoyant FR',
      description: 'Desc FR',
      slug: 'nettoyant-fr',
      isCompliant: true,
      clpWarnings: []
    }

    await expect(
      executeMarketCatalogCommand(f.database, BUYER_CLAIMS, productId, commandId1, payload, options)
    ).rejects.toThrowError(MarketCatalogError)
  })

  it('rejects invalid input when maxOrderQuantity is less than minOrderQuantity', async () => {
    const invalidQty = {
      action: 'configure' as const,
      expectedVersion: 0,
      marketCode: 'FR',
      locale: 'fr-FR',
      isAvailable: true,
      availabilityStatus: 'available' as const,
      minOrderQuantity: 10,
      maxOrderQuantity: 5, // invalid: max < min
      title: 'Nettoyant FR',
      description: 'Desc FR',
      slug: 'nettoyant-fr-qty',
      isCompliant: true,
      clpWarnings: []
    }

    await expect(
      executeMarketCatalogCommand(f.database, CLAIMS, productId, commandId1, invalidQty, options)
    ).rejects.toThrowError(new MarketCatalogError('invalid_input'))
  })

  it('rejects invalid market code not matching uppercase 2-5 letter format', async () => {
    const invalidCode = {
      action: 'configure' as const,
      expectedVersion: 0,
      marketCode: 'fr_FR', // invalid format
      locale: 'fr-FR',
      isAvailable: true,
      availabilityStatus: 'available' as const,
      minOrderQuantity: 1,
      title: 'Nettoyant FR',
      description: 'Desc FR',
      slug: 'nettoyant-fr-code',
      isCompliant: true,
      clpWarnings: []
    }

    await expect(
      executeMarketCatalogCommand(f.database, CLAIMS, productId, commandId1, invalidCode, options)
    ).rejects.toThrowError(new MarketCatalogError('invalid_input'))
  })

  it('rejects invalid SDS URL if not https scheme', async () => {
    const invalidSds = {
      action: 'configure' as const,
      expectedVersion: 0,
      marketCode: 'FR',
      locale: 'fr-FR',
      isAvailable: true,
      availabilityStatus: 'available' as const,
      minOrderQuantity: 1,
      title: 'Nettoyant FR',
      description: 'Desc FR',
      slug: 'nettoyant-fr-sds',
      isCompliant: true,
      clpWarnings: [],
      sdsUrl: 'http://insecure.example.com/sds.pdf' // must be https
    }

    await expect(
      executeMarketCatalogCommand(f.database, CLAIMS, productId, commandId1, invalidSds, options)
    ).rejects.toThrowError(new MarketCatalogError('invalid_input'))
  })

  it('updates market availability status to restricted with restriction reason', async () => {
    const payload1 = {
      action: 'configure' as const,
      expectedVersion: 0,
      marketCode: 'FR',
      locale: 'fr-FR',
      isAvailable: true,
      availabilityStatus: 'available' as const,
      minOrderQuantity: 1,
      title: 'Nettoyant FR',
      description: 'Desc FR',
      slug: 'nettoyant-fr-restricted',
      isCompliant: true,
      clpWarnings: []
    }
    await executeMarketCatalogCommand(f.database, CLAIMS, productId, commandId1, payload1, options)

    const payload2 = {
      action: 'set_availability' as const,
      expectedVersion: 1,
      marketCode: 'FR',
      locale: 'fr-FR',
      isAvailable: false,
      availabilityStatus: 'restricted' as const,
      restrictionReason: 'Requires professional applicator certificate in France',
      minOrderQuantity: 1,
      title: 'Nettoyant FR',
      description: 'Desc FR',
      slug: 'nettoyant-fr-restricted',
      isCompliant: true,
      clpWarnings: []
    }
    const updateRes = await executeMarketCatalogCommand(f.database, CLAIMS, productId, commandId2, payload2, options)
    expect(updateRes.version).toBe(2)

    const configs = await readProductMarketConfigs(f.database, productId)
    expect(configs[0]).toMatchObject({
      marketCode: 'FR',
      isAvailable: 0,
      availabilityStatus: 'restricted',
      restrictionReason: 'Requires professional applicator certificate in France'
    })
  })
})
