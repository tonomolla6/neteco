import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  AlternativeMarketPaymentProvider,
  alternativeProviderFromEnv
} from '../../workers/payments/alternative-contingency-provider'
import { handlePaymentContingencyHttp } from '../../workers/payments/contingency-routing-http'
import { ALL_WORKER_SECRETS } from '../../scripts/provision-worker-secrets'

// SECFIX-3 findings 1 + 8: forged contingency payment webhooks.
const now = '2026-10-31T09:00:00Z'
const orderId = '55555555-5555-4555-8555-555555555555'
const configuredSecret = 'Zq3v9Kx2Lr8Tn4Wp6Ys1Ud7Hb5Jc0Mf2Ag9Ek3Qw'
const formerHardcodedSecret = 'contingency-secret-key-123456789012'

const provider = (secretKey = configuredSecret) =>
  new AlternativeMarketPaymentProvider({
    secretKey,
    merchantId: 'merchant-alt-01',
    endpointUrl: 'https://contingency.payments.example/pay'
  })

async function signed(payload: Record<string, string>, secretKey = configuredSecret) {
  return { ...payload, signature: await provider(secretKey).signPayload(payload) }
}

const base = {
  provider_event_id: 'evt-sec-1',
  provider_reference: 'ref-sec-1',
  order_reference: orderId,
  amount_cents: '10000',
  currency: 'EUR'
}

describe('SECFIX-3 alternative provider status mapping (finding 1)', () => {
  it('does not capture a cancelled notification that omits response_code', async () => {
    const notification = await provider().verifyNotification(await signed({ ...base, status: 'cancelled' }))
    expect(notification.status).toBe('cancelled')
  })

  it('does not capture a "captured" status without an explicit success response_code', async () => {
    const notification = await provider().verifyNotification(await signed({ ...base, status: 'captured' }))
    expect(notification.status).not.toBe('captured')
  })

  it('does not capture a cancelled/failed/declined status even when response_code is 0000', async () => {
    for (const status of ['cancelled', 'failed', 'declined']) {
      const notification = await provider().verifyNotification(
        await signed({ ...base, provider_event_id: `evt-${status}`, status, response_code: '0000' })
      )
      expect(notification.status, status).not.toBe('captured')
    }
  })

  it('does not capture a captured status with a non-success response_code', async () => {
    const notification = await provider().verifyNotification(
      await signed({ ...base, status: 'captured', response_code: '0190' })
    )
    expect(notification.status).not.toBe('captured')
  })

  it('captures only an explicit captured status with success code 0000', async () => {
    const notification = await provider().verifyNotification(
      await signed({ ...base, status: 'captured', response_code: '0000' })
    )
    expect(notification.status).toBe('captured')
  })

  it('rejects notifications in a currency other than EUR instead of relabelling them', async () => {
    await expect(
      provider().verifyNotification(
        await signed({ ...base, currency: 'USD', status: 'captured', response_code: '0000' })
      )
    ).rejects.toThrow('invalid_currency')
  })

  it('rejects notifications without stable provider identifiers (no random replay keys)', async () => {
    const { provider_event_id: _event, ...withoutEvent } = base
    await expect(
      provider().verifyNotification(await signed({ ...withoutEvent, status: 'captured', response_code: '0000' }))
    ).rejects.toThrow('invalid_provider_event')
    const { provider_reference: _reference, ...withoutReference } = base
    await expect(
      provider().verifyNotification(await signed({ ...withoutReference, status: 'captured', response_code: '0000' }))
    ).rejects.toThrow('invalid_provider_reference')
  })
})

describe('SECFIX-3 alternative provider configuration from env (finding 8)', () => {
  const env = {
    PAYMENT_CONTINGENCY_ENABLED: 'true',
    PAYMENT_CONTINGENCY_SECRET_KEY: configuredSecret,
    PAYMENT_CONTINGENCY_MERCHANT_ID: 'merchant-alt-01',
    PAYMENT_CONTINGENCY_ENDPOINT_URL: 'https://contingency.payments.example/pay'
  }

  it('returns a provider only when enabled with a strong secret, merchant id and https endpoint', async () => {
    const configured = alternativeProviderFromEnv(env)
    expect(configured).toBeInstanceOf(AlternativeMarketPaymentProvider)
    const payload = await signed({ ...base, status: 'captured', response_code: '0000' })
    await expect(configured!.verifyNotification(payload)).resolves.toMatchObject({ status: 'captured' })
  })

  it.each([
    ['flag absent', { ...env, PAYMENT_CONTINGENCY_ENABLED: undefined }],
    ['flag false', { ...env, PAYMENT_CONTINGENCY_ENABLED: 'false' }],
    ['secret absent', { ...env, PAYMENT_CONTINGENCY_SECRET_KEY: undefined }],
    ['secret too short', { ...env, PAYMENT_CONTINGENCY_SECRET_KEY: 's'.repeat(31) }],
    ['former hardcoded secret', { ...env, PAYMENT_CONTINGENCY_SECRET_KEY: formerHardcodedSecret }],
    ['local-only secret', { ...env, PAYMENT_CONTINGENCY_SECRET_KEY: `local-only-${'x'.repeat(40)}` }],
    ['merchant absent', { ...env, PAYMENT_CONTINGENCY_MERCHANT_ID: undefined }],
    ['endpoint not https', { ...env, PAYMENT_CONTINGENCY_ENDPOINT_URL: 'http://contingency.payments.example/pay' }],
    ['endpoint .invalid', { ...env, PAYMENT_CONTINGENCY_ENDPOINT_URL: 'https://contingency.payments.invalid/pay' }],
    ['endpoint malformed', { ...env, PAYMENT_CONTINGENCY_ENDPOINT_URL: 'not a url' }]
  ])('returns null (fail closed) when %s', (_label, candidate) => {
    expect(alternativeProviderFromEnv(candidate)).toBeNull()
  })
})

describe('SECFIX-3 contingency webhook fails closed without a configured provider (finding 8)', () => {
  let sqlite: DatabaseSync
  let database: D1Database

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.exec(await readFile('db/d1/migrations/0145_orders_procurement_split_contingency.sql', 'utf8'))
    database = d1OverSqlite(sqlite)
    const t = '2026-10-31T08:00:00Z'
    const d = 'dm-sec-contingency'
    const h = 'a'.repeat(64)
    sqlite.exec(`
      INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES('cust-sec-1','C',NULL,'active','${t}','${t}');
      INSERT INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at)
        VALUES('${d}','${h}','active',1,'2030-01-01T00:00:00Z','c','${t}','${t}');
      INSERT INTO checkout_quotes(id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents, shipping_pending, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at)
        VALUES('${d}','${d}',1,'${t}','EUR',0,1,10000,0,10000,'${h}','c','${t}');
      INSERT INTO shipping_quotes(id, cart_id, cart_version, destination_hash, options_json, option_count, snapshot_hash, expires_at, correlation_id, created_at)
        VALUES('${d}','${d}',1,'${h}','[]',0,'${h}','2030-01-01T00:00:00Z','c','${t}');
      INSERT INTO checkout_attempts(id, cart_id, command_key, state, correlation_id, payload_hash, created_at, updated_at)
        VALUES('${d}','${d}','key-sec','failed','c','${h}','${t}','${t}');
      INSERT INTO orders(id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy, correlation_id, created_at, updated_at, customer_id)
        VALUES('${orderId}','${d}','${d}','${d}','${d}','${h}','awaiting_payment','res-1','2030-01-01T00:00:00Z','EUR',10000,0,10000,0,0,0,'parcel',1,1,3,'c@example.invalid','${h}',1,1,'c','${t}','${t}','cust-sec-1');
    `)
  })

  afterEach(() => sqlite.close())

  const webhook = (payload: Record<string, string>) =>
    new Request('https://shop.invalid/api/payments/alternative/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })

  it('answers 503 and records nothing for a payload forged with the former hardcoded secret', async () => {
    const forged = await signed({ ...base, status: 'captured', response_code: '0000' }, formerHardcodedSecret)
    const response = await handlePaymentContingencyHttp(webhook(forged), { database, now })
    expect(response?.status).toBe(503)
    expect(await response!.json()).toEqual({ error: { code: 'service_unavailable' } })
    const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM payment_unified_settlement_reconciliation').get() as {
      n: number
    }
    expect(rows.n).toBe(0)
  })

  it('records a cancelled notification without response_code as a discrepancy, never settled', async () => {
    const payload = await signed({ ...base, status: 'cancelled' })
    const response = await handlePaymentContingencyHttp(webhook(payload), {
      database,
      alternativeProvider: provider(),
      now
    })
    expect(response?.status).toBe(200)
    expect(((await response!.json()) as { status: string }).status).toBe('discrepancy')
  })
})

describe('SECFIX-3 contingency secret governance', () => {
  it('lists the provider secret in the provisioning allowlist and the secrets inventory', async () => {
    expect(ALL_WORKER_SECRETS).toContain('PAYMENT_CONTINGENCY_SECRET_KEY')
    const inventory = await readFile('docs/operations/worker-secrets.md', 'utf8')
    for (const name of [
      'PAYMENT_CONTINGENCY_SECRET_KEY',
      'PAYMENT_CONTINGENCY_ENABLED',
      'PAYMENT_CONTINGENCY_MERCHANT_ID',
      'PAYMENT_CONTINGENCY_ENDPOINT_URL'
    ]) {
      expect(inventory).toContain(`\`${name}\``)
    }
  })
})
