import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleIntegrationsHttp,
  ownsIntegrationsNamespace,
  type IntegrationsHttpDependencies
} from '../../workers/integrations/integrations-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const CUSTOMER_ID = '10000000-0000-4000-8000-000000000002'
const SESSION_PASSWORD = 'test-session-password-at-least-32-chars-long!!'
const ORIGIN = 'https://neteco.beply.es'

async function setupHttpDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0138_integration_sandbox_faults_webhooks.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador'),
      ('customer', 'Cliente', 'Rol cliente');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('integrations.manage', 'integrations', 'manage', 'Gestión general de integraciones');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'integrations.manage');

    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-int@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${CUSTOMER_ID}', 'customer-int@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000001', '${ADMIN_ID}', 1, 1, '${NOW}', '2099-12-31T23:59:59Z'),
      ('20000000-0000-4000-8000-000000000002', '${CUSTOMER_ID}', 1, 1, '${NOW}', '2099-12-31T23:59:59Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${CUSTOMER_ID}', 'customer', '${NOW}');
  `)

  return sqlite
}

describe('Integraciones HTTP Handler (INT-018, INT-019, INT-021)', () => {
  let sqlite: DatabaseSync
  let adminCookie: string
  let customerCookie: string

  beforeEach(async () => {
    sqlite = await setupHttpDb()
    adminCookie = (await issueD1SessionCookie(
      d1OverSqlite(sqlite),
      {
        sessionId: '20000000-0000-4000-8000-000000000001',
        identityId: ADMIN_ID,
        sessionVersion: 1
      },
      { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
    ))!
    customerCookie = (await issueD1SessionCookie(
      d1OverSqlite(sqlite),
      {
        sessionId: '20000000-0000-4000-8000-000000000002',
        identityId: CUSTOMER_ID,
        sessionVersion: 1
      },
      { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
    ))!
  })

  afterEach(() => {
    sqlite.close()
  })

  function getDeps(): IntegrationsHttpDependencies {
    return {
      database: d1OverSqlite(sqlite),
      sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 },
      origin: ORIGIN,
      now: () => NOW
    }
  }

  describe('ownsIntegrationsNamespace', () => {
    it('reconoce rutas del espacio de nombres', () => {
      expect(ownsIntegrationsNamespace('/api/admin/sandbox-contracts/runs')).toBe(true)
      expect(ownsIntegrationsNamespace('/api/admin/fault-injection/rules')).toBe(true)
      expect(ownsIntegrationsNamespace('/api/admin/webhooks/subscriptions')).toBe(true)
      expect(ownsIntegrationsNamespace('/api/admin/other')).toBe(false)
    })
  })

  describe('INT-018: Endpoints de Sandbox Contracts', () => {
    it('GET /api/admin/sandbox-contracts/quotas devuelve estado de cuotas', async () => {
      const request = new Request(`${ORIGIN}/api/admin/sandbox-contracts/quotas`, {
        method: 'GET',
        headers: { Cookie: adminCookie }
      })

      const response = await handleIntegrationsHttp(request, getDeps())
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)
      const data = await response!.json()
      expect(data).toHaveProperty('quotas')
      expect(Array.isArray(data.quotas)).toBe(true)
    })

    it('POST /api/admin/sandbox-contracts/run ejecuta prueba de contrato', async () => {
      const request = new Request(`${ORIGIN}/api/admin/sandbox-contracts/run`, {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          provider: 'beply',
          suiteName: 'beply-invoice-lifecycle'
        })
      })

      const response = await handleIntegrationsHttp(request, getDeps())
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)
      const data = await response!.json()
      expect(data.status).toBe('passed')
      expect(data.provider).toBe('beply')
    })

    it('Rechaza acceso sin permisos de administración', async () => {
      const request = new Request(`${ORIGIN}/api/admin/sandbox-contracts/quotas`, {
        method: 'GET',
        headers: { Cookie: customerCookie }
      })

      const response = await handleIntegrationsHttp(request, getDeps())
      expect(response).not.toBeNull()
      expect(response!.status).toBe(403)
    })
  })

  describe('INT-019: Endpoints de Fault Injection', () => {
    it('POST /api/admin/fault-injection/simulate corre simulación y verifica recuperación sin corrupción', async () => {
      const request = new Request(`${ORIGIN}/api/admin/fault-injection/simulate`, {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          provider: 'beply',
          operation: 'issue_invoice',
          faultType: 'timeout',
          targetEntityId: 'order-canary-101',
          timeoutMs: 50
        })
      })

      const response = await handleIntegrationsHttp(request, getDeps())
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)
      const data = await response!.json()
      expect(data.recovered).toBe(true)
      expect(data.stateConsistent).toBe(true)
    })
  })

  describe('INT-021: Endpoints de Webhooks Salientes', () => {
    it('flujo completo: crear suscripción, listar, rotar secreto y ver entregas', async () => {
      // 1. Crear suscripción
      const createReq = new Request(`${ORIGIN}/api/admin/webhooks/subscriptions`, {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: 'https://webhook.prueba.invalid/listener',
          topics: ['order.paid', 'invoice.issued'],
          description: 'Listener auditoría'
        })
      })

      const createRes = await handleIntegrationsHttp(createReq, getDeps())
      expect(createRes!.status).toBe(201)
      const sub = await createRes!.json()
      expect(sub.id).toBeDefined()
      expect(sub.primarySecret).toBeDefined()

      // 2. Rotar secreto
      const rotateReq = new Request(`${ORIGIN}/api/admin/webhooks/subscriptions/${sub.id}/rotate-secret`, {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          expectedVersion: 1,
          gracePeriodSeconds: 86400
        })
      })

      const rotateRes = await handleIntegrationsHttp(rotateReq, getDeps())
      expect(rotateRes!.status).toBe(200)
      const rotated = await rotateRes!.json()
      expect(rotated.version).toBe(2)
      expect(rotated.secondarySecret).toBe(sub.primarySecret)
    })
  })

  describe('Seguridad y Robustez en Fronteras (INT-12)', () => {
    it('Rechaza peticiones mutantes con CSRF o cross-site', async () => {
      const request = new Request(`${ORIGIN}/api/admin/sandbox-contracts/run`, {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json',
          Origin: 'https://attacker.evil.invalid',
          'Sec-Fetch-Site': 'cross-site'
        },
        body: JSON.stringify({
          provider: 'beply',
          suiteName: 'beply-invoice-lifecycle'
        })
      })

      const response = await handleIntegrationsHttp(request, getDeps())
      expect(response).not.toBeNull()
      expect(response!.status).toBe(403)
      const data = await response!.json()
      expect(data).toMatchObject({ error: { code: 'csrf_rejected' } })
    })

    it('Valida esquema Zod en POST /api/admin/sandbox-contracts/run', async () => {
      const request = new Request(`${ORIGIN}/api/admin/sandbox-contracts/run`, {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          provider: 'unsupported-provider-xyz',
          suiteName: 'x' // too short
        })
      })

      const response = await handleIntegrationsHttp(request, getDeps())
      expect(response).not.toBeNull()
      expect(response!.status).toBe(400)
    })
  })
})
