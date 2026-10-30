import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

export const FIXTURE_NOW = '2026-10-29T12:00:00Z'
export const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
export const REVIEWER_ID = '10000000-0000-4000-8000-000000000002'
export const INSTALLER_ID = '10000000-0000-4000-8000-000000000003'
export const SECRETS_MGR_ID = '10000000-0000-4000-8000-000000000004'
export const VIEWER_ID = '10000000-0000-4000-8000-000000000005'
export const NOPERMS_ID = '10000000-0000-4000-8000-000000000006'
export const NOMFA_ID = '10000000-0000-4000-8000-000000000007'

const session = (n: number) => `20000000-0000-4000-8000-00000000000${n}`

export const SESSION_CONFIG = { password: 'k'.repeat(64), maxAgeSeconds: 3600 }
export const TEST_ORIGIN = 'https://shop.invalid'
export const TEST_PEPPER = 'test_pepper_12345678901234567890'

export interface TestActors {
  adminCookie: string
  reviewerCookie: string
  installerCookie: string
  secretsMgrCookie: string
  viewerCookie: string
  nopermsCookie: string
  nomfaCookie: string
}

export async function setupConnectorsTestDb(): Promise<{
  sqlite: DatabaseSync
  database: D1Database
  actors: TestActors
}> {
  const sqlite = await openMigratedDatabase()
  const migrationSql = await readFile('db/d1/migrations/0130_connector_marketplace.sql', 'utf8')
  sqlite.exec(migrationSql)

  const database = d1OverSqlite(sqlite)

  // Seed roles & role_permissions
  sqlite.exec(`
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture');

    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Fixture admin'),
      ('reviewer', 'Revisor de conectores', 'Fixture reviewer'),
      ('installer', 'Instalador de conectores', 'Fixture installer'),
      ('secrets_mgr', 'Gestor de secretos', 'Fixture secrets'),
      ('viewer', 'Visor de conectores', 'Fixture viewer'),
      ('noperms', 'Sin permisos', 'Fixture noperms');

    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('reviewer', 'connectors.view'),
      ('reviewer', 'connectors.review'),
      ('installer', 'connectors.view'),
      ('installer', 'connectors.install'),
      ('secrets_mgr', 'connectors.view'),
      ('secrets_mgr', 'connectors.secrets'),
      ('viewer', 'connectors.view');
  `)

  // Seed identities
  const identities = [
    { id: ADMIN_ID, email: 'admin@neteco.invalid', role: 'admin' },
    { id: REVIEWER_ID, email: 'reviewer@neteco.invalid', role: 'reviewer' },
    { id: INSTALLER_ID, email: 'installer@neteco.invalid', role: 'installer' },
    { id: SECRETS_MGR_ID, email: 'secrets@neteco.invalid', role: 'secrets_mgr' },
    { id: VIEWER_ID, email: 'viewer@neteco.invalid', role: 'viewer' },
    { id: NOPERMS_ID, email: 'noperms@neteco.invalid', role: 'noperms' },
    { id: NOMFA_ID, email: 'nomfa@neteco.invalid', role: 'admin' }
  ]

  for (let i = 0; i < identities.length; i++) {
    const ident = identities[i]!
    sqlite
      .prepare(
        `INSERT INTO identities (id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at)
         VALUES (?, ?, 'hash', ?, 'active', 1, ?, ?)`
      )
      .run(ident.id, ident.email, FIXTURE_NOW, FIXTURE_NOW, FIXTURE_NOW)

    sqlite
      .prepare(`INSERT INTO identity_roles (identity_id, role_code, granted_at) VALUES (?, ?, ?)`)
      .run(ident.id, ident.role, FIXTURE_NOW)

    const sessId = session(i + 1)
    const mfa = ident.id === NOMFA_ID ? 0 : 1
    sqlite
      .prepare(
        `INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
         VALUES (?, ?, 1, ?, ?, '2026-10-30T12:00:00Z')`
      )
      .run(sessId, ident.id, mfa, FIXTURE_NOW)
  }

  // Pre-seed a few catalog connectors (governed)
  const insertCatalog = sqlite.prepare(
    `INSERT INTO connector_catalog (
      id, name, category, description, version, provider_type,
      allowed_scopes, config_schema_json, governance_status,
      review_notes, reviewed_by, reviewed_at, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  insertCatalog.run(
    'erp-holded',
    'Holded ERP Connector',
    'erp',
    'Sincronización oficial de pedidos y existencias con Holded.',
    '1.2.0',
    'internal_adapter',
    JSON.stringify(['orders.read', 'inventory.read', 'inventory.write']),
    JSON.stringify({ endpointUrl: 'https://api.holded.example/v1', timeoutMs: 5000, declaredSecrets: ['api_key'] }),
    'approved',
    'Aprobado tras validación de seguridad.',
    ADMIN_ID,
    FIXTURE_NOW,
    ADMIN_ID,
    FIXTURE_NOW,
    FIXTURE_NOW
  )

  insertCatalog.run(
    'carrier-correos-express',
    'Correos Express Envíos',
    'carrier',
    'Gestión de envíos y etiquetas de transporte.',
    '2.0.1',
    'internal_adapter',
    JSON.stringify(['shipping.read', 'shipping.write']),
    JSON.stringify({
      endpointUrl: 'https://api.correos.example/v2',
      timeoutMs: 4000,
      declaredSecrets: ['api_key', 'signing_secret']
    }),
    'approved',
    'Certificado para logística.',
    ADMIN_ID,
    FIXTURE_NOW,
    ADMIN_ID,
    FIXTURE_NOW,
    FIXTURE_NOW
  )

  insertCatalog.run(
    'crm-hubspot-draft',
    'HubSpot CRM Sync',
    'crm',
    'Integración CRM de contactos comerciales B2B.',
    '0.9.0',
    'rest_sync',
    JSON.stringify(['customers.read_masked']),
    JSON.stringify({ declaredSecrets: ['client_secret'] }),
    'draft',
    null,
    null,
    null,
    ADMIN_ID,
    FIXTURE_NOW,
    FIXTURE_NOW
  )

  insertCatalog.run(
    'webhook-exporter',
    'Exportador de Webhooks',
    'webhook',
    'Reenvío gobernado de eventos a sistemas externos.',
    '1.0.0',
    'webhook_outbound',
    JSON.stringify(['webhooks.deliver']),
    JSON.stringify({ endpointUrl: 'https://webhooks.example/listen', declaredSecrets: ['signing_secret'] }),
    'in_review',
    null,
    null,
    null,
    ADMIN_ID,
    FIXTURE_NOW,
    FIXTURE_NOW
  )

  const adminCookie = (await issueD1SessionCookie(
    database,
    { identityId: ADMIN_ID, sessionId: session(1), sessionVersion: 1 },
    SESSION_CONFIG
  ))!
  const reviewerCookie = (await issueD1SessionCookie(
    database,
    { identityId: REVIEWER_ID, sessionId: session(2), sessionVersion: 1 },
    SESSION_CONFIG
  ))!
  const installerCookie = (await issueD1SessionCookie(
    database,
    { identityId: INSTALLER_ID, sessionId: session(3), sessionVersion: 1 },
    SESSION_CONFIG
  ))!
  const secretsMgrCookie = (await issueD1SessionCookie(
    database,
    { identityId: SECRETS_MGR_ID, sessionId: session(4), sessionVersion: 1 },
    SESSION_CONFIG
  ))!
  const viewerCookie = (await issueD1SessionCookie(
    database,
    { identityId: VIEWER_ID, sessionId: session(5), sessionVersion: 1 },
    SESSION_CONFIG
  ))!
  const nopermsCookie = (await issueD1SessionCookie(
    database,
    { identityId: NOPERMS_ID, sessionId: session(6), sessionVersion: 1 },
    SESSION_CONFIG
  ))!
  const nomfaCookie = (await issueD1SessionCookie(
    database,
    { identityId: NOMFA_ID, sessionId: session(7), sessionVersion: 1 },
    SESSION_CONFIG
  ))!

  return {
    sqlite,
    database,
    actors: {
      adminCookie,
      reviewerCookie,
      installerCookie,
      secretsMgrCookie,
      viewerCookie,
      nopermsCookie,
      nomfaCookie
    }
  }
}
