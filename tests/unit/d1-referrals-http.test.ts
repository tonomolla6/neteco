import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { handleReferralsHttp, ownsReferralsNamespace } from '../../workers/marketing/referrals-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const CUSTOMER_ID = '30000000-0000-4000-8000-000000000001'
const CUSTOMER_IDENTITY_ID = '10000000-0000-4000-8000-000000000011'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const sql = await readFile(
    new URL('../../db/d1/migrations/0112_bundles_referrals_events.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(sql)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin', 'Administrador', 'Fixture');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES ('administration.manage', 'administration', 'manage', 'Fixture');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES ('admin', 'administration.manage');
    INSERT OR IGNORE INTO customers (id, name, status, created_at, updated_at) VALUES ('${CUSTOMER_ID}', 'Empresa C', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO identities (id, customer_id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at) VALUES
      ('${ADMIN_ID}', NULL, 'admin@neteco.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}'),
      ('${CUSTOMER_IDENTITY_ID}', '${CUSTOMER_ID}', 'c@neteco.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES ('${ADMIN_ID}', 'admin', '${NOW}');

    INSERT OR IGNORE INTO referral_policies (
      id, version, is_active, terms_version, reward_cents, referee_discount_cents,
      min_order_cents, return_window_days, max_referrals_per_advocate, updated_at, updated_by
    ) VALUES (
      'global', 1, 1, 'terms-2026-v1', 1500, 1000, 5000, 14, 10, '${NOW}', '${ADMIN_ID}'
    );
  `)

  return sqlite
}

describe('Referrals HTTP Routing & Contracts', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite?.close()
  })

  it('matches ownsReferralsNamespace accurately', () => {
    expect(ownsReferralsNamespace('/api/account/referrals')).toBe(true)
    expect(ownsReferralsNamespace('/api/account/referrals/enroll')).toBe(true)
    expect(ownsReferralsNamespace('/api/admin/referrals/policy')).toBe(true)
    expect(ownsReferralsNamespace('/api/admin/referrals/settle')).toBe(true)
    expect(ownsReferralsNamespace('/api/catalog')).toBe(false)
  })

  it('GET /api/account/referrals returns 401 if unauthenticated', async () => {
    const req = new Request('https://tienda.neteco.test/api/account/referrals')
    const res = await handleReferralsHttp(req, { database: db, now: NOW })
    expect(res.status).toBe(401)
  })

  it('GET /api/admin/referrals/policy returns 401 without admin credentials', async () => {
    const req = new Request('https://tienda.neteco.test/api/admin/referrals/policy')
    const res = await handleReferralsHttp(req, { database: db, now: NOW })
    expect(res.status).toBe(401)
  })
})
