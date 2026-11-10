import { z } from 'zod'

export const currencySchema = z.enum(['EUR', 'USD', 'GBP'])
export type Currency = z.infer<typeof currencySchema>

export const sourcingStrategySchema = z.enum([
  'lowest_cost',
  'shortest_lead_time',
  'best_margin',
  'preferred',
  'manual_override'
])
export type SourcingStrategy = z.infer<typeof sourcingStrategySchema>

export const catalogSupplierSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(2).max(50),
  name: z.string().min(2).max(160),
  currency: currencySchema.default('EUR'),
  leadTimeDaysDefault: z.number().int().min(0).default(3),
  reliabilityScore: z.number().int().min(0).max(100).default(95),
  paymentTermsDays: z.number().int().min(0).default(30),
  isActive: z.number().int().min(0).max(1).default(1),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type CatalogSupplier = z.infer<typeof catalogSupplierSchema>

export const supplierProductOfferingSchema = z.object({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
  productId: z.string().min(1),
  variantId: z.string().min(1),
  supplierSku: z.string().min(1).max(100),
  costCents: z.number().int().min(1),
  currency: currencySchema.default('EUR'),
  leadTimeDays: z.number().int().min(0),
  minOrderQuantity: z.number().int().min(1).default(1),
  isPreferred: z.number().int().min(0).max(1).default(0),
  isActive: z.number().int().min(0).max(1).default(1),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type SupplierProductOffering = z.infer<typeof supplierProductOfferingSchema>

export const sourcingDecisionSchema = z.object({
  id: z.string().uuid(),
  variantId: z.string().min(1),
  selectedSupplierId: z.string().uuid(),
  selectedOfferingId: z.string().uuid(),
  strategy: sourcingStrategySchema,
  selectionReason: z.string().min(3),
  retailPriceCents: z.number().int().min(0),
  costCents: z.number().int().min(1),
  marginCents: z.number().int(),
  marginPercent: z.number(),
  leadTimeDays: z.number().int().min(0),
  candidateOptions: z.array(z.record(z.string(), z.unknown())),
  actorId: z.string().uuid(),
  createdAt: z.string()
})
export type SourcingDecision = z.infer<typeof sourcingDecisionSchema>

export interface MarginCalculationResult {
  retailPriceCents: number
  costCents: number
  marginCents: number
  marginPercent: number
  markupPercent: number
  isViable: boolean
}

/**
 * Calculates profit margin and markup in financial cents and percentage.
 * Enforces positive viable margin calculation.
 */
export function calculateMargin(retailPriceCents: number, costCents: number): MarginCalculationResult {
  if (costCents <= 0) {
    throw new Error('invalid_supplier_cost')
  }
  const marginCents = retailPriceCents - costCents
  const marginPercent = retailPriceCents > 0 ? Math.round((marginCents / retailPriceCents) * 10000) / 100 : 0
  const markupPercent = Math.round((marginCents / costCents) * 10000) / 100

  return {
    retailPriceCents,
    costCents,
    marginCents,
    marginPercent,
    markupPercent,
    isViable: marginCents > 0
  }
}

export interface CandidateSupplierOffering {
  offeringId: string
  supplierId: string
  supplierName: string
  supplierSku: string
  costCents: number
  leadTimeDays: number
  minOrderQuantity: number
  isPreferred: boolean
  reliabilityScore: number
}

export interface SourcingSelectionResult {
  selectedOffering: CandidateSupplierOffering
  strategy: SourcingStrategy
  reason: string
  margin: MarginCalculationResult
  candidateEvaluations: Array<
    CandidateSupplierOffering & {
      evaluatedMarginCents: number
      evaluatedMarginPercent: number
    }
  >
}

/**
 * Evaluates candidate supplier offerings according to a given sourcing strategy
 * and returns the traceable choice with full margin and comparison metrics.
 */
export function selectSourcingOffering(
  retailPriceCents: number,
  candidates: CandidateSupplierOffering[],
  strategy: SourcingStrategy
): SourcingSelectionResult {
  if (candidates.length === 0) {
    throw new Error('no_active_supplier_offerings')
  }

  const candidateEvaluations = candidates.map((candidate) => {
    const margin = calculateMargin(retailPriceCents, candidate.costCents)
    return {
      ...candidate,
      evaluatedMarginCents: margin.marginCents,
      evaluatedMarginPercent: margin.marginPercent
    }
  })

  let selected: (typeof candidateEvaluations)[0]
  let reason: string

  switch (strategy) {
    case 'lowest_cost': {
      // Sort by cost ascending, then lead time
      const sorted = [...candidateEvaluations].sort(
        (a, b) => a.costCents - b.costCents || a.leadTimeDays - b.leadTimeDays
      )
      selected = sorted[0]!
      reason = `Selección por menor coste de adquisición (${(selected.costCents / 100).toFixed(2)}€ vs otros ${
        sorted.length > 1 ? (sorted[1]!.costCents / 100).toFixed(2) + '€' : 'sin alternativas'
      })`
      break
    }

    case 'shortest_lead_time': {
      // Sort by lead time ascending, then cost
      const sorted = [...candidateEvaluations].sort(
        (a, b) => a.leadTimeDays - b.leadTimeDays || a.costCents - b.costCents
      )
      selected = sorted[0]!
      reason = `Selección por plazo de entrega más rápido (${selected.leadTimeDays} días de lead time)`
      break
    }

    case 'best_margin': {
      // Sort by margin percent descending
      const sorted = [...candidateEvaluations].sort(
        (a, b) => b.evaluatedMarginPercent - a.evaluatedMarginPercent || a.leadTimeDays - b.leadTimeDays
      )
      selected = sorted[0]!
      reason = `Selección por mayor margen comercial (${selected.evaluatedMarginPercent.toFixed(2)}% de margen sobre PVP)`
      break
    }

    case 'preferred': {
      // Prefer preferred supplier, fallback to lowest cost
      const preferred = candidateEvaluations.filter((c) => c.isPreferred)
      if (preferred.length > 0) {
        selected = preferred.sort((a, b) => a.costCents - b.costCents)[0]!
        reason = `Selección por proveedor preferente configurado (${selected.supplierName})`
      } else {
        const sorted = [...candidateEvaluations].sort((a, b) => a.costCents - b.costCents)
        selected = sorted[0]!
        reason = `No hay proveedor preferente marcado; fallback a menor coste (${(selected.costCents / 100).toFixed(2)}€)`
      }
      break
    }

    case 'manual_override':
    default: {
      selected = candidateEvaluations[0]!
      reason = `Selección manual explícita asignada a ${selected.supplierName}`
      break
    }
  }

  const finalMargin = calculateMargin(retailPriceCents, selected.costCents)

  return {
    selectedOffering: selected,
    strategy,
    reason,
    margin: finalMargin,
    candidateEvaluations
  }
}
