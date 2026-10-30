import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleSupplierSourcingHttp,
  ownsSupplierSourcingNamespace,
  type SupplierSourcingHttpDependencies
} from '../../workers/catalog/supplier-sourcing-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000021'
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
      ('catalog.write', 'catalog', 'write', 'Edición catálogo');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'catalog.write');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-sourcing-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${GUEST_ID}', 'guest-sourcing-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000021', '${ADMIN_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z'),
      ('20000000-0000-4000-8000-000000000099', '${GUEST_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${GUEST_ID}', 'guest', '${NOW}');
  `)

  return sqlite
}

describe('CAT-021: Multi-Supplier Sourcing HTTP Handlers', () => {
  let sqlite: DatabaseSync
  let d1: ReturnType<typeof d1OverSqlite>
  let adminCookie: string
  let guestCookie: string

  beforeEach(async () => {
    sqlite = await setupTestDb()
    d1 = d1OverSqlite(sqlite)

    const rawAdmin = await issueD1SessionCookie(
      d1,
      { identityId: ADMIN_ID, sessionId: '20000000-0000-4000-8000-000000000021', sessionVersion: 1 },
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

  const deps = (): SupplierSourcingHttpDependencies => ({
    database: d1,
    origin: 'https://neteco.test',
    sessionCookieConfiguration: SESSION_CONFIG,
    now: () => NOW
  })

  it('checks namespace correctly', () => {
    expect(ownsSupplierSourcingNamespace('/api/admin/supplier-sourcing/supplier')).toBe(true)
    expect(ownsSupplierSourcingNamespace('/api/admin/supplier-sourcing/decision')).toBe(true)
    expect(ownsSupplierSourcingNamespace('/api/admin/catalog')).toBe(false)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const req = new Request('https://neteco.test/api/admin/supplier-sourcing/supplier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'SUP1', name: 'Sup 1' })
    })

    const res = await handleSupplierSourcingHttp(req, deps())
    expect(res?.status).toBe(401)
  })

  it('rejects requests without permissions with 403', async () => {
    const req = new Request('https://neteco.test/api/admin/supplier-sourcing/supplier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: guestCookie },
      body: JSON.stringify({ code: 'SUP-FAIL', name: 'Sup Fail' })
    })

    const res = await handleSupplierSourcingHttp(req, deps())
    expect(res?.status).toBe(403)
  })

  it('executes multi-supplier sourcing workflow over HTTP: create suppliers, offerings, select sourcing and list decisions', async () => {
    // 1. Create Supplier 1
    const sup1Req = new Request('https://neteco.test/api/admin/supplier-sourcing/supplier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        code: 'SUP-CHEM-01',
        name: 'Química Industrial del Sur',
        leadTimeDaysDefault: 2,
        reliabilityScore: 96
      })
    })
    const sup1Res = await handleSupplierSourcingHttp(sup1Req, deps())
    expect(sup1Res?.status).toBe(201)
    const sup1 = (await sup1Res?.json()) as { id: string }

    // 2. Create Supplier 2
    const sup2Req = new Request('https://neteco.test/api/admin/supplier-sourcing/supplier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        code: 'SUP-CHEM-02',
        name: 'Distribuidor Express Ibérica',
        leadTimeDaysDefault: 1,
        reliabilityScore: 90
      })
    })
    const sup2Res = await handleSupplierSourcingHttp(sup2Req, deps())
    expect(sup2Res?.status).toBe(201)
    const sup2 = (await sup2Res?.json()) as { id: string }

    const variantId = 'var-desengrasante-10l'
    const productId = 'prod-desengrasante'

    // 3. Upsert Offering from Supplier 1 (cheaper, longer lead)
    const off1Req = new Request('https://neteco.test/api/admin/supplier-sourcing/offering', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        supplierId: sup1.id,
        productId,
        variantId,
        supplierSku: 'QIS-10L',
        costCents: 1500, // 15.00€
        leadTimeDays: 4,
        isPreferred: 0
      })
    })
    const off1Res = await handleSupplierSourcingHttp(off1Req, deps())
    expect(off1Res?.status).toBe(200)

    // 4. Upsert Offering from Supplier 2 (more expensive, faster)
    const off2Req = new Request('https://neteco.test/api/admin/supplier-sourcing/offering', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        supplierId: sup2.id,
        productId,
        variantId,
        supplierSku: 'DEI-10L',
        costCents: 1800, // 18.00€
        leadTimeDays: 1,
        isPreferred: 1
      })
    })
    const off2Res = await handleSupplierSourcingHttp(off2Req, deps())
    expect(off2Res?.status).toBe(200)

    // 5. List offerings
    const listOffReq = new Request(`https://neteco.test/api/admin/supplier-sourcing/offerings?variantId=${variantId}`, {
      method: 'GET',
      headers: { cookie: adminCookie }
    })
    const listOffRes = await handleSupplierSourcingHttp(listOffReq, deps())
    expect(listOffRes?.status).toBe(200)
    const offerings = (await listOffRes?.json()) as Array<{ id: string }>
    expect(offerings).toHaveLength(2)

    // 6. Select sourcing decision with 'lowest_cost' strategy
    const decisionReq = new Request('https://neteco.test/api/admin/supplier-sourcing/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        variantId,
        retailPriceCents: 3000, // 30.00€ PVP
        strategy: 'lowest_cost',
        selectionReason: 'Optimización de coste para compra centralizada'
      })
    })
    const decisionRes = await handleSupplierSourcingHttp(decisionReq, deps())
    expect(decisionRes?.status).toBe(201)
    const decision = (await decisionRes?.json()) as {
      selectedSupplierId: string
      costCents: number
      marginCents: number
      marginPercent: number
      candidateOptions: unknown[]
    }

    expect(decision.selectedSupplierId).toBe(sup1.id)
    expect(decision.costCents).toBe(1500)
    expect(decision.marginCents).toBe(1500)
    expect(decision.marginPercent).toBe(50.0)
    expect(decision.candidateOptions.length).toBe(2)

    // 7. Get decision audit trail
    const trailReq = new Request(`https://neteco.test/api/admin/supplier-sourcing/decisions?variantId=${variantId}`, {
      method: 'GET',
      headers: { cookie: adminCookie }
    })
    const trailRes = await handleSupplierSourcingHttp(trailReq, deps())
    expect(trailRes?.status).toBe(200)
    const trail = (await trailRes?.json()) as Array<{ strategy: string; selectionReason: string }>
    expect(trail).toHaveLength(1)
    expect(trail[0].strategy).toBe('lowest_cost')
  })
})
