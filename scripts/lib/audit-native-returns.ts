import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  adminOrderReturnSchema,
  adminReturnListSchema,
  customerOrderReturnsSchema,
  returnCommandReceiptSchema,
  returnRequestInputSchema,
  returnTransitionInputSchema,
  returnOrderIdSchema,
  type AdminOrderReturn,
  type ReturnState,
  type ReturnTransitionInput
} from '../../shared/order-returns'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { canonicalJson } from '../../workers/catalog/inventory'

export interface NativeReturnsAuditInput {
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  customerCookie: string
  outsiderCookie?: string
  guestCookie?: string
  /** Root obtains current ownership through authenticated checkout, captures a
   * signed synthetic callback and records delivery through real HTTP commands. */
  orderId: string
  scenario: (name: string) => void
}
export interface NativeReturnsAuditEvidence {
  scenarios: number
  checks: readonly string[]
  returnPublicRef: string
  version: number
  finalState: 'resolution_ready'
  receivedUnits: number
  inventoryDigestBefore: string
  inventoryDigestAfter: string
  inventoryUnchanged: true
  contractUnchanged: true
  economicEffects: false
}
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'native_returns_object_unconfirmed')
  return value as Record<string, unknown>
}
const inventoryQueries = [
  'SELECT * FROM inventory_locations ORDER BY id',
  'SELECT * FROM inventory_balances ORDER BY variant_id,location_id',
  'SELECT * FROM inventory_reservations ORDER BY id',
  'SELECT * FROM inventory_reservation_lines ORDER BY reservation_id,variant_id,location_id',
  'SELECT * FROM inventory_movements ORDER BY id'
] as const
const contractQueries = [
  'SELECT * FROM orders ORDER BY id',
  'SELECT * FROM order_lines ORDER BY order_id,line_index',
  'SELECT * FROM order_shipping_address ORDER BY order_id',
  'SELECT * FROM order_billing_address ORDER BY order_id',
  'SELECT * FROM order_events ORDER BY id',
  'SELECT * FROM payment_intents ORDER BY id',
  'SELECT * FROM order_payment_states ORDER BY order_id',
  'SELECT * FROM payment_commands ORDER BY order_id,command_id',
  'SELECT * FROM payment_events ORDER BY id',
  'SELECT * FROM payment_recovery_jobs ORDER BY payment_intent_id',
  'SELECT * FROM payment_fulfilment_claims ORDER BY order_id',
  'SELECT * FROM order_fulfillments ORDER BY order_id',
  'SELECT * FROM order_fulfillment_commands ORDER BY id',
  'SELECT * FROM order_fulfillment_audit ORDER BY command_id',
  'SELECT * FROM fiscal_outbox_events ORDER BY id',
  'SELECT * FROM fiscal_outbox_delivery ORDER BY event_id',
  'SELECT * FROM fiscal_evaluation_inbox ORDER BY event_id',
  'SELECT * FROM fiscal_invoice_intents ORDER BY id',
  'SELECT * FROM fiscal_issuance_work ORDER BY intent_id',
  'SELECT * FROM fiscal_provider_receipts ORDER BY intent_id',
  'SELECT * FROM fiscal_documents ORDER BY id',
  'SELECT * FROM fiscal_issuance_events ORDER BY id'
] as const
async function digests(database: D1Database) {
  const raw: unknown = await database.batch(
    [...inventoryQueries, ...contractQueries].map((sql) => database.prepare(sql))
  )
  const envelopes = catalogPolicyOwnJson(raw)
  assert(
    Array.isArray(envelopes) && envelopes.length === inventoryQueries.length + contractQueries.length,
    'native_returns_d1_batch_unconfirmed'
  )
  const rows = envelopes.map((value) => {
    const envelope = object(value)
    assert.equal(envelope.success, true, 'native_returns_d1_success_unconfirmed')
    assert(Array.isArray(envelope.results), 'native_returns_d1_rows_unconfirmed')
    return envelope.results
  })
  const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
  return {
    inventory: hash(rows.slice(0, inventoryQueries.length)),
    contract: hash(rows.slice(inventoryQueries.length))
  }
}
async function responseBody(response: Response, status: number) {
  assert.equal(response.status, status, 'native_returns_status_mismatch')
  assert.match(response.headers.get('cache-control') ?? '', /\bprivate\b/, 'native_returns_private_cache_missing')
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/, 'native_returns_no_store_missing')
  assert.match(response.headers.get('vary') ?? '', /\bcookie\b/i, 'native_returns_cookie_vary_missing')
  assert.match(response.headers.get('x-robots-tag') ?? '', /\bnoindex\b/, 'native_returns_noindex_missing')
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i, 'native_returns_json_missing')
  const text = await response.text()
  assert(text.length > 0 && text.length <= 256 * 1024, 'native_returns_body_size_unconfirmed')
  const value = catalogPolicyOwnJson(JSON.parse(text) as unknown)
  return { value, text }
}
function error(value: unknown, code: string) {
  const data = object(value),
    failure = object(data.error)
  assert.deepEqual(Object.keys(data), ['error'], 'native_returns_error_shape')
  assert.deepEqual(Object.keys(failure), ['code'], 'native_returns_error_shape')
  assert.equal(failure.code, code, 'native_returns_error_code')
}
/** Disposable local native audit. No provider invocation, direct paid/owner SQL,
 * stock writes or policy fabrication: every RMA write is a guarded HTTP command. */
export async function auditNativeReturns(input: NativeReturnsAuditInput): Promise<NativeReturnsAuditEvidence> {
  const origin = new URL(input.origin)
  assert(
    origin.protocol === 'https:' &&
      origin.origin === input.origin &&
      (origin.hostname.endsWith('.test') || origin.hostname.endsWith('.invalid')),
    'native_returns_local_origin_required'
  )
  assert(returnOrderIdSchema.safeParse(input.orderId).success, 'native_returns_order_id_invalid')
  for (const cookie of [
    input.adminCookie,
    input.customerCookie,
    ...(input.outsiderCookie ? [input.outsiderCookie] : []),
    ...(input.guestCookie ? [input.guestCookie] : [])
  ])
    assert(
      typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 16384 && !/[\r\n]/.test(cookie),
      'native_returns_cookie_invalid'
    )
  assert(typeof input.scenario === 'function', 'native_returns_scenario_required')
  const checks: string[] = [],
    prefix = `native-rma:${randomUUID()}`,
    staffMarker = `private-custody-${randomUUID()}`
  async function check<T>(name: string, run: () => Promise<T>) {
    const label = `native_returns_${name}`
    input.scenario(label)
    const result = await run()
    checks.push(label)
    return result
  }
  function request(path: string, cookie: string, method = 'GET', body?: unknown, key?: string) {
    return input.dispatch(
      new Request(input.origin + path, {
        method,
        headers: {
          Origin: input.origin,
          Cookie: cookie,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key ? { 'Idempotency-Key': key } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    )
  }
  const customerPath = `/api/orders/${input.orderId}/returns`
  async function customerRead() {
    const result = await responseBody(await request(customerPath, input.customerCookie), 200),
      dto = customerOrderReturnsSchema.parse(result.value)
    assert.equal(dto.orderId, input.orderId, 'native_returns_wrong_order')
    assert(!result.text.includes(staffMarker), 'native_returns_private_evidence_leak')
    return dto
  }
  const baseline = await check('paid_delivered_owned_baseline', async () => {
    const dto = await customerRead()
    assert(dto.readiness.ready && dto.capabilities.returnRequest, 'native_returns_baseline_not_ready')
    assert.equal(dto.version, 0, 'native_returns_disposable_order_required')
    assert.equal(dto.pagination.total, 0, 'native_returns_disposable_history_required')
    return dto
  })
  const before = await digests(input.database),
    line = baseline.lines.find((item) => item.availableQuantity > 0)!
  const units = Math.min(2, line.availableQuantity),
    requestInput = returnRequestInputSchema.parse({
      expectedVersion: 0,
      reason: 'Synthetic locally verified return request reason',
      lines: [{ lineIndex: line.lineIndex, quantity: units }]
    })
  const first = await check('request_recorded', async () => {
    const result = await responseBody(
        await request(customerPath, input.customerCookie, 'POST', requestInput, `${prefix}:request`),
        201
      ),
      receipt = returnCommandReceiptSchema.parse(result.value)
    assert.equal(receipt.action, 'requested')
    assert.equal(receipt.version, 1)
    assert.equal(receipt.orderId, input.orderId)
    return { ...result, receipt }
  })
  const publicRef = first.receipt.publicRef,
    adminPath = `/api/admin/returns/${publicRef}`
  async function read(state: ReturnState, version: number): Promise<AdminOrderReturn> {
    const result = await responseBody(await request(adminPath, input.adminCookie), 200),
      dto = adminOrderReturnSchema.parse(result.value)
    assert.equal(dto.publicRef, publicRef)
    assert.equal(dto.orderId, input.orderId)
    assert.equal(dto.state, state)
    assert.equal(dto.version, version)
    assert(dto.readiness.ready, 'native_returns_live_readiness_lost')
    return dto
  }
  async function rejected(path: string, cookie: string, method: string, body: unknown, key: string, code: string) {
    const result = await responseBody(await request(path, cookie, method, body, key), 409)
    error(result.value, code)
  }
  const common = {
    reason: `${staffMarker} internal documented operational reason`,
    publicMessage: 'Información pública del expediente y su revisión documentada.',
    evidence: `${staffMarker} internal warehouse evidence not a customer message`
  }
  function command(body: unknown) {
    return returnTransitionInputSchema.parse(body)
  }
  async function transition(body: ReturnTransitionInput, key: string) {
    const result = await responseBody(await request(adminPath, input.adminCookie, 'PUT', body, key), 200),
      receipt = returnCommandReceiptSchema.parse(result.value)
    assert.equal(receipt.returnId, first.receipt.returnId)
    assert.equal(receipt.action, body.action)
    assert.equal(receipt.version, body.expectedVersion + 1)
    const dto = await read(body.action, receipt.version)
    assert.equal(dto.timeline.items[0]?.commandId, receipt.commandId, 'native_returns_audit_receipt_mismatch')
    return { ...result, receipt, dto }
  }
  await check('exact_request_replay', async () => {
    const replay = await responseBody(
      await request(customerPath, input.customerCookie, 'POST', requestInput, `${prefix}:request`),
      201
    )
    assert.equal(replay.text, first.text)
    await read('requested', 1)
  })
  await check('request_key_conflict', () =>
    rejected(
      customerPath,
      input.customerCookie,
      'POST',
      { ...requestInput, reason: 'Changed request reason with the same key' },
      `${prefix}:request`,
      'idempotency_conflict'
    )
  )
  await check('stale_order_budget', () =>
    rejected(customerPath, input.customerCookie, 'POST', requestInput, `${prefix}:stale-request`, 'version_conflict')
  )
  await check('quantity_budget_conserved', () =>
    rejected(
      customerPath,
      input.customerCookie,
      'POST',
      {
        ...requestInput,
        expectedVersion: 1,
        lines: [{ lineIndex: line.lineIndex, quantity: line.availableQuantity - units + 1 }]
      },
      `${prefix}:oversubscribe`,
      'quantity_unavailable'
    )
  )
  await check('resolution_skip_rejected', () =>
    rejected(
      adminPath,
      input.adminCookie,
      'PUT',
      command({
        ...common,
        action: 'resolution_ready',
        expectedVersion: 1,
        resolution: 'Resolution proposal cannot skip physical custody'
      }),
      `${prefix}:skip`,
      'invalid_transition'
    )
  )
  const approval = command({
    ...common,
    action: 'approved',
    expectedVersion: 1,
    decisionRef: `${staffMarker}-manual-admission`,
    lines: [{ lineIndex: line.lineIndex, quantity: units }]
  })
  await check('stale_case_version', () =>
    rejected(
      adminPath,
      input.adminCookie,
      'PUT',
      { ...approval, expectedVersion: 2 },
      `${prefix}:stale-admission`,
      'version_conflict'
    )
  )
  const admitted = await check('documented_admission', () => transition(approval, `${prefix}:admission`))
  await check('received_overflow_rejected', () =>
    rejected(
      adminPath,
      input.adminCookie,
      'PUT',
      command({
        ...common,
        action: 'received',
        expectedVersion: 2,
        lines: [{ lineIndex: line.lineIndex, quantity: units + 1 }]
      }),
      `${prefix}:received-overflow`,
      'quantity_unavailable'
    )
  )
  let version = 2
  const received = async (quantity: number) => {
    const result = await transition(
      command({
        ...common,
        action: 'received',
        expectedVersion: version,
        lines: [{ lineIndex: line.lineIndex, quantity }]
      }),
      `${prefix}:received:${version}`
    )
    version = result.receipt.version
  }
  await check('first_physical_receipt', () => received(1))
  if (units > 1) {
    await check('inspection_requires_complete_receipt', () =>
      rejected(
        adminPath,
        input.adminCookie,
        'PUT',
        command({
          ...common,
          action: 'inspected',
          expectedVersion: version,
          lines: [{ lineIndex: line.lineIndex, quantity: 1, condition: 'unknown', disposition: 'quarantine' }]
        }),
        `${prefix}:early-inspection`,
        'invalid_transition'
      )
    )
    await check('remaining_physical_receipt', () => received(units - 1))
  }
  await check('received_claim_cannot_be_rejected', () =>
    rejected(
      adminPath,
      input.adminCookie,
      'PUT',
      command({ ...common, action: 'rejected', expectedVersion: version }),
      `${prefix}:reject-received`,
      'invalid_transition'
    )
  )
  const inspected = async (quantity: number) => {
    const result = await transition(
      command({
        ...common,
        action: 'inspected',
        expectedVersion: version,
        lines: [
          {
            lineIndex: line.lineIndex,
            quantity,
            condition: 'unknown',
            disposition: 'quarantine',
            note: `${staffMarker} custody inspection record`
          }
        ]
      }),
      `${prefix}:inspected:${version}`
    )
    version = result.receipt.version
  }
  await check('first_custody_inspection', () => inspected(1))
  if (units > 1) {
    await check('resolution_requires_complete_inspection', () =>
      rejected(
        adminPath,
        input.adminCookie,
        'PUT',
        command({
          ...common,
          action: 'resolution_ready',
          expectedVersion: version,
          resolution: `${staffMarker} prepared resolution`
        }),
        `${prefix}:early-resolution`,
        'invalid_transition'
      )
    )
    await check('remaining_custody_inspection', () => inspected(units - 1))
  }
  const final = await check('resolution_ready_no_economic_effect', () =>
    transition(
      command({
        ...common,
        action: 'resolution_ready',
        expectedVersion: version,
        resolution: `${staffMarker} economic decision remains pending`,
        cost: {
          amountCents: 0,
          currency: 'EUR',
          category: 'handling',
          evidenceRef: `${staffMarker}-cost`,
          description: 'Explicit zero documented operational cost, not refund'
        }
      }),
      `${prefix}:ready`
    )
  )
  version = final.receipt.version
  await check('terminal_custody_and_public_privacy', async () => {
    assert.equal(final.dto.capabilities.returnsTransitions, false)
    assert.deepEqual(final.dto.capabilities.allowedActions, [])
    assert.equal(final.dto.lines[0]!.claimedQuantity, units)
    assert.equal(final.dto.lines[0]!.receivedQuantity, units)
    assert.equal(final.dto.lines[0]!.inspectedQuantity, units)
    const dto = await customerRead()
    assert.equal(dto.returns[0]?.state, 'resolution_ready')
    assert.equal(dto.lines.find((item) => item.lineIndex === line.lineIndex)?.claimedQuantity, units)
    assert.equal(dto.returns[0]?.timeline.pagination.total, version)
  })
  await check('historical_request_replay', async () => {
    const result = await responseBody(
      await request(customerPath, input.customerCookie, 'POST', requestInput, `${prefix}:request`),
      201
    )
    assert.equal(result.text, first.text)
    await read('resolution_ready', version)
  })
  await check('historical_admission_replay', async () => {
    const result = await responseBody(
      await request(adminPath, input.adminCookie, 'PUT', approval, `${prefix}:admission`),
      200
    )
    assert.equal(result.text, admitted.text)
    await read('resolution_ready', version)
  })
  await check('native_admin_list_projection', async () => {
    const result = await responseBody(
        await request(`/api/admin/returns?q=${publicRef}&page=1&perPage=25`, input.adminCookie),
        200
      ),
      dto = adminReturnListSchema.parse(result.value)
    assert.equal(dto.items.length, 1)
    assert.equal(dto.items[0]?.publicRef, publicRef)
    assert.equal(dto.items[0]?.state, 'resolution_ready')
  })
  if (input.outsiderCookie)
    await check('different_customer_private_ownership', async () => {
      const result = await responseBody(await request(customerPath, input.outsiderCookie!), 404)
      error(result.value, 'not_found')
    })
  if (input.guestCookie)
    await check('guest_requires_unavailable_verification_contract', async () => {
      const result = await responseBody(await request(customerPath, input.guestCookie!), 403)
      error(result.value, 'guest_verification_required')
    })
  const after = await check('zero_inventory_payment_fiscal_effects', async () => {
    const result = await digests(input.database)
    assert.equal(result.inventory, before.inventory, 'native_returns_inventory_changed')
    assert.equal(result.contract, before.contract, 'native_returns_historical_or_economic_contract_changed')
    return result
  })
  return {
    scenarios: checks.length,
    checks,
    returnPublicRef: publicRef,
    version,
    finalState: 'resolution_ready',
    receivedUnits: units,
    inventoryDigestBefore: before.inventory,
    inventoryDigestAfter: after.inventory,
    inventoryUnchanged: true,
    contractUnchanged: true,
    economicEffects: false
  }
}
