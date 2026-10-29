import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { createCompiledShopFixture } from './compiled-shop-fixture'
import type {
  NativeCartRecoveryBrowserInput,
  CartRecoveryBrowserFixture
} from '../../scripts/lib/audit-native-cart-recovery-browser'
import { deterministicTestData } from '../fixtures/deterministic'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { updateD1AccountPreferences } from '../../workers/auth/account-preferences'
import { createCart, setCartLine } from '../../workers/catalog/cart'
import { evaluateD1CartRecoveries, dispatchD1CartRecoveries } from '../../workers/marketing/cart-recovery'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import {
  CART_RECOVERY_POLICY_VERSION,
  cartRecoveryReceiptSchema,
  cartRecoveryIntentHash
} from '../../shared/cart-recovery'

type Fixture = Awaited<ReturnType<typeof createCompiledShopFixture>>
type Callbacks = Pick<
  NativeCartRecoveryBrowserInput,
  'prepare' | 'readCommittedResume' | 'revokeCapability' | 'assertEconomicUnchanged'
>

/** Uses an existing compiled runtime/catalog only; no migration, provider or
 * synthetic economic authority is installed by this adapter. */
export function createCompiledRecoveryBrowserCallbacks(fixture: Fixture): Callbacks {
  const db = fixture.database
  const data = deterministicTestData('compiled-recovery-browser')
  const root = '/api/account/cart-recovery'
  const policy = { enabled: true, waitSeconds: 3600, frequencyCapSeconds: 86400, tokenTtlSeconds: 86400 }
  const owners = new Map<
    string,
    { identityId: string; customerId: string; cartId: string; originalTokenHash: string }
  >()
  let economicBefore: string | undefined
  const economicTables = [
    'cart_lines',
    'inventory_balances',
    'inventory_movements',
    'inventory_reservations',
    'inventory_reservation_lines',
    'orders',
    'order_lines',
    'payment_intents',
    'payment_events',
    'fiscal_invoice_intents'
  ]
  async function economicSnapshot() {
    return JSON.stringify(
      await Promise.all(
        economicTables.map(async (table) => {
          const result = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
          assert(result.success, 'compiled_recovery_economic_read_failed')
          return result.results
        })
      )
    )
  }
  async function send(
    cookie: string,
    path: string,
    body: unknown,
    method = 'POST',
    extra: Record<string, string> = {}
  ) {
    return fixture.dispatch(
      new Request(fixture.origin + path, {
        method,
        headers: {
          cookie,
          origin: fixture.origin,
          'content-type': 'application/json',
          'cf-connecting-ip': '192.0.2.91',
          'idempotency-key': data.uuid('command'),
          ...extra
        },
        body: JSON.stringify(body)
      })
    )
  }
  return {
    async prepare(viewport) {
      let utc = await fixture.readServerClock()
      const customerId = data.uuid(viewport + '-customer')
      const identityId = data.uuid(viewport + '-identity')
      const sessionId = data.uuid(viewport + '-session')
      const email = data.email(viewport)
      await db.batch([
        db
          .prepare(
            "INSERT INTO customers(id,name,status,created_at,updated_at) VALUES(?,'Synthetic browser recovery customer','active',?,?)"
          )
          .bind(customerId, utc(-60000), utc(-60000)),
        db
          .prepare(
            "INSERT INTO identities(id,email,password_hash,status,email_verified_at,customer_id,created_at,updated_at) VALUES(?,?,'synthetic-unusable','active',?,?,?,?)"
          )
          .bind(identityId, email, utc(-60000), customerId, utc(-60000), utc(-60000)),
        db
          .prepare(
            'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,0,?,?)'
          )
          .bind(sessionId, identityId, utc(-60000), utc(3600000))
      ])
      const claims = { identityId, sessionId, sessionVersion: 1 }
      const options = { now: () => utc(), hmacKey: new TextEncoder().encode(fixture.tokenPepper) }
      const issued = await issueD1SessionCookie(db, claims, fixture.sessionCookieConfiguration)
      assert(issued, 'compiled_recovery_cookie_not_issued')
      const customerCookie = issued.split(';')[0]!
      const cart = await createCart(db, { now: utc(-7200000), correlationId: 'compiled-recovery-browser-' + viewport })
      const added = await setCartLine(db, {
        ...cart,
        now: utc(-7200000),
        variantId: 'v-1-1',
        quantity: 2,
        expectedVersion: 1,
        idempotencyKey: data.uuid('line'),
        correlationId: 'compiled-recovery-browser-' + viewport
      })
      assert.equal(added.outcome, 'applied')
      await updateD1AccountPreferences(
        db,
        claims,
        data.uuid('account-consent'),
        {
          expectedVersion: 0,
          preferences: { product_updates: true, replenishment: false },
          policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION
        },
        options
      )
      const consent = await send(
        customerCookie,
        root + '/preferences',
        {
          expectedVersion: 0,
          recoveryEnabled: true,
          policyVersion: CART_RECOVERY_POLICY_VERSION
        },
        'PUT'
      )
      assert.equal(consent.status, 201)
      const consentReceipt = cartRecoveryReceiptSchema.parse(await consent.json())
      assert.equal(consentReceipt.action, 'preferences')
      assert.equal(consentReceipt.version, 1)
      const associated = await send(
        `${customerCookie}; neteco-cart-v2=v1.${cart.cartId}.${cart.token}`,
        root + '/associations',
        { expectedCartVersion: 2, stage: 'checkout', policyVersion: CART_RECOVERY_POLICY_VERSION },
        'POST',
        { 'X-Neteco-Cart-Id': cart.cartId }
      )
      assert.equal(associated.status, 201)
      const association = cartRecoveryReceiptSchema.parse(await associated.json())
      assert.equal(association.action, 'associate')
      assert(association.associationId, 'compiled_recovery_association_missing')
      assert.equal(association.cartVersion, 2)
      // Explicitly re-anchor after the compiled HTTP consent/association.
      utc = await fixture.readServerClock()
      assert.equal((await evaluateD1CartRecoveries(db, { ...options, policy })).created, 1)
      let token: string | undefined
      const delivered = await dispatchD1CartRecoveries(
        db,
        {
          async send(message) {
            assert(message.to === email, 'compiled_recovery_internal_recipient_mismatch')
            token = message.text.match(/cr1\.[a-f0-9]{64}/)?.[0]
            return { messageId: 'explicit-fake-compiled-recovery-browser-' + viewport }
          }
        },
        { ...options, policy, origin: fixture.origin }
      )
      assert.equal(delivered.sent, 1)
      assert(token, 'compiled_recovery_internal_capability_missing')
      const cartRow = await db
        .prepare('SELECT token_hash FROM carts WHERE id=?')
        .bind(cart.cartId)
        .first<{ token_hash: string }>()
      assert(cartRow, 'compiled_recovery_cart_missing')
      owners.set(association.associationId, {
        identityId,
        customerId,
        cartId: cart.cartId,
        originalTokenHash: cartRow.token_hash
      })
      economicBefore = await economicSnapshot()
      return {
        customerCookie,
        capability: { id: association.associationId, token },
        cartId: cart.cartId,
        cartVersion: 2
      }
    },
    async readCommittedResume({ body, receipt }) {
      const owner = owners.get(body.id)
      assert(owner, 'compiled_recovery_unprepared_association')
      assert.equal(receipt.action, 'resume')
      assert.equal(receipt.associationId, body.id)
      assert.equal(receipt.cartVersion, body.expectedCartVersion + 1)
      assert.equal(receipt.version, body.expectedCartVersion + 1)
      assert.equal(receipt.payloadHash, await cartRecoveryIntentHash('resume', body))
      const association = await db
        .prepare('SELECT customer_id,cart_id,cart_version FROM cart_recovery_associations WHERE id=?')
        .bind(body.id)
        .first<{ customer_id: string; cart_id: string; cart_version: number }>()
      assert(association, 'compiled_recovery_original_association_missing')
      assert.equal(association.customer_id, owner.customerId)
      assert.equal(association.cart_id, owner.cartId)
      assert.equal(association.cart_version, body.expectedCartVersion)
      const command = await db
        .prepare(
          `SELECT action,association_id,cart_id,expected_version,applied_version,
        payload_hash,input_json,receipt_json,grant_hash FROM cart_recovery_commands
        WHERE actor_id=? AND customer_id=? AND command_id=?`
        )
        .bind(owner.identityId, owner.customerId, receipt.commandId)
        .first<{
          action: string
          association_id: string
          cart_id: string
          expected_version: number
          applied_version: number
          payload_hash: string
          input_json: string
          receipt_json: string
          grant_hash: string
        }>()
      assert(command, 'compiled_recovery_resume_not_durable')
      assert.equal(command.action, 'resume')
      assert.equal(command.association_id, body.id)
      assert.equal(command.cart_id, owner.cartId)
      assert.equal(command.expected_version, body.expectedCartVersion)
      assert.equal(command.applied_version, receipt.version)
      assert.equal(command.payload_hash, receipt.payloadHash)
      assert.deepEqual(JSON.parse(command.receipt_json), receipt)
      assert.deepEqual(JSON.parse(command.input_json), {
        id: body.id,
        tokenHash: createHash('sha256').update(body.token).digest('hex'),
        expectedCartVersion: body.expectedCartVersion
      })
      assert(
        !command.input_json.includes(body.token) && !command.receipt_json.includes(body.token),
        'compiled_recovery_secret_persisted'
      )
      const cart = await db
        .prepare('SELECT version,token_hash FROM carts WHERE id=?')
        .bind(owner.cartId)
        .first<{ version: number; token_hash: string }>()
      assert(cart, 'compiled_recovery_rotated_cart_missing')
      assert.equal(cart.version, receipt.cartVersion)
      assert.equal(cart.token_hash, command.grant_hash)
      assert.notEqual(cart.token_hash, owner.originalTokenHash)
    },
    async revokeCapability(prepared: CartRecoveryBrowserFixture) {
      assert(owners.has(prepared.capability.id), 'compiled_recovery_unprepared_revocation')
      const response = await send(
        prepared.customerCookie,
        root + '/preferences',
        {
          expectedVersion: 1,
          recoveryEnabled: false,
          policyVersion: CART_RECOVERY_POLICY_VERSION
        },
        'PUT'
      )
      assert.equal(response.status, 201)
      const receipt = cartRecoveryReceiptSchema.parse(await response.json())
      assert.equal(receipt.action, 'preferences')
      assert.equal(receipt.version, 2)
      assert.equal(receipt.recoveryEnabled, false)
    },
    async assertEconomicUnchanged() {
      assert(economicBefore !== undefined, 'compiled_recovery_economic_snapshot_not_prepared')
      assert.equal(await economicSnapshot(), economicBefore)
      assert.equal(fixture.outbound.requests, 0)
    }
  }
}
