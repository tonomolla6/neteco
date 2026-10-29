import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  orderTimelineItemSchema,
  orderTimelineResponseSchema,
  type OrderTimelineItem
} from '../../shared/order-timeline'

export interface NativeOrderTimelineInput {
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  orderId: string
  customerCookie: string
  adminCookie: string
  wrongOwnerCookie: string
  customerAdminDenial?: 'forbidden' | 'mfa_required'
  scenario?: (name: string) => void
}
export const ORDER_TIMELINE_NATIVE_SCENARIOS = [
  'native_order_timeline_owner_confirmed_ledger',
  'native_order_timeline_admin_same_safe_ledger',
  'native_order_timeline_bounded_cursor_pages',
  'native_order_timeline_anonymous_and_admin_customer_denied',
  'native_order_timeline_wrong_owner_uniform_not_found',
  'native_order_timeline_invalid_cursor_denied',
  'native_order_timeline_scoped_counts_and_metadata_unchanged'
] as const

/** Caller-owned workerd/D1 acceptance assertions, not a fixture builder.
 * No SQL writes, authority inserts or provider calls. Caller owns outgoing0.
 * Counts/digests are limited evidence, not a global rows-written proof.
 * Local isolated audit runtime only (financial validationOnly records are
 * included). Authenticated ownership only: not the guest-access journey.
 */
export async function auditNativeOrderTimeline(input: NativeOrderTimelineInput) {
  const origin = new URL(input.origin)
  assert(origin.protocol === 'https:' && origin.origin === input.origin && origin.hostname.endsWith('.test'))
  assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(input.orderId))
  for (const cookie of [input.adminCookie, input.customerCookie, input.wrongOwnerCookie])
    assert(typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 16384 && !/[\r\n]/u.test(cookie))
  const order = await input.database
    .prepare('SELECT id, status, created_at, updated_at FROM orders WHERE id = ?')
    .bind(input.orderId)
    .first<{ id: string }>()
  assert(order?.id === input.orderId, 'Caller must supply an existing durable order')
  const tables = [
    'orders',
    'order_events',
    'checkout_commands',
    'payment_events',
    'payment_intents',
    'order_fulfillment_commands',
    'order_fulfillment_audit',
    'order_return_commands',
    'order_return_events',
    'refund_contracts',
    'refund_receipts',
    'fiscal_invoice_intents',
    'fiscal_provider_receipts',
    'fiscal_documents',
    'fiscal_credit_contracts',
    'fiscal_credit_receipts',
    'fiscal_credit_documents',
    'auth_sessions',
    'identity_roles'
  ] as const
  async function all(sql: string, ...values: string[]) {
    const result = await input.database
      .prepare(sql)
      .bind(...values)
      .all()
    assert(result.success && Array.isArray(result.results))
    return result.results
  }
  async function snapshot() {
    const counts = await input.database
      .prepare(`SELECT ${tables.map((table) => `(SELECT COUNT(*) FROM ${table}) AS ${table}`).join(', ')}`)
      .first<Record<string, number>>()
    assert(counts && tables.every((table) => Number.isSafeInteger(counts[table]) && counts[table]! >= 0))
    const metadata = await Promise.all([
      all('SELECT id, status, created_at, updated_at FROM orders WHERE id = ?', input.orderId),
      all('SELECT id, event_type, created_at FROM order_events WHERE order_id = ? ORDER BY id', input.orderId),
      all('SELECT id, event_type, created_at FROM payment_events WHERE order_id = ? ORDER BY id', input.orderId),
      all(
        'SELECT id, action, to_state, created_at FROM order_fulfillment_audit WHERE order_id = ? ORDER BY id',
        input.orderId
      ),
      all(
        'SELECT command_id, action, created_at FROM order_return_events WHERE order_id = ? ORDER BY command_id',
        input.orderId
      ),
      all(
        'SELECT id, identity_id, session_version, mfa_verified, expires_at, revoked_at FROM auth_sessions ORDER BY id'
      ),
      all('SELECT identity_id, role_code, granted_at, expires_at FROM identity_roles ORDER BY identity_id, role_code')
    ])
    return { counts, digest: createHash('sha256').update(JSON.stringify(metadata)).digest('hex') }
  }
  const before = await snapshot()
  // Independently reconcile the local audit fixture's immutable ledgers, rather
  // than accepting a plausible DTO or inventing stages that have not occurred.
  const ledgerQueries = [
    "SELECT 'checkout:'||e.id AS id, 'checkout' AS kind, 'created' AS state, e.created_at AS createdAt, NULL AS validationOnly FROM order_events e WHERE e.order_id=? AND e.event_type='order.created' AND EXISTS(SELECT 1 FROM checkout_commands c JOIN orders o ON o.id=e.order_id AND o.cart_id=c.cart_id JOIN checkout_attempts a ON a.id=o.attempt_id AND a.order_id=o.id AND a.state='completed' WHERE c.kind='checkout' AND c.response_status=200 AND json_extract(c.response_body,'$.outcome')='order_created' AND json_extract(c.response_body,'$.body.id')=e.order_id AND c.created_at=e.created_at)",
    "SELECT 'payment:'||e.id AS id, 'payment' AS kind, e.event_type AS state, e.created_at AS createdAt, NULL AS validationOnly FROM payment_events e JOIN payment_intents p ON p.id=e.payment_intent_id AND p.order_id=e.order_id WHERE e.order_id=?",
    "SELECT 'fulfillment:'||c.id AS id, 'fulfillment' AS kind, c.to_state AS state, c.created_at AS createdAt, NULL AS validationOnly FROM order_fulfillment_commands c JOIN order_fulfillment_audit a ON a.command_id=c.id AND a.order_id=c.order_id AND a.to_state=c.to_state AND a.created_at=c.created_at WHERE c.order_id=?",
    "SELECT 'return:'||c.id AS id, 'return' AS kind, c.to_state AS state, c.created_at AS createdAt, NULL AS validationOnly FROM order_return_commands c JOIN order_return_events e ON e.command_id=c.id AND e.order_id=c.order_id AND e.action=c.action AND e.created_at=c.created_at WHERE c.order_id=?",
    "SELECT 'refund:'||e.id AS id, 'refund' AS kind, 'succeeded' AS state, e.created_at AS createdAt, c.validation_only AS validationOnly FROM order_events e JOIN refund_contracts c ON c.id=e.correlation_id AND c.order_id=e.order_id JOIN refund_receipts r ON r.refund_id=c.id AND r.status='succeeded' WHERE e.order_id=? AND e.event_type='refund.succeeded'",
    "SELECT 'fiscal:'||e.id AS id, 'fiscal' AS kind, r.fiscal_status AS state, e.created_at AS createdAt, CASE WHEN r.provider='local_fake' THEN 1 ELSE 0 END AS validationOnly FROM order_events e JOIN fiscal_invoice_intents i ON i.id=e.correlation_id AND i.order_id=e.order_id JOIN fiscal_provider_receipts r ON r.intent_id=i.id JOIN fiscal_documents d ON d.intent_id=i.id AND d.order_id=i.order_id WHERE e.order_id=? AND e.event_type='invoice.issued'",
    "SELECT 'credit:'||e.id AS id, 'credit' AS kind, json_extract(r.receipt_json,'$.status') AS state, e.created_at AS createdAt, c.validation_only AS validationOnly FROM order_events e JOIN fiscal_credit_contracts c ON c.id=e.correlation_id AND c.order_id=e.order_id JOIN fiscal_credit_receipts r ON r.credit_id=c.id JOIN fiscal_credit_documents d ON d.credit_id=c.id WHERE e.order_id=? AND e.event_type='invoice.issued'"
  ]
  const readLedger = async () =>
    (await Promise.all(ledgerQueries.map((sql) => all(sql, input.orderId)))).flat().map((row) =>
      orderTimelineItemSchema.parse({
        ...row,
        validationOnly: row.validationOnly === null ? null : Boolean(row.validationOnly)
      })
    )
  const ledger = await readLedger()
  assert(
    ledger.some((row) => row.kind === 'checkout'),
    'Confirmed checkout ledger is required'
  )
  const checks: string[] = []
  const mark = (index: number) => {
    const name = ORDER_TIMELINE_NATIVE_SCENARIOS[index]!
    checks.push(name)
    input.scenario?.(name)
  }
  async function read(admin: boolean, id: string, cookie?: string, limit = 20, cursor?: string) {
    const query = new URLSearchParams({ limit: String(limit) })
    if (cursor !== undefined) query.set('cursor', cursor)
    const response = await input.dispatch(
      new Request(`${input.origin}/api/${admin ? 'admin/' : ''}orders/${id}/timeline?${query}`, {
        headers: {
          origin: input.origin,
          'sec-fetch-site': 'same-origin',
          'cf-connecting-ip': '192.0.2.160',
          ...(cookie ? { cookie } : {})
        }
      })
    )
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/iu)
    assert.match(response.headers.get('cache-control') ?? '', /\bprivate\b/iu)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/iu)
    const bytes = await response.arrayBuffer()
    assert(bytes.byteLength > 0 && bytes.byteLength <= 32768)
    return { status: response.status, body: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  }
  async function page(admin: boolean, cookie: string, limit: number, cursor?: string) {
    const response = await read(admin, input.orderId, cookie, limit, cursor)
    assert.equal(response.status, 200)
    const body = orderTimelineResponseSchema.parse(response.body)
    assert.equal(body.orderId, input.orderId)
    assert.equal(body.audience, admin ? 'admin' : 'customer')
    assert(body.items.length <= limit)
    return body
  }
  async function collect(admin: boolean, cookie: string, limit: number) {
    const items: OrderTimelineItem[] = [],
      cursors = new Set<string>()
    let cursor: string | undefined
    for (let pages = 0; pages < 200; pages++) {
      const body = await page(admin, cookie, limit, cursor)
      items.push(...body.items)
      assert.equal(new Set(items.map((item) => item.id)).size, items.length, 'No duplicate events across cursor pages')
      for (let i = 1; i < items.length; i++) {
        const previous = items[i - 1]!,
          current = items[i]!
        assert(
          previous.createdAt > current.createdAt ||
            (previous.createdAt === current.createdAt && previous.id > current.id),
          'Timeline must remain descending across pages'
        )
      }
      if (body.nextCursor === null) return items
      assert(!cursors.has(body.nextCursor), 'Cursor must make progress')
      cursors.add(body.nextCursor)
      cursor = body.nextCursor
    }
    throw new Error('Fixture exceeds bounded acceptance pagination budget')
  }
  const owner = await collect(false, input.customerCookie, 20)
  assert(owner.length > 0, 'An existing checkout must not become an empty timeline')
  const byId = (rows: ReadonlyArray<{ id: string }>) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
  assert.deepEqual(
    byId(owner),
    byId(ledger as OrderTimelineItem[]),
    'Timeline must reflect the existing confirmed local ledger exactly'
  )
  mark(0)
  const admin = await collect(true, input.adminCookie, 20)
  assert.deepEqual(admin, owner, 'Common safe ledger must agree for owner and authorized admin')
  mark(1)
  assert.deepEqual(await collect(false, input.customerCookie, 1), owner)
  mark(2)
  const anonymous = await read(false, input.orderId)
  assert.equal(anonymous.status, 401)
  assert.deepEqual(anonymous.body, { error: { code: 'unauthenticated' } })
  const customerAdmin = await read(true, input.orderId, input.customerCookie)
  assert.equal(customerAdmin.status, 403)
  assert.deepEqual(customerAdmin.body, { error: { code: input.customerAdminDenial ?? 'forbidden' } })
  mark(3)
  const missingId = '00000000-0000-4000-8000-000000000000'
  assert.equal(await input.database.prepare('SELECT id FROM orders WHERE id = ?').bind(missingId).first(), null)
  const wrongOwner = await read(false, input.orderId, input.wrongOwnerCookie)
  const missing = await read(false, missingId, input.customerCookie)
  assert.equal(wrongOwner.status, 404)
  assert.equal(missing.status, 404)
  assert.deepEqual(wrongOwner.body, missing.body)
  assert.deepEqual(wrongOwner.body, { error: { code: 'not_found' } })
  mark(4)
  const invalid = await read(false, input.orderId, input.customerCookie, 20, '!invalid')
  assert.equal(invalid.status, 400)
  assert.deepEqual(invalid.body, { error: { code: 'invalid_input' } })
  mark(5)
  assert.deepEqual(await snapshot(), before)
  assert.deepEqual(await readLedger(), ledger, 'Confirmed financial and operational metadata must remain unchanged')
  mark(6)
  return {
    scenarios: checks.length,
    checks,
    sourceKinds: [...new Set(owner.map((item) => item.kind))].sort(),
    scopedCountTables: tables,
    countsUnchanged: true,
    fixtureDigestsUnchanged: true,
    globalRowsWrittenProof: false,
    outboundNetworkGate: 'caller_owned',
    productionAcceptance: false
  }
}
