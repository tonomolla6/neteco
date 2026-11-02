import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleCustomerRecurringListsHttp,
  ownsCustomerRecurringListsNamespace
} from '../../workers/catalog/customer-recurring-lists-http'

const NOW = '2026-10-29T10:00:00Z'
const CUSTOMER_A = '30000000-0000-4000-8000-000000000001'
const CUSTOMER_B = '30000000-0000-4000-8000-000000000002'
const CUSTOMER_C = '30000000-0000-4000-8000-000000000003'
const OWNER_IDENTITY = '10000000-0000-4000-8000-000000000001'
const COLLAB_IDENTITY = '10000000-0000-4000-8000-000000000002'
const OTHER_IDENTITY = '10000000-0000-4000-8000-000000000003'
const SESSION_OWNER = '20000000-0000-4000-8000-000000000001'
const SESSION_COLLAB = '20000000-0000-4000-8000-000000000002'
const SESSION_OTHER = '20000000-0000-4000-8000-000000000003'

const config = { password: randomBytes(32).toString('hex'), maxAgeSeconds: 3600 }

describe('CUS-018: Customer Recurring Lists HTTP API', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let ownerCookie: string
  let collabCookie: string
  let otherCookie: string
  let publication: Awaited<ReturnType<typeof provisionPublicationValidityFixture>>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    sqlite.exec(await readFile('db/d1/migrations/0108_b2b_shared_lists_edi_scoring.sql', 'utf8'))
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    publication = await provisionPublicationValidityFixture(database, {
      productIds: ['p-1', 'p-2', 'p-3'],
      now: NOW
    })

    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(CUSTOMER_A, NOW, NOW)
    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(CUSTOMER_B, NOW, NOW)
    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(CUSTOMER_C, NOW, NOW)

    for (const [id, email, cust, sess] of [
      [OWNER_IDENTITY, 'owner@example.invalid', CUSTOMER_A, SESSION_OWNER],
      [COLLAB_IDENTITY, 'collab@example.invalid', CUSTOMER_C, SESSION_COLLAB],
      [OTHER_IDENTITY, 'other@example.invalid', CUSTOMER_B, SESSION_OTHER]
    ]) {
      sqlite
        .prepare(
          `INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
           VALUES (?, ?, 'synthetic', ?, 'active', ?, ?, ?)`
        )
        .run(id, email, NOW, cust, NOW, NOW)
      sqlite
        .prepare(
          `INSERT INTO auth_sessions(id, identity_id, session_version, created_at, expires_at)
           VALUES (?, ?, 1, '2026-10-29T08:00:00Z', '2026-10-29T12:00:00Z')`
        )
        .run(sess, id)
    }

    ownerCookie = (await issueD1SessionCookie(
      database,
      { sessionId: SESSION_OWNER, identityId: OWNER_IDENTITY, sessionVersion: 1 },
      config
    ))!
    collabCookie = (await issueD1SessionCookie(
      database,
      { sessionId: SESSION_COLLAB, identityId: COLLAB_IDENTITY, sessionVersion: 1 },
      config
    ))!
    otherCookie = (await issueD1SessionCookie(
      database,
      { sessionId: SESSION_OTHER, identityId: OTHER_IDENTITY, sessionVersion: 1 },
      config
    ))!
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reconoce el namespace de listas recurrentes', () => {
    expect(ownsCustomerRecurringListsNamespace('/api/account/recurring-lists')).toBe(true)
    expect(ownsCustomerRecurringListsNamespace('/api/account/recurring-lists/123/revalidate')).toBe(true)
    expect(ownsCustomerRecurringListsNamespace('/api/account/orders')).toBe(false)
  })

  it('exige autenticación válida rechazando peticiones anónimas con 401', async () => {
    const req = new Request('https://neteco.invalid/api/account/recurring-lists', {
      method: 'GET'
    })
    const res = await handleCustomerRecurringListsHttp(req, {
      database,
      sessionCookieConfiguration: config
    })
    expect(res).not.toBeNull()
    expect(res?.status).toBe(401)
  })

  it('permite crear, consultar y listar listas recurrentes vía HTTP', async () => {
    const createReq = new Request('https://neteco.invalid/api/account/recurring-lists', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: ownerCookie
      },
      body: JSON.stringify({
        name: 'Químicos Cocina',
        description: 'Desengrasantes y detergentes industriales',
        frequency: 'monthly',
        nextSuggestedDate: '2026-11-29'
      })
    })

    const createRes = await handleCustomerRecurringListsHttp(createReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(createRes?.status).toBe(201)
    const listData = (await createRes?.json()) as { ok: boolean; list: { id: string; name: string } }
    expect(listData.ok).toBe(true)
    expect(listData.list.name).toBe('Químicos Cocina')

    // List all
    const listReq = new Request('https://neteco.invalid/api/account/recurring-lists', {
      headers: { cookie: ownerCookie }
    })
    const listRes = await handleCustomerRecurringListsHttp(listReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(listRes?.status).toBe(200)
    const lists = (await listRes?.json()) as { lists: Array<{ id: string }> }
    expect(lists.lists).toHaveLength(1)

    // Get detail
    const getReq = new Request(`https://neteco.invalid/api/account/recurring-lists/${listData.list.id}`, {
      headers: { cookie: ownerCookie }
    })
    const getRes = await handleCustomerRecurringListsHttp(getReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(getRes?.status).toBe(200)
    const detail = (await getRes?.json()) as { list: { id: string; isOwner: boolean } }
    expect(detail.list.isOwner).toBe(true)
  })

  it('gestiona colaboradores e ítems a través de endpoints REST', async () => {
    // 1. Create list
    const createReq = new Request('https://neteco.invalid/api/account/recurring-lists', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: ownerCookie
      },
      body: JSON.stringify({
        name: 'Lavandería Central',
        frequency: 'weekly'
      })
    })
    const createRes = await handleCustomerRecurringListsHttp(createReq, {
      database,
      sessionCookieConfiguration: config
    })
    const { list } = (await createRes?.json()) as { list: { id: string } }

    // 2. Add collaborator
    const collabReq = new Request(`https://neteco.invalid/api/account/recurring-lists/${list.id}/collaborators`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: ownerCookie
      },
      body: JSON.stringify({
        email: 'collab@example.invalid',
        role: 'editor'
      })
    })
    const collabRes = await handleCustomerRecurringListsHttp(collabReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(collabRes?.status).toBe(200)

    // 3. Collab can add items
    const variantId = 'v-1-1'
    const itemReq = new Request(`https://neteco.invalid/api/account/recurring-lists/${list.id}/items`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: collabCookie
      },
      body: JSON.stringify({
        variantId,
        quantity: 4,
        expectedUnitGrossCents: 1200
      })
    })
    const itemRes = await handleCustomerRecurringListsHttp(itemReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(itemRes?.status).toBe(200)

    // 4. Revalidate
    const revalReq = new Request(`https://neteco.invalid/api/account/recurring-lists/${list.id}/revalidate`, {
      headers: { cookie: ownerCookie }
    })
    const revalRes = await handleCustomerRecurringListsHttp(revalReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(revalRes?.status).toBe(200)
    const revalData = (await revalRes?.json()) as { report: { allAvailable: boolean; itemCount: number } }
    expect(revalData.report.itemCount).toBe(1)
    expect(revalData.report.allAvailable).toBe(true)

    // 5. Replenish
    const repReq = new Request(`https://neteco.invalid/api/account/recurring-lists/${list.id}/replenish`, {
      method: 'POST',
      headers: { cookie: ownerCookie }
    })
    const repRes = await handleCustomerRecurringListsHttp(repReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(repRes?.status).toBe(200)
  })

  it('deniega acceso a usuarios de otros clientes con 403', async () => {
    const createReq = new Request('https://neteco.invalid/api/account/recurring-lists', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: ownerCookie
      },
      body: JSON.stringify({
        name: 'Secreta',
        frequency: 'weekly'
      })
    })
    const createRes = await handleCustomerRecurringListsHttp(createReq, {
      database,
      sessionCookieConfiguration: config
    })
    const { list } = (await createRes?.json()) as { list: { id: string } }

    const badReq = new Request(`https://neteco.invalid/api/account/recurring-lists/${list.id}`, {
      headers: { cookie: otherCookie }
    })
    const badRes = await handleCustomerRecurringListsHttp(badReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(badRes?.status).toBe(403)
  })
})
