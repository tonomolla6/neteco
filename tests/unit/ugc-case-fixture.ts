import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'

export const NOW = '2026-10-29T10:00:00Z'
export const ADMIN_IDENTITY = 'admin-ugc-1'
export const CUSTOMER_IDENTITY = 'cust-ugc-1'
export const CUSTOMER_IDENTITY_2 = 'cust-ugc-2'
export const OTHER_IDENTITY = 'other-ugc-1'

export const PROD_1 = 'prod-limpiador-alcalino-5l'
export const PROD_2 = 'prod-desengrasante-taller-1l'
export const ORDER_1 = 'ord-2026-ugc-1'

export interface UgcCaseWorld {
  sqlite: DatabaseSync
  db: D1Database
  close: () => void
}

export async function createUgcCaseWorld(): Promise<UgcCaseWorld> {
  const sqlite = await openMigratedDatabase()
  try {
    // Apply migration 0124
    const migrationSql = await readFile('db/d1/migrations/0124_ugc_reviews_customer_success_cases.sql', 'utf8')
    sqlite.exec(migrationSql)

    sqlite.exec('PRAGMA foreign_keys = OFF')

    // Seed test identities
    const makeIdentity = (id: string, email: string) =>
      `INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
       VALUES('${id}', '${email}', 'synthetic_hash', '${NOW}', 'active', '${NOW}', '${NOW}');`

    sqlite.exec(`
      ${makeIdentity(ADMIN_IDENTITY, 'admin@neteco.es')}
      ${makeIdentity(CUSTOMER_IDENTITY, 'cliente1@taller.es')}
      ${makeIdentity(CUSTOMER_IDENTITY_2, 'cliente2@lavanderia.es')}
      ${makeIdentity(OTHER_IDENTITY, 'otro@empresa.es')}

      -- Seed admin role and permission
      INSERT OR IGNORE INTO roles(code, name, description) VALUES('admin', 'Administrador', 'Synthetic');
      INSERT OR IGNORE INTO permissions(code, resource, action, description) VALUES('administration.manage', 'administration', 'manage', 'Synthetic');
      INSERT OR IGNORE INTO role_permissions(role_code, permission_code) VALUES('admin', 'administration.manage');
      INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES('${ADMIN_IDENTITY}', 'admin', '${NOW}');

      -- Seed categories and products
      INSERT OR IGNORE INTO categories(id, name, slug) VALUES('cat-limpieza', 'Limpieza', 'limpieza');
      INSERT OR IGNORE INTO products(id, category_id, name, slug, description, status, created_at, updated_at) VALUES
        ('${PROD_1}', 'cat-limpieza', 'Limpiador Alcalino 5L', 'limpiador-alcalino-5l', 'Limpiador industrial', 'published', '${NOW}', '${NOW}'),
        ('${PROD_2}', 'cat-limpieza', 'Desengrasante Taller 1L', 'desengrasante-taller-1l', 'Desengrasante fuerte', 'published', '${NOW}', '${NOW}');

      -- Seed test order for verified buyer
      INSERT INTO orders (
        id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id,
        reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents,
        shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code,
        shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email,
        contact_email_hash, consent_tos, consent_privacy, correlation_id, customer_id, created_at, updated_at
      ) VALUES (
        '${ORDER_1}', 'cart-ugc-1', 'quote-ugc-1', 'ship-ugc-1', 'att-ugc-1', '${'0'.repeat(64)}', 'awaiting_payment', 'res-1', '2027-01-01T00:00:00Z', 'EUR',
        826, 174, 1000, 0, 0, 0, 'parcel', 1, 1, 2, 'cliente1@taller.es', '${'1'.repeat(64)}',
        1, 1, 'corr-ugc-1', '${CUSTOMER_IDENTITY}', '${NOW}', '${NOW}'
      );
    `)

    return {
      sqlite,
      db: d1OverSqlite(sqlite),
      close: () => sqlite.close()
    }
  } catch (error) {
    sqlite.close()
    throw error
  }
}
