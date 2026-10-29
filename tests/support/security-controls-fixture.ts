import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase } from './d1-sqlite'

export const NOW = '2026-10-29T10:00:00Z'
export const PEPPER = 'test-pepper-0123456789-abcdefghijklmnop'
export const MASTER_KEY = 'test-master-key-0123456789-abcdefghijklmnop'
export const IDS = {
  customer: '30000000-0000-4000-8000-000000000001',
  company: '40000000-0000-4000-8000-000000000001',
  company2: '40000000-0000-4000-8000-000000000002',
  customer2: '30000000-0000-4000-8000-000000000002',
  admin: '10000000-0000-4000-8000-000000000001',
  plain: '10000000-0000-4000-8000-000000000002',
  worker1: '10000000-0000-4000-8000-000000000011',
  worker2: '10000000-0000-4000-8000-000000000012',
  shared: '10000000-0000-4000-8000-000000000013',
  disabled: '10000000-0000-4000-8000-000000000014',
  adminSession: '20000000-0000-4000-8000-000000000001',
  worker1Session: '20000000-0000-4000-8000-000000000011',
  worker2Session: '20000000-0000-4000-8000-000000000012',
  plainSession: '20000000-0000-4000-8000-000000000002'
}

export function uuid(n: number): string {
  return `99000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

export interface SecurityWorld {
  sqlite: DatabaseSync
  db: D1Database
}

/** Base schema plus only migration 0114 and a minimal synthetic population. */
export async function openSecurityControlsDatabase(): Promise<SecurityWorld> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile('db/d1/migrations/0114_security_keys_devices_abuse.sql', 'utf8'))
  const insertIdentity = sqlite.prepare(
    `INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
     VALUES (?, ?, 'synthetic', ?, ?, ?, ?)`
  )
  insertIdentity.run(IDS.admin, 'admin@neteco.invalid', NOW, 'active', NOW, NOW)
  insertIdentity.run(IDS.plain, 'cliente@neteco.invalid', NOW, 'active', NOW, NOW)
  insertIdentity.run(IDS.worker1, 'ana.lopez@neteco.invalid', NOW, 'active', NOW, NOW)
  insertIdentity.run(IDS.worker2, 'luis.perez@neteco.invalid', NOW, 'active', NOW, NOW)
  insertIdentity.run(IDS.shared, 'almacen@neteco.invalid', NOW, 'active', NOW, NOW)
  insertIdentity.run(IDS.disabled, 'baja.usuario@neteco.invalid', NOW, 'disabled', NOW, NOW)
  sqlite.exec(`
    INSERT INTO roles(code, name, description) VALUES('admin', 'Admin', 'Synthetic');
    INSERT INTO permissions(code, resource, action, description) VALUES('administration.manage', 'administration', 'manage', 'Synthetic');
    INSERT INTO role_permissions(role_code, permission_code) VALUES('admin', 'administration.manage');
    INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES('${IDS.admin}', 'admin', '${NOW}');
  `)
  for (const [identity, session] of [
    [IDS.admin, IDS.adminSession],
    [IDS.worker1, IDS.worker1Session],
    [IDS.worker2, IDS.worker2Session],
    [IDS.plain, IDS.plainSession]
  ]) {
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id, identity_id, session_version, created_at, expires_at)
         VALUES (?, ?, 1, '2026-10-29T08:00:00Z', '2026-10-29T14:00:00Z')`
      )
      .run(session, identity)
  }
  const insertCustomer = sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)')
  insertCustomer.run(IDS.customer, NOW, NOW)
  insertCustomer.run(IDS.customer2, NOW, NOW)
  const insertCompany = sqlite.prepare(
    `INSERT INTO companies(id, customer_id, legal_name, tax_id, country_code, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ES', ?, ?, ?)`
  )
  insertCompany.run(IDS.company, IDS.customer, 'Acme Industrial S.L.', 'B12345678', 'approved', NOW, NOW)
  insertCompany.run(IDS.company2, IDS.customer2, 'Pendiente S.L.', 'B87654321', 'pending', NOW, NOW)
  return { sqlite, db: d1OverSqlite(sqlite) }
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function dumpDatabaseText(sqlite: DatabaseSync, tables: string[]): string {
  return tables.map((table) => JSON.stringify(sqlite.prepare(`SELECT * FROM ${table}`).all())).join('\n')
}
