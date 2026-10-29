import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'

export const NOW = '2026-10-29T12:00:00Z'
export const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
export const OTHER_ADMIN_ID = '10000000-0000-4000-8000-000000000004'
export const NOPERMS_ID = '10000000-0000-4000-8000-000000000002'
export const NOMFA_ID = '10000000-0000-4000-8000-000000000003'
const session = (n: number) => `20000000-0000-4000-8000-00000000000${n}`
export const ADMIN = { identityId: ADMIN_ID, sessionId: session(1), sessionVersion: 1 }
export const NOPERMS = { identityId: NOPERMS_ID, sessionId: session(2), sessionVersion: 1 }
export const NOMFA = { identityId: NOMFA_ID, sessionId: session(3), sessionVersion: 1 }
export const OTHER_ADMIN = { identityId: OTHER_ADMIN_ID, sessionId: session(4), sessionVersion: 1 }

let counter = 0
export const uuid = () => `70000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

export async function setupPerformanceInsightsDb(): Promise<{ sqlite: DatabaseSync; db: D1Database }> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0128_aiops_third_party_b2b_cache_edge_personalization.sql', import.meta.url),
      'utf8'
    )
  )
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin', 'Administración', 'Fixture'), ('operator', 'Operador', 'Fixture');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES ('administration.manage', 'administration', 'manage', 'Fixture');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES ('admin', 'administration.manage');
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, email_verified_at, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-perf@example.invalid', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}'),
      ('${OTHER_ADMIN_ID}', 'admin2-perf@example.invalid', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}'),
      ('${NOPERMS_ID}', 'operator-perf@example.invalid', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}'),
      ('${NOMFA_ID}', 'nomfa-perf@example.invalid', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'), ('${OTHER_ADMIN_ID}', 'admin', '${NOW}'), ('${NOMFA_ID}', 'admin', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN.sessionId}', '${ADMIN_ID}', 1, 1, '2026-10-29T11:00:00Z', '2026-11-29T12:00:00Z'),
      ('${NOPERMS.sessionId}', '${NOPERMS_ID}', 1, 1, '2026-10-29T11:00:00Z', '2026-11-29T12:00:00Z'),
      ('${NOMFA.sessionId}', '${NOMFA_ID}', 1, 0, '2026-10-29T11:00:00Z', '2026-11-29T12:00:00Z'),
      ('${OTHER_ADMIN.sessionId}', '${OTHER_ADMIN_ID}', 1, 1, '2026-10-29T11:00:00Z', '2026-11-29T12:00:00Z');
  `)
  return { sqlite, db: d1OverSqlite(sqlite) }
}

export const claimsResolver = async (request: Request) => {
  switch (request.headers.get('x-test-session')) {
    case 'admin':
      return ADMIN
    case 'other':
      return OTHER_ADMIN
    case 'noperms':
      return NOPERMS
    case 'nomfa':
      return NOMFA
    default:
      return null
  }
}

export function post(url: string, body: unknown, session = 'admin', extra: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-session': session, ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}
export function get(url: string, session = 'admin'): Request {
  return new Request(url, { headers: { 'x-test-session': session } })
}
