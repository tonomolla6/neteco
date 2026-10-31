import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  assertSyntheticDataSafe,
  detectContractDrift,
  type SandboxContractRunInput
} from '../../shared/integration-sandbox-contracts'
import {
  acknowledgeDriftAlert,
  executeSandboxContractRun,
  getSandboxContractQuotas,
  listDriftAlerts,
  listSandboxContractRuns,
  SandboxContractsError
} from '../../workers/integrations/sandbox-contracts'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const NON_ADMIN_ID = '10000000-0000-4000-8000-000000000002'

async function setupTestDb(): Promise<DatabaseSync> {
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
      ('integrations.manage', 'integrations', 'manage', 'Gestión de integraciones'),
      ('administration.manage', 'administration', 'manage', 'Administración general');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'integrations.manage'),
      ('admin', 'administration.manage');

    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${NON_ADMIN_ID}', 'customer@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000001', '${ADMIN_ID}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z'),
      ('20000000-0000-4000-8000-000000000002', '${NON_ADMIN_ID}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${NON_ADMIN_ID}', 'customer', '${NOW}');
  `)

  return sqlite
}

describe('INT-018: Pruebas de contrato periódicas contra sandbox', () => {
  let sqlite: DatabaseSync

  beforeEach(async () => {
    sqlite = await setupTestDb()
  })

  afterEach(() => {
    sqlite.close()
  })

  describe('Control de secretos y datos sintéticos', () => {
    it('acepta datos estrictamente sintéticos', () => {
      expect(() =>
        assertSyntheticDataSafe({
          customer: {
            legalName: 'NETECO Contrato Sandbox',
            email: 'contract+run-123@example.invalid',
            taxId: '12345678Z'
          },
          orderNumber: 'NETECO-SANDBOX-001',
          amountCents: 145,
          endpointUrl: 'https://sandbox.beply.es/api/v1/invoices'
        })
      ).not.toThrow()
    })

    it('rechaza nombres reales o emails de producción', () => {
      expect(() =>
        assertSyntheticDataSafe({
          customer: {
            legalName: 'Juan Pérez Real',
            email: 'juan.perez@empresa-real.com'
          }
        })
      ).toThrowError(/synthetic_data_violation/)
    })

    it('rechaza URLs de producción o http inseguro', () => {
      expect(() =>
        assertSyntheticDataSafe({
          endpointUrl: 'https://api.beply.es/v1/invoices'
        })
      ).toThrowError(/production_endpoint_violation/)

      expect(() =>
        assertSyntheticDataSafe({
          endpointUrl: 'http://sandbox.beply.es/v1/invoices'
        })
      ).toThrowError(/https_required/)
    })

    it('rechaza secretos o tokens de producción', () => {
      expect(() =>
        assertSyntheticDataSafe({
          token: 'live_sec_1234567890abcdef'
        })
      ).toThrowError(/credential_safety_violation/)
    })
  })

  describe('Detección de drift en contratos de proveedor', () => {
    it('detecta respuesta conforme sin drift', () => {
      const expectedSchema = {
        requiredFields: ['id', 'status', 'invoice_code', 'currency'],
        fieldTypes: { id: 'string', status: 'string', invoice_code: 'string', currency: 'string' },
        allowedStatuses: ['issued', 'paid']
      }
      const actualResponse = {
        id: 'inv_123',
        status: 'issued',
        invoice_code: 'F2026-001',
        currency: 'EUR'
      }

      const drifts = detectContractDrift(actualResponse, expectedSchema)
      expect(drifts).toHaveLength(0)
    })

    it('detecta campo obligatorio ausente', () => {
      const expectedSchema = {
        requiredFields: ['id', 'status', 'invoice_code'],
        fieldTypes: { id: 'string', status: 'string', invoice_code: 'string' }
      }
      const actualResponse = {
        id: 'inv_123',
        status: 'issued'
      }

      const drifts = detectContractDrift(actualResponse, expectedSchema)
      expect(drifts).toContainEqual(
        expect.objectContaining({
          field: 'invoice_code',
          driftType: 'missing_field'
        })
      )
    })

    it('detecta cambio de tipo de datos (schema_mismatch)', () => {
      const expectedSchema = {
        requiredFields: ['amount_cents'],
        fieldTypes: { amount_cents: 'number' }
      }
      const actualResponse = {
        amount_cents: '145' // string en lugar de number
      }

      const drifts = detectContractDrift(actualResponse, expectedSchema)
      expect(drifts).toContainEqual(
        expect.objectContaining({
          field: 'amount_cents',
          driftType: 'schema_mismatch'
        })
      )
    })

    it('detecta valor no permitido en enumerado de estado (semantic_drift)', () => {
      const expectedSchema = {
        requiredFields: ['status'],
        fieldTypes: { status: 'string' },
        allowedStatuses: ['authorized', 'refused']
      }
      const actualResponse = {
        status: 'unknown_pending'
      }

      const drifts = detectContractDrift(actualResponse, expectedSchema)
      expect(drifts).toContainEqual(
        expect.objectContaining({
          field: 'status',
          driftType: 'semantic_drift'
        })
      )
    })
  })

  describe('Ejecución de suite de contrato y control de cuotas', () => {
    it('ejecuta suite exitosa para beply y descuenta cuota', async () => {
      const db = d1OverSqlite(sqlite)
      const input: SandboxContractRunInput = {
        provider: 'beply',
        suiteName: 'beply-invoice-lifecycle',
        simulateDrift: false
      }

      const result = await executeSandboxContractRun(db, input, {
        actorId: ADMIN_ID,
        now: NOW
      })

      expect(result.status).toBe('passed')
      expect(result.driftCount).toBe(0)
      expect(result.quotaConsumed).toBe(1)

      const quotas = await getSandboxContractQuotas(db, 'beply', NOW)
      expect(quotas.dailyUsed).toBe(1)
      expect(quotas.hourlyUsed).toBe(1)

      const runs = await listSandboxContractRuns(db, { provider: 'beply' })
      expect(runs).toHaveLength(1)
      expect(runs[0]!.id).toBe(result.id)
    })

    it('ejecuta suite con drift simulado, genera alerta de drift y registra hallazgos', async () => {
      const db = d1OverSqlite(sqlite)
      const input: SandboxContractRunInput = {
        provider: 'redsys',
        suiteName: 'redsys-redirect-and-signature',
        simulateDrift: true
      }

      const result = await executeSandboxContractRun(db, input, {
        actorId: ADMIN_ID,
        now: NOW
      })

      expect(result.status).toBe('drift_detected')
      expect(result.driftCount).toBeGreaterThan(0)

      const alerts = await listDriftAlerts(db, { provider: 'redsys' })
      expect(alerts).toHaveLength(1)
      expect(alerts[0]!.severity).toBe('critical')
      expect(alerts[0]!.acknowledged).toBe(false)

      // Reconocer la alerta
      const ack = await acknowledgeDriftAlert(db, alerts[0]!.id, {
        actorId: ADMIN_ID,
        now: '2026-10-29T12:05:00Z'
      })
      expect(ack.acknowledged).toBe(true)
      expect(ack.acknowledgedBy).toBe(ADMIN_ID)
    })

    it('bloquea ejecución y registra quota_exceeded si se supera el presupuesto', async () => {
      const db = d1OverSqlite(sqlite)
      // Agotar la cuota intencionalmente
      sqlite.exec(`
        UPDATE sandbox_contract_quotas
        SET hourly_used = hourly_limit, updated_at = '${NOW}'
        WHERE provider = 'beply';
      `)

      const input: SandboxContractRunInput = {
        provider: 'beply',
        suiteName: 'beply-invoice-lifecycle',
        simulateDrift: false
      }

      const result = await executeSandboxContractRun(db, input, {
        actorId: ADMIN_ID,
        now: NOW
      })

      expect(result.status).toBe('quota_exceeded')
      expect(result.quotaConsumed).toBe(0)

      const alerts = await listDriftAlerts(db, { provider: 'beply' })
      expect(alerts.some((a) => a.driftType === 'status_code_changed' && a.description.includes('cuota'))).toBe(true)
    })

    it('rechaza invocación con PII no sintética', async () => {
      const db = d1OverSqlite(sqlite)
      const input: SandboxContractRunInput = {
        provider: 'beply',
        suiteName: 'beply-invoice-lifecycle',
        overrideCustomer: {
          legalName: 'Cliente Real S.L.',
          email: 'real@empresa.com'
        }
      }

      await expect(
        executeSandboxContractRun(db, input, {
          actorId: ADMIN_ID,
          now: NOW
        })
      ).rejects.toThrowError(SandboxContractsError)
    })
  })
})
