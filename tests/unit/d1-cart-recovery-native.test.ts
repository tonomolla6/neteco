import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { createCart, setCartLine, getCart } from '../../workers/catalog/cart'
import { updateD1AccountPreferences } from '../../workers/auth/account-preferences'
import { evaluateD1CartRecoveries, dispatchD1CartRecoveries } from '../../workers/marketing/cart-recovery'
import {
  createD1ProductWatch,
  confirmD1ProductWatch,
  evaluateD1ProductWatches,
  dispatchD1ProductWatchDeliveries,
  type ProductWatchSender
} from '../../workers/marketing/product-watch'
import { PRODUCT_WATCH_POLICY_VERSION } from '../../shared/product-watch'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import {
  CART_RECOVERY_POLICY_VERSION,
  cartRecoveryReceiptSchema,
  cartRecoveryResolvedSchema
} from '../../shared/cart-recovery'
import { preferencesFixture, CLAIMS } from './d1-account-preferences-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

// Actual canary source + D1 + CartCoordinator. Provider delivery alone is fake.
// This does not establish browser, deployment or external-delivery acceptance.
it('resumes through actual CartDO with only an HttpOnly grant, exact replay and live revocation, without economic effects', async () => {
  const fixture = await preferencesFixture()
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  const origin = 'https://cart-recovery-native.neteco.test'
  const utc = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
  let runtime: Miniflare | undefined
  try {
    seedInventoryFixture(fixture.sqlite)
    const bundled = await build({
      stdin: {
        contents: "export { default, CartCoordinator } from './workers/canary'",
        resolveDir: process.cwd(),
        sourcefile: 'cart-recovery-native-entry.ts',
        loader: 'ts'
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      external: ['node:*', 'cloudflare:*'],
      write: false,
      logLevel: 'silent'
    })
    const password = randomBytes(32).toString('hex'),
      pepper = randomBytes(32).toString('hex')
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'cart-recovery-native',
        modules: true,
        script: bundled.outputFiles[0]!.text,
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        bindings: {
          APP_ENV: 'local',
          AUTH_ENABLED: 'true',
          CART_RECOVERY_ENABLED: 'true',
          EMAIL_ENABLED: 'false',
          AUTH_ORIGIN: origin,
          NUXT_SESSION_PASSWORD: password,
          AUTH_TOKEN_PEPPER: pepper,
          AUTH_RATE_LIMIT_PEPPER: randomBytes(32).toString('hex'),
          AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64')
        },
        durableObjects: { CARTS: { className: 'CartCoordinator', useSQLite: true } },
        ratelimits: {
          CART_EDGE_LIMIT: { namespace_id: '910090', simple: { limit: 100, period: 60 } },
          AUTH_EDGE_LIMIT: { namespace_id: '920090', simple: { limit: 100, period: 60 } }
        },
        d1Databases: { DB: randomUUID() },
        outboundService: outbound
      })
    )
    const db = (await runtime.getD1Database('DB')) as unknown as D1Database
    const files = (await readdir('db/d1/migrations'))
      .filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 90)
      .sort()
    expect(files).toHaveLength(90)
    for (const file of files)
      await db.batch(splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => db.prepare(sql)))
    // Initial identity/catalog/stock only: no consent, association or recovery
    // projection is transplanted; all of those come from the actual services.
    for (const table of [
      'brands',
      'categories',
      'tax_classes',
      'shipping_profiles',
      'products',
      'variants',
      'inventory_locations',
      'inventory_balances',
      'inventory_movements',
      'customers',
      'identities',
      'auth_sessions'
    ]) {
      for (const row of fixture.sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<
        string,
        string | number | null
      >[]) {
        const columns = Object.keys(row).filter(
          (column) =>
            !(table === 'products' && column === 'catalog_version') &&
            !(table === 'categories' && column === 'category_version')
        )
        await db
          .prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
          .bind(...columns.map((column) => row[column]))
          .run()
      }
    }
    await provisionPublicationValidityFixture(db, { productIds: ['p-1'], now: utc(-60000) })
    // The actual HTTP handler owns its clock. Do not freeze an earlier test
    // instant and then mistake a later HTTP consent for a future record.
    const options = { now: () => utc(), hmacKey: new TextEncoder().encode(pepper) }
    const cart = await createCart(db, { now: utc(-7200000), correlationId: 'native-recovery' })
    expect(
      (
        await setCartLine(db, {
          ...cart,
          now: utc(-7200000),
          variantId: 'v-1-1',
          quantity: 2,
          expectedVersion: 1,
          idempotencyKey: randomUUID(),
          correlationId: 'native-recovery'
        })
      ).outcome
    ).toBe('applied')
    await updateD1AccountPreferences(
      db,
      CLAIMS,
      randomUUID(),
      {
        expectedVersion: 0,
        preferences: { product_updates: true, replenishment: false },
        policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION
      },
      options
    )
    const issued = await issueD1SessionCookie(db, CLAIMS, { password, maxAgeSeconds: 3600 })
    expect(issued).not.toBeNull()
    const sessionCookie = issued!.split(';')[0]!,
      oldCookie = `${sessionCookie}; neteco-cart-v2=v1.${cart.cartId}.${cart.token}`
    const root = '/api/account/cart-recovery'
    async function send(
      path: string,
      body?: unknown,
      method = body === undefined ? 'GET' : 'POST',
      cookie = sessionCookie,
      key = randomUUID(),
      extra: Record<string, string> = {}
    ) {
      const response = await runtime!.dispatchFetch(origin + path, {
        method,
        headers: {
          Cookie: cookie,
          Origin: origin,
          'CF-Connecting-IP': '192.0.2.90',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...extra
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      expect(response.headers.get('cache-control')).toContain('no-store')
      return {
        status: response.status,
        body: (await response.json()) as unknown,
        cookie: response.headers.get('set-cookie')
      }
    }
    expect(
      (
        await send(
          root + '/preferences',
          { expectedVersion: 0, recoveryEnabled: true, policyVersion: CART_RECOVERY_POLICY_VERSION },
          'PUT'
        )
      ).status
    ).toBe(201)
    const associated = await send(
      root + '/associations',
      { expectedCartVersion: 2, stage: 'checkout', policyVersion: CART_RECOVERY_POLICY_VERSION },
      'POST',
      oldCookie,
      randomUUID(),
      { 'X-Neteco-Cart-Id': cart.cartId }
    )
    expect(associated.status).toBe(201)
    const association = cartRecoveryReceiptSchema.parse(associated.body)
    const activity = await db
      .prepare('SELECT activity_at FROM cart_recovery_associations WHERE id=?')
      .bind(association.associationId)
      .first<{ activity_at: string }>()
    expect(Date.parse(activity!.activity_at)).toBeLessThan(Date.now() - 3600000)
    const policy = { enabled: true, waitSeconds: 3600, frequencyCapSeconds: 86400, tokenTtlSeconds: 86400 }
    expect(await evaluateD1CartRecoveries(db, { ...options, policy })).toMatchObject({ created: 1 })
    let message = ''
    expect(
      await dispatchD1CartRecoveries(
        db,
        {
          async send(sent) {
            message = sent.text
            return { messageId: 'explicit-fake-native-recovery' }
          }
        },
        { ...options, policy, origin }
      )
    ).toMatchObject({ sent: 1 })
    const token = message.match(/cr1\.[a-f0-9]{64}/)?.[0]
    expect(token).toBeDefined()
    const protectedTables = [
      'cart_lines',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'orders',
      'payment_intents',
      'fiscal_invoice_intents'
    ]
    const snapshot = () =>
      Promise.all(
        protectedTables.map(async (table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results)
      )
    const before = await snapshot(),
      input = { id: association.associationId!, token: token!, expectedCartVersion: 2 },
      command = randomUUID()
    const resolved = await send(root + '/resolve', { id: input.id, token: input.token })
    expect(resolved.status).toBe(200)
    expect(cartRecoveryResolvedSchema.parse(resolved.body)).toMatchObject({
      stage: 'checkout',
      cartVersion: 2,
      lines: [{ variantId: 11, quantity: 2, grossCents: 1000 }]
    })
    const resumed = await send(root + '/resume', input, 'POST', sessionCookie, command)
    expect(resumed.status).toBe(201)
    const receipt = cartRecoveryReceiptSchema.parse(resumed.body)
    expect(receipt).toMatchObject({
      commandId: command,
      cartVersion: 3,
      inventoryEffect: 'none',
      economicEffect: 'none'
    })
    expect(resumed.cookie).toMatch(/HttpOnly; Secure; SameSite=Lax/)
    const newCookie = resumed.cookie!.split(';')[0]!,
      possession = newCookie.match(/=v1\.([a-f0-9-]+)\.([A-Za-z0-9_-]{43})$/)!
    expect(possession).not.toBeNull()
    expect(possession[1]).toBe(cart.cartId)
    expect(possession[2]).not.toBe(cart.token)
    expect(JSON.stringify(resumed.body)).not.toContain(possession[2]!)
    await expect(getCart(db, cart)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(await getCart(db, { cartId: cart.cartId, token: possession[2]! })).toMatchObject({
      version: 3,
      expiresAt: cart.expiresAt,
      lines: [{ variantId: 'v-1-1', quantity: 2 }]
    })
    const current = await send('/api/cart', undefined, 'GET', `${sessionCookie}; ${newCookie}`)
    expect(current.status).toBe(200)
    expect(current.body).toMatchObject({ id: cart.cartId, version: 3, items: [{ variantId: 11, qty: 2 }] })
    const replay = await send(root + '/resume', input, 'POST', sessionCookie, command)
    expect(replay.body).toEqual(receipt)
    expect(replay.cookie!.split(';')[0]).toBe(newCookie)
    const recovered = await send(root + '/commands/' + command, undefined, 'GET', sessionCookie, randomUUID(), {
      'X-Neteco-Command-Payload-Hash': receipt.payloadHash
    })
    expect(recovered.status).toBe(200)
    expect(recovered.body).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(recovered.cookie!.split(';')[0]).toBe(newCookie)
    expect(await snapshot()).toEqual(before)
    for (const table of ['carts', 'cart_commands', 'cart_recovery_commands', 'cart_recovery_deliveries']) {
      const stored = JSON.stringify((await db.prepare(`SELECT * FROM ${table}`).all()).results)
      expect(stored).not.toContain(possession[2]!)
      expect(stored).not.toContain(token!)
    }
    // Exercise the genuinely confirmed marketing signal, not just the simpler
    // confirmation predicate, against D1's real expression-depth limit. This
    // internal test clock is beyond the immutable recovery cooldown; no public
    // request can choose it. Prices/publication are synthetic fixture writes.
    const watchInstant = utc(86401000)
    const watchOptions = { ...options, now: () => watchInstant }
    const watchMessages: Parameters<ProductWatchSender['send']>[0][] = []
    const watchSender: ProductWatchSender = {
      async send(sent) {
        watchMessages.push(sent)
        return { messageId: 'explicit-fake-native-watch-' + watchMessages.length }
      }
    }
    const watch = await createD1ProductWatch(
      db,
      CLAIMS,
      {
        variantId: 11,
        kind: 'price_drop',
        consent: true,
        policyVersion: PRODUCT_WATCH_POLICY_VERSION
      },
      randomUUID(),
      watchOptions
    )
    expect(await dispatchD1ProductWatchDeliveries(db, watchSender, { ...watchOptions, origin })).toMatchObject({
      sent: 1
    })
    const confirmation = watchMessages[0]!.text.match(/pw1\.[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0]
    expect(confirmation).toBeDefined()
    await confirmD1ProductWatch(
      db,
      CLAIMS,
      watch.watchId,
      {
        expectedVersion: 1,
        token: confirmation!
      },
      randomUUID(),
      watchOptions
    )
    await db
      .prepare(
        `INSERT INTO variant_price_versions(id,variant_id,gross_cents,volume_tiers,valid_from,status,reason,created_at)
      VALUES(?,'v-1-1',400,'[]',?,'approved','Synthetic native price-drop control',?)`
      )
      .bind(randomUUID(), watchInstant, watchInstant)
      .run()
    // Canonical catalog publication also serves ordinary real-clock reads;
    // do not create a future-only approval merely to advance marketing time.
    await provisionPublicationValidityFixture(db, { productIds: ['p-1'], now: utc(-60000) })
    expect(await evaluateD1ProductWatches(db, watchOptions)).toMatchObject({ created: 1 })
    expect(await dispatchD1ProductWatchDeliveries(db, watchSender, { ...watchOptions, origin })).toEqual({
      sent: 1,
      skipped: 0,
      manualReview: 0
    })
    expect(watchMessages).toHaveLength(2)
    expect(await db.prepare("SELECT status FROM product_watch_deliveries WHERE kind='price_drop'").first()).toEqual({
      status: 'sent'
    })
    expect(await snapshot()).toEqual(before)
    await db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(utc(), CLAIMS.sessionId).run()
    const denied = await send(root + '/resume', input, 'POST', sessionCookie, command)
    expect(denied.status).toBe(401)
    expect(denied.cookie).toBeNull()
    expect(
      (
        await send(root + '/commands/' + command, undefined, 'GET', sessionCookie, randomUUID(), {
          'X-Neteco-Command-Payload-Hash': receipt.payloadHash
        })
      ).status
    ).toBe(401)
    expect(await snapshot()).toEqual(before)
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    fixture.sqlite.close()
    await runtime?.dispose()
  }
}, 60000)
