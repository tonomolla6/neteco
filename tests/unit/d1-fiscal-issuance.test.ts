import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openMigratedDatabase, d1OverSqlite, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { placeOrder, requestShippingOptions } from '../../workers/catalog/checkout'
import {
  approveFiscalPolicy,
  queueFiscalInvoice,
  dispatchFiscalIssuance,
  reconcileFiscalInvoice,
  withdrawFiscalPolicy,
  fiscalMappingFingerprint
} from '../../workers/fiscal/issuance'
import { PersistentLocalFiscalProvider, localFiscalBlobBytes } from '../../workers/fiscal/local-provider'
import type { PrivateFiscalStorage, OrdinaryFiscalProvider } from '../../shared/fiscal-issuance'
import { handleD1FiscalRequest, ownsFiscalNamespace } from '../../workers/fiscal/http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { WorkerBeplyInvoiceProvider } from '../../workers/fiscal/beply-provider'
import { fiscalBatchEvidence } from '../../workers/fiscal/d1-boundary'

const NOW = '2026-10-03T09:00:00Z',
  IDENTITY = '10000000-0000-4000-8000-000000000001',
  SESSION = '20000000-0000-4000-8000-000000000001'
const claims = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const mappings = {
  companyId: 'SYNTHETIC',
  taxes: { '0': 'ZERO', '1000': 'REDUCED', '2100': 'GENERAL' },
  paymentCode: 'CARD'
}
const policyInput = {
  idempotencyKey: 'approve-one',
  environment: 'local_validation',
  provider: 'local_fake',
  series: 'LOCAL',
  trigger: 'after_payment_capture',
  mappings,
  evidenceRef: 'synthetic-approved-policy:1',
  reason: 'Synthetic local fiscal protocol validation only'
}
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function world(options: { queue?: boolean; owner?: boolean } = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  const sqlite = await openMigratedDatabase()
  databases.push(sqlite)
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='fiscal_invoice_intents'").get())
    sqlite.exec(await readFile(new URL('../../db/d1/migrations/0042_fiscal_issuance.sql', import.meta.url), 'utf8'))
  sqlite.limits.exprDepth = 100
  seedInventoryFixture(sqlite)
  sqlite.function('synthetic_fiscal_clock', () => new Date(Date.now()).toISOString().replace('.000Z', 'Z'))
  const native = d1OverSqlite(sqlite),
    prepare = native.prepare.bind(native)
  const database = {
    ...native,
    prepare(sql: string) {
      return prepare(sql.replaceAll("'now'", 'synthetic_fiscal_clock()'))
    }
  } as D1Database
  await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: NOW })
  sqlite.exec(`
    INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES('${IDENTITY}','operator@example.invalid','synthetic-password','${NOW}','active','${NOW}','${NOW}');
    INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES('${SESSION}','${IDENTITY}',1,1,'2026-10-03T08:00:00Z','2026-10-03T11:00:00Z');
    INSERT INTO roles VALUES('admin','Admin','fixture');
    INSERT INTO permissions VALUES('administration.manage','administration','manage','fixture');
    INSERT INTO role_permissions VALUES('admin','administration.manage');
    INSERT INTO identity_roles(identity_id,role_code,granted_at)VALUES('${IDENTITY}','admin','2026-10-01T00:00:00Z');
    INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,created_at)
      VALUES('own-zone','own','Local','own_delivery','["468"]','${NOW}');
    INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,created_at)
      VALUES('own-rate','own-zone','own_delivery','parcel',100,1000,1,2,1,'${NOW}');
  `)
  if (options.owner) {
    sqlite.exec(`INSERT INTO customers(id,name,created_at,updated_at)VALUES('30000000-0000-4000-8000-000000000001','Synthetic Buyer','${NOW}','${NOW}');
    UPDATE identities SET customer_id='30000000-0000-4000-8000-000000000001' WHERE id='${IDENTITY}'`)
  }
  const cart = await createCart(database, { correlationId: 'synthetic-fiscal', now: NOW })
  const common = { cartId: cart.cartId, token: cart.token, correlationId: 'synthetic-fiscal', now: NOW }
  await setCartLine(database, { ...common, expectedVersion: 1, idempotencyKey: 'add', variantId: 'v-1-1', quantity: 1 })
  const shipping = await requestShippingOptions(database, {
    ...common,
    expectedVersion: 2,
    idempotencyKey: 'ship',
    destination: { city: 'Ontinyent', postalCode: '46870' }
  })
  const quote = await quoteCart(database, { ...common, expectedVersion: 2, idempotencyKey: 'quote' })
  if (shipping.outcome !== 'options' || quote.outcome !== 'quoted') throw Error('Synthetic checkout fixture failed')
  const option = (shipping.body.options as Array<{ optionIndex: number; optionHash: string }>)[0]!
  const order = await placeOrder(database, {
    ...common,
    expectedVersion: quote.quote.cartVersion,
    idempotencyKey: 'checkout',
    quoteId: quote.quote.quoteId,
    shippingQuoteId: String(shipping.body.shippingQuoteId),
    selectedOptionIndex: option.optionIndex,
    selectedOptionHash: option.optionHash,
    consentTos: true,
    consentPrivacy: true,
    contactEmail: 'buyer@example.invalid',
    contactName: 'Synthetic Buyer',
    ...(options.owner ? { ownerSession: claims } : {}),
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
  if (order.outcome !== 'order_created') throw Error('Synthetic order fixture failed')
  const orderId = String(order.body.id),
    intentId = crypto.randomUUID(),
    hash = 'a'.repeat(64)
  const amount = Number(
    sqlite.prepare('SELECT total_gross_cents FROM orders WHERE id=?').get(orderId)!.total_gross_cents
  )
  sqlite
    .prepare(
      `INSERT INTO payment_intents(id,order_id,provider,merchant_order,method,status,amount_gross_cents,currency,request_hash,
    redirect_envelope_hash,expires_at,correlation_id,created_at,updated_at)
    VALUES(?,?,'redsys','202600000001','card','captured',?,'EUR',?,?,'2026-10-03T10:00:00Z','synthetic-fiscal',?,?)`
    )
    .run(intentId, orderId, amount, hash, hash, NOW, NOW)
  sqlite
    .prepare(
      `INSERT INTO order_payment_states(order_id,status,active_intent_id,paid_gross_cents,updated_at)
    VALUES(?,'awaiting_payment',?,0,?)`
    )
    .run(orderId, intentId, NOW)
  sqlite
    .prepare("UPDATE order_payment_states SET status='paid',paid_gross_cents=? WHERE order_id=?")
    .run(amount, orderId)
  const eventId = `invoice-evaluation:${orderId}`
  const policy = await approveFiscalPolicy(database, claims, policyInput, { now: NOW })
  const objects = new Map<string, Uint8Array>()
  const storage: PrivateFiscalStorage = {
    async put(key, bytes) {
      objects.set(key, Uint8Array.from(bytes))
    },
    async get(key) {
      return objects.get(key) ?? null
    }
  }
  const provider = new PersistentLocalFiscalProvider(database, await fiscalMappingFingerprint(mappings))
  const queued =
    options.queue === false
      ? null
      : await queueFiscalInvoice(database, claims, {
          eventId,
          policyId: policy.id,
          idempotencyKey: 'queue-one',
          now: NOW
        })
  return {
    sqlite,
    database,
    orderId,
    orderToken: String(order.body.orderToken),
    eventId,
    policy,
    storage,
    objects,
    provider,
    queued,
    amount
  }
}
function facts(sqlite: DatabaseSync) {
  return sqlite
    .prepare(
      `SELECT
  (SELECT count(*)FROM fiscal_invoice_intents)AS intents,(SELECT count(*)FROM fiscal_documents)AS documents,
  (SELECT count(*)FROM fiscal_fake_invoices)AS accepted,(SELECT count(*)FROM fiscal_provider_receipts)AS receipts,
  (SELECT count(*)FROM order_events WHERE event_type='invoice.issued')AS events,
  (SELECT count(*)FROM email_outbox_events WHERE event_type='invoice.issued')AS email`
    )
    .get()
}
function work(sqlite: DatabaseSync) {
  return sqlite.prepare('SELECT * FROM fiscal_issuance_work').get()!
}
async function dispatch(
  w: Awaited<ReturnType<typeof world>>,
  provider: OrdinaryFiscalProvider = w.provider,
  extra: Record<string, unknown> = {}
) {
  return dispatchFiscalIssuance(w.database, provider, w.storage, {
    now: NOW,
    appEnvironment: 'local',
    allowProviderIssuance: true,
    ...extra
  })
}
async function reconcile(
  w: Awaited<ReturnType<typeof world>>,
  provider: OrdinaryFiscalProvider = w.provider,
  key = 'reconcile-one'
) {
  return reconcileFiscalInvoice(
    w.database,
    claims,
    w.queued!.intentId,
    {
      expectedGeneration: Number(work(w.sqlite).generation),
      idempotencyKey: key,
      reason: 'Synthetic recovery with authoritative persisted provider evidence',
      evidenceRef: 'synthetic-evidence:1'
    },
    provider,
    w.storage,
    { now: NOW, appEnvironment: 'local' }
  )
}

describe('D1 ordinary fiscal issuance protocol — no real-provider acceptance claim', () => {
  it('keeps captured evaluation blocked without governed policy/intent and opt-in', async () => {
    const w = await world({ queue: false })
    expect(w.sqlite.prepare('SELECT status FROM fiscal_evaluation_inbox').get()).toBeUndefined()
    expect(w.sqlite.prepare('SELECT status FROM fiscal_outbox_delivery').get()).toEqual({ status: 'blocked_policy' })
    expect(
      await dispatchFiscalIssuance(w.database, w.provider, w.storage, { now: NOW, appEnvironment: 'local' })
    ).toMatchObject({ disabled: true, completed: 0 })
    expect(facts(w.sqlite)).toEqual({ intents: 0, documents: 0, accepted: 0, receipts: 0, events: 0, email: 0 })
  })
  it('issues once from immutable historic money/shipping snapshots and commits the email obligation atomically', async () => {
    const w = await world()
    w.sqlite.exec(
      'UPDATE shipping_rates SET net_cents=9999,tax_rate_basis_points=2100; UPDATE variants SET price_gross_cents=90000'
    )
    expect(await dispatch(w)).toMatchObject({ completed: 1, uncertain: 0 })
    const contract = JSON.parse(
      String(w.sqlite.prepare('SELECT contract_json FROM fiscal_invoice_intents').get()!.contract_json)
    )
    expect(contract.shippingTaxRateBasisPoints).toBe(1000)
    expect(contract.shippingTaxCents).toBe(10)
    expect(contract.totalGrossCents).toBe(w.amount)
    expect(contract.validationOnly).toBe(true)
    expect(facts(w.sqlite)).toEqual({ intents: 1, documents: 1, accepted: 1, receipts: 1, events: 1, email: 1 })
    expect(await dispatch(w)).toMatchObject({ completed: 0 })
    expect(w.objects.size).toBe(1)
  })
  it('deduplicates concurrent workers before the external side effect', async () => {
    const w = await world()
    const result = await Promise.all([dispatch(w), dispatch(w), dispatch(w)])
    expect(result.reduce((sum, r) => sum + r.completed, 0)).toBe(1)
    expect(facts(w.sqlite)).toEqual({ intents: 1, documents: 1, accepted: 1, receipts: 1, events: 1, email: 1 })
  })
  it('persistently deduplicates policies and queue commands and rejects drift', async () => {
    const w = await world()
    expect(await approveFiscalPolicy(w.database, claims, policyInput, { now: NOW })).toEqual(w.policy)
    await expect(
      approveFiscalPolicy(w.database, claims, { ...policyInput, series: 'OTHER' }, { now: NOW })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(
      await queueFiscalInvoice(w.database, claims, {
        eventId: w.eventId,
        policyId: w.policy.id,
        idempotencyKey: 'queue-one',
        now: NOW
      })
    ).toEqual({ ...w.queued, replayed: true })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_issuance_policies').get()!.n).toBe(1)
  })
  it.each(['local_validation', 'preview', 'production'])(
    'refuses local fake outside appEnvironment=local (%s)',
    async (appEnvironment) => {
      const w = await world()
      expect(await dispatch(w, w.provider, { appEnvironment })).toMatchObject({ completed: 0, blocked: 1 })
      expect(facts(w.sqlite).accepted).toBe(0)
    }
  )
  it('rejects policy withdrawal and provider mapping drift before provider call', async () => {
    const w = await world()
    await withdrawFiscalPolicy(w.database, claims, w.policy.id, 'Synthetic policy withdrawn before issuing', {
      now: NOW,
      idempotencyKey: 'withdraw-one'
    })
    expect(await dispatch(w)).toMatchObject({ completed: 0, blocked: 1 })
    expect(facts(w.sqlite).accepted).toBe(0)
  })
  it('refuses mapping drift before marking issuing', async () => {
    const w = await world()
    const wrong = new PersistentLocalFiscalProvider(w.database, 'f'.repeat(64))
    expect(await dispatch(w, wrong)).toMatchObject({ blocked: 1 })
    expect(facts(w.sqlite).accepted).toBe(0)
  })
  it('quarantines a lost accepted response, never blindly reissues, then reconciles authoritative evidence', async () => {
    const w = await world()
    w.provider.failures.issue = 'accepted_response_lost'
    expect(await dispatch(w)).toMatchObject({ uncertain: 1, completed: 0 })
    expect(work(w.sqlite).status).toBe('uncertain')
    expect(facts(w.sqlite).accepted).toBe(1)
    const restarted = new PersistentLocalFiscalProvider(w.database, await fiscalMappingFingerprint(mappings))
    expect(await dispatch(w, restarted)).toMatchObject({ completed: 0, uncertain: 0 })
    expect(await reconcile(w, restarted)).toEqual({ outcome: 'completed', replayed: false })
    expect(facts(w.sqlite)).toEqual({ intents: 1, documents: 1, accepted: 1, receipts: 1, events: 1, email: 1 })
  })
  it('does not treat a duplicate/conflict exception as evidence of an invoice', async () => {
    const w = await world()
    w.provider.failures.issue = 'duplicate'
    expect(await dispatch(w)).toMatchObject({ uncertain: 1 })
    expect(await reconcile(w)).toMatchObject({ outcome: 'blocked' })
    expect(facts(w.sqlite).documents).toBe(0)
    expect(facts(w.sqlite).accepted).toBe(0)
  })
  it('keeps uncertainty without a lookup capability and never calls issue again', async () => {
    const w = await world()
    w.provider.failures.issue = 'accepted_response_lost'
    await dispatch(w)
    const noLookup: OrdinaryFiscalProvider = {
      name: w.provider.name,
      environment: w.provider.environment,
      mappingFingerprint: w.provider.mappingFingerprint,
      issueInvoice: vi.fn().mockRejectedValue(Error('must not issue')),
      downloadPdf: w.provider.downloadPdf.bind(w.provider)
    }
    expect(await reconcile(w, noLookup)).toMatchObject({ outcome: 'blocked' })
    expect(noLookup.issueInvoice).not.toHaveBeenCalled()
  })
  it.each(['wrong_amount', 'invalid_receipt'])(
    'quarantines invalid receipt %s and creates no document',
    async (mode) => {
      const w = await world()
      w.provider.failures.issue = mode as 'wrong_amount' | 'invalid_receipt'
      expect(await dispatch(w)).toMatchObject({ uncertain: 1 })
      expect(facts(w.sqlite).documents).toBe(0)
    }
  )
  it.each(['invalid', 'too_large', 'lost'])(
    'quarantines PDF %s without reissuing, and recovers from stored receipt',
    async (mode) => {
      const w = await world()
      w.provider.failures.pdf = mode as 'invalid' | 'too_large' | 'lost'
      expect(await dispatch(w)).toMatchObject({ uncertain: 1 })
      expect(facts(w.sqlite).receipts).toBe(1)
      expect(facts(w.sqlite).documents).toBe(0)
      w.provider.failures.pdf = undefined
      expect(await reconcile(w)).toMatchObject({ outcome: 'completed' })
      expect(facts(w.sqlite).accepted).toBe(1)
    }
  )
  it('makes completion plus event and email obligation rollback as one batch', async () => {
    const w = await world()
    w.sqlite.exec(
      "CREATE TRIGGER synthetic_fail_invoice_email BEFORE INSERT ON email_outbox_events WHEN NEW.event_type='invoice.issued' BEGIN SELECT RAISE(ABORT,'synthetic failure');END"
    )
    expect(await dispatch(w)).toMatchObject({ uncertain: 1 })
    expect(facts(w.sqlite)).toEqual({ intents: 1, documents: 0, accepted: 1, receipts: 1, events: 0, email: 0 })
    w.sqlite.exec('DROP TRIGGER synthetic_fail_invoice_email')
    expect(await reconcile(w)).toMatchObject({ outcome: 'completed' })
    expect(facts(w.sqlite).accepted).toBe(1)
  })
  it('does not reissue an expired issuing marker (crash before or after provider invocation)', async () => {
    const w = await world()
    w.sqlite.exec(
      "UPDATE fiscal_issuance_work SET status='issuing',issuing_at='2026-10-03T08:00:00Z',lease_token='abandoned',lease_until='2026-10-03T08:15:00Z'"
    )
    expect(await dispatch(w)).toMatchObject({ uncertain: 1, completed: 0 })
    expect(facts(w.sqlite).accepted).toBe(0)
  })
  it('reclaims only pre-issuing expired leases', async () => {
    const w = await world()
    w.sqlite.exec(
      "UPDATE fiscal_issuance_work SET status='leased',lease_token='abandoned',lease_until='2026-10-03T08:15:00Z'"
    )
    expect(await dispatch(w)).toMatchObject({ completed: 1 })
    expect(facts(w.sqlite).accepted).toBe(1)
  })
  it('requires current email/MFA/role/session authorization for privileged evidence recovery', async () => {
    const w = await world()
    w.provider.failures.issue = 'accepted_response_lost'
    await dispatch(w)
    w.sqlite.exec(`UPDATE auth_sessions SET mfa_verified=0 WHERE id='${SESSION}'`)
    await expect(reconcile(w)).rejects.toMatchObject({ code: 'mfa_required' })
    expect(facts(w.sqlite).documents).toBe(0)
  })
  it('rechecks revocation after lookup await and leaves receipt/document unavailable', async () => {
    const w = await world()
    w.provider.failures.issue = 'accepted_response_lost'
    await dispatch(w)
    const original = w.provider.lookupByExternalKey.bind(w.provider)
    vi.spyOn(w.provider, 'lookupByExternalKey').mockImplementation(async (...args) => {
      const result = await original(...args)
      w.sqlite.exec(`UPDATE auth_sessions SET revoked_at='${NOW}' WHERE id='${SESSION}'`)
      return result
    })
    await expect(reconcile(w)).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(facts(w.sqlite).receipts).toBe(0)
    expect(facts(w.sqlite).documents).toBe(0)
  })
  it('fences a late issuer so a replaced lease cannot store receipt or complete', async () => {
    const w = await world(),
      original = w.provider.issueInvoice.bind(w.provider)
    vi.spyOn(w.provider, 'issueInvoice').mockImplementation(async (request) => {
      const result = await original(request)
      w.sqlite.exec(
        "UPDATE fiscal_issuance_work SET status='uncertain',generation=generation+1,lease_token=NULL,lease_until=NULL,last_error_code='synthetic_replacement'"
      )
      return result
    })
    expect(await dispatch(w)).toMatchObject({ uncertain: 1 })
    expect(facts(w.sqlite).documents).toBe(0)
    expect(facts(w.sqlite).receipts).toBe(0)
  })
  it('physically rejects editing or deleting emitted documents, contracts, receipts and fiscal events', async () => {
    const w = await world()
    await dispatch(w)
    for (const table of [
      'fiscal_invoice_intents',
      'fiscal_provider_receipts',
      'fiscal_documents',
      'fiscal_issuance_events',
      'fiscal_fake_invoices'
    ]) {
      expect(() => w.sqlite.exec(`DELETE FROM ${table}`)).toThrow(/immutable/)
    }
    expect(() =>
      w.sqlite.exec(
        "UPDATE fiscal_documents SET pdf_checksum='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'"
      )
    ).toThrow(/immutable/)
  })
})

const COOKIE = { password: 'synthetic-fiscal-cookie-password-at-least-32', maxAgeSeconds: 3600 }
async function http(
  w: Awaited<ReturnType<typeof world>>,
  path: string,
  options: {
    method?: string
    body?: unknown
    headers?: Record<string, string>
    appEnvironment?: 'local' | 'preview' | 'production'
    guest?: boolean
    anonymous?: boolean
    storage?: PrivateFiscalStorage
    database?: D1Database
  } = {}
) {
  const cookie = options.anonymous
    ? ''
    : options.guest
      ? `neteco-order-access-v2=v1.${w.orderId}.${w.orderToken}`
      : (await issueD1SessionCookie(w.database, claims, COOKIE))!.split(';')[0]!
  const headers = {
    cookie,
    ...(options.method === 'POST' ? { origin: 'https://neteco.invalid', 'content-type': 'application/json' } : {}),
    ...options.headers
  }
  return (await handleD1FiscalRequest(
    new Request(`https://neteco.invalid${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined
        ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }
        : {})
    }),
    {
      database: options.database ?? w.database,
      sessionCookieConfiguration: COOKIE,
      origin: 'https://neteco.invalid',
      appEnvironment: options.appEnvironment ?? 'local',
      now: () => new Date(Date.now()).toISOString().replace('.000Z', 'Z'),
      storage: options.storage ?? w.storage,
      providerResolver: () => w.provider
    }
  ))!
}
describe('fiscal HTTP namespace, live ownership and private PDF', () => {
  it.each([
    '/api/admin/fiscal',
    '/api/admin/fiscal/policies/unknown',
    '/api/%61dmin/fiscal/policies',
    '/api/admin/fiscal%2fpolicies',
    '/api/admin/fiscal%252fpolicies',
    '/api/orders/00000000-0000-4000-8000-000000000001/%69nvoice',
    '/api/admin/orders/x/fiscal/unknown'
  ])('owns aliases without fallback: %s', (path) => {
    expect(ownsFiscalNamespace(path)).toBe(true)
  })
  it('does not own unrelated orders/catalog resources', () => {
    expect(ownsFiscalNamespace('/api/orders/abc/lines')).toBe(false)
    expect(ownsFiscalNamespace('/api/products')).toBe(false)
  })
  it('returns canonical admin state and exposes no edit/reissue/rectification actions', async () => {
    const w = await world(),
      response = await http(w, `/api/admin/orders/${w.orderId}/fiscal`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'queued',
      validationOnly: true,
      pdfAvailable: false,
      capabilities: { edit: false, issueRetry: false, creditNote: false, reconcile: false }
    })
  })
  it('serves PDF only to an active sealed owner session', async () => {
    const w = await world({ owner: true })
    await dispatch(w)
    const response = await http(w, `/api/orders/${w.orderId}/invoice`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toBe('Cookie')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(new TextDecoder().decode(await response.arrayBuffer())).toContain('SYNTHETIC LOCAL VALIDATION ONLY')
  })
  it('never assigns guest orders to a login by equal email/admin role', async () => {
    const w = await world()
    await dispatch(w)
    w.sqlite.exec(`UPDATE identities SET email='buyer@example.invalid' WHERE id='${IDENTITY}'`)
    expect((await http(w, `/api/orders/${w.orderId}/invoice`)).status).toBe(401)
  })
  it('accepts only the existing current guest cookie, not the guessable order ID', async () => {
    const w = await world()
    await dispatch(w)
    expect((await http(w, `/api/orders/${w.orderId}/invoice`, { anonymous: true })).status).toBe(401)
    expect((await http(w, `/api/orders/${w.orderId}/invoice`, { guest: true })).status).toBe(200)
    expect((await http(w, `/api/orders/${w.orderId}/invoice?token=${w.orderToken}`, { anonymous: true })).status).toBe(
      400
    )
    w.sqlite.prepare('UPDATE orders SET access_revoked_at=? WHERE id=?').run(NOW, w.orderId)
    expect((await http(w, `/api/orders/${w.orderId}/invoice`, { guest: true })).status).toBe(404)
  })
  it('expires guest order cookie after 24h without extending at PDF download', async () => {
    const w = await world()
    await dispatch(w)
    vi.setSystemTime(new Date('2026-10-04T09:00:00Z'))
    expect((await http(w, `/api/orders/${w.orderId}/invoice`, { guest: true })).status).toBe(404)
  })
  it('does not release bytes if guest credential was revoked during the storage await', async () => {
    const w = await world()
    await dispatch(w)
    const storage: PrivateFiscalStorage = {
      ...w.storage,
      async get(key) {
        const bytes = await w.storage.get(key)
        w.sqlite.prepare('UPDATE orders SET access_revoked_at=? WHERE id=?').run(NOW, w.orderId)
        return bytes
      }
    }
    const response = await http(w, `/api/orders/${w.orderId}/invoice`, { guest: true, storage })
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).not.toBe('application/pdf')
  })
  it('does not release bytes if sealed owner session expires during storage await', async () => {
    const w = await world({ owner: true })
    await dispatch(w)
    const storage: PrivateFiscalStorage = {
      ...w.storage,
      async get(key) {
        const bytes = await w.storage.get(key)
        vi.setSystemTime(new Date('2026-10-03T11:00:00Z'))
        return bytes
      }
    }
    expect((await http(w, `/api/orders/${w.orderId}/invoice`, { storage })).status).toBe(401)
  })
  it('verifies stored bytes/checksum and fails closed on corruption', async () => {
    const w = await world()
    await dispatch(w)
    const key = [...w.objects.keys()][0]!,
      bytes = w.objects.get(key)!
    bytes[10] = (bytes[10]! + 1) % 255
    expect((await http(w, `/api/orders/${w.orderId}/invoice`, { guest: true })).status).toBe(503)
  })
  it.each(['preview', 'production'] as const)('never serves fake PDF as real in %s', async (appEnvironment) => {
    const w = await world()
    await dispatch(w)
    expect((await http(w, `/api/orders/${w.orderId}/invoice`, { guest: true, appEnvironment })).status).toBe(404)
    const state = await http(w, `/api/orders/${w.orderId}/fiscal`, { guest: true, appEnvironment })
    expect(await state.json()).toMatchObject({ validationOnly: true, pdfAvailable: false })
  })
  it('rejects cross-site, wrong-origin, unsupported methods and encoded aliases before mutation', async () => {
    const w = await world()
    expect(
      (
        await http(w, '/api/admin/fiscal/policies', {
          method: 'POST',
          body: policyInput,
          headers: { origin: 'https://evil.invalid' }
        })
      ).status
    ).toBe(403)
    expect(
      (
        await http(w, '/api/admin/fiscal/policies', {
          method: 'POST',
          body: policyInput,
          headers: { 'sec-fetch-site': 'cross-site' }
        })
      ).status
    ).toBe(403)
    expect((await http(w, '/api/admin/fiscal/policies', { method: 'PUT' })).status).toBe(405)
    expect((await http(w, '/api/admin/fiscal%2fpolicies', { method: 'POST', body: policyInput })).status).toBe(404)
    expect(w.sqlite.prepare('SELECT count(*)AS n FROM fiscal_issuance_policies').get()!.n).toBe(1)
  })
  it.each([
    { body: { ...policyInput, claims }, status: 422 },
    { body: policyInput, headers: { 'content-length': '20000' }, status: 413 },
    { body: policyInput, headers: { 'content-type': 'text/plain' }, status: 415 },
    { body: '{broken', status: 400 },
    { body: ' '.repeat(17000), status: 413 }
  ])('rejects hostile/body-invalid policy requests %#', async (test) => {
    const w = await world()
    expect(
      (await http(w, '/api/admin/fiscal/policies', { method: 'POST', body: test.body, headers: test.headers })).status
    ).toBe(test.status)
  })
  it('replays policies and queue HTTP commands without new occurrences', async () => {
    const w = await world()
    const response = await http(w, '/api/admin/fiscal/policies', { method: 'POST', body: policyInput })
    expect(response.status).toBe(201)
    expect((await response.json()).policy.id).toBe(w.policy.id)
    const queued = await http(w, '/api/admin/fiscal/requests', {
      method: 'POST',
      body: { eventId: w.eventId, policyId: w.policy.id, idempotencyKey: 'queue-one' }
    })
    expect(queued.status).toBe(202)
    expect(await queued.json()).toMatchObject({ intentId: w.queued!.intentId, replayed: true })
  })
})

describe('fiscal durable evidence boundaries and adversarial windows', () => {
  it('queues a real paid outbox obligation without fabricating receipts or manually changing delivery state', async () => {
    const w = await world({ queue: false })
    expect(w.sqlite.prepare('SELECT * FROM fiscal_evaluation_inbox').get()).toBeUndefined()
    expect(w.sqlite.prepare('SELECT status FROM fiscal_outbox_delivery').get()).toEqual({ status: 'blocked_policy' })
    const queued = await queueFiscalInvoice(w.database, claims, {
      eventId: w.eventId,
      policyId: w.policy.id,
      idempotencyKey: 'governed-queue',
      now: NOW
    })
    expect(queued.replayed).toBe(false)
    expect(w.sqlite.prepare('SELECT status FROM fiscal_evaluation_inbox').get()).toEqual({ status: 'blocked_policy' })
    expect(w.sqlite.prepare('SELECT status FROM fiscal_outbox_delivery').get()).toEqual({ status: 'ready' })
    expect(await dispatch(w)).toMatchObject({ completed: 1 })
  })
  it('rolls back the owned evaluation receipt and transport release if intent persistence fails', async () => {
    const w = await world({ queue: false })
    w.sqlite.exec(
      "CREATE TRIGGER synthetic_queue_failure BEFORE INSERT ON fiscal_invoice_intents BEGIN SELECT RAISE(ABORT,'synthetic failure');END"
    )
    await expect(
      queueFiscalInvoice(w.database, claims, {
        eventId: w.eventId,
        policyId: w.policy.id,
        idempotencyKey: 'governed-queue',
        now: NOW
      })
    ).rejects.toThrow()
    expect(w.sqlite.prepare('SELECT * FROM fiscal_evaluation_inbox').get()).toBeUndefined()
    expect(w.sqlite.prepare('SELECT status FROM fiscal_outbox_delivery').get()).toEqual({ status: 'blocked_policy' })
    expect(facts(w.sqlite).intents).toBe(0)
  })
  it('serializes native D1 batches while same-key admin commands race; no duplicate occurrence', async () => {
    const w = await world({ queue: false }),
      batch = w.database.batch.bind(w.database)
    let tail: Promise<unknown> = Promise.resolve()
    const serialized = {
      ...w.database,
      batch(statements: D1PreparedStatement[]) {
        const result = tail.then(() => batch(statements))
        tail = result.catch(() => {})
        return result
      }
    } as D1Database
    const policies = await Promise.all(
      Array.from({ length: 3 }, () =>
        approveFiscalPolicy(
          serialized,
          claims,
          { ...policyInput, idempotencyKey: 'raced-policy', series: 'RACE' },
          { now: NOW }
        )
      )
    )
    expect(new Set(policies.map((p) => p.id)).size).toBe(1)
    const queues = await Promise.all(
      Array.from({ length: 3 }, () =>
        queueFiscalInvoice(serialized, claims, {
          eventId: w.eventId,
          policyId: policies[0]!.id,
          idempotencyKey: 'raced-queue',
          now: NOW
        })
      )
    )
    expect(new Set(queues.map((q) => q.intentId)).size).toBe(1)
    expect(facts(w.sqlite).intents).toBe(1)
    expect(
      w.sqlite.prepare("SELECT count(*) AS n FROM fiscal_issuance_events WHERE event_type='queued'").get()!.n
    ).toBe(1)
  })
  it('classifies racing same-key/different-payload as idempotency conflict, not a raw SQL error', async () => {
    const w = await world({ queue: false }),
      batch = w.database.batch.bind(w.database)
    let tail: Promise<unknown> = Promise.resolve()
    const serialized = {
      ...w.database,
      batch(statements: D1PreparedStatement[]) {
        const result = tail.then(() => batch(statements))
        tail = result.catch(() => {})
        return result
      }
    } as D1Database
    const result = await Promise.allSettled(
      ['RACE1', 'RACE2'].map((series) =>
        approveFiscalPolicy(serialized, claims, { ...policyInput, idempotencyKey: 'collision', series }, { now: NOW })
      )
    )
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((result.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      code: 'idempotency_conflict'
    })
  })
  it('bounds preparation attempts and persists its transition event atomically', async () => {
    const w = await world()
    w.sqlite.exec('UPDATE fiscal_issuance_work SET attempts=10')
    expect(await dispatch(w)).toMatchObject({ blocked: 1, completed: 0 })
    expect(work(w.sqlite).status).toBe('manual_review')
    expect(
      w.sqlite.prepare("SELECT count(*)AS n FROM fiscal_issuance_events WHERE event_type='preparation_blocked'").get()!
        .n
    ).toBe(1)
  })
  it.each(['typed', 'array', 'buffer'])('accepts native BLOB %s without aliasing', (kind) => {
    const bytes = new TextEncoder().encode('%PDF-1.4\n% native BLOB\n%%EOF')
    const value = kind === 'typed' ? bytes : kind === 'array' ? [...bytes] : bytes.buffer
    const owned = localFiscalBlobBytes(value)
    expect(owned).toEqual(bytes)
    bytes[0] = 0
    expect(owned[0]).toBe(37)
  })
  it.each([
    Array(20),
    [...Array(20).fill(1), 256],
    new Uint8Array(3),
    Object.create({ byteLength: 30 }),
    Array(20).fill('1')
  ])('rejects malformed native BLOB %#', (value) => {
    expect(() => localFiscalBlobBytes(value)).toThrow('invalid_source')
  })
  it.each([
    Object.create({ success: true, results: [] }),
    { success: true },
    { success: true, results: Array(1) },
    { success: 1, results: [] },
    { success: true, results: [Object.create({ providerId: 'SYNTHETIC' })] },
    {
      get success() {
        throw Error('do not invoke getter')
      },
      results: []
    },
    {
      success: true,
      get results() {
        throw Error('do not invoke getter')
      }
    }
  ])('rejects malformed/inherited/getter/sparse D1 envelopes %#', (value) => {
    expect(() => fiscalBatchEvidence([value], 1)).toThrow('unconfirmed')
  })
  it('never executes provider receipt getters', async () => {
    const w = await world(),
      getter = vi.fn(() => w.amount)
    vi.spyOn(w.provider, 'issueInvoice').mockResolvedValue({
      providerId: 'SYNTHETIC',
      code: 'SYNTHETIC',
      status: 'issued',
      currency: 'EUR',
      get amountCents() {
        return getter()
      }
    })
    expect(await dispatch(w)).toMatchObject({ uncertain: 1 })
    expect(getter).not.toHaveBeenCalled()
    expect(facts(w.sqlite).documents).toBe(0)
  })
  it.each(['wrong_key', 'wrong_fingerprint', 'multiple', 'unavailable'] as const)(
    'requires exact authoritative singular lookup evidence: %s',
    async (mode) => {
      const w = await world()
      w.provider.failures.issue = 'accepted_response_lost'
      await dispatch(w)
      w.provider.failures.lookup = mode
      expect(await reconcile(w)).toMatchObject({ outcome: 'blocked' })
      expect(facts(w.sqlite).documents).toBe(0)
      expect(facts(w.sqlite).accepted).toBe(1)
    }
  )
  it('fences reconciliation during PDF await; older owner cannot persist a completion', async () => {
    const w = await world()
    w.provider.failures.issue = 'accepted_response_lost'
    await dispatch(w)
    const original = w.provider.downloadPdf.bind(w.provider)
    vi.spyOn(w.provider, 'downloadPdf').mockImplementation(async (id) => {
      const bytes = await original(id)
      w.sqlite.exec(
        "UPDATE fiscal_issuance_work SET generation=generation+1,status='uncertain',lease_token=NULL,lease_until=NULL"
      )
      return bytes
    })
    await expect(reconcile(w)).rejects.toMatchObject({ code: 'version_conflict' })
    expect(facts(w.sqlite).documents).toBe(0)
    expect(facts(w.sqlite).events).toBe(0)
  })
  it('rechecks authorization after private storage write before completion', async () => {
    const w = await world()
    w.provider.failures.issue = 'accepted_response_lost'
    await dispatch(w)
    const original = w.storage.put
    w.storage.put = async (key, bytes) => {
      await original(key, bytes)
      w.sqlite.exec(`UPDATE auth_sessions SET revoked_at='${NOW}' WHERE id='${SESSION}'`)
    }
    await expect(reconcile(w)).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(facts(w.sqlite).documents).toBe(0)
    expect(facts(w.sqlite).events).toBe(0)
  })
  it('uses live SQL authorization when session expires between preflight and mutating batch', async () => {
    const w = await world({ queue: false }),
      nativeBatch = w.database.batch.bind(w.database)
    const raced = {
      ...w.database,
      async batch(statements: D1PreparedStatement[]) {
        vi.setSystemTime(new Date('2026-10-03T11:00:00Z'))
        return nativeBatch(statements)
      }
    } as D1Database
    await expect(
      queueFiscalInvoice(raced, claims, {
        eventId: w.eventId,
        policyId: w.policy.id,
        idempotencyKey: 'queue-after-expiry',
        now: NOW
      })
    ).rejects.toThrow()
    expect(facts(w.sqlite).intents).toBe(0)
  })
  it('does not interpret malformed candidate evidence as an empty/blocked queue', async () => {
    const w = await world(),
      original = w.database.prepare.bind(w.database)
    const bad = {
      ...w.database,
      prepare(sql: string) {
        const statement = original(sql)
        if (sql.includes('SELECT intent_id FROM fiscal_issuance_work WHERE attempts'))
          statement.all = async () => ({ success: true, results: Array(1) }) as never
        return statement
      }
    } as D1Database
    await expect(
      dispatchFiscalIssuance(bad, w.provider, w.storage, {
        now: NOW,
        appEnvironment: 'local',
        allowProviderIssuance: true
      })
    ).rejects.toThrow('unconfirmed')
    expect(facts(w.sqlite).accepted).toBe(0)
  })
  it('preserves the non-retryable marker when the issuing batch commit acknowledgement is malformed', async () => {
    const w = await world(),
      batch = w.database.batch.bind(w.database),
      prepare = w.database.prepare.bind(w.database)
    let marker = false
    const raced = {
      ...w.database,
      prepare(sql: string) {
        if (sql.includes("SET status='issuing'")) marker = true
        return prepare(sql)
      },
      async batch(statements: D1PreparedStatement[]) {
        const result = await batch(statements)
        if (marker) {
          marker = false
          return result.map(() => Object.create({ success: true, results: [] }))
        }
        return result
      }
    } as D1Database
    await expect(
      dispatchFiscalIssuance(raced, w.provider, w.storage, {
        now: NOW,
        appEnvironment: 'local',
        allowProviderIssuance: true
      })
    ).rejects.toThrow('unconfirmed')
    expect(work(w.sqlite).status).toBe('issuing')
    expect(facts(w.sqlite).accepted).toBe(0)
    expect(await dispatch(w)).toMatchObject({ completed: 0 })
    expect(facts(w.sqlite).accepted).toBe(0)
  })
})

const beplyConfiguration = {
  baseUrl: 'https://synthetic.beply.es/api/3/',
  token: 'SYNTHETIC-NOT-A-REAL-TOKEN',
  invoiceSeries: 'SANDBOX',
  correctiveSeries: 'RECT',
  taxCode0: 'ZERO',
  taxCode10: 'REDUCED',
  taxCode21: 'GENERAL',
  paymentCodeRedsys: 'CARD',
  paymentCodeBankTransfer: 'TRANSFER',
  companyId: 'SYNTHETIC',
  environment: 'sandbox' as const
}
async function beplyContract(w: Awaited<ReturnType<typeof world>>) {
  return {
    ...JSON.parse(String(w.sqlite.prepare('SELECT contract_json FROM fiscal_invoice_intents').get()!.contract_json)),
    provider: 'beply',
    environment: 'sandbox',
    series: 'SANDBOX',
    validationOnly: false
  }
}
function beplyFetcher(invoice: unknown, overrides: { pdf?: Response; invoiceResponse?: Response } = {}) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/3(?=\/)/, '')
    if (path === '/contactos' && (!init?.method || init.method === 'GET')) return Response.json([])
    if (path === '/crearFacturaCliente') return overrides.invoiceResponse ?? Response.json(invoice)
    if (path.startsWith('/exportarFacturaCliente/'))
      return (
        overrides.pdf ??
        new Response('%PDF-1.4\n% SYNTHETIC PDF ONLY\n%%EOF', { headers: { 'content-type': 'application/pdf' } })
      )
    return Response.json({ ok: true })
  })
}
describe('Worker Beply adapter OFFLINE fixtures only — no provider acceptance claim', () => {
  it('rejects the known production tenant when labelled sandbox without fetching', async () => {
    const fetcher = beplyFetcher({})
    for (const baseUrl of [
      'https://neteco.beply.es/api/3',
      'https://NETECO.BEPLY.ES/api/3/',
      'https://neteco.beply.es:443/api/3'
    ])
      await expect(WorkerBeplyInvoiceProvider.create({ ...beplyConfiguration, baseUrl }, fetcher)).rejects.toThrow()
    await expect(
      WorkerBeplyInvoiceProvider.create(
        { ...beplyConfiguration, baseUrl: 'https://neteco.beply.es/api/3', environment: 'production' },
        fetcher
      )
    ).resolves.toMatchObject({ environment: 'production' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('uses mapped historic shipping VAT, precise net amounts, and no invented remote lookup', async () => {
    const w = await world(),
      fetcher = beplyFetcher({
        idfactura: 42,
        codigo: 'SANDBOX-42',
        total: (w.amount / 100).toFixed(2),
        coddivisa: 'EUR'
      })
    const provider = await WorkerBeplyInvoiceProvider.create(beplyConfiguration, fetcher)
    expect(await provider.issueInvoice(await beplyContract(w))).toEqual({
      providerId: '42',
      code: 'SANDBOX-42',
      status: 'issued',
      amountCents: w.amount,
      currency: 'EUR'
    })
    expect('lookupByExternalKey' in provider).toBe(false)
    expect(fetcher.mock.calls[0]![0]).toBe('https://synthetic.beply.es/api/3/clientes')
    const request = fetcher.mock.calls.find(([url]) => String(url).endsWith('/crearFacturaCliente'))!
    expect(request[0]).toBe('https://synthetic.beply.es/api/3/crearFacturaCliente')
    const form = new URLSearchParams(String(request[1]!.body)),
      lines = JSON.parse(form.get('lineas')!)
    expect(lines.find((line: { referencia: string }) => line.referencia === 'ENVIO')).toMatchObject({
      codimpuesto: 'REDUCED',
      iva: 10,
      pvpunitario: '1.000000'
    })
    expect(form.get('observaciones')).toContain('correlación')
    expect(request[1]!.redirect).toBe('error')
    expect(new TextDecoder().decode(await provider.downloadPdf('42'))).toContain('%PDF')
    expect(fetcher.mock.calls.at(-1)![0]).toBe(
      'https://synthetic.beply.es/api/3/exportarFacturaCliente/42?type=PDF&lang=es_ES'
    )
  })
  it.each([
    { idfactura: 42, total: '6.10', coddivisa: 'EUR' },
    { idfactura: 42, codigo: 'X', total: '6.101', coddivisa: 'EUR' },
    { idfactura: '../../secret', codigo: 'X', total: '6.10', coddivisa: 'EUR' },
    { idfactura: 42, codigo: 'X', total: '6.10', coddivisa: 'USD' },
    { idfactura: 42, codigo: 'X', total: '6.10' },
    { idfactura: 42, codigo: 'X', total: Infinity, coddivisa: 'EUR' }
  ])('rejects missing/invalid money, identity or currency %#', async (invoice) => {
    const w = await world(),
      provider = await WorkerBeplyInvoiceProvider.create(beplyConfiguration, beplyFetcher(invoice))
    await expect(provider.issueInvoice(await beplyContract(w))).rejects.toThrow()
  })
  it.each([
    'http://synthetic.beply.es',
    'https://evil.invalid',
    'https://synthetic.beply.es/other',
    'https://user:pass@synthetic.beply.es',
    'https://synthetic.beply.es:8443'
  ])('rejects unsafe unapproved configuration %s', async (baseUrl) => {
    const fetcher = beplyFetcher({})
    await expect(WorkerBeplyInvoiceProvider.create({ ...beplyConfiguration, baseUrl }, fetcher)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([
    new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('%PDF-1.4\ninvalid without EOF', { headers: { 'content-type': 'application/pdf' } }),
    new Response('%PDF-1.4\n%%EOF', { headers: { 'content-type': 'application/pdf', 'content-length': '9999999' } })
  ])('validates PDF MIME/header/EOF and declared bounds %#', async (pdf) => {
    const provider = await WorkerBeplyInvoiceProvider.create(beplyConfiguration, beplyFetcher({}, { pdf }))
    await expect(provider.downloadPdf('42')).rejects.toThrow()
  })
  it('normalizes errors without echoing provider body, token or PII', async () => {
    const w = await world(),
      provider = await WorkerBeplyInvoiceProvider.create(
        beplyConfiguration,
        beplyFetcher({}, { invoiceResponse: new Response('SYNTHETIC-SECRET buyer@example.invalid', { status: 409 }) })
      )
    await expect(provider.issueInvoice(await beplyContract(w))).rejects.toMatchObject({
      code: 'duplicate',
      status: 409,
      message: 'beply_duplicate'
    })
  })
})
