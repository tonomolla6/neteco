import { describe, expect, it } from 'vitest'
import {
  createCart,
  expireCarts,
  getCart,
  markConverted,
  quoteCart,
  readCartAddOperation,
  setCartLine,
  type CreatedCart
} from '../../workers/catalog/cart'
import { splitGross } from '../../server/domain/money'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { stableUuid as stableUuidLike } from '../../scripts/lib/d1-category-seed'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { testUuid } from '../support/deterministic'

const NOW = '2026-08-25T09:00:00Z'

function withdrawSyntheticPolicy(sqlite: Awaited<ReturnType<typeof openMigratedDatabase>>) {
  sqlite
    .prepare(
      `INSERT INTO catalog_publication_policy_withdrawals(id,policy_id,actor_id,reason,created_at)
    SELECT ?,id,actor_id,'Synthetic policy withdrawal for temporal regression',?
    FROM catalog_publication_policies WHERE code='local_fixture' ORDER BY version DESC LIMIT 1`
    )
    .run(testUuid(), NOW)
}

function beforeBatch(database: D1Database, action: () => void): D1Database {
  let fired = false
  return new Proxy(database, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true
            action()
          }
          return target.batch(statements)
        }
      const value: unknown = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

async function world() {
  const sqlite = await openMigratedDatabase()
  // Match D1's runtime expression limit on complete caller SQL envelopes.
  sqlite.limits.exprDepth = 100
  const fixture = seedInventoryFixture(sqlite)
  await provisionPublicationValidityFixture(d1OverSqlite(sqlite), {
    productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'],
    now: '2026-01-01T00:00:00Z'
  })
  // A governed price version for v-2-1 (effective 300 cents vs base 500).
  sqlite
    .prepare(
      `INSERT INTO variant_price_versions (
         id, variant_id, gross_cents, volume_tiers, valid_from, status, reason, created_at
       ) VALUES ('pv-cart-1', ?, 300, '[]', '2026-01-01T00:00:00Z', 'approved', 'Precio gobernado test', '2026-01-01T00:00:00Z')`
    )
    .run(fixture.variantId(2, 1))
  // An unpublished variant that carts must reject.
  sqlite.exec(
    `INSERT INTO products (id, legacy_id, category_id, name, slug, status)
     VALUES ('p-hidden', 99, 'c1', 'Producto oculto', 'producto-oculto', 'draft')`
  )
  sqlite
    .prepare(
      `INSERT INTO variants (
         id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status,
         price_gross_cents, backorder_allowed
       ) VALUES ('v-hidden', 991, 'p-hidden', 't21', 'sp1', 'SKU-HIDDEN', 'Botella 1 L', 'draft', 700, 0)`
    )
    .run()

  return { database: d1OverSqlite(sqlite), fixture, sqlite }
}

async function newCart(database: D1Database): Promise<CreatedCart> {
  return createCart(database, { correlationId: 'test', now: NOW })
}

describe('current publication authority for cart writes and quotes', () => {
  it('recovers only the exact authorized ADD receipt without touching an expired cart or retired SKU', async () => {
    const { sqlite, database } = await world()
    try {
      const cart = await newCart(database)
      const input = {
        cartId: cart.cartId,
        token: cart.token,
        idempotencyKey: 'lost-add',
        expectedVersion: 1,
        variantId: 'v-1-1',
        quantity: 2,
        mode: 'add' as const,
        correlationId: 'test',
        now: NOW
      }
      await setCartLine(database, input)
      sqlite.exec(
        "UPDATE variants SET status='draft' WHERE id='v-1-1'; UPDATE carts SET status='expired',expired_at=expires_at"
      )
      const before = sqlite.prepare('SELECT * FROM carts').all()
      const lines = sqlite.prepare('SELECT * FROM cart_lines').all()
      const commands = sqlite.prepare('SELECT * FROM cart_commands').all()
      expect(await readCartAddOperation(database, input)).toEqual({
        source: 'cloudflare',
        cartId: cart.cartId,
        commandId: 'lost-add',
        outcome: 'applied',
        appliedVersion: 2
      })
      expect(await readCartAddOperation(database, { ...input, idempotencyKey: 'absent' })).toMatchObject({
        outcome: 'unknown',
        appliedVersion: null
      })
      await expect(readCartAddOperation(database, { ...input, quantity: 3 })).rejects.toMatchObject({
        code: 'conflict'
      })
      await expect(readCartAddOperation(database, { ...input, token: 'wrong' })).rejects.toMatchObject({
        code: 'unauthorized'
      })
      const forbiddenLedger = new Proxy(database, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => {
              if (sql.includes('FROM cart_commands')) throw new Error('unauthorized ledger lookup')
              return target.prepare(sql)
            }
          const value: unknown = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await expect(readCartAddOperation(forbiddenLedger, { ...input, token: 'wrong' })).rejects.toMatchObject({
        code: 'unauthorized'
      })
      expect(sqlite.prepare('SELECT * FROM carts').all()).toEqual(before)
      expect(sqlite.prepare('SELECT * FROM cart_lines').all()).toEqual(lines)
      expect(sqlite.prepare('SELECT * FROM cart_commands').all()).toEqual(commands)
    } finally {
      sqlite.close()
    }
  })
  it('fails closed on malformed receipt metadata and token rotation during ledger lookup', async () => {
    const { sqlite, database } = await world()
    try {
      const cart = await newCart(database)
      const input = {
        ...cart,
        idempotencyKey: 'recover-proof',
        expectedVersion: 1,
        variantId: 'v-1-1',
        quantity: 2,
        mode: 'add' as const,
        correlationId: 'test',
        now: NOW
      }
      await setCartLine(database, input)
      const original = sqlite.prepare('SELECT response_body FROM cart_commands').get() as { response_body: string }
      for (const fault of [
        { kind: 'quote', status: 200, body: original.response_body },
        { kind: 'mutate', status: 201, body: original.response_body },
        { kind: 'mutate', status: 200, body: '{}' },
        { kind: 'mutate', status: 200, body: '{"outcome":"applied","body":{"cartVersion":999}}' }
      ]) {
        sqlite
          .prepare('UPDATE cart_commands SET kind=?,response_status=?,response_body=?')
          .run(fault.kind, fault.status, fault.body)
        await expect(readCartAddOperation(database, input)).rejects.toMatchObject({ name: 'CartInfrastructureError' })
      }
      sqlite
        .prepare("UPDATE cart_commands SET kind='mutate',response_status=200,response_body=?")
        .run(original.response_body)
      const rotating = new Proxy(database, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => {
              const statement = target.prepare(sql)
              if (!sql.includes('FROM cart_commands')) return statement
              return {
                bind(...parameters: unknown[]) {
                  const bound = statement.bind(...parameters)
                  return {
                    async first() {
                      const row = await bound.first()
                      sqlite.prepare('UPDATE carts SET token_hash=? WHERE id=?').run('f'.repeat(64), cart.cartId)
                      return row
                    }
                  }
                }
              }
            }
          const value: unknown = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }) as D1Database
      await expect(readCartAddOperation(rotating, input)).rejects.toMatchObject({ code: 'unauthorized' })
    } finally {
      sqlite.close()
    }
  })
  it('never grandfathers a published product without a reviewed policy', async () => {
    const { sqlite, database } = await world()
    const cart = await newCart(database)
    sqlite.exec(
      "UPDATE products SET status='published' WHERE id='p-hidden'; UPDATE variants SET status='published' WHERE id='v-hidden'"
    )
    await expect(
      setCartLine(database, {
        cartId: cart.cartId,
        token: cart.token,
        variantId: 'v-hidden',
        expectedVersion: 1,
        idempotencyKey: 'missing-policy',
        correlationId: 'validity',
        now: NOW,
        quantity: 1
      })
    ).rejects.toMatchObject({ code: 'variant_not_available' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM cart_commands').get()).toMatchObject({ n: 0 })
  })

  it('denies a withdrawn policy but still allows removing the saved line', async () => {
    const { sqlite, database } = await world()
    const cart = await newCart(database)
    const command = {
      cartId: cart.cartId,
      token: cart.token,
      variantId: 'v-1-1',
      expectedVersion: 1,
      idempotencyKey: 'before-withdrawal',
      correlationId: 'validity',
      now: NOW,
      quantity: 2
    }
    await setCartLine(database, command)
    withdrawSyntheticPolicy(sqlite)
    await expect(
      setCartLine(database, { ...command, expectedVersion: 2, idempotencyKey: 'after-withdrawal' })
    ).rejects.toMatchObject({ code: 'variant_not_available' })
    expect(
      await setCartLine(database, { ...command, quantity: 0, expectedVersion: 2, idempotencyKey: 'remove-invalid' })
    ).toMatchObject({ outcome: 'applied', body: { removed: true, cartVersion: 3 } })
    expect(sqlite.prepare('SELECT count(*) AS n FROM cart_lines').get()).toMatchObject({ n: 0 })
  })

  it('keeps a historical quote replay but denies new quotes after withdrawal', async () => {
    const { sqlite, database } = await world()
    const cart = await newCart(database)
    await setCartLine(database, {
      cartId: cart.cartId,
      token: cart.token,
      variantId: 'v-1-1',
      expectedVersion: 1,
      idempotencyKey: 'line',
      correlationId: 'validity',
      now: NOW,
      quantity: 1
    })
    const command = {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      idempotencyKey: 'historical-quote',
      correlationId: 'validity',
      now: NOW
    }
    const historical = await quoteCart(database, command)
    withdrawSyntheticPolicy(sqlite)
    expect(await quoteCart(database, command)).toEqual(historical)
    await expect(quoteCart(database, { ...command, idempotencyKey: 'new-quote' })).rejects.toMatchObject({
      code: 'variant_not_available'
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM checkout_quotes').get()).toMatchObject({ n: 1 })
  })

  it('rolls back a mutation if governing evidence changes after the preflight', async () => {
    const { sqlite, database } = await world()
    const cart = await newCart(database)
    const drifting = beforeBatch(database, () => withdrawSyntheticPolicy(sqlite))
    await expect(
      setCartLine(drifting, {
        cartId: cart.cartId,
        token: cart.token,
        variantId: 'v-1-1',
        expectedVersion: 1,
        idempotencyKey: 'late-drift',
        correlationId: 'validity',
        now: NOW,
        quantity: 1
      })
    ).rejects.toMatchObject({ code: 'variant_not_available' })
    expect(sqlite.prepare('SELECT version FROM carts WHERE id=?').get(cart.cartId)).toMatchObject({ version: 1 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM cart_lines').get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM cart_commands').get()).toMatchObject({ n: 0 })
  })

  it('rolls back every quote row if its evidence changes before the batch commits', async () => {
    const { sqlite, database } = await world()
    const cart = await newCart(database)
    await setCartLine(database, {
      cartId: cart.cartId,
      token: cart.token,
      variantId: 'v-1-1',
      expectedVersion: 1,
      idempotencyKey: 'line',
      correlationId: 'validity',
      now: NOW,
      quantity: 1
    })
    await expect(
      quoteCart(
        beforeBatch(database, () => withdrawSyntheticPolicy(sqlite)),
        {
          cartId: cart.cartId,
          token: cart.token,
          expectedVersion: 2,
          idempotencyKey: 'late-quote',
          correlationId: 'validity',
          now: NOW
        }
      )
    ).rejects.toMatchObject({ code: 'variant_not_available' })
    for (const table of ['checkout_quotes', 'checkout_quote_lines'])
      expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare("SELECT count(*) AS n FROM cart_commands WHERE command_id='late-quote'").get()).toMatchObject(
      { n: 0 }
    )
  })

  it('does not turn a D1 outage into a publication business error', async () => {
    const { database } = await world()
    const cart = await newCart(database)
    const broken = new Proxy(database, {
      get(target, property) {
        if (property === 'batch')
          return async () => {
            throw new Error('D1 unavailable')
          }
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(
      setCartLine(broken, {
        cartId: cart.cartId,
        token: cart.token,
        variantId: 'v-1-1',
        expectedVersion: 1,
        idempotencyKey: 'outage',
        correlationId: 'validity',
        now: NOW,
        quantity: 1
      })
    ).rejects.toMatchObject({ name: 'CartInfrastructureError' })
  })

  it.each(['mutation', 'quote'] as const)(
    'preserves infrastructure classification when policy withdrawal coincides with a %s batch outage mentioning CHECK',
    async (operation) => {
      const { sqlite, database } = await world()
      const cart = await newCart(database)
      if (operation === 'quote')
        await setCartLine(database, {
          cartId: cart.cartId,
          token: cart.token,
          variantId: 'v-1-1',
          expectedVersion: 1,
          idempotencyKey: 'line-before-outage',
          correlationId: 'validity',
          now: NOW,
          quantity: 1
        })
      const beforeCart = sqlite.prepare('SELECT * FROM carts WHERE id=?').get(cart.cartId)
      const beforeLines = sqlite.prepare('SELECT * FROM cart_lines ORDER BY cart_id,variant_id').all()
      const beforeCommands = sqlite.prepare('SELECT * FROM cart_commands ORDER BY command_id').all()
      let batches = 0
      const unavailable = new Proxy(database, {
        get(target, property) {
          if (property === 'batch')
            return async () => {
              batches += 1
              withdrawSyntheticPolicy(sqlite)
              // No batch statements execute: this is infrastructure failure,
              // not an atomic guard reporting the independently committed drift.
              throw new Error('D1_ERROR: provider unavailable; CHECK constraint failed private_table')
            }
          const value: unknown = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      const command = {
        cartId: cart.cartId,
        token: cart.token,
        expectedVersion: operation === 'quote' ? 2 : 1,
        idempotencyKey: 'outage-with-drift',
        correlationId: 'validity',
        now: NOW
      }
      await expect(
        operation === 'quote'
          ? quoteCart(unavailable, command)
          : setCartLine(unavailable, { ...command, variantId: 'v-1-1', quantity: 1 })
      ).rejects.toMatchObject({ name: 'CartInfrastructureError' })
      expect(batches).toBe(1)
      expect(sqlite.prepare('SELECT * FROM carts WHERE id=?').get(cart.cartId)).toEqual(beforeCart)
      expect(sqlite.prepare('SELECT * FROM cart_lines ORDER BY cart_id,variant_id').all()).toEqual(beforeLines)
      expect(sqlite.prepare('SELECT * FROM cart_commands ORDER BY command_id').all()).toEqual(beforeCommands)
      for (const table of ['checkout_quotes', 'checkout_quote_lines', 'inventory_reservations'])
        expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toMatchObject({ n: 0 })
      expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_publication_policy_withdrawals').get()).toMatchObject({
        n: 1
      })
    }
  )
})

describe('cart identity and authorization', () => {
  it('creates a cart whose token works exactly once and never reappears', async () => {
    const { database } = await world()
    const created = await newCart(database)
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const view = await getCart(database, { cartId: created.cartId, token: created.token })
    expect(view).toMatchObject({ cartId: created.cartId, version: 1, status: 'active', lines: [] })
  })

  it('never leaks cart existence through wrong tokens', async () => {
    const { database } = await world()
    const created = await newCart(database)
    for (const token of ['wrong-token-wrong-token-wrong-token-wrong', '']) {
      await expect(getCart(database, { cartId: created.cartId, token })).rejects.toMatchObject({ code: 'unauthorized' })
      await expect(
        setCartLine(database, {
          cartId: created.cartId,
          correlationId: 't',
          expectedVersion: 1,
          idempotencyKey: `k-${token.slice(0, 4)}-1`,
          now: NOW,
          quantity: 1,
          token,
          variantId: 'v-any'
        })
      ).rejects.toMatchObject({ code: 'unauthorized' })
    }
    // Unknown id with any token must be indistinguishable from a wrong token.
    await expect(
      getCart(database, { cartId: 'f0000000-0000-4000-8000-000000000000', token: created.token })
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('stores only the SHA-256 digest of the secret token', async () => {
    const { database, sqlite } = await world()
    const created = await newCart(database)
    const row = sqlite.prepare('SELECT token_hash FROM carts WHERE id = ?').get(created.cartId) as {
      token_hash: string
    }
    expect(row.token_hash).toHaveLength(64)
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.token_hash).not.toContain(created.token)
    void database
  })
})

describe('cart mutations: idempotency, versions and atomicity', () => {
  async function cartWithLine(quantity = 3) {
    const { database, fixture, sqlite } = await world()
    const created = await newCart(database)
    const applied = await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 1,
      idempotencyKey: 'k-seed',
      now: NOW,
      quantity,
      token: created.token,
      variantId: fixture.variantId(1, 1)
    })
    expect(applied.outcome).toBe('applied')
    return { applied, created, database, fixture, sqlite }
  }

  it('applies, replays identically and conflicts on payload change', async () => {
    const { applied, created, database, fixture } = await cartWithLine()
    expect(applied.outcome === 'applied' ? applied.body : null).toMatchObject({ cartVersion: 2, removed: false })

    const replay = await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 1,
      idempotencyKey: 'k-seed',
      now: NOW,
      quantity: 3,
      token: created.token,
      variantId: fixture.variantId(1, 1)
    })
    expect(replay).toEqual(applied)

    const conflict = await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 1,
      idempotencyKey: 'k-seed',
      now: NOW,
      quantity: 5,
      token: created.token,
      variantId: fixture.variantId(1, 1)
    })
    expect(conflict.outcome).toBe('conflict')
  })

  it('authenticates before replaying and scopes the same key independently per cart', async () => {
    const { database, fixture } = await world()
    const firstCart = await newCart(database)
    const secondCart = await newCart(database)
    const input = {
      correlationId: 't',
      expectedVersion: 1,
      idempotencyKey: 'shared-across-carts',
      now: NOW,
      quantity: 2,
      variantId: fixture.variantId(1, 1)
    }

    await expect(
      setCartLine(database, { ...input, cartId: firstCart.cartId, token: firstCart.token })
    ).resolves.toMatchObject({ outcome: 'applied' })
    await expect(
      setCartLine(database, { ...input, cartId: firstCart.cartId, token: 'wrong-token' })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(
      setCartLine(database, { ...input, cartId: secondCart.cartId, token: secondCart.token })
    ).resolves.toMatchObject({ outcome: 'applied' })
  })

  it('expires a cart at the command instant and leaves no mutation behind', async () => {
    const { database, fixture, sqlite } = await world()
    const created = await newCart(database)
    const result = await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 1,
      idempotencyKey: 'after-ttl',
      now: '2026-08-28T09:00:00Z',
      quantity: 1,
      token: created.token,
      variantId: fixture.variantId(1, 1)
    })
    expect(result).toEqual({ outcome: 'not_active', status: 'expired' })
    expect(sqlite.prepare('SELECT count(*) AS c FROM cart_lines WHERE cart_id = ?').get(created.cartId)).toEqual({
      c: 0
    })
    expect(sqlite.prepare('SELECT count(*) AS c FROM cart_commands WHERE cart_id = ?').get(created.cartId)).toEqual({
      c: 0
    })
  })

  it('rejects stale expectedVersion without any effect', async () => {
    const { created, database, fixture, sqlite } = await cartWithLine()
    const result = await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 1,
      idempotencyKey: 'k-stale',
      now: NOW,
      quantity: 7,
      token: created.token,
      variantId: fixture.variantId(2, 1)
    })
    expect(result.outcome).toBe('version_conflict')
    if (result.outcome === 'version_conflict') expect(result.currentVersion).toBe(2)
    const commands = sqlite.prepare('SELECT count(*) AS c FROM cart_commands WHERE command_id=?').get('k-stale') as {
      c: number
    }
    expect(commands.c).toBe(0)
    void fixture
  })

  it.each([-1, 0.5, 1000])('rejects unsafe quantity %s before touching state', async (quantity) => {
    const { created, database, fixture, sqlite } = await cartWithLine()
    await expect(
      setCartLine(database, {
        cartId: created.cartId,
        correlationId: 't',
        expectedVersion: 2,
        idempotencyKey: `k-bad-${quantity}`,
        now: NOW,
        quantity: quantity as number,
        token: created.token,
        variantId: fixture.variantId(1, 1)
      })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const version = (
      sqlite.prepare('SELECT version FROM carts WHERE id = ?').get(created.cartId) as { version: number }
    ).version
    expect(version).toBe(2)
  })

  it('removes lines with quantity 0 and keeps one line per variant', async () => {
    const { created, database, fixture } = await cartWithLine()
    const second = await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 2,
      idempotencyKey: 'k-second',
      now: NOW,
      quantity: 2,
      token: created.token,
      variantId: fixture.variantId(2, 1)
    })
    expect(second.outcome).toBe('applied')

    const upsert = await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 3,
      idempotencyKey: 'k-upsert',
      now: NOW,
      quantity: 9,
      token: created.token,
      variantId: fixture.variantId(1, 1)
    })
    expect(upsert.outcome).toBe('applied')

    const view = await getCart(database, { cartId: created.cartId, token: created.token })
    expect(view.lines.filter((line) => line.variantId === fixture.variantId(1, 1))).toHaveLength(1)
    expect(view.lines.find((line) => line.variantId === fixture.variantId(1, 1))?.quantity).toBe(9)

    const removal = await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 4,
      idempotencyKey: 'k-remove',
      now: NOW,
      quantity: 0,
      token: created.token,
      variantId: fixture.variantId(1, 1)
    })
    expect(removal.outcome === 'applied' && removal.body.removed).toBe(true)
    const after = await getCart(database, { cartId: created.cartId, token: created.token })
    expect(after.lines.some((line) => line.variantId === fixture.variantId(1, 1))).toBe(false)
  })

  it('rejects unpublished or unknown variants with one stable code', async () => {
    const { created, database, fixture } = await cartWithLine()
    for (const [index, target] of ['v-hidden', '00000000-0000-4000-8000-000000000000'].entries()) {
      await expect(
        setCartLine(database, {
          cartId: created.cartId,
          correlationId: 't',
          expectedVersion: 2,
          idempotencyKey: `k-var-${index}`,
          now: NOW,
          quantity: 1,
          token: created.token,
          variantId: target
        })
      ).rejects.toMatchObject({ code: 'variant_not_available' })
    }
    void fixture
  })

  it('refuses a "Consultar precio" variant (public price 0) with the stable unavailable code', async () => {
    const { created, database, fixture, sqlite } = await cartWithLine()
    sqlite.prepare('UPDATE variants SET price_gross_cents = 0 WHERE id = ?').run(fixture.variantId(3, 1))
    sqlite.prepare('UPDATE variants SET price_gross_cents = 0 WHERE id = ?').run(fixture.variantId(1, 1))
    await expect(
      setCartLine(database, {
        cartId: created.cartId,
        correlationId: 't',
        expectedVersion: 2,
        idempotencyKey: 'k-price-0-add',
        mode: 'add',
        now: NOW,
        quantity: 1,
        token: created.token,
        variantId: fixture.variantId(3, 1)
      })
    ).rejects.toMatchObject({ code: 'variant_not_available' })
    // Raising the quantity of a line that lost its public price is refused too…
    await expect(
      setCartLine(database, {
        cartId: created.cartId,
        correlationId: 't',
        expectedVersion: 2,
        idempotencyKey: 'k-price-0-set',
        now: NOW,
        quantity: 5,
        token: created.token,
        variantId: fixture.variantId(1, 1)
      })
    ).rejects.toMatchObject({ code: 'variant_not_available' })
    // …but removing it stays possible.
    const removal = await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 2,
      idempotencyKey: 'k-price-0-remove',
      now: NOW,
      quantity: 0,
      token: created.token,
      variantId: fixture.variantId(1, 1)
    })
    expect(removal.outcome === 'applied' && removal.body.removed).toBe(true)
  })

  it('accepts a variant whose base price is 0 but whose governed price is positive', async () => {
    const { created, database, fixture, sqlite } = await cartWithLine()
    sqlite.prepare('UPDATE variants SET price_gross_cents = 0 WHERE id = ?').run(fixture.variantId(2, 1))
    const applied = await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 2,
      idempotencyKey: 'k-governed-price',
      mode: 'add',
      now: NOW,
      quantity: 1,
      token: created.token,
      variantId: fixture.variantId(2, 1)
    })
    expect(applied.outcome).toBe('applied')
  })

  it('rolls the whole batch back when a mid-flight failure aborts the transaction', async () => {
    const { created, database, fixture, sqlite } = await cartWithLine()
    sqlite.exec(`
      CREATE TRIGGER abort_cart_lines_666 BEFORE INSERT ON cart_lines
      WHEN new.quantity = 665
      BEGIN
        SELECT RAISE(ABORT, 'simulated mid-flight failure');
      END;
    `)
    const beforeLines = (sqlite.prepare('SELECT count(*) AS c FROM cart_lines').get() as { c: number }).c
    await expect(
      setCartLine(database, {
        cartId: created.cartId,
        correlationId: 't',
        expectedVersion: 2,
        idempotencyKey: 'k-abort',
        now: NOW,
        quantity: 665,
        token: created.token,
        variantId: fixture.variantId(2, 1)
      })
    ).rejects.toThrow()
    const afterLines = (sqlite.prepare('SELECT count(*) AS c FROM cart_lines').get() as { c: number }).c
    const version = (
      sqlite.prepare('SELECT version FROM carts WHERE id = ?').get(created.cartId) as { version: number }
    ).version
    expect(afterLines).toBe(beforeLines)
    expect(version).toBe(2)
    const command = sqlite.prepare('SELECT count(*) AS c FROM cart_commands WHERE command_id = ?').get('k-abort') as {
      c: number
    }
    expect(command.c).toBe(0)
    sqlite.exec('DROP TRIGGER abort_cart_lines_666')
  })

  it('freezes expired and converted carts', async () => {
    const { database, fixture } = await world()
    const expiring = await newCart(database)

    await expireCarts(database, { at: '2026-09-01T00:00:00Z' })
    const convertedCart = await newCart(database)

    const expiredView = await getCart(database, { cartId: expiring.cartId, token: expiring.token })
    expect(expiredView.status).toBe('expired')
    expect(expiredView.version).toBe(2)
    await expect(
      setCartLine(database, {
        cartId: expiring.cartId,
        correlationId: 't',
        expectedVersion: 1,
        idempotencyKey: 'k-expired',
        now: NOW,
        quantity: 1,
        token: expiring.token,
        variantId: fixture.variantId(1, 1)
      })
    ).resolves.toMatchObject({ outcome: 'not_active', status: 'expired' })

    await setCartLine(database, {
      cartId: convertedCart.cartId,
      correlationId: 't',
      expectedVersion: 1,
      idempotencyKey: 'converted-line',
      now: NOW,
      quantity: 1,
      token: convertedCart.token,
      variantId: fixture.variantId(1, 1)
    })
    const contractual = await quoteCart(database, {
      cartId: convertedCart.cartId,
      correlationId: 't',
      expectedVersion: 2,
      idempotencyKey: 'converted-quote',
      now: NOW,
      token: convertedCart.token
    })
    if (contractual.outcome !== 'quoted') throw new Error('expected contractual quote')
    await markConverted(database, {
      cartId: convertedCart.cartId,
      expectedVersion: 2,
      now: NOW,
      quoteId: contractual.quote.quoteId
    })
    const converted = await getCart(database, { cartId: convertedCart.cartId, token: convertedCart.token })
    expect(converted.status).toBe('converted')
    expect(converted.version).toBe(3)
    await expect(
      quoteCart(database, {
        cartId: convertedCart.cartId,
        correlationId: 't',
        expectedVersion: 3,
        idempotencyKey: 'k-q-conv',
        now: NOW,
        token: convertedCart.token
      })
    ).resolves.toMatchObject({ outcome: 'not_active', status: 'converted' })
  })

  it('accepts only canonical, semantically valid instants everywhere', async () => {
    const { created, database, fixture, sqlite } = await cartWithLine()
    for (const bad of ['2026-13-45T99:99:99Z', '2026-08-25 09:00:00', "2026-08-25'; DROP TABLE carts;--"]) {
      await expect(
        setCartLine(database, {
          cartId: created.cartId,
          correlationId: 't',
          expectedVersion: 2,
          idempotencyKey: `k-time-${bad.length}-${bad.charCodeAt(0)}`,
          now: bad,
          quantity: 1,
          token: created.token,
          variantId: fixture.variantId(1, 1)
        })
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
    // The schema itself must also reject impossible timestamps (defence in depth
    // behind the service-level validation above).
    expect(() =>
      sqlite.exec(
        "INSERT INTO carts (id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at) VALUES ('carts-impossible','" +
          'a'.repeat(64) +
          "','active',1,'2026-08-28T09:00:00Z','t','2026-13-45T99:99:99Z','2026-13-45T99:99:99Z')"
      )
    ).toThrow()

    for (const [table, columns, values] of [
      [
        'carts',
        'id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at',
        `'bad-hash-cart','${`a${'Z'.repeat(63)}`}','active',1,'2026-08-28T09:00:00Z','t','${NOW}','${NOW}'`
      ],
      [
        'cart_commands',
        'command_id, cart_id, kind, payload_hash, response_status, response_body, correlation_id, created_at',
        `'bad-hash-command','${created.cartId}','mutate','${`a${'Z'.repeat(63)}`}',200,'{}','t','${NOW}'`
      ],
      [
        'checkout_quotes',
        'id, cart_id, cart_version, pricing_instant, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at',
        `'bad-hash-quote','${created.cartId}',2,'${NOW}',1,0,1,'${`a${'Z'.repeat(63)}`}','t','${NOW}'`
      ]
    ] as const) {
      expect(() => sqlite.exec(`INSERT INTO ${table} (${columns}) VALUES (${values})`)).toThrow()
    }
  })
})

describe('pre-checkout quotes', () => {
  async function quotedCart() {
    const { database, fixture, sqlite } = await world()
    const created = await newCart(database)
    await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 1,
      idempotencyKey: 'q-add-1',
      now: NOW,
      quantity: 2,
      token: created.token,
      variantId: fixture.variantId(1, 1)
    })
    await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 2,
      idempotencyKey: 'q-add-2',
      now: NOW,
      quantity: 1,
      token: created.token,
      variantId: fixture.variantId(2, 1)
    })
    return { created, database, fixture, sqlite }
  }

  it('prices with effective versions, taxes via money.ts and snapshots availability', async () => {
    const { created, database, fixture } = await quotedCart()
    const result = await quoteCart(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 3,
      idempotencyKey: 'q-1',
      now: NOW,
      token: created.token
    })
    expect(result.outcome).toBe('quoted')
    if (result.outcome !== 'quoted') return
    const { quote } = result
    expect(quote.pricingInstant).toBe(NOW)
    expect(quote.currency).toBe('EUR')
    expect(quote.shipping).toEqual({ grossCents: 0, pending: true })
    const governed = quote.lines.find((line) => line.variantId === fixture.variantId(2, 1))!
    expect(governed.unitGrossCents).toBe(300)
    expect(governed.priceVersionId).toBe('pv-cart-1')
    const fallback = quote.lines.find((line) => line.variantId === fixture.variantId(1, 1))!
    expect(fallback.unitGrossCents).toBe(500)
    expect(fallback.priceVersionId).toBe(`legacy:${fixture.variantId(1, 1)}`)

    // Rounding must match server/domain/money.ts exactly.
    const oracleBase = splitGross(governed.unitGrossCents * governed.quantity, governed.taxRateBasisPoints)
    expect(governed.netCents).toBe(oracleBase.netCents)
    expect(governed.taxCents).toBe(oracleBase.taxCents)
    expect(governed.grossCents).toBe(oracleBase.grossCents)

    // Availability observed from inventory without reserving anything.
    expect(governed.availableQuantity).toBeGreaterThan(0)
    expect(quote.totals.grossCents).toBe(quote.lines.reduce((sum, line) => sum + line.grossCents, 0))
  })

  it('selects the winning volume tier at the cart quantity and rounds VAT on the whole line', async () => {
    const { created, database, fixture, sqlite } = await quotedCart()
    sqlite
      .prepare(
        `INSERT INTO variant_price_versions (
           id, variant_id, gross_cents, volume_tiers, valid_from, status, reason, created_at
         ) VALUES ('pv-tier-quote', ?, 500,
           '[{"minimumQuantity":2,"unitGrossCents":3}]', '${NOW}', 'approved',
           'Tier fiscal test', '${NOW}')`
      )
      .run(fixture.variantId(1, 1))
    const result = await quoteCart(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 3,
      idempotencyKey: 'tier-quote',
      now: NOW,
      token: created.token
    })
    expect(result.outcome).toBe('quoted')
    if (result.outcome !== 'quoted') return
    const line = result.quote.lines.find((item) => item.variantId === fixture.variantId(1, 1))!
    expect(line).toMatchObject({
      priceVersionId: 'pv-tier-quote',
      quantity: 2,
      unitGrossCents: 3,
      grossCents: 6,
      netCents: 5,
      taxCents: 1
    })
    expect(splitGross(3, line.taxRateBasisPoints).netCents * 2).toBe(4)
    expect(
      (
        sqlite
          .prepare('SELECT unit_gross_cents FROM checkout_quote_lines WHERE quote_id = ? AND variant_id = ?')
          .get(result.quote.quoteId, fixture.variantId(1, 1)) as { unit_gross_cents: number }
      ).unit_gross_cents
    ).toBe(3)
  })

  it('never reserves stock nor mutates balances while quoting', async () => {
    const { created, database, fixture, sqlite } = await quotedCart()
    const balancesBefore = sqlite
      .prepare('SELECT variant_id AS v, physical_quantity AS q FROM inventory_balances ORDER BY v')
      .all()
    await quoteCart(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 3,
      idempotencyKey: 'q-noreserve',
      now: NOW,
      token: created.token
    })
    await quoteCart(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 3,
      idempotencyKey: 'q-noreserve-2',
      now: NOW,
      token: created.token
    })
    const balancesAfter = sqlite
      .prepare('SELECT variant_id AS v, physical_quantity AS q FROM inventory_balances ORDER BY v')
      .all()
    expect(balancesAfter).toEqual(balancesBefore)
    const reservations = sqlite.prepare('SELECT count(*) AS c FROM inventory_reservations').get() as { c: number }
    expect(reservations.c).toBe(0)
    void fixture
  })

  it('keeps old quotes byte-identical when prices or the cart move on', async () => {
    const { created, database, fixture, sqlite } = await quotedCart()
    const first = await quoteCart(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 3,
      idempotencyKey: 'q-old',
      now: NOW,
      token: created.token
    })
    if (first.outcome !== 'quoted') throw new Error('expected quote')
    const snapshotBefore = sqlite
      .prepare('SELECT * FROM checkout_quote_lines WHERE quote_id = ? ORDER BY line_index')
      .all(first.quote.quoteId)
    const quoteRowBefore = sqlite.prepare('SELECT * FROM checkout_quotes WHERE id = ?').get(first.quote.quoteId)

    // Price change for the fallback variant becomes effective later.
    sqlite
      .prepare(
        `INSERT INTO variant_price_versions (
           id, variant_id, gross_cents, volume_tiers, valid_from, status, reason, created_at
         ) VALUES ('pv-later', ?, 111, '[]', '2026-08-26T00:00:00Z', 'approved', 'Subida futura', '${NOW}')`
      )
      .run(fixture.variantId(1, 1))
    // Cart changes too.
    await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 3,
      idempotencyKey: 'q-change',
      now: NOW,
      quantity: 50,
      token: created.token,
      variantId: fixture.variantId(1, 1)
    })

    const second = await quoteCart(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 4,
      idempotencyKey: 'q-new',
      now: NOW,
      token: created.token
    })
    if (second.outcome !== 'quoted') throw new Error('expected second quote')
    expect(second.quote.quoteId).not.toBe(first.quote.quoteId)
    const newFallback = second.quote.lines.find((line) => line.variantId === fixture.variantId(1, 1))!
    expect(newFallback.quantity).toBe(50)
    // Still the old effective price: the new version starts tomorrow.
    expect(newFallback.unitGrossCents).toBe(500)

    const snapshotAfter = sqlite
      .prepare('SELECT * FROM checkout_quote_lines WHERE quote_id = ? ORDER BY line_index')
      .all(first.quote.quoteId)
    expect(snapshotAfter).toEqual(snapshotBefore)
    const quoteRowAfter = sqlite.prepare('SELECT * FROM checkout_quotes WHERE id = ?').get(first.quote.quoteId)
    expect(quoteRowAfter).toEqual(quoteRowBefore)

    // Tomorrow's instant picks the new governed price.
    const future = await quoteCart(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 4,
      idempotencyKey: 'q-future',
      now: '2026-08-26T00:00:01Z',
      token: created.token
    })
    if (future.outcome !== 'quoted') throw new Error('expected future quote')
    expect(future.quote.lines.find((line) => line.variantId === fixture.variantId(1, 1))!.unitGrossCents).toBe(111)
    expect(future.quote.pricingInstant).toBe('2026-08-26T00:00:01Z')

    expect(() =>
      sqlite.prepare('UPDATE checkout_quotes SET total_gross_cents = 1 WHERE id = ?').run(first.quote.quoteId)
    ).toThrow(/immutable/)
    expect(() =>
      sqlite.prepare('DELETE FROM checkout_quote_lines WHERE quote_id = ?').run(first.quote.quoteId)
    ).toThrow(/immutable/)
  })

  it('replays the same stored quote for the same key regardless of later changes', async () => {
    const { created, database } = await quotedCart()
    const first = await quoteCart(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 3,
      idempotencyKey: 'q-replay-key',
      now: NOW,
      token: created.token
    })
    const replay = await quoteCart(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 3,
      idempotencyKey: 'q-replay-key',
      now: '2026-08-26T00:00:01Z', // even a different later instant cannot alter a stored answer
      token: created.token
    })
    expect(replay).toEqual(first)

    await expect(
      quoteCart(database, {
        cartId: created.cartId,
        correlationId: 't',
        expectedVersion: 3,
        idempotencyKey: 'q-replay-key',
        now: NOW,
        token: 'wrong-token'
      })
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('rejects stale versions and unavailable lines instead of creating a partial quote', async () => {
    const { created, database, fixture, sqlite } = await quotedCart()
    await expect(
      quoteCart(database, {
        cartId: created.cartId,
        correlationId: 't',
        expectedVersion: 2,
        idempotencyKey: 'q-stale',
        now: NOW,
        token: created.token
      })
    ).resolves.toMatchObject({ currentVersion: 3, outcome: 'version_conflict' })

    sqlite.prepare("UPDATE variants SET status = 'draft' WHERE id = ?").run(fixture.variantId(2, 1))
    await expect(
      quoteCart(database, {
        cartId: created.cartId,
        correlationId: 't',
        expectedVersion: 3,
        idempotencyKey: 'q-unpublished',
        now: NOW,
        token: created.token
      })
    ).rejects.toMatchObject({ code: 'variant_not_available' })
    expect(sqlite.prepare("SELECT count(*) AS c FROM checkout_quotes WHERE correlation_id = 't'").get()).toEqual({
      c: 0
    })
  })

  it('refuses to quote (and so to check out) a line whose public price dropped to 0', async () => {
    const { created, database, fixture, sqlite } = await quotedCart()
    sqlite.prepare('UPDATE variants SET price_gross_cents = 0 WHERE id = ?').run(fixture.variantId(1, 1))
    await expect(
      quoteCart(database, {
        cartId: created.cartId,
        correlationId: 'price-0',
        expectedVersion: 3,
        idempotencyKey: 'q-price-0',
        now: NOW,
        token: created.token
      })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(sqlite.prepare("SELECT count(*) AS c FROM checkout_quotes WHERE correlation_id = 'price-0'").get()).toEqual({
      c: 0
    })
  })

  it('refuses to quote an empty cart', async () => {
    const { database } = await world()
    const created = await newCart(database)
    await expect(
      quoteCart(database, {
        cartId: created.cartId,
        correlationId: 't',
        expectedVersion: 1,
        idempotencyKey: 'q-empty',
        now: NOW,
        token: created.token
      })
    ).resolves.toMatchObject({ outcome: 'empty_cart' })
  })

  it('ignores client-supplied pricing fields entirely', async () => {
    const { created, database, fixture } = await quotedCart()
    const hostile = {
      cartId: created.cartId,
      correlationId: 't',
      currency: 'USD',
      discountPercent: -90,
      expectedVersion: 3,
      idempotencyKey: 'q-hostile',
      now: NOW,
      pricingInstant: '1999-01-01T00:00:00Z',
      taxRateBasisPoints: 0,
      token: created.token,
      unitPriceOverride: 1
    }
    const result = await quoteCart(database, hostile)
    if (result.outcome !== 'quoted') throw new Error('expected quote')
    expect(result.quote.currency).toBe('EUR')
    expect(result.quote.pricingInstant).toBe(NOW)
    expect(result.quote.lines.every((line) => line.taxRateBasisPoints > 0)).toBe(true)
    expect(result.quote.lines.find((line) => line.variantId === fixture.variantId(1, 1))!.unitGrossCents).toBe(500)
  })

  it('reseeding demo data does not overwrite live stock or ledger entries', async () => {
    const sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    const { applyGeneratedSeed } = await import('../support/d1-sqlite')
    const { renderD1CategorySeed } = await import('../../scripts/lib/d1-category-seed')
    const { renderD1ProductSeed } = await import('../../scripts/lib/d1-product-seed')
    const { INVENTORY_SEED_LOCATION_ID, renderD1InventorySeed } = await import('../../scripts/lib/d1-inventory-seed')
    const { reserveInventory } = await import('../../workers/catalog/inventory')
    applyGeneratedSeed(sqlite, renderD1CategorySeed())
    applyGeneratedSeed(sqlite, renderD1ProductSeed())
    applyGeneratedSeed(sqlite, renderD1InventorySeed())

    const liveVariant = stableUuidLike('variant:1:1')
    const reservation = await reserveInventory(d1OverSqlite(sqlite), {
      correlationId: 'live',
      expiresAt: '2026-08-29T09:00:00Z',
      idempotencyKey: 'live-reserve-1',
      lines: [{ locationId: INVENTORY_SEED_LOCATION_ID, quantity: 4, variantId: liveVariant }],
      now: NOW
    })
    expect(reservation.outcome).toBe('reserved')

    const stockBefore = sqlite
      .prepare('SELECT variant_id AS v, physical_quantity AS q FROM inventory_balances ORDER BY v')
      .all()
    const ledgerBefore = sqlite.prepare('SELECT count(*) AS c FROM inventory_movements').get()

    applyGeneratedSeed(sqlite, renderD1InventorySeed())

    const stockAfter = sqlite
      .prepare('SELECT variant_id AS v, physical_quantity AS q FROM inventory_balances ORDER BY v')
      .all()
    const ledgerAfter = sqlite.prepare('SELECT count(*) AS c FROM inventory_movements').get()
    expect(stockAfter).toEqual(stockBefore)
    expect(JSON.stringify(ledgerAfter)).toBe(JSON.stringify(ledgerBefore))
  })
})
