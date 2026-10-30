import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'

export const NOW = '2026-10-29T12:00:00Z'
export const ADMIN_IDENTITY = '10000000-0000-4000-8000-000000000001'
export const CUSTOMER_IDENTITY_1 = '20000000-0000-4000-8000-000000000001'
export const CUSTOMER_IDENTITY_2 = '20000000-0000-4000-8000-000000000002'
export const CUSTOMER_UNSUBSCRIBED = '20000000-0000-4000-8000-000000000003'
export const OTHER_IDENTITY = '30000000-0000-4000-8000-000000000001'

export const COMPANY_ID_1 = 'comp-turia-lavanderia'
export const COMPANY_ID_2 = 'comp-restaurante-med'

export const PROD_1 = 'prod-detergente-alcalino'
export const PROD_2 = 'prod-oxigeno-activo'
export const ORDER_1 = 'ord-b2b-turia-01'
export const ORDER_2 = 'ord-b2b-turia-02'

export interface LearningCampaignsWorld {
  sqlite: DatabaseSync
  db: D1Database
  close: () => void
}

export async function createLearningCampaignsWorld(): Promise<LearningCampaignsWorld> {
  const sqlite = await openMigratedDatabase()
  try {
    const migrationSql = await readFile('db/d1/migrations/0125_learning_campaigns_recurring_incentives.sql', 'utf8')
    sqlite.exec(migrationSql)

    sqlite.exec('PRAGMA foreign_keys = OFF')

    const makeIdentity = (id: string, email: string, customerId?: string) =>
      `INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
       VALUES('${id}', '${email}', 'synthetic_hash', '${NOW}', 'active', ${customerId ? `'${customerId}'` : 'NULL'}, '${NOW}', '${NOW}');`

    sqlite.exec(`
      -- Customers
      INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES
        ('${CUSTOMER_IDENTITY_1}', 'Elena Gómez', '+34600111222', 'active', '${NOW}', '${NOW}'),
        ('${CUSTOMER_IDENTITY_2}', 'Carlos Valls', '+34600333444', 'active', '${NOW}', '${NOW}'),
        ('${CUSTOMER_UNSUBSCRIBED}', 'Laura Soler', '+34600555666', 'active', '${NOW}', '${NOW}');

      -- Identities
      ${makeIdentity(ADMIN_IDENTITY, 'admin@neteco.es')}
      ${makeIdentity(CUSTOMER_IDENTITY_1, 'elena@turia.es', CUSTOMER_IDENTITY_1)}
      ${makeIdentity(CUSTOMER_IDENTITY_2, 'carlos@mediterraneo.es', CUSTOMER_IDENTITY_2)}
      ${makeIdentity(CUSTOMER_UNSUBSCRIBED, 'laura@baja.es', CUSTOMER_UNSUBSCRIBED)}
      ${makeIdentity(OTHER_IDENTITY, 'otro@empresa.es')}

      -- Roles & Permissions for Admin
      INSERT OR IGNORE INTO roles(code, name, description) VALUES('admin', 'Administrador', 'Synthetic');
      INSERT OR IGNORE INTO permissions(code, resource, action, description) VALUES('administration.manage', 'administration', 'manage', 'Synthetic');
      INSERT OR IGNORE INTO role_permissions(role_code, permission_code) VALUES('admin', 'administration.manage');
      INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES('${ADMIN_IDENTITY}', 'admin', '${NOW}');

      -- Companies
      INSERT INTO companies(id, customer_id, legal_name, trade_name, tax_id, country_code, status, created_at, updated_at) VALUES
        ('${COMPANY_ID_1}', '${CUSTOMER_IDENTITY_1}', 'Lavanderías Turia S.L.', 'Lavandería Turia', 'B98765432', 'ES', 'approved', '${NOW}', '${NOW}'),
        ('${COMPANY_ID_2}', '${CUSTOMER_IDENTITY_2}', 'Restaurante Mediterráneo S.A.', 'Restaurante Mediterráneo', 'A12345678', 'ES', 'approved', '${NOW}', '${NOW}');

      -- Newsletter Subscriptions & Consents
      INSERT INTO newsletter_subscriptions(id, email_normalized, email_hash, purpose, channel, status, consent_text, consent_version, consent_source, request_id, request_key, requested_at, confirmed_at, unsubscribed_at, confirmation_expires_at) VALUES
        ('sub-elena', 'elena@turia.es', 'e111111111111111111111111111111111111111111111111111111111111111', 'newsletter', 'email', 'confirmed', 'Acepto recibir comunicaciones comerciales', '2026-v1', 'web_checkout', 'req-sub-elena', 'key-sub-elena', 1700000000, 1700000005, NULL, 1700003600),
        ('sub-carlos', 'carlos@mediterraneo.es', 'e222222222222222222222222222222222222222222222222222222222222222', 'newsletter', 'email', 'confirmed', 'Acepto ofertas B2B', '2026-v1', 'portal_registration', 'req-sub-carlos', 'key-sub-carlos', 1700000000, 1700000006, NULL, 1700003600),
        ('sub-laura', 'laura@baja.es', 'e333333333333333333333333333333333333333333333333333333333333333', 'newsletter', 'email', 'unsubscribed', 'Acepto ofertas', '2026-v1', 'web_form', 'req-sub-laura', 'key-sub-laura', 1700000000, NULL, 1700000010, 1700003600);

      -- Suppressions
      INSERT INTO newsletter_suppressions(email_hash, channel, reason, source, created_at, updated_at) VALUES
        ('e333333333333333333333333333333333333333333333333333333333333333', 'email', 'unsubscribe', 'user_preference', 1700000010, 1700000010);

      -- Categories & Products
      INSERT OR IGNORE INTO categories(id, name, slug) VALUES('cat-industrial', 'Química Industrial', 'quimica-industrial');
      INSERT OR IGNORE INTO products(id, category_id, name, slug, description, status, created_at, updated_at) VALUES
        ('${PROD_1}', 'cat-industrial', 'Detergente Alcalino Concentrado 25L', 'detergente-alcalino-25l', 'Detergente alcalino alto rendimiento', 'published', '${NOW}', '${NOW}'),
        ('${PROD_2}', 'cat-industrial', 'Oxígeno Activo Desinfectante 20L', 'oxigeno-activo-20l', 'Blanqueante y desinfectante', 'published', '${NOW}', '${NOW}');

      -- Orders for B2B Volume & Incentives
      INSERT INTO orders (
        id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id,
        reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents,
        shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code,
        shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email,
        contact_email_hash, consent_tos, consent_privacy, correlation_id, customer_id, created_at, updated_at
      ) VALUES
        ('${ORDER_1}', 'cart-1', 'q-1', 'sq-1', 'att-1', '${'0'.repeat(64)}', 'awaiting_payment', 'res-1',
         '${NOW}', 'EUR', 1250000, 262500, 1512500, 0, 0, 0, 'std', 1, 1, 2, 'elena@turia.es',
         'e111111111111111111111111111111111111111111111111111111111111111', 1, 1, 'corr-1', '${CUSTOMER_IDENTITY_1}', '${NOW}', '${NOW}'),
        ('${ORDER_2}', 'cart-2', 'q-2', 'sq-2', 'att-2', '${'a'.repeat(64)}', 'awaiting_payment', 'res-2',
         '${NOW}', 'EUR', 850000, 178500, 1028500, 0, 0, 0, 'std', 1, 1, 2, 'elena@turia.es',
         'e111111111111111111111111111111111111111111111111111111111111111', 1, 1, 'corr-2', '${CUSTOMER_IDENTITY_1}', '${NOW}', '${NOW}');
    `)

    const db = d1OverSqlite(sqlite)
    return {
      sqlite,
      db,
      close: () => sqlite.close()
    }
  } catch (error) {
    sqlite.close()
    throw error
  }
}
