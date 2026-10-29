import { expect, it } from 'vitest'
import { deterministicTestData } from '../fixtures/deterministic'
import { createCompiledShopFixture } from '../support/compiled-shop-fixture'
import { runCompiledBrowserProof } from '../support/compiled-browser-proof'
import { createCompiledRecoveryBrowserCallbacks } from '../support/compiled-cart-recovery-browser-fixture'
import { auditNativeCartRecoveryBrowser } from '../../scripts/lib/audit-native-cart-recovery-browser'
import { preferencesFixture, CLAIMS } from '../unit/d1-account-preferences-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { updateD1AccountPreferences } from '../../workers/auth/account-preferences'
import { createCart, setCartLine, getCart } from '../../workers/catalog/cart'
import { evaluateD1CartRecoveries, dispatchD1CartRecoveries } from '../../workers/marketing/cart-recovery'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import {
  CART_RECOVERY_POLICY_VERSION,
  cartRecoveryReceiptSchema,
  cartRecoveryResolvedSchema
} from '../../shared/cart-recovery'

// Compiled current shop bytes + real workerd SSR/D1/CartDO, not a browser or
// provider-delivery claim. Only the explicit internal sender captures a token.
it('serves safe compiled recovery SSR and resumes through actual CartDO with exact replay and live revocation', async () => {
  const data = deterministicTestData('compiled-cart-recovery')
  const password = data.token('session-password'),
    pepper = data.token('token-pepper')
  const fixture = await createCompiledShopFixture({
    CART_RECOVERY_ENABLED: 'true',
    NUXT_SESSION_PASSWORD: password,
    AUTH_TOKEN_PEPPER: pepper,
    EMAIL_ENABLED: 'false'
  })
  let initial: Awaited<ReturnType<typeof preferencesFixture>> | undefined
  const db = fixture.database,
    root = '/api/account/cart-recovery'
  try {
    let utc = await fixture.readServerClock()
    initial = await preferencesFixture()
    seedInventoryFixture(initial.sqlite)
    // Initial catalog/stock/identity only. Consent, association, delivery,
    // capability and resume facts are produced by their canonical services.
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
      for (const row of initial.sqlite.prepare(`SELECT * FROM ${table}`).all()) {
        const entries = Object.entries(row).filter(
          ([column]) =>
            !(table === 'products' && column === 'catalog_version') &&
            !(table === 'categories' && column === 'category_version')
        )
        await db
          .prepare(
            `INSERT INTO ${table}(${entries.map(([column]) => column).join(',')}) VALUES(${entries.map(() => '?').join(',')})`
          )
          .bind(...entries.map(([, value]) => value))
          .run()
      }
    }
    await provisionPublicationValidityFixture(db, { productIds: ['p-1'], now: utc(-60_000) })
    const options = { now: () => utc(), hmacKey: new TextEncoder().encode(pepper) }
    const cart = await createCart(db, { now: utc(-7_200_000), correlationId: 'compiled-recovery' })
    expect(
      await setCartLine(db, {
        ...cart,
        now: utc(-7_200_000),
        variantId: 'v-1-1',
        quantity: 2,
        expectedVersion: 1,
        idempotencyKey: data.uuid('set-cart-line'),
        correlationId: 'compiled-recovery'
      })
    ).toMatchObject({ outcome: 'applied' })
    await updateD1AccountPreferences(
      db,
      CLAIMS,
      data.uuid('account-preferences'),
      {
        expectedVersion: 0,
        preferences: { product_updates: true, replenishment: false },
        policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION
      },
      options
    )
    const issued = await issueD1SessionCookie(db, CLAIMS, { password, maxAgeSeconds: 3600 })
    expect(issued).not.toBeNull()
    const cookie = issued!.split(';')[0]!
    async function send(
      path: string,
      body?: unknown,
      method = body === undefined ? 'GET' : 'POST',
      selectedCookie = cookie,
      key = data.uuid('http-command'),
      extra: Record<string, string> = {}
    ) {
      return fixture.dispatch(
        new Request(fixture.origin + path, {
          method,
          headers: {
            Cookie: selectedCookie,
            Origin: fixture.origin,
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '192.0.2.90',
            'Idempotency-Key': key,
            ...extra
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        })
      )
    }
    for (const selectedCookie of [cookie, '']) {
      const response = await fixture.dispatch(
        new Request(fixture.origin + '/cuenta/recuperar-carrito', {
          headers: {
            ...(selectedCookie ? { cookie: selectedCookie } : {}),
            accept: 'text/html',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
            'sec-fetch-site': 'none'
          }
        })
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      const html = await response.text()
      expect(html).toContain('Recuperar carrito')
      expect(html).toContain('no crea un pedido ni confirma un pago')
      expect(html).not.toContain(cart.token)
      expect(html).not.toMatch(/cr1\.[a-f0-9]{64}/)
      expect(response.headers.get('location')).toBeNull()
      if (!selectedCookie) {
        expect(html).toContain('/login?redirect=%2Fcuenta%2Frecuperar-carrito')
        expect(html).toContain('No se conserva el secreto durante el acceso')
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
      `${cookie}; neteco-cart-v2=v1.${cart.cartId}.${cart.token}`,
      data.uuid('associate'),
      { 'X-Neteco-Cart-Id': cart.cartId }
    )
    expect(associated.status).toBe(201)
    const association = cartRecoveryReceiptSchema.parse(await associated.json())
    // Re-anchor explicitly after the HTTP-owned consent/association clocks.
    // The returned clock is fixed; no local elapsed-time clock is introduced.
    utc = await fixture.readServerClock()
    const policy = { enabled: true, waitSeconds: 3600, frequencyCapSeconds: 86400, tokenTtlSeconds: 86400 }
    expect(await evaluateD1CartRecoveries(db, { ...options, policy })).toMatchObject({ created: 1 })
    let message = ''
    expect(
      await dispatchD1CartRecoveries(
        db,
        {
          async send(sent) {
            message = sent.text
            return { messageId: 'explicit-fake-compiled-recovery' }
          }
        },
        { ...options, policy, origin: fixture.origin }
      )
    ).toMatchObject({ sent: 1 })
    const token = message.match(/cr1\.[a-f0-9]{64}/)?.[0]
    expect(token).toBeDefined()
    const tables = [
      'cart_lines',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'orders',
      'payment_intents',
      'fiscal_invoice_intents'
    ]
    const economicSnapshot = async () =>
      Promise.all(tables.map(async (table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results))
    const before = await economicSnapshot(),
      input = { id: association.associationId!, token: token!, expectedCartVersion: 2 }
    const resolved = await send(root + '/resolve', { id: input.id, token: input.token })
    expect(resolved.status).toBe(200)
    expect(cartRecoveryResolvedSchema.parse(await resolved.json())).toMatchObject({
      stage: 'checkout',
      cartVersion: 2,
      lines: [{ variantId: 11, quantity: 2, grossCents: 1000 }]
    })
    const key = data.uuid('resume'),
      resumed = await send(root + '/resume', input, 'POST', cookie, key)
    expect(resumed.status).toBe(201)
    expect(resumed.headers.get('cache-control')).toContain('no-store')
    const bytes = await resumed.text(),
      receipt = cartRecoveryReceiptSchema.parse(JSON.parse(bytes))
    expect(receipt).toMatchObject({ commandId: key, cartVersion: 3, inventoryEffect: 'none', economicEffect: 'none' })
    const grant = resumed.headers.get('set-cookie')
    expect(grant).toMatch(/HttpOnly; Secure; SameSite=Lax/)
    const newCookie = grant!.split(';')[0]!,
      possession = newCookie.match(/=v1\.([a-f0-9-]+)\.([A-Za-z0-9_-]{43})$/)
    expect(possession).not.toBeNull()
    expect(possession![1]).toBe(cart.cartId)
    expect(possession![2]).not.toBe(cart.token)
    expect(bytes).not.toContain(possession![2]!)
    await expect(getCart(db, cart)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(await getCart(db, { cartId: cart.cartId, token: possession![2]! })).toMatchObject({
      version: 3,
      expiresAt: cart.expiresAt
    })
    const replay = await send(root + '/resume', input, 'POST', cookie, key)
    expect(replay.status).toBe(201)
    expect(await replay.text()).toBe(bytes)
    expect(replay.headers.get('set-cookie')!.split(';')[0]).toBe(newCookie)
    const recovered = await send(root + '/commands/' + key, undefined, 'GET', cookie, data.uuid('lookup'), {
      'X-Neteco-Command-Payload-Hash': receipt.payloadHash
    })
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(recovered.headers.get('set-cookie')!.split(';')[0]).toBe(newCookie)
    expect(await economicSnapshot()).toEqual(before)
    for (const table of ['carts', 'cart_commands', 'cart_recovery_commands', 'cart_recovery_deliveries']) {
      const stored = JSON.stringify((await db.prepare(`SELECT * FROM ${table}`).all()).results)
      expect(stored).not.toContain(token!)
      expect(stored).not.toContain(possession![2]!)
    }
    await db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(utc(), CLAIMS.sessionId).run()
    for (const path of [root + '/resume', root + '/commands/' + key]) {
      const response = path.endsWith('/resume')
        ? await send(path, input, 'POST', cookie, key)
        : await send(path, undefined, 'GET', cookie, data.uuid('revoked-lookup'), {
            'X-Neteco-Command-Payload-Hash': receipt.payloadHash
          })
      expect(response.status).toBe(401)
      expect(response.headers.get('set-cookie')).toBeNull()
    }
    expect(await economicSnapshot()).toEqual(before)
    expect(fixture.outbound.requests).toBe(0)
    await runCompiledBrowserProof(async (browser) => {
      const result = await auditNativeCartRecoveryBrowser({
        browser,
        origin: fixture.origin,
        dispatch: (request) => fixture.dispatch(request),
        ...createCompiledRecoveryBrowserCallbacks(fixture)
      })
      expect(result).toMatchObject({ scenarios: 2, browserExecuted: true, providerSubmission: false })
    })
  } finally {
    try {
      initial?.sqlite.close()
    } finally {
      await fixture.dispose()
    }
  }
}, 120_000)
