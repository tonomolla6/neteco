import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { CartCoordinator, cartDoName } from '../../workers/cart-coordinator'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'

class FakeStorage {
  private readonly values = new Map<string, unknown>()
  private alarm: number | null = null

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }
  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value))
  }
  async delete(key: string) {
    this.values.delete(key)
  }
  async list({ prefix }: { prefix?: string }) {
    return new Map([...this.values].filter(([key]) => !prefix || key.startsWith(prefix)))
  }
  async setAlarm(atMs: number) {
    this.alarm = atMs
  }
  async getAlarm() {
    return this.alarm
  }
  async deleteAlarm() {
    this.alarm = null
  }
}

interface WorldOptions {
  delayMs?: number
  failDatabase?: boolean
}

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

async function world(options: WorldOptions = {}) {
  const sqlite = await openMigratedDatabase()
  seedInventoryFixture(sqlite)
  sqlite.exec(
    "INSERT INTO products (id, legacy_id, category_id, name, slug, status) VALUES ('p-uuid-a', 201, 'c1', 'Producto UUID A', 'producto-uuid-a', 'published')"
  )
  sqlite.exec(
    "INSERT INTO products (id, legacy_id, category_id, name, slug, status) VALUES ('p-uuid-b', 202, 'c1', 'Producto UUID B', 'producto-uuid-b', 'published')"
  )
  for (const [variantId, productId] of [
    [UUID_A, 'p-uuid-a'],
    [UUID_B, 'p-uuid-b']
  ] as const) {
    sqlite
      .prepare(
        `INSERT INTO variants (
           id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status,
           price_gross_cents, backorder_allowed
         ) VALUES (?, ?, ?, 't21', 'sp1', ?, 'Botella 1 L', 'published', 500, 0)`
      )
      .run(variantId, productId === 'p-uuid-a' ? 2001 : 2002, productId, `SKU-${variantId.slice(0, 8)}`)
    sqlite
      .prepare(
        `INSERT INTO inventory_balances (
           variant_id, location_id, physical_quantity, blocked_quantity, version, created_at, updated_at
         ) VALUES (?, 'loc-main', 25, 0, 1, '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z')`
      )
      .run(variantId)
  }
  sqlite.exec(`
    INSERT INTO shipping_zones (id, code, name, kind, postal_prefixes, active, created_at)
    VALUES ('zone-pickup', 'pickup', 'Recogida', 'warehouse_pickup', '[]', 1, '2026-08-12T00:00:00Z');
    INSERT INTO shipping_rates (
      id, zone_id, method_code, service_profile, net_cents, tax_rate_basis_points,
      eta_min_days, eta_max_days, rate_version, active, created_at
    ) VALUES (
      'rate-pickup', 'zone-pickup', 'pickup', 'parcel', 0, 2100,
      0, 0, 1, 1, '2026-08-12T00:00:00Z'
    );
  `)

  let database = d1OverSqlite(sqlite)
  let inFlight = 0
  let maxInFlight = 0
  if (options.delayMs || options.failDatabase) {
    const rawPrepare = database.prepare.bind(database)
    const instrumented = (sql: string) => {
      const statement = rawPrepare(sql)
      return {
        bind: (...parameters: unknown[]) => {
          const bound = statement.bind(...parameters)
          return {
            first: () =>
              track(
                () => bound.first(),
                () => Promise.reject(new Error('D1 outage'))
              ),
            all: () =>
              track(
                () => bound.all(),
                () => Promise.reject(new Error('D1 outage'))
              ),
            run: () =>
              track(
                () => bound.run(),
                () => Promise.reject(new Error('D1 outage'))
              )
          }
        }
      }
    }
    database = { ...database, prepare: instrumented } as unknown as D1Database
  }

  function track<T>(operation: () => Promise<T>, failure: () => Promise<T>): Promise<T> {
    if (options.failDatabase) return failure()
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    return new Promise<T>((resolve) => setTimeout(resolve, options.delayMs ?? 0)).then(() =>
      operation().finally(() => {
        inFlight -= 1
      })
    )
  }

  // One Durable Object instance per cart name. Serialization must come from
  // CartCoordinator itself, not from this test namespace.
  const entries = new Map<string, { instance: CartCoordinator; storage: FakeStorage }>()
  const env = {
    APP_ENV: 'canary',
    DB: database,
    CARTS: {
      idFromName: (name: string) => ({ name }),
      get: (stub: { name: string }) => ({
        fetch: (request: Request) => {
          let entry = entries.get(stub.name)
          if (!entry) {
            const storage = new FakeStorage()
            entry = {
              instance: new CartCoordinator({ storage, waitUntil: vi.fn() } as unknown as DurableObjectState, {
                APP_ENV: 'canary',
                DB: database
              }),
              storage
            }
            entries.set(stub.name, entry)
          }
          return entry.instance.fetch(request)
        }
      })
    }
  } as unknown as CloudflareEnv

  return {
    env,
    maxInFlight: () => maxInFlight,
    entryCount: () => entries.size,
    storageOfName: (name: string) => entries.get(name)?.storage
  }
}

function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>
}

async function createCart(env: CloudflareEnv): Promise<{ cartId: string; token: string }> {
  const response = await worker.fetch!(
    new Request('https://canary.neteco.invalid/api/carts', { method: 'POST', body: '{}' }),
    env
  )
  expect(response.status).toBe(201)
  return (await json(response)) as unknown as { cartId: string; token: string }
}

const mutateViaApi = (
  env: CloudflareEnv,
  cart: { cartId: string; token: string },
  key: string,
  variantId: string,
  quantity: number,
  expectedVersion: number
) =>
  worker.fetch!(
    new Request(`https://canary.neteco.invalid/api/carts/${cart.cartId}/items/${variantId}`, {
      method: 'PUT',
      headers: { authorization: `Cart ${cart.token}`, 'idempotency-key': key },
      body: JSON.stringify({ expectedVersion, quantity })
    }),
    env
  )

describe('CartCoordinator partitioning and serialization', () => {
  it('serializes concurrent commands for the same cart (maxInFlight=1)', async () => {
    const { env, maxInFlight } = await world({ delayMs: 25 })
    const cart = await createCart(env)

    const [first, second] = await Promise.all([
      mutateViaApi(env, cart, 'k-race-a', UUID_A, 2, 1),
      mutateViaApi(env, cart, 'k-race-b', UUID_B, 3, 1)
    ])
    expect(first.status).toBe(200)
    expect(second.status).toBe(409)
    const loserBody = await json(second)
    expect(loserBody.outcome ?? (loserBody as { error?: { code?: string } }).error?.code).toBe('version_conflict')
    expect(maxInFlight()).toBe(1)
  })

  it('keeps different carts on different instances with isolated caches', async () => {
    const { env, entryCount, storageOfName } = await world()
    const cartA = await createCart(env)
    const cartB = await createCart(env)

    for (const cart of [cartA, cartB])
      expect((await mutateViaApi(env, cart, 'shared-key', UUID_A, 1, 1)).status).toBe(200)
    expect(entryCount()).toBe(2)
    for (const cart of [cartA, cartB]) {
      const cached = await storageOfName(cartDoName(cart.cartId))?.get('cmd:shared-key')
      expect(cached).toBeDefined()
    }
  })

  it('allows different cart instances to execute in parallel', async () => {
    const { env, maxInFlight } = await world({ delayMs: 25 })
    const cartA = await createCart(env)
    const cartB = await createCart(env)
    const quote = (cart: { cartId: string; token: string }, key: string) =>
      worker.fetch!(
        new Request(`https://canary.neteco.invalid/api/carts/${cart.cartId}/quote`, {
          method: 'POST',
          headers: { authorization: `Cart ${cart.token}`, 'idempotency-key': key },
          body: JSON.stringify({ expectedVersion: 1 })
        }),
        env
      )
    const [first, second] = await Promise.all([quote(cartA, 'parallel-a'), quote(cartB, 'parallel-b')])
    expect(first.status).toBe(422)
    expect(second.status).toBe(422)
    expect(maxInFlight()).toBeGreaterThanOrEqual(2)
  })

  it('rejects a reused commandId carrying a different payload', async () => {
    const { env } = await world()
    const cart = await createCart(env)
    const name = cartDoName(cart.cartId)
    const commandNow = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

    const directCall = (variantId: string, quantity: number) => {
      const stub = (
        env as unknown as { CARTS: { get(stub: { name: string }): { fetch(request: Request): Promise<Response> } } }
      ).CARTS.get({ name })
      return stub.fetch(
        new Request('https://cart-coordinator.invalid/command', {
          method: 'POST',
          body: JSON.stringify({
            cartId: cart.cartId,
            commandId: 'dup-key',
            payload: {
              cartId: cart.cartId,
              correlationId: 't',
              expectedVersion: 1,
              idempotencyKey: 'dup-key',
              now: commandNow,
              quantity,
              token: cart.token,
              variantId
            },
            type: 'mutate'
          })
        })
      )
    }

    const first = await directCall(UUID_A, 1)
    expect(first.status).toBe(200)
    const second = await directCall(UUID_B, 2)
    expect(second.status).toBe(409)
    await expect(second.json()).resolves.toMatchObject({ error: { code: 'conflict' } })
    void name
  })

  it('still replays the original response after more than 256 later commands', async () => {
    const { env, storageOfName } = await world()
    const cart = await createCart(env)

    let latestVersion = 1
    const firstBody = await json(await mutateViaApi(env, cart, 'k-0', UUID_A, 1, latestVersion))
    latestVersion = Number(firstBody.cartVersion)
    for (let index = 1; index <= 300; index += 1) {
      const response = await mutateViaApi(env, cart, `k-${index}`, UUID_A, (index % 9) + 1, latestVersion)
      const body = await json(response)
      latestVersion = Number(body.cartVersion)
    }

    // Simulate eviction/restart: the persistent D1 command ledger, not the DO
    // cache, must reproduce the original response after 300 later commands.
    await storageOfName(cartDoName(cart.cartId))?.delete('cmd:k-0')
    const replayed = await mutateViaApi(env, cart, 'k-0', UUID_A, 1, 1)
    expect(replayed.status).toBe(200)
    await expect(replayed.json()).resolves.toEqual(firstBody)

    // A genuinely different payload under the same key is still rejected.
    const conflict = await mutateViaApi(env, cart, 'k-0', UUID_A, 7, 1)
    expect(conflict.status).toBe(409)
    await expect(json(conflict)).resolves.toMatchObject({ error: { code: 'conflict' } })
  })

  it('authenticates before the DO cache and never stores the plaintext token', async () => {
    const { env, storageOfName } = await world()
    const cart = await createCart(env)
    const storage = storageOfName(cartDoName(cart.cartId))
    expect(JSON.stringify([...(await storage!.list({})).entries()])).not.toContain(cart.token)
    const first = await mutateViaApi(env, cart, 'secure-replay', UUID_A, 1, 1)
    expect(first.status).toBe(200)

    const wrongToken = await mutateViaApi(env, { ...cart, token: 'wrong-token' }, 'secure-replay', UUID_A, 1, 1)
    expect(wrongToken.status).toBe(401)
    const stored = await storage?.get('cmd:secure-replay')
    expect(JSON.stringify(stored)).not.toContain(cart.token)
  })

  it('reports infrastructure outages as internal errors, not business outcomes', async () => {
    const { env } = await world({ failDatabase: true })
    const response = await worker.fetch!(
      new Request('https://canary.neteco.invalid/api/carts', { method: 'POST', body: '{}' }),
      env
    )
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: { code: 'internal' } })

    const misleading = await worker.fetch!(
      new Request(`https://canary.neteco.invalid/api/carts/${UUID_A}/items/${UUID_B}`, {
        method: 'PUT',
        headers: {
          authorization: 'Cart invalid-token-invalid-token-invalid-token-invalid',
          'idempotency-key': 'k-outage'
        },
        body: JSON.stringify({ expectedVersion: 1, quantity: 1 })
      }),
      env
    )
    expect(misleading.status).toBe(500)
    await expect(misleading.json()).resolves.toEqual({ error: { code: 'internal' } })
  })
})

describe('cart HTTP contract', () => {
  it('serves shipping, checkout and authenticated guest order lookup end to end', async () => {
    const { env, storageOfName } = await world()
    const cart = await createCart(env)
    expect((await mutateViaApi(env, cart, 'http-add', UUID_A, 2, 1)).status).toBe(200)
    const headers = { authorization: `Cart ${cart.token}`, 'idempotency-key': 'http-quote' }
    const quoteResponse = await worker.fetch!(
      new Request(`https://canary.neteco.invalid/api/carts/${cart.cartId}/quote`, {
        body: JSON.stringify({ expectedVersion: 2 }),
        headers,
        method: 'POST'
      }),
      env
    )
    expect(quoteResponse.status).toBe(200)
    const quote = (await json(quoteResponse)).quote as Record<string, unknown>

    const shippingResponse = await worker.fetch!(
      new Request(`https://canary.neteco.invalid/api/carts/${cart.cartId}/shipping-options`, {
        body: JSON.stringify({ destination: { city: 'Ontinyent', postalCode: '46870' }, expectedVersion: 2 }),
        headers: { ...headers, 'idempotency-key': 'http-shipping' },
        method: 'POST'
      }),
      env
    )
    expect(shippingResponse.status).toBe(200)
    const shipping = (await json(shippingResponse)).body as Record<string, unknown>
    const pickup = (shipping.options as Array<Record<string, unknown>>)[0]!
    const checkoutPayload = {
      consentPrivacy: true,
      consentTos: true,
      contactEmail: 'http@neteco.es',
      expectedVersion: 2,
      quoteId: quote.quoteId,
      selectedOptionHash: pickup.optionHash,
      selectedOptionIndex: pickup.optionIndex,
      shippingAddress: {
        city: 'Ontinyent',
        line1: 'Carrer Major 1',
        phone: '+34 600 000 000',
        postalCode: '46870',
        province: 'València',
        recipientName: 'Compra HTTP'
      },
      shippingQuoteId: shipping.shippingQuoteId
    }
    const checkoutRequest = () =>
      worker.fetch!(
        new Request(`https://canary.neteco.invalid/api/carts/${cart.cartId}/orders`, {
          body: JSON.stringify(checkoutPayload),
          headers: { ...headers, 'idempotency-key': 'http-checkout' },
          method: 'POST'
        }),
        env
      )
    const first = await checkoutRequest()
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('no-store')
    const firstBody = await json(first)
    const order = firstBody.body as Record<string, unknown>
    expect(order.orderToken).toMatch(/^[0-9a-f]{64}$/)
    const replay = await checkoutRequest()
    expect(await json(replay)).toEqual(firstBody)
    expect(JSON.stringify([...(await storageOfName(cartDoName(cart.cartId))!.list({})).entries()])).not.toContain(
      order.orderToken as string
    )

    const lookup = await worker.fetch!(
      new Request(`https://canary.neteco.invalid/api/orders/${String(order.id)}`, {
        headers: { authorization: `Order ${String(order.orderToken)}` }
      }),
      env
    )
    expect(lookup.status).toBe(200)
    expect(lookup.headers.get('cache-control')).toBe('no-store')
    await expect(json(lookup)).resolves.toMatchObject({ id: order.id })
  })

  it('marks every response no-store and never leaks the token afterwards', async () => {
    const logSpy = vi.spyOn(console, 'log')
    const { env } = await world()
    const createResponse = await worker.fetch!(
      new Request('https://canary.neteco.invalid/api/carts', { method: 'POST', body: '{}' }),
      env
    )
    expect(createResponse.headers.get('cache-control')).toBe('no-store')
    const cart = (await json(createResponse)) as unknown as { cartId: string; token: string }

    const view = await worker.fetch!(
      new Request(`https://canary.neteco.invalid/api/carts/${cart.cartId}`, {
        headers: { authorization: `Cart ${cart.token}` }
      }),
      env
    )
    expect(view.headers.get('cache-control')).toBe('no-store')
    expect(await view.text()).not.toContain(cart.token)

    const unauthorized = await worker.fetch!(new Request(`https://canary.neteco.invalid/api/carts/${cart.cartId}`), env)
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('cache-control')).toBe('no-store')

    for (const call of logSpy.mock.calls.flat()) expect(String(call)).not.toContain(cart.token)
    logSpy.mockRestore()
  })

  it('enforces strict limits on ids, keys, bodies and quantities', async () => {
    const { env } = await world()
    const cart = await createCart(env)

    const oversized = await worker.fetch!(
      new Request('https://canary.neteco.invalid/api/carts', {
        method: 'POST',
        body: JSON.stringify({ blob: 'x'.repeat(8192) })
      }),
      env
    )
    expect(oversized.status).toBe(400)

    const badVariant = await mutateViaApi(env, cart, 'k-limits-a', 'not-a-uuid', 1, 1)
    expect(badVariant.status).toBe(400)

    const badQuantity = await mutateViaApi(env, cart, 'k-limits-b', UUID_A, 5000, 1)
    expect(badQuantity.status).toBe(400)

    const missingKey = await worker.fetch!(
      new Request(`https://canary.neteco.invalid/api/carts/${cart.cartId}/items/${UUID_A}`, {
        method: 'PUT',
        headers: { authorization: `Cart ${cart.token}` },
        body: JSON.stringify({ expectedVersion: 1, quantity: 1 })
      }),
      env
    )
    expect(missingKey.status).toBe(400)
  })

  it('documents the deterministic DO partitioning key', () => {
    expect(cartDoName('some-cart-id')).toBe('cart:some-cart-id')
    expect(cartDoName('other-cart-id')).not.toBe(cartDoName('some-cart-id'))
  })
})
