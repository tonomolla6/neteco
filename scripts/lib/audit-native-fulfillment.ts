import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  adminOrderFulfillmentSchema,
  allowedFulfillmentActions,
  fulfillmentCommandReceiptSchema,
  fulfillmentOrderIdSchema,
  fulfillmentTransitionInputSchema,
  type AdminOrderFulfillment,
  type FulfillmentAction,
  type FulfillmentCommandReceipt,
  type OrderFulfillmentState
} from '../../shared/order-fulfillment'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { canonicalJson } from '../../workers/catalog/inventory'

export interface NativeFulfillmentAuditInput {
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  /** Root creates this order through checkout and captures its payment through
   * a signed synthetic Redsys callback. This helper cannot manufacture proof. */
  orderId: string
  scenario: (name: string) => void
}
export interface NativeFulfillmentAuditEvidence {
  scenarios: number
  checks: readonly string[]
  shippingMethod: 'pickup' | 'own_delivery' | 'parcel'
  transitions: 6
  finalState: 'delivered'
  finalVersion: 6
  inventoryDigestBefore: string
  inventoryDigestAfter: string
  inventoryUnchanged: true
  contractUnchanged: true
}
interface Digests {
  inventory: string
  contract: string
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}
function denseArray(value: unknown): unknown[] {
  assert(
    Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype,
    'native_fulfillment_d1_array_unconfirmed'
  )
  assert.equal(Reflect.ownKeys(value).length, value.length + 1, 'native_fulfillment_d1_array_unconfirmed')
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    assert(
      descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable,
      'native_fulfillment_d1_array_unconfirmed'
    )
    return descriptor.value as unknown
  })
}
function confirmedRows(value: unknown): unknown[] {
  assert.equal(own(value, 'success'), true, 'native_fulfillment_d1_success_unconfirmed')
  return denseArray(own(value, 'results')).map((row) => catalogPolicyOwnJson(row))
}
function digest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
/** One read-only batch: no fabricated payment facts, inventory adjustments,
 * reservation releases or timestamp normalization can hide an unwanted effect. */
async function readDigests(database: D1Database, orderId: string): Promise<Digests> {
  const result: unknown = await database.batch([
    database.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id'),
    database.prepare('SELECT * FROM inventory_reservations ORDER BY id'),
    database.prepare('SELECT * FROM inventory_reservation_lines ORDER BY reservation_id,variant_id,location_id'),
    database.prepare('SELECT * FROM inventory_movements ORDER BY id'),
    database.prepare('SELECT * FROM orders WHERE id=?').bind(orderId),
    database.prepare('SELECT * FROM order_lines WHERE order_id=? ORDER BY line_index').bind(orderId),
    database.prepare('SELECT * FROM order_shipping_address WHERE order_id=?').bind(orderId),
    database.prepare('SELECT * FROM order_billing_address WHERE order_id=?').bind(orderId)
  ])
  const results = denseArray(result)
  assert.equal(results.length, 8, 'native_fulfillment_d1_batch_unconfirmed')
  const rows = results.map(confirmedRows)
  assert.equal(rows[4]!.length, 1, 'native_fulfillment_contract_missing')
  assert(rows[5]!.length > 0, 'native_fulfillment_contract_lines_missing')
  return { inventory: digest(rows.slice(0, 4)), contract: digest(rows.slice(4)) }
}
function privateHeaders(response: Response) {
  assert.match(response.headers.get('cache-control') ?? '', /\bprivate\b/, 'native_fulfillment_private_cache_missing')
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/, 'native_fulfillment_no_store_missing')
  assert.match(response.headers.get('vary') ?? '', /\bcookie\b/i, 'native_fulfillment_cookie_vary_missing')
  assert.match(response.headers.get('x-robots-tag') ?? '', /\bnoindex\b/, 'native_fulfillment_noindex_missing')
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i, 'native_fulfillment_json_missing')
}
async function responseBody(response: Response, expectedStatus: number) {
  privateHeaders(response)
  assert.equal(response.status, expectedStatus, 'native_fulfillment_http_status_mismatch')
  const text = await response.text()
  assert(text.length > 0 && text.length <= 128 * 1024, 'native_fulfillment_response_size_unconfirmed')
  let value: unknown
  try {
    value = catalogPolicyOwnJson(JSON.parse(text) as unknown)
  } catch {
    throw new Error('native_fulfillment_response_json_unconfirmed')
  }
  return { text, value }
}
function assertError(value: unknown, expectedCode: string) {
  assert(
    value !== null && typeof value === 'object' && Object.keys(value).length === 1,
    'native_fulfillment_error_unconfirmed'
  )
  const failure = own(value, 'error')
  assert(
    failure !== null && typeof failure === 'object' && Object.keys(failure).length === 1,
    'native_fulfillment_error_unconfirmed'
  )
  assert.equal(own(failure, 'code'), expectedCode, 'native_fulfillment_error_code_mismatch')
}

/** Native HTTP/D1 validation only, scoped to a disposable locally paid order.
 * No fetch, gateway, credentials, synthetic paid UPDATE or stock write exists
 * here. Every effect comes from the actual guarded fulfillment HTTP handler. */
export async function auditNativeFulfillment(
  input: NativeFulfillmentAuditInput
): Promise<NativeFulfillmentAuditEvidence> {
  const origin = new URL(input.origin)
  assert(
    origin.protocol === 'https:' &&
      origin.origin === input.origin &&
      (origin.hostname.endsWith('.test') || origin.hostname.endsWith('.invalid')),
    'native_fulfillment_local_origin_required'
  )
  assert(fulfillmentOrderIdSchema.safeParse(input.orderId).success, 'native_fulfillment_order_id_invalid')
  assert(
    typeof input.adminCookie === 'string' &&
      input.adminCookie.length > 0 &&
      input.adminCookie.length <= 16_384 &&
      !/[\r\n]/.test(input.adminCookie),
    'native_fulfillment_cookie_invalid'
  )
  assert(typeof input.scenario === 'function', 'native_fulfillment_scenario_callback_missing')
  const checks: string[] = []
  async function check<T>(name: string, run: () => Promise<T>) {
    const scenario = `native_fulfillment_${name}`
    input.scenario(scenario)
    const result = await run()
    checks.push(scenario)
    return result
  }
  const path = `${input.origin}/api/admin/orders/${input.orderId}/fulfillment`
  const keyPrefix = `native-fulfillment:${randomUUID()}`
  const reason = 'Synthetic disposable native fulfillment audit operation'
  const evidence = 'Synthetic local-only operational evidence; not a real carrier delivery'
  const send = (action: FulfillmentAction, expectedVersion: number, key: string) => {
    const body = fulfillmentTransitionInputSchema.parse({
      action,
      expectedVersion,
      reason,
      ...(['exception', 'in_transit', 'delivered'].includes(action) ? { evidence } : {})
    })
    return input.dispatch(
      new Request(`${path}/transitions`, {
        method: 'POST',
        headers: {
          Origin: input.origin,
          Cookie: input.adminCookie,
          'Content-Type': 'application/json',
          'Idempotency-Key': key
        },
        body: JSON.stringify(body)
      })
    )
  }
  let method: 'pickup' | 'own_delivery' | 'parcel', warehouseId: string
  async function read(
    state: OrderFulfillmentState,
    version: number,
    interrupted: OrderFulfillmentState | null = null
  ): Promise<AdminOrderFulfillment> {
    const body = await responseBody(
      await input.dispatch(
        new Request(`${path}?page=1&perPage=25`, {
          headers: { Origin: input.origin, Cookie: input.adminCookie }
        })
      ),
      200
    )
    const parsed = adminOrderFulfillmentSchema.safeParse(body.value)
    assert(parsed.success, 'native_fulfillment_dto_unconfirmed')
    const data = parsed.data
    assert.equal(data.orderId, input.orderId, 'native_fulfillment_wrong_order')
    assert.equal(data.state, state, 'native_fulfillment_state_mismatch')
    assert.equal(data.version, version, 'native_fulfillment_version_mismatch')
    assert.equal(data.interruptedState, interrupted, 'native_fulfillment_interrupted_state_mismatch')
    assert(
      data.readiness.ready && data.readiness.blockers.length === 0 && data.warehouse && data.shippingMethod,
      'native_fulfillment_payment_assignment_or_history_unconfirmed'
    )
    if (version > 0) {
      assert.equal(data.shippingMethod, method, 'native_fulfillment_shipping_contract_changed')
      assert.equal(data.warehouse.id, warehouseId, 'native_fulfillment_warehouse_contract_changed')
    }
    assert.deepEqual(
      data.capabilities.allowedActions,
      allowedFulfillmentActions(state, interrupted, data.shippingMethod),
      'native_fulfillment_actions_mismatch'
    )
    assert.equal(
      data.capabilities.fulfillmentTransitions,
      state !== 'delivered',
      'native_fulfillment_capability_mismatch'
    )
    assert.equal(data.timeline.items.length, version, 'native_fulfillment_history_incomplete')
    assert.deepEqual(
      data.timeline.items.map((item) => item.version),
      Array.from({ length: version }, (_, index) => version - index),
      'native_fulfillment_history_order_mismatch'
    )
    assert.equal(
      new Set(data.timeline.items.map((item) => item.commandId)).size,
      version,
      'native_fulfillment_history_duplicates'
    )
    return data
  }
  async function transition(
    action: FulfillmentAction,
    version: number,
    interrupted: OrderFulfillmentState | null = null
  ) {
    const body = await responseBody(await send(action, version, `${keyPrefix}:${action}:${version}`), 200)
    const parsed = fulfillmentCommandReceiptSchema.safeParse(body.value)
    assert(parsed.success, 'native_fulfillment_receipt_unconfirmed')
    const receipt: FulfillmentCommandReceipt = parsed.data
    assert.equal(receipt.orderId, input.orderId, 'native_fulfillment_receipt_wrong_order')
    assert.equal(receipt.warehouseId, warehouseId, 'native_fulfillment_receipt_wrong_warehouse')
    assert.equal(receipt.action, action, 'native_fulfillment_receipt_wrong_action')
    assert.equal(receipt.version, version + 1, 'native_fulfillment_receipt_wrong_version')
    assert.equal(receipt.interruptedState, interrupted, 'native_fulfillment_receipt_wrong_interrupted_state')
    const current = await read(action, version + 1, interrupted)
    assert.equal(current.timeline.items[0]!.commandId, receipt.commandId, 'native_fulfillment_receipt_audit_mismatch')
    return body.text
  }
  async function rejected(action: FulfillmentAction, version: number, key: string, code: string) {
    const body = await responseBody(await send(action, version, key), 409)
    assertError(body.value, code)
  }

  const before = await check('paid_assigned_baseline', async () => {
    const baseline = await read('pending', 0)
    method = baseline.shippingMethod!
    warehouseId = baseline.warehouse!.id
    return readDigests(input.database, input.orderId)
  })
  await check('initial_skip_rejected', () => rejected('delivered', 0, `${keyPrefix}:skip`, 'invalid_transition'))
  const firstReceipt = await check('picking', () => transition('picking', 0))
  await check('exact_replay', async () => {
    const replay = await responseBody(await send('picking', 0, `${keyPrefix}:picking:0`), 200)
    assert.equal(replay.text === firstReceipt, true, 'native_fulfillment_replay_bytes_changed')
    await read('picking', 1)
  })
  await check('idempotency_conflict', () => rejected('packed', 1, `${keyPrefix}:picking:0`, 'idempotency_conflict'))
  await check('stale_version_rejected', () => rejected('packed', 0, `${keyPrefix}:stale`, 'version_conflict'))
  await check('exception_recorded', () => transition('exception', 1, 'picking'))
  await check('exception_resume_skip_rejected', () =>
    rejected('packed', 2, `${keyPrefix}:skip-resume`, 'invalid_transition')
  )
  await check('exception_resume', () => transition('picking', 2))
  await check('packed', () => transition('packed', 3))
  await check('shipping_mode_mismatch', () =>
    rejected(
      method === 'pickup' ? 'in_transit' : 'ready_for_pickup',
      4,
      `${keyPrefix}:wrong-shipping`,
      'shipping_mode_mismatch'
    )
  )
  await check(method! === 'pickup' ? 'ready_for_pickup' : 'in_transit', () =>
    transition(method === 'pickup' ? 'ready_for_pickup' : 'in_transit', 4)
  )
  await check('delivered', () => transition('delivered', 5))
  await check('historical_replay_after_delivery', async () => {
    const replay = await responseBody(await send('picking', 0, `${keyPrefix}:picking:0`), 200)
    assert.equal(replay.text === firstReceipt, true, 'native_fulfillment_historical_replay_bytes_changed')
    await read('delivered', 6)
  })
  await check('terminal_transition_rejected', () =>
    rejected('exception', 6, `${keyPrefix}:after-delivery`, 'invalid_transition')
  )
  const after = await check('unchanged_inventory_and_contract', async () => {
    const value = await readDigests(input.database, input.orderId)
    assert.equal(value.inventory, before.inventory, 'native_fulfillment_inventory_changed')
    assert.equal(value.contract, before.contract, 'native_fulfillment_historical_order_contract_changed')
    return value
  })
  return {
    scenarios: checks.length,
    checks,
    shippingMethod: method!,
    transitions: 6,
    finalState: 'delivered',
    finalVersion: 6,
    inventoryDigestBefore: before.inventory,
    inventoryDigestAfter: after.inventory,
    inventoryUnchanged: true,
    contractUnchanged: true
  }
}
