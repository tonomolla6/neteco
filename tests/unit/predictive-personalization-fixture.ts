import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'

export const NOW = '2026-10-29T12:00:00Z'
export const ADMIN_IDENTITY = '10000000-0000-4000-8000-000000000001'
export const CUSTOMER_ID_1 = '20000000-0000-4000-8000-000000000001'
export const CUSTOMER_ID_2 = '20000000-0000-4000-8000-000000000002'
export const OTHER_IDENTITY = '30000000-0000-4000-8000-000000000001'

export const CAMPAIGN_ID_1 = 'camp-b2b-turia-vip'
export const PROD_DETERGENT = 'prod-detergente-alcalino'
export const PROD_DESCALER = 'prod-desincrustante-acido'
export const PROD_BLEACH = 'prod-lejia-industrial'
export const PROD_AMMONIA = 'prod-amoniaco-tecnico'
export const PROD_DEGREASER = 'prod-desengrasante-alimentario'

export interface PredictivePersonalizationWorld {
  sqlite: DatabaseSync
  db: D1Database
  close: () => void
}

export async function createPredictivePersonalizationWorld(): Promise<PredictivePersonalizationWorld> {
  const sqlite = await openMigratedDatabase()
  try {
    // Migration 0125 for marketing_targeted_campaigns
    const migration0125Sql = await readFile('db/d1/migrations/0125_learning_campaigns_recurring_incentives.sql', 'utf8')
    sqlite.exec(migration0125Sql)

    // Migration 0127 for predictive personalization and model evaluations
    const migration0127Sql = await readFile(
      'db/d1/migrations/0127_predictive_personalization_campaign_eval.sql',
      'utf8'
    )
    sqlite.exec(migration0127Sql)

    sqlite.exec('PRAGMA foreign_keys = OFF')

    const makeIdentity = (id: string, email: string, customerId?: string) =>
      `INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
       VALUES('${id}', '${email}', 'synthetic_hash', '${NOW}', 'active', ${customerId ? `'${customerId}'` : 'NULL'}, '${NOW}', '${NOW}');`

    sqlite.exec(`
      -- Customers
      INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES
        ('${CUSTOMER_ID_1}', 'Lavandería Turia', '+34600111222', 'active', '${NOW}', '${NOW}'),
        ('${CUSTOMER_ID_2}', 'Restaurante El Grao', '+34600333444', 'active', '${NOW}', '${NOW}');

      -- Identities
      ${makeIdentity(ADMIN_IDENTITY, 'admin@neteco.es')}
      ${makeIdentity(CUSTOMER_ID_1, 'turia@neteco.es', CUSTOMER_ID_1)}
      ${makeIdentity(CUSTOMER_ID_2, 'elgrao@neteco.es', CUSTOMER_ID_2)}
      ${makeIdentity(OTHER_IDENTITY, 'otro@empresa.es')}

      -- Roles & Permissions for Admin
      INSERT OR IGNORE INTO roles(code, name, description) VALUES('admin', 'Administrador', 'Synthetic');
      INSERT OR IGNORE INTO permissions(code, resource, action, description) VALUES('administration.manage', 'administration', 'manage', 'Synthetic');
      INSERT OR IGNORE INTO role_permissions(role_code, permission_code) VALUES('admin', 'administration.manage');
      INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES('${ADMIN_IDENTITY}', 'admin', '${NOW}');

      -- Sample targeted campaign
      INSERT INTO marketing_targeted_campaigns(
        id, code, name, description, target_type, target_id, tariff_type, discount_percent, min_order_net_cents,
        margin_floor_basis_points, start_at, end_at, status, version, created_at, updated_at
      ) VALUES (
        '${CAMPAIGN_ID_1}', 'camp-b2b-turia-vip', 'Campaña Turia Q4', 'Campaña especial lavanderías',
        'sector', 'lavanderia_industrial', 'percentage_discount', 12, 10000, 1500,
        '${NOW}', '2026-12-31T23:59:59Z', 'active', 1, '${NOW}', '${NOW}'
      );

      -- Sample catalog products
      INSERT OR IGNORE INTO categories(id, name, slug) VALUES
        ('cat-industrial', 'Limpieza Industrial', 'limpieza-industrial'),
        ('cat-alimentaria', 'Higiene Alimentaria', 'higiene-alimentaria');

      INSERT OR IGNORE INTO products(id, category_id, name, slug, short_description, description) VALUES
        ('${PROD_DETERGENT}', 'cat-industrial', 'Detergente Alcalino Pro', 'detergente-alcalino-pro', 'Detergente industrial', 'Uso profesional en lavandería'),
        ('${PROD_DESCALER}', 'cat-industrial', 'Desincrustante Ácido Fuerte', 'desincrustante-acido', 'Elimina cal e incrustaciones', 'pH ácido 1.5'),
        ('${PROD_BLEACH}', 'cat-industrial', 'Hipoclorito Sódico 150g/l', 'hipoclorito-sodico-150', 'Desinfectante clorado', 'Lejía concentrada cloro activo'),
        ('${PROD_AMMONIA}', 'cat-industrial', 'Amoníaco Perfumado', 'amoniaco-perfumado', 'Desengrasante amoniacal', 'Uso no clorado'),
        ('${PROD_DEGREASER}', 'cat-alimentaria', 'Desengrasante Alimentario HD', 'desengrasante-alimentario-hd', 'Desengrasante cocinas HACCP', 'Apto industria alimentaria');
    `)

    sqlite.exec('PRAGMA foreign_keys = ON')

    return {
      sqlite,
      db: d1OverSqlite(sqlite),
      close: () => {
        sqlite.close()
      }
    }
  } catch (error) {
    sqlite.close()
    throw error
  }
}
