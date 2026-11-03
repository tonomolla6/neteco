import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import {
  convertDraftOrderToConfirmed,
  createDraftOrder,
  reviewDraftOrder,
  submitDraftOrderForApproval
} from '../../workers/b2b/draft-orders'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-0000000000c1',
  sessionId: '20000000-0000-4000-8000-0000000000c1',
  sessionVersion: 1
}
const ITEM = {
  variantId: 'v1',
  sku: 'CLR-25',
  name: 'Cloro 25L',
  quantity: 10,
  unitPriceCents: 3200,
  lineTotalCents: 32000
}
const INPUT = {
  commandId: 'test-draft-command',
  customerId: 'cust-1',
  companyName: 'Hospital Mar SL',
  contactEmail: 'compras@example.invalid',
  items: [ITEM],
  taxRatePercent: 21,
  expiresInHours: 48
}

describe('CHK-022: integridad de importes y escrituras atómicas', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.exec(
      await readFile(
        new URL('../../db/d1/migrations/0133_supplier_feed_editorial_sourcing_draft_orders.sql', import.meta.url),
        'utf8'
      )
    )
    sqlite.exec(`
      INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin','Administrador','x');
      INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES ('orders.manage','orders','manage','x');
      INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES ('admin','orders.manage');
      INSERT INTO identities (id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES ('${ADMIN.identityId}','c1@example.invalid','h','${NOW}','active','${NOW}','${NOW}');
      INSERT INTO auth_sessions (id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES ('${ADMIN.sessionId}','${ADMIN.identityId}',1,1,'${NOW}','2099-01-01T00:00:00Z');
      INSERT INTO identity_roles (identity_id, role_code, granted_at) VALUES ('${ADMIN.identityId}','admin','${NOW}');
    `)
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => sqlite.close())

  /** Runs `interfere` right after the first read of draft_orders: a concurrent writer wins the CAS. */
  function racing(interfere: () => void): D1Database {
    let fired = false
    const wrap = (statement: ReturnType<D1Database['prepare']>, sql: string): ReturnType<D1Database['prepare']> =>
      ({
        sql,
        bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
        first: async (...values: unknown[]) => {
          const row = await (statement as unknown as { first(...a: unknown[]): Promise<unknown> }).first(...values)
          if (!fired && /FROM draft_orders/i.test(sql) && /^\s*SELECT/i.test(sql)) {
            fired = true
            interfere()
          }
          return row
        },
        all: (...values: unknown[]) =>
          (statement as unknown as { all(...a: unknown[]): Promise<unknown> }).all(...values),
        run: (...values: unknown[]) =>
          (statement as unknown as { run(...a: unknown[]): Promise<unknown> }).run(...values)
      }) as never
    return {
      prepare: (sql: string) => wrap(db.prepare(sql), sql),
      batch: (statements: never[]) => db.batch(statements)
    } as unknown as D1Database
  }

  it('rechaza líneas cuyo total no es cantidad por precio unitario', async () => {
    await expect(
      createDraftOrder(db, ADMIN, { ...INPUT, items: [{ ...ITEM, lineTotalCents: 1 }] }, { now: NOW })
    ).rejects.toThrow()
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM draft_orders').get()).toEqual({ n: 0 })
  })

  async function approvedDraft() {
    const created = await createDraftOrder(db, ADMIN, INPUT, { now: NOW })
    const submitted = await submitDraftOrderForApproval(
      db,
      ADMIN,
      { draftOrderId: created.id, expectedVersion: created.version },
      { now: NOW }
    )
    return reviewDraftOrder(
      db,
      ADMIN,
      { draftOrderId: created.id, expectedVersion: submitted.version, decision: 'approved' },
      { now: NOW }
    )
  }

  it('una conversión que pierde la carrera de versión no deja evento ni cambia el pedido', async () => {
    const approved = await approvedDraft()
    const before = sqlite.prepare('SELECT COUNT(*) AS n FROM draft_order_timeline').get() as { n: number }
    const loser = racing(() =>
      sqlite.exec(`UPDATE draft_orders SET status='cancelled', version=version+1 WHERE id='${approved.id}'`)
    )
    await expect(
      convertDraftOrderToConfirmed(
        loser,
        ADMIN,
        { draftOrderId: approved.id, expectedVersion: approved.version, confirmedOrderId: 'ord-1' },
        { now: NOW }
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    const after = sqlite.prepare('SELECT COUNT(*) AS n FROM draft_order_timeline').get() as { n: number }
    expect(after.n).toBe(before.n)
    expect(sqlite.prepare('SELECT status, converted_order_id FROM draft_orders').get()).toEqual({
      status: 'cancelled',
      converted_order_id: null
    })
  })

  it('una revisión que pierde la carrera tampoco deja evento de línea de tiempo', async () => {
    const created = await createDraftOrder(db, ADMIN, INPUT, { now: NOW })
    const submitted = await submitDraftOrderForApproval(
      db,
      ADMIN,
      { draftOrderId: created.id, expectedVersion: created.version },
      { now: NOW }
    )
    const before = sqlite.prepare('SELECT COUNT(*) AS n FROM draft_order_timeline').get() as { n: number }
    const loser = racing(() =>
      sqlite.exec(`UPDATE draft_orders SET status='rejected', version=version+1 WHERE id='${created.id}'`)
    )
    await expect(
      reviewDraftOrder(
        loser,
        ADMIN,
        { draftOrderId: created.id, expectedVersion: submitted.version, decision: 'approved' },
        { now: NOW }
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    const after = sqlite.prepare('SELECT COUNT(*) AS n FROM draft_order_timeline').get() as { n: number }
    expect(after.n).toBe(before.n)
  })
})
