import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cancelManifest,
  closeManifest,
  confirmPickup,
  createManifest,
  getManifest,
  getManifestDocument,
  listManifests,
  schedulePickup,
  setManifestItem
} from '../../workers/fulfillment/carrier-manifests'
import { createLocalCarrierManifestAdapter } from '../../workers/fulfillment/carrier-manifest-adapter'
import { ShippingOpsError, sha256Hex } from '../../workers/fulfillment/shipping-ops-common'
import {
  ADMIN,
  NOW,
  OTHER,
  opsWorld,
  seedDispatchedOrder,
  setFulfillmentStatus,
  type OpsWorld
} from './shipping-ops-fixture'

let w: OpsWorld
const adapter = createLocalCarrierManifestAdapter()
const code = (e: unknown) => (e instanceof ShippingOpsError ? e.code : `not-ops:${String(e)}`)
const fails = (p: Promise<unknown>) => p.then(() => 'resolved', code)
const DATE = '2026-10-30'

beforeEach(async () => {
  w = await opsWorld()
  seedDispatchedOrder(w.sqlite, 'ord-1', [
    { carrier: 'Correos ', trackingNumber: 'TRK-1', weightGrams: 2000 },
    { carrier: 'correos', trackingNumber: 'TRK-2', weightGrams: 3000 }
  ])
  seedDispatchedOrder(w.sqlite, 'ord-2', [{ carrier: 'CORREOS', trackingNumber: 'TRK-3', weightGrams: 500 }])
  seedDispatchedOrder(w.sqlite, 'ord-3', [{ carrier: 'seur', trackingNumber: 'SEUR-1' }])
})
afterEach(() => w.close())

const create = (extra: Record<string, unknown> = {}) =>
  createManifest(w.db, {
    actorId: ADMIN,
    input: { commandId: 'cmd-create-1', carrier: 'correos', pickupDate: DATE, ...extra },
    now: NOW
  })
const deps = (extra = {}) => ({ actorId: ADMIN, adapter, now: NOW, ...extra })
const close = (id: string, version: number, commandId = 'cmd-close-01', d = deps()) =>
  closeManifest(w.db, { ...d, manifestId: id, input: { commandId, expectedVersion: version } })

describe('SHP-028 manifest creation and reconciliation', () => {
  it('includes only the carrier shipments (case/space insensitive) and reconciles the totals', async () => {
    const m = await create()
    expect(m).toMatchObject({
      carrier: 'correos',
      status: 'open',
      version: 1,
      includedShipments: 3,
      excludedShipments: 0,
      parcelCount: 3,
      weightGrams: 5500,
      pickupDate: DATE
    })
    expect(m.items.map((i) => i.trackingNumber)).toEqual(['TRK-1', 'TRK-2', 'TRK-3'])
    expect(m.reconciliation).toMatchObject({ candidates: 3, included: 3, excluded: 0, balanced: true })
    expect(m.items.some((i) => i.trackingNumber === 'SEUR-1')).toBe(false)
  })

  it('excludes shipments already in another active manifest, with reason', async () => {
    const first = await create()
    const empty = await createManifest(w.db, {
      actorId: ADMIN,
      input: { commandId: 'cmd-create-2', carrier: 'correos', pickupDate: '2026-10-31' },
      now: NOW
    })
    expect(empty).toMatchObject({ includedShipments: 0, excludedShipments: 3 })
    await cancelManifest(w.db, {
      ...deps(),
      manifestId: empty.id,
      input: { commandId: 'cmd-cancel-e', expectedVersion: 1 }
    })
    seedDispatchedOrder(w.sqlite, 'ord-4', [{ carrier: 'correos', trackingNumber: 'TRK-4' }])
    const next = await createManifest(w.db, {
      actorId: ADMIN,
      input: { commandId: 'cmd-create-3', carrier: 'correos', pickupDate: '2026-10-31' },
      now: NOW
    })
    expect(next.includedShipments).toBe(1)
    expect(next.excludedShipments).toBe(3)
    expect(next.reconciliation.excludedByReason).toEqual({ already_manifested: 3 })
    expect(next.reconciliation.balanced).toBe(true)
    expect(first.id).not.toBe(next.id)
  })

  it('excludes orders in exception or already delivered', async () => {
    setFulfillmentStatus(w.sqlite, 'ord-1', 'exception')
    setFulfillmentStatus(w.sqlite, 'ord-2', 'delivered')
    const m = await create()
    expect(m.includedShipments).toBe(0)
    expect(m.reconciliation.excludedByReason).toEqual({ order_exception: 2, already_delivered: 1 })
  })

  it('rejects invalid input, past dates, unknown carriers and non-admins', async () => {
    expect(await fails(create({ pickupDate: '2026-02-30' }))).toBe('invalid_input')
    expect(await fails(create({ pickupDate: '2026-10-28' }))).toBe('invalid_input')
    expect(await fails(create({ carrier: '' }))).toBe('invalid_input')
    expect(await fails(create({ commandId: 'x' }))).toBe('invalid_input')
    expect(await fails(create({ carrier: 'nobody' }))).toBe('nothing_to_manifest')
    expect(
      await fails(
        createManifest(w.db, {
          actorId: OTHER,
          input: { commandId: 'cmd-create-9', carrier: 'correos', pickupDate: DATE },
          now: NOW
        })
      )
    ).toBe('forbidden')
    expect((w.sqlite.prepare('SELECT count(*) n FROM carrier_manifests').get() as { n: number }).n).toBe(0)
  })

  it('is idempotent by command id and rejects reuse with another payload', async () => {
    const a = await create()
    expect((await create()).id).toBe(a.id)
    expect(await fails(create({ pickupDate: '2026-11-02' }))).toBe('idempotency_conflict')
    expect((w.sqlite.prepare('SELECT count(*) n FROM carrier_manifests').get() as { n: number }).n).toBe(1)
  })

  it('allows a single active manifest per carrier and date; cancelling frees the shipments', async () => {
    const a = await create()
    expect(await fails(create({ commandId: 'cmd-create-2' }))).toBe('conflict')
    const cancelled = await cancelManifest(w.db, {
      ...deps(),
      manifestId: a.id,
      input: { commandId: 'cmd-cancel-1', expectedVersion: 1 }
    })
    expect(cancelled.status).toBe('cancelled')
    const again = await create({ commandId: 'cmd-create-3' })
    expect(again.includedShipments).toBe(3)
  })
})

describe('SHP-028 item adjustments', () => {
  it('holds and releases a shipment with CAS while open', async () => {
    const m = await create()
    const held = await setManifestItem(w.db, {
      ...deps(),
      manifestId: m.id,
      input: { commandId: 'cmd-item-001', expectedVersion: 1, trackingNumber: 'TRK-2', decision: 'excluded' }
    })
    expect(held).toMatchObject({
      version: 2,
      includedShipments: 2,
      excludedShipments: 1,
      weightGrams: 2500,
      parcelCount: 2
    })
    expect(held.items.find((i) => i.trackingNumber === 'TRK-2')).toMatchObject({
      decision: 'excluded',
      exclusionReason: 'manual_hold'
    })
    expect(
      await fails(
        setManifestItem(w.db, {
          ...deps(),
          manifestId: m.id,
          input: { commandId: 'cmd-item-002', expectedVersion: 1, trackingNumber: 'TRK-2', decision: 'included' }
        })
      )
    ).toBe('version_conflict')
    const back = await setManifestItem(w.db, {
      ...deps(),
      manifestId: m.id,
      input: { commandId: 'cmd-item-003', expectedVersion: 2, trackingNumber: 'TRK-2', decision: 'included' }
    })
    expect(back).toMatchObject({ version: 3, includedShipments: 3, weightGrams: 5500 })
  })

  it('refuses unknown tracking, non-manual re-inclusion and closed manifests', async () => {
    setFulfillmentStatus(w.sqlite, 'ord-2', 'exception')
    const m = await create()
    const item = (trackingNumber: string, decision: 'included' | 'excluded', expectedVersion: number, n: string) =>
      setManifestItem(w.db, {
        ...deps(),
        manifestId: m.id,
        input: { commandId: `cmd-item-${n}`, expectedVersion, trackingNumber, decision }
      })
    expect(await fails(item('NOPE', 'excluded', 1, 'aaaa'))).toBe('not_found')
    expect(await fails(item('TRK-3', 'included', 1, 'bbbb'))).toBe('invalid_transition')
    expect(await fails(item('TRK-1', 'included', 1, 'cccc'))).toBe('invalid_transition')
    await close(m.id, 1)
    expect(await fails(item('TRK-1', 'excluded', 2, 'dddd'))).toBe('manifest_not_open')
  })

  it('replays an item command idempotently', async () => {
    const m = await create()
    const input = {
      commandId: 'cmd-item-same',
      expectedVersion: 1,
      trackingNumber: 'TRK-1',
      decision: 'excluded' as const
    }
    const a = await setManifestItem(w.db, { ...deps(), manifestId: m.id, input })
    const b = await setManifestItem(w.db, { ...deps(), manifestId: m.id, input })
    expect(b).toEqual(a)
    expect(
      await fails(setManifestItem(w.db, { ...deps(), manifestId: m.id, input: { ...input, trackingNumber: 'TRK-2' } }))
    ).toBe('idempotency_conflict')
  })
})

describe('SHP-028 closure and archived documents', () => {
  it('closes with the carrier adapter and archives an immutable, hash-verified document', async () => {
    const m = await create()
    const closed = await close(m.id, 1)
    expect(closed).toMatchObject({ status: 'closed', version: 2, closedAt: NOW })
    expect(closed.providerManifestId).toMatch(/^MAN-[0-9A-F]{14}$/)
    expect(closed.documents).toHaveLength(1)
    const doc = await getManifestDocument(w.db, ADMIN, m.id, 'manifest_csv')
    expect(doc.content.split('\n')[0]).toBe('tracking_number,shipment_number,order_id,parcel_index,weight_grams')
    expect(doc.content).toContain('TRK-1')
    expect(doc.content).not.toContain('SEUR-1')
    expect(doc.sha256).toBe(await sha256Hex(doc.content))
    expect(() => w.sqlite.exec(`UPDATE carrier_manifest_documents SET content = 'x'`)).toThrow(/immutable/)
    expect(() => w.sqlite.exec(`DELETE FROM carrier_manifest_documents`)).toThrow(/immutable/)
    w.sqlite.exec(`DROP TRIGGER carrier_manifest_documents_no_update`)
    w.sqlite.exec(`UPDATE carrier_manifest_documents SET content = content || 'tamper'`)
    expect(await fails(getManifestDocument(w.db, ADMIN, m.id, 'manifest_csv'))).toBe('internal')
  })

  it('is idempotent, rejects double close and stale versions', async () => {
    const m = await create()
    const a = await close(m.id, 1)
    expect(await close(m.id, 1)).toEqual(a)
    expect(await fails(close(m.id, 2, 'cmd-close-02'))).toBe('manifest_not_open')
    const n = await createManifest(w.db, {
      actorId: ADMIN,
      input: { commandId: 'cmd-create-5', carrier: 'seur', pickupDate: DATE },
      now: NOW
    })
    expect(await fails(close(n.id, 9, 'cmd-close-03'))).toBe('version_conflict')
  })

  it('does not change state when the carrier is unavailable and can retry', async () => {
    const m = await create()
    expect(
      await fails(
        close(m.id, 1, 'cmd-close-04', deps({ adapter: createLocalCarrierManifestAdapter({ fail: 'close' }) }))
      )
    ).toBe('carrier_unavailable')
    expect((await getManifest(w.db, ADMIN, m.id)).status).toBe('open')
    expect((w.sqlite.prepare('SELECT count(*) n FROM carrier_manifest_documents').get() as { n: number }).n).toBe(0)
    expect((await close(m.id, 1, 'cmd-close-05')).status).toBe('closed')
  })

  it('re-reconciles at closure: shipments that became ineligible are excluded and reported', async () => {
    const m = await create()
    setFulfillmentStatus(w.sqlite, 'ord-2', 'exception')
    const closed = await close(m.id, 1)
    expect(closed.includedShipments).toBe(2)
    expect(closed.items.find((i) => i.trackingNumber === 'TRK-3')).toMatchObject({
      decision: 'excluded',
      exclusionReason: 'order_exception'
    })
    expect(closed.reconciliation).toMatchObject({ candidates: 3, included: 2, excluded: 1, balanced: true })
    const doc = await getManifestDocument(w.db, ADMIN, m.id, 'manifest_csv')
    expect(doc.content).not.toContain('TRK-3')
  })

  it('cannot close a manifest without any included shipment', async () => {
    const m = await create()
    for (const [i, t] of ['TRK-1', 'TRK-2', 'TRK-3'].entries())
      await setManifestItem(w.db, {
        ...deps(),
        manifestId: m.id,
        input: { commandId: `cmd-hold-${i}00`, expectedVersion: 1 + i, trackingNumber: t, decision: 'excluded' }
      })
    expect(await fails(close(m.id, 4))).toBe('nothing_to_manifest')
  })

  it('lets exactly one of two concurrent closes win', async () => {
    const m = await create()
    const results = await Promise.allSettled([close(m.id, 1, 'cmd-race-001'), close(m.id, 1, 'cmd-race-002')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((w.sqlite.prepare('SELECT count(*) n FROM carrier_manifest_documents').get() as { n: number }).n).toBe(1)
  })

  it('refuses a non-admin and a revoked admin without writing', async () => {
    const m = await create()
    expect(await fails(close(m.id, 1, 'cmd-close-06', deps({ actorId: OTHER })))).toBe('forbidden')
    w.sqlite.exec(`DELETE FROM identity_roles WHERE identity_id = '${ADMIN}'`)
    expect(await fails(close(m.id, 1, 'cmd-close-07'))).toBe('forbidden')
    expect((w.sqlite.prepare('SELECT status FROM carrier_manifests').get() as { status: string }).status).toBe('open')
  })
})

describe('SHP-028 pickup and conciliation', () => {
  const scheduled = async () => {
    const m = await create()
    await close(m.id, 1)
    return schedulePickup(w.db, {
      ...deps(),
      manifestId: m.id,
      input: { commandId: 'cmd-pickup-1', expectedVersion: 2 }
    })
  }

  it('schedules a deterministic pickup only on a closed manifest, once', async () => {
    const m = await create()
    expect(
      await fails(
        schedulePickup(w.db, { ...deps(), manifestId: m.id, input: { commandId: 'cmd-pickup-0', expectedVersion: 1 } })
      )
    ).toBe('manifest_not_closed')
    await close(m.id, 1)
    const s = await schedulePickup(w.db, {
      ...deps(),
      manifestId: m.id,
      input: { commandId: 'cmd-pickup-1', expectedVersion: 2 }
    })
    expect(s.pickup).toMatchObject({ status: 'scheduled', parcelCount: 3, scheduledDate: DATE })
    expect(s.pickup!.providerPickupId).toMatch(/^PUP-/)
    expect(s.version).toBe(3)
    expect(
      await fails(
        schedulePickup(w.db, { ...deps(), manifestId: m.id, input: { commandId: 'cmd-pickup-2', expectedVersion: 3 } })
      )
    ).toBe('invalid_transition')
    expect(
      await fails(
        schedulePickup(w.db, {
          ...deps({ adapter: createLocalCarrierManifestAdapter({ fail: 'pickup' }) }),
          manifestId: m.id,
          input: { commandId: 'cmd-pickup-3', expectedVersion: 3 }
        })
      )
    ).toBe('invalid_transition')
  })

  it('keeps state when the carrier fails scheduling', async () => {
    const m = await create()
    await close(m.id, 1)
    expect(
      await fails(
        schedulePickup(w.db, {
          ...deps({ adapter: createLocalCarrierManifestAdapter({ fail: 'pickup' }) }),
          manifestId: m.id,
          input: { commandId: 'cmd-pickup-4', expectedVersion: 2 }
        })
      )
    ).toBe('carrier_unavailable')
    expect((await getManifest(w.db, ADMIN, m.id)).pickup).toBeNull()
  })

  it('confirms a clean pickup, archives the receipt and marks every parcel scanned', async () => {
    const m = await scheduled()
    const done = await confirmPickup(w.db, {
      ...deps(),
      manifestId: m.id,
      input: {
        commandId: 'cmd-scan-001',
        expectedVersion: 3,
        scannedTrackingNumbers: ['TRK-3', 'TRK-1', 'TRK-2', 'TRK-1']
      }
    })
    expect(done).toMatchObject({ status: 'picked_up', version: 4 })
    expect(done.pickup).toMatchObject({
      status: 'confirmed',
      scannedCount: 3,
      missingCount: 0,
      unexpectedTrackings: [],
      confirmedAt: NOW
    })
    expect(done.items.every((i) => i.scanStatus === 'scanned')).toBe(true)
    expect(done.documents.map((d) => d.kind).sort()).toEqual(['manifest_csv', 'pickup_receipt'])
    const receipt = await getManifestDocument(w.db, ADMIN, m.id, 'pickup_receipt')
    expect(receipt.content).toContain('missing=0')
  })

  it('flags missing and unexpected parcels as a discrepancy, including excluded shipments', async () => {
    const m = await create()
    await setManifestItem(w.db, {
      ...deps(),
      manifestId: m.id,
      input: { commandId: 'cmd-item-hold', expectedVersion: 1, trackingNumber: 'TRK-3', decision: 'excluded' }
    })
    await close(m.id, 2, 'cmd-close-hold')
    await schedulePickup(w.db, {
      ...deps(),
      manifestId: m.id,
      input: { commandId: 'cmd-pickup-h', expectedVersion: 3 }
    })
    const done = await confirmPickup(w.db, {
      ...deps(),
      manifestId: m.id,
      input: { commandId: 'cmd-scan-002', expectedVersion: 4, scannedTrackingNumbers: ['TRK-1', 'TRK-3', 'ALIEN-9'] }
    })
    expect(done.status).toBe('discrepancy')
    expect(done.pickup).toMatchObject({
      status: 'discrepancy',
      scannedCount: 1,
      missingCount: 1,
      unexpectedTrackings: ['ALIEN-9', 'TRK-3']
    })
    expect(done.items.find((i) => i.trackingNumber === 'TRK-2')!.scanStatus).toBe('missing')
    expect(done.items.find((i) => i.trackingNumber === 'TRK-1')!.scanStatus).toBe('scanned')
  })

  it('requires a scheduled pickup, CAS, idempotency and bounded scans', async () => {
    const m = await create()
    await close(m.id, 1)
    const base = { ...deps(), manifestId: m.id }
    expect(
      await fails(
        confirmPickup(w.db, {
          ...base,
          input: { commandId: 'cmd-scan-003', expectedVersion: 2, scannedTrackingNumbers: [] }
        })
      )
    ).toBe('invalid_transition')
    await schedulePickup(w.db, { ...base, input: { commandId: 'cmd-pickup-5', expectedVersion: 2 } })
    expect(
      await fails(
        confirmPickup(w.db, {
          ...base,
          input: { commandId: 'cmd-scan-004', expectedVersion: 2, scannedTrackingNumbers: [] }
        })
      )
    ).toBe('version_conflict')
    expect(
      await fails(
        confirmPickup(w.db, {
          ...base,
          input: {
            commandId: 'cmd-scan-005',
            expectedVersion: 3,
            scannedTrackingNumbers: Array.from({ length: 1001 }, (_, i) => `T${i}`)
          }
        })
      )
    ).toBe('invalid_input')
    const input = { commandId: 'cmd-scan-006', expectedVersion: 3, scannedTrackingNumbers: ['TRK-1', 'TRK-2', 'TRK-3'] }
    const a = await confirmPickup(w.db, { ...base, input })
    expect(await confirmPickup(w.db, { ...base, input })).toEqual(a)
    expect(
      await fails(confirmPickup(w.db, { ...base, input: { ...input, commandId: 'cmd-scan-007', expectedVersion: 4 } }))
    ).toBe('invalid_transition')
  })

  it('cannot cancel once a pickup is scheduled, but can cancel a closed manifest before', async () => {
    const m = await scheduled()
    expect(
      await fails(
        cancelManifest(w.db, { ...deps(), manifestId: m.id, input: { commandId: 'cmd-cancel-2', expectedVersion: 3 } })
      )
    ).toBe('invalid_transition')
    const other = await createManifest(w.db, {
      actorId: ADMIN,
      input: { commandId: 'cmd-create-8', carrier: 'seur', pickupDate: DATE },
      now: NOW
    })
    await close(other.id, 1, 'cmd-close-08')
    expect(
      (
        await cancelManifest(w.db, {
          ...deps(),
          manifestId: other.id,
          input: { commandId: 'cmd-cancel-3', expectedVersion: 2 }
        })
      ).status
    ).toBe('cancelled')
  })
})

describe('SHP-028 reading', () => {
  it('lists with filters, bounds the limit and 404s on unknown manifests or documents', async () => {
    const a = await create()
    await createManifest(w.db, {
      actorId: ADMIN,
      input: { commandId: 'cmd-create-7', carrier: 'seur', pickupDate: DATE },
      now: NOW
    })
    await close(a.id, 1)
    expect((await listManifests(w.db, ADMIN, {})).map((m) => m.carrier).sort()).toEqual(['correos', 'seur'])
    expect((await listManifests(w.db, ADMIN, { status: 'closed' })).map((m) => m.id)).toEqual([a.id])
    expect(await listManifests(w.db, ADMIN, { limit: 1 })).toHaveLength(1)
    expect(await fails(listManifests(w.db, ADMIN, { status: 'bogus' as never }))).toBe('invalid_input')
    expect(await fails(listManifests(w.db, OTHER, {}))).toBe('forbidden')
    expect(await fails(getManifest(w.db, ADMIN, 'missing'))).toBe('not_found')
    expect(await fails(getManifestDocument(w.db, ADMIN, a.id, 'pickup_receipt'))).toBe('not_found')
  })

  it('keeps manifest commands append-only', async () => {
    await create()
    expect(() => w.sqlite.exec(`UPDATE carrier_manifest_commands SET action = 'close'`)).toThrow(/immutable/)
    expect(() => w.sqlite.exec(`DELETE FROM carrier_manifest_commands`)).toThrow(/immutable/)
  })
})
