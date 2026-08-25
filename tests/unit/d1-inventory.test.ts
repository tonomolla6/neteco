import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { renderD1CategorySeed } from '../../scripts/lib/d1-category-seed'
import { renderD1InventorySeed } from '../../scripts/lib/d1-inventory-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import {
  assignReservation,
  expireExpiredReservations,
  InventoryError,
  listAvailability,
  reconcileInventory,
  releaseReservation,
  reservationPayloadHash,
  renewReservation,
  reserveInventory
} from '../../workers/catalog/inventory'
import {
  applyGeneratedSeed,
  d1OverSqlite,
  openMigratedDatabase,
  seedInventoryFixture,
  type InventoryWorld
} from '../support/d1-sqlite'

const NOW = '2026-08-25T09:00:00Z'
const TTL = '2026-08-26T09:00:00Z'

async function world() {
  const sqlite = await openMigratedDatabase()
  const fixture = seedInventoryFixture(sqlite)
  return { database: d1OverSqlite(sqlite), fixture, sqlite }
}

const lines = (world_: InventoryWorld, pairs: Array<[number, number]>, quantity = 1) =>
  pairs.map(([product, variant]) => ({
    locationId: world_.locationId,
    quantity,
    variantId: world_.variantId(product, variant)
  }))

async function movementCount(sqlite: DatabaseSync) {
  return Number((sqlite.prepare('SELECT count(*) AS total FROM inventory_movements').get() as { total: number }).total)
}

describe('D1 inventory schema', () => {
  it('rejects non-canonical and impossible timestamps plus short payload hashes', async () => {
    const { sqlite } = await world()
    const insertReservation = sqlite.prepare(
      `INSERT INTO inventory_reservations (
         id, idempotency_key, payload_hash, status, correlation_id, reason,
         expires_at, renewed_at, assigned_at, released_at, expired_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'reserved', 'corr', NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`
    )
    expect(() =>
      insertReservation.run('res-bad-shape', 'k-bad-shape', 'a'.repeat(64), TTL, '2026-08-25 09:00:00', NOW)
    ).toThrow()
    expect(() =>
      insertReservation.run('res-impossible', 'k-impossible', 'a'.repeat(64), TTL, '2026-99-99T09:00:00Z', NOW)
    ).toThrow()
    expect(() => insertReservation.run('res-short-hash', 'k-short-hash', 'aaaa1111', TTL, NOW, NOW)).toThrow()
  })

  it('rejects impossible quantities and inconsistent terminal metadata', async () => {
    const { sqlite } = await world()
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO inventory_reservations (
             id, idempotency_key, payload_hash, status, correlation_id,
             expires_at, assigned_at, released_at, created_at, updated_at
           ) VALUES ('res-terminal','k-terminal','${'a'.repeat(64)}','assigned','corr',
                     '${TTL}','${NOW}','${NOW}','${NOW}','${NOW}')`
        )
        .run()
    ).toThrow()
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO inventory_balances (
             variant_id, location_id, physical_quantity, blocked_quantity, version, created_at, updated_at
           ) VALUES ('v-1-1','loc-main', -1, 0, 1, '${NOW}', '${NOW}')`
        )
        .run()
    ).toThrow()
  })

  it('rechaza bloqueado mayor que físico y movimientos duplicados', async () => {
    const { sqlite } = await world()
    expect(() =>
      sqlite.prepare("UPDATE inventory_balances SET blocked_quantity = 99 WHERE variant_id = 'v-1-1'").run()
    ).toThrow()
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO inventory_movements (
             id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
             reference_type, idempotency_key, correlation_id, created_at
           )
           SELECT id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
                  reference_type, idempotency_key, correlation_id, created_at
           FROM inventory_movements LIMIT 1`
        )
        .run()
    ).toThrow()
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO inventory_movements (
             id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
             reference_type, idempotency_key, correlation_id, created_at
           ) VALUES ('mv-x','v-1-1','loc-main','allocate', 0, -1, 'reservation','mv-1-1','corr','${NOW}')`
        )
        .run()
    ).toThrow()
  })

  it('requires every reservation line and movement to target an existing balance', async () => {
    const { sqlite } = await world()
    sqlite.exec(
      `INSERT INTO inventory_locations (id, code, name, kind, active, created_at)
       VALUES ('loc-empty', 'EMPTY', 'Sin saldo', 'warehouse', 1, '${NOW}');
       INSERT INTO inventory_reservations (
         id, idempotency_key, payload_hash, status, correlation_id, expires_at, created_at, updated_at
       ) VALUES ('res-no-balance', 'k-no-balance', '${'b'.repeat(64)}', 'reserved', 'corr', '${TTL}', '${NOW}', '${NOW}')`
    )
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO inventory_reservation_lines (reservation_id, variant_id, location_id, quantity)
           VALUES ('res-no-balance', 'v-1-1', 'loc-empty', 1)`
        )
        .run()
    ).toThrow()
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO inventory_movements (
             id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
             reference_type, idempotency_key, correlation_id, reason, created_at
           ) VALUES ('mv-no-balance', 'v-1-1', 'loc-empty', 'receipt', 1, 0,
                     'test', 'mv-no-balance', 'corr', 'Sin balance', '${NOW}')`
        )
        .run()
    ).toThrow()
  })
})

describe('D1 atomic reservations', () => {
  it('reserve → replay → conflict keeps one single effect set', async () => {
    const { database, fixture } = await world()
    const key = 'k-simple'
    const first = await reserveInventory(database, {
      correlationId: 't',
      expiresAt: TTL,
      idempotencyKey: key,
      lines: lines(fixture, [[1, 1]], 5),
      now: NOW
    })
    expect(first.outcome).toBe('reserved')
    const availability = await listAvailability(database, { variantId: fixture.variantId(1, 1) })
    expect(availability[0]?.reservedQuantity).toBe(5)
    expect(availability[0]?.sellableQuantity).toBe(availability[0]!.physicalQuantity - availability[0]!.safetyStock - 5)

    const before = await listAvailability(database, {})
    const replay = await reserveInventory(database, {
      correlationId: 't',
      expiresAt: TTL,
      idempotencyKey: key,
      lines: lines(fixture, [[1, 1]], 5),
      now: NOW
    })
    expect(replay.outcome).toBe('replayed')
    const conflict = await reserveInventory(database, {
      correlationId: 't',
      expiresAt: TTL,
      idempotencyKey: key,
      lines: lines(fixture, [[1, 1]], 6),
      now: NOW
    })
    expect(conflict.outcome).toBe('conflict')
    const after = await listAvailability(database, {})
    expect(after).toEqual(before)
  })

  it('multi-line reservation succeeds fully or not at all', async () => {
    const { database, fixture } = await world()
    const ok = await reserveInventory(database, {
      correlationId: 't',
      expiresAt: TTL,
      idempotencyKey: 'k-multi',
      lines: lines(fixture, [
        [2, 1],
        [3, 1]
      ]),
      now: NOW
    })
    expect(ok.outcome).toBe('reserved')

    await expect(
      reserveInventory(database, {
        correlationId: 't',
        expiresAt: TTL,
        idempotencyKey: 'k-partial',
        lines: [...lines(fixture, [[6, 1]], 1), ...lines(fixture, [[4, 1]], 10_000)],
        now: NOW
      })
    ).rejects.toBeInstanceOf(InventoryError)

    // Line 1 of the failed batch must NOT be reserved.
    const availability = await listAvailability(database, { variantId: fixture.variantId(6, 1) })
    expect(availability[0]?.reservedQuantity).toBe(0)
    expect((await reconcileInventory(database)).ok).toBe(true)
  })

  it('assignment decrements once and replays are side-effect free', async () => {
    const { database, fixture, sqlite } = await world()
    const key = 'k-assign'
    await reserveInventory(database, {
      correlationId: 't',
      expiresAt: TTL,
      idempotencyKey: key,
      lines: lines(fixture, [[1, 1]], 4),
      now: NOW
    })

    const assigned = await assignReservation(database, { correlationId: 't', idempotencyKey: key, now: NOW })
    expect(assigned.outcome).toBe('assigned')
    const balanceAfterAssign = Number(
      (
        sqlite.prepare("SELECT physical_quantity AS q FROM inventory_balances WHERE variant_id='v-1-1'").get() as {
          q: number
        }
      ).q
    )

    const replayed = await assignReservation(database, { correlationId: 't', idempotencyKey: key, now: NOW })
    expect(replayed.outcome).toBe('replayed')
    const balanceAfterReplay = Number(
      (
        sqlite.prepare("SELECT physical_quantity AS q FROM inventory_balances WHERE variant_id='v-1-1'").get() as {
          q: number
        }
      ).q
    )
    expect(balanceAfterReplay).toBe(balanceAfterAssign)

    // Late release of an assigned reservation is rejected without effects.
    const lateRelease = await releaseReservation(database, { correlationId: 't', idempotencyKey: key, now: NOW })
    expect(lateRelease.outcome).toBe('not_active')
    expect(balanceAfterReplay).toBe(balanceAfterAssign)
  })

  it('rolls assignment back when its deterministic movement key was poisoned', async () => {
    const { database, fixture, sqlite } = await world()
    const key = 'k-poisoned-assign'
    const variantId = fixture.variantId(1, 1)
    await reserveInventory(database, {
      correlationId: 't',
      expiresAt: TTL,
      idempotencyKey: key,
      lines: [{ locationId: fixture.locationId, quantity: 2, variantId }],
      now: NOW
    })
    const physicalBefore = sqlite
      .prepare('SELECT physical_quantity AS quantity FROM inventory_balances WHERE variant_id = ?')
      .get(variantId)
    sqlite
      .prepare(
        `INSERT INTO inventory_movements (
           id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
           reference_type, reference_id, idempotency_key, correlation_id, reason, created_at
         ) VALUES (?, ?, ?, 'allocate', -1, -1, 'reservation', ?, ?, 'poison', 'Clave ocupada', ?)`
      )
      .run(
        'poisoned-allocate',
        variantId,
        fixture.locationId,
        key,
        `${key}:allocate:${variantId}:${fixture.locationId}`,
        NOW
      )

    await expect(assignReservation(database, { correlationId: 't', idempotencyKey: key, now: NOW })).rejects.toThrow()
    expect(sqlite.prepare('SELECT status FROM inventory_reservations WHERE id = ?').get(key)).toEqual({
      status: 'reserved'
    })
    expect(
      sqlite.prepare('SELECT physical_quantity AS quantity FROM inventory_balances WHERE variant_id = ?').get(variantId)
    ).toEqual(physicalBefore)
  })

  it('release frees commitments exactly once', async () => {
    const { database, fixture } = await world()
    const key = 'k-release'
    await reserveInventory(database, {
      correlationId: 't',
      expiresAt: TTL,
      idempotencyKey: key,
      lines: lines(fixture, [[3, 1]], 7),
      now: NOW
    })
    expect((await releaseReservation(database, { correlationId: 't', idempotencyKey: key, now: NOW })).outcome).toBe(
      'applied'
    )
    expect((await releaseReservation(database, { correlationId: 't', idempotencyKey: key, now: NOW })).outcome).toBe(
      'replayed'
    )
    const availability = await listAvailability(database, { variantId: fixture.variantId(3, 1) })
    expect(availability[0]?.reservedQuantity).toBe(0)
  })

  it('expired reservations cannot be assigned', async () => {
    const { database, fixture } = await world()
    const key = 'k-ttl'
    await reserveInventory(database, {
      correlationId: 't',
      expiresAt: '2026-08-25T10:00:00Z',
      idempotencyKey: key,
      lines: lines(fixture, [[1, 1]], 2),
      now: NOW
    })
    const lateAssign = await assignReservation(database, {
      correlationId: 't',
      idempotencyKey: key,
      now: '2026-08-25T11:00:00Z'
    })
    expect(lateAssign.outcome).toBe('expired')
    // Expiry job formalises it; afterwards the state is terminal.
    await expireExpiredReservations(database, { at: '2026-08-25T11:00:00Z', correlationId: 'due' })
    const afterExpiry = await assignReservation(database, {
      correlationId: 't',
      idempotencyKey: key,
      now: '2026-08-25T11:00:00Z'
    })
    expect(afterExpiry.outcome).toBe('expired')
    expect(afterExpiry.status === 'expired').toBe(true)
  })

  it('renewal extends validity and stale expiry callers are ignored', async () => {
    const { database, fixture } = await world()
    const key = 'k-renew'
    await reserveInventory(database, {
      correlationId: 't',
      expiresAt: '2026-08-25T10:00:00Z',
      idempotencyKey: key,
      lines: lines(fixture, [[2, 1]], 2),
      now: NOW
    })
    const renewed = await renewReservation(database, {
      correlationId: 't',
      expiresAt: '2026-08-25T12:00:00Z',
      idempotencyKey: key,
      now: NOW
    })
    expect(renewed.outcome).toBe('applied')

    const stale = await expireExpiredReservations(database, { at: '2026-08-25T11:00:00Z', correlationId: 'stale' })
    expect(stale.expiredCount).toBe(0)
    const stillLive = await listAvailability(database, { variantId: fixture.variantId(2, 1) })
    expect(stillLive[0]?.reservedQuantity).toBe(2)

    const due = await expireExpiredReservations(database, { at: '2026-08-25T12:00:00Z', correlationId: 'due' })
    expect(due.expiredCount).toBe(1)
    const repeat = await expireExpiredReservations(database, { at: '2026-08-25T12:00:00Z', correlationId: 'due' })
    expect(repeat.expiredCount).toBe(0)
    const afterExpiry = await listAvailability(database, { variantId: fixture.variantId(2, 1) })
    expect(afterExpiry[0]?.reservedQuantity).toBe(0)
    expect((await reconcileInventory(database)).ok).toBe(true)
  })

  it('never renews a reservation after its current expiry', async () => {
    const { database, fixture } = await world()
    await reserveInventory(database, {
      correlationId: 't',
      expiresAt: '2026-08-25T10:00:00Z',
      idempotencyKey: 'k-no-resurrection',
      lines: lines(fixture, [[2, 1]], 1),
      now: NOW
    })
    const result = await renewReservation(database, {
      correlationId: 't',
      expiresAt: '2026-08-25T13:00:00Z',
      idempotencyKey: 'k-no-resurrection',
      now: '2026-08-25T11:00:00Z'
    })
    expect(result.outcome).toBe('not_active')
  })

  it('uses collision-resistant reservation fingerprints and rejects duplicate lines', async () => {
    const { database, fixture } = await world()
    const commonLines = lines(fixture, [[1, 1]], 1)
    const left = await reservationPayloadHash({ expiresAt: TTL, reason: '0.6gotcplt0dr2fnv' }, commonLines)
    const right = await reservationPayloadHash({ expiresAt: TTL, reason: '0.tra92xcqn82xsh' }, commonLines)
    expect(left).toHaveLength(64)
    expect(right).toHaveLength(64)
    expect(left).not.toBe(right)

    await expect(
      reserveInventory(database, {
        correlationId: 't',
        expiresAt: TTL,
        idempotencyKey: 'k-duplicate-lines',
        lines: [...commonLines, ...commonLines],
        now: NOW
      })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('does not disguise a D1 outage as insufficient stock', async () => {
    const { database: base, fixture } = await world()
    const database = new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'batch') return async () => Promise.reject(new Error('simulated D1 outage'))
        return Reflect.get(target, property, receiver)
      }
    })
    await expect(
      reserveInventory(database, {
        correlationId: 't',
        expiresAt: TTL,
        idempotencyKey: 'k-outage',
        lines: lines(fixture, [[1, 1]], 1),
        now: NOW
      })
    ).rejects.toThrow('simulated D1 outage')
  })

  it('backorder variants accept over-stock reservations', async () => {
    const { database, fixture } = await world()
    const result = await reserveInventory(database, {
      correlationId: 't',
      expiresAt: TTL,
      idempotencyKey: 'k-backorder',
      lines: lines(fixture, [[5, 1]], 100_000),
      now: NOW
    })
    expect(result.outcome).toBe('reserved')
    const availability = await listAvailability(database, { variantId: fixture.variantId(5, 1) })
    expect(availability[0]?.backorderAllowed).toBe(true)
    expect(availability[0]?.sellableQuantity).toBe(0)
  })

  it('20 contenders issued together never oversell in the synchronous SQLite adapter', async () => {
    const { database, fixture } = await world()
    const target = fixture.variantId(4, 1) // physical 3, safety 1 -> sellable 2? keep deterministic below
    const stock = (await listAvailability(database, { variantId: target }))[0]!.sellableQuantity
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        reserveInventory(database, {
          correlationId: 'concurrence',
          expiresAt: TTL,
          idempotencyKey: `k-race-${index}`,
          lines: [{ locationId: fixture.locationId, quantity: 1, variantId: target }],
          now: NOW
        }).then(
          (result) => result.outcome,
          () => 'error'
        )
      )
    )
    const fulfilled = outcomes.filter((outcome) => outcome === 'reserved').length
    expect(fulfilled).toBe(Math.min(20, Math.max(stock, 0)))
    const availability = (await listAvailability(database, { variantId: target }))[0]!
    expect(availability.reservedQuantity).toBe(fulfilled)
    expect(availability.sellableQuantity).toBeGreaterThanOrEqual(0)
    expect((await reconcileInventory(database)).ok).toBe(true)
  })

  it('reconciliation detects deliberate corruption without movements', async () => {
    const { database, fixture, sqlite } = await world()
    expect((await reconcileInventory(database)).ok).toBe(true)

    sqlite.exec(
      `UPDATE inventory_balances SET physical_quantity = physical_quantity + 9 WHERE variant_id = '${fixture.variantId(1, 1)}'`
    )
    const corrupted = await reconcileInventory(database)
    expect(corrupted.ok).toBe(false)
    expect(corrupted.violations.map((violation) => violation.code)).toContain('ledger_physical_mismatch')

    sqlite.exec(
      `UPDATE inventory_balances SET physical_quantity = physical_quantity - 9 WHERE variant_id = '${fixture.variantId(1, 1)}'`
    )
    expect((await reconcileInventory(database)).ok).toBe(true)
  })

  it('every lifecycle step stays explained by ledger movements', async () => {
    const { database, fixture, sqlite } = await world()
    const key = 'k-life'
    await reserveInventory(database, {
      correlationId: 't',
      expiresAt: TTL,
      idempotencyKey: key,
      lines: lines(fixture, [[1, 1]], 2),
      now: NOW
    })
    const afterReserve = await movementCount(sqlite)
    await assignReservation(database, { correlationId: 't', idempotencyKey: key, now: NOW })
    const afterAssign = await movementCount(sqlite)
    expect(afterAssign - afterReserve).toBe(1) // one allocate movement

    // A second reservation released twice must not add extra movements on replay.
    await reserveInventory(database, {
      correlationId: 't',
      expiresAt: TTL,
      idempotencyKey: 'k-life-b',
      lines: lines(fixture, [[2, 1]], 1),
      now: NOW
    })
    const beforeRelease = await movementCount(sqlite)
    await releaseReservation(database, { correlationId: 't', idempotencyKey: 'k-life-b', now: NOW })
    const afterRelease = await movementCount(sqlite)
    expect(afterRelease - beforeRelease).toBe(1)
    await releaseReservation(database, { correlationId: 't', idempotencyKey: 'k-life-b', now: NOW })
    expect(await movementCount(sqlite)).toBe(afterRelease)
    expect((await reconcileInventory(database)).ok).toBe(true)
  })
})

describe('D1 inventory seed safety', () => {
  it('never resets live stock or rewrites its append-only ledger when reapplied', async () => {
    const sqlite = await openMigratedDatabase()
    applyGeneratedSeed(sqlite, renderD1CategorySeed())
    applyGeneratedSeed(sqlite, renderD1ProductSeed())
    applyGeneratedSeed(sqlite, renderD1InventorySeed())
    const target = sqlite
      .prepare('SELECT variant_id AS id FROM inventory_balances ORDER BY variant_id LIMIT 1')
      .get() as {
      id: string
    }
    sqlite
      .prepare(
        'UPDATE inventory_balances SET physical_quantity = physical_quantity - 1, version = version + 1 WHERE variant_id = ?'
      )
      .run(target.id)
    sqlite
      .prepare(
        `INSERT INTO inventory_movements (
           id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
           reference_type, idempotency_key, correlation_id, reason, created_at
         ) SELECT 'live-adjustment', variant_id, location_id, 'adjustment', -1, 0,
                  'audit', 'live-adjustment', 'test', 'Ajuste real', '${NOW}'
           FROM inventory_balances WHERE variant_id = ?`
      )
      .run(target.id)
    const before = {
      balance: sqlite
        .prepare('SELECT physical_quantity, version FROM inventory_balances WHERE variant_id = ?')
        .get(target.id),
      movements: sqlite.prepare('SELECT count(*) AS total FROM inventory_movements').get()
    }

    applyGeneratedSeed(sqlite, renderD1InventorySeed())

    expect(
      sqlite.prepare('SELECT physical_quantity, version FROM inventory_balances WHERE variant_id = ?').get(target.id)
    ).toEqual(before.balance)
    expect(sqlite.prepare('SELECT count(*) AS total FROM inventory_movements').get()).toEqual(before.movements)
    expect((await reconcileInventory(d1OverSqlite(sqlite))).ok).toBe(true)
  })
})
