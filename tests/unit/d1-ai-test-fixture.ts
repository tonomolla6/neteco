import { readFile } from 'node:fs/promises'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { issueD1SessionCookie, type SessionCookieConfiguration } from '../../workers/auth/session-cookie'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'

export const ADMIN_ACTOR = '11111111-0000-4000-8000-000000000001'
export const ADMIN_SESSION = '22222222-0000-4000-8000-000000000001'
export const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: ADMIN_ACTOR,
  sessionId: ADMIN_SESSION,
  sessionVersion: 1
}

export const OPERATOR_ACTOR = '11111111-0000-4000-8000-000000000002'
export const OPERATOR_SESSION = '22222222-0000-4000-8000-000000000002'
export const OPERATOR_CLAIMS: VerifiedSessionClaims = {
  identityId: OPERATOR_ACTOR,
  sessionId: OPERATOR_SESSION,
  sessionVersion: 1
}

export const UNAUTHORIZED_ACTOR = '11111111-0000-4000-8000-000000000099'
export const UNAUTHORIZED_SESSION = '22222222-0000-4000-8000-000000000099'
export const UNAUTHORIZED_CLAIMS: VerifiedSessionClaims = {
  identityId: UNAUTHORIZED_ACTOR,
  sessionId: UNAUTHORIZED_SESSION,
  sessionVersion: 1
}

export const SESSION_CONFIG: SessionCookieConfiguration = {
  password: 'synthetic-ai-test-session-password-32chars!!',
  maxAgeSeconds: 3600
}

export const TEST_ORIGIN = 'https://admin.neteco.test'

export const TEST_ASSET_ID = 'a55e7000-0000-4000-8000-000000000001'

export async function aiTestFixture() {
  const sqlite = await openMigratedDatabase()
  sqlite.limits.exprDepth = 100
  sqlite.limits.variableNumber = 100
  sqlite.limits.functionArg = 32

  // Apply migration 0119
  const migration0119 = await readFile(
    new URL('../../db/d1/migrations/0119_ai_assistant_enrichment.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration0119)

  const database = d1OverSqlite(sqlite)
  seedInventoryFixture(sqlite, { initialPhysicalQuantity: 50 })
  const past = '2026-10-29T00:00:00Z'
  const future = '2099-01-01T00:00:00Z'

  await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: past })

  // Seed permissions and roles
  sqlite.exec(`
    INSERT OR IGNORE INTO roles VALUES('admin', 'Admin', 'Synthetic Admin Role');
    INSERT OR IGNORE INTO roles VALUES('operator', 'Operator', 'Synthetic Limited Operator');
    INSERT OR IGNORE INTO roles VALUES('unauthorized', 'Unauthorized', 'Synthetic No Perms');

    INSERT OR IGNORE INTO permissions VALUES('administration.manage', 'administration', 'manage', 'Full Admin');
    INSERT OR IGNORE INTO permissions VALUES('admin.ai_assistant', 'admin', 'ai_assistant', 'AI Assistant');
    INSERT OR IGNORE INTO permissions VALUES('catalog.write', 'catalog', 'write', 'Catalog Write');
    INSERT OR IGNORE INTO permissions VALUES('catalog.ai_generate', 'catalog', 'ai_generate', 'Catalog AI Generate');
    INSERT OR IGNORE INTO permissions VALUES('media.write', 'media', 'write', 'Media Write');
    INSERT OR IGNORE INTO permissions VALUES('media.ai_enrich', 'media', 'ai_enrich', 'Media AI Enrich');
    INSERT OR IGNORE INTO permissions VALUES('orders.view', 'orders', 'view', 'Orders View');
    INSERT OR IGNORE INTO permissions VALUES('customers.view', 'customers', 'view', 'Customers View');

    -- Admin gets all
    INSERT OR IGNORE INTO role_permissions VALUES('admin', 'administration.manage');
    INSERT OR IGNORE INTO role_permissions VALUES('admin', 'admin.ai_assistant');
    INSERT OR IGNORE INTO role_permissions VALUES('admin', 'catalog.write');
    INSERT OR IGNORE INTO role_permissions VALUES('admin', 'catalog.ai_generate');
    INSERT OR IGNORE INTO role_permissions VALUES('admin', 'media.write');
    INSERT OR IGNORE INTO role_permissions VALUES('admin', 'media.ai_enrich');
    INSERT OR IGNORE INTO role_permissions VALUES('admin', 'orders.view');
    INSERT OR IGNORE INTO role_permissions VALUES('admin', 'customers.view');

    -- Operator gets catalog only
    INSERT OR IGNORE INTO role_permissions VALUES('operator', 'catalog.write');
    INSERT OR IGNORE INTO role_permissions VALUES('operator', 'catalog.ai_generate');

    -- Identities
    INSERT OR IGNORE INTO identities(id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at)
      VALUES('${ADMIN_ACTOR}', 'admin@example.invalid', 'synthetic_hash', '${past}', 'active', 1, '${past}', '${past}');
    INSERT OR IGNORE INTO identities(id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at)
      VALUES('${OPERATOR_ACTOR}', 'operator@example.invalid', 'synthetic_hash', '${past}', 'active', 1, '${past}', '${past}');
    INSERT OR IGNORE INTO identities(id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at)
      VALUES('${UNAUTHORIZED_ACTOR}', 'unauth@example.invalid', 'synthetic_hash', '${past}', 'active', 1, '${past}', '${past}');

    -- Auth sessions
    INSERT OR IGNORE INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES('${ADMIN_SESSION}', '${ADMIN_ACTOR}', 1, 1, '${past}', '${future}');
    INSERT OR IGNORE INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES('${OPERATOR_SESSION}', '${OPERATOR_ACTOR}', 1, 1, '${past}', '${future}');
    INSERT OR IGNORE INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES('${UNAUTHORIZED_SESSION}', '${UNAUTHORIZED_ACTOR}', 1, 1, '${past}', '${future}');

    -- Identity roles
    INSERT OR IGNORE INTO identity_roles(identity_id, role_code, granted_at)
      VALUES('${ADMIN_ACTOR}', 'admin', '${past}');
    INSERT OR IGNORE INTO identity_roles(identity_id, role_code, granted_at)
      VALUES('${OPERATOR_ACTOR}', 'operator', '${past}');
    INSERT OR IGNORE INTO identity_roles(identity_id, role_code, granted_at)
      VALUES('${UNAUTHORIZED_ACTOR}', 'unauthorized', '${past}');

    -- Seed an existing product for catalog and duplicate testing
    INSERT OR IGNORE INTO categories(id, name, slug, description, created_at)
      VALUES('cat-ind-1', 'Limpieza Industrial', 'industriales', 'Productos para industria y talleres', '${past}');

    INSERT OR IGNORE INTO products(id, category_id, name, slug, short_description, description, usage, created_at, updated_at)
      VALUES(
        'prod-desengrasante-1',
        'cat-ind-1',
        'Desengrasante Alcalino Extra Fuerte Neteco',
        'desengrasante-alcalino-extra-fuerte',
        'Desengrasante industrial potente para motores y suelos industriales.',
        'Formula alcalina concentrada de alta eficacia contra grasas pesadas, aceites quemados y residuos carbonosos.',
        'Diluir al 5% en agua para suciedad ligera, al 20% para suciedad severa. Dejar actuar 5 minutos y aclarar con agua a presion.',
        '${past}',
        '${past}'
      );

    INSERT OR IGNORE INTO variants(id, product_id, tax_class_id, shipping_profile_id, sku, format, price_gross_cents, status)
      VALUES('var-desengrasante-1', 'prod-desengrasante-1', 't21', 'sp1', 'SKU-DES-001', '5L', 1500, 'published');
    INSERT OR IGNORE INTO inventory_balances(variant_id, location_id, physical_quantity, blocked_quantity, version, created_at, updated_at)
      VALUES('var-desengrasante-1', 'loc-main', 50, 0, 1, '${past}', '${past}');

    -- Seed a media asset
    INSERT OR IGNORE INTO media_assets(
      id, storage_key, original_name, mime_type, byte_size, checksum_sha256,
      owner_name, source_url, license, authorized_at, rights_status, quarantine_status,
      alt_text, metadata, created_at
    ) VALUES (
      '${TEST_ASSET_ID}',
      'media/2026/10/desengrasante-5l.jpg',
      'desengrasante-5l.jpg',
      'image/jpeg',
      524288,
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'Neteco Quimica SL',
      'https://storage.neteco.test/media/desengrasante-5l.jpg',
      'internal_proprietary',
      '${past}',
      'pending',
      'pending',
      'Garrafa blanca de 5L con tapon dosificador',
      '{"width":1200,"height":1200,"colorSpace":"sRGB"}',
      '${past}'
    );
  `)

  const adminCookie = (await issueD1SessionCookie(database, ADMIN_CLAIMS, SESSION_CONFIG))!.split(';')[0]!
  const operatorCookie = (await issueD1SessionCookie(database, OPERATOR_CLAIMS, SESSION_CONFIG))!.split(';')[0]!
  const unauthorizedCookie = (await issueD1SessionCookie(database, UNAUTHORIZED_CLAIMS, SESSION_CONFIG))!.split(';')[0]!

  return {
    sqlite,
    database,
    adminCookie,
    operatorCookie,
    unauthorizedCookie,
    now: past
  }
}
