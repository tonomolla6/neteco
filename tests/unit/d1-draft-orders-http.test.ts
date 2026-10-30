import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleDraftOrdersHttp,
  ownsDraftOrdersNamespace,
  type DraftOrdersHttpDependencies
} from '../../workers/b2b/draft-orders-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000022'
const GUEST_ID = '90000000-0000-4000-8000-000000000099'
const SESSION_CONFIG = { password: 'synthetic-secret-password-longer-than-32-chars-test', maxAgeSeconds: 3600 }

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0133_supplier_feed_editorial_sourcing_draft_orders.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol admin'),
      ('guest', 'Invitado', 'Sin permisos');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('orders.manage', 'orders', 'manage', 'Gestión pedidos'),
      ('catalog.write', 'catalog', 'write', 'Edición catálogo');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'orders.manage'),
      ('admin', 'catalog.write');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-drafts-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${GUEST_ID}', 'guest-drafts-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000022', '${ADMIN_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z'),
      ('20000000-0000-4000-8000-000000000099', '${GUEST_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${GUEST_ID}', 'guest', '${NOW}');
  `)

  return sqlite
}

describe('CHK-022: Draft Orders HTTP Handlers', () => {
  let sqlite: DatabaseSync
  let d1: ReturnType<typeof d1OverSqlite>
  let adminCookie: string
  let guestCookie: string

  beforeEach(async () => {
    sqlite = await setupTestDb()
    d1 = d1OverSqlite(sqlite)

    const rawAdmin = await issueD1SessionCookie(
      d1,
      { identityId: ADMIN_ID, sessionId: '20000000-0000-4000-8000-000000000022', sessionVersion: 1 },
      SESSION_CONFIG
    )
    adminCookie = rawAdmin!.split(';')[0]!

    const rawGuest = await issueD1SessionCookie(
      d1,
      { identityId: GUEST_ID, sessionId: '20000000-0000-4000-8000-000000000099', sessionVersion: 1 },
      SESSION_CONFIG
    )
    guestCookie = rawGuest!.split(';')[0]!
  })

  afterEach(() => {
    sqlite?.close()
  })

  const deps = (): DraftOrdersHttpDependencies => ({
    database: d1,
    origin: 'https://neteco.test',
    sessionCookieConfiguration: SESSION_CONFIG,
    now: () => NOW
  })

  it('checks namespace correctly', () => {
    expect(ownsDraftOrdersNamespace('/api/admin/draft-orders/create')).toBe(true)
    expect(ownsDraftOrdersNamespace('/api/admin/draft-orders/list')).toBe(true)
    expect(ownsDraftOrdersNamespace('/api/admin/orders')).toBe(false)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const req = new Request('https://neteco.test/api/admin/draft-orders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: 'c1' })
    })

    const res = await handleDraftOrdersHttp(req, deps())
    expect(res?.status).toBe(401)
  })

  it('rejects requests from users without orders.manage permission with 403', async () => {
    const req = new Request('https://neteco.test/api/admin/draft-orders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: guestCookie },
      body: JSON.stringify({
        customerId: 'cust-fail',
        companyName: 'Fail Corp',
        contactEmail: 'fail@corp.es',
        items: [{ variantId: 'v1', sku: 'S1', name: 'N1', quantity: 1, unitPriceCents: 100, lineTotalCents: 100 }]
      })
    })

    const res = await handleDraftOrdersHttp(req, deps())
    expect(res?.status).toBe(403)
  })

  it('handles draft order lifecycle over HTTP: create, submit, review, convert, and timeline audit', async () => {
    // 1. Create draft order
    const createReq = new Request('https://neteco.test/api/admin/draft-orders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        customerId: 'cust-b2b-001',
        companyName: 'Residencia Los Olivos SA',
        contactEmail: 'administracion@losolivos.es',
        items: [
          {
            variantId: 'var-gel-hidro-5l',
            sku: 'GEL-5L',
            name: 'Gel Hidroalcohólico 5L',
            quantity: 20,
            unitPriceCents: 1200,
            lineTotalCents: 24000
          }
        ],
        shippingCents: 800,
        taxRatePercent: 21,
        expiresInHours: 48
      })
    })

    const createRes = await handleDraftOrdersHttp(createReq, deps())
    expect(createRes?.status).toBe(201)
    const draft = (await createRes?.json()) as {
      id: string
      draftNumber: string
      status: string
      inventoryReserved: number
      paymentStatus: string
      expiresAt: string
      version: number
    }

    expect(draft.id).toBeDefined()
    expect(draft.status).toBe('draft')
    expect(draft.inventoryReserved).toBe(0) // No reservation indefinitely
    expect(draft.paymentStatus).toBe('unbilled') // No charge indefinitely
    expect(draft.expiresAt).toBe('2026-10-31T12:00:00Z')

    // 2. Submit for approval
    const submitReq = new Request('https://neteco.test/api/admin/draft-orders/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        draftOrderId: draft.id,
        expectedVersion: draft.version,
        notes: 'Solicitud de descuento comercial por volumen'
      })
    })
    const submitRes = await handleDraftOrdersHttp(submitReq, deps())
    expect(submitRes?.status).toBe(200)
    const submitted = (await submitRes?.json()) as { status: string; version: number }
    expect(submitted.status).toBe('pending_approval')

    // 3. Review: Approve draft order
    const reviewReq = new Request('https://neteco.test/api/admin/draft-orders/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        draftOrderId: draft.id,
        decision: 'approved',
        expectedVersion: submitted.version,
        notes: 'Aprobado descuento 10% por direccion comercial'
      })
    })
    const reviewRes = await handleDraftOrdersHttp(reviewReq, deps())
    expect(reviewRes?.status).toBe(200)
    const approved = (await reviewRes?.json()) as { status: string; version: number }
    expect(approved.status).toBe('approved')

    // 4. Convert to confirmed order
    const convertReq = new Request('https://neteco.test/api/admin/draft-orders/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        draftOrderId: draft.id,
        expectedVersion: approved.version,
        confirmedOrderId: 'ord-b2b-conf-999'
      })
    })
    const convertRes = await handleDraftOrdersHttp(convertReq, deps())
    expect(convertRes?.status).toBe(200)
    const converted = (await convertRes?.json()) as { status: string; convertedOrderId: string }
    expect(converted.status).toBe('converted')
    expect(converted.convertedOrderId).toBe('ord-b2b-conf-999')

    // 5. Retrieve draft with complete timeline
    const getReq = new Request(`https://neteco.test/api/admin/draft-orders/${draft.id}`, {
      method: 'GET',
      headers: { cookie: adminCookie }
    })
    const getRes = await handleDraftOrdersHttp(getReq, deps())
    expect(getRes?.status).toBe(200)
    const retrieved = (await getRes?.json()) as { timeline: Array<{ eventType: string }> }
    expect(retrieved.timeline.map((e) => e.eventType)).toEqual([
      'created',
      'submitted_for_approval',
      'approved',
      'converted'
    ])
  })

  it('rejects conversion of expired draft orders (410)', async () => {
    // Create draft order expiring in 1 hour
    const createReq = new Request('https://neteco.test/api/admin/draft-orders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        customerId: 'cust-b2b-stale',
        companyName: 'Stale Draft SL',
        contactEmail: 'stale@test.es',
        items: [{ variantId: 'v1', sku: 'S1', name: 'N1', quantity: 1, unitPriceCents: 500, lineTotalCents: 500 }],
        expiresInHours: 1
      })
    })
    const createRes = await handleDraftOrdersHttp(createReq, deps())
    const draft = (await createRes?.json()) as { id: string; version: number }

    // Approve it immediately
    const submitReq = new Request('https://neteco.test/api/admin/draft-orders/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ draftOrderId: draft.id, expectedVersion: draft.version })
    })
    const submitRes = await handleDraftOrdersHttp(submitReq, deps())
    const submitted = (await submitRes?.json()) as { version: number }

    const approveReq = new Request('https://neteco.test/api/admin/draft-orders/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ draftOrderId: draft.id, decision: 'approved', expectedVersion: submitted.version })
    })
    const approveRes = await handleDraftOrdersHttp(approveReq, deps())
    const approved = (await approveRes?.json()) as { version: number }

    // Fast-forward time past expiration
    const threeHoursLaterDeps: DraftOrdersHttpDependencies = {
      ...deps(),
      now: () => '2026-10-29T15:00:00Z'
    }

    // Sweep expired
    const sweepReq = new Request('https://neteco.test/api/admin/draft-orders/sweep', {
      method: 'POST',
      headers: { cookie: adminCookie }
    })
    const sweepRes = await handleDraftOrdersHttp(sweepReq, threeHoursLaterDeps)
    expect(sweepRes?.status).toBe(200)

    // Attempt to convert -> 410 draft_order_expired
    const convertReq = new Request('https://neteco.test/api/admin/draft-orders/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        draftOrderId: draft.id,
        expectedVersion: approved.version,
        confirmedOrderId: 'ord-fail-after-expiry'
      })
    })
    const convertRes = await handleDraftOrdersHttp(convertReq, threeHoursLaterDeps)
    expect(convertRes?.status).toBe(410)
    const errBody = await convertRes?.json()
    expect(errBody).toEqual({ error: { code: 'draft_order_expired' } })
  })
})
