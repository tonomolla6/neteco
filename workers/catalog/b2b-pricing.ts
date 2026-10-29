import { z } from 'zod'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'
import { canonicalPayloadHash } from './cart'
import type { VerifiedSessionClaims } from './authorization'
import { authorizeD1CompanyReview } from '../auth/admin-companies'
import { splitGross } from '../../server/domain/money'
import {
  effectiveB2BGrossCentsExpression,
  effectiveB2BSourceExpression,
  effectiveB2BVersionIdExpression,
  inlineEffectivePricingSql,
  resolvePricingInstant
} from './pricing'

/** Internal resolver: customerId must come from an already verified session. */
export async function resolveD1EffectiveB2BVariantPrice(
  database: D1Database,
  input: { variantId: string; customerId: string | null; instant: string }
) {
  const instant = resolvePricingInstant({ instant: input.instant })
  const gross = inlineEffectivePricingSql(effectiveB2BGrossCentsExpression('v', '?1'), instant)
  const version = inlineEffectivePricingSql(effectiveB2BVersionIdExpression('v', '?1'), instant)
  const source = inlineEffectivePricingSql(effectiveB2BSourceExpression('v', '?1'), instant)
  const row = await database
    .prepare(
      `SELECT ${gross} AS unitGrossCents, ${version} AS priceVersionId, ${source} AS source,
      t.rate_basis_points AS taxRateBasisPoints FROM variants v
      JOIN tax_classes t ON t.id=v.tax_class_id WHERE v.id=?2`
    )
    .bind(input.customerId, input.variantId)
    .first<{
      unitGrossCents: number
      priceVersionId: string
      taxRateBasisPoints: number
      source: 'public' | 'b2b_variant' | 'b2b_category'
    }>()
  if (!row) throw new Error('variant_not_found')
  const { netCents, taxCents } = splitGross(row.unitGrossCents, row.taxRateBasisPoints)
  return { ...row, netCents, taxCents }
}

export class B2BPricingError extends Error {
  constructor(readonly code: 'invalid_input' | 'conflict' | 'unavailable') {
    super(code)
  }
}
const instantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine((v) => {
    const d = new Date(v)
    return Number.isFinite(d.getTime()) && d.toISOString().replace('.000Z', 'Z') === v
  })
const idSchema = z.string().min(1).max(200)
const reasonSchema = z.string().trim().min(3).max(500)
const listSchema = z
  .object({
    priceListId: idSchema.optional(),
    expectedVersion: z.number().int().safe().nonnegative().optional(),
    code: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(200),
    status: z.enum(['active', 'inactive']),
    validFrom: instantSchema,
    validUntil: instantSchema.nullable(),
    variantRules: z
      .array(z.object({ variantId: idSchema, unitGrossCents: z.number().int().safe().positive() }).strict())
      .max(200),
    categoryRules: z
      .array(z.object({ categoryId: idSchema, discountBps: z.number().int().min(0).max(9500) }).strict())
      .max(200),
    reason: reasonSchema
  })
  .strict()
  .refine((v) => (v.priceListId === undefined) === (v.expectedVersion === undefined))
  .refine((v) => v.validUntil === null || v.validUntil > v.validFrom)
  .refine((v) => new Set(v.variantRules.map((r) => r.variantId)).size === v.variantRules.length)
  .refine((v) => new Set(v.categoryRules.map((r) => r.categoryId)).size === v.categoryRules.length)
const assignmentSchema = z
  .object({
    expectedVersion: z.number().int().safe().nonnegative(),
    priceListId: idSchema,
    validFrom: instantSchema,
    validUntil: instantSchema.nullable(),
    reason: reasonSchema
  })
  .strict()
  .refine((v) => v.validUntil === null || v.validUntil > v.validFrom)
type CommandOptions = { idempotencyKey: string; now?: () => string }
interface B2BReceipt {
  commandId: string
  action: string
  priceListId: string
  version: number
  companyId?: string
}
function classifyB2BWriteFailure(error: unknown): B2BPricingError {
  if (isD1CheckConstraintFailure(error)) return new B2BPricingError('conflict')
  if (error instanceof Error && /^(?:D1_ERROR: )?(?:FOREIGN KEY|UNIQUE) constraint failed(?::|$)/.test(error.message))
    return new B2BPricingError('conflict')
  return new B2BPricingError('unavailable')
}
async function readB2BCommand(db: D1Database, actorId: string, key: string) {
  return db
    .prepare('SELECT payload_hash,receipt_json FROM b2b_pricing_commands WHERE actor_id=?1 AND command_id=?2')
    .bind(actorId, key)
    .first<{ payload_hash: string; receipt_json: string }>()
}
async function recoverB2B(db: D1Database, claims: VerifiedSessionClaims, options: CommandOptions, hash: string) {
  await authorizeD1CompanyReview(db, claims, { now: options.now })
  const saved = await readB2BCommand(db, claims.identityId, options.idempotencyKey)
  if (!saved) return null
  if (saved.payload_hash !== hash) throw new B2BPricingError('conflict')
  return JSON.parse(saved.receipt_json) as B2BReceipt
}
function commandStatements(
  db: D1Database,
  claims: VerifiedSessionClaims,
  options: CommandOptions,
  hash: string,
  action: string,
  value: unknown,
  receipt: B2BReceipt,
  condition: string,
  parameters: unknown[]
) {
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!instantSchema.safeParse(now).success || !z.string().uuid().safeParse(options.idempotencyKey).success)
    throw new B2BPricingError('invalid_input')
  return [
    db
      .prepare(
        `INSERT INTO b2b_pricing_commands(actor_id,command_id,session_id,session_version,action,payload_hash,input_json,receipt_json,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE ${condition}`
      )
      .bind(
        claims.identityId,
        options.idempotencyKey,
        claims.sessionId,
        claims.sessionVersion,
        action,
        hash,
        JSON.stringify(value),
        JSON.stringify(receipt),
        now,
        ...parameters
      ),
    db
      .prepare(
        `INSERT INTO b2b_pricing_guards(id,valid) SELECT ?1,CASE WHEN changes()=1 AND EXISTS(SELECT 1 FROM b2b_pricing_commands WHERE actor_id=?2 AND command_id=?3 AND payload_hash=?4) THEN 1 ELSE 0 END`
      )
      .bind(`${claims.identityId}:${options.idempotencyKey}`, claims.identityId, options.idempotencyKey, hash),
    db.prepare('DELETE FROM b2b_pricing_guards WHERE id=?1').bind(`${claims.identityId}:${options.idempotencyKey}`)
  ]
}
export async function upsertD1B2BPriceList(
  db: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: CommandOptions
) {
  const parsed = listSchema.safeParse(input)
  if (!parsed.success) throw new B2BPricingError('invalid_input')
  const value = parsed.data
  const hash = await canonicalPayloadHash({ action: 'upsert_price_list', actorId: claims.identityId, ...value })
  const prior = await recoverB2B(db, claims, options, hash)
  if (prior) return prior
  const priceListId = value.priceListId ?? crypto.randomUUID()
  const expected = value.expectedVersion ?? 0
  const stats = expected
    ? await db
        .prepare(
          `SELECT version,
   (SELECT count(*) FROM b2b_variant_rules WHERE price_list_id=?1)+(SELECT count(*) FROM b2b_category_rules WHERE price_list_id=?1) ruleCount,
   EXISTS(SELECT 1 FROM b2b_company_assignments WHERE price_list_id=?1) assigned
   FROM b2b_price_lists WHERE id=?1`
        )
        .bind(priceListId)
        .first<{ version: number; ruleCount: number; assigned: number }>()
    : null
  if (expected && (!stats || stats.version !== expected)) throw new B2BPricingError('conflict')
  const version = expected
    ? expected +
      1 +
      Number(stats!.ruleCount) +
      (stats!.assigned ? value.variantRules.length + value.categoryRules.length : 0)
    : 1
  const receipt: B2BReceipt = { commandId: options.idempotencyKey, action: 'upsert_price_list', priceListId, version }
  const condition = expected
    ? 'EXISTS(SELECT 1 FROM b2b_price_lists WHERE id=?10 AND version=?11)'
    : 'NOT EXISTS(SELECT 1 FROM b2b_price_lists WHERE id=?10) AND ?11=0'
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const statements = commandStatements(db, claims, options, hash, receipt.action, value, receipt, condition, [
    priceListId,
    expected
  ])
  statements.push(
    db
      .prepare(
        'INSERT INTO b2b_pricing_write_context(actor_id,command_id,price_list_id,company_id) VALUES(?1,?2,?3,NULL)'
      )
      .bind(claims.identityId, options.idempotencyKey, priceListId)
  )
  if (expected)
    statements.push(
      db
        .prepare(
          'UPDATE b2b_price_lists SET code=?2,name=?3,status=?4,valid_from=?5,valid_until=?6,updated_at=?7,version=version+1 WHERE id=?1 AND version=?8'
        )
        .bind(priceListId, value.code, value.name, value.status, value.validFrom, value.validUntil, now, expected),
      db.prepare('DELETE FROM b2b_variant_rules WHERE price_list_id=?1').bind(priceListId),
      db.prepare('DELETE FROM b2b_category_rules WHERE price_list_id=?1').bind(priceListId)
    )
  else
    statements.push(
      db
        .prepare(
          'INSERT INTO b2b_price_lists(id,code,name,status,version,valid_from,valid_until,created_at,updated_at) VALUES(?1,?2,?3,?4,1,?5,?6,?7,?7)'
        )
        .bind(priceListId, value.code, value.name, value.status, value.validFrom, value.validUntil, now)
    )
  statements.push(
    db
      .prepare(
        "INSERT INTO b2b_variant_rules(price_list_id,variant_id,unit_gross_cents) SELECT ?1,json_extract(value,'$.variantId'),json_extract(value,'$.unitGrossCents') FROM json_each(?2)"
      )
      .bind(priceListId, JSON.stringify(value.variantRules)),
    db
      .prepare(
        "INSERT INTO b2b_category_rules(price_list_id,category_id,discount_basis_points) SELECT ?1,json_extract(value,'$.categoryId'),json_extract(value,'$.discountBps') FROM json_each(?2)"
      )
      .bind(priceListId, JSON.stringify(value.categoryRules)),
    db
      .prepare(
        'INSERT INTO b2b_pricing_guards(id,valid) SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM b2b_price_lists WHERE id=?2 AND version=?3) THEN 1 ELSE 0 END'
      )
      .bind(`list:${options.idempotencyKey}`, priceListId, version),
    db.prepare('DELETE FROM b2b_pricing_guards WHERE id=?1').bind(`list:${options.idempotencyKey}`),
    db.prepare('INSERT OR IGNORE INTO b2b_managed_lists(price_list_id) VALUES(?1)').bind(priceListId),
    db
      .prepare('INSERT INTO b2b_pricing_applied(actor_id,command_id) VALUES(?1,?2)')
      .bind(claims.identityId, options.idempotencyKey),
    db
      .prepare('DELETE FROM b2b_pricing_write_context WHERE actor_id=?1 AND command_id=?2')
      .bind(claims.identityId, options.idempotencyKey)
  )
  try {
    await db.batch(statements)
  } catch (error) {
    const replay = await recoverB2B(db, claims, options, hash)
    if (replay) return replay
    throw classifyB2BWriteFailure(error)
  }
  return (
    (await recoverB2B(db, claims, options, hash)) ??
    (() => {
      throw new B2BPricingError('unavailable')
    })()
  )
}
export async function assignD1CompanyB2BPriceList(
  db: D1Database,
  claims: VerifiedSessionClaims,
  companyId: string,
  input: unknown,
  options: CommandOptions
) {
  const parsed = assignmentSchema.safeParse(input)
  if (!parsed.success || !idSchema.safeParse(companyId).success) throw new B2BPricingError('invalid_input')
  const value = parsed.data
  const hash = await canonicalPayloadHash({
    action: 'assign_price_list',
    actorId: claims.identityId,
    companyId,
    ...value
  })
  const prior = await recoverB2B(db, claims, options, hash)
  if (prior) return prior
  const version = value.expectedVersion + 1
  const receipt: B2BReceipt = {
    commandId: options.idempotencyKey,
    action: 'assign_price_list',
    companyId,
    priceListId: value.priceListId,
    version
  }
  const condition = `EXISTS(SELECT 1 FROM companies c JOIN customers customer ON customer.id=c.customer_id WHERE c.id=?10 AND c.status='approved' AND customer.status='active')
    AND EXISTS(SELECT 1 FROM b2b_price_lists WHERE id=?11)
    AND COALESCE((SELECT version FROM b2b_company_assignments WHERE company_id=?10),0)=?12`
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const statements = commandStatements(
    db,
    claims,
    options,
    hash,
    receipt.action,
    { companyId, ...value },
    receipt,
    condition,
    [companyId, value.priceListId, value.expectedVersion]
  )
  statements.push(
    db
      .prepare(
        'INSERT INTO b2b_pricing_write_context(actor_id,command_id,price_list_id,company_id) VALUES(?1,?2,?3,?4)'
      )
      .bind(claims.identityId, options.idempotencyKey, value.priceListId, companyId)
  )
  statements.push(
    db
      .prepare(
        `INSERT INTO b2b_company_assignments(company_id,price_list_id,version,valid_from,valid_until,updated_at) VALUES(?1,?2,1,?3,?4,?5)
    ON CONFLICT(company_id) DO UPDATE SET price_list_id=excluded.price_list_id,active=1,version=b2b_company_assignments.version+1,valid_from=excluded.valid_from,valid_until=excluded.valid_until,updated_at=excluded.updated_at WHERE b2b_company_assignments.version=?6`
      )
      .bind(companyId, value.priceListId, value.validFrom, value.validUntil, now, value.expectedVersion),
    db
      .prepare(
        'INSERT INTO b2b_pricing_guards(id,valid) SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM b2b_company_assignments WHERE company_id=?2 AND version=?3 AND price_list_id=?4) THEN 1 ELSE 0 END'
      )
      .bind(`assignment:${options.idempotencyKey}`, companyId, version, value.priceListId),
    db.prepare('DELETE FROM b2b_pricing_guards WHERE id=?1').bind(`assignment:${options.idempotencyKey}`),
    db.prepare('INSERT OR IGNORE INTO b2b_managed_assignments(company_id) VALUES(?1)').bind(companyId),
    db
      .prepare('INSERT INTO b2b_pricing_applied(actor_id,command_id) VALUES(?1,?2)')
      .bind(claims.identityId, options.idempotencyKey),
    db
      .prepare('DELETE FROM b2b_pricing_write_context WHERE actor_id=?1 AND command_id=?2')
      .bind(claims.identityId, options.idempotencyKey)
  )
  try {
    await db.batch(statements)
  } catch (error) {
    const replay = await recoverB2B(db, claims, options, hash)
    if (replay) return replay
    throw classifyB2BWriteFailure(error)
  }
  return (
    (await recoverB2B(db, claims, options, hash)) ??
    (() => {
      throw new B2BPricingError('unavailable')
    })()
  )
}

/** Detect changes to private price authority while a projection is in flight. */
export async function readD1B2BPricingAuthority(db: D1Database, customerId: string, now: string): Promise<string> {
  const row = await db
    .prepare(
      `SELECT c.id AS companyId,c.status AS companyStatus,
    a.price_list_id AS listId,a.active AS assignmentActive,a.version AS assignmentVersion,a.valid_from AS assignmentFrom,a.valid_until AS assignmentUntil,
    l.version AS listVersion,l.status AS listStatus,l.valid_from AS listFrom,l.valid_until AS listUntil,
    CASE WHEN a.valid_from<=?2 AND (a.valid_until IS NULL OR a.valid_until>?2)
      AND l.valid_from<=?2 AND (l.valid_until IS NULL OR l.valid_until>?2) THEN 1 ELSE 0 END AS active
    FROM companies c
    LEFT JOIN b2b_company_assignments a ON a.company_id=c.id
    LEFT JOIN b2b_price_lists l ON l.id=a.price_list_id WHERE c.customer_id=?1`
    )
    .bind(customerId, now)
    .first()
  return JSON.stringify(row)
}

export async function unassignD1CompanyB2BPriceList(
  db: D1Database,
  claims: VerifiedSessionClaims,
  companyId: string,
  input: unknown,
  options: CommandOptions
) {
  const parsed = z
    .object({ expectedVersion: z.number().int().safe().positive(), reason: reasonSchema })
    .strict()
    .safeParse(input)
  if (!parsed.success || !idSchema.safeParse(companyId).success) throw new B2BPricingError('invalid_input')
  const value = parsed.data
  const hash = await canonicalPayloadHash({
    action: 'unassign_price_list',
    actorId: claims.identityId,
    companyId,
    ...value
  })
  const prior = await recoverB2B(db, claims, options, hash)
  if (prior) return prior
  const current = await db
    .prepare(
      'SELECT price_list_id AS priceListId FROM b2b_company_assignments WHERE company_id=?1 AND version=?2 AND active=1'
    )
    .bind(companyId, value.expectedVersion)
    .first<{ priceListId: string }>()
  if (!current) throw new B2BPricingError('conflict')
  const version = value.expectedVersion + 1
  const receipt: B2BReceipt = {
    commandId: options.idempotencyKey,
    action: 'unassign_price_list',
    companyId,
    priceListId: current.priceListId,
    version
  }
  const condition =
    'EXISTS(SELECT 1 FROM b2b_company_assignments WHERE company_id=?10 AND version=?11 AND active=1 AND price_list_id=?12)'
  const statements = commandStatements(
    db,
    claims,
    options,
    hash,
    receipt.action,
    { companyId, ...value },
    receipt,
    condition,
    [companyId, value.expectedVersion, current.priceListId]
  )
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  statements.push(
    db
      .prepare(
        'INSERT INTO b2b_pricing_write_context(actor_id,command_id,price_list_id,company_id) VALUES(?1,?2,?3,?4)'
      )
      .bind(claims.identityId, options.idempotencyKey, current.priceListId, companyId),
    db
      .prepare(
        'UPDATE b2b_company_assignments SET active=0,version=version+1,updated_at=?3 WHERE company_id=?1 AND version=?2 AND active=1'
      )
      .bind(companyId, value.expectedVersion, now),
    db
      .prepare(
        'INSERT INTO b2b_pricing_guards(id,valid) SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM b2b_company_assignments WHERE company_id=?2 AND version=?3 AND active=0) THEN 1 ELSE 0 END'
      )
      .bind(`unassign:${options.idempotencyKey}`, companyId, version),
    db.prepare('DELETE FROM b2b_pricing_guards WHERE id=?1').bind(`unassign:${options.idempotencyKey}`),
    db
      .prepare('INSERT INTO b2b_pricing_applied(actor_id,command_id) VALUES(?1,?2)')
      .bind(claims.identityId, options.idempotencyKey),
    db
      .prepare('DELETE FROM b2b_pricing_write_context WHERE actor_id=?1 AND command_id=?2')
      .bind(claims.identityId, options.idempotencyKey)
  )
  try {
    await db.batch(statements)
  } catch (error) {
    const replay = await recoverB2B(db, claims, options, hash)
    if (replay) return replay
    throw classifyB2BWriteFailure(error)
  }
  return (
    (await recoverB2B(db, claims, options, hash)) ??
    (() => {
      throw new B2BPricingError('unavailable')
    })()
  )
}
