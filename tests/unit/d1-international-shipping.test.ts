import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import {
  configureInternationalShippingPolicy,
  evaluateInternationalShipping,
  readInternationalShippingPolicy
} from '../../workers/fulfillment/international-shipping'
import { seedDefaultMarkets } from '../../workers/catalog/market-catalog'
import { InternationalShippingError } from '../../shared/catalog-markets'

const MIGRATION_PATH = 'db/d1/migrations/0120_market_catalog_international_shipping.sql'
const options = { now: () => utc() }

describe('SHP-031: Envío internacional/restricciones por país', () => {
  let f: Awaited<ReturnType<typeof returnsFixture>>
  const commandId1 = '33333333-3333-4333-8333-333333333333'
  const commandId2 = '44444444-4444-4444-8444-444444444444'

  beforeEach(async () => {
    f = await returnsFixture()
    f.sqlite.exec(await readFile(MIGRATION_PATH, 'utf8'))
    await seedDefaultMarkets(f.database, options)
  })

  afterEach(() => {
    f?.sqlite.close()
  })

  it('configures duties, documentation, chemical restrictions, and returns per market', async () => {
    const policy = {
      marketCode: 'GB',
      expectedVersion: 0,
      customsDeclaredValueRequired: true,
      dutyCollectionType: 'ddp' as const,
      hsTariffCodeRequired: true,
      deMinimisThresholdCents: 15000, // 150 EUR
      estimatedDutyRateBps: 650, // 6.5%
      customsHandlingFeeCents: 1200, // 12 EUR
      requiredDocuments: ['commercial_invoice', 'export_declaration', 'sds_destination_language'],
      customsDeclarationNotes: 'UK border declaration required with EORI',
      adrAllowed: true,
      maxHazardClass: 'limited_quantity_only' as const,
      prohibitedUnNumbers: ['UN1760', 'UN1791'],
      maxDangerousGoodsVolumeLiters: 20,
      requiresSpecialAdrCarrier: true,
      returnsPermitted: true,
      returnWindowDays: 14,
      hazardousReturnsAllowed: false,
      returnCarrierCode: 'dhl_express_uk',
      customerReturnFeeCents: 2500,
      returnPolicyNotes: 'Dangerous goods cannot be returned via post; contact support.'
    }

    const result = await configureInternationalShippingPolicy(f.database, CLAIMS, commandId1, policy, options)
    expect(result).toMatchObject({
      commandId: commandId1,
      marketCode: 'GB',
      version: 1
    })

    const readBack = await readInternationalShippingPolicy(f.database, 'GB')
    expect(readBack).toMatchObject({
      marketCode: 'GB',
      dutyCollectionType: 'ddp',
      adrAllowed: 1,
      maxHazardClass: 'limited_quantity_only',
      hazardousReturnsAllowed: 0,
      returnWindowDays: 14
    })
    expect(readBack?.requiredDocuments).toEqual(['commercial_invoice', 'export_declaration', 'sds_destination_language'])
    expect(readBack?.prohibitedUnNumbers).toEqual(['UN1760', 'UN1791'])
  })

  it('evaluates international shipment with duty calculation and document requirements', async () => {
    // Configure GB policy
    await configureInternationalShippingPolicy(
      f.database,
      CLAIMS,
      commandId1,
      {
        marketCode: 'GB',
        expectedVersion: 0,
        customsDeclaredValueRequired: true,
        dutyCollectionType: 'ddp',
        hsTariffCodeRequired: true,
        deMinimisThresholdCents: 15000, // 150 EUR
        estimatedDutyRateBps: 650, // 6.5%
        customsHandlingFeeCents: 1000,
        requiredDocuments: ['commercial_invoice', 'export_declaration'],
        adrAllowed: true,
        maxHazardClass: 'limited_quantity_only',
        prohibitedUnNumbers: [],
        maxDangerousGoodsVolumeLiters: 25,
        requiresSpecialAdrCarrier: false,
        returnsPermitted: true,
        returnWindowDays: 30,
        hazardousReturnsAllowed: false,
        customerReturnFeeCents: 1500
      },
      options
    )

    // Order with value 200 EUR (20000 cents > 150 EUR de minimis)
    const evaluation = await evaluateInternationalShipping(f.database, {
      marketCode: 'GB',
      declaredValueCents: 20000,
      items: [
        {
          variantId: 'v-1-1',
          quantity: 2,
          isDangerousGoods: false,
          weightGrams: 2000,
          valueCents: 20000
        }
      ]
    })

    expect(evaluation.allowed).toBe(true)
    expect(evaluation.duties).toMatchObject({
      declaredValueRequired: true,
      dutyCollectionType: 'ddp',
      exceedsDeMinimis: true,
      estimatedDutyCents: 1300, // 20000 * 6.5% = 1300 cents
      customsHandlingFeeCents: 1000,
      totalCustomsFeesCents: 2300
    })
    expect(evaluation.documentation.requiredDocuments).toEqual(['commercial_invoice', 'export_declaration'])
    expect(evaluation.returns).toMatchObject({
      returnsPermitted: true,
      returnWindowDays: 30,
      hazardousReturnsAllowed: false
    })
  })

  it('exempts duty calculation below de minimis threshold', async () => {
    await configureInternationalShippingPolicy(
      f.database,
      CLAIMS,
      commandId1,
      {
        marketCode: 'GB',
        expectedVersion: 0,
        customsDeclaredValueRequired: true,
        dutyCollectionType: 'ddp',
        deMinimisThresholdCents: 15000,
        estimatedDutyRateBps: 650,
        customsHandlingFeeCents: 1000,
        requiredDocuments: ['commercial_invoice'],
        adrAllowed: true,
        maxHazardClass: 'unrestricted',
        prohibitedUnNumbers: [],
        maxDangerousGoodsVolumeLiters: 100,
        requiresSpecialAdrCarrier: false,
        returnsPermitted: true,
        returnWindowDays: 14,
        hazardousReturnsAllowed: false,
        customerReturnFeeCents: 0
      },
      options
    )

    // Order with value 100 EUR (10000 cents < 15000 cents)
    const evaluation = await evaluateInternationalShipping(f.database, {
      marketCode: 'GB',
      declaredValueCents: 10000,
      items: [{ variantId: 'v-1-1', quantity: 1, isDangerousGoods: false, weightGrams: 1000, valueCents: 10000 }]
    })

    expect(evaluation.allowed).toBe(true)
    expect(evaluation.duties.exceedsDeMinimis).toBe(false)
    expect(evaluation.duties.estimatedDutyCents).toBe(0)
    expect(evaluation.duties.totalCustomsFeesCents).toBe(1000) // handling fee still applies
  })

  it('blocks shipment when destination country prohibits ADR dangerous goods', async () => {
    // Market CH prohibits ADR chemical shipments in this configuration
    await configureInternationalShippingPolicy(
      f.database,
      CLAIMS,
      commandId1,
      {
        marketCode: 'CH',
        expectedVersion: 0,
        customsDeclaredValueRequired: true,
        dutyCollectionType: 'dap',
        deMinimisThresholdCents: 6000,
        estimatedDutyRateBps: 500,
        customsHandlingFeeCents: 1500,
        requiredDocuments: ['commercial_invoice'],
        adrAllowed: false, // ADR prohibited
        maxHazardClass: 'none',
        prohibitedUnNumbers: [],
        maxDangerousGoodsVolumeLiters: 0,
        requiresSpecialAdrCarrier: false,
        returnsPermitted: false,
        returnWindowDays: 0,
        hazardousReturnsAllowed: false,
        customerReturnFeeCents: 0
      },
      options
    )

    const evaluation = await evaluateInternationalShipping(f.database, {
      marketCode: 'CH',
      declaredValueCents: 5000,
      items: [
        {
          variantId: 'v-1-1',
          quantity: 1,
          isDangerousGoods: true,
          unNumber: 'UN1824',
          hazardClass: 'class_8',
          volumeLiters: 5,
          weightGrams: 5000,
          valueCents: 5000
        }
      ]
    })

    expect(evaluation.allowed).toBe(false)
    expect(evaluation.blockReason).toBe('adr_not_allowed_in_market')
    expect(evaluation.violations).toContain('Dangerous goods (ADR) transport is prohibited to destination market CH.')
  })

  it('blocks shipment containing specific prohibited chemical UN numbers', async () => {
    await configureInternationalShippingPolicy(
      f.database,
      CLAIMS,
      commandId1,
      {
        marketCode: 'PT',
        expectedVersion: 0,
        customsDeclaredValueRequired: false,
        dutyCollectionType: 'exempt',
        deMinimisThresholdCents: 0,
        estimatedDutyRateBps: 0,
        customsHandlingFeeCents: 0,
        requiredDocuments: [],
        adrAllowed: true,
        maxHazardClass: 'unrestricted',
        prohibitedUnNumbers: ['UN1791'], // Hypochlorite solution prohibited
        maxDangerousGoodsVolumeLiters: 100,
        requiresSpecialAdrCarrier: false,
        returnsPermitted: true,
        returnWindowDays: 14,
        hazardousReturnsAllowed: false,
        customerReturnFeeCents: 0
      },
      options
    )

    const evaluation = await evaluateInternationalShipping(f.database, {
      marketCode: 'PT',
      declaredValueCents: 4000,
      items: [
        {
          variantId: 'v-1-1',
          quantity: 2,
          isDangerousGoods: true,
          unNumber: 'UN1791',
          hazardClass: 'class_8',
          volumeLiters: 10,
          weightGrams: 10000,
          valueCents: 4000
        }
      ]
    })

    expect(evaluation.allowed).toBe(false)
    expect(evaluation.blockReason).toBe('prohibited_chemical_un_number')
    expect(evaluation.violations[0]).toContain('UN1791')
  })

  it('blocks shipment when total dangerous goods volume exceeds destination limit', async () => {
    await configureInternationalShippingPolicy(
      f.database,
      CLAIMS,
      commandId1,
      {
        marketCode: 'FR',
        expectedVersion: 0,
        customsDeclaredValueRequired: false,
        dutyCollectionType: 'exempt',
        deMinimisThresholdCents: 0,
        estimatedDutyRateBps: 0,
        customsHandlingFeeCents: 0,
        requiredDocuments: [],
        adrAllowed: true,
        maxHazardClass: 'unrestricted',
        prohibitedUnNumbers: [],
        maxDangerousGoodsVolumeLiters: 30, // 30L limit
        requiresSpecialAdrCarrier: false,
        returnsPermitted: true,
        returnWindowDays: 14,
        hazardousReturnsAllowed: false,
        customerReturnFeeCents: 0
      },
      options
    )

    const evaluation = await evaluateInternationalShipping(f.database, {
      marketCode: 'FR',
      declaredValueCents: 8000,
      items: [
        {
          variantId: 'v-1-1',
          quantity: 4,
          isDangerousGoods: true,
          unNumber: 'UN1263',
          hazardClass: 'class_3',
          volumeLiters: 40, // 40L > 30L limit
          weightGrams: 40000,
          valueCents: 8000
        }
      ]
    })

    expect(evaluation.allowed).toBe(false)
    expect(evaluation.blockReason).toBe('dangerous_goods_volume_limit_exceeded')
  })

  it('denies policy modification to non-admin actors', async () => {
    const policy = {
      marketCode: 'FR',
      expectedVersion: 0,
      customsDeclaredValueRequired: false,
      dutyCollectionType: 'exempt' as const,
      adrAllowed: true,
      maxHazardClass: 'unrestricted' as const,
      prohibitedUnNumbers: [],
      maxDangerousGoodsVolumeLiters: 50,
      requiresSpecialAdrCarrier: false,
      returnsPermitted: true,
      returnWindowDays: 14,
      hazardousReturnsAllowed: false,
      customerReturnFeeCents: 0
    }

    await expect(
      configureInternationalShippingPolicy(f.database, BUYER_CLAIMS, commandId1, policy, options)
    ).rejects.toThrowError(InternationalShippingError)
  })
})
