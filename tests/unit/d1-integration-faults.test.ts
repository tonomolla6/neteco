import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { FaultInjectionScenarioInput } from '../../shared/integration-fault-injection'
import {
  configureFaultRule,
  getFaultSimulationLogs,
  listFaultRules,
  runFaultInjectionSimulation,
  verifyEntityConsistency
} from '../../workers/integrations/fault-injection'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0138_integration_sandbox_faults_webhooks.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('integrations.manage', 'integrations', 'manage', 'Gestión de integraciones');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'integrations.manage');

    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000001', '${ADMIN_ID}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');
  `)

  return sqlite
}

describe('INT-019: Fault injection de integraciones y recuperación sin corrupción', () => {
  let sqlite: DatabaseSync

  beforeEach(async () => {
    sqlite = await setupTestDb()
  })

  afterEach(() => {
    sqlite.close()
  })

  describe('Los 6 tipos requeridos de inyección de fallos', () => {
    it('1. Timeout: se detecta el corte, se evita estado huérfano y se programa reintento limpio', async () => {
      const db = d1OverSqlite(sqlite)
      const scenario: FaultInjectionScenarioInput = {
        provider: 'beply',
        operation: 'issue_invoice',
        faultType: 'timeout',
        targetEntityId: 'order-1001',
        timeoutMs: 50
      }

      const result = await runFaultInjectionSimulation(db, scenario, {
        actorId: ADMIN_ID,
        now: NOW
      })

      expect(result.faultInjected).toBe('timeout')
      expect(result.recovered).toBe(true)
      expect(result.recoveryAction).toBe('retried')
      expect(result.stateConsistent).toBe(true)

      // Verificamos que no hay registros corruptos ni transacciones a medias
      const consistency = await verifyEntityConsistency(db, 'order-1001')
      expect(consistency.corrupted).toBe(false)
      expect(consistency.casVersionIntact).toBe(true)
    })

    it('2. HTTP 500: error del proveedor upstream activa backoff y preserva la entidad', async () => {
      const db = d1OverSqlite(sqlite)
      const scenario: FaultInjectionScenarioInput = {
        provider: 'redsys',
        operation: 'process_payment',
        faultType: 'http_500',
        targetEntityId: 'payment-2002'
      }

      const result = await runFaultInjectionSimulation(db, scenario, {
        actorId: ADMIN_ID,
        now: NOW
      })

      expect(result.faultInjected).toBe('http_500')
      expect(result.recovered).toBe(true)
      expect(result.recoveryAction).toBe('retried')
      expect(result.stateConsistent).toBe(true)

      const consistency = await verifyEntityConsistency(db, 'payment-2002')
      expect(consistency.corrupted).toBe(false)
    })

    it('3. HTTP 401: fallo de autenticación de credenciales no entra en bucle infinito y rechaza de inmediato', async () => {
      const db = d1OverSqlite(sqlite)
      const scenario: FaultInjectionScenarioInput = {
        provider: 'beply',
        operation: 'download_pdf',
        faultType: 'http_401',
        targetEntityId: 'invoice-3003'
      }

      const result = await runFaultInjectionSimulation(db, scenario, {
        actorId: ADMIN_ID,
        now: NOW
      })

      expect(result.faultInjected).toBe('http_401')
      expect(result.recovered).toBe(true)
      expect(result.recoveryAction).toBe('clean_rejection')
      expect(result.stateConsistent).toBe(true)
      expect(result.auditDetails.alertCreated).toBe(true)
    })

    it('4. Payload parcial: respuesta mutilada o incompleta se rechaza antes de escribir en base de datos', async () => {
      const db = d1OverSqlite(sqlite)
      const scenario: FaultInjectionScenarioInput = {
        provider: 'carrier',
        operation: 'manifest_tracking',
        faultType: 'partial_payload',
        targetEntityId: 'shipment-4004'
      }

      const result = await runFaultInjectionSimulation(db, scenario, {
        actorId: ADMIN_ID,
        now: NOW
      })

      expect(result.faultInjected).toBe('partial_payload')
      expect(result.recovered).toBe(true)
      expect(result.recoveryAction).toBe('dlq_routed')
      expect(result.stateConsistent).toBe(true)

      const consistency = await verifyEntityConsistency(db, 'shipment-4004')
      expect(consistency.corrupted).toBe(false)
    })

    it('5. Duplicado: reintento con la misma clave de idempotencia devuelve el mismo recibo sin duplicar saldo', async () => {
      const db = d1OverSqlite(sqlite)
      const scenario: FaultInjectionScenarioInput = {
        provider: 'webhook',
        operation: 'order_status_update',
        faultType: 'duplicate',
        targetEntityId: 'order-5005',
        idempotencyKey: 'dup-idemp-5005'
      }

      const result = await runFaultInjectionSimulation(db, scenario, {
        actorId: ADMIN_ID,
        now: NOW
      })

      expect(result.faultInjected).toBe('duplicate')
      expect(result.recovered).toBe(true)
      expect(result.recoveryAction).toBe('idempotent_cached')
      expect(result.stateConsistent).toBe(true)

      const consistency = await verifyEntityConsistency(db, 'order-5005')
      expect(consistency.corrupted).toBe(false)
      expect(consistency.duplicateCount).toBe(0)
    })

    it('6. Latencia: alta latencia controlada se gestiona sin bloqueo ni fugas de recursos', async () => {
      const db = d1OverSqlite(sqlite)
      const scenario: FaultInjectionScenarioInput = {
        provider: 'redsys',
        operation: 'create_redirect',
        faultType: 'latency',
        targetEntityId: 'redirect-6006',
        latencyMs: 150
      }

      const result = await runFaultInjectionSimulation(db, scenario, {
        actorId: ADMIN_ID,
        now: NOW
      })

      expect(result.faultInjected).toBe('latency')
      expect(result.recovered).toBe(true)
      expect(result.recoveryAction).toBe('fallback_executed')
      expect(result.stateConsistent).toBe(true)
    })
  })

  describe('Auditoría y gobernanza de reglas de inyección', () => {
    it('crea, lista y actualiza regla con CAS versioning', async () => {
      const db = d1OverSqlite(sqlite)
      const rule = await configureFaultRule(
        db,
        {
          provider: 'beply',
          operation: 'issue_invoice',
          faultType: 'timeout',
          parameters: { timeoutMs: 2000 },
          active: true
        },
        { actorId: ADMIN_ID, now: NOW }
      )

      expect(rule.version).toBe(1)
      expect(rule.active).toBe(true)

      const rules = await listFaultRules(db)
      expect(rules).toHaveLength(1)
      expect(rules[0]!.id).toBe(rule.id)

      // Actualizar regla con CAS
      const updated = await configureFaultRule(
        db,
        {
          id: rule.id,
          provider: 'beply',
          operation: 'issue_invoice',
          faultType: 'timeout',
          parameters: { timeoutMs: 4000 },
          active: false,
          expectedVersion: 1
        },
        { actorId: ADMIN_ID, now: '2026-10-29T12:10:00Z' }
      )

      expect(updated.version).toBe(2)
      expect(updated.active).toBe(false)
    })

    it('persiste logs de simulación con veredicto de consistencia', async () => {
      const db = d1OverSqlite(sqlite)
      await runFaultInjectionSimulation(
        db,
        {
          provider: 'beply',
          operation: 'issue_invoice',
          faultType: 'timeout',
          targetEntityId: 'order-audit-1'
        },
        { actorId: ADMIN_ID, now: NOW }
      )

      const logs = await getFaultSimulationLogs(db)
      expect(logs.length).toBeGreaterThan(0)
      expect(logs[0]!.stateConsistent).toBe(true)
    })
  })
})
