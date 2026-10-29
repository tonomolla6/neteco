import { z } from 'zod'

/**
 * SHP-030 packing optimiser. Pure and deterministic: first-fit-decreasing over single units with
 * per-parcel box re-selection. It is a HEURISTIC (dimension check by sorted edges plus a fill ratio,
 * not a 3D bin-packing proof): every plan must be validated by the warehouse before it is used.
 */
export const PACKING_ALGORITHM_VERSION = 'ffd-box-reselect-1'
export const MAX_PACKING_UNITS = 500
export const MAX_PACKING_PARCELS = 20
export const DEFAULT_FILL_RATIO_BP = 8500

export const hazardClassSchema = z.enum(['none', 'corrosive', 'flammable', 'oxidizer', 'toxic', 'irritant'])
export type HazardClass = z.infer<typeof hazardClassSchema>

export interface BoxType {
  code: string
  name: string
  widthMm: number
  heightMm: number
  depthMm: number
  tareGrams: number
  maxWeightGrams: number
  hazmatAllowed: boolean
  active: boolean
}
export interface ProductProfile {
  sku: string
  weightGrams: number
  widthMm: number
  heightMm: number
  depthMm: number
  hazardClass: HazardClass
}
export interface IncompatibilityRule {
  classA: HazardClass
  classB: HazardClass
}
export interface PackingContext {
  boxes: readonly BoxType[]
  profiles: readonly ProductProfile[]
  incompatibilities: readonly IncompatibilityRule[]
  fillRatioBp?: number
}

export const packingLineSchema = z
  .object({
    sku: z.string().min(1).max(200),
    quantity: z.number().int().min(1).max(MAX_PACKING_UNITS),
    lineIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()
export const packingRequestSchema = z.object({ lines: z.array(packingLineSchema).min(1).max(200) }).strict()
export type PackingLine = z.infer<typeof packingLineSchema>
export type PackingRequest = z.infer<typeof packingRequestSchema>

export interface PlannedContent {
  sku: string
  quantity: number
  lineIndex?: number
}
export interface PlannedParcel {
  boxCode: string
  widthMm: number
  heightMm: number
  depthMm: number
  contents: PlannedContent[]
  hazardClasses: HazardClass[]
  netWeightGrams: number
  grossWeightGrams: number
  fillRatioBp: number
}
export interface PackingPlan {
  algorithmVersion: string
  parcels: PlannedParcel[]
  totals: { parcelCount: number; netWeightGrams: number; grossWeightGrams: number }
}

export class PackingOptimizerError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'too_many_units'
      | 'too_many_parcels'
      | 'unknown_profile'
      | 'no_active_boxes'
      | 'unpackable'
      | 'line_index_required',
    readonly details: Record<string, unknown> = {}
  ) {
    super(code)
    this.name = 'PackingOptimizerError'
  }
}

interface Unit {
  sku: string
  lineIndex: number | undefined
  edges: [number, number, number]
  volume: number
  weight: number
  hazard: HazardClass
}

const edgesOf = (a: number, b: number, c: number): [number, number, number] =>
  [a, b, c].sort((x, y) => x - y) as [number, number, number]
const pairKey = (a: HazardClass, b: HazardClass) => (a <= b ? `${a}|${b}` : `${b}|${a}`)
const ruleSet = (rules: readonly IncompatibilityRule[]) => new Set(rules.map((r) => pairKey(r.classA, r.classB)))
const boxVolume = (box: BoxType) => box.widthMm * box.heightMm * box.depthMm
const boxEdges = (box: BoxType) => edgesOf(box.widthMm, box.heightMm, box.depthMm)

function sortedBoxes(boxes: readonly BoxType[]): BoxType[] {
  return boxes
    .filter((box) => box.active)
    .sort((a, b) => boxVolume(a) - boxVolume(b) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

function edgesFit(unit: [number, number, number], box: BoxType): boolean {
  const e = boxEdges(box)
  return unit[0] <= e[0] && unit[1] <= e[1] && unit[2] <= e[2]
}

function classesCompatible(classes: readonly HazardClass[], incoming: HazardClass, rules: Set<string>): boolean {
  return classes.every((existing) => !rules.has(pairKey(existing, incoming)))
}

function boxHolds(box: BoxType, units: readonly Unit[], fillBp: number): boolean {
  if (!box.active) return false
  const net = units.reduce((n, u) => n + u.weight, 0)
  const volume = units.reduce((n, u) => n + u.volume, 0)
  return (
    units.every((u) => edgesFit(u.edges, box) && (u.hazard === 'none' || box.hazmatAllowed)) &&
    box.tareGrams + net <= box.maxWeightGrams &&
    volume * 10000 <= boxVolume(box) * fillBp
  )
}

function expandUnits(request: PackingRequest, profiles: ReadonlyMap<string, ProductProfile>): Unit[] {
  const merged = new Map<string, { sku: string; lineIndex: number | undefined; quantity: number }>()
  for (const line of request.lines) {
    const key = `${line.sku}\u0000${line.lineIndex ?? ''}`
    const existing = merged.get(key)
    if (existing) existing.quantity += line.quantity
    else merged.set(key, { sku: line.sku, lineIndex: line.lineIndex, quantity: line.quantity })
  }
  let total = 0
  for (const entry of merged.values()) total += entry.quantity
  if (total > MAX_PACKING_UNITS) throw new PackingOptimizerError('too_many_units', { max: MAX_PACKING_UNITS })
  const missing = [...new Set([...merged.values()].map((e) => e.sku).filter((sku) => !profiles.has(sku)))].sort()
  if (missing.length) throw new PackingOptimizerError('unknown_profile', { skus: missing })
  const units: Unit[] = []
  for (const entry of merged.values()) {
    const p = profiles.get(entry.sku)!
    for (let i = 0; i < entry.quantity; i += 1)
      units.push({
        sku: p.sku,
        lineIndex: entry.lineIndex,
        edges: edgesOf(p.widthMm, p.heightMm, p.depthMm),
        volume: p.widthMm * p.heightMm * p.depthMm,
        weight: p.weightGrams,
        hazard: p.hazardClass
      })
  }
  return units
}

function compareUnits(a: Unit, b: Unit): number {
  return (
    b.volume - a.volume ||
    b.weight - a.weight ||
    (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0) ||
    (a.lineIndex ?? -1) - (b.lineIndex ?? -1)
  )
}

function unpackableReason(unit: Unit, boxes: readonly BoxType[], fillBp: number): string {
  const byDims = boxes.filter((box) => edgesFit(unit.edges, box) && unit.volume * 10000 <= boxVolume(box) * fillBp)
  if (!byDims.length) return 'dimensions'
  const byHazmat = byDims.filter((box) => unit.hazard === 'none' || box.hazmatAllowed)
  if (!byHazmat.length) return 'hazmat_box'
  return 'weight'
}

function summarise(box: BoxType, units: readonly Unit[]): PlannedParcel {
  const contents = new Map<string, PlannedContent>()
  for (const unit of units) {
    const key = `${unit.sku}\u0000${unit.lineIndex ?? ''}`
    const current = contents.get(key)
    if (current) current.quantity += 1
    else
      contents.set(key, {
        sku: unit.sku,
        quantity: 1,
        ...(unit.lineIndex === undefined ? {} : { lineIndex: unit.lineIndex })
      })
  }
  const net = units.reduce((n, u) => n + u.weight, 0)
  const volume = units.reduce((n, u) => n + u.volume, 0)
  return {
    boxCode: box.code,
    widthMm: box.widthMm,
    heightMm: box.heightMm,
    depthMm: box.depthMm,
    contents: [...contents.values()].sort(
      (a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0) || (a.lineIndex ?? -1) - (b.lineIndex ?? -1)
    ),
    hazardClasses: [...new Set(units.map((u) => u.hazard))].sort(),
    netWeightGrams: net,
    grossWeightGrams: net + box.tareGrams,
    fillRatioBp: Math.ceil((volume * 10000) / boxVolume(box))
  }
}

export function optimizePacking(rawRequest: PackingRequest, context: PackingContext): PackingPlan {
  const parsed = packingRequestSchema.safeParse(rawRequest)
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some((i) => i.code === 'too_big' && i.path.at(-1) === 'quantity')
    throw new PackingOptimizerError(tooMany ? 'too_many_units' : 'invalid_input')
  }
  const fillBp = context.fillRatioBp ?? DEFAULT_FILL_RATIO_BP
  const boxes = sortedBoxes([...context.boxes])
  if (!boxes.length) throw new PackingOptimizerError('no_active_boxes')
  const profiles = new Map(context.profiles.map((p) => [p.sku, p]))
  const rules = ruleSet(context.incompatibilities)
  const units = expandUnits(parsed.data, profiles).sort(compareUnits)

  const groups: Unit[][] = []
  for (const unit of units) {
    let placed = false
    for (const group of groups) {
      if (
        !classesCompatible(
          group.map((u) => u.hazard),
          unit.hazard,
          rules
        )
      )
        continue
      const candidate = [...group, unit]
      if (boxes.some((box) => boxHolds(box, candidate, fillBp))) {
        group.push(unit)
        placed = true
        break
      }
    }
    if (placed) continue
    if (!boxes.some((box) => boxHolds(box, [unit], fillBp)))
      throw new PackingOptimizerError('unpackable', { sku: unit.sku, reason: unpackableReason(unit, boxes, fillBp) })
    groups.push([unit])
  }
  if (groups.length > MAX_PACKING_PARCELS)
    throw new PackingOptimizerError('too_many_parcels', { required: groups.length, max: MAX_PACKING_PARCELS })

  const parcels = groups.map((group) =>
    summarise(
      boxes.find((box) => boxHolds(box, group, fillBp))!,
      group
    )
  )
  return {
    algorithmVersion: PACKING_ALGORITHM_VERSION,
    parcels,
    totals: {
      parcelCount: parcels.length,
      netWeightGrams: parcels.reduce((n, p) => n + p.netWeightGrams, 0),
      grossWeightGrams: parcels.reduce((n, p) => n + p.grossWeightGrams, 0)
    }
  }
}

/**
 * Independent check of a plan (also used on stored plans before warehouse validation).
 * Returns stable problem codes; an empty array means every invariant holds.
 */
export function verifyPackingPlan(plan: PackingPlan, rawRequest: PackingRequest, context: PackingContext): string[] {
  const problems: string[] = []
  const fillBp = context.fillRatioBp ?? DEFAULT_FILL_RATIO_BP
  const profiles = new Map(context.profiles.map((p) => [p.sku, p]))
  const boxes = new Map(context.boxes.map((b) => [b.code, b]))
  const rules = ruleSet(context.incompatibilities)
  const wanted = new Map<string, number>()
  for (const line of rawRequest.lines) {
    const key = `${line.sku}\u0000${line.lineIndex ?? ''}`
    wanted.set(key, (wanted.get(key) ?? 0) + line.quantity)
  }
  const got = new Map<string, number>()
  plan.parcels.forEach((parcel, index) => {
    const tag = `parcel_${index}`
    const box = boxes.get(parcel.boxCode)
    if (!box) return void problems.push(`unknown_box:${tag}`)
    if (!box.active) problems.push(`inactive_box:${tag}`)
    const units: Unit[] = []
    for (const content of parcel.contents) {
      const p = profiles.get(content.sku)
      if (!p) {
        problems.push(`unknown_profile:${tag}`)
        continue
      }
      const key = `${content.sku}\u0000${content.lineIndex ?? ''}`
      got.set(key, (got.get(key) ?? 0) + content.quantity)
      for (let i = 0; i < content.quantity; i += 1)
        units.push({
          sku: p.sku,
          lineIndex: content.lineIndex,
          edges: edgesOf(p.widthMm, p.heightMm, p.depthMm),
          volume: p.widthMm * p.heightMm * p.depthMm,
          weight: p.weightGrams,
          hazard: p.hazardClass
        })
    }
    const classes = units.map((u) => u.hazard)
    for (let i = 0; i < classes.length; i += 1)
      for (let j = i + 1; j < classes.length; j += 1)
        if (rules.has(pairKey(classes[i]!, classes[j]!))) {
          problems.push(`incompatible_classes:${tag}`)
          i = classes.length
          break
        }
    if (!units.every((u) => edgesFit(u.edges, box))) problems.push(`dimensions:${tag}`)
    if (units.some((u) => u.hazard !== 'none') && !box.hazmatAllowed) problems.push(`hazmat_box:${tag}`)
    const net = units.reduce((n, u) => n + u.weight, 0)
    if (box.tareGrams + net > box.maxWeightGrams) problems.push(`overweight:${tag}`)
    if (units.reduce((n, u) => n + u.volume, 0) * 10000 > boxVolume(box) * fillBp) problems.push(`overfilled:${tag}`)
    if (parcel.grossWeightGrams !== box.tareGrams + net) problems.push(`weight_mismatch:${tag}`)
  })
  for (const [key, quantity] of wanted)
    if (got.get(key) !== quantity) problems.push(`units_mismatch:${key.split('\u0000')[0]}`)
  for (const key of got.keys()) if (!wanted.has(key)) problems.push(`units_mismatch:${key.split('\u0000')[0]}`)
  if (plan.parcels.length > MAX_PACKING_PARCELS) problems.push('too_many_parcels')
  return [...new Set(problems)]
}

/** Maps a plan to the parcel shape accepted by shared/order-packing (needs lineIndex on every line). */
export function toOrderPackingParcels(plan: PackingPlan) {
  return plan.parcels.map((parcel) => ({
    weightGrams: parcel.grossWeightGrams,
    widthMm: parcel.widthMm,
    heightMm: parcel.heightMm,
    depthMm: parcel.depthMm,
    contents: parcel.contents.map((content) => {
      if (content.lineIndex === undefined) throw new PackingOptimizerError('line_index_required')
      return { lineIndex: content.lineIndex, quantity: content.quantity }
    })
  }))
}
