import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleSplitBackordersHttp } from '../../workers/orders/split-backorders-http'
import { handleProcurementApprovalsHttp } from '../../workers/orders/procurement-approvals-http'
import { setCustomerSplitPreferences } from '../../workers/orders/split-backorders'
import { assignOrderProcurementDetails } from '../../workers/orders/procurement-approvals'

// SECFIX-3 findings 4 + 5: anonymous/cross-customer reads of order split preferences and invoice views.
const now = '2026-10-31T09:00:00Z'
const config = { password: 'o'.repeat(64), maxAgeSeconds: 3600 }
const origin = 'https://shop.invalid'
const orderId = '66666666-6666-4666-8666-666666666666'
const unknownOrderId = '77777777-7777-4777-8777-777777777777'
const ids = {
  admin: ['10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-0000000000a1'],
  owner: ['10000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-0000000000b1'],
  stranger: ['10000000-0000-4000-8000-0000000000c1', '20000000-0000-4000-8000-0000000000c1']
} as const

let sqlite: DatabaseSync
let database: D1Database
const cookies: Record<keyof typeof ids, string> = { admin: '', owner: '', stranger: '' }

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile('db/d1/migrations/0074_order_purchase_reference.sql', 'utf8'))
  sqlite.exec(await readFile('db/d1/migrations/0145_orders_procurement_split_contingency.sql', 'utf8'))
  database = d1OverSqlite(sqlite)
  const t = '2026-10-31T08:00:00Z'
  const d = 'dm-sec-ownership'
  const h = 'a'.repeat(64)
  sqlite.exec(`
    INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES('cust-owner','Owner',NULL,'active','${t}','${t}');
    INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES('cust-stranger','Stranger',NULL,'active','${t}','${t}');
    INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
      VALUES('${ids.admin[0]}','admin@neteco.es','x','${t}','active',NULL,'${t}','${t}');
    INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
      VALUES('${ids.owner[0]}','owner@cliente.es','x','${t}','active','cust-owner','${t}','${t}');
    INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
      VALUES('${ids.stranger[0]}','stranger@cliente.es','x','${t}','active','cust-stranger','${t}','${t}');
    INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES('${ids.admin[1]}','${ids.admin[0]}',1,1,'${t}','2026-10-31T20:00:00Z');
    INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES('${ids.owner[1]}','${ids.owner[0]}',1,0,'${t}','2026-10-31T20:00:00Z');
    INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES('${ids.stranger[1]}','${ids.stranger[0]}',1,0,'${t}','2026-10-31T20:00:00Z');
    INSERT INTO roles(code, name, description) VALUES('admin','Administrator','Full admin') ON CONFLICT DO NOTHING;
    INSERT INTO permissions(code, resource, action, description) VALUES('administration.manage','administration','manage','Admin') ON CONFLICT DO NOTHING;
    INSERT INTO role_permissions(role_code, permission_code) VALUES('admin','administration.manage') ON CONFLICT DO NOTHING;
    INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES('${ids.admin[0]}','admin','${t}');
    INSERT INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at)
      VALUES('${d}','${h}','active',1,'2030-01-01T00:00:00Z','c','${t}','${t}');
    INSERT INTO checkout_quotes(id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents, shipping_pending, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at)
      VALUES('${d}','${d}',1,'${t}','EUR',0,1,10000,0,10000,'${h}','c','${t}');
    INSERT INTO shipping_quotes(id, cart_id, cart_version, destination_hash, options_json, option_count, snapshot_hash, expires_at, correlation_id, created_at)
      VALUES('${d}','${d}',1,'${h}','[]',0,'${h}','2030-01-01T00:00:00Z','c','${t}');
    INSERT INTO checkout_attempts(id, cart_id, command_key, state, correlation_id, payload_hash, created_at, updated_at)
      VALUES('${d}','${d}','key-sec-own','failed','c','${h}','${t}','${t}');
    INSERT INTO orders(id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy, correlation_id, created_at, updated_at, customer_id)
      VALUES('${orderId}','${d}','${d}','${d}','${d}','${h}','awaiting_payment','res-1','2030-01-01T00:00:00Z','EUR',10000,0,10000,0,0,0,'parcel',1,1,3,'owner@cliente.es','${h}',1,1,'c','${t}','${t}','cust-owner');
  `)
  for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
    const [identityId, sessionId] = ids[key]
    cookies[key] = (await issueD1SessionCookie(database, { identityId, sessionId, sessionVersion: 1 }, config))!
  }
  await setCustomerSplitPreferences(database, {
    orderId,
    customerId: 'cust-owner',
    customerAcceptsSplit: true,
    acceptedExtraShippingCents: 0,
    shippingCostPayer: 'merchant',
    now
  } as never)
  await assignOrderProcurementDetails(database, {
    orderId,
    purchaseOrderReference: 'PO-SECRET-B2B',
    costCenter: 'CC-CONFIDENCIAL',
    approvalThresholdCents: 500000,
    now
  })
})

afterEach(() => {
  vi.useRealTimers()
  sqlite.close()
})

const cases = [
  {
    name: 'GET /api/orders/split-preferences (finding 4)',
    path: '/api/orders/split-preferences',
    handle: (request: Request) =>
      handleSplitBackordersHttp(request, { database, sessionCookieConfiguration: config, origin, now })
  },
  {
    name: 'GET /api/orders/procurement/invoice-view (finding 5)',
    path: '/api/orders/procurement/invoice-view',
    handle: (request: Request) =>
      handleProcurementApprovalsHttp(request, { database, sessionCookieConfiguration: config, origin, now })
  }
]

describe.each(cases)('SECFIX-3 $name', ({ path, handle }) => {
  const get = (order: string, cookie?: string) =>
    handle(new Request(`${origin}${path}?orderId=${order}`, { headers: cookie ? { cookie } : {} }))

  it('rejects anonymous callers with 401 and leaks no order data', async () => {
    const response = await get(orderId)
    expect(response?.status).toBe(401)
    const text = await response!.text()
    expect(text).not.toContain('PO-SECRET-B2B')
    expect(text).not.toContain('cust-owner')
    expect(JSON.parse(text)).toEqual({ error: { code: 'unauthenticated' } })
  })

  it('rejects anonymous callers with 401 even for unknown orders (no existence oracle)', async () => {
    expect((await get(unknownOrderId))?.status).toBe(401)
  })

  it.each([orderId, unknownOrderId])('rejects a revoked session before looking up order %s', async (order) => {
    sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(now, ids.owner[1])
    const response = await get(order, cookies.owner)
    expect(response?.status).toBe(401)
    expect(await response!.json()).toEqual({ error: { code: 'unauthenticated' } })
  })

  it('answers 404 for an unknown order to an authenticated caller', async () => {
    const response = await get(unknownOrderId, cookies.stranger)
    expect(response?.status).toBe(404)
    expect(await response!.json()).toEqual({ error: { code: 'not_found' } })
  })

  it('forbids a different customer with 403', async () => {
    const response = await get(orderId, cookies.stranger)
    expect(response?.status).toBe(403)
    expect(await response!.text()).not.toContain('PO-SECRET-B2B')
  })

  it('serves the order owner and an administrator', async () => {
    expect((await get(orderId, cookies.owner))?.status).toBe(200)
    expect((await get(orderId, cookies.admin))?.status).toBe(200)
  })
})

describe('SECFIX-3 POST /api/orders/split-preferences origin check', () => {
  const post = (headers: Record<string, string>) =>
    handleSplitBackordersHttp(
      new Request(`${origin}/api/orders/split-preferences`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookies.owner, ...headers },
        body: JSON.stringify({
          orderId,
          customerAcceptsSplit: true,
          acceptedExtraShippingCents: 0,
          shippingCostPayer: 'merchant'
        })
      }),
      { database, sessionCookieConfiguration: config, origin, now }
    )

  it('rejects a cross-origin mutation with 403 csrf_rejected', async () => {
    const response = await post({ origin: 'https://evil.example' })
    expect(response?.status).toBe(403)
    expect(await response!.json()).toEqual({ error: { code: 'csrf_rejected' } })
  })

  it('rejects a mutation without Origin header with 403 csrf_rejected', async () => {
    expect((await post({}))?.status).toBe(403)
  })

  it('accepts a same-origin mutation from the owner', async () => {
    expect((await post({ origin }))?.status).toBe(200)
  })

  it('rejects a cookie invalidated by an identity session-version change', async () => {
    sqlite.prepare('UPDATE identities SET session_version = session_version + 1 WHERE id = ?').run(ids.owner[0])
    const response = await post({ origin })
    expect(response?.status).toBe(401)
  })
})
