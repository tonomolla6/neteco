import { describe, expect, it } from 'vitest'
import {
  createCart,
  expireCarts,
  getCart,
  markConverted,
  quoteCart,
  setCartLine,
  type CreatedCart
} from '../../workers/catalog/cart'
import { splitGross } from '../../server/domain/money'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { stableUuid as stableUuidLike } from '../../scripts/lib/d1-category-seed'

const NOW = '2026-08-25T09:00:00Z'

async function world() {
  const sqlite = await openMigratedDatabase()
  const fixture = seedInventoryFixture(sqlite)
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
    } as Parameters<typeof quoteCart>[0]
    const result = await quoteCart(database, hostile)
    if (result.outcome !== 'quoted') throw new Error('expected quote')
    expect(result.quote.currency).toBe('EUR')
    expect(result.quote.pricingInstant).toBe(NOW)
    expect(result.quote.lines.every((line) => line.taxRateBasisPoints > 0)).toBe(true)
    expect(result.quote.lines.find((line) => line.variantId === fixture.variantId(1, 1))!.unitGrossCents).toBe(500)
  })

  it('reseeding demo data does not overwrite live stock or ledger entries', async () => {
    const sqlite = await openMigratedDatabase()
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
