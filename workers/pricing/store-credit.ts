import { z } from 'zod'
import {
  STORE_CREDIT_POLICY,
  allocateRedemption,
  evaluateIssuance,
  storeCreditIssueInputSchema
} from '../../shared/store-credit'
import {
  authorizeAdmin,
  canonicalJson,
  fail,
  recordBlocked,
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

const DAY_MS = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

interface AccountRow {
  balance_cents: number
  version: number
  frozen: number
}
const readAccount = (db: D1Database, customerId: string) =>
  db
    .prepare('SELECT balance_cents, version, frozen FROM store_credit_accounts WHERE customer_id = ?')
    .bind(customerId)
    .first<AccountRow>()

/** The balance is always derived from the grants, in the same atomic batch as the change. */
const refreshAccount = (db: D1Database, customerId: string, now: string) =>
  db
    .prepare(
      `UPDATE store_credit_accounts SET
         balance_cents = (SELECT COALESCE(SUM(remaining_cents), 0) FROM store_credit_grants
                          WHERE customer_id = ?1 AND voided_at IS NULL),
         version = version + 1, updated_at = ?2
       WHERE customer_id = ?1`
    )
    .bind(customerId, now)

const ledgerInsert = (
  db: D1Database,
  customerId: string,
  grantId: string,
  type: 'issue' | 'redeem' | 'restore',
  amountCents: number,
  orderRef: string | null,
  commandId: string,
  now: string
) =>
  db
    .prepare(
      `INSERT INTO store_credit_ledger(customer_id, grant_id, entry_type, amount_cents, order_ref, command_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(customerId, grantId, type, amountCents, orderRef, commandId, now)

/* ------------------------------------------------------------------ issuance */

export async function issueStoreCredit(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  idempotencyKey: string,
  now: string
): Promise<PricingReceipt> {
  requireIdempotencyKey(idempotencyKey)
  const parsed = storeCreditIssueInputSchema.safeParse(raw)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'issue', input }))
  const prior = await replay(db, claims.identityId, idempotencyKey, payloadHash)
  if (prior) return prior
  const customer = await db
    .prepare("SELECT 1 AS ok FROM customers WHERE id = ? AND status = 'active'")
    .bind(input.customerId)
    .first()
  if (!customer) fail('not_found')
  const account = await readAccount(db, input.customerId)
  if (account?.frozen === 1) {
    await recordBlocked(
      db,
      'store_credit',
      input.customerId,
      'issue_blocked',
      claims.identityId,
      { reason: 'frozen', amountCents: input.amountCents },
      now
    )
    fail('account_frozen')
  }
  const cutoff = iso(Date.parse(now) - STORE_CREDIT_POLICY.rollingWindowDays * DAY_MS)
  const { results } = await db
    .prepare('SELECT amount_cents FROM store_credit_grants WHERE customer_id = ? AND issued_at > ?')
    .bind(input.customerId, cutoff)
    .all<{ amount_cents: number }>()
  const verdict = evaluateIssuance({ amountCents: input.amountCents, recent: results.map((r) => r.amount_cents) })
  if (!verdict.allowed) {
    await recordBlocked(
      db,
      'store_credit',
      input.customerId,
      'issue_blocked',
      claims.identityId,
      { reason: verdict.reason, amountCents: input.amountCents, sourceRef: input.sourceRef },
      now
    )
    fail('limit_reached')
  }
  const grantId = crypto.randomUUID()
  const expiresAt = iso(Date.parse(now) + input.expiresInDays * DAY_MS)
  const balanceCents = (account?.balance_cents ?? 0) + input.amountCents
  return runCommand(db, {
    actorId: claims.identityId,
    key: idempotencyKey,
    domain: 'store_credit',
    action: 'issue',
    targetId: input.customerId,
    expectedVersion: account?.version ?? 0,
    appliedVersion: (account?.version ?? 1) + 1,
    payloadHash,
    now,
    result: { grantId, amountCents: input.amountCents, expiresAt, balanceCents },
    audit: {
      grantId,
      kind: input.kind,
      sourceRef: input.sourceRef,
      amountCents: input.amountCents,
      expiresAt,
      reason: input.reason
    },
    statements: (commandId) => [
      db
        .prepare(
          'INSERT OR IGNORE INTO store_credit_accounts(customer_id, balance_cents, version, frozen, updated_at) VALUES (?, 0, 1, 0, ?)'
        )
        .bind(input.customerId, now),
      db
        .prepare(
          `INSERT INTO store_credit_grants(id, customer_id, kind, source_ref, amount_cents, remaining_cents, reason,
             issued_by, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          grantId,
          input.customerId,
          input.kind,
          input.sourceRef,
          input.amountCents,
          input.amountCents,
          input.reason,
          claims.identityId,
          now,
          expiresAt
        ),
      ledgerInsert(db, input.customerId, grantId, 'issue', input.amountCents, null, commandId, now),
      refreshAccount(db, input.customerId, now)
    ]
  })
}

/* ------------------------------------------------------------------ redemption */

const redeemSchema = z
  .object({ orderId: z.string().min(1).max(128), amountCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
  .strict()
const MAX_FAILED_REDEMPTIONS_PER_HOUR = 5

export async function redeemStoreCredit(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  idempotencyKey: string,
  now: string
): Promise<PricingReceipt> {
  requireIdempotencyKey(idempotencyKey)
  const parsed = redeemSchema.safeParse(raw)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  const customerId = await requireCustomer(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'redeem', input }))
  const prior = await replay(db, claims.identityId, idempotencyKey, payloadHash)
  if (prior) return prior
  const order = await db
    .prepare('SELECT status, total_gross_cents, customer_id FROM orders WHERE id = ?')
    .bind(input.orderId)
    .first<{ status: string; total_gross_cents: number; customer_id: string | null }>()
  if (!order || order.customer_id !== customerId) fail('not_found')
  if (order.status !== 'awaiting_payment') fail('invalid_transition')
  // The amount to charge is fixed when a payment intent is created: credit can only be applied before that.
  const payment = await db.prepare('SELECT 1 AS ok FROM payment_intents WHERE order_id = ?').bind(input.orderId).first()
  if (payment) fail('invalid_transition')
  // PRI-018 downstream: like checkout, credit never applies to credit-terms (bank transfer of the full
  // total, B2B open amounts) or market-checkout orders, whose payment instructions are not the amount due.
  if (await paidOutsideCardCheckout(db, input.orderId)) fail('invalid_transition')
  const failed = await db
    .prepare(
      "SELECT count(*) AS n FROM pricing_audit WHERE domain = 'store_credit' AND target_id = ? AND action = 'redeem_blocked' AND created_at > ?"
    )
    .bind(customerId, iso(Date.parse(now) - 3_600_000))
    .first<{ n: number }>()
  if ((failed?.n ?? 0) >= MAX_FAILED_REDEMPTIONS_PER_HOUR) fail('limit_reached')
  const account = await readAccount(db, customerId)
  const blocked = async (reason: string): Promise<never> => {
    await recordBlocked(
      db,
      'store_credit',
      customerId,
      'redeem_blocked',
      claims.identityId,
      { reason, orderId: input.orderId, amountCents: input.amountCents },
      now
    )
    return fail(reason === 'over_order_total' ? 'overpayment' : 'insufficient_credit')
  }
  if (!account) return blocked('no_account')
  if (account.frozen === 1) fail('account_frozen')
  const already = await db
    .prepare(
      "SELECT COALESCE(-SUM(amount_cents), 0) AS used FROM store_credit_ledger WHERE order_ref = ? AND entry_type IN ('redeem', 'restore')"
    )
    .bind(input.orderId)
    .first<{ used: number }>()
  if ((already?.used ?? 0) + input.amountCents > order.total_gross_cents) return blocked('over_order_total')
  const { results } = await db
    .prepare(
      `SELECT id, remaining_cents, expires_at FROM store_credit_grants
       WHERE customer_id = ? AND voided_at IS NULL AND remaining_cents > 0 AND expires_at > ?
       ORDER BY expires_at, id LIMIT 200`
    )
    .bind(customerId, now)
    .all<{ id: string; remaining_cents: number; expires_at: string }>()
  const allocation = allocateRedemption(
    results.map((g) => ({ id: g.id, remainingCents: g.remaining_cents, expiresAt: g.expires_at })),
    input.amountCents,
    now
  )
  if (!allocation) return blocked('insufficient_funds')
  return runCommand(db, {
    actorId: claims.identityId,
    key: idempotencyKey,
    domain: 'store_credit',
    action: 'redeem',
    targetId: customerId,
    expectedVersion: account.version,
    appliedVersion: account.version + 1,
    payloadHash,
    now,
    result: {
      orderId: input.orderId,
      redeemedCents: input.amountCents,
      balanceCents: account.balance_cents - input.amountCents
    },
    audit: { orderId: input.orderId, amountCents: input.amountCents, allocation },
    statements: (commandId) => [
      ...allocation.flatMap((a) => [
        db
          .prepare('UPDATE store_credit_grants SET remaining_cents = remaining_cents - ? WHERE id = ?')
          .bind(a.cents, a.grantId),
        ledgerInsert(db, customerId, a.grantId, 'redeem', -a.cents, input.orderId, commandId, now)
      ]),
      refreshAccount(db, customerId, now)
    ]
  })
}

async function paidOutsideCardCheckout(db: D1Database, orderId: string): Promise<boolean> {
  const terms = await db
    .prepare(
      "SELECT 1 AS ok FROM order_events WHERE order_id = ? AND event_type = 'order.created' AND json_extract(payload_json, '$.paymentMethod') = 'transferencia'"
    )
    .bind(orderId)
    .first()
  if (terms) return true
  try {
    return Boolean(
      await db.prepare('SELECT 1 AS ok FROM order_market_snapshots WHERE order_id = ?').bind(orderId).first()
    )
  } catch (error) {
    // Databases without market checkout (before 0118) have no market orders.
    if (error instanceof Error && /no such table:?\s*(main\.)?order_market_snapshots/.test(error.message)) return false
    throw error
  }
}

/* ------------------------------------------------------------------ restore / void / freeze / expire */

export async function restoreStoreCredit(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  idempotencyKey: string,
  now: string
): Promise<PricingReceipt> {
  requireIdempotencyKey(idempotencyKey)
  const parsed = z
    .object({ orderId: z.string().min(1).max(128) })
    .strict()
    .safeParse(raw)
  if (!parsed.success) fail('invalid_input')
  await authorizeAdmin(db, claims, now)
  const { orderId } = parsed.data
  const payloadHash = await sha256Hex(canonicalJson({ action: 'restore', orderId }))
  const prior = await replay(db, claims.identityId, idempotencyKey, payloadHash)
  if (prior) return prior
  const order = await db
    .prepare('SELECT status, customer_id FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ status: string; customer_id: string | null }>()
  if (!order?.customer_id) fail('not_found')
  if (order.status !== 'cancelled') fail('invalid_transition')
  const customerId = order.customer_id
  const { results } = await db
    .prepare(
      `SELECT l.grant_id AS grantId, -SUM(l.amount_cents) AS net FROM store_credit_ledger l
       JOIN store_credit_grants g ON g.id = l.grant_id AND g.voided_at IS NULL
       WHERE l.order_ref = ? AND l.entry_type IN ('redeem', 'restore') GROUP BY l.grant_id HAVING net > 0`
    )
    .bind(orderId)
    .all<{ grantId: string; net: number }>()
  const account = await readAccount(db, customerId)
  if (!account || results.length === 0) fail('not_found')
  const restored = results.reduce((n, r) => n + r.net, 0)
  return runCommand(db, {
    actorId: claims.identityId,
    key: idempotencyKey,
    domain: 'store_credit',
    action: 'restore',
    targetId: customerId,
    expectedVersion: account.version,
    appliedVersion: account.version + 1,
    payloadHash,
    now,
    result: { orderId, restoredCents: restored, balanceCents: account.balance_cents + restored },
    audit: { orderId, restored: results },
    statements: (commandId) => [
      ...results.flatMap((r) => [
        db
          .prepare('UPDATE store_credit_grants SET remaining_cents = remaining_cents + ? WHERE id = ?')
          .bind(r.net, r.grantId),
        ledgerInsert(db, customerId, r.grantId, 'restore', r.net, orderId, commandId, now)
      ]),
      refreshAccount(db, customerId, now)
    ]
  })
}

export async function voidStoreCreditGrant(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  idempotencyKey: string,
  now: string
): Promise<PricingReceipt> {
  requireIdempotencyKey(idempotencyKey)
  const parsed = z
    .object({ grantId: z.string().uuid(), reason: z.string().trim().min(10).max(300) })
    .strict()
    .safeParse(raw)
  if (!parsed.success) fail('invalid_input')
  await authorizeAdmin(db, claims, now)
  const { grantId, reason } = parsed.data
  const payloadHash = await sha256Hex(canonicalJson({ action: 'void', grantId, reason }))
  const prior = await replay(db, claims.identityId, idempotencyKey, payloadHash)
  if (prior) return prior
  const grant = await db
    .prepare('SELECT customer_id, remaining_cents, voided_at FROM store_credit_grants WHERE id = ?')
    .bind(grantId)
    .first<{ customer_id: string; remaining_cents: number; voided_at: string | null }>()
  if (!grant) fail('not_found')
  if (grant.voided_at !== null || grant.remaining_cents === 0) fail('invalid_transition')
  const account = await readAccount(db, grant.customer_id)
  if (!account) fail('not_found')
  return runCommand(db, {
    actorId: claims.identityId,
    key: idempotencyKey,
    domain: 'store_credit',
    action: 'void',
    targetId: grant.customer_id,
    expectedVersion: account.version,
    appliedVersion: account.version + 1,
    payloadHash,
    now,
    result: {
      grantId,
      voidedCents: grant.remaining_cents,
      balanceCents: account.balance_cents - grant.remaining_cents
    },
    audit: { grantId, voidedCents: grant.remaining_cents, reason },
    statements: (commandId) => [
      db
        .prepare(
          `INSERT INTO store_credit_ledger(customer_id, grant_id, entry_type, amount_cents, order_ref, command_id, created_at)
           SELECT customer_id, id, 'void', -remaining_cents, NULL, ?, ? FROM store_credit_grants
           WHERE id = ? AND remaining_cents = ? AND voided_at IS NULL`
        )
        .bind(commandId, now, grantId, grant.remaining_cents),
      db
        .prepare(
          'UPDATE store_credit_grants SET remaining_cents = 0, voided_at = ? WHERE id = ? AND remaining_cents = ?'
        )
        .bind(now, grantId, grant.remaining_cents),
      refreshAccount(db, grant.customer_id, now)
    ]
  })
}

export async function freezeStoreCredit(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  expectedVersion: number,
  idempotencyKey: string,
  now: string
): Promise<PricingReceipt> {
  requireIdempotencyKey(idempotencyKey)
  requireVersion(expectedVersion)
  const parsed = z
    .object({ customerId: z.string().uuid(), frozen: z.boolean(), reason: z.string().trim().min(10).max(300) })
    .strict()
    .safeParse(raw)
  if (!parsed.success) fail('invalid_input')
  await authorizeAdmin(db, claims, now)
  const input = parsed.data
  const payloadHash = await sha256Hex(canonicalJson({ action: 'freeze', expectedVersion, input }))
  const prior = await replay(db, claims.identityId, idempotencyKey, payloadHash)
  if (prior) return prior
  const account = await readAccount(db, input.customerId)
  if (!account) fail('not_found')
  if (account.version !== expectedVersion) fail('version_conflict')
  return runCommand(db, {
    actorId: claims.identityId,
    key: idempotencyKey,
    domain: 'store_credit',
    action: input.frozen ? 'freeze' : 'unfreeze',
    targetId: input.customerId,
    expectedVersion,
    appliedVersion: expectedVersion + 1,
    payloadHash,
    now,
    audit: { frozen: input.frozen, reason: input.reason },
    statements: () => [
      db
        .prepare(
          'UPDATE store_credit_accounts SET frozen = ?, version = version + 1, updated_at = ? WHERE customer_id = ? AND version = ?'
        )
        .bind(input.frozen ? 1 : 0, now, input.customerId, expectedVersion)
    ]
  })
}

/** Bounded sweep: expires due grants exactly once; raced grants are left for the next sweep. */
export async function expireDueStoreCredit(
  db: D1Database,
  claims: VerifiedSessionClaims,
  idempotencyKey: string,
  now: string,
  limit = 50
): Promise<PricingReceipt> {
  requireIdempotencyKey(idempotencyKey)
  await authorizeAdmin(db, claims, now)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'expire', limit }))
  const prior = await replay(db, claims.identityId, idempotencyKey, payloadHash)
  if (prior) return prior
  const { results } = await db
    .prepare(
      `SELECT id, customer_id, remaining_cents FROM store_credit_grants
       WHERE remaining_cents > 0 AND voided_at IS NULL AND expires_at <= ? ORDER BY expires_at, id LIMIT ?`
    )
    .bind(now, Math.min(Math.max(1, limit), 200))
    .all<{ id: string; customer_id: string; remaining_cents: number }>()
  const expiredCents = results.reduce((n, g) => n + g.remaining_cents, 0)
  if (results.length === 0)
    return {
      commandId: crypto.randomUUID(),
      domain: 'store_credit',
      action: 'expire',
      targetId: 'sweep',
      appliedVersion: 1,
      payloadHash,
      recordedAt: now,
      result: { expiredGrants: 0, expiredCents: 0 }
    }
  const customers = [...new Set(results.map((g) => g.customer_id))]
  return runCommand(db, {
    actorId: claims.identityId,
    key: idempotencyKey,
    domain: 'store_credit',
    action: 'expire',
    targetId: `sweep:${crypto.randomUUID()}`,
    expectedVersion: 0,
    appliedVersion: 1,
    payloadHash,
    now,
    result: { expiredGrants: results.length, expiredCents },
    audit: { grants: results.map((g) => ({ id: g.id, cents: g.remaining_cents })) },
    statements: (commandId) => [
      ...results.flatMap((g) => [
        db
          .prepare(
            `INSERT INTO store_credit_ledger(customer_id, grant_id, entry_type, amount_cents, order_ref, command_id, created_at)
             SELECT customer_id, id, 'expire', -remaining_cents, NULL, ?, ? FROM store_credit_grants
             WHERE id = ? AND remaining_cents = ? AND voided_at IS NULL`
          )
          .bind(commandId, now, g.id, g.remaining_cents),
        db
          .prepare('UPDATE store_credit_grants SET remaining_cents = 0 WHERE id = ? AND remaining_cents = ?')
          .bind(g.id, g.remaining_cents)
      ]),
      ...customers.map((customerId) => refreshAccount(db, customerId, now))
    ]
  })
}

/* ------------------------------------------------------------------ reads */

export async function reconcileStoreCredit(
  db: D1Database,
  claims: VerifiedSessionClaims,
  customerId: string,
  now: string
) {
  requireUuid(customerId)
  await authorizeAdmin(db, claims, now)
  const row = await db
    .prepare(
      `SELECT a.balance_cents AS balanceCents,
         (SELECT COALESCE(SUM(amount_cents), 0) FROM store_credit_ledger WHERE customer_id = a.customer_id) AS ledgerSumCents,
         (SELECT COALESCE(SUM(remaining_cents), 0) FROM store_credit_grants WHERE customer_id = a.customer_id AND voided_at IS NULL) AS grantsRemainingCents
       FROM store_credit_accounts a WHERE a.customer_id = ?`
    )
    .bind(customerId)
    .first<{ balanceCents: number; ledgerSumCents: number; grantsRemainingCents: number }>()
  if (!row) fail('not_found')
  return {
    ...row,
    consistent: row.balanceCents === row.ledgerSumCents && row.balanceCents === row.grantsRemainingCents
  }
}

/** Customer view: spendable balance and own movements only; no operator, source or reason data. */
export async function getStoreCreditSummary(db: D1Database, claims: VerifiedSessionClaims, now: string) {
  const customerId = await requireCustomer(db, claims, now)
  const [grants, ledger] = await db.batch([
    db
      .prepare(
        `SELECT id, kind, remaining_cents AS remainingCents, expires_at AS expiresAt FROM store_credit_grants
         WHERE customer_id = ? AND voided_at IS NULL AND remaining_cents > 0 AND expires_at > ? ORDER BY expires_at, id LIMIT 100`
      )
      .bind(customerId, now),
    db
      .prepare(
        `SELECT entry_type AS entryType, amount_cents AS amountCents, order_ref AS orderId, created_at AS createdAt
         FROM store_credit_ledger WHERE customer_id = ? ORDER BY id DESC LIMIT 20`
      )
      .bind(customerId)
  ])
  const rows = grants!.results as Array<{ id: string; kind: string; remainingCents: number; expiresAt: string }>
  return {
    balanceCents: rows.reduce((n, g) => n + g.remainingCents, 0),
    grants: rows,
    movements: ledger!.results
  }
}
