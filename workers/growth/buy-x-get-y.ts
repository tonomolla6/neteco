import { z } from 'zod'
import { mapQuoteLines, prepareQuoteLinesStatement, CartError, type RawResolvedLine } from '../catalog/cart'
import { validateQuantity } from '../../server/domain/money'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  bxgyReturnLinesSchema,
  bxgyRuleInputSchema,
  bxgySnapshotSchema,
  evaluateBuyXGetY,
  passThroughEvaluation,
  quoteBxgyReturn,
  type BxgyCartLine,
  type BxgyEvaluation,
  type BxgyReturnLine,
  type BxgyReturnQuote,
  type BxgyRule,
  type BxgyRuleInput,
  type BxgySnapshot,
  type BxgyStatus
} from '../../shared/buy-x-get-y'
import {
  authorizeAdmin,
  canonicalJson,
  executeCommand,
  fail,
  mapStorageError,
  replayCommand,
  requireIdempotencyKey,
  sha256Hex,
  type CommandReceipt,
  type VerifiedSessionClaims
} from './common'

/* ---------------------------------------------------------------- rules */

const TRANSITIONS: Record<BxgyStatus, readonly BxgyStatus[]> = {
  draft: ['active', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: []
}

interface RuleRow {
  id: string
  code: string
  name: string
  status: BxgyStatus
  version: number
  trigger_variant_id: string
  buy_quantity: number
  gift_variant_id: string
  gift_quantity: number
  max_applications_per_order: number
  total_limit: number | null
  per_customer_limit: number | null
  margin_floor_basis_points: number
  starts_at: string
  ends_at: string | null
  updated_at: string
}

export interface BxgyRuleView extends BxgyRule {
  code: string
  name: string
  updatedAt: string
}

function viewOf(row: RuleRow): BxgyRuleView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    version: row.version,
    triggerVariantId: row.trigger_variant_id,
    buyQuantity: row.buy_quantity,
    giftVariantId: row.gift_variant_id,
    giftQuantity: row.gift_quantity,
    maxApplicationsPerOrder: row.max_applications_per_order,
    totalLimit: row.total_limit,
    perCustomerLimit: row.per_customer_limit,
    marginFloorBasisPoints: row.margin_floor_basis_points,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    updatedAt: row.updated_at
  }
}

const RULE_COLUMNS = `id, code, name, status, version, trigger_variant_id, buy_quantity, gift_variant_id,
  gift_quantity, max_applications_per_order, total_limit, per_customer_limit, margin_floor_basis_points,
  starts_at, ends_at, updated_at`

async function readRule(db: D1Database, id: string): Promise<RuleRow | null> {
  return db.prepare(`SELECT ${RULE_COLUMNS} FROM bxgy_rules WHERE id = ?`).bind(id).first<RuleRow>()
}

function parseRuleInput(raw: unknown): BxgyRuleInput {
  const parsed = bxgyRuleInputSchema.safeParse(raw)
  if (!parsed.success) fail('invalid_input')
  return parsed.data
}

async function assertVariantsExist(db: D1Database, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)]
  const { results } = await db
    .prepare(`SELECT id FROM variants WHERE id IN (${unique.map(() => '?').join(',')})`)
    .bind(...unique)
    .all<{ id: string }>()
  if (results.length !== unique.length) fail('variant_not_available')
}

function receiptOf(
  action: string,
  targetId: string,
  appliedVersion: number,
  payloadHash: string,
  now: string
): CommandReceipt {
  return { commandId: crypto.randomUUID(), action, targetId, appliedVersion, payloadHash, recordedAt: now }
}

function commandInsert(db: D1Database, receipt: CommandReceipt, actorId: string, key: string, expected: number) {
  return db
    .prepare(
      `INSERT INTO bxgy_commands(command_id, actor_id, rule_id, action, idempotency_key, expected_version,
         applied_version, payload_hash, receipt_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      receipt.commandId,
      actorId,
      receipt.targetId,
      receipt.action,
      key,
      expected,
      receipt.appliedVersion,
      receipt.payloadHash,
      JSON.stringify(receipt),
      receipt.recordedAt
    )
}

export async function createBxgyRule(
  db: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  idempotencyKey: string,
  now: string
): Promise<CommandReceipt> {
  requireIdempotencyKey(idempotencyKey)
  const input = parseRuleInput(rawInput)
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'create', input }))
  const replay = await replayCommand(db, 'bxgy_commands', claims.identityId, idempotencyKey, payloadHash)
  if (replay) return replay
  await assertVariantsExist(db, [input.triggerVariantId, input.giftVariantId])
  const id = crypto.randomUUID()
  const receipt = receiptOf('create', id, 1, payloadHash, now)
  return executeCommand(
    db,
    'bxgy_commands',
    claims.identityId,
    idempotencyKey,
    payloadHash,
    [
      db
        .prepare(
          `INSERT INTO bxgy_rules(id, code, name, status, version, trigger_variant_id, buy_quantity, gift_variant_id,
           gift_quantity, max_applications_per_order, total_limit, per_customer_limit, margin_floor_basis_points,
           starts_at, ends_at, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, 'draft', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          input.code,
          input.name,
          input.triggerVariantId,
          input.buyQuantity,
          input.giftVariantId,
          input.giftQuantity,
          input.maxApplicationsPerOrder,
          input.totalLimit,
          input.perCustomerLimit,
          input.marginFloorBasisPoints,
          input.startsAt,
          input.endsAt,
          now,
          now,
          claims.identityId
        ),
      commandInsert(db, receipt, claims.identityId, idempotencyKey, 0)
    ],
    receipt
  )
}

export async function updateBxgyRule(
  db: D1Database,
  claims: VerifiedSessionClaims,
  ruleId: string,
  rawInput: unknown,
  expectedVersion: number,
  idempotencyKey: string,
  now: string
): Promise<CommandReceipt> {
  requireIdempotencyKey(idempotencyKey)
  const input = parseRuleInput(rawInput)
  if (!catalogPolicyUuidSchema.safeParse(ruleId).success || !Number.isInteger(expectedVersion) || expectedVersion < 1)
    fail('invalid_input')
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'update', ruleId, expectedVersion, input }))
  const replay = await replayCommand(db, 'bxgy_commands', claims.identityId, idempotencyKey, payloadHash)
  if (replay) return replay
  const current = await readRule(db, ruleId)
  if (!current) fail('not_found')
  if (current.code !== input.code) fail('invalid_input')
  if (current.version !== expectedVersion) fail('version_conflict')
  if (current.status === 'archived') fail('invalid_transition')
  await assertVariantsExist(db, [input.triggerVariantId, input.giftVariantId])
  const receipt = receiptOf('update', ruleId, expectedVersion + 1, payloadHash, now)
  return executeCommand(
    db,
    'bxgy_commands',
    claims.identityId,
    idempotencyKey,
    payloadHash,
    [
      commandInsert(db, receipt, claims.identityId, idempotencyKey, expectedVersion),
      db
        .prepare(
          `UPDATE bxgy_rules SET name = ?, trigger_variant_id = ?, buy_quantity = ?, gift_variant_id = ?,
           gift_quantity = ?, max_applications_per_order = ?, total_limit = ?, per_customer_limit = ?,
           margin_floor_basis_points = ?, starts_at = ?, ends_at = ?, version = ?, updated_at = ?, updated_by = ?
         WHERE id = ? AND version = ?`
        )
        .bind(
          input.name,
          input.triggerVariantId,
          input.buyQuantity,
          input.giftVariantId,
          input.giftQuantity,
          input.maxApplicationsPerOrder,
          input.totalLimit,
          input.perCustomerLimit,
          input.marginFloorBasisPoints,
          input.startsAt,
          input.endsAt,
          expectedVersion + 1,
          now,
          claims.identityId,
          ruleId,
          expectedVersion
        )
    ],
    receipt
  )
}

export async function setBxgyRuleStatus(
  db: D1Database,
  claims: VerifiedSessionClaims,
  ruleId: string,
  status: BxgyStatus,
  expectedVersion: number,
  idempotencyKey: string,
  now: string
): Promise<CommandReceipt> {
  requireIdempotencyKey(idempotencyKey)
  if (
    !catalogPolicyUuidSchema.safeParse(ruleId).success ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1 ||
    !(status in TRANSITIONS)
  )
    fail('invalid_input')
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'set_status', ruleId, expectedVersion, status }))
  const replay = await replayCommand(db, 'bxgy_commands', claims.identityId, idempotencyKey, payloadHash)
  if (replay) return replay
  const current = await readRule(db, ruleId)
  if (!current) fail('not_found')
  if (current.version !== expectedVersion) fail('version_conflict')
  if (!TRANSITIONS[current.status].includes(status)) fail('invalid_transition')
  const receipt = receiptOf('set_status', ruleId, expectedVersion + 1, payloadHash, now)
  return executeCommand(
    db,
    'bxgy_commands',
    claims.identityId,
    idempotencyKey,
    payloadHash,
    [
      commandInsert(db, receipt, claims.identityId, idempotencyKey, expectedVersion),
      db
        .prepare(
          `UPDATE bxgy_rules SET status = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`
        )
        .bind(status, expectedVersion + 1, now, claims.identityId, ruleId, expectedVersion)
    ],
    receipt
  )
}

export async function listBxgyRules(
  db: D1Database,
  claims: VerifiedSessionClaims,
  now: string
): Promise<BxgyRuleView[]> {
  await authorizeAdmin(db, claims, now)
  const { results } = await db.prepare(`SELECT ${RULE_COLUMNS} FROM bxgy_rules ORDER BY code LIMIT 200`).all<RuleRow>()
  return results.map(viewOf)
}

/* ---------------------------------------------------------------- preview */

const previewInputSchema = z
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
      .max(100),
    customerId: catalogPolicyUuidSchema.nullable()
  })
  .strict()
  .refine((value) => new Set(value.lines.map((l) => l.variantId)).size === value.lines.length)

export interface BxgyPreview {
  rule: { id: string; code: string; version: number } | null
  evaluation: BxgyEvaluation
}

/**
 * Server-priced preview. Prices, VAT, cost and sellable stock come from the catalogue
 * in one read batch; nothing is written. Several active rules: the eligible one with the
 * largest discount wins (ties by code), so offers never stack.
 */
export async function previewBuyXGetY(db: D1Database, rawInput: unknown, now: string): Promise<BxgyPreview> {
  const parsed = previewInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  const [cartStatement, rulesStatement] = [
    prepareQuoteLinesStatement(db, { lines: input.lines, instant: now }),
    db
      .prepare(
        `SELECT ${RULE_COLUMNS} FROM bxgy_rules
         WHERE status = 'active' AND trigger_variant_id IN (SELECT json_extract(value, '$.variantId') FROM json_each(?1))
         ORDER BY code LIMIT 50`
      )
      .bind(JSON.stringify(input.lines))
  ]
  const [cartResult, rulesResult] = await db.batch([cartStatement, rulesStatement])
  let resolved
  try {
    resolved = mapQuoteLines((cartResult!.results as unknown as RawResolvedLine[]) ?? [])
  } catch (error) {
    if (error instanceof CartError) fail('variant_not_available')
    throw error
  }
  if (resolved.length !== input.lines.length) fail('variant_not_available')
  for (const line of resolved) {
    try {
      validateQuantity(line.quantity, line)
    } catch {
      fail('invalid_input')
    }
  }
  const cartLines: BxgyCartLine[] = resolved.map((l) => ({
    variantId: l.variantId,
    quantity: l.quantity,
    unitGrossCents: l.unitGrossCents,
    taxRateBasisPoints: l.taxRateBasisPoints,
    costUnitNetCents: l.costUnitNetCents
  }))
  const rules = (rulesResult!.results as unknown as RuleRow[]).map(viewOf)
  if (rules.length === 0) return { rule: null, evaluation: passThroughEvaluation(cartLines) }

  const giftIds = [...new Set(rules.map((r) => r.giftVariantId))]
  const [giftResult, usageResult] = await db.batch([
    prepareQuoteLinesStatement(db, { lines: giftIds.map((variantId) => ({ variantId, quantity: 1 })), instant: now }),
    db
      .prepare(
        `SELECT rule_id AS ruleId, COALESCE(SUM(applications), 0) AS total,
                COALESCE(SUM(CASE WHEN customer_id = ?2 THEN applications ELSE 0 END), 0) AS customer
         FROM bxgy_redemptions
         WHERE rule_id IN (SELECT value FROM json_each(?1)) GROUP BY rule_id`
      )
      .bind(JSON.stringify(rules.map((r) => r.id)), input.customerId)
  ])
  const gifts = new Map((giftResult!.results as unknown as RawResolvedLine[]).map((row) => [row.variantId, row]))
  const usage = new Map(
    (usageResult!.results as unknown as Array<{ ruleId: string; total: number; customer: number }>).map((row) => [
      row.ruleId,
      row
    ])
  )

  let best: { rule: BxgyRuleView; evaluation: BxgyEvaluation } | null = null
  let first: { rule: BxgyRuleView; evaluation: BxgyEvaluation } | null = null
  for (const rule of rules) {
    const gift = gifts.get(rule.giftVariantId)
    const sellable =
      gift &&
      gift.variantStatus === 'published' &&
      gift.productStatus === 'published' &&
      gift.categoryStatus === 'published' &&
      gift.publicationValid === 1
    const used = usage.get(rule.id)
    const evaluation = evaluateBuyXGetY(rule, {
      now,
      customerId: input.customerId,
      lines: cartLines,
      gift: {
        unitGrossCents: gift ? Number(gift.unitGrossCents) : 0,
        taxRateBasisPoints: gift ? Number(gift.taxRateBasisPoints) : 0,
        availableQuantity: sellable ? Number(gift.availableQuantity) : 0,
        costUnitNetCents: gift ? (gift.costUnitNetCents === null ? null : Number(gift.costUnitNetCents)) : null
      },
      redemptions: { total: Number(used?.total ?? 0), customer: Number(used?.customer ?? 0) }
    })
    const candidate = { rule, evaluation }
    first ??= candidate
    if (
      evaluation.eligible &&
      (!best || evaluation.totals.discountGrossCents > best.evaluation.totals.discountGrossCents)
    )
      best = candidate
  }
  const chosen = best ?? first!
  return {
    rule: { id: chosen.rule.id, code: chosen.rule.code, version: chosen.rule.version },
    evaluation: chosen.evaluation
  }
}

/* ---------------------------------------------------------------- redemptions */

export async function recordBxgyRedemption(
  db: D1Database,
  input: { orderRef: string; ruleId: string; customerId: string | null; snapshot: BxgySnapshot },
  now: string
): Promise<void> {
  const snapshot = bxgySnapshotSchema.safeParse(input.snapshot)
  if (
    !snapshot.success ||
    input.orderRef.length < 8 ||
    input.orderRef.length > 128 ||
    !catalogPolicyUuidSchema.safeParse(input.ruleId).success ||
    (input.customerId !== null && !catalogPolicyUuidSchema.safeParse(input.customerId).success)
  )
    fail('invalid_input')
  const rule = await readRule(db, input.ruleId)
  if (!rule) fail('not_found')
  const snapshotJson = canonicalJson(snapshot.data)
  const existing = await db
    .prepare('SELECT rule_id, snapshot_json FROM bxgy_redemptions WHERE order_ref = ?')
    .bind(input.orderRef)
    .first<{ rule_id: string; snapshot_json: string }>()
  if (existing) {
    if (existing.rule_id === input.ruleId && existing.snapshot_json === snapshotJson) return
    fail('conflict')
  }
  const applications = snapshot.data.applications
  try {
    await db
      .prepare(
        `INSERT INTO bxgy_redemptions(order_ref, rule_id, rule_version, customer_id, applications, snapshot_json, created_at)
         SELECT ?1, r.id, r.version, ?3, ?4, ?5, ?6 FROM bxgy_rules r
         WHERE r.id = ?2
           AND (r.total_limit IS NULL
                OR COALESCE((SELECT SUM(applications) FROM bxgy_redemptions WHERE rule_id = r.id), 0) + ?4 <= r.total_limit)
           AND (r.per_customer_limit IS NULL
                OR (?3 IS NOT NULL AND COALESCE((SELECT SUM(applications) FROM bxgy_redemptions
                    WHERE rule_id = r.id AND customer_id = ?3), 0) + ?4 <= r.per_customer_limit))`
      )
      .bind(input.orderRef, input.ruleId, input.customerId, applications, snapshotJson, now)
      .run()
  } catch (error) {
    mapStorageError(error)
  }
  const stored = await db
    .prepare('SELECT 1 AS ok FROM bxgy_redemptions WHERE order_ref = ?')
    .bind(input.orderRef)
    .first()
  if (!stored) fail('limit_reached')
}

/* ---------------------------------------------------------------- returns */

const returnInputSchema = z
  .object({
    orderRef: z.string().min(8).max(128),
    returnRef: z.string().min(8).max(128),
    lines: bxgyReturnLinesSchema
  })
  .strict()

export interface BxgyReturnReceipt {
  returnRef: string
  quote: BxgyReturnQuote
}

export async function recordBxgyReturn(
  db: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  now: string
): Promise<BxgyReturnReceipt> {
  const parsed = returnInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ orderRef: input.orderRef, lines: input.lines }))
  const prior = await db
    .prepare('SELECT order_ref, payload_hash, returned_json FROM bxgy_returns WHERE return_ref = ?')
    .bind(input.returnRef)
    .first<{ order_ref: string; payload_hash: string; returned_json: string }>()
  if (prior) {
    if (prior.payload_hash !== payloadHash || prior.order_ref !== input.orderRef) fail('idempotency_conflict')
    return { returnRef: input.returnRef, quote: (JSON.parse(prior.returned_json) as { quote: BxgyReturnQuote }).quote }
  }
  const sale = await db
    .prepare('SELECT snapshot_json FROM bxgy_redemptions WHERE order_ref = ?')
    .bind(input.orderRef)
    .first<{ snapshot_json: string }>()
  if (!sale) fail('not_found')
  const snapshot = JSON.parse(sale.snapshot_json) as BxgySnapshot
  const { results } = await db
    .prepare('SELECT returned_json FROM bxgy_returns WHERE order_ref = ? ORDER BY created_at, return_ref')
    .bind(input.orderRef)
    .all<{ returned_json: string }>()
  const previous: BxgyReturnLine[] = results.flatMap(
    (row) => (JSON.parse(row.returned_json) as { lines: BxgyReturnLine[] }).lines
  )
  let quote: BxgyReturnQuote
  try {
    quote = quoteBxgyReturn(snapshot, previous, input.lines)
  } catch {
    fail('return_invalid')
  }
  try {
    await db
      .prepare(
        `INSERT INTO bxgy_returns(return_ref, order_ref, payload_hash, returned_json, refund_gross_cents, clawback_gross_cents, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE (SELECT count(*) FROM bxgy_returns WHERE order_ref = ?2) = ?8`
      )
      .bind(
        input.returnRef,
        input.orderRef,
        payloadHash,
        JSON.stringify({ lines: input.lines, quote }),
        quote.refundGrossCents,
        quote.clawbackGrossCents,
        now,
        results.length
      )
      .run()
  } catch (error) {
    mapStorageError(error)
  }
  const stored = await db.prepare('SELECT 1 AS ok FROM bxgy_returns WHERE return_ref = ?').bind(input.returnRef).first()
  if (!stored) fail('version_conflict')
  return { returnRef: input.returnRef, quote }
}
