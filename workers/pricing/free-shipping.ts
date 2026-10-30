import { z } from 'zod'
import { quoteLine } from '../../server/domain/money'
import {
  classifyShippingZone,
  decideFreeShipping,
  freeShippingRuleInputSchema,
  type FreeShippingReason,
  type FreeShippingRule,
  type FreeShippingRuleInput,
  type ShippingProfile
} from '../../shared/free-shipping-policy'
import { CartError, mapQuoteLines, prepareQuoteLinesStatement, type RawResolvedLine } from '../catalog/cart'
import { mapShippingOptions, prepareShippingRatesStatement, type RateRow } from '../catalog/shipping'
import {
  STATUS_TRANSITIONS,
  authorizeAdmin,
  canonicalJson,
  fail,
  replay,
  requireIdempotencyKey,
  requireUuid,
  requireVersion,
  runCommand,
  sha256Hex,
  type PricingReceipt,
  type VerifiedSessionClaims
} from './common'

type Status = FreeShippingRule['status']
interface RuleRow {
  id: string
  code: string
  status: Status
  version: number
  profile: FreeShippingRule['profile']
  zone: FreeShippingRule['zone']
  customer_profile: FreeShippingRule['customerProfile']
  threshold_gross_cents: number
  min_margin_basis_points: number
  conscious_subsidy: number
  subsidy_cap_net_cents: number | null
  subsidy_reason: string | null
}
const COLUMNS = `id, code, status, version, profile, zone, customer_profile, threshold_gross_cents,
  min_margin_basis_points, conscious_subsidy, subsidy_cap_net_cents, subsidy_reason`

const toRule = (row: RuleRow): FreeShippingRule => ({
  id: row.id,
  code: row.code,
  status: row.status,
  version: row.version,
  profile: row.profile,
  zone: row.zone,
  customerProfile: row.customer_profile,
  thresholdGrossCents: row.threshold_gross_cents,
  minMarginBasisPoints: row.min_margin_basis_points,
  consciousSubsidy: row.conscious_subsidy === 1,
  subsidyCapNetCents: row.subsidy_cap_net_cents,
  subsidyReason: row.subsidy_reason
})
function parseInput(raw: unknown): FreeShippingRuleInput {
  const parsed = freeShippingRuleInputSchema.safeParse(raw)
  if (!parsed.success) fail('invalid_input')
  return parsed.data
}
const readRow = (db: D1Database, id: string) =>
  db.prepare(`SELECT ${COLUMNS} FROM free_shipping_rules WHERE id = ?`).bind(id).first<RuleRow>()
const valuesOf = (i: FreeShippingRuleInput) => [
  i.profile,
  i.zone,
  i.customerProfile,
  i.thresholdGrossCents,
  i.minMarginBasisPoints,
  i.consciousSubsidy ? 1 : 0,
  i.subsidyCapNetCents,
  i.subsidyReason
]

export async function createFreeShippingRule(
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
    domain: 'free_shipping',
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
          `INSERT INTO free_shipping_rules(id, code, status, version, profile, zone, customer_profile,
             threshold_gross_cents, min_margin_basis_points, conscious_subsidy, subsidy_cap_net_cents, subsidy_reason,
             created_at, updated_at, updated_by)
           VALUES (?, ?, 'draft', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, input.code, ...valuesOf(input), now, now, claims.identityId)
    ]
  })
}

export async function updateFreeShippingRule(
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
    domain: 'free_shipping',
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
          `UPDATE free_shipping_rules SET profile = ?, zone = ?, customer_profile = ?, threshold_gross_cents = ?,
             min_margin_basis_points = ?, conscious_subsidy = ?, subsidy_cap_net_cents = ?, subsidy_reason = ?,
             version = ?, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`
        )
        .bind(...valuesOf(input), expectedVersion + 1, now, claims.identityId, ruleId, expectedVersion)
    ]
  })
}

export async function setFreeShippingRuleStatus(
  db: D1Database,
  claims: VerifiedSessionClaims,
  ruleId: string,
  status: Status,
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
    domain: 'free_shipping',
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
          'UPDATE free_shipping_rules SET status = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?'
        )
        .bind(status, expectedVersion + 1, now, claims.identityId, ruleId, expectedVersion)
    ]
  })
}

export async function listFreeShippingRules(db: D1Database, claims: VerifiedSessionClaims, now: string) {
  await authorizeAdmin(db, claims, now)
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM free_shipping_rules ORDER BY code LIMIT 200`)
    .all<RuleRow>()
  return results.map(toRule)
}

/** Active rule for a profile/zone; a customer-specific rule beats the generic one. */
export async function loadActiveFreeShippingRule(
  db: D1Database,
  profile: ShippingProfile,
  zone: FreeShippingRule['zone'],
  customerProfile: 'consumer' | 'company'
): Promise<FreeShippingRule | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM free_shipping_rules
       WHERE status = 'active' AND profile = ?1 AND zone = ?2 AND customer_profile IN ('any', ?3)
       ORDER BY customer_profile = 'any' LIMIT 1`
    )
    .bind(profile, zone, customerProfile)
    .first<RuleRow>()
  return row ? toRule(row) : null
}

const simulationSchema = z
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
      .max(50),
    postalCode: z.string().regex(/^\d{5}$/),
    customerProfile: z.enum(['consumer', 'company'])
  })
  .strict()

/** Admin simulation: every figure is derived on the server from catalog, price and rate data. */
export async function simulateFreeShipping(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  now: string,
  options: { ownDeliveryPrefixes?: readonly string[] } = {}
) {
  const parsed = simulationSchema.safeParse(raw)
  if (!parsed.success || new Set(parsed.data.lines.map((l) => l.variantId)).size !== parsed.data.lines.length)
    fail('invalid_input')
  await authorizeAdmin(db, claims, now)
  let lines
  let rates: RateRow[]
  try {
    const [quoted, rated] = await db.batch([
      prepareQuoteLinesStatement(db, { lines: parsed.data.lines, instant: now }),
      prepareShippingRatesStatement(db, 1001)
    ])
    lines = mapQuoteLines(quoted!.results as unknown as RawResolvedLine[])
    rates = rated!.results as unknown as RateRow[]
  } catch (error) {
    if (error instanceof CartError && error.code === 'variant_not_available') fail('variant_not_available')
    throw error
  }
  if (lines.length !== parsed.data.lines.length) fail('variant_not_available')
  const quoted = lines.map((l) => quoteLine({ ...l }))
  const goodsGross = quoted.reduce((n, l) => n + l.grossCents, 0)
  const goodsNet = quoted.reduce((n, l) => n + l.netCents, 0)
  const cost = lines.some((l) => l.costUnitNetCents === null)
    ? null
    : lines.reduce((n, l) => n + l.costUnitNetCents! * l.quantity, 0)
  const weight = lines.reduce((n, l) => n + l.weightGrams * l.quantity, 0)
  const profile: ShippingProfile = lines.some((l) => l.profileKind === 'adr')
    ? 'adr'
    : lines.some((l) => l.profileKind === 'pallet') || weight > 20_000
      ? 'pallet'
      : 'parcel'
  const zone = classifyShippingZone(parsed.data.postalCode, options.ownDeliveryPrefixes ?? [])
  const standard =
    profile === 'adr'
      ? []
      : mapShippingOptions(
          lines.map((l) => ({ ...l, published: 1 })),
          rates,
          { postalCode: parsed.data.postalCode, city: 'simulation' }
        ).filter((o) => o.methodCode === 'parcel' && o.serviceProfile === profile)
  const shippingNet = standard[0]?.netCents ?? null
  const rule = await loadActiveFreeShippingRule(db, profile, zone, parsed.data.customerProfile)
  const decision = decideFreeShipping(rule, {
    profile,
    zone,
    customerProfile: parsed.data.customerProfile,
    goodsGrossCents: goodsGross,
    goodsNetCents: goodsNet,
    goodsCostNetCents: cost,
    shippingNetCents: shippingNet ?? 0
  })
  const noRate = decision.free && shippingNet === null
  const reason: FreeShippingReason | 'no_rate' = noRate ? 'no_rate' : decision.reason
  await authorizeAdmin(db, claims, now)
  return {
    free: noRate ? false : decision.free,
    reason,
    profile,
    zone,
    goodsGrossCents: goodsGross,
    goodsNetCents: goodsNet,
    goodsCostNetCents: cost,
    shippingNetCents: shippingNet,
    subsidyNetCents: noRate ? 0 : decision.subsidyNetCents,
    ruleId: rule?.id ?? null,
    ruleVersion: rule?.version ?? null
  }
}
