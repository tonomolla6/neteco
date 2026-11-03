import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  addDeliveryRouteStop,
  createDeliveryRoute,
  reoptimizeDeliveryRoute
} from '../../workers/fulfillment/delivery-routes'

// SECFIX-3 finding 7: route writes must be compare-and-set on version, not read-check-then-write.
const now = '2026-10-29T10:00:00Z'
let db: DatabaseSync

beforeEach(async () => {
  db = await openMigratedDatabase()
  db.exec(await readFile('db/d1/migrations/0109_shipping_convenience_conditions_routes.sql', 'utf8'))
  db.exec(`INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
    VALUES('admin-1','admin@example.invalid','syn','${now}','active','${now}','${now}')`)
  await createDeliveryRoute(db, {
    actorId: 'admin-1',
    id: 'route-cas',
    routeDate: '2026-10-30',
    windowStart: '09:00',
    windowEnd: '14:00',
    commandId: 'cmd-route-cas',
    now
  } as never)
})

afterEach(() => db.close())

/** Simulates another writer committing between this command's read and its first write. */
function withConcurrentWriter(target: DatabaseSync) {
  let injected = false
  return {
    prepare(sql: string) {
      if (!injected && !/^\s*SELECT/i.test(sql)) {
        injected = true
        target.exec(`UPDATE delivery_routes SET version = version + 1, total_stops = total_stops + 1,
          total_parcels = total_parcels + 3, total_weight_grams = total_weight_grams + 3000 WHERE id = 'route-cas'`)
      }
      return target.prepare(sql)
    }
  } as unknown as DatabaseSync
}

const route = () =>
  db
    .prepare('SELECT version, total_stops, total_parcels, total_weight_grams FROM delivery_routes WHERE id = ?')
    .get('route-cas') as { version: number; total_stops: number; total_parcels: number; total_weight_grams: number }
const stopCount = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM delivery_route_stops WHERE route_id = ?').get('route-cas') as { n: number }).n

describe('SECFIX-3 delivery route CAS', () => {
  it('replays a stop command without adding a second stop and rejects different payloads', async () => {
    const input = {
      actorId: 'admin-1',
      routeId: 'route-cas',
      recipientName: 'Cliente A',
      streetAddress: 'Calle 1',
      postalCode: '28001',
      city: 'Madrid',
      parcelCount: 1,
      weightGrams: 500,
      expectedVersion: 1,
      commandId: 'cmd-idempotent-stop',
      now
    }
    const first = await addDeliveryRouteStop(d1OverSqlite(db) as never, input)
    expect((await addDeliveryRouteStop(d1OverSqlite(db) as never, input)).version).toBe(first.version)
    await expect(addDeliveryRouteStop(d1OverSqlite(db) as never, { ...input, city: 'Toledo' })).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    expect(stopCount()).toBe(1)
  })

  it('replays a reoptimization command without changing version twice', async () => {
    const input = { actorId: 'admin-1', routeId: 'route-cas', expectedVersion: 1, commandId: 'cmd-reopt-retry', now }
    const first = await reoptimizeDeliveryRoute(d1OverSqlite(db) as never, input)
    const replay = await reoptimizeDeliveryRoute(d1OverSqlite(db) as never, input)
    expect(replay.newVersion).toBe(first.newVersion)
    expect(route().version).toBe(2)
  })

  it('serializes simultaneous identical stop commands and returns the original receipt after later changes', async () => {
    const input = {
      actorId: 'admin-1',
      routeId: 'route-cas',
      recipientName: 'Cliente A',
      streetAddress: 'Calle 1',
      postalCode: '28001',
      city: 'Madrid',
      expectedVersion: 1,
      commandId: 'cmd-concurrent-stop',
      now
    }
    const adapter = d1OverSqlite(db) as never
    const [first, second] = await Promise.all([
      addDeliveryRouteStop(adapter, input),
      addDeliveryRouteStop(adapter, input)
    ])
    expect(second).toEqual(first)
    await reoptimizeDeliveryRoute(adapter, {
      actorId: input.actorId,
      routeId: input.routeId,
      expectedVersion: 2,
      commandId: 'cmd-next',
      now
    })
    expect(await addDeliveryRouteStop(adapter, input)).toEqual(first)
    expect(route().version).toBe(3)
    expect(stopCount()).toBe(1)
  })
  it('addDeliveryRouteStop loses no concurrent update: version_conflict and nothing written', async () => {
    await expect(
      addDeliveryRouteStop(withConcurrentWriter(db), {
        actorId: 'admin-1',
        routeId: 'route-cas',
        recipientName: 'Cliente A',
        streetAddress: 'Calle 1',
        postalCode: '28001',
        city: 'Madrid',
        parcelCount: 1,
        weightGrams: 500,
        expectedVersion: 1,
        commandId: 'cmd-stop-cas',
        now
      })
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect(route()).toEqual({ version: 2, total_stops: 1, total_parcels: 3, total_weight_grams: 3000 })
    expect(stopCount()).toBe(0)
  })

  it('reoptimizeDeliveryRoute rejects a concurrent version change instead of overwriting it', async () => {
    await expect(
      reoptimizeDeliveryRoute(withConcurrentWriter(db), {
        actorId: 'admin-1',
        routeId: 'route-cas',
        expectedVersion: 1,
        commandId: 'cmd-reopt-cas',
        now
      })
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect(route().version).toBe(2)
  })

  it.each([
    { postalCode: 'bad', commandId: 'cmd-invalid-stop' },
    { postalCode: '28001', commandId: 'cmd-route-cas' }
  ])('leaves the route unchanged when a stop or its command cannot be inserted', async ({ postalCode, commandId }) => {
    await expect(
      addDeliveryRouteStop(d1OverSqlite(db) as never, {
        actorId: 'admin-1',
        routeId: 'route-cas',
        recipientName: 'Cliente A',
        streetAddress: 'Calle 1',
        postalCode,
        city: 'Madrid',
        parcelCount: 1,
        weightGrams: 500,
        expectedVersion: 1,
        commandId,
        now
      })
    ).rejects.toThrow()
    expect(route()).toEqual({ version: 1, total_stops: 0, total_parcels: 0, total_weight_grams: 0 })
    expect(stopCount()).toBe(0)
  })

  it('applies an uncontended stop through the D1 adapter (CAS claim succeeds)', async () => {
    const updated = await addDeliveryRouteStop(d1OverSqlite(db) as never, {
      actorId: 'admin-1',
      routeId: 'route-cas',
      recipientName: 'Cliente B',
      streetAddress: 'Calle 2',
      postalCode: '28002',
      city: 'Madrid',
      parcelCount: 2,
      weightGrams: 700,
      expectedVersion: 1,
      commandId: 'cmd-stop-d1',
      now
    })
    expect(updated.version).toBe(2)
    expect(updated.totalStops).toBe(1)
    expect(stopCount()).toBe(1)
  })

  it('uses D1 first() without passing bound values as column names', async () => {
    const d1 = d1OverSqlite(db)
    const strict = {
      batch: d1.batch.bind(d1),
      prepare(sql: string) {
        const stmt = d1.prepare(sql)
        const wrap = (target: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(target, {
            get(statement, property) {
              if (property === 'bind') return (...args: unknown[]) => wrap(statement.bind(...args))
              if (property === 'first' || property === 'all' || property === 'run') {
                return (...args: unknown[]) => {
                  if (args.length) throw new Error('unexpected D1 execution arguments')
                  return statement[property]()
                }
              }
              return Reflect.get(statement, property)
            }
          })
        return wrap(stmt)
      }
    }
    const updated = await addDeliveryRouteStop(strict as never, {
      actorId: 'admin-1',
      routeId: 'route-cas',
      recipientName: 'Cliente C',
      streetAddress: 'Calle 3',
      postalCode: '28003',
      city: 'Madrid',
      expectedVersion: 1,
      commandId: 'cmd-strict-d1',
      now
    })
    expect(updated.version).toBe(2)
    expect(stopCount()).toBe(1)
  })
})
