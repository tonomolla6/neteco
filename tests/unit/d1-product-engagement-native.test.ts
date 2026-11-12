import { randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { buildNativeCanary as build } from '../support/native-canary-build'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { dispatchD1ProductWatchDeliveries, type ProductWatchSender } from '../../workers/marketing/product-watch'
import {
  PRODUCT_WATCH_POLICY_VERSION,
  productWatchReceiptSchema,
  productWatchDetailSchema,
  productWatchCommandSchema,
  productWatchIntentHash
} from '../../shared/product-watch'
import {
  productContributionReceiptSchema,
  productContributionSnapshotSchema,
  publicProductContributionListSchema,
  productContributionIntentHash
} from '../../shared/product-contributions'
import { testUuid } from '../support/deterministic'

it('runs variant double opt-in and moderated unverified review through canary source on real workerd D1 without domain effects or outbound', async () => {
  const origin = 'https://product-engagement-native.neteco.test',
    password = randomBytes(32).toString('hex'),
    pepper = randomBytes(32).toString('hex')
  const outbound = vi.fn(() => {
    throw Error('unexpected_outbound')
  })
  // Source acceptance, not the separately built shop artifact or a browser.
  // All code bytes remain in memory; only disposable Miniflare persistence is used.
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: 'product-engagement-native-entry.ts',
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
      name: 'product-engagement-native',
      ...bundle.nativeSource,
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      bindings: {
        APP_ENV: 'local',
        AUTH_ENABLED: 'true',
        PRODUCT_WATCH_ENABLED: 'true',
        PRODUCT_CONTRIBUTIONS_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: password,
        AUTH_TOKEN_PEPPER: pepper,
        AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        AUTH_RATE_LIMIT_PEPPER: randomBytes(32).toString('hex')
      },
      ratelimits: {
        AUTH_EDGE_LIMIT: { namespace_id: '908881', simple: { limit: 100, period: 60 } },
        CART_EDGE_LIMIT: { namespace_id: '908882', simple: { limit: 100, period: 60 } },
        ADMIN_EDGE_LIMIT: { namespace_id: '908883', simple: { limit: 100, period: 60 } }
      },
      d1Databases: { DB: testUuid() },
      outboundService: outbound
    })
  )
  try {
    const db = (await runtime.getD1Database('DB')) as unknown as D1Database
    const files = (await readdir('db/d1/migrations'))
      .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 88)
      .sort()
    expect(files.map((file) => Number(file.slice(0, 4)))).toEqual(Array.from({ length: 88 }, (_, index) => index + 1))
    for (const file of files)
      await db.batch(splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => db.prepare(sql)))
    const seed: D1PreparedStatement[] = []
    seedInventoryFixture({
      exec(sql: string) {
        seed.push(...splitDemoSql(sql).map((text) => db.prepare(text)))
      },
      prepare(sql: string) {
        return {
          run(...args: unknown[]) {
            seed.push(db.prepare(sql).bind(...args))
          }
        }
      }
    } as unknown as DatabaseSync)
    await db.batch(seed)
    const now = (await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') now").first<{ now: string }>())!.now
    await provisionPublicationValidityFixture(db, { productIds: ['p-1'], now })
    const buyer = { identityId: testUuid(), sessionId: testUuid(), sessionVersion: 1 },
      admin = { identityId: testUuid(), sessionId: testUuid(), sessionVersion: 1 }
    await db.batch([
      db.prepare("INSERT INTO roles VALUES('engagement-moderator','Synthetic moderator','Local native acceptance')"),
      db.prepare("INSERT OR IGNORE INTO permissions VALUES('support.manage','support','manage','Synthetic')"),
      db.prepare("INSERT INTO role_permissions VALUES('engagement-moderator','support.manage')")
    ])
    for (const [claims, email] of [
      [buyer, 'engagement-buyer@example.invalid'],
      [admin, 'engagement-moderator@example.invalid']
    ] as const) {
      const customerId = testUuid()
      await db.batch([
        db
          .prepare("INSERT INTO customers(id,status,created_at,updated_at) VALUES(?,'active',?,?)")
          .bind(customerId, now, now),
        db
          .prepare(
            "INSERT INTO identities(id,email,password_hash,status,email_verified_at,customer_id,created_at,updated_at) VALUES(?,?,'synthetic','active',?,?,?,?)"
          )
          .bind(claims.identityId, email, now, customerId, now, now),
        db
          .prepare(
            "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,?, ?,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+1 hour'))"
          )
          .bind(claims.sessionId, claims.identityId, claims === admin ? 1 : 0, now, now)
      ])
    }
    await db.batch([
      db
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'engagement-moderator',?)")
        .bind(admin.identityId, now),
      db
        .prepare(
          "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-native-enrolled-factor','[]',?,?)"
        )
        .bind(admin.identityId, now, now)
    ])
    const config = { password, maxAgeSeconds: 3600 }
    const buyerCookie = (await issueD1SessionCookie(db, buyer, config))!.split(';')[0]!,
      adminCookie = (await issueD1SessionCookie(db, admin, config))!.split(';')[0]!
    const critical = [
      'orders',
      'order_lines',
      'payment_intents',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'inventory_reservation_lines',
      'variant_price_versions',
      'customer_account_preferences',
      'newsletter_subscriptions'
    ]
    const snapshot = async () =>
      JSON.stringify(
        (await db.batch(critical.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`)))).map(
          (result) => result.results
        )
      )
    const before = await snapshot()
    const call = (path: string, cookie = buyerCookie, body?: unknown, key = testUuid(), hash?: string) =>
      runtime.dispatchFetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'CF-Connecting-IP': '192.0.2.188',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    const watchInput = {
        variantId: 11,
        kind: 'price_drop',
        consent: true,
        policyVersion: PRODUCT_WATCH_POLICY_VERSION
      },
      createKey = testUuid()
    const created = await call('/api/account/product-watches', buyerCookie, watchInput, createKey)
    expect(created.status).toBe(201)
    const createdReceipt = productWatchReceiptSchema.parse(await created.json())
    expect(createdReceipt).toMatchObject({
      action: 'create',
      version: 1,
      status: 'pending',
      commandId: createKey,
      payloadHash: await productWatchIntentHash('create', null, watchInput)
    })
    expect(JSON.stringify(createdReceipt)).not.toMatch(/token|pw1\.|recipient|@/)
    const detail = await call('/api/account/product-watches/' + createdReceipt.watchId)
    expect(detail.status).toBe(200)
    expect(productWatchDetailSchema.parse(await detail.json()).item).toMatchObject({
      id: createdReceipt.watchId,
      status: 'pending',
      version: 1,
      suppressedByPreferences: true
    })
    expect(detail.headers.get('cache-control')).toBe('private, no-store')
    expect(detail.headers.has('set-cookie')).toBe(false)
    const messages: Parameters<ProductWatchSender['send']>[0][] = []
    const fakeSender: ProductWatchSender = {
      async send(message) {
        messages.push(message)
        return { messageId: 'explicit-fake-native-confirmation-1' }
      }
    }
    // Only an explicitly supplied delivery double can obtain this credential.
    // No token is read directly from D1 or returned by the HTTP create command.
    expect(
      await dispatchD1ProductWatchDeliveries(db, fakeSender, { origin, hmacKey: new TextEncoder().encode(pepper) })
    ).toEqual({ sent: 1, skipped: 0, manualReview: 0 })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.to).toBe('engagement-buyer@example.invalid')
    const confirmationToken = messages[0]!.text.match(/pw1\.[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0]
    expect(confirmationToken).toBeDefined()
    const confirmation = await call(`/api/account/product-watches/${createdReceipt.watchId}/confirm`, buyerCookie, {
      expectedVersion: 1,
      token: confirmationToken
    })
    expect(confirmation.status).toBe(201)
    expect(productWatchReceiptSchema.parse(await confirmation.json())).toMatchObject({
      action: 'confirm',
      status: 'confirmed',
      version: 2
    })
    const cancelBody = { expectedVersion: 2 },
      cancelKey = testUuid(),
      cancelPath = `/api/account/product-watches/${createdReceipt.watchId}/cancel`
    const cancelled = await call(cancelPath, buyerCookie, cancelBody, cancelKey)
    expect(cancelled.status).toBe(201)
    const cancelReceipt = productWatchReceiptSchema.parse(await cancelled.json())
    expect(cancelReceipt).toMatchObject({ action: 'cancel', status: 'cancelled', version: 3 })
    expect(await (await call(cancelPath, buyerCookie, cancelBody, cancelKey)).json()).toEqual(cancelReceipt)
    const recovery = await call(
      `/api/account/product-watches/commands/${cancelKey}`,
      buyerCookie,
      undefined,
      testUuid(),
      cancelReceipt.payloadHash
    )
    expect(recovery.status).toBe(200)
    expect(productWatchCommandSchema.parse(await recovery.json())).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt: cancelReceipt
    })
    expect((await call('/api/account/product-watches/' + createdReceipt.watchId, adminCookie)).status).toBe(404)
    const reviewBody = {
      kind: 'review',
      productId: 1,
      score: 4,
      title: 'Uso sintético revisado',
      body: 'Reseña sintética moderada sin datos personales ni promesas.',
      privacyAcknowledged: true
    }
    const submitted = await call('/api/account/product-contributions', buyerCookie, reviewBody)
    expect(submitted.status).toBe(201)
    const submittedReceipt = productContributionReceiptSchema.parse(await submitted.json())
    expect(submittedReceipt.payloadHash).toBe(await productContributionIntentHash('submit', null, reviewBody))
    const ownReview = await call('/api/account/product-contributions/' + submittedReceipt.contributionId)
    expect(ownReview.status).toBe(200)
    expect(productContributionSnapshotSchema.parse(await ownReview.json())).toMatchObject({
      origin: 'unverified',
      state: 'pending',
      version: 1
    })
    expect(
      publicProductContributionListSchema.parse(await (await call('/api/products/1/contributions', '')).json()).items
    ).toEqual([])
    const publishBody = {
      action: 'publish',
      expectedVersion: 1,
      reason: 'Moderación sintética revisada explícitamente',
      reviewReference: 'synthetic-native-review',
      slaDueAt: null
    }
    const publishPath = `/api/admin/product-contributions/${submittedReceipt.contributionId}/commands`
    // A session flag alone is not sufficient: the persisted factor is checked.
    await db.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').bind(admin.sessionId).run()
    expect((await call(publishPath, adminCookie, publishBody)).status).toBe(403)
    await db.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').bind(admin.sessionId).run()
    const published = await call(publishPath, adminCookie, publishBody)
    expect(published.status).toBe(201)
    expect(productContributionReceiptSchema.parse(await published.json())).toMatchObject({
      action: 'publish',
      version: 2,
      inventoryEffect: 'none',
      economicEffect: 'none',
      senderInvoked: false
    })
    const publicResponse = await call('/api/products/1/contributions', '')
    expect(publicResponse.status).toBe(200)
    const publicBody = publicProductContributionListSchema.parse(await publicResponse.json())
    expect(publicBody.items).toHaveLength(1)
    expect(publicBody.items[0]).toMatchObject({ origin: 'unverified', score: 4, body: reviewBody.body })
    const publicJson = JSON.stringify(publicBody)
    for (const forbidden of [
      buyer.identityId,
      buyer.sessionId,
      admin.identityId,
      admin.sessionId,
      '@',
      'customerId',
      'sessionId',
      'reason',
      'reviewReference',
      'recipient',
      'token',
      'costNet'
    ])
      expect(publicJson).not.toContain(forbidden)
    await db
      .prepare("DELETE FROM identity_roles WHERE identity_id=? AND role_code='engagement-moderator'")
      .bind(admin.identityId)
      .run()
    const countBefore = await db.prepare('SELECT count(*) n FROM product_contribution_commands').first()
    expect(
      (
        await call(publishPath, adminCookie, {
          action: 'withdraw',
          expectedVersion: 2,
          reason: 'Intento sintético tras revocar el permiso'
        })
      ).status
    ).toBe(403)
    expect(await db.prepare('SELECT count(*) n FROM product_contribution_commands').first()).toEqual(countBefore)
    expect(await snapshot()).toBe(before)
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
}, 120000)
