import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { placeOrder, requestShippingOptions } from '../../workers/catalog/checkout'
import { createPackingOrder } from './d1-order-packing-fixture'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import { executeD1AdminPackingCommand } from '../../workers/fulfillment/packing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { FISCAL_RUNTIME_NOW as NOW, fiscalRuntimeClaims as claims } from './d1-fiscal-runtime-fixture'
import {
  dispatchBeplyOrders,
  publishBeplyOrders,
  readBeplyOrder,
  retryBeplyOrder
} from '../../workers/integrations/beply-orders'
import { BeplyOrdersProviderError } from '../../workers/integrations/beply-orders-provider'
import { beplyOrdersWorld } from './beply-orders-fixture'

const opened: DatabaseSync[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const db of opened.splice(0)) db.close()
})
const after = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString().replace('.000Z', 'Z')
const world = () => beplyOrdersWorld(opened)

describe('durable Beply orders and queue processing', () => {
  it('backfills paid orders and atomically captures future authorised/captured payment transitions', async () => {
    const w = await world()
    expect(w.row()).toMatchObject({ version: 1, synced_version: 0, status: 'pending' })
    w.sqlite
      .prepare("UPDATE order_payment_states SET status='provider_authorised',updated_at=? WHERE order_id=?")
      .run(NOW, w.order.orderId)
    expect(w.row()).toMatchObject({ version: 2 })
    w.sqlite.prepare('UPDATE order_payment_states SET updated_at=? WHERE order_id=?').run(NOW, w.order.orderId)
    expect(w.row()).toMatchObject({ version: 2 })
    await w.paid(w.policy)
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM beply_order_sync').get()!.n).toBe(2)
  })
  it('captures accepted B2B credit checkout without requiring a captured card payment', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
    const w = await world(),
      customerId = 'c1000000-0000-4000-8000-000000000001'
    w.sqlite
      .prepare('INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,?,?,?)')
      .run(customerId, 'Synthetic Company', NOW, NOW)
    w.sqlite.prepare('UPDATE identities SET customer_id=? WHERE id=?').run(customerId, claims.identityId)
    w.sqlite
      .prepare(
        "INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES('company',?,'Synthetic Company','approved',?,?)"
      )
      .run(customerId, NOW, NOW)
    w.sqlite
      .prepare(
        `INSERT INTO b2b_credit_commands(actor_id,command_id,session_id,session_version,company_id,expected_version,payment_days,credit_limit_cents,blocked,block_reason,reason,payload_hash,created_at)
      VALUES(?,'terms',?,1,'company',0,30,100000,0,NULL,'Synthetic credit agreement',?,?)`
      )
      .run(claims.identityId, claims.sessionId, 'a'.repeat(64), NOW)
    const cart = await createCart(w.database, { correlationId: 'beply-credit', now: NOW })
    const common = { ...cart, correlationId: 'beply-credit', now: NOW, ownerSession: claims }
    await setCartLine(w.database, {
      ...common,
      expectedVersion: 1,
      idempotencyKey: 'add',
      variantId: 'v-1-1',
      quantity: 1
    })
    const quote = await quoteCart(w.database, { ...common, expectedVersion: 2, idempotencyKey: 'quote' })
    const shipping = await requestShippingOptions(w.database, {
      ...common,
      expectedVersion: 2,
      idempotencyKey: 'shipping',
      destination: { city: 'Ontinyent', postalCode: '46870' }
    })
    if (quote.outcome !== 'quoted' || shipping.outcome !== 'options') throw new Error('credit_quote_failed')
    const option = (shipping.body.options as Array<{ optionIndex: number; optionHash: string }>)[0]!
    const placed = await placeOrder(w.database, {
      ...common,
      expectedVersion: 2,
      idempotencyKey: 'credit-order',
      quoteId: quote.quote.quoteId,
      shippingQuoteId: String(shipping.body.shippingQuoteId),
      selectedOptionIndex: option.optionIndex,
      selectedOptionHash: option.optionHash,
      paymentMethod: 'credit',
      contactEmail: 'credit@example.invalid',
      contactName: 'Synthetic Buyer',
      consentTos: true,
      consentPrivacy: true,
      shippingAddress: {
        recipientName: 'Synthetic Buyer',
        line1: 'Synthetic Street 1',
        city: 'Ontinyent',
        province: 'Valencia',
        postalCode: '46870',
        phone: '600000000'
      }
    })
    expect(placed.outcome).toBe('order_created')
    if (placed.outcome !== 'order_created') throw new Error('credit_checkout_failed')
    const orderId = String(placed.body.id)
    expect(w.sqlite.prepare('SELECT status FROM beply_order_sync WHERE order_id=?').get(orderId)).toMatchObject({
      status: 'pending'
    })
    expect(
      await dispatchBeplyOrders(w.database, w.adapter, { enabled: true, now: NOW, orderId, limit: 1 })
    ).toMatchObject({ completed: 1 })
    expect(w.adapter.createOrder.mock.calls[0]![0]).toMatchObject({
      orderId,
      paymentMethod: 'credit',
      customer: { externalKey: customerId }
    })
    const view = await readBeplyOrder(w.database, { kind: 'customer', claims }, orderId, NOW)
    expect(view).toMatchObject({ audience: 'customer', lastErrorCode: null, providerOrderId: '71' })
    expect(JSON.stringify(view)).not.toContain('credit@example.invalid')
  })
  it('captures real preparation, packing, shipment tracking and delivery commands', async () => {
    const w = await world()
    w.sqlite
      .exec(`INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,created_at) VALUES('parcel-zone','parcel','Synthetic parcel','parcel_peninsular','["peninsular"]','${NOW}');
      INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,created_at) VALUES('parcel-rate','parcel-zone','parcel','parcel',100,1000,1,2,1,'${NOW}');`)
    const orderId = await createPackingOrder(w.database, { method: 'parcel', stage: 'pending', now: NOW })
    const run = () => dispatchBeplyOrders(w.database, w.adapter, { enabled: true, now: NOW, orderId, limit: 1 })
    for (const [expectedVersion, action] of ['picking', 'packed'].entries()) {
      await executeD1AdminFulfillmentCommand(
        w.database,
        claims,
        orderId,
        { action, expectedVersion, reason: 'Synthetic operational transition' },
        { idempotencyKey: `beply-${action}`, now: NOW }
      )
    }
    await run()
    expect(w.adapter.createOrder.mock.calls[0]![0].state).toBe('preparing')
    await executeD1AdminPackingCommand(
      w.database,
      claims,
      orderId,
      {
        action: 'pack',
        expectedVersion: 0,
        expectedFulfillmentVersion: 2,
        reason: 'Synthetic packing command',
        parcels: [
          { weightGrams: 1000, widthMm: 100, heightMm: 100, depthMm: 100, contents: [{ lineIndex: 0, quantity: 4 }] }
        ]
      },
      { idempotencyKey: 'a1000000-0000-4000-8000-000000000001', now: NOW }
    )
    await executeD1AdminPackingCommand(
      w.database,
      claims,
      orderId,
      {
        action: 'manual_dispatch',
        expectedVersion: 1,
        expectedFulfillmentVersion: 2,
        reason: 'Synthetic dispatch command',
        shipments: [
          {
            parcelIndex: 0,
            carrier: 'Synthetic carrier',
            shipmentNumber: 'SHIP1',
            trackingNumber: 'TRACK1',
            externalLabelReference: 'LABEL1'
          }
        ],
        actualNetCents: 100,
        taxBps: 1000
      },
      { idempotencyKey: 'a1000000-0000-4000-8000-000000000002', now: NOW }
    )
    await run()
    expect(w.adapter.updateOrder.mock.lastCall![1]).toMatchObject({
      state: 'shipped',
      shipments: [{ carrier: 'Synthetic carrier', trackingNumber: 'TRACK1', shipmentNumber: 'SHIP1', parcelIndex: 0 }]
    })
    for (const [index, action] of ['in_transit', 'delivered'].entries()) {
      await executeD1AdminFulfillmentCommand(
        w.database,
        claims,
        orderId,
        {
          action,
          expectedVersion: index + 2,
          reason: 'Synthetic operational transition',
          evidence: 'Synthetic physical delivery evidence'
        },
        { idempotencyKey: `beply-${action}`, now: NOW }
      )
    }
    await run()
    expect(w.adapter.updateOrder.mock.lastCall![1].state).toBe('delivered')
  })
  it('enforces canonical timestamps and complete lease ownership in STRICT SQL', async () => {
    const w = await world()
    expect(() =>
      w.sqlite.prepare("UPDATE beply_order_sync SET lease_token='orphan' WHERE order_id=?").run(w.order.orderId)
    ).toThrow()
    expect(() =>
      w.sqlite
        .prepare("UPDATE beply_order_sync SET due_at='2026-02-30T00:00:00Z' WHERE order_id=?")
        .run(w.order.orderId)
    ).toThrow()
    expect(() =>
      w.sqlite.prepare('UPDATE beply_order_sync SET attempts=-1 WHERE order_id=?').run(w.order.orderId)
    ).toThrow()
  })
  it('is opt in and never invokes the provider when disabled', async () => {
    const w = await world()
    expect(await dispatchBeplyOrders(w.database, w.adapter, { now: NOW })).toMatchObject({ disabled: true })
    expect(w.adapter.createOrder).not.toHaveBeenCalled()
    expect(w.row()).toMatchObject({ status: 'pending', attempts: 0 })
  })
  it('sends only durable IDs to the queue and an outage leaves checkout/payment untouched', async () => {
    const w = await world(),
      queue = { send: vi.fn().mockRejectedValue(new Error('token=secret PII')) }
    expect(await publishBeplyOrders(w.database, queue, { now: NOW, limit: 1 })).toMatchObject({ retryable: 1 })
    expect(
      w.sqlite.prepare('SELECT status FROM order_payment_states WHERE order_id=?').get(w.order.orderId)!.status
    ).toBe('paid')
    expect(w.row()).toMatchObject({ queue_attempts: 1, queue_due_at: after(30) })
    expect(JSON.stringify(w.row())).not.toContain('secret')
    queue.send.mockResolvedValue(undefined)
    expect(await publishBeplyOrders(w.database, queue, { now: after(30), limit: 1 })).toMatchObject({ published: 1 })
    expect(queue.send.mock.lastCall![0]).toEqual({
      type: 'beply.order.sync',
      schemaVersion: 1,
      orderId: w.order.orderId
    })
  })
  it('syncs a snapshot once, including product/variant references and shipping tax, despite duplicate delivery', async () => {
    const w = await world()
    expect(await w.run()).toMatchObject({ completed: 1 })
    expect(w.row()).toMatchObject({ status: 'synced', synced_version: 1, provider_order_id: '71' })
    expect(w.adapter.createOrder).toHaveBeenCalledTimes(1)
    expect(w.adapter.createOrder.mock.calls[0]![0]).toMatchObject({
      orderId: w.order.orderId,
      state: 'confirmed',
      shippingNetCents: 100,
      shippingTaxRateBasisPoints: 1000,
      lines: [expect.objectContaining({ variantId: 'v-1-1', sku: 'SKU-1-1' })]
    })
    expect(await w.run()).toMatchObject({ completed: 0 })
    expect(w.adapter.createOrder).toHaveBeenCalledTimes(1)
  })
  it('coalesces a newer cancellation during a lease without acknowledging the unsent version', async () => {
    const w = await world()
    w.adapter.createOrder.mockImplementationOnce(async () => {
      w.sqlite.prepare("UPDATE orders SET status='cancelled',updated_at=? WHERE id=?").run(after(1), w.order.orderId)
      return { providerOrderId: '71', code: 'PED71' }
    })
    await w.run()
    expect(w.row()).toMatchObject({ version: 2, synced_version: 1, status: 'pending', provider_order_id: '71' })
    await w.run(after(1))
    expect(w.adapter.createOrder).toHaveBeenCalledTimes(1)
    expect(w.adapter.updateOrder.mock.calls[0]![1]).toMatchObject({ state: 'cancelled', version: 2 })
    expect(w.row()).toMatchObject({ status: 'synced', synced_version: 2 })
  })
  it('persists create-start before POST, reconciles a lost response and never posts twice', async () => {
    const w = await world()
    w.adapter.createOrder.mockImplementationOnce(async () => {
      expect(w.row().create_state).toBe('started')
      throw new BeplyOrdersProviderError('transport', true, true)
    })
    expect(await w.run()).toMatchObject({ retryable: 1 })
    expect(w.row()).toMatchObject({ create_state: 'started', due_at: after(30) })
    w.adapter.lookupOrder.mockResolvedValue({ providerOrderId: '71', code: 'PED71' })
    expect(await w.run(after(30))).toMatchObject({ completed: 1 })
    expect(w.adapter.createOrder).toHaveBeenCalledTimes(1)
    expect(w.adapter.lookupOrder).toHaveBeenCalledTimes(2)
    expect(w.row().provider_order_id).toBe('71')
  })
  it('retries a definitively rejected create without losing its original identity', async () => {
    const w = await world()
    w.adapter.createOrder.mockRejectedValueOnce(new BeplyOrdersProviderError('provider', true, false))
    expect(await w.run()).toMatchObject({ retryable: 1 })
    expect(w.row().create_state).toBe('none')
    const firstHash = w.row().create_hash
    expect(await w.run(after(30))).toMatchObject({ completed: 1 })
    expect(w.adapter.createOrder).toHaveBeenCalledTimes(2)
    expect(w.row().create_hash).toBe(firstHash)
  })
  it('allows a manual retry after a definitively rejected create without retrying uncertain accepted documents', async () => {
    const w = await world()
    w.adapter.createOrder.mockRejectedValueOnce(new BeplyOrdersProviderError('credentials', false, false))
    expect(await w.run()).toMatchObject({ manualReview: 1 })
    expect(w.row()).toMatchObject({ status: 'manual_review', create_state: 'none' })
    await retryBeplyOrder(
      w.database,
      claims,
      w.order.orderId,
      { commandId: 'credentials-corrected', expectedVersion: 1, reason: 'Synthetic credentials now corrected' },
      NOW
    )
    expect(await w.run()).toMatchObject({ completed: 1 })
    expect(w.adapter.createOrder).toHaveBeenCalledTimes(2)
  })
  it('quarantines unknown create outcome even if lookup is temporarily empty', async () => {
    const w = await world()
    w.adapter.createOrder.mockRejectedValueOnce(new BeplyOrdersProviderError('transport', true, true))
    await w.run()
    expect(await w.run(after(30))).toMatchObject({ manualReview: 1 })
    expect(w.row()).toMatchObject({ status: 'manual_review', last_error_code: 'create_outcome_unknown' })
    expect(w.adapter.createOrder).toHaveBeenCalledTimes(1)
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM beply_order_alerts').get()!.n).toBeGreaterThan(0)
  })
  it('retries known safe provider failures with bounded exponential backoff and sanitised alerts', async () => {
    const w = await world()
    w.adapter.lookupOrder.mockRejectedValue(new BeplyOrdersProviderError('provider', true))
    await w.run()
    expect(w.row()).toMatchObject({ status: 'pending', due_at: after(30), attempts: 1, create_state: 'none' })
    await w.run(after(30))
    expect(w.row()).toMatchObject({ due_at: after(90), attempts: 2 })
    expect(w.adapter.createOrder).not.toHaveBeenCalled()
  })
  it('prevents concurrent workers and fences the acknowledgement of an expired lease', async () => {
    const w = await world()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    w.adapter.createOrder.mockImplementationOnce(async () => {
      await held
      return { providerOrderId: '71', code: 'PED71' }
    })
    const first = w.run()
    await vi.waitFor(() => expect(w.adapter.createOrder).toHaveBeenCalledTimes(1))
    expect(await w.run()).toMatchObject({ completed: 0 })
    w.adapter.lookupOrder.mockResolvedValue({ providerOrderId: '71', code: 'PED71' })
    expect(await w.run(after(301))).toMatchObject({ completed: 1 })
    release()
    expect(await first).toMatchObject({ lostLease: 1 })
    expect(w.row()).toMatchObject({ status: 'synced', attempts: 2 })
  })
  it('reads back ERP state periodically and exposes it only to the order owner/admin', async () => {
    const w = await world()
    await w.run()
    const admin = { kind: 'admin' as const, claims }
    expect(await readBeplyOrder(w.database, admin, w.order.orderId, NOW)).toMatchObject({
      orderId: w.order.orderId,
      state: 'confirmed',
      erp: { served: true, deliveryNoteIds: ['81'], invoiceIds: ['91'] }
    })
    const customer = { kind: 'customer' as const, claims }
    await expect(readBeplyOrder(w.database, customer, w.order.orderId, NOW)).rejects.toThrow()
    await expect(
      readBeplyOrder(w.database, { kind: 'admin', claims: { ...claims, sessionVersion: 2 } }, w.order.orderId, NOW)
    ).rejects.toThrow()
    w.adapter.readOrder.mockResolvedValue({ served: false, deliveryNoteIds: [], invoiceIds: [] })
    await w.run(after(901))
    expect(w.adapter.createOrder).toHaveBeenCalledTimes(1)
    expect(w.adapter.readOrder).toHaveBeenCalledTimes(2)
    expect((await readBeplyOrder(w.database, admin, w.order.orderId, after(901))).erp?.served).toBe(false)
  })
  it('retains existing ERP evidence when polling fails, with a visible stale timestamp', async () => {
    const w = await world()
    await w.run()
    w.adapter.readOrder.mockRejectedValueOnce(new BeplyOrdersProviderError('provider', true))
    await w.run(after(901))
    const view = await readBeplyOrder(w.database, { kind: 'admin', claims }, w.order.orderId, after(901))
    expect(view.erp?.served).toBe(true)
    expect(view.erpCheckedAt).toBe(NOW)
    expect(view.lastErrorCode).toBe('provider')
  })
  it('requires fresh MFA authority, CAS and command/payload idempotency for manual retries', async () => {
    const w = await world()
    w.adapter.lookupOrder.mockRejectedValueOnce(new BeplyOrdersProviderError('credentials'))
    await w.run()
    const input = { commandId: 'retry-1', expectedVersion: 1, reason: 'Synthetic credentials corrected' }
    await expect(
      retryBeplyOrder(w.database, { ...claims, sessionVersion: 2 }, w.order.orderId, input, NOW)
    ).rejects.toThrow()
    await expect(
      retryBeplyOrder(w.database, claims, w.order.orderId, { ...input, expectedVersion: 2 }, NOW)
    ).rejects.toThrow('version_conflict')
    expect(await retryBeplyOrder(w.database, claims, w.order.orderId, input, NOW)).toMatchObject({ version: 2 })
    expect(await retryBeplyOrder(w.database, claims, w.order.orderId, input, NOW)).toMatchObject({ version: 2 })
    await expect(
      retryBeplyOrder(w.database, claims, w.order.orderId, { ...input, reason: 'Changed content must conflict' }, NOW)
    ).rejects.toThrow('idempotency_conflict')
    expect(w.row().version).toBe(2)
  })
  it('quarantines an expired tenth attempt without more provider calls', async () => {
    const w = await world()
    w.sqlite
      .prepare(
        "UPDATE beply_order_sync SET attempts=10,status='leased',lease_token='old',lease_until=? WHERE order_id=?"
      )
      .run(NOW, w.order.orderId)
    expect(await w.run()).toMatchObject({ manualReview: 1 })
    expect(w.row()).toMatchObject({ status: 'manual_review', last_error_code: 'attempts_exhausted' })
    expect(w.adapter.lookupOrder).not.toHaveBeenCalled()
  })
  it('never changes payment, stock, fiscal authority or total when Beply fails', async () => {
    const w = await world()
    w.adapter.lookupOrder.mockRejectedValueOnce(new Error('Bearer real-secret customer@example.invalid'))
    const before = w.sqlite.prepare('SELECT total_gross_cents FROM orders WHERE id=?').get(w.order.orderId)
    expect(await w.run()).toMatchObject({ manualReview: 1 })
    expect(w.sqlite.prepare('SELECT total_gross_cents FROM orders WHERE id=?').get(w.order.orderId)).toEqual(before)
    expect(w.row().last_error_code).toBe('sync_failed')
    expect(JSON.stringify(w.sqlite.prepare('SELECT * FROM beply_order_alerts').all())).not.toContain('real-secret')
  })
})
