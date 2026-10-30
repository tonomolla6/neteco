import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'

export const FIXTURE_NOW = '2026-10-29T12:00:00Z'
export const TEST_ORIGIN = 'https://shop.neteco.invalid'
export const SESSION_PASSWORD = 'k'.repeat(64)

export const ADMIN_IDENTITY = '10000000-0000-4000-8000-000000000001'
export const CONTENT_MGR_IDENTITY = '10000000-0000-4000-8000-000000000002'
export const ORDER_MGR_IDENTITY = '10000000-0000-4000-8000-000000000003'
export const WAREHOUSE_OP_IDENTITY = '10000000-0000-4000-8000-000000000004'
export const MKT_MGR_IDENTITY = '10000000-0000-4000-8000-000000000005'
export const UNPRIVILEGED_IDENTITY = '10000000-0000-4000-8000-000000000009'

export interface BaTestWorld {
  sqlite: DatabaseSync
  db: D1Database
  close: () => void
}

export async function createBaTestWorld(): Promise<BaTestWorld> {
  const sqlite = await openMigratedDatabase()
  try {
    const migrationSql = await readFile(
      'db/d1/migrations/0131_preview_diff_role_dashboards_campaign_manager.sql',
      'utf8'
    )
    sqlite.exec(migrationSql)

    sqlite.exec('PRAGMA foreign_keys = OFF;')

    const makeIdentity = (id: string, email: string) =>
      `INSERT OR IGNORE INTO identities(id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at)
       VALUES('${id}', '${email}', 'synthetic_hash', '${FIXTURE_NOW}', 'active', 1, '${FIXTURE_NOW}', '${FIXTURE_NOW}');`

    const makeSession = (sessionId: string, identityId: string) =>
      `INSERT OR IGNORE INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
       VALUES('${sessionId}', '${identityId}', 1, 1, '${FIXTURE_NOW}', '2099-12-31T23:59:59Z');
       INSERT OR IGNORE INTO identity_mfa(identity_id, verified_at, updated_at)
       VALUES('${identityId}', '${FIXTURE_NOW}', '${FIXTURE_NOW}');`

    sqlite.exec(`
      ${makeIdentity(ADMIN_IDENTITY, 'admin@neteco.es')}
      ${makeIdentity(CONTENT_MGR_IDENTITY, 'content@neteco.es')}
      ${makeIdentity(ORDER_MGR_IDENTITY, 'orders@neteco.es')}
      ${makeIdentity(WAREHOUSE_OP_IDENTITY, 'warehouse@neteco.es')}
      ${makeIdentity(MKT_MGR_IDENTITY, 'marketing@neteco.es')}
      ${makeIdentity(UNPRIVILEGED_IDENTITY, 'unprivileged@neteco.es')}

      ${makeSession('20000000-0000-4000-8000-000000000001', ADMIN_IDENTITY)}
      ${makeSession('20000000-0000-4000-8000-000000000002', CONTENT_MGR_IDENTITY)}
      ${makeSession('20000000-0000-4000-8000-000000000003', ORDER_MGR_IDENTITY)}
      ${makeSession('20000000-0000-4000-8000-000000000004', WAREHOUSE_OP_IDENTITY)}
      ${makeSession('20000000-0000-4000-8000-000000000005', MKT_MGR_IDENTITY)}
      ${makeSession('20000000-0000-4000-8000-000000000009', UNPRIVILEGED_IDENTITY)}

      INSERT OR IGNORE INTO roles(code, name, description) VALUES
        ('admin', 'Administrador', 'Synthetic admin'),
        ('content_manager', 'Gestor de Contenido', 'Synthetic content manager'),
        ('order_manager', 'Gestor de Pedidos', 'Synthetic order manager'),
        ('warehouse_operator', 'Operador de Almacén', 'Synthetic warehouse operator'),
        ('marketing_manager', 'Gestor Comercial', 'Synthetic marketing manager');

      INSERT OR IGNORE INTO permissions(code, resource, action, description) VALUES
        ('administration.manage', 'administration', 'manage', 'Admin manage'),
        ('content.preview', 'content', 'preview', 'CMS preview comparison'),
        ('content.write', 'content', 'write', 'CMS draft writing'),
        ('campaigns.manage', 'campaigns', 'manage', 'Commercial campaigns management'),
        ('dashboard.configure', 'dashboard', 'configure', 'Dashboard layout config');

      INSERT OR IGNORE INTO role_permissions(role_code, permission_code) VALUES
        ('admin', 'administration.manage'),
        ('admin', 'content.preview'),
        ('admin', 'campaigns.manage'),
        ('admin', 'dashboard.configure'),
        ('content_manager', 'content.preview'),
        ('content_manager', 'content.write'),
        ('order_manager', 'dashboard.configure'),
        ('marketing_manager', 'campaigns.manage'),
        ('marketing_manager', 'dashboard.configure');

      INSERT OR IGNORE INTO identity_roles(identity_id, role_code, granted_at) VALUES
        ('${ADMIN_IDENTITY}', 'admin', '${FIXTURE_NOW}'),
        ('${CONTENT_MGR_IDENTITY}', 'content_manager', '${FIXTURE_NOW}'),
        ('${ORDER_MGR_IDENTITY}', 'order_manager', '${FIXTURE_NOW}'),
        ('${WAREHOUSE_OP_IDENTITY}', 'warehouse_operator', '${FIXTURE_NOW}'),
        ('${MKT_MGR_IDENTITY}', 'marketing_manager', '${FIXTURE_NOW}');
    `)

    sqlite.exec('PRAGMA foreign_keys = ON;')
    const db = d1OverSqlite(sqlite)
    return {
      sqlite,
      db,
      close: () => {
        try {
          sqlite.close()
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    sqlite.close()
    throw err
  }
}
