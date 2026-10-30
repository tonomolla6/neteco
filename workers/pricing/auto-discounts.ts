import { z } from 'zod'
import { validateQuantity } from '../../server/domain/money'
import {
  autoDiscountRuleInputSchema,
  evaluateAutoDiscounts,
  type AutoDiscountRule,
  type AutoDiscountRuleInput,
  type AutoDiscountStatus
} from '../../shared/auto-discounts'
import { CartError, mapQuoteLines, prepareQuoteLinesStatement, type RawResolvedLine } from '../catalog/cart'
import {
  STATUS_TRANSITIONS,
  authorizeAdmin,
  canonicalJson,
  fail,
  liveCustomerId,
  replay,
  requireIdempotencyKey,
  requireUuid,
  requireVersion,
  runCommand,
  sha256Hex,
  type PricingReceipt,
  type VerifiedSessionClaims
} from './common'

interface RuleRow {
  id: string
  code: string
  name: string
  status: AutoDiscountStatus
  version: number
  kind: AutoDiscountRule['kind']
  scope_ids_json: string
  benefit_kind: 'percent' | 'fixed' | 'tiers'
  basis_points: number | null
  fixed_gross_cents: number | null
  tiers_json: string
  min_basket_gross_cents: number
  priority: number
  stacking: AutoDiscountRule['stacking']
  segment: AutoDiscountRule['segment']
  margin_floor_basis_points: number
  customer_message: string
  starts_at: string
  ends_at: string | null
}
const COLUMNS = `id, code, name, status, version, kind, scope_ids_json, benefit_kind, basis_points, fixed_gross_cents,
  tiers_json, min_basket_gross_cents, priority, stacking, segment, margin_floor_basis_points, customer_message,
  starts_at, ends_at`

function toRule(row: RuleRow): AutoDiscountRule {
  const benefit =
    row.benefit_kind === 'percent'
      ? { kind: 'percent' as const, basisPoints: row.basis_points! }
      : row.benefit_kind === 'fixed'
        ? { kind: 'fixed' as const, grossCents: row.fixed_gross_cents! }
        : {
            kind: 'tiers' as const,
            tiers: JSON.parse(row.tiers_json) as Array<{ minQuantity: number; basisPoints: number }>
          }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    version: row.version,
    kind: row.kind,
    scopeIds: JSON.parse(row.scope_ids_json) as string[],
    benefit,
    minBasketGrossCents: row.min_basket_gross_cents,
    priority: row.priority,
    stacking: row.stacking,
    segment: row.segment,
    marginFloorBasisPoints: row.margin_floor_basis_points,
    customerMessage: row.customer_message,
    startsAt: row.starts_at,
    endsAt: row.ends_at
  }
}

function parseInput(raw: unknown): AutoDiscountRuleInput {
  const parsed = autoDiscountRuleInputSchema.safeParse(raw)
  if (!parsed.success) fail('invalid_input')
  return parsed.data
}
const readRow = (db: D1Database, id: string) =>
  db.prepare(`SELECT ${COLUMNS} FROM auto_discount_rules WHERE id = ?`).bind(id).first<RuleRow>()

function columnsOf(input: AutoDiscountRuleInput) {
  return [
    input.name,
    input.kind,
    JSON.stringify(input.scopeIds),
    input.benefit.kind,
    input.benefit.kind === 'percent' ? input.benefit.basisPoints : null,
    input.benefit.kind === 'fixed' ? input.benefit.grossCents : null,
    JSON.stringify(input.benefit.kind === 'tiers' ? input.benefit.tiers : []),
    input.minBasketGrossCents,
    input.priority,
    input.stacking,
    input.segment,
    input.marginFloorBasisPoints,
    input.customerMessage,
    input.startsAt,
    input.endsAt
  ]
}

export async function createAutoDiscountRule(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  idempotencyKey: string,
  now: string
): Promise<PricingReceipt> {
  requireIdempotencyKey(idempotencyKey)
  const input = parseInput(raw)
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'create', input }))
  const prior = await replay(db, claims.identityId, idempotencyKey, payloadHash)
  if (prior) return prior
  const id = crypto.randomUUID()
  return runCommand(db, {
    actorId: claims.identityId,
    key: idempotencyKey,
    domain: 'auto_discount',
    action: 'create',
    targetId: id,
    expectedVersion: 0,
    appliedVersion: 1,
    payloadHash,
    now,
    audit: { after: input },
    statements: () => [
      db
        .prepare(
          `INSERT INTO auto_discount_rules(id, code, status, version, name, kind, scope_ids_json, benefit_kind,
             basis_points, fixed_gross_cents, tiers_json, min_basket_gross_cents, priority, stacking, segment,
             margin_floor_basis_points, customer_message, starts_at, ends_at, created_at, updated_at, updated_by)
           VALUES (?, ?, 'draft', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, input.code, ...columnsOf(input), now, now, claims.identityId)
    ]
  })
}

export async function updateAutoDiscountRule(
  db: D1Database,
  claims: VerifiedSessionClaims,
  ruleId: string,
  raw: unknown,
  expectedVersion: number,
  idempotencyKey: string,
  now: string
): Promise<PricingReceipt> {
  requireIdempotencyKey(idempotencyKey)
  requireUuid(ruleId)
  requireVersion(expectedVersion)
  const input = parseInput(raw)
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'update', ruleId, expectedVersion, input }))
  const prior = await replay(db, claims.identityId, idempotencyKey, payloadHash)
  if (prior) return prior
  const current = await readRow(db, ruleId)
  if (!current) fail('not_found')
  if (current.code !== input.code) fail('invalid_input')
  if (current.version !== expectedVersion) fail('version_conflict')
  if (current.status === 'archived') fail('invalid_transition')
  return runCommand(db, {
    actorId: claims.identityId,
    key: idempotencyKey,
    domain: 'auto_discount',
    action: 'update',
    targetId: ruleId,
    expectedVersion,
    appliedVersion: expectedVersion + 1,
    payloadHash,
    now,
    audit: { before: toRule(current), after: input },
    statements: () => [
      db
        .prepare(
          `UPDATE auto_discount_rules SET name = ?, kind = ?, scope_ids_json = ?, benefit_kind = ?, basis_points = ?,
             fixed_gross_cents = ?, tiers_json = ?, min_basket_gross_cents = ?, priority = ?, stacking = ?, segment = ?,
             margin_floor_basis_points = ?, customer_message = ?, starts_at = ?, ends_at = ?,
             version = ?, updated_at = ?, updated_by = ?
           WHERE id = ? AND version = ?`
        )
        .bind(...columnsOf(input), expectedVersion + 1, now, claims.identityId, ruleId, expectedVersion)
    ]
  })
}

export async function setAutoDiscountRuleStatus(
  db: D1Database,
  claims: VerifiedSessionClaims,
  ruleId: string,
  status: AutoDiscountStatus,
  expectedVersion: number,
  idempotencyKey: string,
  now: string
): Promise<PricingReceipt> {
  requireIdempotencyKey(idempotencyKey)
  requireUuid(ruleId)
  requireVersion(expectedVersion)
  if (!(status in STATUS_TRANSITIONS)) fail('invalid_input')
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'set_status', ruleId, expectedVersion, status }))
  const prior = await replay(db, claims.identityId, idempotencyKey, payloadHash)
  if (prior) return prior
  const current = await readRow(db, ruleId)
  if (!current) fail('not_found')
  if (current.version !== expectedVersion) fail('version_conflict')
  if (!STATUS_TRANSITIONS[current.status]!.includes(status)) fail('invalid_transition')
  return runCommand(db, {
    actorId: claims.identityId,
    key: idempotencyKey,
    domain: 'auto_discount',
    action: 'set_status',
    targetId: ruleId,
    expectedVersion,
    appliedVersion: expectedVersion + 1,
    payloadHash,
    now,
    audit: { from: current.status, to: status },
    statements: () => [
      db
        .prepare(
          'UPDATE auto_discount_rules SET status = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?'
        )
        .bind(status, expectedVersion + 1, now, claims.identityId, ruleId, expectedVersion)
    ]
  })
}

export async function listAutoDiscountRules(
  db: D1Database,
  claims: VerifiedSessionClaims,
  now: string
): Promise<Array<AutoDiscountRule & { updatedAt?: never }>> {
  await authorizeAdmin(db, claims, now)
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM auto_discount_rules ORDER BY priority, code LIMIT 200`)
    .all<RuleRow>()
  return results.map(toRule)
}

/* ------------------------------------------------------------------ customer preview */

const previewSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            variantId: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
            quantity: z.number().int().min(1).max(999)
          })
          .strict()
      )
      .min(1)
      .max(50)
  })
  .strict()

/**
 * Customer-facing simulation. Prices, costs, segment and time are all server facts;
 * the response carries amounts and explanations only (no cost, margin or rule codes).
 */
export async function previewAutoDiscounts(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  now: string
) {
  const parsed = previewSchema.safeParse(raw)
  if (!parsed.success || new Set(parsed.data.lines.map((l) => l.variantId)).size !== parsed.data.lines.length)
    fail('invalid_input')
  const customerId = await liveCustomerId(db, claims, now)
  let resolved
  try {
    const [quoted, rules, company] = await db.batch([
      prepareQuoteLinesStatement(db, { lines: parsed.data.lines, instant: now, ...(customerId ? { customerId } : {}) }),
      db
        .prepare(
          `SELECT ${COLUMNS} FROM auto_discount_rules WHERE status = 'active' AND starts_at <= ?1
             AND (ends_at IS NULL OR ends_at > ?1) ORDER BY priority, code LIMIT 200`
        )
        .bind(now),
      db
        .prepare("SELECT EXISTS(SELECT 1 FROM companies WHERE customer_id = ?1 AND status = 'approved') AS approved")
        .bind(customerId)
    ])
    resolved = {
      lines: mapQuoteLines(quoted!.results as unknown as RawResolvedLine[]),
      rules: (rules!.results as unknown as RuleRow[]).map(toRule),
      companyApproved: (company!.results[0] as { approved: number } | undefined)?.approved === 1
    }
  } catch (error) {
    if (error instanceof CartError && error.code === 'variant_not_available') fail('variant_not_available')
    throw error
  }
  if (resolved.lines.length !== parsed.data.lines.length) fail('variant_not_available')
  for (const line of resolved.lines) {
    const requested = parsed.data.lines.find((l) => l.variantId === line.variantId)
    if (!requested || requested.quantity !== line.quantity) fail('variant_not_available')
    try {
      validateQuantity(line.quantity, line)
    } catch {
      fail('invalid_input')
    }
  }
  const result = evaluateAutoDiscounts(resolved.rules, {
    now,
    customerId,
    companyApproved: resolved.companyApproved,
    lines: resolved.lines.map((line, lineIndex) => ({
      lineIndex,
      variantId: line.variantId,
      productId: line.productId,
      categoryId: line.categoryId,
      sku: line.sku,
      quantity: line.quantity,
      unitGrossCents: line.unitGrossCents,
      costUnitNetCents: line.costUnitNetCents,
      taxRateBasisPoints: line.taxRateBasisPoints
    }))
  })
  return {
    evaluatedAt: now,
    lines: result.lines.map((l) => ({
      lineIndex: l.lineIndex,
      variantId: l.variantId,
      quantity: l.quantity,
      unitGrossCents: l.unitGrossCents,
      discountGrossCents: l.discountGrossCents,
      netCents: l.netCents,
      taxCents: l.taxCents,
      grossCents: l.grossCents
    })),
    totals: result.totals,
    explanations: result.explanations
  }
}
