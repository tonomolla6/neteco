import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleSupplierFeedHttp,
  ownsSupplierFeedNamespace,
  type SupplierFeedHttpDependencies
} from '../../workers/catalog/supplier-feed-comparison-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000018'
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
      ('${ADMIN_ID}', 'admin-feed-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${GUEST_ID}', 'guest-feed-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000018', '${ADMIN_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z'),
      ('20000000-0000-4000-8000-000000000099', '${GUEST_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${GUEST_ID}', 'guest', '${NOW}');
  `)

  return sqlite
}

describe('CAT-018: Supplier Feed Comparison HTTP Handlers', () => {
  let sqlite: DatabaseSync
  let d1: ReturnType<typeof d1OverSqlite>
  let adminCookie: string
  let guestCookie: string

  beforeEach(async () => {
    sqlite = await setupTestDb()
    d1 = d1OverSqlite(sqlite)

    const rawAdmin = await issueD1SessionCookie(
      d1,
      { identityId: ADMIN_ID, sessionId: '20000000-0000-4000-8000-000000000018', sessionVersion: 1 },
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

  const deps = (): SupplierFeedHttpDependencies => ({
    database: d1,
    origin: 'https://neteco.test',
    sessionCookieConfiguration: SESSION_CONFIG,
    now: () => NOW
  })

  it('recognizes namespace and ignores alien paths', () => {
    expect(ownsSupplierFeedNamespace('/api/admin/supplier-feed/stage')).toBe(true)
    expect(ownsSupplierFeedNamespace('/api/admin/supplier-feed/items')).toBe(true)
    expect(ownsSupplierFeedNamespace('/api/admin/products')).toBe(false)
  })

  it('returns 401 unauthenticated when cookie is missing', async () => {
    const req = new Request('https://neteco.test/api/admin/supplier-feed/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId: 'S1', feedName: 'F1', items: [] })
    })

    const res = await handleSupplierFeedHttp(req, deps())
    expect(res).not.toBeNull()
    expect(res?.status).toBe(401)
    const body = await res?.json()
    expect(body).toEqual({ error: { code: 'unauthenticated' } })
  })

  it('returns 403 forbidden when user lacks catalog.write', async () => {
    const req = new Request('https://neteco.test/api/admin/supplier-feed/stage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: guestCookie
      },
      body: JSON.stringify({
        supplierId: 'S1',
        feedName: 'F1',
        items: [{ supplierSku: 'SKU1', name: 'Prod 1', priceCents: 1000 }]
      })
    })

    const res = await handleSupplierFeedHttp(req, deps())
    expect(res?.status).toBe(403)
    const body = await res?.json()
    expect(body).toEqual({ error: { code: 'forbidden' } })
  })

  it('handles feed staging, review, listing, and application flow over HTTP', async () => {
    // 1. Stage feed
    const stageReq = new Request('https://neteco.test/api/admin/supplier-feed/stage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: adminCookie
      },
      body: JSON.stringify({
        supplierId: 'SUP-B2B-QUIM',
        feedName: 'Tarifa Octubre Quimicos',
        items: [
          {
            supplierSku: 'SKU-CLORO-25',
            name: 'Cloro Activo 25L',
            priceCents: 1950,
            leadTimeDays: 2,
            stockQuantity: 40
          }
        ]
      })
    })

    const stageRes = await handleSupplierFeedHttp(stageReq, deps())
    expect(stageRes?.status).toBe(201)
    const stageData = (await stageRes?.json()) as { importId: string; altasCount: number }
    expect(stageData.importId).toBeDefined()
    expect(stageData.altasCount).toBe(1)

    // 2. Get import summary
    const importReq = new Request(`https://neteco.test/api/admin/supplier-feed/import/${stageData.importId}`, {
      method: 'GET',
      headers: { cookie: adminCookie }
    })
    const importRes = await handleSupplierFeedHttp(importReq, deps())
    expect(importRes?.status).toBe(200)
    const importData = (await importRes?.json()) as { feedName: string }
    expect(importData.feedName).toBe('Tarifa Octubre Quimicos')

    // 3. List items for review
    const listReq = new Request(`https://neteco.test/api/admin/supplier-feed/items?importId=${stageData.importId}`, {
      method: 'GET',
      headers: { cookie: adminCookie }
    })
    const listRes = await handleSupplierFeedHttp(listReq, deps())
    expect(listRes?.status).toBe(200)
    const items = (await listRes?.json()) as Array<{ id: string; status: string; version: number }>
    expect(items).toHaveLength(1)
    expect(items[0].status).toBe('pending_review')

    // 4. Review item (CAS version mismatch fails 409)
    const conflictReq = new Request('https://neteco.test/api/admin/supplier-feed/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        itemId: items[0].id,
        decision: 'approved',
        expectedVersion: 999
      })
    })
    const conflictRes = await handleSupplierFeedHttp(conflictReq, deps())
    expect(conflictRes?.status).toBe(409)

    // 5. Review item with correct version (approves)
    const reviewReq = new Request('https://neteco.test/api/admin/supplier-feed/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        itemId: items[0].id,
        decision: 'approved',
        expectedVersion: items[0].version,
        reviewNotes: 'Precio y stock revisados'
      })
    })
    const reviewRes = await handleSupplierFeedHttp(reviewReq, deps())
    expect(reviewRes?.status).toBe(200)

    // 6. Apply approved item
    const applyReq = new Request('https://neteco.test/api/admin/supplier-feed/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        importId: stageData.importId,
        itemIds: [items[0].id]
      })
    })
    const applyRes = await handleSupplierFeedHttp(applyReq, deps())
    expect(applyRes?.status).toBe(200)
    const applyData = (await applyRes?.json()) as { appliedCount: number }
    expect(applyData.appliedCount).toBe(1)
  })

  it('rejects apply request when item is not approved (acceptance criterion)', async () => {
    // Stage an item
    const stageReq = new Request('https://neteco.test/api/admin/supplier-feed/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        supplierId: 'SUP-B2B-QUIM',
        feedName: 'Tarifa Test',
        items: [{ supplierSku: 'SKU-PENDING', name: 'Pendiente', priceCents: 500 }]
      })
    })
    const stageRes = await handleSupplierFeedHttp(stageReq, deps())
    const stageData = (await stageRes?.json()) as { importId: string }

    const listReq = new Request(`https://neteco.test/api/admin/supplier-feed/items?importId=${stageData.importId}`, {
      method: 'GET',
      headers: { cookie: adminCookie }
    })
    const listRes = await handleSupplierFeedHttp(listReq, deps())
    const items = (await listRes?.json()) as Array<{ id: string }>

    // Apply without review -> 422 with unreviewed_feed_cannot_publish
    const applyReq = new Request('https://neteco.test/api/admin/supplier-feed/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        importId: stageData.importId,
        itemIds: [items[0].id]
      })
    })
    const applyRes = await handleSupplierFeedHttp(applyReq, deps())
    expect(applyRes?.status).toBe(422)
    const applyData = await applyRes?.json()
    expect(applyData).toEqual({ error: { code: 'unreviewed_feed_cannot_publish' } })
  })
})
