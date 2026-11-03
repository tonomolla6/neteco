import { z } from 'zod'

export const BUNDLE_SECTORS = [
  'hosteleria',
  'automocion',
  'sanitario',
  'industrial',
  'oficinas',
  'colectividades',
  'general'
] as const

export type BundleSector = (typeof BUNDLE_SECTORS)[number]

export const BUNDLE_TASKS = [
  'desengrase_profundo',
  'desinfeccion_superficies',
  'lavado_vehiculos',
  'lavavajillas_automatico',
  'higiene_manos',
  'limpieza_general',
  'mantenimiento_suelos'
] as const

export type BundleTask = (typeof BUNDLE_TASKS)[number]

export interface BundleItemInput {
  variantId: string
  quantity: number
  minQuantity?: number
  maxQuantity?: number
}

export interface BundleComponentView {
  id: string
  variantId: string
  variantSku: string
  variantName: string
  productTitle: string
  unitPriceCents: number
  taxRate: number
  defaultQuantity: number
  minQuantity: number
  maxQuantity: number
  effectiveStock: number
}

export interface BundleItemCalculation {
  variantId: string
  quantity: number
  unitPriceCents: number
  taxRate: number
  lineGrossCents: number
  lineTaxCents: number
  lineNetCents: number
}

export interface BundlePricingResult {
  equivalentStandaloneCents: number
  bundlePriceCents: number
  savingsCents: number
  savingsPercent: number
  taxCents: number
  totalCents: number
  items: BundleItemCalculation[]
}

export interface BundleDetailView {
  id: string
  slug: string
  title: string
  description: string
  sector: BundleSector
  task: BundleTask
  bundlePriceCents: number
  status: 'draft' | 'active' | 'archived'
  version: number
  equivalentStandaloneCents: number
  savingsCents: number
  savingsPercent: number
  maxAvailableKits: number
  inStock: boolean
  items: BundleComponentView[]
  createdAt: string
  updatedAt: string
}

export const bundleCreateSchema = z.object({
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  title: z.string().min(3).max(200),
  slug: z
    .string()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9_-]+$/),
  description: z.string().min(3).max(2000),
  sector: z.enum(BUNDLE_SECTORS),
  task: z.enum(BUNDLE_TASKS),
  bundlePriceCents: z.number().int().positive(),
  items: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.number().int().min(1),
        minQuantity: z.number().int().min(1).default(1),
        maxQuantity: z.number().int().min(1).default(50)
      })
    )
    .min(1)
})

export const bundleUpdateSchema = z.object({
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  bundleId: z.string().uuid(),
  expectedVersion: z.number().int().min(0),
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(3).max(2000).optional(),
  sector: z.enum(BUNDLE_SECTORS).optional(),
  task: z.enum(BUNDLE_TASKS).optional(),
  bundlePriceCents: z.number().int().positive().optional(),
  status: z.enum(['draft', 'active', 'archived']).optional()
})

export const bundleSelectionSchema = z.object({
  bundleId: z.string().uuid(),
  kitQuantity: z.number().int().min(1).default(1),
  customQuantities: z.record(z.string(), z.number().int().min(1)).optional()
})

export function calculateBundleAvailability(components: Array<{ effectiveStock: number; quantity: number }>): number {
  if (!components.length) return 0
  let minKits = Infinity
  for (const comp of components) {
    if (comp.quantity <= 0) continue
    const available = Math.floor(Math.max(0, comp.effectiveStock) / comp.quantity)
    if (available < minKits) {
      minKits = available
    }
  }
  return minKits === Infinity ? 0 : minKits
}

export function calculateBundlePricing(params: {
  baseBundlePriceCents: number
  kitQuantity: number
  components: Array<{
    variantId: string
    unitPriceCents: number
    taxRate: number
    defaultQuantity: number
    customQuantity?: number
  }>
  marginFloorBasisPoints?: number
}): BundlePricingResult {
  const kitQty = Math.max(1, params.kitQuantity)
  let defaultStandaloneSum = 0
  let configuredStandaloneSum = 0

  for (const comp of params.components) {
    if (typeof comp.variantId !== 'string' || !comp.variantId.trim()) throw new Error('invalid_variant_id')
    defaultStandaloneSum += comp.unitPriceCents * comp.defaultQuantity
    const qty = comp.customQuantity !== undefined ? comp.customQuantity : comp.defaultQuantity
    configuredStandaloneSum += comp.unitPriceCents * qty
  }

  // Base bundle discount ratio
  const discountRatio =
    defaultStandaloneSum > 0
      ? Math.max(0, (defaultStandaloneSum - params.baseBundlePriceCents) / defaultStandaloneSum)
      : 0

  // Total standalone sum for kitQty
  const equivalentStandaloneCents = configuredStandaloneSum * kitQty

  // Pro-rate bundle price for customized quantities
  const unitBundlePriceCents = Math.round(configuredStandaloneSum * (1 - discountRatio))
  const bundlePriceCents = unitBundlePriceCents * kitQty

  const savingsCents = Math.max(0, equivalentStandaloneCents - bundlePriceCents)
  const savingsPercent =
    equivalentStandaloneCents > 0 ? Math.round((savingsCents / equivalentStandaloneCents) * 1000) / 10 : 0

  // Component prices are VAT-inclusive (variants.price_gross_cents), so the bundle price already is the
  // total. Allocate it across lines proportionally to their standalone gross (largest remainder, exact
  // integer cents) and derive the VAT included in each allocated line.
  const lines = params.components.map((comp, index) => {
    const qty = comp.customQuantity !== undefined ? comp.customQuantity : comp.defaultQuantity
    const standaloneGross = comp.unitPriceCents * qty * kitQty
    const share = equivalentStandaloneCents > 0 ? (bundlePriceCents * standaloneGross) / equivalentStandaloneCents : 0
    return { comp, qty, index, allocated: Math.floor(share), remainder: share - Math.floor(share) }
  })
  let unallocated = bundlePriceCents - lines.reduce((sum, line) => sum + line.allocated, 0)
  for (const line of [...lines].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (unallocated <= 0) break
    line.allocated += 1
    unallocated -= 1
  }

  let totalTaxCents = 0
  const items: BundleItemCalculation[] = []

  for (const { comp, qty, allocated } of lines) {
    const lineGross = allocated
    const lineNet = Math.round(lineGross / (1 + comp.taxRate))
    const lineTax = lineGross - lineNet
    totalTaxCents += lineTax

    items.push({
      variantId: comp.variantId,
      quantity: qty * kitQty,
      unitPriceCents: comp.unitPriceCents,
      taxRate: comp.taxRate,
      lineGrossCents: lineGross,
      lineTaxCents: lineTax,
      lineNetCents: lineNet
    })
  }

  return {
    equivalentStandaloneCents,
    bundlePriceCents,
    savingsCents,
    savingsPercent,
    // VAT included in bundlePriceCents; the total payable is the VAT-inclusive bundle price itself.
    taxCents: totalTaxCents,
    totalCents: bundlePriceCents,
    items
  }
}

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalizeJson(element)).join(',')}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`
}

export async function bundleIntentHash(payload: unknown): Promise<string> {
  const text = canonicalizeJson(payload)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
