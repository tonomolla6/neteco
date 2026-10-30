import { z } from 'zod'
import { splitGross, validateQuantity } from '../../server/domain/money'
import { MAX_CART_QUANTITY } from '../../shared/cart-limits'
import { QUICK_ORDER_IMPORT_MAX_ROWS } from '../../shared/quick-order-import'
import type { VerifiedSessionClaims } from './authorization'
import { activeOrderCustomerId } from './customer-orders'
import { sellableExpression } from './inventory'
import { effectiveB2BGrossCentsExpression, effectiveB2BSourceExpression, inlineEffectivePricingSql } from './pricing'

/** SEA-018. Server-side resolution of a CSV / barcode quick order under the authenticated
 * company. Identity, company and time are always derived on the server from the verified
 * session; the body only carries references and quantities. Read-only: it reserves nothing
 * and the cart re-validates every price and quantity when the lines are added. */
export class QuickOrderCompanyError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'unauthenticated' | 'not_company' | 'company_not_approved' | 'unavailable'
  ) {
    super(code)
  }
}
const reference = z.string().trim().min(1).max(160)
const inputSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            reference: reference.refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
            quantity: z.number().int().min(1).max(MAX_CART_QUANTITY)
          })
          .strict()
      )
      .min(1)
      .max(QUICK_ORDER_IMPORT_MAX_ROWS)
  })
  .strict()

export type QuickOrderLineErrorCode =
  | 'not_found'
  | 'ambiguous'
  | 'duplicate_reference'
  | 'duplicate_variant'
  | 'insufficient_stock'
  | 'quantity_not_allowed'
export type CompanyQuickOrderLine =
  | {
      index: number
      status: 'ready'
      reference: string
      quantity: number
      variantId: string
      legacyVariantId: number | null
      sku: string
      productSlug: string
      name: string
      format: string
      unitLabel: string
      unitGrossCents: number
      grossCents: number
      netCents: number
      taxCents: number
      taxRateBasisPoints: number
      source: 'public' | 'b2b_variant' | 'b2b_category'
      stock: number
      backorderAllowed: boolean
      minimumQuantity: number
      quantityIncrement: number
      maximumQuantity: number | null
    }
  | { index: number; status: 'error'; reference: string; quantity: number; code: QuickOrderLineErrorCode }
export interface CompanyQuickOrderResult {
  companyId: string
  lines: CompanyQuickOrderLine[]
}

interface Row {
  ref: string
  variantId: string
  legacyVariantId: number | null
  sku: string
  productSlug: string
  name: string
  format: string
  unitLabel: string
  unitGrossCents: number
  taxRateBasisPoints: number
  source: 'public' | 'b2b_variant' | 'b2b_category'
  stock: number
  backorderAllowed: number
  minimumQuantity: number
  quantityIncrement: number
  maximumQuantity: number | null
}

const clock = (now?: () => string) => {
  const value = now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) || new Date(value).toISOString().replace('.000Z', 'Z') !== value)
    throw new QuickOrderCompanyError('unavailable')
  return value
}

async function authority(database: D1Database, claims: VerifiedSessionClaims | null, now: string) {
  const customerId = await activeOrderCustomerId(database, claims, now)
  if (!customerId) throw new QuickOrderCompanyError('unauthenticated')
  const company = await database
    .prepare('SELECT id, status FROM companies WHERE customer_id = ?1')
    .bind(customerId)
    .first<{ id: string; status: string }>()
  if (!company) throw new QuickOrderCompanyError('not_company')
  if (company.status !== 'approved') throw new QuickOrderCompanyError('company_not_approved')
  return { customerId, companyId: company.id }
}

export async function resolveCompanyQuickOrder(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  rawInput: unknown,
  options: { now?: () => string } = {}
): Promise<CompanyQuickOrderResult> {
  const parsed = inputSchema.safeParse(rawInput)
  if (!parsed.success) throw new QuickOrderCompanyError('invalid_input')
  const now = clock(options.now)
  const before = await authority(database, claims, now)

  const seen = new Set<string>()
  const unique: string[] = []
  for (const line of parsed.data.lines) {
    const key = line.reference.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(line.reference)
    }
  }
  const gross = inlineEffectivePricingSql(effectiveB2BGrossCentsExpression('v', '?1'), now)
  const source = inlineEffectivePricingSql(effectiveB2BSourceExpression('v', '?1'), now)
  // One statement for the whole batch. References travel as a single JSON parameter
  // (D1 allows few bound variables) and match exact SKU, EAN, GTIN or MPN.
  const { results } = await database
    .prepare(
      `SELECT r.value AS ref, v.id AS variantId, v.legacy_id AS legacyVariantId, v.sku AS sku, p.slug AS productSlug, p.name AS name,
        v.format AS format, v.unit_label AS unitLabel, ${gross} AS unitGrossCents,
        t.rate_basis_points AS taxRateBasisPoints, ${source} AS source,
        COALESCE((SELECT SUM(${sellableExpression()}) FROM inventory_balances b WHERE b.variant_id = v.id), 0) AS stock,
        v.backorder_allowed AS backorderAllowed, v.minimum_quantity AS minimumQuantity,
        v.quantity_increment AS quantityIncrement, v.maximum_quantity AS maximumQuantity
       FROM json_each(?2) r
       JOIN variants v ON v.sku = r.value OR v.ean = r.value OR v.gtin = r.value OR v.mpn = r.value
       JOIN products p ON p.id = v.product_id AND p.status = 'published'
       JOIN tax_classes t ON t.id = v.tax_class_id
       WHERE v.status = 'published'
       ORDER BY r.key, v.id`
    )
    .bind(before.customerId, JSON.stringify(unique))
    .all<Row>()
  const after = await authority(database, claims, now)
  if (after.customerId !== before.customerId || after.companyId !== before.companyId)
    throw new QuickOrderCompanyError('unauthenticated')

  const byReference = new Map<string, Row[]>()
  for (const row of results) byReference.set(row.ref, [...(byReference.get(row.ref) ?? []), row])
  const claimedReferences = new Set<string>()
  const claimedVariants = new Set<string>()
  const lines = parsed.data.lines.map((line, index): CompanyQuickOrderLine => {
    const failure = (code: QuickOrderLineErrorCode): CompanyQuickOrderLine => ({
      index,
      status: 'error',
      reference: line.reference,
      quantity: line.quantity,
      code
    })
    const key = line.reference.toLowerCase()
    if (claimedReferences.has(key)) return failure('duplicate_reference')
    claimedReferences.add(key)
    const matches = byReference.get(line.reference) ?? []
    // The same variant can match through several identifiers of one row.
    const variants = [...new Map(matches.map((row) => [row.variantId, row])).values()]
    if (variants.length === 0) return failure('not_found')
    if (variants.length > 1) return failure('ambiguous')
    const row = variants[0]!
    if (claimedVariants.has(row.variantId)) return failure('duplicate_variant')
    claimedVariants.add(row.variantId)
    try {
      validateQuantity(line.quantity, row)
    } catch {
      return failure('quantity_not_allowed')
    }
    if (!row.backorderAllowed && line.quantity > row.stock) return failure('insufficient_stock')
    const grossCents = row.unitGrossCents * line.quantity
    if (!Number.isSafeInteger(grossCents)) return failure('quantity_not_allowed')
    const amount = splitGross(grossCents, row.taxRateBasisPoints)
    return {
      index,
      status: 'ready',
      reference: line.reference,
      quantity: line.quantity,
      variantId: row.variantId,
      legacyVariantId: row.legacyVariantId,
      sku: row.sku,
      productSlug: row.productSlug,
      name: row.name,
      format: row.format,
      unitLabel: row.unitLabel,
      unitGrossCents: row.unitGrossCents,
      grossCents,
      netCents: amount.netCents,
      taxCents: amount.taxCents,
      taxRateBasisPoints: row.taxRateBasisPoints,
      source: row.source,
      stock: row.stock,
      backorderAllowed: row.backorderAllowed === 1,
      minimumQuantity: row.minimumQuantity,
      quantityIncrement: row.quantityIncrement,
      maximumQuantity: row.maximumQuantity
    }
  })
  return { companyId: before.companyId, lines }
}
