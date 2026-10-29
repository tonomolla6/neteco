import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'

export const NOW = '2026-10-29T12:00:00Z'
export const ADMIN_ID = '10000000-0000-4000-8000-0000000000a1'
export const ADMIN_SESSION = '20000000-0000-4000-8000-0000000000a1'
export const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }
export const NO_MFA_ID = '10000000-0000-4000-8000-0000000000a2'
export const NO_MFA_SESSION = '20000000-0000-4000-8000-0000000000a2'
export const NO_MFA_CLAIMS = { identityId: NO_MFA_ID, sessionId: NO_MFA_SESSION, sessionVersion: 1 }
export const PLAIN_ID = '10000000-0000-4000-8000-0000000000a3'
export const PLAIN_SESSION = '20000000-0000-4000-8000-0000000000a3'
export const PLAIN_CLAIMS = { identityId: PLAIN_ID, sessionId: PLAIN_SESSION, sessionVersion: 1 }
export const CUSTOMER_ID = '30000000-0000-4000-8000-0000000000a1'

/** Migrated base + 0115 + admin (MFA), admin without MFA, and a role-less identity. */
export async function growthDatabase(): Promise<{ sqlite: DatabaseSync; db: D1Database }> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile(new URL('../../db/d1/migrations/0115_growth_offers.sql', import.meta.url), 'utf8'))
  return { sqlite, db: d1OverSqlite(sqlite) }
}

export function seedGrowthIdentities(sqlite: DatabaseSync) {
  const t = '2026-01-01T00:00:00Z'
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin', 'Administración', 'Fixture');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES ('administration.manage', 'administration', 'manage', 'Fixture');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES ('admin', 'administration.manage');
  `)
  for (const [id, session, mfa, role, mail] of [
    [ADMIN_ID, ADMIN_SESSION, 1, true, 'admin'],
    [NO_MFA_ID, NO_MFA_SESSION, 0, true, 'nomfa'],
    [PLAIN_ID, PLAIN_SESSION, 1, false, 'plain']
  ] as const) {
    sqlite
      .prepare(
        `INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
         VALUES (?, ?, 'fixture-hash', 'active', 1, ?, ?, ?)`
      )
      .run(id, `${mail}@neteco.test`, t, t, t)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
         VALUES (?, ?, 1, ?, ?, '2027-01-01T00:00:00Z')`
      )
      .run(session, id, mfa, t)
    if (role)
      sqlite
        .prepare(`INSERT INTO identity_roles (identity_id, role_code, granted_at) VALUES (?, 'admin', ?)`)
        .run(id, t)
  }
  sqlite
    .prepare(
      `INSERT INTO customers (id, name, status, created_at, updated_at) VALUES (?, 'Cliente Test', 'active', ?, ?)`
    )
    .run(CUSTOMER_ID, t, t)
}
