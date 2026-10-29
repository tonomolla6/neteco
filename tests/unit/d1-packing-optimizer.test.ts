import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createPackingSuggestion,
  decidePackingSuggestion,
  deleteIncompatibility,
  getPackingSuggestion,
  listPackingConfig,
  setIncompatibility,
  upsertBoxType,
  upsertProductProfile
} from '../../workers/fulfillment/packing-optimizer'
import { ShippingOpsError } from '../../workers/fulfillment/shipping-ops-common'
import { ADMIN, NOW, OTHER, opsWorld, type OpsWorld } from './shipping-ops-fixture'

let w: OpsWorld
const code = (error: unknown) => (error instanceof ShippingOpsError ? error.code : `not-ops:${String(error)}`)
const fails = async (promise: Promise<unknown>) => promise.then(() => 'resolved', code)

const profile = (extra = {}) => ({
  weightGrams: 1100,
  widthMm: 80,
  heightMm: 200,
  depthMm: 80,
  hazardClass: 'none' as const,
  expectedVersion: 0,
  ...extra
})

beforeEach(async () => {
  w = await opsWorld()
  await upsertProductProfile(w.db, { actorId: ADMIN, sku: 'SOAP', input: profile(), now: NOW })
  await upsertProductProfile(w.db, {
    actorId: ADMIN,
    sku: 'BLEACH',
    input: profile({ weightGrams: 5200, widthMm: 150, heightMm: 280, depthMm: 150, hazardClass: 'oxidizer' }),
    now: NOW
  })
  await upsertProductProfile(w.db, {
    actorId: ADMIN,
    sku: 'ACID',
    input: profile({ weightGrams: 1200, hazardClass: 'corrosive' }),
    now: NOW
  })
})
afterEach(() => w.close())

const suggest = (extra: Record<string, unknown> = {}) =>
  createPackingSuggestion(w.db, {
    actorId: ADMIN,
    input: { commandId: 'cmd-suggest-1', lines: [{ sku: 'SOAP', quantity: 4, lineIndex: 0 }], ...extra } as never,
    now: NOW
  })

describe('SHP-030 packing optimiser persistence', () => {
  it('exposes the seeded default boxes and incompatibilities to admins only', async () => {
    const config = await listPackingConfig(w.db, ADMIN)
    expect(config.boxes.map((b) => b.code)).toEqual(['L', 'M', 'S'])
    expect(config.incompatibilities.length).toBeGreaterThanOrEqual(4)
    expect(config.profiles.map((p) => p.sku)).toEqual(['ACID', 'BLEACH', 'SOAP'])
    expect(await fails(listPackingConfig(w.db, OTHER))).toBe('forbidden')
    expect(await fails(listPackingConfig(w.db, 'ghost'))).toBe('forbidden')
  })

  it('creates and updates a box with CAS and rejects stale or invalid versions', async () => {
    const input = {
      name: 'Extra',
      widthMm: 700,
      heightMm: 500,
      depthMm: 500,
      tareGrams: 900,
      maxWeightGrams: 30000,
      hazmatAllowed: false,
      active: true,
      expectedVersion: 0
    }
    const created = await upsertBoxType(w.db, { actorId: ADMIN, code: 'XL', input, now: NOW })
    expect(created.version).toBe(1)
    expect(await fails(upsertBoxType(w.db, { actorId: ADMIN, code: 'XL', input, now: NOW }))).toBe('version_conflict')
    const updated = await upsertBoxType(w.db, {
      actorId: ADMIN,
      code: 'XL',
      input: { ...input, active: false, expectedVersion: 1 },
      now: NOW
    })
    expect(updated).toMatchObject({ version: 2, active: false })
    expect(
      await fails(
        upsertBoxType(w.db, { actorId: ADMIN, code: 'XL', input: { ...input, expectedVersion: 1 }, now: NOW })
      )
    ).toBe('version_conflict')
    expect(
      await fails(
        upsertBoxType(w.db, { actorId: ADMIN, code: 'ZZ', input: { ...input, expectedVersion: 4 }, now: NOW })
      )
    ).toBe('version_conflict')
    expect(await fails(upsertBoxType(w.db, { actorId: ADMIN, code: 'bad code', input, now: NOW }))).toBe(
      'invalid_input'
    )
    expect(
      await fails(upsertBoxType(w.db, { actorId: ADMIN, code: 'T', input: { ...input, tareGrams: 40000 }, now: NOW }))
    ).toBe('invalid_input')
    expect(await fails(upsertBoxType(w.db, { actorId: OTHER, code: 'N', input, now: NOW }))).toBe('forbidden')
  })

  it('updates a profile with CAS', async () => {
    const next = await upsertProductProfile(w.db, {
      actorId: ADMIN,
      sku: 'SOAP',
      input: profile({ weightGrams: 1200, expectedVersion: 1 }),
      now: NOW
    })
    expect(next).toMatchObject({ version: 2, weightGrams: 1200 })
    expect(
      await fails(
        upsertProductProfile(w.db, { actorId: ADMIN, sku: 'SOAP', input: profile({ expectedVersion: 1 }), now: NOW })
      )
    ).toBe('version_conflict')
    expect(await fails(upsertProductProfile(w.db, { actorId: ADMIN, sku: '', input: profile(), now: NOW }))).toBe(
      'invalid_input'
    )
    expect(
      await fails(
        upsertProductProfile(w.db, { actorId: ADMIN, sku: 'X', input: profile({ weightGrams: 0 }), now: NOW })
      )
    ).toBe('invalid_input')
  })

  it('persists a verified suggestion and replays idempotently', async () => {
    const a = await suggest()
    expect(a).toMatchObject({ status: 'suggested', version: 1, orderId: null })
    expect(a.plan.parcels.length).toBeGreaterThanOrEqual(1)
    expect(a.orderPackingParcels?.[0]?.contents[0]).toMatchObject({ lineIndex: 0 })
    const again = await suggest()
    expect(again.id).toBe(a.id)
    expect((w.sqlite.prepare('SELECT count(*) n FROM packing_suggestions').get() as { n: number }).n).toBe(1)
    expect(await fails(suggest({ lines: [{ sku: 'SOAP', quantity: 5, lineIndex: 0 }] }))).toBe('idempotency_conflict')
  })

  it('does not persist anything when a profile is missing or the product is unpackable', async () => {
    expect(await fails(suggest({ commandId: 'cmd-x-1234', lines: [{ sku: 'MISSING', quantity: 1 }] }))).toBe(
      'unknown_profile'
    )
    await upsertProductProfile(w.db, {
      actorId: ADMIN,
      sku: 'GIANT',
      input: profile({ widthMm: 2000, heightMm: 2000, depthMm: 2000 }),
      now: NOW
    })
    expect(await fails(suggest({ commandId: 'cmd-x-5678', lines: [{ sku: 'GIANT', quantity: 1 }] }))).toBe('unpackable')
    expect(await fails(suggest({ commandId: 'cmd-x-9999', lines: [{ sku: 'SOAP', quantity: 0 }] }))).toBe(
      'invalid_input'
    )
    expect((w.sqlite.prepare('SELECT count(*) n FROM packing_suggestions').get() as { n: number }).n).toBe(0)
  })

  it('separates bleach from acid using the configured rules, and honours rule changes', async () => {
    const lines = [
      { sku: 'BLEACH', quantity: 1 },
      { sku: 'ACID', quantity: 1 }
    ]
    const split = await suggest({ commandId: 'cmd-rule-001', lines })
    expect(split.plan.parcels).toHaveLength(2)
    await deleteIncompatibility(w.db, { actorId: ADMIN, classA: 'oxidizer', classB: 'corrosive' })
    const merged = await suggest({ commandId: 'cmd-rule-002', lines })
    expect(merged.plan.parcels).toHaveLength(1)
    await setIncompatibility(w.db, { actorId: ADMIN, classA: 'oxidizer', classB: 'corrosive', reason: 'No mezclar' })
    expect((await suggest({ commandId: 'cmd-rule-003', lines })).plan.parcels).toHaveLength(2)
    expect(
      await fails(setIncompatibility(w.db, { actorId: OTHER, classA: 'toxic', classB: 'none', reason: 'xxxx' }))
    ).toBe('forbidden')
    expect(await fails(deleteIncompatibility(w.db, { actorId: OTHER, classA: 'toxic', classB: 'none' }))).toBe(
      'forbidden'
    )
  })

  it('reads lines from the order snapshot when only orderId is given', async () => {
    w.sqlite
      .exec(`INSERT INTO order_lines(order_id,line_index,variant_id,sku,name,quantity,unit_gross_cents,net_cents,tax_cents,gross_cents,tax_rate_basis_points,price_version_id,location_id,created_at)
      VALUES('ord-1',0,'v','SOAP','Jabon',3,100,300,0,300,0,'p','l','${NOW}'),('ord-1',1,'v','ACID','Acido',1,100,100,0,100,0,'p','l','${NOW}')`)
    const s = await createPackingSuggestion(w.db, {
      actorId: ADMIN,
      input: { commandId: 'cmd-order-1', orderId: 'ord-1' },
      now: NOW
    })
    expect(s.orderId).toBe('ord-1')
    expect(s.lines).toEqual(
      [
        { sku: 'ACID', quantity: 1, lineIndex: 1 },
        { sku: 'SOAP', quantity: 3, lineIndex: 0 }
      ].sort((a, b) => a.lineIndex - b.lineIndex)
    )
    expect(
      await fails(
        createPackingSuggestion(w.db, {
          actorId: ADMIN,
          input: { commandId: 'cmd-order-2', orderId: 'nope' },
          now: NOW
        })
      )
    ).toBe('not_found')
  })

  it('rejects suggestion creation by non admins without writing', async () => {
    expect(
      await fails(
        createPackingSuggestion(w.db, {
          actorId: OTHER,
          input: { commandId: 'cmd-forbid-1', lines: [{ sku: 'SOAP', quantity: 1 }] },
          now: NOW
        })
      )
    ).toBe('forbidden')
    expect((w.sqlite.prepare('SELECT count(*) n FROM packing_suggestions').get() as { n: number }).n).toBe(0)
  })

  it('warehouse validation accepts weights within tolerance and returns order parcels', async () => {
    const s = await suggest()
    const actual = s.plan.parcels.map((p, parcelIndex) => ({ parcelIndex, weightGrams: p.grossWeightGrams + 50 }))
    const done = await decidePackingSuggestion(w.db, {
      actorId: ADMIN,
      suggestionId: s.id,
      input: { commandId: 'cmd-valid-01', expectedVersion: 1, decision: 'accept', actualParcels: actual },
      now: NOW
    })
    expect(done).toMatchObject({ status: 'validated', version: 2, validatedAt: NOW })
    expect(done.validation).toMatchObject({ decision: 'accept' })
    expect((await getPackingSuggestion(w.db, ADMIN, s.id)).status).toBe('validated')
    const replay = await decidePackingSuggestion(w.db, {
      actorId: ADMIN,
      suggestionId: s.id,
      input: { commandId: 'cmd-valid-01', expectedVersion: 1, decision: 'accept', actualParcels: actual },
      now: NOW
    })
    expect(replay).toEqual(done)
    expect(
      await fails(
        decidePackingSuggestion(w.db, {
          actorId: ADMIN,
          suggestionId: s.id,
          input: {
            commandId: 'cmd-valid-01',
            expectedVersion: 1,
            decision: 'accept',
            actualParcels: actual.map((a) => ({ ...a, weightGrams: a.weightGrams + 1 }))
          },
          now: NOW
        })
      )
    ).toBe('idempotency_conflict')
  })

  it('refuses actual weights outside tolerance or above the box maximum', async () => {
    const s = await suggest()
    const planned = s.plan.parcels[0]!.grossWeightGrams
    const decide = (weightGrams: number, commandId: string) =>
      decidePackingSuggestion(w.db, {
        actorId: ADMIN,
        suggestionId: s.id,
        input: {
          commandId,
          expectedVersion: 1,
          decision: 'accept',
          actualParcels: [
            { parcelIndex: 0, weightGrams },
            ...s.plan.parcels.slice(1).map((p, i) => ({ parcelIndex: i + 1, weightGrams: p.grossWeightGrams }))
          ]
        },
        now: NOW
      })
    expect(await fails(decide(Math.ceil(planned * 1.2), 'cmd-tol-0001'))).toBe('validation_out_of_tolerance')
    expect(await fails(decide(Math.floor(planned * 0.5), 'cmd-tol-0002'))).toBe('validation_out_of_tolerance')
    expect((await getPackingSuggestion(w.db, ADMIN, s.id)).status).toBe('suggested')
    expect((w.sqlite.prepare('SELECT count(*) n FROM packing_suggestion_commands').get() as { n: number }).n).toBe(0)
  })

  it('requires one actual weight per parcel, and a note to reject', async () => {
    const s = await suggest()
    const base = { suggestionId: s.id, actorId: ADMIN, now: NOW }
    expect(
      await fails(
        decidePackingSuggestion(w.db, {
          ...base,
          input: { commandId: 'cmd-inv-0001', expectedVersion: 1, decision: 'accept' }
        })
      )
    ).toBe('invalid_input')
    expect(
      await fails(
        decidePackingSuggestion(w.db, {
          ...base,
          input: {
            commandId: 'cmd-inv-0002',
            expectedVersion: 1,
            decision: 'accept',
            actualParcels: [{ parcelIndex: 5, weightGrams: 1000 }]
          }
        })
      )
    ).toBe('invalid_input')
    expect(
      await fails(
        decidePackingSuggestion(w.db, {
          ...base,
          input: { commandId: 'cmd-inv-0003', expectedVersion: 1, decision: 'reject' }
        })
      )
    ).toBe('invalid_input')
    const rejected = await decidePackingSuggestion(w.db, {
      ...base,
      input: {
        commandId: 'cmd-inv-0004',
        expectedVersion: 1,
        decision: 'reject',
        note: 'No cabe en el hueco de almacen'
      }
    })
    expect(rejected.status).toBe('rejected')
  })

  it('applies CAS and state machine to decisions', async () => {
    const s = await suggest()
    const actual = s.plan.parcels.map((p, parcelIndex) => ({ parcelIndex, weightGrams: p.grossWeightGrams }))
    expect(
      await fails(
        decidePackingSuggestion(w.db, {
          actorId: ADMIN,
          suggestionId: s.id,
          input: { commandId: 'cmd-cas-0001', expectedVersion: 7, decision: 'accept', actualParcels: actual },
          now: NOW
        })
      )
    ).toBe('version_conflict')
    await decidePackingSuggestion(w.db, {
      actorId: ADMIN,
      suggestionId: s.id,
      input: { commandId: 'cmd-cas-0002', expectedVersion: 1, decision: 'accept', actualParcels: actual },
      now: NOW
    })
    expect(
      await fails(
        decidePackingSuggestion(w.db, {
          actorId: ADMIN,
          suggestionId: s.id,
          input: {
            commandId: 'cmd-cas-0003',
            expectedVersion: 2,
            decision: 'reject',
            note: 'Cambio de opinion tardio'
          },
          now: NOW
        })
      )
    ).toBe('invalid_transition')
    expect(
      await fails(
        decidePackingSuggestion(w.db, {
          actorId: ADMIN,
          suggestionId: 'nope',
          input: {
            commandId: 'cmd-cas-0004',
            expectedVersion: 1,
            decision: 'reject',
            note: 'Cambio de opinion tardio'
          },
          now: NOW
        })
      )
    ).toBe('not_found')
  })

  it('marks the plan stale when its box was deactivated or a rule changed before validation', async () => {
    const s = await suggest()
    const box = s.plan.parcels[0]!.boxCode
    const current = (await listPackingConfig(w.db, ADMIN)).boxes.find((b) => b.code === box)!
    await upsertBoxType(w.db, {
      actorId: ADMIN,
      code: box,
      input: {
        name: current.name,
        widthMm: current.widthMm,
        heightMm: current.heightMm,
        depthMm: current.depthMm,
        tareGrams: current.tareGrams,
        maxWeightGrams: current.maxWeightGrams,
        hazmatAllowed: current.hazmatAllowed,
        active: false,
        expectedVersion: current.version
      },
      now: NOW
    })
    const actual = s.plan.parcels.map((p, parcelIndex) => ({ parcelIndex, weightGrams: p.grossWeightGrams }))
    expect(
      await fails(
        decidePackingSuggestion(w.db, {
          actorId: ADMIN,
          suggestionId: s.id,
          input: { commandId: 'cmd-stale-01', expectedVersion: 1, decision: 'accept', actualParcels: actual },
          now: NOW
        })
      )
    ).toBe('plan_stale')
  })

  it('detects a stored plan tampered with directly in the database', async () => {
    const s = await suggest()
    const tampered = JSON.parse(
      (w.sqlite.prepare('SELECT plan_json p FROM packing_suggestions').get() as { p: string }).p
    )
    tampered.parcels[0].contents[0].quantity += 1
    w.sqlite.prepare('UPDATE packing_suggestions SET plan_json = ?').run(JSON.stringify(tampered))
    const actual = s.plan.parcels.map((p, parcelIndex) => ({ parcelIndex, weightGrams: p.grossWeightGrams }))
    expect(
      await fails(
        decidePackingSuggestion(w.db, {
          actorId: ADMIN,
          suggestionId: s.id,
          input: { commandId: 'cmd-tamper-1', expectedVersion: 1, decision: 'accept', actualParcels: actual },
          now: NOW
        })
      )
    ).toBe('plan_stale')
  })

  it('authorises live inside the write: a revoked admin cannot validate', async () => {
    const s = await suggest()
    w.sqlite.exec(`DELETE FROM identity_roles WHERE identity_id = '${ADMIN}'`)
    expect(
      await fails(
        decidePackingSuggestion(w.db, {
          actorId: ADMIN,
          suggestionId: s.id,
          input: { commandId: 'cmd-revoke-1', expectedVersion: 1, decision: 'reject', note: 'Ya no tengo permiso' },
          now: NOW
        })
      )
    ).toBe('forbidden')
    expect((w.sqlite.prepare('SELECT status FROM packing_suggestions').get() as { status: string }).status).toBe(
      'suggested'
    )
  })

  it('keeps decision commands append-only', async () => {
    const s = await suggest()
    await decidePackingSuggestion(w.db, {
      actorId: ADMIN,
      suggestionId: s.id,
      input: { commandId: 'cmd-append-1', expectedVersion: 1, decision: 'reject', note: 'Rechazada por almacen' },
      now: NOW
    })
    expect(() => w.sqlite.exec(`UPDATE packing_suggestion_commands SET action = 'validate'`)).toThrow(/immutable/)
    expect(() => w.sqlite.exec(`DELETE FROM packing_suggestion_commands`)).toThrow(/immutable/)
  })
})
