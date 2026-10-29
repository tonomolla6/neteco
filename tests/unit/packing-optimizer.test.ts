import { describe, expect, it } from 'vitest'
import {
  PackingOptimizerError,
  PACKING_ALGORITHM_VERSION,
  optimizePacking,
  toOrderPackingParcels,
  verifyPackingPlan,
  type BoxType,
  type PackingContext,
  type ProductProfile
} from '../../shared/packing-optimizer'
import { packingParcelSchema } from '../../shared/order-packing'

const boxes: BoxType[] = [
  {
    code: 'L',
    name: 'Grande',
    widthMm: 600,
    heightMm: 400,
    depthMm: 400,
    tareGrams: 800,
    maxWeightGrams: 25000,
    hazmatAllowed: true,
    active: true
  },
  {
    code: 'S',
    name: 'Pequena',
    widthMm: 200,
    heightMm: 150,
    depthMm: 150,
    tareGrams: 150,
    maxWeightGrams: 5000,
    hazmatAllowed: true,
    active: true
  },
  {
    code: 'M',
    name: 'Mediana',
    widthMm: 400,
    heightMm: 300,
    depthMm: 300,
    tareGrams: 400,
    maxWeightGrams: 15000,
    hazmatAllowed: true,
    active: true
  },
  {
    code: 'X',
    name: 'Sin ADR',
    widthMm: 100,
    heightMm: 100,
    depthMm: 100,
    tareGrams: 50,
    maxWeightGrams: 2000,
    hazmatAllowed: false,
    active: true
  }
]
const profile = (
  sku: string,
  w: number,
  h: number,
  d: number,
  g: number,
  hazardClass: ProductProfile['hazardClass'] = 'none'
): ProductProfile => ({
  sku,
  weightGrams: g,
  widthMm: w,
  heightMm: h,
  depthMm: d,
  hazardClass
})
const profiles: ProductProfile[] = [
  profile('SOAP-1L', 80, 200, 80, 1100),
  profile('BLEACH-5L', 150, 280, 150, 5200, 'oxidizer'),
  profile('ACID-1L', 80, 220, 80, 1200, 'corrosive'),
  profile('FLAM-1L', 80, 220, 80, 900, 'flammable'),
  profile('PAD', 20, 20, 20, 30),
  profile('DRUM', 520, 340, 340, 20000),
  profile('HUGE', 900, 900, 900, 500),
  profile('LEAD', 100, 100, 100, 30000)
]
const incompatibilities = [
  { classA: 'corrosive' as const, classB: 'oxidizer' as const },
  { classA: 'flammable' as const, classB: 'oxidizer' as const },
  { classA: 'corrosive' as const, classB: 'flammable' as const }
]
const ctx = (extra: Partial<PackingContext> = {}): PackingContext => ({ boxes, profiles, incompatibilities, ...extra })

describe('SHP-030 packing optimiser (pure algorithm)', () => {
  it('packs one small item in the smallest box that fits', () => {
    const plan = optimizePacking(
      { lines: [{ sku: 'PAD', quantity: 1 }] },
      ctx({ boxes: boxes.filter((b) => b.code !== 'X') })
    )
    expect(plan.algorithmVersion).toBe(PACKING_ALGORITHM_VERSION)
    expect(plan.parcels).toHaveLength(1)
    expect(plan.parcels[0]!.boxCode).toBe('S')
    expect(plan.parcels[0]!.grossWeightGrams).toBe(180)
  })

  it('groups many compatible units into the fewest parcels and reports totals', () => {
    const plan = optimizePacking({ lines: [{ sku: 'SOAP-1L', quantity: 8 }] }, ctx())
    expect(plan.parcels.length).toBeLessThanOrEqual(2)
    const units = plan.parcels.flatMap((p) => p.contents).reduce((n, c) => n + c.quantity, 0)
    expect(units).toBe(8)
    expect(plan.totals.parcelCount).toBe(plan.parcels.length)
    expect(plan.totals.netWeightGrams).toBe(8 * 1100)
    expect(verifyPackingPlan(plan, { lines: [{ sku: 'SOAP-1L', quantity: 8 }] }, ctx())).toEqual([])
  })

  it('never places incompatible hazard classes in the same parcel', () => {
    const lines = [
      { sku: 'BLEACH-5L', quantity: 1 },
      { sku: 'ACID-1L', quantity: 2 },
      { sku: 'FLAM-1L', quantity: 1 }
    ]
    const plan = optimizePacking({ lines }, ctx())
    for (const parcel of plan.parcels) {
      const classes = new Set(parcel.hazardClasses)
      expect(classes.has('oxidizer') && classes.has('corrosive')).toBe(false)
      expect(classes.has('oxidizer') && classes.has('flammable')).toBe(false)
      expect(classes.has('corrosive') && classes.has('flammable')).toBe(false)
    }
    expect(plan.parcels.length).toBe(3)
    expect(verifyPackingPlan(plan, { lines }, ctx())).toEqual([])
  })

  it('allows an inert product to share a parcel with any hazard class', () => {
    const plan = optimizePacking(
      {
        lines: [
          { sku: 'BLEACH-5L', quantity: 1 },
          { sku: 'PAD', quantity: 3 }
        ]
      },
      ctx()
    )
    expect(plan.parcels).toHaveLength(1)
  })

  it('honours a same-class incompatibility rule (class with itself)', () => {
    const plan = optimizePacking(
      { lines: [{ sku: 'FLAM-1L', quantity: 2 }] },
      ctx({ incompatibilities: [{ classA: 'flammable', classB: 'flammable' }] })
    )
    expect(plan.parcels).toHaveLength(2)
  })

  it('splits when the weight limit of every box is exceeded', () => {
    const plan = optimizePacking({ lines: [{ sku: 'BLEACH-5L', quantity: 6 }] }, ctx())
    for (const parcel of plan.parcels) {
      const box = boxes.find((b) => b.code === parcel.boxCode)!
      expect(parcel.grossWeightGrams).toBeLessThanOrEqual(box.maxWeightGrams)
    }
    expect(plan.parcels.length).toBeGreaterThanOrEqual(2)
  })

  it('does not exceed the configured fill ratio', () => {
    const plan = optimizePacking({ lines: [{ sku: 'SOAP-1L', quantity: 30 }] }, ctx())
    for (const parcel of plan.parcels) expect(parcel.fillRatioBp).toBeLessThanOrEqual(8500)
  })

  it('rejects a product larger than every active box with unpackable/dimensions', () => {
    try {
      optimizePacking({ lines: [{ sku: 'HUGE', quantity: 1 }] }, ctx())
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PackingOptimizerError)
      expect((error as PackingOptimizerError).code).toBe('unpackable')
      expect((error as PackingOptimizerError).details).toMatchObject({ sku: 'HUGE', reason: 'dimensions' })
    }
  })

  it('rejects a unit heavier than every box with reason weight', () => {
    expect(() => optimizePacking({ lines: [{ sku: 'LEAD', quantity: 1 }] }, ctx())).toThrowError(
      expect.objectContaining({ code: 'unpackable', details: expect.objectContaining({ reason: 'weight' }) })
    )
  })

  it('never uses a box that forbids hazardous goods for hazard classes', () => {
    const plan = optimizePacking(
      { lines: [{ sku: 'ACID-1L', quantity: 1 }] },
      ctx({ boxes: boxes.filter((b) => b.code !== 'S') })
    )
    expect(plan.parcels[0]!.boxCode).toBe('M')
    const onlyX = boxes.filter((b) => b.code === 'X')
    expect(() => optimizePacking({ lines: [{ sku: 'ACID-1L', quantity: 1 }] }, ctx({ boxes: onlyX }))).toThrowError(
      expect.objectContaining({ code: 'unpackable' })
    )
  })

  it('ignores inactive boxes and fails when none are active', () => {
    const inactive = boxes.map((b) => ({ ...b, active: false }))
    expect(() => optimizePacking({ lines: [{ sku: 'PAD', quantity: 1 }] }, ctx({ boxes: inactive }))).toThrowError(
      expect.objectContaining({ code: 'no_active_boxes' })
    )
    const plan = optimizePacking(
      { lines: [{ sku: 'PAD', quantity: 1 }] },
      ctx({ boxes: boxes.map((b) => (b.code === 'S' || b.code === 'X' ? { ...b, active: false } : b)) })
    )
    expect(plan.parcels[0]!.boxCode).toBe('M')
  })

  it('reports every SKU without a profile', () => {
    expect(() =>
      optimizePacking(
        {
          lines: [
            { sku: 'NOPE-1', quantity: 1 },
            { sku: 'NOPE-2', quantity: 1 }
          ]
        },
        ctx()
      )
    ).toThrowError(expect.objectContaining({ code: 'unknown_profile', details: { skus: ['NOPE-1', 'NOPE-2'] } }))
  })

  it('validates inputs: empty, zero, negative, fractional quantities, too many units', () => {
    const bad = (lines: unknown) => () => optimizePacking({ lines: lines as never }, ctx())
    expect(bad([])).toThrowError(expect.objectContaining({ code: 'invalid_input' }))
    expect(bad([{ sku: 'PAD', quantity: 0 }])).toThrowError(expect.objectContaining({ code: 'invalid_input' }))
    expect(bad([{ sku: 'PAD', quantity: -1 }])).toThrowError(expect.objectContaining({ code: 'invalid_input' }))
    expect(bad([{ sku: 'PAD', quantity: 1.5 }])).toThrowError(expect.objectContaining({ code: 'invalid_input' }))
    expect(bad([{ sku: '', quantity: 1 }])).toThrowError(expect.objectContaining({ code: 'invalid_input' }))
    expect(bad([{ sku: 'PAD', quantity: 501 }])).toThrowError(expect.objectContaining({ code: 'too_many_units' }))
  })

  it('fails with too_many_parcels beyond 20 parcels', () => {
    expect(() => optimizePacking({ lines: [{ sku: 'DRUM', quantity: 21 }] }, ctx())).toThrowError(
      expect.objectContaining({ code: 'too_many_parcels' })
    )
  })

  it('is deterministic regardless of line order and merges duplicated lines', () => {
    const a = optimizePacking(
      {
        lines: [
          { sku: 'SOAP-1L', quantity: 3 },
          { sku: 'PAD', quantity: 5 },
          { sku: 'ACID-1L', quantity: 1 }
        ]
      },
      ctx()
    )
    const b = optimizePacking(
      {
        lines: [
          { sku: 'ACID-1L', quantity: 1 },
          { sku: 'PAD', quantity: 2 },
          { sku: 'PAD', quantity: 3 },
          { sku: 'SOAP-1L', quantity: 3 }
        ]
      },
      ctx()
    )
    expect(b).toEqual(a)
  })

  it('keeps lineIndex through the plan and maps to the order packing parcel schema', () => {
    const lines = [
      { sku: 'SOAP-1L', quantity: 2, lineIndex: 0 },
      { sku: 'ACID-1L', quantity: 1, lineIndex: 1 }
    ]
    const plan = optimizePacking({ lines }, ctx())
    const parcels = toOrderPackingParcels(plan)
    for (const parcel of parcels) expect(packingParcelSchema.safeParse(parcel).success).toBe(true)
    const total = parcels.flatMap((p) => p.contents).reduce((n, c) => n + c.quantity, 0)
    expect(total).toBe(3)
  })

  it('refuses to map to order parcels when lineIndex is missing', () => {
    const plan = optimizePacking({ lines: [{ sku: 'PAD', quantity: 1 }] }, ctx())
    expect(() => toOrderPackingParcels(plan)).toThrowError(expect.objectContaining({ code: 'line_index_required' }))
  })

  it('verifier detects tampered plans (overweight, incompatibility, missing units, wrong box)', () => {
    const lines = [
      { sku: 'BLEACH-5L', quantity: 1 },
      { sku: 'ACID-1L', quantity: 1 }
    ]
    const plan = optimizePacking({ lines }, ctx())
    const merged = structuredClone(plan)
    merged.parcels[0]!.contents.push(...merged.parcels[1]!.contents)
    merged.parcels[0]!.hazardClasses = ['corrosive', 'oxidizer']
    merged.parcels.splice(1, 1)
    const problems = verifyPackingPlan(merged, { lines }, ctx())
    expect(problems.some((p) => p.startsWith('incompatible_classes'))).toBe(true)
    const missing = structuredClone(plan)
    missing.parcels.splice(1, 1)
    expect(verifyPackingPlan(missing, { lines }, ctx()).some((p) => p.startsWith('units_mismatch'))).toBe(true)
    const wrongBox = structuredClone(plan)
    wrongBox.parcels[0]!.boxCode = 'ZZZ'
    expect(verifyPackingPlan(wrongBox, { lines }, ctx()).some((p) => p.startsWith('unknown_box'))).toBe(true)
    const heavy = structuredClone(plan)
    heavy.parcels[0]!.boxCode = 'X'
    expect(verifyPackingPlan(heavy, { lines }, ctx()).length).toBeGreaterThan(0)
  })

  it('does not mutate its inputs', () => {
    const c = ctx()
    const snapshot = JSON.stringify(c)
    const input = { lines: [{ sku: 'SOAP-1L', quantity: 4 }] }
    const before = JSON.stringify(input)
    optimizePacking(input, c)
    expect(JSON.stringify(c)).toBe(snapshot)
    expect(JSON.stringify(input)).toBe(before)
  })
})
