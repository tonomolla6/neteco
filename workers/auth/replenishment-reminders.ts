import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import {
  REPLENISHMENT_CAP,
  REPLENISHMENT_MAX_INTERVAL_DAYS,
  REPLENISHMENT_MIN_INTERVAL_DAYS,
  replenishmentListSchema,
  replenishmentPlanInputSchema,
  replenishmentPlanReceiptSchema
} from '../../shared/replenishment-reminders'
import {
  customerAuthority,
  finalCustomer,
  lifecycleBindings,
  lifecycleFail,
  lifecycleNow,
  lifecycleUuid,
  type AccountLifecycleOptions
} from './account-lifecycle-core'

const DAY = 86400000
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const addDays = (at: string, days: number) => iso(Date.parse(at) + days * DAY)
const PAID_PURCHASES = `FROM orders o JOIN order_lines l ON l.order_id=o.id JOIN order_payment_states s ON s.order_id=o.id AND s.status='paid'`

const planRow = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().min(1),
    source: z.enum(['history', 'declared']),
    interval_days: z.number().int(),
    status: z.enum(['active', 'paused', 'cancelled']),
    next_due_at: catalogPolicyInstantSchema
  })
  .strict()
async function existingPlan(db: D1Database, customerId: string, variantId: string) {
  const raw = await db
    .prepare(
      'SELECT id,version,source,interval_days,status,next_due_at FROM replenishment_plans WHERE customer_id=?1 AND variant_id=?2'
    )
    .bind(customerId, variantId)
    .first()
  if (raw === null) return null
  const parsed = planRow.safeParse(raw)
  return parsed.success ? parsed.data : lifecycleFail('unavailable')
}
/** Paid purchase instants of one variant for one customer, newest first. */
async function purchases(db: D1Database, customerId: string, variantId: string, now: string) {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT o.created_at at ${PAID_PURCHASES} WHERE o.customer_id=?1 AND l.variant_id=?2 AND o.created_at<=?3 ORDER BY o.created_at DESC LIMIT 24`
    )
    .bind(customerId, variantId, now)
    .all<{ at: string }>()
  return results.map((row) => row.at)
}
/** Median gap (days) between consecutive paid purchases, clamped to the policy range. */
export function deriveIntervalDays(instants: string[]): number | null {
  const times = instants.map((at) => Date.parse(at)).sort((a, b) => a - b)
  if (times.length < 2) return null
  const gaps = times
    .slice(1)
    .map((time, i) => Math.round((time - times[i]!) / DAY))
    .sort((a, b) => a - b)
  const mid = Math.floor(gaps.length / 2),
    median = gaps.length % 2 ? gaps[mid]! : Math.round((gaps[mid - 1]! + gaps[mid]!) / 2)
  return Math.min(Math.max(median, REPLENISHMENT_MIN_INTERVAL_DAYS), REPLENISHMENT_MAX_INTERVAL_DAYS)
}
const commandRow = z
  .object({
    payload_hash: z.string(),
    plan_id: z.string().uuid(),
    variant_id: z.string(),
    applied_version: z.number().int(),
    source: z.enum(['history', 'declared']),
    interval_days: z.number().int(),
    status: z.enum(['active', 'paused', 'cancelled']),
    next_due_at: catalogPolicyInstantSchema,
    recorded_at: catalogPolicyInstantSchema
  })
  .strict()
async function storedCommand(db: D1Database, customerId: string, actorId: string, key: string) {
  const raw = await db
    .prepare(
      `SELECT payload_hash,plan_id,variant_id,applied_version,source,interval_days,status,next_due_at,recorded_at
 FROM replenishment_plan_commands WHERE customer_id=?1 AND command_id=?2 AND actor_id=?3`
    )
    .bind(customerId, key, actorId)
    .first()
  if (raw === null) return null
  const row = commandRow.safeParse(raw)
  if (!row.success) return lifecycleFail('unavailable')
  const receipt = replenishmentPlanReceiptSchema.safeParse({
    source: 'cloudflare',
    commandId: key,
    planId: row.data.plan_id,
    variantId: row.data.variant_id,
    version: row.data.applied_version,
    status: row.data.status,
    planSource: row.data.source,
    intervalDays: row.data.interval_days,
    nextDueAt: row.data.next_due_at,
    recordedAt: row.data.recorded_at
  })
  if (!receipt.success) return lifecycleFail('unavailable')
  return { hash: row.data.payload_hash, receipt: receipt.data }
}
export async function saveD1ReplenishmentPlan(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  input: unknown,
  options: AccountLifecycleOptions = {}
) {
  const parsed = replenishmentPlanInputSchema.safeParse(input)
  if (!parsed.success || !lifecycleUuid.safeParse(key).success) return lifecycleFail('invalid_input')
  const value = parsed.data,
    owner = await customerAuthority(db, claims, options),
    hash = await canonicalPayloadHash({ customerId: owner.customerId, actorId: owner.actorId, ...value }),
    previous = await storedCommand(db, owner.customerId, owner.actorId, key)
  if (previous) {
    await finalCustomer(db, claims, owner.customerId, options)
    if (previous.hash !== hash) return lifecycleFail('conflict')
    return previous.receipt
  }
  const now = lifecycleNow(options),
    current = await existingPlan(db, owner.customerId, value.variantId)
  if ((current?.version ?? 0) !== value.expectedVersion) return lifecycleFail('conflict')
  const variant = await db
    .prepare("SELECT 1 ok FROM variants WHERE id=?1 AND status='published'")
    .bind(value.variantId)
    .first()
  if (variant === null) return lifecycleFail('not_found')
  let status: 'active' | 'paused' | 'cancelled', source: 'history' | 'declared', interval: number, nextDue: string
  if (value.action === 'save') {
    const bought = await purchases(db, owner.customerId, value.variantId, now)
    source = value.source!
    if (source === 'history') {
      const derived = deriveIntervalDays(bought)
      if (derived === null) return lifecycleFail('insufficient_history')
      interval = derived
    } else interval = value.intervalDays!
    const due = addDays(bought[0] ?? now, interval)
    nextDue = due < now ? now : due
    status = 'active'
  } else {
    if (!current) return lifecycleFail('not_found')
    const allowed = { pause: 'active', resume: 'paused' } as const
    if (value.action === 'cancel' ? current.status === 'cancelled' : current.status !== allowed[value.action])
      return lifecycleFail('invalid_input')
    status = value.action === 'pause' ? 'paused' : value.action === 'resume' ? 'active' : 'cancelled'
    source = current.source
    interval = current.interval_days
    nextDue = value.action === 'resume' && current.next_due_at < now ? now : current.next_due_at
  }
  try {
    await db
      .prepare(
        `INSERT INTO replenishment_plan_commands(customer_id,command_id,actor_id,session_id,session_version,payload_hash,plan_id,variant_id,action,
 expected_version,applied_version,source,interval_days,status,next_due_at,recorded_at)
 VALUES(?5,?6,?3,?2,?4,?7,?8,?9,?10,?11,?11+1,?12,?13,?14,?15,?1)`
      )
      .bind(
        ...lifecycleBindings(claims, now),
        owner.customerId,
        key,
        hash,
        current?.id ?? crypto.randomUUID(),
        value.variantId,
        value.action,
        value.expectedVersion,
        source,
        interval,
        status,
        nextDue
      )
      .run()
  } catch {
    /* Read the durable command: a lost response does not prove absence. */
  }
  const recovered = await storedCommand(db, owner.customerId, owner.actorId, key)
  await finalCustomer(db, claims, owner.customerId, options)
  if (recovered) return recovered.hash === hash ? recovered.receipt : lifecycleFail('conflict')
  const fresh = await existingPlan(db, owner.customerId, value.variantId)
  return lifecycleFail((fresh?.version ?? 0) !== value.expectedVersion ? 'conflict' : 'unavailable')
}
export async function listD1ReplenishmentPlans(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: AccountLifecycleOptions = {}
) {
  const owner = await customerAuthority(db, claims, options),
    [plans, recent, consent] = await db.batch([
      db
        .prepare(
          `SELECT p.id,p.variant_id variantId,v.sku,pr.name,p.source,p.interval_days intervalDays,p.status,p.next_due_at nextDueAt,
 p.last_reminded_at lastRemindedAt,p.version FROM replenishment_plans p JOIN variants v ON v.id=p.variant_id JOIN products pr ON pr.id=v.product_id
 WHERE p.customer_id=?1 ORDER BY p.next_due_at,p.id LIMIT 100`
        )
        .bind(owner.customerId),
      db
        .prepare(
          `SELECT r.variant_id variantId,v.sku,r.status,r.suppression_reason reason,r.created_at createdAt FROM replenishment_reminders r
 JOIN variants v ON v.id=r.variant_id WHERE r.customer_id=?1 ORDER BY r.created_at DESC,r.id LIMIT 10`
        )
        .bind(owner.customerId),
      db
        .prepare(
          'SELECT COALESCE((SELECT replenishment FROM customer_account_preferences WHERE customer_id=?1),0) value'
        )
        .bind(owner.customerId)
    ])
  await finalCustomer(db, claims, owner.customerId, options)
  const parsed = replenishmentListSchema.safeParse({
    source: 'cloudflare',
    consent: { replenishment: (consent!.results[0] as { value: number }).value === 1 },
    cap: REPLENISHMENT_CAP,
    plans: plans!.results,
    recent: recent!.results
  })
  return parsed.success ? parsed.data : lifecycleFail('unavailable')
}
const dueRow = z
  .object({
    id: z.string().uuid(),
    customer_id: z.string().uuid(),
    variant_id: z.string(),
    interval_days: z.number().int(),
    next_due_at: catalogPolicyInstantSchema,
    consent: z.number(),
    has_center: z.number(),
    unsub: z.number().nullable(),
    email: z.number().nullable(),
    last_purchase: z.string().nullable()
  })
  .strict()
/**
 * Scheduler: queues reminders only for customers with live consent, honours the
 * preference centre, suppresses after a repurchase and enforces the frequency
 * cap in SQL (one transaction per plan, deterministic and replay-safe).
 */
export async function scheduleReplenishmentReminders(db: D1Database, options: { now: string; limit?: number }) {
  if (!catalogPolicyInstantSchema.safeParse(options.now).success) return lifecycleFail('invalid_input')
  const now = options.now,
    limit = Math.min(Math.max(options.limit ?? 100, 1), 500),
    summary = { queued: 0, suppressed: 0, deferred: 0 }
  const { results } = await db
    .prepare(
      `SELECT p.id,p.customer_id,p.variant_id,p.interval_days,p.next_due_at,COALESCE(pref.replenishment,0) consent,
 (pc.customer_id IS NOT NULL) has_center,pc.unsubscribe_all unsub,pc.channel_email email,
 (SELECT max(o.created_at) ${PAID_PURCHASES} WHERE o.customer_id=p.customer_id AND l.variant_id=p.variant_id AND o.created_at<=?1
 AND o.created_at>strftime('%Y-%m-%dT%H:%M:%SZ',p.next_due_at,'-'||p.interval_days||' days')) last_purchase
 FROM replenishment_plans p JOIN customers c ON c.id=p.customer_id AND c.status='active'
 LEFT JOIN customer_account_preferences pref ON pref.customer_id=p.customer_id
 LEFT JOIN customer_preference_center pc ON pc.customer_id=p.customer_id
 WHERE p.status='active' AND p.next_due_at<=?1 ORDER BY p.next_due_at,p.id LIMIT ?2`
    )
    .bind(now, limit)
    .all()
  for (const raw of results) {
    const plan = dueRow.parse(raw),
      interval = plan.interval_days * DAY,
      advance = iso(
        Date.parse(plan.next_due_at) +
          (Math.floor((Date.parse(now) - Date.parse(plan.next_due_at)) / interval) + 1) * interval
      )
    let reason: string | null = null
    if (plan.has_center && plan.unsub === 1) reason = 'unsubscribed_all'
    else if (plan.consent !== 1) reason = 'no_consent'
    else if (plan.has_center && plan.email !== 1) reason = 'email_channel_off'
    else if (plan.last_purchase !== null) reason = 'purchased_since'
    const nextDue = reason === 'purchased_since' ? addDays(plan.last_purchase!, plan.interval_days) : advance
    const cap =
      reason === null
        ? `AND NOT EXISTS(SELECT 1 FROM replenishment_reminders q WHERE q.customer_id=?3 AND q.status='queued' AND q.created_at>strftime('%Y-%m-%dT%H:%M:%SZ',?1,'-${REPLENISHMENT_CAP.windowDays} days'))`
        : ''
    try {
      const [, advanced] = await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO replenishment_reminders(id,plan_id,customer_id,variant_id,due_at,status,suppression_reason,created_at)
 SELECT ?6,?2,?3,?4,?5,?7,?8,?1 WHERE 1=1 ${cap}`
          )
          .bind(
            now,
            plan.id,
            plan.customer_id,
            plan.variant_id,
            plan.next_due_at,
            crypto.randomUUID(),
            reason ? 'suppressed' : 'queued',
            reason
          ),
        db
          .prepare(
            `UPDATE replenishment_plans SET next_due_at=?3,last_reminded_at=CASE WHEN ?4=1 THEN ?1 ELSE last_reminded_at END
 WHERE id=?2 AND status='active' AND next_due_at=?5
 AND EXISTS(SELECT 1 FROM replenishment_reminders r WHERE r.plan_id=?2 AND r.due_at=?5) RETURNING id`
          )
          .bind(now, plan.id, nextDue, reason ? 0 : 1, plan.next_due_at)
      ])
      if (!advanced!.results.length) summary.deferred++
      else if (reason) summary.suppressed++
      else summary.queued++
    } catch {
      summary.deferred++
    }
  }
  return summary
}
