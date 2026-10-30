import { z } from 'zod'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import {
  type CatalogSupplier,
  type SupplierProductOffering,
  type SourcingDecision,
  type SourcingStrategy,
  type CandidateSupplierOffering,
  selectSourcingOffering
} from '../../shared/supplier-sourcing'

export class SupplierSourcingError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'SupplierSourcingError'
  }
}

export async function authorizeCatalog(
  database: D1Database,
  claims: VerifiedSessionClaims,
  now?: string
): Promise<void> {
  const resWrite = await authorizeD1Session(database, claims, 'catalog.write', {
    now,
    requireMfa: true
  })
  if (resWrite.allowed) return

  const resManage = await authorizeD1Session(database, claims, 'administration.manage', {
    now,
    requireMfa: true
  })
  if (resManage.allowed) return

  if (resWrite.code === 'unauthenticated' || resManage.code === 'unauthenticated') {
    throw new SupplierSourcingError('unauthenticated', 'Session unauthenticated or expired')
  }
  throw new SupplierSourcingError('forbidden', 'Requires catalog.write permission')
}

const createSupplierInputSchema = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(160),
  currency: z.enum(['EUR', 'USD', 'GBP']).optional(),
  leadTimeDaysDefault: z.number().int().min(0).max(365).optional(),
  reliabilityScore: z.number().int().min(0).max(100).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional()
})

export type SupplierSourcingOptions = {
  now?: string
}

export async function createSupplier(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: {
    code: string
    name: string
    currency?: 'EUR' | 'USD' | 'GBP'
    leadTimeDaysDefault?: number
    reliabilityScore?: number
    paymentTermsDays?: number
  },
  options?: SupplierSourcingOptions
): Promise<CatalogSupplier> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeCatalog(database, claims, now)
  input = createSupplierInputSchema.parse(input)

  const id = crypto.randomUUID()
  const currency = input.currency ?? 'EUR'
  const leadTimeDefault = input.leadTimeDaysDefault ?? 3
  const reliability = input.reliabilityScore ?? 95
  const paymentTerms = input.paymentTermsDays ?? 30

  await database
    .prepare(
      `INSERT INTO catalog_suppliers (
         id, code, name, currency, lead_time_days_default,
         reliability_score, payment_terms_days, is_active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .bind(id, input.code, input.name, currency, leadTimeDefault, reliability, paymentTerms, now, now)
    .run()

  return {
    id,
    code: input.code,
    name: input.name,
    currency,
    leadTimeDaysDefault: leadTimeDefault,
    reliabilityScore: reliability,
    paymentTermsDays: paymentTerms,
    isActive: 1,
    createdAt: now,
    updatedAt: now
  }
}

export async function upsertSupplierOffering(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: {
    supplierId: string
    productId: string
    variantId: string
    supplierSku: string
    costCents: number
    currency?: 'EUR' | 'USD' | 'GBP'
    leadTimeDays: number
    minOrderQuantity?: number
    isPreferred?: number
  },
  options?: SupplierSourcingOptions
): Promise<SupplierProductOffering> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeCatalog(database, claims, now)

  if (input.costCents <= 0) {
    throw new SupplierSourcingError('invalid_cost', 'Cost cents must be positive')
  }

  const existing = await database
    .prepare(`SELECT id, version FROM supplier_product_offerings WHERE supplier_id = ? AND variant_id = ?`)
    .bind(input.supplierId, input.variantId)
    .first<{ id: string; version: number }>()

  const currency = input.currency ?? 'EUR'
  const moq = input.minOrderQuantity ?? 1
  const isPreferred = input.isPreferred ?? 0

  if (existing) {
    const nextVersion = existing.version + 1
    await database
      .prepare(
        `UPDATE supplier_product_offerings
         SET supplier_sku = ?, cost_cents = ?, currency = ?,
             lead_time_days = ?, min_order_quantity = ?, is_preferred = ?,
             version = ?, updated_at = ?
         WHERE id = ? AND version = ?`
      )
      .bind(
        input.supplierSku,
        input.costCents,
        currency,
        input.leadTimeDays,
        moq,
        isPreferred,
        nextVersion,
        now,
        existing.id,
        existing.version
      )
      .run()

    return {
      id: existing.id,
      supplierId: input.supplierId,
      productId: input.productId,
      variantId: input.variantId,
      supplierSku: input.supplierSku,
      costCents: input.costCents,
      currency,
      leadTimeDays: input.leadTimeDays,
      minOrderQuantity: moq,
      isPreferred,
      isActive: 1,
      version: nextVersion,
      createdAt: now,
      updatedAt: now
    }
  } else {
    const id = crypto.randomUUID()
    await database
      .prepare(
        `INSERT INTO supplier_product_offerings (
           id, supplier_id, product_id, variant_id, supplier_sku,
           cost_cents, currency, lead_time_days, min_order_quantity,
           is_preferred, is_active, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`
      )
      .bind(
        id,
        input.supplierId,
        input.productId,
        input.variantId,
        input.supplierSku,
        input.costCents,
        currency,
        input.leadTimeDays,
        moq,
        isPreferred,
        now,
        now
      )
      .run()

    return {
      id,
      supplierId: input.supplierId,
      productId: input.productId,
      variantId: input.variantId,
      supplierSku: input.supplierSku,
      costCents: input.costCents,
      currency,
      leadTimeDays: input.leadTimeDays,
      minOrderQuantity: moq,
      isPreferred,
      isActive: 1,
      version: 1,
      createdAt: now,
      updatedAt: now
    }
  }
}

export async function selectAndRecordSourcingDecision(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: {
    variantId: string
    retailPriceCents: number
    strategy: SourcingStrategy
    selectionReason?: string
  },
  options?: SupplierSourcingOptions
): Promise<SourcingDecision> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeCatalog(database, claims, now)

  const rows = await database
    .prepare(
      `SELECT o.id as offering_id, o.supplier_id, o.supplier_sku, o.cost_cents,
              o.lead_time_days, o.min_order_quantity, o.is_preferred,
              s.name as supplier_name, s.reliability_score
       FROM supplier_product_offerings o
       JOIN catalog_suppliers s ON s.id = o.supplier_id
       WHERE o.variant_id = ? AND o.is_active = 1 AND s.is_active = 1`
    )
    .bind(input.variantId)
    .all<{
      offering_id: string
      supplier_id: string
      supplier_sku: string
      cost_cents: number
      lead_time_days: number
      min_order_quantity: number
      is_preferred: number
      supplier_name: string
      reliability_score: number
    }>()

  if (!rows.results || rows.results.length === 0) {
    throw new SupplierSourcingError('no_suppliers_found', `No active suppliers found for variant ${input.variantId}`)
  }

  const candidates: CandidateSupplierOffering[] = rows.results.map((r) => ({
    offeringId: r.offering_id,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    supplierSku: r.supplier_sku,
    costCents: r.cost_cents,
    leadTimeDays: r.lead_time_days,
    minOrderQuantity: r.min_order_quantity,
    isPreferred: r.is_preferred === 1,
    reliabilityScore: r.reliability_score
  }))

  const result = selectSourcingOffering(input.retailPriceCents, candidates, input.strategy)
  const finalReason = input.selectionReason ? `${input.selectionReason} (${result.reason})` : result.reason

  const decisionId = crypto.randomUUID()
  const candidateOptionsJson = JSON.stringify(result.candidateEvaluations)

  await database
    .prepare(
      `INSERT INTO supplier_sourcing_decisions (
         id, variant_id, selected_supplier_id, selected_offering_id,
         strategy, selection_reason, retail_price_cents, cost_cents,
         margin_cents, margin_percent, lead_time_days, candidate_options_json,
         actor_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      decisionId,
      input.variantId,
      result.selectedOffering.supplierId,
      result.selectedOffering.offeringId,
      input.strategy,
      finalReason,
      input.retailPriceCents,
      result.selectedOffering.costCents,
      result.margin.marginCents,
      result.margin.marginPercent,
      result.selectedOffering.leadTimeDays,
      candidateOptionsJson,
      claims.identityId,
      now
    )
    .run()

  return {
    id: decisionId,
    variantId: input.variantId,
    selectedSupplierId: result.selectedOffering.supplierId,
    selectedOfferingId: result.selectedOffering.offeringId,
    strategy: input.strategy,
    selectionReason: finalReason,
    retailPriceCents: input.retailPriceCents,
    costCents: result.selectedOffering.costCents,
    marginCents: result.margin.marginCents,
    marginPercent: result.margin.marginPercent,
    leadTimeDays: result.selectedOffering.leadTimeDays,
    candidateOptions: result.candidateEvaluations as unknown as Array<Record<string, unknown>>,
    actorId: claims.identityId,
    createdAt: now
  }
}

export async function listSupplierOfferings(
  database: D1Database,
  variantId: string
): Promise<SupplierProductOffering[]> {
  const rows = await database
    .prepare(
      `SELECT id, supplier_id, product_id, variant_id, supplier_sku,
              cost_cents, currency, lead_time_days, min_order_quantity,
              is_preferred, is_active, version, created_at, updated_at
       FROM supplier_product_offerings
       WHERE variant_id = ?
       ORDER BY cost_cents ASC`
    )
    .bind(variantId)
    .all<{
      id: string
      supplier_id: string
      product_id: string
      variant_id: string
      supplier_sku: string
      cost_cents: number
      currency: 'EUR' | 'USD' | 'GBP'
      lead_time_days: number
      min_order_quantity: number
      is_preferred: number
      is_active: number
      version: number
      created_at: string
      updated_at: string
    }>()

  return (rows.results || []).map((r) => ({
    id: r.id,
    supplierId: r.supplier_id,
    productId: r.product_id,
    variantId: r.variant_id,
    supplierSku: r.supplier_sku,
    costCents: r.cost_cents,
    currency: r.currency,
    leadTimeDays: r.lead_time_days,
    minOrderQuantity: r.min_order_quantity,
    isPreferred: r.is_preferred,
    isActive: r.is_active,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

export async function listSourcingDecisions(database: D1Database, variantId: string): Promise<SourcingDecision[]> {
  const rows = await database
    .prepare(
      `SELECT id, variant_id, selected_supplier_id, selected_offering_id,
              strategy, selection_reason, retail_price_cents, cost_cents,
              margin_cents, margin_percent, lead_time_days, candidate_options_json,
              actor_id, created_at
       FROM supplier_sourcing_decisions
       WHERE variant_id = ?
       ORDER BY created_at DESC`
    )
    .bind(variantId)
    .all<{
      id: string
      variant_id: string
      selected_supplier_id: string
      selected_offering_id: string
      strategy: SourcingStrategy
      selection_reason: string
      retail_price_cents: number
      cost_cents: number
      margin_cents: number
      margin_percent: number
      lead_time_days: number
      candidate_options_json: string
      actor_id: string
      created_at: string
    }>()

  return (rows.results || []).map((r) => ({
    id: r.id,
    variantId: r.variant_id,
    selectedSupplierId: r.selected_supplier_id,
    selectedOfferingId: r.selected_offering_id,
    strategy: r.strategy,
    selectionReason: r.selection_reason,
    retailPriceCents: r.retail_price_cents,
    costCents: r.cost_cents,
    marginCents: r.margin_cents,
    marginPercent: r.margin_percent,
    leadTimeDays: r.lead_time_days,
    candidateOptions: JSON.parse(r.candidate_options_json),
    actorId: r.actor_id,
    createdAt: r.created_at
  }))
}
