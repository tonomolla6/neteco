import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { createDraftOrder } from '../../workers/b2b/draft-orders'

const now = '2026-10-29T12:00:00Z'
const claims = {
  identityId: '10000000-0000-4000-8000-0000000000c1',
  sessionId: '20000000-0000-4000-8000-0000000000c1',
  sessionVersion: 1
}
const input = {
  commandId: 'draft-command-1',
  customerId: 'cust-1',
  companyName: 'Hospital Mar SL',
  contactEmail: 'compras@example.invalid',
  items: [
    { variantId: 'v1', sku: 'CLR-25', name: 'Cloro 25L', quantity: 10, unitPriceCents: 3200, lineTotalCents: 32000 }
  ],
  taxRatePercent: 21,
  expiresInHours: 48
}

let sqlite: DatabaseSync
let database: D1Database

beforeEach(async () => {
  sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile('db/d1/migrations/0133_supplier_feed_editorial_sourcing_draft_orders.sql', 'utf8'))
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin','Administrador','x');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES ('orders.manage','orders','manage','x');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES ('admin','orders.manage');
    INSERT INTO identities (id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES ('${claims.identityId}','c1@example.invalid','h','${now}','active','${now}','${now}');
    INSERT INTO auth_sessions (id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES ('${claims.sessionId}','${claims.identityId}',1,1,'${now}','2099-01-01T00:00:00Z');
    INSERT INTO identity_roles (identity_id, role_code, granted_at) VALUES ('${claims.identityId}','admin','${now}');
  `)
  database = d1OverSqlite(sqlite)
})

afterEach(() => sqlite.close())

describe('SECFIX-3 draft order creation idempotency', () => {
  it('requires a command ID even for direct callers and writes nothing when it is absent', async () => {
    const { commandId: _unused, ...withoutCommand } = input
    await expect(createDraftOrder(database, claims, withoutCommand as never, { now })).rejects.toMatchObject({
      code: 'invalid_input'
    })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM draft_orders').get()).toEqual({ n: 0 })
  })

  it('replays the same command without creating another order or timeline entry', async () => {
    const first = await createDraftOrder(database, claims, input, { now })
    const second = await createDraftOrder(database, claims, input, { now })
    expect(second.id).toBe(first.id)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM draft_orders').get()).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM draft_order_timeline').get()).toEqual({ n: 1 })
  })

  it('rejects reuse of a command with a different payload without a second order', async () => {
    await createDraftOrder(database, claims, input, { now })
    await expect(
      createDraftOrder(database, claims, { ...input, companyName: 'Otra empresa' }, { now })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM draft_orders').get()).toEqual({ n: 1 })
  })

  it('serializes concurrent retries of the same command', async () => {
    const [first, second] = await Promise.all([
      createDraftOrder(database, claims, input, { now }),
      createDraftOrder(database, claims, input, { now })
    ])
    expect(second.id).toBe(first.id)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM draft_orders').get()).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM draft_order_commands').get()).toEqual({ n: 1 })
  })

  it('does not store customer details in the command ledger', async () => {
    await createDraftOrder(database, claims, input, { now })
    const row = sqlite.prepare('SELECT input_json FROM draft_order_commands').get() as { input_json: string }
    expect(row.input_json).not.toContain(input.companyName)
    expect(row.input_json).not.toContain(input.contactEmail)
  })
})
