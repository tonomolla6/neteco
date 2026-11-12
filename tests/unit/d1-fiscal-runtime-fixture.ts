import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase, d1OverSqlite, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { placeOrder, requestShippingOptions } from '../../workers/catalog/checkout'
import { approveFiscalPolicy, queueFiscalInvoice, fiscalMappingFingerprint } from '../../workers/fiscal/issuance'
import { PersistentLocalFiscalProvider } from '../../workers/fiscal/local-provider'
import type { FiscalPolicy, PrivateFiscalStorage } from '../../shared/fiscal-issuance'
import { testUuid } from '../support/deterministic'

export const FISCAL_RUNTIME_NOW = '2026-10-03T09:00:00Z'
export const fiscalRuntimeClaims = {
  identityId: '10000000-0000-4000-8000-000000000001',
  sessionId: '20000000-0000-4000-8000-000000000001',
  sessionVersion: 1
}
export const fiscalRuntimeMappings = {
  companyId: 'SYNTHETIC',
  taxes: { '0': 'ZERO', '1000': 'REDUCED', '2100': 'GENERAL' },
  paymentCode: 'CARD'
}
export async function fiscalRuntimeWorld(opened: DatabaseSync[]) {
  const sqlite = await openMigratedDatabase()
  opened.push(sqlite)
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='transactional_email_preparations'").get())
    sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0047_fiscal_runtime_email_manifest.sql', import.meta.url), 'utf8')
    )
  sqlite.limits.exprDepth = 100
  seedInventoryFixture(sqlite)
  let currentClock = FISCAL_RUNTIME_NOW
  sqlite.function('synthetic_fiscal_clock', () => currentClock)
  const raw = d1OverSqlite(sqlite)
  const database = {
    ...raw,
    prepare: (sql: string) => raw.prepare(sql.replaceAll("'now'", 'synthetic_fiscal_clock()'))
  } as D1Database
  await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: FISCAL_RUNTIME_NOW })
  sqlite.exec(`
    INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES('${fiscalRuntimeClaims.identityId}','operator@example.invalid','synthetic','${FISCAL_RUNTIME_NOW}','active','${FISCAL_RUNTIME_NOW}','${FISCAL_RUNTIME_NOW}');
    INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES('${fiscalRuntimeClaims.sessionId}','${fiscalRuntimeClaims.identityId}',1,1,'2026-10-03T08:00:00Z','2026-10-03T11:00:00Z');
    INSERT INTO roles VALUES('admin','Admin','fixture'); INSERT INTO permissions VALUES('administration.manage','administration','manage','fixture');
    INSERT INTO role_permissions VALUES('admin','administration.manage');
    INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${fiscalRuntimeClaims.identityId}','admin','2026-10-01T00:00:00Z');
    INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,created_at) VALUES('own-zone','own','Local','own_delivery','["468"]','${FISCAL_RUNTIME_NOW}');
    INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,created_at)
      VALUES('own-rate','own-zone','own_delivery','parcel',100,1000,1,2,1,'${FISCAL_RUNTIME_NOW}');
  `)
  const objects = new Map<string, Uint8Array>()
  const storage: PrivateFiscalStorage = {
    async put(key, bytes) {
      objects.set(key, Uint8Array.from(bytes))
    },
    async get(key) {
      return objects.get(key) ?? null
    }
  }
  const provider = new PersistentLocalFiscalProvider(database, await fiscalMappingFingerprint(fiscalRuntimeMappings))
  let merchantOrder = 202600000000
  async function approve(key: string, series = 'LOCAL') {
    return approveFiscalPolicy(
      database,
      fiscalRuntimeClaims,
      {
        idempotencyKey: key,
        environment: 'local_validation',
        provider: 'local_fake',
        series,
        trigger: 'after_payment_capture',
        mappings: fiscalRuntimeMappings,
        evidenceRef: 'synthetic-local-only',
        reason: 'Synthetic local-only fiscal protocol validation'
      },
      { now: FISCAL_RUNTIME_NOW }
    )
  }
  async function paid(policy: FiscalPolicy) {
    const cart = await createCart(database, { correlationId: testUuid(), now: FISCAL_RUNTIME_NOW })
    const common = {
      cartId: cart.cartId,
      token: cart.token,
      correlationId: 'synthetic-runtime',
      now: FISCAL_RUNTIME_NOW
    }
    await setCartLine(database, {
      ...common,
      expectedVersion: 1,
      idempotencyKey: 'add',
      variantId: 'v-1-1',
      quantity: 1
    })
    const shipping = await requestShippingOptions(database, {
      ...common,
      expectedVersion: 2,
      idempotencyKey: 'ship',
      destination: { city: 'Ontinyent', postalCode: '46870' }
    })
    const quote = await quoteCart(database, { ...common, expectedVersion: 2, idempotencyKey: 'quote' })
    if (shipping.outcome !== 'options' || quote.outcome !== 'quoted') throw new Error('synthetic_checkout_failed')
    const option = (shipping.body.options as Array<{ optionIndex: number; optionHash: string }>)[0]!
    const order = await placeOrder(database, {
      ...common,
      expectedVersion: quote.quote.cartVersion,
      idempotencyKey: 'order',
      quoteId: quote.quote.quoteId,
      shippingQuoteId: String(shipping.body.shippingQuoteId),
      selectedOptionIndex: option.optionIndex,
      selectedOptionHash: option.optionHash,
      consentTos: true,
      consentPrivacy: true,
      contactEmail: 'buyer@example.invalid',
      contactName: 'Synthetic <Buyer>',
      shippingAddress: {
        recipientName: 'Synthetic Buyer',
        line1: 'Synthetic Street 1',
        postalCode: '46870',
        city: 'Ontinyent',
        province: 'Valencia',
        countryCode: 'ES',
        phone: '600000000'
      }
    })
    if (order.outcome !== 'order_created') throw new Error('synthetic_order_failed')
    const orderId = String(order.body.id),
      paymentId = testUuid()
    const amount = Number(
      sqlite.prepare('SELECT total_gross_cents FROM orders WHERE id=?').get(orderId)!.total_gross_cents
    )
    sqlite
      .prepare(
        `INSERT INTO payment_intents(id,order_id,provider,merchant_order,method,status,amount_gross_cents,currency,request_hash,redirect_envelope_hash,expires_at,correlation_id,created_at,updated_at)
      VALUES(?,?,'redsys',?,'card','captured',?,'EUR',?,?,'2026-10-03T10:00:00Z','synthetic-runtime',?,?)`
      )
      .run(
        paymentId,
        orderId,
        String(++merchantOrder),
        amount,
        'a'.repeat(64),
        'a'.repeat(64),
        FISCAL_RUNTIME_NOW,
        FISCAL_RUNTIME_NOW
      )
    sqlite
      .prepare(
        "INSERT INTO order_payment_states(order_id,status,active_intent_id,paid_gross_cents,updated_at) VALUES(?,'awaiting_payment',?,0,?)"
      )
      .run(orderId, paymentId, FISCAL_RUNTIME_NOW)
    sqlite
      .prepare("UPDATE order_payment_states SET status='paid',paid_gross_cents=? WHERE order_id=?")
      .run(amount, orderId)
    const queued = await queueFiscalInvoice(database, fiscalRuntimeClaims, {
      eventId: `invoice-evaluation:${orderId}`,
      policyId: policy.id,
      idempotencyKey: testUuid(),
      now: FISCAL_RUNTIME_NOW
    })
    return { orderId, intentId: queued.intentId, amount }
  }
  const policy = await approve('policy-one')
  const order = await paid(policy)
  return {
    sqlite,
    database,
    provider,
    storage,
    objects,
    policy,
    order,
    approve,
    paid,
    setClock(now: string) {
      currentClock = now
    }
  }
}
