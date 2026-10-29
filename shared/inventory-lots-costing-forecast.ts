import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'

const integer = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1)
const positive = integer.min(1)
const printable = (value: string) =>
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
const reason = z.string().trim().min(5).max(500).refine(printable)
const lotNumber = z.string().trim().min(1).max(100).refine(printable)

// --- INV-019: Lotes, caducidades, FEFO y trazabilidad ---
export const lotStatusSchema = z.enum(['active', 'quarantined', 'depleted', 'expired'])
export type LotStatus = z.infer<typeof lotStatusSchema>

export const inventoryLotSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    variantId: catalogPolicyUuidSchema,
    legacyVariantId: positive.optional(),
    lotNumber,
    locationId: z.string().min(1).max(50),
    status: lotStatusSchema,
    manufacturedAt: catalogPolicyInstantSchema.nullable(),
    expiresAt: catalogPolicyInstantSchema,
    initialQuantity: positive,
    availableQuantity: integer,
    version: positive,
    createdAt: catalogPolicyInstantSchema,
    updatedAt: catalogPolicyInstantSchema
  })
  .strict()
export type InventoryLot = z.infer<typeof inventoryLotSchema>

export const createLotInputSchema = z
  .object({
    variantId: catalogPolicyUuidSchema,
    lotNumber,
    locationId: z.string().min(1).max(50).default('main'),
    manufacturedAt: catalogPolicyInstantSchema.optional(),
    expiresAt: catalogPolicyInstantSchema,
    initialQuantity: positive,
    reason: reason.optional()
  })
  .strict()
export type CreateLotInput = z.infer<typeof createLotInputSchema>

export const quarantineLotInputSchema = z
  .object({
    expectedVersion: positive,
    reason
  })
  .strict()
export type QuarantineLotInput = z.infer<typeof quarantineLotInputSchema>

export const allocateFefoInputSchema = z
  .object({
    orderId: catalogPolicyUuidSchema,
    orderLineIndex: integer,
    variantId: catalogPolicyUuidSchema,
    locationId: z.string().min(1).max(50).default('main'),
    requestedQuantity: positive,
    customerId: catalogPolicyUuidSchema.optional(),
    reason: reason.optional()
  })
  .strict()
export type AllocateFefoInput = z.infer<typeof allocateFefoInputSchema>

export const lotAllocationItemSchema = z
  .object({
    allocationId: catalogPolicyUuidSchema,
    lotId: catalogPolicyUuidSchema,
    lotNumber,
    expiresAt: catalogPolicyInstantSchema,
    allocatedQuantity: positive
  })
  .strict()
export type LotAllocationItem = z.infer<typeof lotAllocationItemSchema>

export const fefoAllocationResultSchema = z
  .object({
    orderId: catalogPolicyUuidSchema,
    orderLineIndex: integer,
    variantId: catalogPolicyUuidSchema,
    totalAllocated: integer,
    requestedQuantity: positive,
    fullyAllocated: z.boolean(),
    allocations: z.array(lotAllocationItemSchema)
  })
  .strict()
export type FefoAllocationResult = z.infer<typeof fefoAllocationResultSchema>

export const lotTraceabilityRecordSchema = z
  .object({
    allocationId: catalogPolicyUuidSchema,
    lotId: catalogPolicyUuidSchema,
    lotNumber,
    variantId: catalogPolicyUuidSchema,
    orderId: catalogPolicyUuidSchema,
    orderLineIndex: integer,
    customerId: catalogPolicyUuidSchema.nullable(),
    customerEmail: z.string().nullable().optional(),
    quantity: positive,
    allocatedAt: catalogPolicyInstantSchema,
    lotStatus: lotStatusSchema,
    expiresAt: catalogPolicyInstantSchema
  })
  .strict()
export type LotTraceabilityRecord = z.infer<typeof lotTraceabilityRecordSchema>

export const lotTraceabilityResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    lot: inventoryLotSchema.nullable().optional(),
    records: z.array(lotTraceabilityRecordSchema),
    totalUnitsTraced: integer
  })
  .strict()
export type LotTraceabilityResponse = z.infer<typeof lotTraceabilityResponseSchema>

// --- INV-021: Coste medio, FIFO y reconciliación de margen analítico ---
export const costingMethodSchema = z.enum(['average_cost', 'fifo'])
export type CostingMethod = z.infer<typeof costingMethodSchema>

export const setCostingPolicyInputSchema = z
  .object({
    variantId: catalogPolicyUuidSchema,
    method: costingMethodSchema,
    expectedVersion: integer,
    reason: reason.optional()
  })
  .strict()
export type SetCostingPolicyInput = z.infer<typeof setCostingPolicyInputSchema>

export const recordCostLayerInputSchema = z
  .object({
    variantId: catalogPolicyUuidSchema,
    locationId: z.string().min(1).max(50).default('main'),
    receiptMovementId: catalogPolicyUuidSchema.optional(),
    unitCostCents: integer,
    quantity: positive,
    reason: reason.optional()
  })
  .strict()
export type RecordCostLayerInput = z.infer<typeof recordCostLayerInputSchema>

export const consumeCostInputSchema = z
  .object({
    orderId: catalogPolicyUuidSchema,
    orderLineIndex: integer,
    variantId: catalogPolicyUuidSchema,
    locationId: z.string().min(1).max(50).default('main'),
    quantity: positive,
    revenueNetCents: integer
  })
  .strict()
export type ConsumeCostInput = z.infer<typeof consumeCostInputSchema>

export const costConsumptionResultSchema = z
  .object({
    consumptionId: catalogPolicyUuidSchema,
    orderId: catalogPolicyUuidSchema,
    orderLineIndex: integer,
    variantId: catalogPolicyUuidSchema,
    method: costingMethodSchema,
    quantity: positive,
    unitCostCents: integer,
    totalCogsCents: integer,
    revenueNetCents: integer,
    marginCents: z.number().int(),
    marginBasisPoints: z.number().int(),
    createdAt: catalogPolicyInstantSchema
  })
  .strict()
export type CostConsumptionResult = z.infer<typeof costConsumptionResultSchema>

export const analyticalMarginReportSchema = z
  .object({
    source: z.literal('cloudflare'),
    variantId: catalogPolicyUuidSchema.optional(),
    periodStart: catalogPolicyInstantSchema,
    periodEnd: catalogPolicyInstantSchema,
    totalUnitsSold: integer,
    totalRevenueNetCents: integer,
    totalCogsCents: integer,
    analyticalGrossMarginCents: z.number().int(),
    analyticalGrossMarginBasisPoints: z.number().int(),
    financialSourceRevenueNetCents: integer,
    discrepancyCents: integer,
    reconciliationStatus: z.enum(['reconciled', 'discrepancy']),
    consumptions: z.array(costConsumptionResultSchema)
  })
  .strict()
export type AnalyticalMarginReport = z.infer<typeof analyticalMarginReportSchema>

// --- INV-022: Previsión de demanda y anomalías (sugerencia no destructiva) ---
export const baselineModelKindSchema = z.enum(['naive_last_period', 'simple_moving_average'])
export type BaselineModelKind = z.infer<typeof baselineModelKindSchema>

export const advancedModelKindSchema = z.enum(['exponential_smoothing', 'trend_adjusted'])
export type AdvancedModelKind = z.infer<typeof advancedModelKindSchema>

export const anomalyKindSchema = z.enum(['spike', 'drop'])
export type AnomalyKind = z.infer<typeof anomalyKindSchema>

export const anomalySeveritySchema = z.enum(['warning', 'critical'])
export type AnomalySeverity = z.infer<typeof anomalySeveritySchema>

export const demandAnomalySchema = z
  .object({
    id: catalogPolicyUuidSchema,
    variantId: catalogPolicyUuidSchema,
    detectedAt: catalogPolicyInstantSchema,
    kind: anomalyKindSchema,
    severity: anomalySeveritySchema,
    observedUnits: integer,
    expectedUnits: z.number().nonnegative(),
    zScore: z.number(),
    status: z.enum(['open', 'acknowledged', 'resolved']),
    createdAt: catalogPolicyInstantSchema
  })
  .strict()
export type DemandAnomaly = z.infer<typeof demandAnomalySchema>

export const reorderSuggestionSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    variantId: catalogPolicyUuidSchema,
    locationId: z.string().min(1).max(50),
    status: z.enum(['suggested', 'reviewed', 'dismissed', 'ordered']),
    currentPhysicalStock: integer,
    safetyStock: integer,
    forecastedDailyDemand: z.number().nonnegative(),
    leadTimeDays: positive,
    suggestedQuantity: positive,
    suggestedReorderDate: catalogPolicyInstantSchema,
    reason: z.string().min(1).max(500),
    reviewedBy: catalogPolicyUuidSchema.nullable().optional(),
    reviewedAt: catalogPolicyInstantSchema.nullable().optional(),
    createdAt: catalogPolicyInstantSchema
  })
  .strict()
export type ReorderSuggestion = z.infer<typeof reorderSuggestionSchema>

export const forecastModelEvaluationSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    variantId: catalogPolicyUuidSchema,
    periodStart: catalogPolicyInstantSchema,
    periodEnd: catalogPolicyInstantSchema,
    baselineModel: baselineModelKindSchema,
    baselineMae: z.number().nonnegative(),
    advancedModel: advancedModelKindSchema,
    advancedMae: z.number().nonnegative(),
    maeImprovementPercent: z.number(),
    forecastDailyDemand: z.number().nonnegative(),
    reorderSuggestion: reorderSuggestionSchema.nullable().optional(),
    anomalies: z.array(demandAnomalySchema)
  })
  .strict()
export type ForecastModelEvaluation = z.infer<typeof forecastModelEvaluationSchema>

export const reviewSuggestionInputSchema = z
  .object({
    suggestionId: catalogPolicyUuidSchema,
    action: z.enum(['review', 'dismiss']),
    reason
  })
  .strict()
export type ReviewSuggestionInput = z.infer<typeof reviewSuggestionInputSchema>

export const ackAnomalyInputSchema = z
  .object({
    anomalyId: catalogPolicyUuidSchema,
    reason
  })
  .strict()
export type AckAnomalyInput = z.infer<typeof ackAnomalyInputSchema>

// --- Command Action Types, Receipts and Hashing ---
export const inventoryLotsCostingActionSchema = z.enum([
  'create_lot',
  'quarantine_lot',
  'allocate_fefo',
  'set_costing_policy',
  'record_cost_layer',
  'consume_cost',
  'review_suggestion',
  'ack_anomaly'
])
export type InventoryLotsCostingAction = z.infer<typeof inventoryLotsCostingActionSchema>

export function parseLotsCostingInput(action: InventoryLotsCostingAction, input: unknown) {
  switch (action) {
    case 'create_lot':
      return createLotInputSchema.parse(input)
    case 'quarantine_lot':
      return quarantineLotInputSchema.parse(input)
    case 'allocate_fefo':
      return allocateFefoInputSchema.parse(input)
    case 'set_costing_policy':
      return setCostingPolicyInputSchema.parse(input)
    case 'record_cost_layer':
      return recordCostLayerInputSchema.parse(input)
    case 'consume_cost':
      return consumeCostInputSchema.parse(input)
    case 'review_suggestion':
      return reviewSuggestionInputSchema.parse(input)
    case 'ack_anomaly':
      return ackAnomalyInputSchema.parse(input)
  }
}

export async function lotsCostingIntentHash(
  action: InventoryLotsCostingAction,
  targetId: string,
  input: unknown
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(['lots-costing:v1', action, targetId, parseLotsCostingInput(action, input)])
  )
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

export const lotsCostingReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: catalogPolicyUuidSchema,
    action: inventoryLotsCostingActionSchema,
    targetId: z.string().min(1).max(100),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    resultVersion: integer,
    data: z.record(z.string(), z.unknown()),
    createdAt: catalogPolicyInstantSchema
  })
  .strict()
export type LotsCostingReceipt = z.infer<typeof lotsCostingReceiptSchema>
