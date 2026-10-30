import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bvFixture, CLAIMS, ID, utc } from './bv-fixture'
import { evaluateLimitedQuantityLine, parseLimitedQuantity, type AdrLineFacts } from '../../shared/adr-limited-quantity'
import {
  evaluateAdrShipment,
  getHazardInfo,
  getSpecialistValidation,
  listCarrierRestrictions,
  recordSpecialistValidation,
  setCarrierRestriction
} from '../../workers/fulfillment/adr-limited-quantity'
import { upsertVariantAdrSpec } from '../../workers/fulfillment/warehouse-adr-assets'

const options = { now: () => utc() }

const validFacts = (over: Partial<AdrLineFacts> = {}): AdrLineFacts => ({
  variantId: 'v-1-1',
  quantity: 12,
  carrierCode: 'seur',
  spec: {
    version: 1,
    unNumber: 'UN 1993',
    properShippingName: 'LIQUIDO INFLAMABLE, N.E.P.',
    adrClass: '3',
    packingGroup: 'II',
    limitedQuantity: '1 L',
    pictograms: ['GHS02', 'GHS07'],
    signalWord: 'PELIGRO',
    hazardStatements: ['H225', 'H319'],
    precautionaryStatements: ['P210'],
    ufiCode: 'UFI-1234-5678-ABCD',
    sdsVersion: '3.2'
  },
  validation: {
    version: 1,
    specVersion: 1,
    status: 'validated',
    contentUnit: 'ml',
    innerContentAmount: 500,
    unitsPerOuter: 6,
    outerGrossGrams: 4200,
    grossLimitGrams: 30000,
    specialistName: 'Marta DGSA',
    certificateRef: 'DGSA-ES-0042'
  },
  carrierRules: [{ adrClass: '3', packingGroup: 'II', allowsLimitedQuantity: true, maxGrossGramsPerPackage: 20000 }],
  ...over
})

const blockers = (facts: AdrLineFacts) => evaluateLimitedQuantityLine(facts).blockers

describe('SHP-029 limited quantity code parsing', () => {
  it.each([
    ['1 L', { contentUnit: 'ml', limit: 1000 }],
    ['5 L', { contentUnit: 'ml', limit: 5000 }],
    ['500 ml', { contentUnit: 'ml', limit: 500 }],
    ['1 kg', { contentUnit: 'g', limit: 1000 }],
    ['120 g', { contentUnit: 'g', limit: 120 }],
    ['0,5 L', { contentUnit: 'ml', limit: 500 }],
    ['0', 'not_permitted'],
    ['', 'invalid'],
    ['mucho', 'invalid'],
    ['5 gallons', 'invalid'],
    ['-1 L', 'invalid']
  ])('parses %j', (text, expected) => {
    expect(parseLimitedQuantity(text)).toEqual(expected)
  })
})

describe('SHP-029 limited-quantity line evaluation (pure)', () => {
  it('allows a fully validated limited-quantity line and reports packages and labelling', () => {
    const result = evaluateLimitedQuantityLine(validFacts())
    expect(result).toMatchObject({ allowed: true, blockers: [], packagesRequired: 2 })
    expect(result.labeling).toMatchObject({
      limitedQuantityMarkRequired: true,
      specialistCertificateRef: 'DGSA-ES-0042'
    })
    expect(result.hazard).toMatchObject({ classified: true, unNumber: 'UN 1993', adrClass: '3', packingGroup: 'II' })
  })

  it('blocks and never guesses when the ADR sheet is missing, still reporting it as unclassified', () => {
    const result = evaluateLimitedQuantityLine(validFacts({ spec: null, validation: null }))
    expect(result.allowed).toBe(false)
    expect(result.blockers).toEqual(['adr_data_missing'])
    expect(result.hazard).toMatchObject({ classified: false })
  })

  it.each([
    ['dangerous class without packing group', { adrClass: '8', packingGroup: 'NONE' }],
    ['dangerous class without UN number', { unNumber: 'NONE' }],
    ['non-dangerous class that still carries a UN number', { adrClass: 'NONE', packingGroup: 'NONE' }],
    ['non-dangerous class that still carries a packing group', { adrClass: 'NONE', unNumber: 'NONE' }]
  ])('blocks incoherent classification: %s', (_name, over) => {
    const base = validFacts()
    expect(blockers({ ...base, spec: { ...base.spec!, ...over } })).toContain('adr_data_incomplete')
  })

  it('accepts class 9 without a packing group and a declared non-dangerous product once validated', () => {
    const base = validFacts()
    expect(
      blockers({
        ...base,
        spec: { ...base.spec!, adrClass: '9', packingGroup: 'NONE', unNumber: 'UN 3082', limitedQuantity: '5 L' },
        carrierRules: [
          { adrClass: '9', packingGroup: 'NONE', allowsLimitedQuantity: true, maxGrossGramsPerPackage: 20000 }
        ]
      })
    ).toEqual([])
    const none = evaluateLimitedQuantityLine({
      ...base,
      spec: {
        ...base.spec!,
        adrClass: 'NONE',
        packingGroup: 'NONE',
        unNumber: 'NONE',
        hazardStatements: [],
        pictograms: [],
        signalWord: 'NONE'
      },
      carrierRules: []
    })
    expect(none.allowed).toBe(true)
    expect(none.labeling).toBeNull()
  })

  it('keeps chemical hazard information in every outcome, even when blocked', () => {
    const base = validFacts()
    for (const facts of [
      { ...base, validation: null },
      { ...base, carrierRules: [] },
      { ...base, quantity: 0 }
    ]) {
      const result = evaluateLimitedQuantityLine(facts)
      expect(result.allowed).toBe(false)
      expect(result.hazard).toMatchObject({
        classified: true,
        hazardStatements: ['H225', 'H319'],
        signalWord: 'PELIGRO',
        pictograms: ['GHS02', 'GHS07']
      })
    }
  })

  it('blocks a dangerous product that lacks pictograms, signal word or hazard statements', () => {
    const base = validFacts()
    for (const over of [{ pictograms: [] }, { hazardStatements: [] }, { signalWord: 'NONE' as const }])
      expect(blockers({ ...base, spec: { ...base.spec!, ...over } })).toContain('hazard_info_missing')
  })

  it('requires a specialist validation that is current and positive', () => {
    const base = validFacts()
    expect(blockers({ ...base, validation: null })).toEqual(['specialist_validation_missing'])
    expect(blockers({ ...base, validation: { ...base.validation!, specVersion: 0 } })).toEqual([
      'specialist_validation_stale'
    ])
    expect(blockers({ ...base, spec: { ...base.spec!, version: 2 } })).toEqual(['specialist_validation_stale'])
    expect(blockers({ ...base, validation: { ...base.validation!, status: 'rejected' } })).toEqual([
      'specialist_validation_rejected'
    ])
  })

  it('blocks codes where limited quantity is not permitted or cannot be read', () => {
    const base = validFacts()
    expect(blockers({ ...base, spec: { ...base.spec!, limitedQuantity: '0' } })).toEqual(['lq_not_permitted'])
    expect(blockers({ ...base, spec: { ...base.spec!, limitedQuantity: '??' } })).toEqual(['lq_code_invalid'])
  })

  it('blocks inner packaging above the code limit, a unit mismatch and an overweight outer package', () => {
    const base = validFacts()
    expect(blockers({ ...base, validation: { ...base.validation!, innerContentAmount: 1001 } })).toEqual([
      'lq_inner_limit_exceeded'
    ])
    expect(blockers({ ...base, validation: { ...base.validation!, contentUnit: 'g' } })).toEqual(['lq_unit_mismatch'])
    expect(
      blockers({ ...base, validation: { ...base.validation!, outerGrossGrams: 30001, grossLimitGrams: 30000 } })
    ).toContain('lq_gross_limit_exceeded')
  })

  it('blocks when the carrier is unknown, has no rule for the class, forbids LQ or caps the weight', () => {
    const base = validFacts()
    expect(blockers({ ...base, carrierRules: [] })).toEqual(['carrier_unknown'])
    expect(
      blockers({
        ...base,
        carrierRules: [
          { adrClass: '8', packingGroup: 'II', allowsLimitedQuantity: true, maxGrossGramsPerPackage: 20000 }
        ]
      })
    ).toEqual(['carrier_rule_missing'])
    expect(
      blockers({
        ...base,
        carrierRules: [
          { adrClass: '3', packingGroup: 'II', allowsLimitedQuantity: false, maxGrossGramsPerPackage: null }
        ]
      })
    ).toEqual(['carrier_prohibits_limited_quantity'])
    expect(
      blockers({
        ...base,
        carrierRules: [
          { adrClass: '3', packingGroup: 'II', allowsLimitedQuantity: true, maxGrossGramsPerPackage: 4000 }
        ]
      })
    ).toEqual(['carrier_package_weight_exceeded'])
  })

  it('blocks non-positive, fractional and absurd quantities', () => {
    for (const quantity of [0, -1, 1.5, 100_001, Number.NaN])
      expect(blockers(validFacts({ quantity }))).toContain('invalid_quantity')
  })

  it('collects every blocker instead of stopping at the first', () => {
    const base = validFacts()
    expect(blockers({ ...base, validation: null, carrierRules: [] })).toEqual([
      'specialist_validation_missing',
      'carrier_unknown'
    ])
  })
})

describe('SHP-029 ADR limited quantities (D1)', () => {
  let f: Awaited<ReturnType<typeof bvFixture>>
  beforeEach(async () => {
    f = await bvFixture()
  })
  afterEach(() => f.sqlite.close())

  let n = 300
  const spec = (over: Record<string, unknown> = {}) =>
    upsertVariantAdrSpec(
      f.database,
      CLAIMS,
      {
        commandId: ID(++n),
        variantId: 'v-1-1',
        unNumber: 'UN 1993',
        properShippingName: 'LIQUIDO INFLAMABLE, N.E.P.',
        adrClass: '3',
        packingGroup: 'II',
        tunnelCode: '(D/E)',
        limitedQuantity: '1 L',
        adrPointsFactor: 3,
        pictograms: ['GHS02', 'GHS07'],
        signalWord: 'PELIGRO',
        hazardStatements: ['H225', 'H319'],
        precautionaryStatements: ['P210'],
        ufiCode: null,
        handlingInstructions: ['Mantener alejado del calor'],
        sdsVersion: '3.2',
        ...over
      } as Parameters<typeof upsertVariantAdrSpec>[2],
      utc()
    )
  const validation = (over: Record<string, unknown> = {}, id = ID(++n)) =>
    recordSpecialistValidation(
      f.database,
      CLAIMS,
      id,
      {
        variantId: 'v-1-1',
        specVersion: 1,
        status: 'validated',
        specialistName: 'Marta DGSA',
        certificateRef: 'DGSA-ES-0042',
        contentUnit: 'ml',
        innerContentAmount: 500,
        unitsPerOuter: 6,
        outerGrossGrams: 4200,
        grossLimitGrams: 30000,
        ...over
      },
      options
    )
  const carrier = (over: Record<string, unknown> = {}, id = ID(++n)) =>
    setCarrierRestriction(
      f.database,
      CLAIMS,
      id,
      {
        carrierCode: 'seur',
        adrClass: '3',
        packingGroup: 'II',
        allowsLimitedQuantity: true,
        maxGrossGramsPerPackage: 20000,
        expectedVersion: 0,
        ...over
      },
      options
    )
  const evaluate = (lines = [{ variantId: 'v-1-1', quantity: 12 }], carrierCode = 'seur') =>
    evaluateAdrShipment(f.database, { carrierCode, lines }, options)

  async function readyToShip() {
    await spec()
    await validation()
    await carrier()
  }

  it('allows a shipment only when spec, specialist validation and carrier rule are all in place', async () => {
    await readyToShip()
    const result = await evaluate()
    expect(result.allowed).toBe(true)
    expect(result.lines[0]).toMatchObject({ variantId: 'v-1-1', allowed: true, packagesRequired: 2 })
  })

  it('blocks a variant with no ADR sheet and surfaces it as unclassified', async () => {
    const result = await evaluate()
    expect(result.allowed).toBe(false)
    expect(result.lines[0]).toMatchObject({ blockers: ['adr_data_missing'], hazard: { classified: false } })
  })

  it('walks each missing piece, in order, until the shipment is allowed', async () => {
    await spec()
    expect((await evaluate()).lines[0]!.blockers).toEqual(['specialist_validation_missing', 'carrier_unknown'])
    await validation()
    expect((await evaluate()).lines[0]!.blockers).toEqual(['carrier_unknown'])
    await carrier({ carrierCode: 'seur', adrClass: '8', packingGroup: 'II' })
    expect((await evaluate()).lines[0]!.blockers).toEqual(['carrier_rule_missing'])
    await carrier()
    expect((await evaluate()).allowed).toBe(true)
  })

  it('invalidates the specialist validation when the ADR sheet changes', async () => {
    await readyToShip()
    await spec({ properShippingName: 'LIQUIDO INFLAMABLE, N.E.P. (mezcla)' })
    const result = await evaluate()
    expect(result.allowed).toBe(false)
    expect(result.lines[0]!.blockers).toEqual(['specialist_validation_stale'])
    await validation({ specVersion: 2 })
    expect((await evaluate()).allowed).toBe(true)
  })

  it('uses the latest specialist verdict: a later rejection blocks again', async () => {
    await readyToShip()
    await validation({ status: 'rejected', rejectionReason: 'Embalaje interior no homologado' })
    expect((await evaluate()).lines[0]!.blockers).toEqual(['specialist_validation_rejected'])
    expect(await getSpecialistValidation(f.database, 'v-1-1')).toMatchObject({ version: 2, status: 'rejected' })
  })

  it('evaluates several lines in one pass and blocks the whole shipment if one line is blocked', async () => {
    await readyToShip()
    const result = await evaluate([
      { variantId: 'v-1-1', quantity: 1 },
      { variantId: 'v-2-1', quantity: 1 }
    ])
    expect(result.allowed).toBe(false)
    expect(result.blockers).toEqual([{ variantId: 'v-2-1', code: 'adr_data_missing' }])
    expect(result.lines.map((l) => l.allowed)).toEqual([true, false])
  })

  it('rejects malformed shipments: empty, duplicated variants, unknown variants, bad carrier codes, too many lines', async () => {
    await expect(evaluate([])).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      evaluate([
        { variantId: 'v-1-1', quantity: 1 },
        { variantId: 'v-1-1', quantity: 2 }
      ])
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(evaluate([{ variantId: 'nope', quantity: 1 }])).rejects.toMatchObject({ code: 'not_found' })
    await expect(evaluate(undefined, 'SEUR; DROP')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      evaluate(Array.from({ length: 101 }, (_, i) => ({ variantId: `v-${i}`, quantity: 1 })))
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('blocks instead of throwing for a quantity that is not a safe positive integer', async () => {
    await readyToShip()
    const result = await evaluate([{ variantId: 'v-1-1', quantity: 0 }])
    expect(result.lines[0]!.blockers).toContain('invalid_quantity')
  })

  describe('hazard information', () => {
    it('is returned in full for a classified variant', async () => {
      await spec()
      expect(await getHazardInfo(f.database, 'v-1-1')).toMatchObject({
        variantId: 'v-1-1',
        classified: true,
        signalWord: 'PELIGRO',
        pictograms: ['GHS02', 'GHS07'],
        hazardStatements: ['H225', 'H319'],
        sdsVersion: '3.2'
      })
    })
    it('says "unclassified" for a variant without data and 404s unknown variants', async () => {
      expect(await getHazardInfo(f.database, 'v-1-1')).toMatchObject({ classified: false, hazardStatements: [] })
      await expect(getHazardInfo(f.database, 'nope')).rejects.toMatchObject({ code: 'not_found' })
      await expect(getHazardInfo(f.database, '')).rejects.toMatchObject({ code: 'invalid_input' })
    })
  })

  describe('recordSpecialistValidation', () => {
    it('requires an existing ADR sheet at exactly the validated version', async () => {
      await expect(validation()).rejects.toMatchObject({ code: 'not_found' })
      await spec()
      await expect(validation({ specVersion: 2 })).rejects.toMatchObject({ code: 'conflict' })
      expect(await validation()).toMatchObject({ version: 1, specVersion: 1, status: 'validated' })
    })

    it('is idempotent for the same command and rejects a replay with a different payload', async () => {
      await spec()
      const id = ID(980)
      const first = await validation({}, id)
      expect(await validation({}, id)).toEqual(first)
      await expect(validation({ innerContentAmount: 250 }, id)).rejects.toMatchObject({ code: 'conflict' })
    })

    it('rejects invalid figures and demands a reason for a rejection', async () => {
      await spec()
      for (const bad of [
        { innerContentAmount: 0 },
        { unitsPerOuter: 1.5 },
        { grossLimitGrams: 30001 },
        { outerGrossGrams: 30000, grossLimitGrams: 20000 },
        { contentUnit: 'oz' },
        { specialistName: 'x' },
        { certificateRef: '' },
        { status: 'maybe' },
        { status: 'rejected' },
        { unexpected: true }
      ])
        await expect(validation(bad)).rejects.toMatchObject({ code: 'invalid_input' })
    })

    it('requires a live MFA administrator', async () => {
      await spec()
      const body = {
        variantId: 'v-1-1',
        specVersion: 1,
        status: 'validated',
        specialistName: 'Marta DGSA',
        certificateRef: 'DGSA-ES-0042',
        contentUnit: 'ml',
        innerContentAmount: 500,
        unitsPerOuter: 6,
        outerGrossGrams: 4200,
        grossLimitGrams: 30000
      }
      await expect(recordSpecialistValidation(f.database, null, ID(1), body, options)).rejects.toMatchObject({
        code: 'unauthenticated'
      })
      await expect(recordSpecialistValidation(f.database, f.plainClaims, ID(2), body, options)).rejects.toMatchObject({
        code: 'forbidden'
      })
      f.sqlite.exec(`UPDATE auth_sessions SET mfa_verified = 0 WHERE id = '${CLAIMS.sessionId}'`)
      await expect(validation()).rejects.toMatchObject({ code: 'forbidden' })
    })

    it('keeps the history append-only and rejects a spec changing under the validation', async () => {
      await spec()
      await validation()
      expect(() => f.sqlite.exec('DELETE FROM adr_specialist_validations')).toThrow(/immutable/)
      expect(() => f.sqlite.exec("UPDATE adr_specialist_validations SET status='rejected'")).toThrow(/immutable/)
      expect(() => f.sqlite.exec('DELETE FROM adr_lq_commands')).toThrow(/immutable/)
    })
  })

  describe('setCarrierRestriction', () => {
    it('creates and updates rules with CAS and lists them', async () => {
      expect(await carrier()).toMatchObject({ version: 1 })
      await expect(carrier({ expectedVersion: 0 })).rejects.toMatchObject({ code: 'conflict' })
      expect(
        await carrier({ expectedVersion: 1, allowsLimitedQuantity: false, maxGrossGramsPerPackage: null })
      ).toMatchObject({ version: 2 })
      const rules = await listCarrierRestrictions(f.database, 'seur')
      expect(rules).toEqual([
        expect.objectContaining({ adrClass: '3', packingGroup: 'II', allowsLimitedQuantity: false, version: 2 })
      ])
    })

    it('forbids a rule that allows LQ without a package weight cap and malformed codes', async () => {
      for (const bad of [
        { maxGrossGramsPerPackage: null },
        { maxGrossGramsPerPackage: 30001 },
        { carrierCode: 'SEUR!' },
        { carrierCode: 'x' },
        { adrClass: '7' },
        { packingGroup: 'IV' },
        { expectedVersion: -1 },
        { documentationNote: 'x'.repeat(501) }
      ])
        await expect(carrier(bad)).rejects.toMatchObject({ code: 'invalid_input' })
    })

    it('is idempotent per command and conflicts on a changed replay', async () => {
      const id = ID(970)
      const first = await carrier({}, id)
      expect(await carrier({}, id)).toEqual(first)
      await expect(carrier({ maxGrossGramsPerPackage: 100 }, id)).rejects.toMatchObject({ code: 'conflict' })
    })

    it('requires a live MFA administrator', async () => {
      const body = {
        carrierCode: 'seur',
        adrClass: '3',
        packingGroup: 'II',
        allowsLimitedQuantity: true,
        maxGrossGramsPerPackage: 1000,
        expectedVersion: 0
      }
      await expect(setCarrierRestriction(f.database, null, ID(1), body, options)).rejects.toMatchObject({
        code: 'unauthenticated'
      })
      await expect(setCarrierRestriction(f.database, f.plainClaims, ID(2), body, options)).rejects.toMatchObject({
        code: 'forbidden'
      })
    })

    it('does not leak one carrier rules to another carrier', async () => {
      await readyToShip()
      expect((await evaluate(undefined, 'correos')).lines[0]!.blockers).toEqual(['carrier_unknown'])
    })
  })
})
