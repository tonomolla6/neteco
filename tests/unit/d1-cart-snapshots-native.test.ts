import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { createCart, setCartLine } from '../../workers/catalog/cart'
import {
  cartSnapshotResponseSchema,
  cartSnapshotIntentHash,
  sharedCartResolveResponseSchema
} from '../../shared/cart-snapshots'

it('creates, recovers, publicly reads and revokes a snapshot through actual canary/workerd D1 without cart or stock writes', async () => {
  const origin = 'https://cart-snapshots-native.neteco.test',
    password = randomBytes(32).toString('hex')
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: 'cart-snapshots-native-entry.ts',
      loader: 'ts',
      contents: "export { default } from './workers/canary'"
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    external: ['node:*', 'cloudflare:*'],
    write: false,
    logLevel: 'silent'
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'cart-snapshots-native',
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      bindings: {
        APP_ENV: 'local',
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: password,
        AUTH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
        AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        AUTH_RATE_LIMIT_PEPPER: randomBytes(32).toString('hex')
      },
      ratelimits: {
        AUTH_EDGE_LIMIT: { namespace_id: '900751', simple: { limit: 100, period: 60 } },
        CART_EDGE_LIMIT: { namespace_id: '900752', simple: { limit: 100, period: 60 } }
      },
      d1Databases: { DB: '00000000-0000-4000-8000-000000000075' },
      outboundService: outbound
    })
  )
  try {
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    const files = (await readdir('db/d1/migrations'))
      .filter((file) => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) <= 75)
      .sort()
    for (const file of files)
      await database.batch(
        splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => database.prepare(sql))
      )
    const seed: D1PreparedStatement[] = []
    seedInventoryFixture({
      exec(sql: string) {
        seed.push(...splitDemoSql(sql).map((text) => database.prepare(text)))
      },
      prepare(sql: string) {
        return {
          run(...args: unknown[]) {
            seed.push(database.prepare(sql).bind(...args))
          }
        }
      }
    } as unknown as DatabaseSync)
    await database.batch(seed)
    const now = (await database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now").first<{ now: string }>())!
      .now
    await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now })
    const identityId = randomUUID(),
      sessionId = randomUUID(),
      customerId = randomUUID()
    await database.batch([
      database
        .prepare("INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,'Synthetic snapshot owner',?,?)")
        .bind(customerId, now, now),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,'snapshot-native@example.invalid','synthetic',?,'active',?,?,?)"
        )
        .bind(identityId, now, customerId, now, now),
      database
        .prepare(
          "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,0,?,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+1 hour'))"
        )
        .bind(sessionId, identityId, now, now)
    ])
    const sessionCookie = (await issueD1SessionCookie(
      database,
      { identityId, sessionId, sessionVersion: 1 },
      { password, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!
    const cart = await createCart(database, { now, correlationId: 'native-snapshot-fixture' })
    await setCartLine(database, {
      ...cart,
      variantId: 'v-1-1',
      quantity: 2,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      now,
      correlationId: 'native-snapshot-fixture'
    })
    const cookie = `${sessionCookie}; neteco-cart-v2=v1.${cart.cartId}.${cart.token}`
    const call = (path: string, method: string, value?: unknown, Cookie = cookie, key = randomUUID(), hash?: string) =>
      runtime.dispatchFetch(origin + path, {
        method,
        headers: {
          Origin: origin,
          Cookie,
          'X-Neteco-Cart-Id': cart.cartId,
          'CF-Connecting-IP': '192.0.2.189',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) })
      })
    const state = async () =>
      Promise.all(
        [
          'carts',
          'cart_lines',
          'orders',
          'checkout_quotes',
          'shipping_quotes',
          'inventory_balances',
          'inventory_movements'
        ].map(async (table) => [table, (await database.prepare('SELECT * FROM ' + table).all()).results])
      )
    const before = await state(),
      key = randomUUID(),
      input = { name: 'Native saved cart', expectedCartVersion: 2, createShare: true }
    const created = await call('/api/account/cart-snapshots', 'POST', input, cookie, key)
    expect(created.status).toBe(201)
    const result = cartSnapshotResponseSchema.parse(await created.json())
    expect(files).toHaveLength(75)
    expect(result.share).not.toBeNull()
    expect(result.share!.token).not.toBe(cart.token)
    const recovered = await call(
      '/api/account/cart-snapshots/commands/' + key,
      'GET',
      undefined,
      cookie,
      randomUUID(),
      await cartSnapshotIntentHash(input)
    )
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({
      action: 'create',
      outcome: 'applied',
      receipt: result.receipt,
      share: result.share
    })
    const shared = await call(
      '/api/cart/shared/resolve',
      'POST',
      { id: result.share!.id, token: result.share!.token },
      ''
    )
    expect(shared.status).toBe(200)
    const publicView = sharedCartResolveResponseSchema.parse(await shared.json())
    expect(publicView.items).toEqual([
      expect.objectContaining({ variantId: 'v-1-1', quantity: 2, unitGrossCents: 500 })
    ])
    expect(JSON.stringify(publicView)).not.toMatch(
      /snapshot-native@example|Native saved cart|customerId|costNet|coupon/
    )
    expect((await call('/api/account/cart-snapshots', 'GET', undefined, '')).status).toBe(401)
    const revoked = await call(`/api/account/cart-snapshots/${result.share!.id}/revoke`, 'POST', {}, sessionCookie)
    expect(revoked.status).toBe(200)
    expect(
      (await call('/api/cart/shared/resolve', 'POST', { id: result.share!.id, token: result.share!.token }, '')).status
    ).toBe(404)
    expect(await state()).toEqual(before)
    expect((await database.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
})
