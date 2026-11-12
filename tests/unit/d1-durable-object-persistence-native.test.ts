import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { createCart } from '../../workers/catalog/cart'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { testUuid, testNow } from '../support/deterministic'
import { syncNativeTestClock } from '../support/native-runtime-clock'

// Local workerd acceptance, not the controlled remote suite required by TST-009.
// Only this generated temporary directory is persisted and subsequently removed.
describe('real cart/inventory Durable Objects: concurrency, failure and restart', () => {
  let runtime: Miniflare | undefined
  let database: D1Database
  let directory: string | undefined
  let script: string
  let now: string
  let expiresAt: string
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })

  async function start() {
    if (!directory) throw new Error('missing_owned_persistence_directory')
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'durable-persistence-native',
        modules: true,
        script,
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        resourcePersistencePath: join(directory, 'persist'),
        resourceTmpPath: join(directory, 'tmp'),
        d1Databases: { DB: '00000000-0000-4000-8000-000000000009' },
        durableObjects: {
          CARTS: { className: 'CartCoordinator', useSQLite: true },
          INVENTORY: { className: 'InventoryCoordinator', useSQLite: true }
        },
        outboundService: outbound
      })
    )
    database = (await runtime.getD1Database('DB')) as unknown as D1Database
  }
  async function send(kind: 'cart' | 'inventory', command: Record<string, unknown>) {
    if (!runtime) throw new Error('missing_runtime')
    const response = await runtime.dispatchFetch('https://durable-native.neteco.test/' + kind, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command)
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const reserve = (variantId: string, quantity: number) => {
    const key = testUuid()
    return {
      type: 'reserve',
      commandId: key,
      payload: {
        correlationId: 'native-persistence',
        idempotencyKey: key,
        now,
        expiresAt,
        lines: [{ variantId, locationId: 'loc-main', quantity }]
      }
    }
  }
  const mutate = (cart: { cartId: string; token: string }, quantity: number) => {
    const key = testUuid()
    return {
      type: 'mutate',
      commandId: key,
      cartId: cart.cartId,
      payload: {
        ...cart,
        variantId: 'v-1-1',
        quantity,
        expectedVersion: 1,
        idempotencyKey: key,
        correlationId: 'native-persistence',
        now
      }
    }
  }
  async function cartFacts(cartId: string) {
    return (
      await database.batch([
        database.prepare('SELECT * FROM carts WHERE id=?').bind(cartId),
        database.prepare('SELECT * FROM cart_lines WHERE cart_id=? ORDER BY variant_id').bind(cartId),
        database.prepare('SELECT * FROM cart_commands WHERE cart_id=? ORDER BY command_id').bind(cartId)
      ])
    ).map((result) => result.results)
  }
  async function inventoryFacts(variantId: string) {
    return (
      await database.batch([
        database.prepare('SELECT * FROM inventory_balances WHERE variant_id=? ORDER BY location_id').bind(variantId),
        database
          .prepare('SELECT * FROM inventory_reservation_lines WHERE variant_id=? ORDER BY reservation_id')
          .bind(variantId),
        database.prepare('SELECT * FROM inventory_movements WHERE variant_id=? ORDER BY id').bind(variantId)
      ])
    ).map((result) => result.results)
  }
  async function ownedBytes(path: string): Promise<number> {
    const entry = await stat(path)
    if (!entry.isDirectory()) return entry.size
    let bytes = 0
    for (const name of await readdir(path)) bytes += await ownedBytes(join(path, name))
    return bytes
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'neteco-tst009-native-'))
    try {
      const bundle = await build({
        stdin: {
          resolveDir: process.cwd(),
          sourcefile: 'durable-persistence-native-entry.ts',
          loader: 'ts',
          contents: `
            import { CartCoordinator, cartDoName } from './workers/cart-coordinator';
            import { InventoryCoordinator, INVENTORY_COORDINATOR_NAME } from './workers/inventory-coordinator';
            export { CartCoordinator, InventoryCoordinator };
            export default { async fetch(request, env) {
              const command = await request.json();
              const cart = new URL(request.url).pathname === '/cart';
              const namespace = cart ? env.CARTS : env.INVENTORY;
              const name = cart ? cartDoName(command.cartId) : INVENTORY_COORDINATOR_NAME;
              return namespace.get(namespace.idFromName(name)).fetch(new Request('https://do.invalid/command', {
                method: 'POST', body: JSON.stringify(command)
              }));
            }};
          `
        },
        bundle: true,
        platform: 'browser',
        format: 'esm',
        external: ['node:*', 'cloudflare:*'],
        write: false,
        logLevel: 'silent'
      })
      script = bundle.outputFiles[0]!.text
      await start()
      now = await syncNativeTestClock(database)
      expiresAt = new Date(Date.parse(now) + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      // Setup only: migration behaviour has its own existing native suite.
      const migrations = (await readdir('db/d1/migrations')).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()
      for (const name of migrations)
        await database.batch(
          splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8')).map((sql) => database.prepare(sql))
        )
      const statements: D1PreparedStatement[] = []
      seedInventoryFixture({
        exec(sql: string) {
          for (const statement of splitDemoSql(sql)) statements.push(database.prepare(statement))
        },
        prepare(sql: string) {
          return {
            run(...parameters: unknown[]) {
              statements.push(database.prepare(sql).bind(...parameters))
            }
          }
        }
      } as unknown as DatabaseSync)
      await database.batch(statements)
      await provisionPublicationValidityFixture(database, {
        productIds: ['p-1'],
        now,
        validUntil: '2099-01-01T00:00:00Z'
      })
    } catch (error) {
      await runtime?.dispose()
      runtime = undefined
      await rm(directory, { recursive: true, force: true })
      directory = undefined
      throw error
    }
  }, 60_000)
  beforeEach(async () => {
    now = await syncNativeTestClock(database)
    expiresAt = new Date(Date.parse(now) + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  })
  afterAll(async () => {
    try {
      await runtime?.dispose()
      runtime = undefined
      if (directory) expect(await ownedBytes(directory)).toBeLessThanOrEqual(128 * 1024 * 1024)
      expect(outbound).not.toHaveBeenCalled()
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('serializes simultaneous same-cart/version mutations into one effect and one CAS conflict', async () => {
    const cart = await createCart(database, { now, correlationId: 'native-concurrency' })
    const results = await Promise.all([send('cart', mutate(cart, 2)), send('cart', mutate(cart, 3))])
    expect(results.map((result) => result.status).sort()).toEqual([200, 409])
    expect(results.find((result) => result.status === 409)?.body).toMatchObject({ outcome: 'version_conflict' })
    const facts = await cartFacts(cart.cartId)
    expect(facts[0]).toMatchObject([{ version: 2 }])
    expect(facts[1]).toHaveLength(1)
    expect(facts[1]![0]!.quantity).toBe(results[0]!.status === 200 ? 2 : 3)
    expect(facts[2]).toHaveLength(1)
  }, 30_000)

  it('serializes competing reservations without overselling the actual three-unit balance', async () => {
    const results = await Promise.all([send('inventory', reserve('v-4-1', 2)), send('inventory', reserve('v-4-1', 2))])
    expect(results.map((result) => result.status).sort()).toEqual([200, 409])
    expect(results.find((result) => result.status === 409)?.body).toMatchObject({
      error: { code: 'insufficient_stock' }
    })
    const facts = await inventoryFacts('v-4-1')
    expect(facts[0]).toMatchObject([{ physical_quantity: 3 }])
    expect(facts[1]).toMatchObject([{ quantity: 2 }])
    expect(facts[1]).toHaveLength(1)
    expect(facts[2]!.filter((row) => row.movement_type === 'reserve')).toHaveLength(1)
  }, 30_000)

  it('reopens real D1/DO persistence and preserves exact replay and changed-payload conflicts for both objects', async () => {
    const cart = await createCart(database, { now, correlationId: 'native-restart' })
    const cartCommand = mutate(cart, 4),
      inventoryCommand = reserve('v-2-1', 2)
    const cartResponse = await send('cart', cartCommand),
      inventoryResponse = await send('inventory', inventoryCommand)
    expect(cartResponse.status).toBe(200)
    expect(inventoryResponse.status).toBe(200)
    const cartBefore = await cartFacts(cart.cartId),
      inventoryBefore = await inventoryFacts('v-2-1')
    await runtime!.dispose()
    runtime = undefined
    await start()
    expect(await send('cart', cartCommand)).toEqual(cartResponse)
    expect(await send('inventory', inventoryCommand)).toEqual(inventoryResponse)
    expect((await send('cart', { ...cartCommand, payload: { ...cartCommand.payload, quantity: 5 } })).status).toBe(409)
    expect(
      (
        await send('inventory', {
          ...inventoryCommand,
          payload: { ...inventoryCommand.payload, lines: [{ variantId: 'v-2-1', locationId: 'loc-main', quantity: 3 }] }
        })
      ).status
    ).toBe(409)
    expect(await cartFacts(cart.cartId)).toEqual(cartBefore)
    expect(await inventoryFacts('v-2-1')).toEqual(inventoryBefore)
  }, 30_000)

  it('rolls back a genuine UNIQUE constraint failure and accepts the next valid command on the same DO', async () => {
    const cart = await createCart(database, { now, correlationId: 'native-constraint' })
    const before = await cartFacts(cart.cartId)
    // Ephemeral fault injection uses the REAL variants.sku UNIQUE constraint.
    // The attempted SKU change and all cart batch effects must roll back.
    await database
      .prepare(
        `CREATE TRIGGER native_tst009_constraint BEFORE INSERT ON cart_lines
      BEGIN UPDATE variants SET sku='SKU-2-1' WHERE id='v-1-1'; END`
      )
      .run()
    try {
      const failed = await send('cart', mutate(cart, 2))
      expect(failed.status).toBe(500)
      expect(await cartFacts(cart.cartId)).toEqual(before)
      expect(await database.prepare("SELECT sku FROM variants WHERE id='v-1-1'").first()).toEqual({ sku: 'SKU-1-1' })
    } finally {
      await database.prepare('DROP TRIGGER native_tst009_constraint').run()
    }
    expect((await send('cart', mutate(cart, 2))).status).toBe(200)
    const after = await cartFacts(cart.cartId)
    expect(after[0]).toMatchObject([{ version: 2 }])
    expect(after[1]).toMatchObject([{ quantity: 2 }])
    expect(after[2]).toHaveLength(1)
  }, 30_000)

  it('automatically fires persisted cart and inventory alarms after restart without another DO request', async () => {
    const instant = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const due = new Date(Date.parse(instant) + 15_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    // Historical fixture creation keeps the production three-day cart TTL
    // intact. No Date/fake-clock override, shortened policy or expiry SQL write.
    const historicalCreation = new Date(Date.parse(due) - 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
    const shortCart = await createCart(database, { now: historicalCreation, correlationId: 'native-alarm-short' })
    const longCart = await createCart(database, { now: instant, correlationId: 'native-alarm-control' })
    expect(shortCart.expiresAt).toBe(due)
    const cartCommand = mutate(shortCart, 2)
    expect((await send('cart', { ...cartCommand, payload: { ...cartCommand.payload, now: instant } })).status).toBe(200)
    const longCartCommand = mutate(longCart, 1)
    expect(
      (await send('cart', { ...longCartCommand, payload: { ...longCartCommand.payload, now: instant } })).status
    ).toBe(200)
    const shortReservation = reserve('v-3-1', 2)
    expect(
      (
        await send('inventory', {
          ...shortReservation,
          payload: { ...shortReservation.payload, now: instant, expiresAt: due }
        })
      ).status
    ).toBe(200)
    const longReservation = reserve('v-6-1', 1)
    expect(
      (
        await send('inventory', {
          ...longReservation,
          payload: { ...longReservation.payload, now: instant }
        })
      ).status
    ).toBe(200)
    const longCartBefore = await cartFacts(longCart.cartId)
    const longInventoryBefore = await inventoryFacts('v-6-1')
    const observe = async () =>
      (
        await database.batch([
          database.prepare('SELECT status,version,expires_at,expired_at FROM carts WHERE id=?').bind(shortCart.cartId),
          database
            .prepare('SELECT status,expires_at,expired_at FROM inventory_reservations WHERE idempotency_key=?')
            .bind(shortReservation.payload.idempotencyKey),
          database
            .prepare(
              "SELECT physical_delta,reserved_delta,created_at FROM inventory_movements WHERE variant_id='v-3-1' AND movement_type='release' AND reference_id=?"
            )
            .bind(shortReservation.payload.idempotencyKey)
        ])
      ).map((result) => result.results)
    expect(await observe()).toMatchObject([
      [{ status: 'active', version: 2, expires_at: due, expired_at: null }],
      [{ status: 'reserved', expires_at: due, expired_at: null }],
      []
    ])
    expect(testNow()).toBeLessThan(Date.parse(due))
    await runtime!.dispose()
    runtime = undefined
    await start()
    // From here onward only D1 SELECTs run: no fetch to wake an object, no
    // direct alarm()/expiry call, no storage.setAlarm(), no scheduler trigger.
    await vi.waitFor(
      async () => {
        const facts = await observe()
        expect(facts[0]).toMatchObject([{ status: 'expired', version: 3, expires_at: due }])
        expect(facts[1]).toMatchObject([{ status: 'expired', expires_at: due }])
        expect(facts[2]).toMatchObject([{ physical_delta: 0, reserved_delta: -2 }])
        expect(facts[2]).toHaveLength(1)
        expect(Date.parse(String(facts[0]![0]!.expired_at))).toBeGreaterThanOrEqual(Date.parse(due))
        expect(Date.parse(String(facts[1]![0]!.expired_at))).toBeGreaterThanOrEqual(Date.parse(due))
      },
      { timeout: 30_000, interval: 250 }
    )
    expect(await cartFacts(longCart.cartId)).toEqual(longCartBefore)
    expect(await inventoryFacts('v-6-1')).toEqual(longInventoryBefore)
    expect(outbound).not.toHaveBeenCalled()
  }, 45_000)
})
