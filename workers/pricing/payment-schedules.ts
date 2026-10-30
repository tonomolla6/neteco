import { z } from 'zod'
import {
  buildPaymentSchedule,
  paymentScheduleInputSchema,
  reconcileSchedule,
  type LedgerEntryLike,
  type PlannedInstallment
} from '../../shared/payment-schedule'
import {
  authorizeAdmin,
  canonicalJson,
  fail,
  replay,
  requireCustomer,
  requireIdempotencyKey,
  requireUuid,
  requireVersion,
  runCommand,
  sha256Hex,
  type PricingReceipt,
  type VerifiedSessionClaims
} from './common'

interface ScheduleRow {
  id: string
  quote_id: string
  customer_id: string
  total_gross_cents: number
  status: 'active' | 'cancelled'
  version: number
}
const readSchedule = (db: D1Database, id: string) =>
  db
    .prepare('SELECT id, quote_id, customer_id, total_gross_cents, status, version FROM payment_schedules WHERE id = ?')
    .bind(id)
    .first<ScheduleRow>()

async function loadLedger(db: D1Database, scheduleId: string) {
  const [plan, entries] = await db.batch([
    db
      .prepare(
        'SELECT seq, kind, due_cents AS dueCents, due_at AS dueAt FROM payment_schedule_installments WHERE schedule_id = ? ORDER BY seq'
      )
      .bind(scheduleId),
    db
      .prepare(
        'SELECT id, seq, entry_type AS entryType, amount_cents AS amountCents, external_ref AS externalRef, created_at AS createdAt FROM payment_schedule_ledger WHERE schedule_id = ? ORDER BY id'
      )
      .bind(scheduleId)
  ])
  return {
    plan: plan!.results as unknown as PlannedInstallment[],
    entries: entries!.results as unknown as Array<
      LedgerEntryLike & { id: number; externalRef: string; createdAt: string }
    >
  }
}

const createSchema = paymentScheduleInputSchema.extend({ quoteId: z.string().uuid() }).strict()

/**
 * The debt is the approved quote's total as stored on the server; the request can only
 * choose the deposit share, the number of instalments and their spacing.
 */
export async function createPaymentSchedule(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  idempotencyKey: string,
  now: string
): Promise<PricingReceipt> {
  requireIdempotencyKey(idempotencyKey)
  const parsed = createSchema.safeParse(raw)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'create', input }))
  const prior = await replay(db, claims.identityId, idempotencyKey, payloadHash)
  if (prior) return prior
  const quote = await db
    .prepare(
      `SELECT q.customer_id AS customerId, v.version, v.status,
              json_extract(v.snapshot_json, '$.total.grossCents') AS totalGrossCents
       FROM sales_quotes q JOIN sales_quote_versions v ON v.quote_id = q.id AND v.version = q.current_version
       WHERE q.id = ?`
    )
    .bind(input.quoteId)
    .first<{ customerId: string; version: number; status: string; totalGrossCents: unknown }>()
  if (!quote) fail('not_found')
  if (quote.status !== 'approved') fail('invalid_transition')
  const total = quote.totalGrossCents
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 1) fail('invalid_input')
  let installments: PlannedInstallment[]
  try {
    installments = buildPaymentSchedule({
      totalGrossCents: total,
      depositBasisPoints: input.depositBasisPoints,
      installments: input.installments,
      intervalDays: input.intervalDays,
      now
    })
  } catch {
    fail('invalid_input')
  }
  const id = crypto.randomUUID()
  return runCommand(db, {
    actorId: claims.identityId,
    key: idempotencyKey,
    domain: 'payment_schedule',
    action: 'create',
    targetId: id,
    expectedVersion: 0,
    appliedVersion: 1,
    payloadHash,
    now,
    result: { scheduleId: id, totalGrossCents: total, installments: installments.length },
    audit: { quoteId: input.quoteId, quoteVersion: quote.version, totalGrossCents: total, plan: installments },
    statements: () => [
      db
        .prepare(
          `INSERT INTO payment_schedules(id, quote_id, quote_version, customer_id, total_gross_cents, status, version,
             created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`
        )
        .bind(id, input.quoteId, quote.version, quote.customerId, total, claims.identityId, now, now),
      ...installments.map((p) =>
        db
          .prepare(
            'INSERT INTO payment_schedule_installments(schedule_id, seq, kind, due_cents, due_at) VALUES (?, ?, ?, ?, ?)'
          )
          .bind(id, p.seq, p.kind, p.dueCents, p.dueAt)
      )
    ]
  })
}

const entrySchema = z
  .object({
    entryType: z.enum(['capture', 'refund', 'invoice', 'credit_note']),
    seq: z.number().int().min(1).max(12).optional(),
    amountCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    externalRef: z.string().trim().min(3).max(128)
  })
  .strict()
  .refine((v) => (v.entryType === 'capture') === (v.seq !== undefined))

/** Books money or a fiscal document. Amounts come from the operator/PSP adapter, never the customer. */
export async function recordScheduleEntry(
  db: D1Database,
  claims: VerifiedSessionClaims,
  scheduleId: string,
  raw: unknown,
  expectedVersion: number,
  idempotencyKey: string,
  now: string
): Promise<PricingReceipt> {
  requireIdempotencyKey(idempotencyKey)
  requireUuid(scheduleId)
  requireVersion(expectedVersion)
  const parsed = entrySchema.safeParse(raw)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'entry', scheduleId, expectedVersion, input }))
  const prior = await replay(db, claims.identityId, idempotencyKey, payloadHash)
  if (prior) return prior
  const schedule = await readSchedule(db, scheduleId)
  if (!schedule) fail('not_found')
  if (schedule.status !== 'active') fail('invalid_transition')
  if (schedule.version !== expectedVersion) fail('version_conflict')
  const { plan, entries } = await loadLedger(db, scheduleId)
  if (input.entryType === 'capture' && !plan.some((p) => p.seq === input.seq)) fail('invalid_input')
  const after = reconcileSchedule(schedule.total_gross_cents, plan, [
    ...entries,
    { entryType: input.entryType, seq: input.seq ?? null, amountCents: input.amountCents }
  ])
  const netCash = after.capturedCents - after.refundedCents
  const netInvoiced = after.invoicedCents - after.creditedCents
  // A refund may leave invoices uncovered (that is a credit note due); an invoice may not outrun cash.
  if (!after.consistent || (input.entryType === 'invoice' && netInvoiced > netCash)) fail('overpayment')
  const version = expectedVersion + 1
  return runCommand(db, {
    actorId: claims.identityId,
    key: idempotencyKey,
    domain: 'payment_schedule',
    action: input.entryType,
    targetId: scheduleId,
    expectedVersion,
    appliedVersion: version,
    payloadHash,
    now,
    result: { remainingCents: after.remainingCents, capturedCents: after.capturedCents, settled: after.settled },
    audit: {
      entryType: input.entryType,
      seq: input.seq ?? null,
      amountCents: input.amountCents,
      externalRef: input.externalRef
    },
    statements: (commandId) => [
      db
        .prepare('UPDATE payment_schedules SET version = ?, updated_at = ? WHERE id = ? AND version = ?')
        .bind(version, now, scheduleId, expectedVersion),
      db
        .prepare(
          `INSERT INTO payment_schedule_ledger(schedule_id, seq, entry_type, amount_cents, external_ref, command_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(scheduleId, input.seq ?? null, input.entryType, input.amountCents, input.externalRef, commandId, now)
    ]
  })
}

export async function cancelPaymentSchedule(
  db: D1Database,
  claims: VerifiedSessionClaims,
  scheduleId: string,
  expectedVersion: number,
  idempotencyKey: string,
  now: string
): Promise<PricingReceipt> {
  requireIdempotencyKey(idempotencyKey)
  requireUuid(scheduleId)
  requireVersion(expectedVersion)
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'cancel', scheduleId, expectedVersion }))
  const prior = await replay(db, claims.identityId, idempotencyKey, payloadHash)
  if (prior) return prior
  const schedule = await readSchedule(db, scheduleId)
  if (!schedule) fail('not_found')
  if (schedule.status !== 'active') fail('invalid_transition')
  if (schedule.version !== expectedVersion) fail('version_conflict')
  const { plan, entries } = await loadLedger(db, scheduleId)
  const r = reconcileSchedule(schedule.total_gross_cents, plan, entries)
  if (r.capturedCents - r.refundedCents !== 0 || r.invoicedCents - r.creditedCents !== 0) fail('invalid_transition')
  return runCommand(db, {
    actorId: claims.identityId,
    key: idempotencyKey,
    domain: 'payment_schedule',
    action: 'cancel',
    targetId: scheduleId,
    expectedVersion,
    appliedVersion: expectedVersion + 1,
    payloadHash,
    now,
    audit: { quoteId: schedule.quote_id },
    statements: () => [
      db
        .prepare(
          "UPDATE payment_schedules SET status = 'cancelled', version = ?, updated_at = ? WHERE id = ? AND version = ?"
        )
        .bind(expectedVersion + 1, now, scheduleId, expectedVersion)
    ]
  })
}

export async function getScheduleReconciliation(
  db: D1Database,
  claims: VerifiedSessionClaims,
  scheduleId: string,
  now: string
) {
  requireUuid(scheduleId)
  await authorizeAdmin(db, claims, now)
  const schedule = await readSchedule(db, scheduleId)
  if (!schedule) fail('not_found')
  const { plan, entries } = await loadLedger(db, scheduleId)
  return {
    scheduleId,
    quoteId: schedule.quote_id,
    status: schedule.status,
    version: schedule.version,
    ...reconcileSchedule(schedule.total_gross_cents, plan, entries),
    entries
  }
}

/** Customer view by quote: amounts and dates only; no provider references or operators. */
export async function getCustomerPaymentSchedule(
  db: D1Database,
  claims: VerifiedSessionClaims,
  quoteId: string,
  now: string
) {
  const customerId = await requireCustomer(db, claims, now)
  requireUuid(quoteId)
  const schedule = await db
    .prepare(
      `SELECT id, total_gross_cents, status, version FROM payment_schedules
       WHERE quote_id = ? AND customer_id = ? ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1`
    )
    .bind(quoteId, customerId)
    .first<{ id: string; total_gross_cents: number; status: string; version: number }>()
  if (!schedule) fail('not_found')
  const { plan, entries } = await loadLedger(db, schedule.id)
  const r = reconcileSchedule(schedule.total_gross_cents, plan, entries)
  return {
    quoteId,
    status: schedule.status,
    dueCents: r.dueCents,
    capturedCents: r.capturedCents,
    refundedCents: r.refundedCents,
    remainingCents: r.remainingCents,
    installments: r.installments.map((i) => ({
      ...i,
      kind: plan.find((p) => p.seq === i.seq)!.kind,
      dueAt: plan.find((p) => p.seq === i.seq)!.dueAt
    }))
  }
}
