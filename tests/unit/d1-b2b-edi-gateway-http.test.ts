import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleB2bEdiHttp, ownsB2bEdiNamespace } from '../../workers/b2b/edi-gateway-http'
import { registerEdiClient, createEdiApiKey, computeEdiHmacSignature } from '../../workers/b2b/edi-gateway'

const NOW = '2026-10-29T10:00:00Z'
const COMPANY_ID = '40000000-0000-4000-8000-000000000001'
const CUSTOMER_ID = '30000000-0000-4000-8000-000000000001'
const ADMIN_IDENTITY = '10000000-0000-4000-8000-000000000099'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000099'
const config = { password: randomBytes(32).toString('hex'), maxAgeSeconds: 3600 }

describe('CUS-030: Key B2B Client EDI HTTP Gateway', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let adminCookie: string
  let _publication: Awaited<ReturnType<typeof provisionPublicationValidityFixture>>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    sqlite.exec(await readFile('db/d1/migrations/0108_b2b_shared_lists_edi_scoring.sql', 'utf8'))
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    _publication = await provisionPublicationValidityFixture(database, {
      productIds: ['p-1'],
      now: NOW
    })

    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(CUSTOMER_ID, NOW, NOW)
    sqlite
      .prepare(
        `INSERT INTO companies(id, customer_id, legal_name, tax_id, country_code, status, created_at, updated_at)
         VALUES (?, ?, 'Acme EDI Ltd', 'B99999999', 'ES', 'approved', ?, ?)`
      )
      .run(COMPANY_ID, CUSTOMER_ID, NOW, NOW)

    // Admin setup
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
         VALUES (?, 'admin@neteco.invalid', 'synthetic', ?, 'active', ?, ?)`
      )
      .run(ADMIN_IDENTITY, NOW, NOW, NOW)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id, identity_id, session_version, created_at, expires_at)
         VALUES (?, ?, 1, '2026-10-29T08:00:00Z', '2026-10-29T12:00:00Z')`
      )
      .run(ADMIN_SESSION, ADMIN_IDENTITY)
    sqlite
      .prepare(`INSERT OR IGNORE INTO roles(code, name, description) VALUES ('super-admin', 'Super Admin', 'Test')`)
      .run()
    sqlite
      .prepare(`INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES (?, 'super-admin', ?)`)
      .run(ADMIN_IDENTITY, NOW)

    adminCookie = (await issueD1SessionCookie(
      database,
      { sessionId: ADMIN_SESSION, identityId: ADMIN_IDENTITY, sessionVersion: 1 },
      config
    ))!
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reconoce las rutas EDI públicas y administrativas', () => {
    expect(ownsB2bEdiNamespace('/api/edi/v1/orders')).toBe(true)
    expect(ownsB2bEdiNamespace('/api/edi/v1/monitoring')).toBe(true)
    expect(ownsB2bEdiNamespace('/api/admin/edi/clients')).toBe(true)
    expect(ownsB2bEdiNamespace('/api/catalog/products')).toBe(false)
  })

  it('rechaza con 403 forbidden a un usuario autenticado sin rol de administración en endpoints admin', async () => {
    const USER_ID = '10000000-0000-4000-8000-000000000002'
    const USER_SESS = '20000000-0000-4000-8000-000000000002'
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
         VALUES (?, 'user@neteco.invalid', 'synthetic', ?, 'active', ?, ?)`
      )
      .run(USER_ID, NOW, NOW, NOW)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id, identity_id, session_version, created_at, expires_at)
         VALUES (?, ?, 1, '2026-10-29T08:00:00Z', '2026-10-29T12:00:00Z')`
      )
      .run(USER_SESS, USER_ID)
    const userCookie = (await issueD1SessionCookie(
      database,
      { sessionId: USER_SESS, identityId: USER_ID, sessionVersion: 1 },
      config
    ))!

    const req = new Request('https://neteco.invalid/api/admin/edi/clients', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: userCookie
      },
      body: JSON.stringify({
        companyId: COMPANY_ID,
        customerId: CUSTOMER_ID,
        name: 'Cliente Clave No Admin'
      })
    })
    const res = await handleB2bEdiHttp(req, {
      database,
      sessionCookieConfiguration: config
    })
    expect(res?.status).toBe(403)
  })

  it('permite al admin registrar clientes y crear claves de acceso', async () => {
    const regReq = new Request('https://neteco.invalid/api/admin/edi/clients', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie
      },
      body: JSON.stringify({
        companyId: COMPANY_ID,
        customerId: CUSTOMER_ID,
        name: 'Cliente Clave SAP',
        environment: 'sandbox',
        rateLimitPerMinute: 60,
        dailyRequestQuota: 5000
      })
    })

    const regRes = await handleB2bEdiHttp(regReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(regRes?.status).toBe(201)
    const { client } = (await regRes?.json()) as { client: { id: string } }

    const keyReq = new Request(`https://neteco.invalid/api/admin/edi/clients/${client.id}/keys`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie
      },
      body: JSON.stringify({ name: 'SAP Key Live' })
    })

    const keyRes = await handleB2bEdiHttp(keyReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(keyRes?.status).toBe(201)
    const keyData = (await keyRes?.json()) as { key: { apiKey: string; hmacSecret: string } }
    expect(keyData.key.apiKey).toBeDefined()
    expect(keyData.key.hmacSecret).toBeDefined()
  })

  it('procesa pedidos EDI con cabeceras de firma, versión e idempotencia', async () => {
    const client = await registerEdiClient(database, {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      name: 'Test Client',
      environment: 'sandbox'
    })
    const key = await createEdiApiKey(database, { clientId: client.id, name: 'EDI Key' })

    const variantId = 'v-1-1'
    const body = JSON.stringify({
      orderReference: 'ORD-EDI-900',
      lines: [{ variantId, quantity: 5 }],
      shippingAddress: { street: 'Paseo de Gracia 1', postalCode: '08007', city: 'Barcelona', countryCode: 'ES' },
      contactEmail: 'purchasing@test.invalid'
    })

    const timestamp = Math.floor(new Date(NOW).getTime() / 1000).toString()
    const signature = await computeEdiHmacSignature(key.hmacSecret, timestamp, body)

    const orderReq = new Request('https://neteco.invalid/api/edi/v1/orders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-neteco-edi-key': key.apiKey,
        'x-neteco-edi-signature': signature,
        'x-neteco-edi-timestamp': timestamp,
        'x-neteco-edi-version': '2026-10',
        'idempotency-key': 'idem-http-001'
      },
      body
    })

    const orderRes = await handleB2bEdiHttp(orderReq, {
      database,
      sessionCookieConfiguration: config
    })

    expect(orderRes?.status).toBe(200)
    expect(orderRes?.headers.get('x-neteco-edi-environment')).toBe('sandbox')
    expect(orderRes?.headers.get('x-neteco-edi-version')).toBe('2026-10')

    const resData = (await orderRes?.json()) as { ok: boolean; order: { status: string; totalGrossCents: number } }
    expect(resData.ok).toBe(true)
    expect(resData.order.status).toBe('sandbox_accepted')
    expect(resData.order.totalGrossCents).toBeGreaterThan(0)
  })

  it('proporciona métricas de monitorización al cliente EDI autenticado', async () => {
    const client = await registerEdiClient(database, {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      name: 'Mon Client',
      environment: 'sandbox'
    })
    const key = await createEdiApiKey(database, { clientId: client.id, name: 'Key' })

    const timestamp = Math.floor(new Date(NOW).getTime() / 1000).toString()
    const signature = await computeEdiHmacSignature(key.hmacSecret, timestamp, '')

    const monReq = new Request('https://neteco.invalid/api/edi/v1/monitoring', {
      headers: {
        'x-neteco-edi-key': key.apiKey,
        'x-neteco-edi-signature': signature,
        'x-neteco-edi-timestamp': timestamp
      }
    })

    const monRes = await handleB2bEdiHttp(monReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(monRes?.status).toBe(200)
    const monData = (await monRes?.json()) as { monitoring: { clientId: string; dailyQuota: number } }
    expect(monData.monitoring.clientId).toBe(client.id)
    expect(monData.monitoring.dailyQuota).toBe(5000)
  })
})
