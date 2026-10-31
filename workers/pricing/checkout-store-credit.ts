import { allocateRedemption } from '../../shared/store-credit'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { ifPricingTable } from './rules-read'

/**
 * PRI-018 wiring: store credit is deducted from the amount to CHARGE (order total stays contractual).
 * The credit ledger of 0148 is the single source of truth: due = total - net(redeem, restore) per order.
 */

export interface StoreCreditRedemptionFlagInput {
  storeCreditRedemptionEnabled?: boolean
  STORE_CREDIT_REDEMPTION_ENABLED?: string
}

/**
 * Store credit redemption reduces the amount charged below order total.
 * Disabled by default until downstream consumers adopt amountDueCents.
 */
export function isStoreCreditRedemptionEnabled(options?: StoreCreditRedemptionFlagInput | null): boolean {
  if (typeof options?.storeCreditRedemptionEnabled === 'boolean') {
    return options.storeCreditRedemptionEnabled
  }
  if (typeof options?.STORE_CREDIT_REDEMPTION_ENABLED === 'string') {
    return options.STORE_CREDIT_REDEMPTION_ENABLED === 'true'
  }
  const envFlag = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.STORE_CREDIT_REDEMPTION_ENABLED
  return envFlag === 'true'
}

/** Net credit currently applied to an order (0 when the credit tables do not exist). */
export async function redeemedStoreCreditCents(db: D1Database, orderId: string): Promise<number> {
  const row = await ifPricingTable(
    () =>
      db
        .prepare(
          "SELECT COALESCE(-SUM(amount_cents), 0) AS cents FROM store_credit_ledger WHERE order_ref = ?1 AND entry_type IN ('redeem', 'restore')"
        )
        .bind(orderId)
        .first<{ cents: number }>(),
    null
  )
  return Number(row?.cents ?? 0)
}

export interface CheckoutCreditPlan {
  customerId: string
  accountVersion: number
  totalCents: number
  allocations: Array<{ grantId: string; cents: number }>
}

/** FIFO plan against live grants; null when the account is missing, frozen or lacks funds. */
export async function planCheckoutRedemption(
  db: D1Database,
  customerId: string,
  amountCents: number,
  now: string
): Promise<CheckoutCreditPlan | null> {
  const account = await ifPricingTable(
    () =>
      db
        .prepare('SELECT version, frozen FROM store_credit_accounts WHERE customer_id = ?1')
        .bind(customerId)
        .first<{ version: number; frozen: number }>(),
    null
  )
  if (!account || account.frozen === 1) return null
  const { results } = await db
    .prepare(
      `SELECT id, remaining_cents, expires_at FROM store_credit_grants
       WHERE customer_id = ?1 AND voided_at IS NULL AND remaining_cents > 0 AND expires_at > ?2
       ORDER BY expires_at, id LIMIT 200`
    )
    .bind(customerId, now)
    .all<{ id: string; remaining_cents: number; expires_at: string }>()
  const allocations = allocateRedemption(
    results.map((grant) => ({ id: grant.id, remainingCents: grant.remaining_cents, expiresAt: grant.expires_at })),
    amountCents,
    now
  )
  return allocations ? { customerId, accountVersion: account.version, totalCents: amountCents, allocations } : null
}

/**
 * Statements for the placeOrder batch (the order row must already be inserted by an earlier statement).
 * CAS on the account version aborts the whole order when another writer spent, froze or voided credit
 * after the plan was read; the unique (grant, order) index and the ledger triggers back it up.
 */
export async function checkoutRedemptionStatements(
  db: D1Database,
  input: { plan: CheckoutCreditPlan; actorId: string; orderId: string; attemptId: string; now: string }
): Promise<{ statements: D1PreparedStatement[]; commandKey: string }> {
  const { plan } = input
  const commandId = crypto.randomUUID()
  const commandKey = `checkout-redeem:${input.attemptId}`
  const payloadHash = await sha256Hex(canonicalJson({ orderId: input.orderId, allocations: plan.allocations }))
  const receipt = {
    commandId,
    domain: 'store_credit',
    action: 'redeem',
    targetId: plan.customerId,
    appliedVersion: plan.accountVersion + 1,
    payloadHash,
    recordedAt: input.now,
    result: { orderId: input.orderId, redeemedCents: plan.totalCents, source: 'checkout' }
  }
  return {
    commandKey,
    statements: [
      db
        .prepare(
          `INSERT INTO pricing_commands(command_id, actor_id, domain, action, target_id, idempotency_key,
             expected_version, applied_version, payload_hash, receipt_json, created_at)
           VALUES (?1, ?2, 'store_credit', 'redeem', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
        )
        .bind(
          commandId,
          input.actorId,
          plan.customerId,
          commandKey,
          plan.accountVersion,
          plan.accountVersion + 1,
          payloadHash,
          JSON.stringify(receipt),
          input.now
        ),
      ...plan.allocations.flatMap((allocation) => [
        db
          .prepare('UPDATE store_credit_grants SET remaining_cents = remaining_cents - ?1 WHERE id = ?2')
          .bind(allocation.cents, allocation.grantId),
        db
          .prepare(
            `INSERT INTO store_credit_ledger(customer_id, grant_id, entry_type, amount_cents, order_ref, command_id, created_at)
             VALUES (?1, ?2, 'redeem', ?3, ?4, ?5, ?6)`
          )
          .bind(plan.customerId, allocation.grantId, -allocation.cents, input.orderId, commandId, input.now)
      ]),
      refreshAccountStatement(db, plan.customerId, input.now),
      db
        .prepare(
          `INSERT INTO pricing_audit(domain, target_id, action, actor_id, outcome, detail_json, created_at)
           VALUES ('store_credit', ?1, 'redeem', ?2, 'applied', ?3, ?4)`
        )
        .bind(
          plan.customerId,
          input.actorId,
          JSON.stringify({
            commandId,
            orderId: input.orderId,
            amountCents: plan.totalCents,
            allocation: plan.allocations,
            source: 'checkout'
          }),
          input.now
        )
    ]
  }
}

const refreshAccountStatement = (db: D1Database, customerId: string, now: string) =>
  db
    .prepare(
      `UPDATE store_credit_accounts SET
         balance_cents = (SELECT COALESCE(SUM(remaining_cents), 0) FROM store_credit_grants
                          WHERE customer_id = ?1 AND voided_at IS NULL),
         version = version + 1, updated_at = ?2
       WHERE customer_id = ?1`
    )
    .bind(customerId, now)
