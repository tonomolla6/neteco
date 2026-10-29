import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  customer360Schema,
  customer360ListSchema,
  customer360QuerySchema,
  customer360ListQuerySchema,
  type Customer360,
  type Customer360List
} from '../../shared/customer-360'
import {
  catalogPolicyInstantSchema as instant,
  catalogPolicyUuidSchema as uuid
} from '../../shared/catalog-publication-policy'
export class Customer360Error extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'history_unconfirmed'
      | 'service_unavailable'
      | 'export_too_large'
  ) {
    super(code)
  }
}
type Options = { now?: string }
function fail(code: Customer360Error['code']): never {
  throw new Customer360Error(code)
}
function checked<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  raw: unknown,
  code: Customer360Error['code'] = 'history_unconfirmed'
): T {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) fail(code)
  return parsed.data
}
async function attempt<T>(run: () => Promise<T>) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof Customer360Error) throw error
    return fail('service_unavailable')
  }
}
const cte = `WITH clock AS MATERIALIZED(SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now), grants AS MATERIALIZED(
 SELECT p.permission_code FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=?3 AND r.granted_at<=(SELECT now FROM clock) AND(r.expires_at IS NULL OR r.expires_at>(SELECT now FROM clock))), authority AS MATERIALIZED(
 SELECT i.id,(i.email_verified_at IS NOT NULL AND i.email_verified_at<=(SELECT now FROM clock)) verified,
 (s.mfa_verified=1 AND EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL AND m.verified_at<=(SELECT now FROM clock))) mfa,
 EXISTS(SELECT 1 FROM grants WHERE permission_code='support.manage') support,
 EXISTS(SELECT 1 FROM grants WHERE permission_code='administration.manage') admin,
 EXISTS(SELECT 1 FROM grants WHERE permission_code='orders.read') orders,
 EXISTS(SELECT 1 FROM grants WHERE permission_code='payments.read') payments,
 EXISTS(SELECT 1 FROM grants WHERE permission_code='invoices.read') invoices
 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id WHERE s.id=?2 AND i.id=?3 AND s.session_version=?4 AND i.session_version=s.session_version
 AND i.status='active' AND s.revoked_at IS NULL AND s.created_at<=(SELECT now FROM clock) AND s.expires_at>(SELECT now FROM clock))`
const flags = z
  .object({
    id: uuid,
    verified: z.number(),
    mfa: z.number(),
    support: z.number(),
    admin: z.number(),
    orders: z.number(),
    payments: z.number(),
    invoices: z.number()
  })
  .strict()
type Flags = z.infer<typeof flags>
function bindings(claims: VerifiedSessionClaims | null, options: Options) {
  if (
    !claims ||
    !uuid.safeParse(claims.identityId).success ||
    !uuid.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    fail('unauthenticated')
  if (options.now !== undefined && !instant.safeParse(options.now).success) fail('invalid_input')
  return [options.now ?? null, claims.sessionId, claims.identityId, claims.sessionVersion]
}
function actor(raw: unknown): Flags {
  if (raw === null) fail('unauthenticated')
  const value = checked(flags, raw)
  if (!value.verified) fail('email_unverified')
  if (!value.mfa) fail('mfa_required')
  if (!value.support && !value.admin) fail('forbidden')
  return value
}
async function authority(db: D1Database, params: unknown[]) {
  return actor(
    await db
      .prepare(`${cte} SELECT * FROM authority`)
      .bind(...params)
      .first()
  )
}
export async function authorizeD1Customer360Actor(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  options: Options = {}
): Promise<void> {
  return attempt(async () => {
    await authority(database, bindings(claims, options))
  })
}
function bounded(raw: unknown) {
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 2 * 1024 * 1024) fail('export_too_large')
}
function rows(result: D1Result) {
  if (!result.success || !Array.isArray(result.results)) fail('service_unavailable')
  return result.results as Record<string, unknown>[]
}
function pageMeta(page: number, perPage: number, total: number) {
  return { page, perPage, total, pages: Math.ceil(total / perPage) }
}
const redacted = () => ({ visibility: 'redacted' as const, data: null })
const visible = <T>(data: T) => ({ visibility: 'visible' as const, data })
export async function listD1Customer360(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  options: Options = {}
): Promise<Customer360List> {
  return attempt(async () => {
    const query = checked(customer360ListQuerySchema, raw, 'invalid_input'),
      params = bindings(claims, options),
      initial = await authority(database, params)
    const selector = `SELECT id,name,status FROM customers WHERE status IN('active','blocked') AND(?6='' OR name LIKE ?5 ESCAPE '\\' OR id=?6)`
    const term = `%${query.q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    const read = () =>
      database.batch([
        database.prepare(`${cte} SELECT * FROM authority`).bind(...params),
        database
          .prepare(`${cte}, selected AS(${selector}) SELECT * FROM selected ORDER BY name,id LIMIT ?7 OFFSET ?8`)
          .bind(...params, term, query.q, query.perPage, (query.page - 1) * query.perPage),
        database
          .prepare(`${cte}, selected AS(${selector}) SELECT count(*) total FROM selected`)
          .bind(...params, term, query.q)
      ])
    const first = await read()
    bounded(first)
    actor(rows(first[0]!)[0] ?? null)
    const dto = checked(customer360ListSchema, {
      source: 'cloudflare',
      items: rows(first[1]!),
      ...pageMeta(query.page, query.perPage, Number(rows(first[2]!)[0]?.total))
    })
    const last = await read()
    const final = actor(rows(last[0]!)[0] ?? null)
    if (JSON.stringify(final) !== JSON.stringify(initial)) fail('forbidden')
    if (JSON.stringify(last.slice(1).map(rows)) !== JSON.stringify(first.slice(1).map(rows)))
      fail('history_unconfirmed')
    return dto
  })
}
const capture = `s.status='paid' AND s.paid_gross_cents=o.total_gross_cents AND EXISTS(SELECT 1 FROM payment_intents p
 JOIN payment_fulfilment_claims f ON f.payment_intent_id=p.id AND f.order_id=o.id
 JOIN payment_recovery_jobs j ON j.payment_intent_id=p.id AND j.order_id=o.id AND j.status='completed'
 WHERE p.id=s.active_intent_id AND p.order_id=o.id AND p.status='captured' AND p.amount_gross_cents=o.total_gross_cents AND p.currency=o.currency
 AND p.updated_at<=(SELECT now FROM clock) AND j.updated_at<=(SELECT now FROM clock)
 AND EXISTS(SELECT 1 FROM payment_events e WHERE e.payment_intent_id=p.id AND e.order_id=o.id AND e.event_type='captured' AND e.created_at<=(SELECT now FROM clock)))`
const ticketSelection = `SELECT t.* FROM support_tickets t WHERE t.customer_id=?5 AND t.created_at<=(SELECT now FROM clock) AND t.updated_at<=(SELECT now FROM clock) AND t.retention_until>(SELECT now FROM clock)`
function proveTicket(row: Record<string, unknown>) {
  if (typeof row.snapshot !== 'string' || typeof row.response !== 'string') fail('history_unconfirmed')
  let snapshot: Record<string, unknown>, response: Record<string, unknown>
  try {
    snapshot = JSON.parse(row.snapshot)
    response = JSON.parse(row.response)
  } catch {
    return fail('history_unconfirmed')
  }
  for (const [key, column] of [
    ['customerId', 'customer_id'],
    ['orderId', 'order_id'],
    ['priority', 'priority'],
    ['ownerId', 'owner_id'],
    ['nextActionAt', 'next_action_at'],
    ['slaDueAt', 'sla_due_at']
  ] as const)
    if (snapshot[key] !== row[column]) fail('history_unconfirmed')
  if (
    Number(response.version) !== row.version ||
    response.publicRef !== row.public_ref ||
    response.state !== row.state ||
    response.commandId !== row.last_command_id ||
    row.command_version !== row.version ||
    row.ticket_id !== row.id ||
    row.command_ref !== row.public_ref ||
    row.command_state !== row.state ||
    row.command_at !== row.updated_at
  )
    fail('history_unconfirmed')
  return {
    publicRef: row.public_ref,
    category: row.category,
    state: row.state,
    priority: row.priority,
    nextActionAt: row.next_action_at,
    ownerAssigned: row.owner_id !== null,
    updatedAt: row.updated_at
  }
}
export async function readD1Customer360(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  raw: unknown,
  options: Options = {}
): Promise<Customer360> {
  return attempt(async () => {
    checked(uuid, customerId, 'invalid_input')
    const query = checked(customer360QuerySchema, raw, 'invalid_input'),
      params = bindings(claims, options),
      initial = await authority(database, params)
    const facts: Array<{ key: string; sql: string; extra?: unknown[] }> = [
      { key: 'actor', sql: 'SELECT * FROM authority' },
      { key: 'customer', sql: "SELECT id,name,status FROM customers WHERE id=?5 AND status IN('active','blocked')" }
    ]
    if (initial.orders)
      facts.push(
        {
          key: 'orders',
          sql: 'SELECT id,status,shipping_method_code shippingMethod,created_at createdAt FROM orders WHERE customer_id=?5 AND created_at<=(SELECT now FROM clock) ORDER BY created_at DESC,id DESC LIMIT ?6 OFFSET ?7',
          extra: [query.perPage, (query.ordersPage - 1) * query.perPage]
        },
        {
          key: 'orderCount',
          sql: 'SELECT count(*) total FROM orders WHERE customer_id=?5 AND created_at<=(SELECT now FROM clock)'
        }
      )
    if (initial.support) {
      const projection =
        't.id,t.customer_id,t.order_id,t.public_ref,t.category,t.state,t.priority,t.next_action_at,t.owner_id,t.sla_due_at,t.updated_at,t.version,t.last_command_id,c.ticket_id,c.result_version command_version,c.public_ref command_ref,c.to_state command_state,c.created_at command_at,c.snapshot,c.response'
      facts.push(
        {
          key: 'tickets',
          sql: `SELECT ${projection} FROM (${ticketSelection}) t LEFT JOIN support_commands c ON c.id=t.last_command_id ORDER BY t.updated_at DESC,t.id DESC LIMIT ?6 OFFSET ?7`,
          extra: [query.perPage, (query.ticketsPage - 1) * query.perPage]
        },
        { key: 'ticketCount', sql: `SELECT count(*) total FROM (${ticketSelection})` },
        {
          key: 'nextAction',
          sql: `SELECT ${projection} FROM (${ticketSelection}) t LEFT JOIN support_commands c ON c.id=t.last_command_id WHERE t.next_action_at IS NOT NULL AND t.state NOT IN('resolved','closed') ORDER BY t.next_action_at,t.id LIMIT 1`
        },
        {
          key: 'ticketHistory',
          sql: `SELECT c.ticket_id,c.result_version,c.expected_version,e.id event_id,CASE WHEN e.ticket_id=c.ticket_id AND e.type=c.action AND e.state=c.to_state AND e.created_at=c.created_at AND e.actor_type=c.actor_type AND e.actor_id IS c.actor_id THEN 1 ELSE 0 END event_matches FROM support_commands c LEFT JOIN support_events e ON e.id=c.id WHERE c.ticket_id IN(SELECT id FROM (${ticketSelection}) ORDER BY updated_at DESC,id DESC LIMIT ?6 OFFSET ?7) ORDER BY c.ticket_id,c.result_version LIMIT 2501`,
          extra: [query.perPage, (query.ticketsPage - 1) * query.perPage]
        }
      )
    }
    if (initial.invoices)
      facts.push(
        {
          key: 'invoices',
          sql: `SELECT i.order_id orderId,w.status,i.validation_only validationOnly,i.amount_gross_cents grossCents,i.currency,i.created_at createdAt,w.completed_at completedAt,r.contract_fingerprint receiptHash,i.contract_fingerprint intentHash FROM fiscal_invoice_intents i JOIN orders o ON o.id=i.order_id LEFT JOIN fiscal_issuance_work w ON w.intent_id=i.id LEFT JOIN fiscal_provider_receipts r ON r.intent_id=i.id WHERE o.customer_id=?5 AND i.created_at<=(SELECT now FROM clock) ORDER BY i.created_at DESC,i.id DESC LIMIT ?6 OFFSET ?7`,
          extra: [query.perPage, (query.invoicesPage - 1) * query.perPage]
        },
        {
          key: 'invoiceCount',
          sql: 'SELECT count(*) total FROM fiscal_invoice_intents i JOIN orders o ON o.id=i.order_id WHERE o.customer_id=?5 AND i.created_at<=(SELECT now FROM clock)'
        }
      )
    if (initial.payments)
      facts.push(
        {
          key: 'value',
          sql: `SELECT count(*) orderCount,COALESCE(sum(CASE WHEN ${capture} THEN 1 ELSE 0 END),0) paidOrderCount,COALESCE(sum(CASE WHEN ${capture} THEN s.paid_gross_cents ELSE 0 END),0) paidGrossCents,COALESCE(sum(CASE WHEN s.status='paid' AND NOT(${capture}) THEN 1 ELSE 0 END),0) badCapture,COALESCE(sum(CASE WHEN o.currency<>'EUR' THEN 1 ELSE 0 END),0) badCurrency FROM orders o LEFT JOIN order_payment_states s ON s.order_id=o.id WHERE o.customer_id=?5 AND o.created_at<=(SELECT now FROM clock)`
        },
        {
          key: 'refunds',
          sql: `SELECT c.amount_gross_cents,c.validation_only,json_extract(c.contract_json,'$.currency') currency,c.contract_fingerprint,w.completed_at,r.receipt_json FROM refund_contracts c JOIN orders o ON o.id=c.order_id JOIN refund_work w ON w.refund_id=c.id LEFT JOIN refund_receipts r ON r.refund_id=c.id AND r.status='succeeded' WHERE o.customer_id=?5 AND w.status='completed' AND c.created_at<=(SELECT now FROM clock) AND w.completed_at<=(SELECT now FROM clock) LIMIT 1001`
        }
      )
    if (initial.admin)
      facts.push(
        {
          key: 'preferences',
          sql: 'SELECT p.version,p.product_updates,p.replenishment,p.updated_at,c.applied_version,c.product_updates commandProduct,c.replenishment commandReplenishment,c.recorded_at FROM customer_account_preferences p LEFT JOIN account_preference_commands c ON c.customer_id=p.customer_id AND c.command_id=p.command_id WHERE p.customer_id=?5'
        },
        {
          key: 'delivery',
          sql: 'SELECT p.version,p.delivery_updates,p.updated_at,c.applied_version,c.delivery_updates commandDelivery,c.recorded_at FROM delivery_preferences p LEFT JOIN delivery_preference_commands c ON c.customer_id=p.customer_id AND c.command_id=p.command_id WHERE p.customer_id=?5'
        }
      )
    const read = () =>
      database.batch(
        facts.map((f) =>
          database
            .prepare(`${cte} ${f.sql}`)
            .bind(...params, ...(f.key === 'actor' ? [] : [customerId]), ...(f.extra ?? []))
        )
      )
    const first = await read()
    bounded(first)
    const data = Object.fromEntries(facts.map((f, index) => [f.key, rows(first[index]!)]))
    actor(data.actor![0] ?? null)
    const customer = data.customer![0]
    if (!customer) fail('not_found')
    const dto: Record<string, unknown> = {
      source: 'cloudflare',
      customer,
      evaluatedAt: options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      orders: redacted(),
      tickets: redacted(),
      invoices: redacted(),
      value: redacted(),
      consent: redacted(),
      nextAction: redacted()
    }
    if (initial.orders)
      dto.orders = visible({
        ...pageMeta(query.ordersPage, query.perPage, Number(data.orderCount![0]?.total)),
        items: data.orders
      })
    if (initial.support) {
      const history = data.ticketHistory!
      if (history.length > 2500) fail('history_unconfirmed')
      const versions = new Map<string, number>()
      for (const row of history) {
        const expected = versions.get(String(row.ticket_id)) ?? 0
        if (
          row.expected_version !== expected ||
          row.result_version !== expected + 1 ||
          row.event_id === null ||
          row.event_matches !== 1
        )
          fail('history_unconfirmed')
        versions.set(String(row.ticket_id), expected + 1)
      }
      for (const row of data.tickets!) if (versions.get(String(row.id)) !== row.version) fail('history_unconfirmed')
      dto.tickets = visible({
        ...pageMeta(query.ticketsPage, query.perPage, Number(data.ticketCount![0]?.total)),
        items: data.tickets!.map(proveTicket)
      })
      const next = data.nextAction![0]
      if (next) proveTicket(next)
      dto.nextAction = visible(
        next
          ? {
              kind: 'support_follow_up',
              ticketRef: next.public_ref,
              dueAt: next.next_action_at,
              ownerAssigned: next.owner_id !== null
            }
          : null
      )
    }
    if (initial.invoices)
      dto.invoices = visible({
        ...pageMeta(query.invoicesPage, query.perPage, Number(data.invoiceCount![0]?.total)),
        items: data.invoices!.map((row) => {
          if (
            typeof row.status !== 'string' ||
            (row.status === 'completed' && (row.receiptHash !== row.intentHash || typeof row.completedAt !== 'string'))
          )
            fail('history_unconfirmed')
          return {
            orderId: row.orderId,
            status: row.status,
            validationOnly: row.validationOnly === 1,
            grossCents: row.grossCents,
            currency: row.currency,
            createdAt: row.createdAt
          }
        })
      })
    if (initial.payments) {
      const value = data.value![0]!
      if (value.badCapture !== 0 || value.badCurrency !== 0 || data.refunds!.length > 1000) fail('history_unconfirmed')
      let settledRefundGrossCents = 0,
        validationRefundGrossCents = 0
      for (const row of data.refunds!) {
        let receipt: Record<string, unknown>
        try {
          receipt = JSON.parse(String(row.receipt_json))
        } catch {
          return fail('history_unconfirmed')
        }
        if (
          receipt.status !== 'succeeded' ||
          receipt.contractFingerprint !== row.contract_fingerprint ||
          receipt.amountCents !== row.amount_gross_cents ||
          receipt.currency !== row.currency ||
          row.currency !== 'EUR' ||
          receipt.validationOnly !== (row.validation_only === 1)
        )
          fail('history_unconfirmed')
        if (row.validation_only === 1) validationRefundGrossCents += Number(row.amount_gross_cents)
        else settledRefundGrossCents += Number(row.amount_gross_cents)
      }
      dto.value = visible({
        currency: 'EUR',
        orderCount: value.orderCount,
        paidOrderCount: value.paidOrderCount,
        paidGrossCents: value.paidGrossCents,
        settledRefundGrossCents,
        validationRefundGrossCents,
        netCollectedGrossCents: Number(value.paidGrossCents) - settledRefundGrossCents
      })
    }
    if (initial.admin) {
      const pref = data.preferences![0],
        delivery = data.delivery![0]
      if (
        pref &&
        (pref.version !== pref.applied_version ||
          pref.product_updates !== pref.commandProduct ||
          pref.replenishment !== pref.commandReplenishment ||
          pref.updated_at !== pref.recorded_at)
      )
        fail('history_unconfirmed')
      if (
        delivery &&
        (delivery.version !== delivery.applied_version ||
          delivery.delivery_updates !== delivery.commandDelivery ||
          delivery.updated_at !== delivery.recorded_at)
      )
        fail('history_unconfirmed')
      const choice = (row: Record<string, unknown> | undefined, value: boolean) => ({
        value,
        version: row?.version ?? 0,
        updatedAt: row?.updated_at ?? null,
        basis: row ? 'recorded' : 'default'
      })
      dto.consent = visible({
        productUpdates: choice(pref, pref?.product_updates === 1),
        replenishment: choice(pref, pref?.replenishment === 1),
        deliveryUpdates: choice(delivery, delivery ? delivery.delivery_updates === 1 : true),
        newsletter: { status: 'unknown', reason: 'identity_unlinked' }
      })
    }
    const result = checked(customer360Schema, dto)
    bounded(result)
    const last = await read()
    const final = actor(rows(last[0]!)[0] ?? null)
    if (JSON.stringify(final) !== JSON.stringify(initial)) fail('forbidden')
    if (JSON.stringify(last.slice(1).map(rows)) !== JSON.stringify(first.slice(1).map(rows)))
      fail('history_unconfirmed')
    return result
  })
}
