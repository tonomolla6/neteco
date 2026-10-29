import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deterministicTestData } from '../fixtures/deterministic'
import { packingFixture, createPackingOrder, CLAIMS, REASON, utc } from './d1-order-packing-fixture'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import {
  readD1AdminPacking,
  executeD1AdminPackingCommand,
  readD1AdminPackingCommand
} from '../../workers/fulfillment/packing'
import { adminOrderPackingSchema, orderPackingInputSchema, orderPackingIntentHash } from '../../shared/order-packing'

describe('SHP013/018/020 governed packing and manual contingency shipment', () => {
  let f: Awaited<ReturnType<typeof packingFixture>>
  const data = deterministicTestData('packing-command')
  const parcel = (quantity = 2) => ({
    weightGrams: 1000,
    widthMm: 100,
    heightMm: 200,
    depthMm: 300,
    contents: [{ lineIndex: 0, quantity }]
  })
  const pack = (expectedVersion = 0, expectedFulfillmentVersion = 1) => ({
    action: 'pack' as const,
    expectedVersion,
    expectedFulfillmentVersion,
    reason: REASON,
    parcels: [parcel(), parcel()]
  })
  const dispatch = (expectedVersion = 1) => ({
    action: 'manual_dispatch' as const,
    expectedVersion,
    expectedFulfillmentVersion: 2,
    reason: REASON,
    actualNetCents: 999,
    taxBps: 2100,
    shipments: [0, 1].map((parcelIndex) => ({
      parcelIndex,
      carrier: 'Synthetic manually declared carrier',
      shipmentNumber: `SHIP-${parcelIndex}`,
      trackingNumber: `TRACK-${parcelIndex}`,
      externalLabelReference: `EXTERNAL-LABEL-${parcelIndex}`
    }))
  })
  const execute = (body: unknown, key = data.uuid(), db?: D1Database) =>
    executeD1AdminPackingCommand(db ?? f.database, CLAIMS, f.orderId, body, { idempotencyKey: key })
  beforeEach(async () => {
    f = await packingFixture()
  })
  afterEach(() => f?.sqlite.close())
  async function packed() {
    await executeD1AdminFulfillmentCommand(
      f.database,
      CLAIMS,
      f.orderId,
      { action: 'packed', expectedVersion: 1, reason: REASON },
      { idempotencyKey: data.uuid() }
    )
  }
  function race(change: () => void | Promise<void>) {
    return new Proxy(f.database, {
      get(db, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            await change()
            return db.batch(statements)
          }
        const value = Reflect.get(db, key)
        return typeof value === 'function' ? value.bind(db) : value
      }
    })
  }
  it('reads the actual contractual order lines and version0 without writes or fake packing', async () => {
    const before = f.economic()
    const result = await readD1AdminPacking(f.database, CLAIMS, f.orderId)
    expect(adminOrderPackingSchema.safeParse(result).success).toBe(true)
    expect(result).toMatchObject({
      version: 0,
      state: 'unpacked',
      parcels: [],
      dispatch: null,
      fulfillmentVersion: 1,
      fulfillmentState: 'picking',
      capabilities: { packingWrite: true, manualDispatch: false },
      lines: [{ lineIndex: 0, quantity: 4 }]
    })
    expect(f.economic()).toEqual(before)
  })
  it('records a complete split across two parcels with immutable command/audit and zero stock/money effects', async () => {
    const before = f.economic(),
      key = data.uuid(),
      body = pack()
    const result = await execute(body, key)
    expect(result).toMatchObject({
      commandId: key,
      action: 'pack',
      version: 1,
      fulfillmentVersion: 1,
      parcelCount: 2,
      inventoryEffect: 'none',
      economicEffect: 'none',
      providerEffect: 'none'
    })
    expect(await readD1AdminPacking(f.database, CLAIMS, f.orderId)).toMatchObject({
      version: 1,
      state: 'packed',
      parcels: body.parcels
    })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM order_packing_commands').get()).toEqual({ n: 1 })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM order_packing_audit').get()).toEqual({ n: 1 })
    expect(f.economic()).toEqual(before)
  })
  it.each([
    ['missing', [parcel(3)]],
    ['extra', [parcel(5)]],
    ['foreign', [{ ...parcel(4), contents: [{ lineIndex: 9, quantity: 4 }] }]]
  ])('rejects %s line quantities atomically', async (_label, parcels) => {
    await expect(execute({ ...pack(), parcels })).rejects.toMatchObject({ code: 'packing_incomplete' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM order_packing_commands').get()).toEqual({ n: 0 })
  })
  it('preserves every prior packing revision and replays only the exact original input', async () => {
    const key = data.uuid(),
      body = pack(),
      receipt = await execute(body, key)
    await execute({ ...pack(1), parcels: [parcel(4)] })
    expect(await execute(body, key)).toEqual(receipt)
    await expect(execute({ ...body, reason: 'Different synthetic operational reason' }, key)).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM order_packing_commands').get()).toEqual({ n: 2 })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM order_packing_audit').get()).toEqual({ n: 2 })
  })
  it('recovers exact UUID/hash receipts and distinguishes genuine unknown from corrupted history', async () => {
    const key = data.uuid(),
      body = pack(),
      receipt = await execute(body, key),
      hash = await orderPackingIntentHash(f.orderId, body)
    expect(await readD1AdminPackingCommand(f.database, CLAIMS, f.orderId, key, hash)).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt
    })
    expect(await readD1AdminPackingCommand(f.database, CLAIMS, f.orderId, data.uuid(), hash)).toEqual({
      source: 'cloudflare',
      outcome: 'unknown'
    })
    await expect(readD1AdminPackingCommand(f.database, CLAIMS, f.orderId, key, 'f'.repeat(64))).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
  })
  it('registers one manual shipment per parcel and actual vs quoted integer costs without changing fulfillment', async () => {
    await execute(pack())
    await packed()
    const before = f.economic(),
      result = await execute(dispatch())
    expect(result).toMatchObject({ action: 'manual_dispatch', version: 2, fulfillmentVersion: 2 })
    const read = await readD1AdminPacking(f.database, CLAIMS, f.orderId)
    expect(read).toMatchObject({
      state: 'manual_dispatch_recorded',
      dispatch: {
        actualNetCents: 999,
        actualTaxCents: 210,
        actualGrossCents: 1209,
        labelVerification: 'unverified_reference_only'
      },
      capabilities: { packingWrite: false, manualDispatch: false }
    })
    expect(read.dispatch?.varianceGrossCents).toBe(1209 - read.quotedGrossCents)
    expect(f.economic()).toEqual(before)
    await expect(execute(pack(2, 2))).rejects.toMatchObject({ code: 'packing_locked' })
  })
  it('requires packed fulfillment and complete per-parcel shipment metadata', async () => {
    await execute(pack())
    await expect(execute({ ...dispatch(), expectedFulfillmentVersion: 1 })).rejects.toMatchObject({
      code: 'invalid_transition'
    })
    await packed()
    await expect(execute({ ...dispatch(), shipments: [dispatch().shipments[0]] })).rejects.toMatchObject({
      code: 'packing_incomplete'
    })
  })
  it('enforces both packing and live fulfillment CAS', async () => {
    await expect(execute(pack(1))).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(execute(pack(0, 0))).rejects.toMatchObject({ code: 'fulfillment_version_conflict' })
  })
  it('rolls back if the session is revoked immediately before the atomic batch', async () => {
    const db = race(() => {
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
    })
    await expect(execute(pack(), data.uuid(), db)).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM order_packing_commands').get()).toEqual({ n: 0 })
  })
  it('rejects stale fulfillment facts when a concurrent real preparation command wins before batch', async () => {
    const db = race(packed)
    await expect(execute(pack(), data.uuid(), db)).rejects.toMatchObject({ code: 'fulfillment_version_conflict' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM order_packing_commands').get()).toEqual({ n: 0 })
  })
  it('rolls back command and projection when audit insertion fails', async () => {
    f.sqlite.exec(
      "CREATE TRIGGER synthetic_packing_audit_failure BEFORE INSERT ON order_packing_audit BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END"
    )
    await expect(execute(pack())).rejects.toMatchObject({ code: 'service_unavailable' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM order_packing_commands').get()).toEqual({ n: 0 })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM order_packings').get()).toEqual({ n: 0 })
  })
  it('fails closed on an existing packing projection with missing immutable audit', async () => {
    await execute(pack())
    f.sqlite.exec('DROP TRIGGER order_packing_audit_no_delete; DELETE FROM order_packing_audit')
    await expect(readD1AdminPacking(f.database, CLAIMS, f.orderId)).rejects.toMatchObject({
      code: 'history_unconfirmed'
    })
  })
  it('checks every historical audit, not only counts and the most recent revision', async () => {
    const first = await execute(pack())
    await execute({ ...pack(1), parcels: [parcel(4)] })
    f.sqlite.exec('DROP TRIGGER order_packing_audit_no_update')
    f.sqlite
      .prepare('UPDATE order_packing_audit SET payload_hash=? WHERE command_id=?')
      .run('f'.repeat(64), first.commandId)
    await expect(readD1AdminPacking(f.database, CLAIMS, f.orderId)).rejects.toMatchObject({
      code: 'history_unconfirmed'
    })
  })
  it('requires live email/MFA/administration grant before reads and original replays', async () => {
    const key = data.uuid(),
      body = pack()
    await execute(body, key)
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
    await expect(readD1AdminPacking(f.database, CLAIMS, f.orderId)).rejects.toMatchObject({ code: 'mfa_required' })
    await expect(execute(body, key)).rejects.toMatchObject({ code: 'mfa_required' })
  })
  it('never packs an unpaid order or converts a pickup into a manual carrier expedition', async () => {
    const unpaid = await createPackingOrder(f.database, { paid: false })
    await expect(
      executeD1AdminPackingCommand(f.database, CLAIMS, unpaid, pack(0, 0), { idempotencyKey: data.uuid() })
    ).rejects.toMatchObject({ code: 'payment_unconfirmed' })
    const pickup = await createPackingOrder(f.database, { method: 'pickup', stage: 'packed' })
    await executeD1AdminPackingCommand(f.database, CLAIMS, pickup, pack(0, 2), { idempotencyKey: data.uuid() })
    await expect(
      executeD1AdminPackingCommand(f.database, CLAIMS, pickup, dispatch(), { idempotencyKey: data.uuid() })
    ).rejects.toMatchObject({ code: 'shipping_mode_mismatch' })
  })
  it('bounds dimensions/weights/allocations and excludes URL/label artifact fiction', () => {
    expect(orderPackingInputSchema.safeParse({ ...pack(), parcels: [{ ...parcel(4), widthMm: 3001 }] }).success).toBe(
      false
    )
    expect(orderPackingInputSchema.safeParse({ ...pack(), parcels: [{ ...parcel(4), weightGrams: 0 }] }).success).toBe(
      false
    )
    expect(
      orderPackingInputSchema.safeParse({
        ...dispatch(),
        shipments: [
          { ...dispatch().shipments[0], externalLabelReference: 'https://invented-label.example.test/file.pdf' }
        ]
      }).success
    ).toBe(false)
  })
})
