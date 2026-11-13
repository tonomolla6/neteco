import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { returnsFixture, CLAIMS, utc } from './d1-returns-fixture'
import type { DatabaseSync } from 'node:sqlite'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { syncNativeTestClock } from '../support/native-runtime-clock'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import {
  executeD1OrderAnnotations,
  readD1OrderAnnotations,
  readD1OrderAnnotationCommand
} from '../../workers/catalog/order-annotations'

it('executes append/CAS/live-authority and receipt recovery on actual workerd D1', async () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'annotations-native',
      modules: true,
      script: 'export default {fetch(){return new Response("isolated")}}',
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      d1Databases: { DB: '00000000-0000-4000-8000-000000000063' },
      outboundService: () => {
        throw new Error('unexpected_outbound')
      }
    })
  )
  let fixture: Awaited<ReturnType<typeof returnsFixture>> | undefined
  try {
    // Only synthetic identity grants and shipping configuration are portable.
    // Create the catalog and the order through their native fixture/services:
    // copying a post-publication catalog would bypass its initial-version guard.
    const db = (await runtime.getD1Database('DB')) as unknown as D1Database
    await syncNativeTestClock(db)
    fixture = await returnsFixture()
    for (const name of (await readdir('db/d1/migrations')).filter((value) => /^\d+.*\.sql$/.test(value)).sort()) {
      const sql = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
      for (let index = 0; index < sql.length; index += 50)
        await db.batch(sql.slice(index, index + 50).map((text) => db.prepare(text)))
    }
    const inserts: D1PreparedStatement[] = []
    seedInventoryFixture({
      exec(sql: string) {
        for (const text of splitDemoSql(sql)) inserts.push(db.prepare(text))
      },
      prepare(sql: string) {
        return {
          run(...args: unknown[]) {
            inserts.push(db.prepare(sql).bind(...args))
          }
        }
      }
    } as unknown as DatabaseSync)
    for (const name of [
      'customers',
      'identities',
      'auth_sessions',
      'roles',
      'permissions',
      'role_permissions',
      'identity_roles',
      'shipping_zones',
      'shipping_rates'
    ]) {
      if (!/^[a-z_]+$/.test(name)) throw new Error('unexpected_fixture_table')
      for (const row of fixture.sqlite.prepare(`SELECT * FROM "${name}"`).all()) {
        const columns = Object.keys(row),
          values = Object.values(row)
        inserts.push(
          db
            .prepare(
              `INSERT INTO "${name}"(${columns.map((value) => `"${value}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`
            )
            .bind(...values)
        )
      }
    }
    await db.batch(inserts)
    await provisionPublicationValidityFixture(db, {
      productIds: ['p-1'],
      now: '2020-01-01T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    const clock = await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') now").first<{ now: string }>()
    if (!clock) throw new Error('missing_native_clock')
    const instant = clock.now,
      cart = await createCart(db, { correlationId: 'annotations-native', now: instant })
    await setCartLine(db, {
      cartId: cart.cartId,
      token: cart.token,
      variantId: 'v-1-1',
      quantity: 1,
      expectedVersion: 1,
      idempotencyKey: 'annotations-add',
      correlationId: 'annotations-native',
      now: instant
    })
    const shipping = await requestShippingOptions(db, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      idempotencyKey: 'annotations-shipping',
      correlationId: 'annotations-native',
      now: instant,
      destination: { city: 'Ontinyent', postalCode: '46870' }
    })
    const quote = await quoteCart(db, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      idempotencyKey: 'annotations-quote',
      correlationId: 'annotations-native',
      now: instant
    })
    if (shipping.outcome !== 'options' || quote.outcome !== 'quoted') throw new Error('native_checkout_not_ready')
    const option = (shipping.body.options as Array<{ optionIndex: number; optionHash: string }>)[0]!
    const placed = await placeOrder(db, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      quoteId: quote.quote.quoteId,
      shippingQuoteId: String(shipping.body.shippingQuoteId),
      selectedOptionIndex: option.optionIndex,
      selectedOptionHash: option.optionHash,
      contactEmail: 'synthetic@example.invalid',
      shippingAddress: {
        recipientName: 'Synthetic',
        line1: 'Synthetic 1',
        city: 'Ontinyent',
        province: 'Valencia',
        postalCode: '46870',
        phone: '+34600000000',
        countryCode: 'ES'
      },
      consentTos: true,
      consentPrivacy: true,
      idempotencyKey: 'annotations-checkout',
      correlationId: 'annotations-native',
      now: instant
    })
    if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
    const orderId = String(placed.body.id)
    const key = '11111111-1111-4111-8111-111111111111',
      options = { now: () => instant },
      input = { expectedVersion: 0, note: 'Nota sintética privada', labels: ['Revisar'] }
    const receipt = await executeD1OrderAnnotations(db, CLAIMS, orderId, key, input, options)
    expect(await executeD1OrderAnnotations(db, CLAIMS, orderId, key, input, options)).toEqual(receipt)
    expect(await readD1OrderAnnotationCommand(db, CLAIMS, orderId, key, options)).toMatchObject({
      outcome: 'applied',
      receipt
    })
    expect(await readD1OrderAnnotations(db, CLAIMS, orderId, {}, options)).toMatchObject({
      version: 1,
      labels: ['Revisar'],
      notes: [{ text: input.note }]
    })
    await expect(
      executeD1OrderAnnotations(
        db,
        CLAIMS,
        orderId,
        '22222222-2222-4222-8222-222222222222',
        { expectedVersion: 0, labels: [] },
        options
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    await db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(utc(), CLAIMS.sessionId).run()
    await expect(readD1OrderAnnotationCommand(db, CLAIMS, orderId, key, options)).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  } finally {
    fixture?.sqlite.close()
    await runtime.dispose()
  }
}, 60000)
