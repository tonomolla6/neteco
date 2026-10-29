import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  type OperationalAlertInput,
  type OperationalAlertAckInput,
  type OperationalAlertEscalateInput,
  type OperationalAlertResolveInput,
  operationalAlertIntentHash
} from '../../shared/operational-alerts'
import {
  OperationalAlertsError,
  createD1OperationalAlert,
  acknowledgeD1OperationalAlert,
  escalateD1OperationalAlert,
  resolveD1OperationalAlert,
  getD1OperationalAlert,
  listD1OperationalAlerts
} from '../../workers/communications/operational-alerts'

const NOW = '2026-10-29T14:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }

const SUPERVISOR_ID = '10000000-0000-4000-8000-000000000002'
const SUPERVISOR_SESSION = '20000000-0000-4000-8000-000000000002'
const SUPERVISOR_CLAIMS = { identityId: SUPERVISOR_ID, sessionId: SUPERVISOR_SESSION, sessionVersion: 1 }

const DRIVER_ID = '10000000-0000-4000-8000-000000000003'
const DRIVER_SESSION = '20000000-0000-4000-8000-000000000003'
const DRIVER_CLAIMS = { identityId: DRIVER_ID, sessionId: DRIVER_SESSION, sessionVersion: 1 }

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0122_operational_alerts_send_time_warehouse_telemetry.sql', import.meta.url),
      'utf8'
    )
  )

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Admin fixture'),
      ('operations', 'Operaciones', 'Operations fixture');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Admin manage'),
      ('operations.manage', 'operations', 'manage', 'Operations manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('operations', 'operations.manage');
  `)

  sqlite.exec(`
    INSERT OR IGNORE INTO identities (id, customer_id, email, status, session_version, email_verified_at, created_at, updated_at) VALUES
      ('${ADMIN_ID}', NULL, 'admin@neteco.test', 'active', 1, '${NOW}', '${NOW}', '${NOW}'),
      ('${SUPERVISOR_ID}', NULL, 'supervisor@neteco.test', 'active', 1, '${NOW}', '${NOW}', '${NOW}'),
      ('${DRIVER_ID}', NULL, 'driver@neteco.test', 'active', 1, '${NOW}', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${SUPERVISOR_ID}', 'admin', '${NOW}'),
      ('${DRIVER_ID}', 'admin', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_SESSION}', '${ADMIN_ID}', 1, 1, '${NOW}', '2026-10-30T14:00:00Z'),
      ('${SUPERVISOR_SESSION}', '${SUPERVISOR_ID}', 1, 1, '${NOW}', '2026-10-30T14:00:00Z'),
      ('${DRIVER_SESSION}', '${DRIVER_ID}', 1, 1, '${NOW}', '2026-10-30T14:00:00Z');
  `)

  return sqlite
}

describe('COM-019 Operational Alerts (Warehouse & Delivery)', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite?.close()
  })

  it('creates an informational alert using primary channel only (no redundant channel required)', async () => {
    const alertId = 'a0000000-0000-4000-8000-000000000001'
    const commandId = 'c0000000-0000-4000-8000-000000000001'
    const input: OperationalAlertInput = {
      area: 'warehouse',
      severity: 'info',
      category: 'minor_damage_hold',
      title: 'Caja con leve rasgadura en estantería B4',
      description: 'Envase exterior con pequeña rasgadura sin fuga química comprobado por operario.',
      locationRef: 'PASILLO-B-MODULO-4'
    }

    const alert = await createD1OperationalAlert(db, ADMIN_CLAIMS, alertId, commandId, input, { now: () => NOW })

    expect(alert.id).toBe(alertId)
    expect(alert.status).toBe('open')
    expect(alert.severity).toBe('info')
    expect(alert.redundantChannelRequired).toBe(false)
    expect(alert.redundantChannelDispatched).toBe(false)
    expect(alert.dispatches).toHaveLength(1)
    expect(alert.dispatches[0].channel).toBe('dashboard')
    expect(alert.dispatches[0].isRedundant).toBe(false)
  })

  it('creates a critical exception alert and automatically triggers redundant channel', async () => {
    const alertId = 'a0000000-0000-4000-8000-000000000002'
    const commandId = 'c0000000-0000-4000-8000-000000000002'
    const input: OperationalAlertInput = {
      area: 'warehouse',
      severity: 'critical',
      category: 'chemical_spill',
      title: 'Derrame químico de producto corrosivo en muelle 2',
      description: 'Rotura de bidón de 25L de limpiador clorado industrial. Se activa protocolo de absorción.',
      locationRef: 'MUELLE-2-DESCARGA'
    }

    const alert = await createD1OperationalAlert(db, ADMIN_CLAIMS, alertId, commandId, input, { now: () => NOW })

    expect(alert.id).toBe(alertId)
    expect(alert.severity).toBe('critical')
    expect(alert.redundantChannelRequired).toBe(true)
    expect(alert.redundantChannelDispatched).toBe(true)
    // Primary (dashboard) + Redundant (sms_pager)
    expect(alert.dispatches.length).toBeGreaterThanOrEqual(2)
    const redundant = alert.dispatches.find((d) => d.isRedundant)
    expect(redundant).toBeDefined()
    expect(redundant?.channel).toBe('sms_pager')
  })

  it('rejects un-auditable personal communication channels (e.g. personal chat/group)', async () => {
    const alertId = 'a0000000-0000-4000-8000-000000000003'
    const commandId = 'c0000000-0000-4000-8000-000000000003'
    const input = {
      area: 'delivery',
      severity: 'critical',
      category: 'vehicle_breakdown',
      title: 'Avería de furgoneta ruta norte',
      description: 'Vehículo averiado en N-VI km 24 con pedidos urgentes.',
      locationRef: 'RUTA-NORTE-VEHICULO-04',
      unapprovedChannel: 'personal_whatsapp_group'
    }

    await expect(
      createD1OperationalAlert(db, ADMIN_CLAIMS, alertId, commandId, input as unknown as OperationalAlertInput, {
        now: () => NOW
      })
    ).rejects.toThrow(OperationalAlertsError)
  })

  it('acknowledges an open alert with expected version (CAS) and records acknowledgment audit', async () => {
    const alertId = 'a0000000-0000-4000-8000-000000000004'
    const commandId1 = 'c0000000-0000-4000-8000-000000000004'
    await createD1OperationalAlert(
      db,
      ADMIN_CLAIMS,
      alertId,
      commandId1,
      {
        area: 'delivery',
        severity: 'critical',
        category: 'route_blocked',
        title: 'Corte de vía por obras en polígono industrial',
        description: 'Imposible acceder a entregas de clientes químicos del sector 3.',
        locationRef: 'RUTA-SUR-POLIGONO-IND'
      },
      { now: () => NOW }
    )

    const ackCommandId = 'c0000000-0000-4000-8000-000000000005'
    const ackInput: OperationalAlertAckInput = {
      expectedVersion: 1,
      ackNote: 'Recibido por supervisor de reparto. Reenrutando furgoneta por acceso secundario.'
    }

    const acked = await acknowledgeD1OperationalAlert(db, SUPERVISOR_CLAIMS, alertId, ackCommandId, ackInput, {
      now: () => '2026-10-29T14:05:00Z'
    })

    expect(acked.status).toBe('acknowledged')
    expect(acked.version).toBe(2)
    expect(acked.acknowledgedBy).toBe(SUPERVISOR_ID)
    expect(acked.acknowledgedAt).toBe('2026-10-29T14:05:00Z')
    expect(acked.ackNote).toContain('Reenrutando furgoneta')
  })

  it('rejects stale CAS expectedVersion on acknowledgment', async () => {
    const alertId = 'a0000000-0000-4000-8000-000000000006'
    await createD1OperationalAlert(
      db,
      ADMIN_CLAIMS,
      alertId,
      'c0000000-0000-4000-8000-000000000006',
      {
        area: 'warehouse',
        severity: 'warning',
        category: 'urgent_stock_shortage',
        title: 'Falta de stock urgente en preparación de pedido prioritario',
        description: 'Faltan 4 garrafas de desinfectante neutro.',
        locationRef: 'ZONA-PICKING-A'
      },
      { now: () => NOW }
    )

    await expect(
      acknowledgeD1OperationalAlert(
        db,
        SUPERVISOR_CLAIMS,
        alertId,
        'c0000000-0000-4000-8000-000000000007',
        { expectedVersion: 99, ackNote: 'Intento con versión desfasada' },
        { now: () => NOW }
      )
    ).rejects.toThrow(OperationalAlertsError)
  })

  it('escalates an alert to a higher tier with redundant escalation notification', async () => {
    const alertId = 'a0000000-0000-4000-8000-000000000008'
    await createD1OperationalAlert(
      db,
      ADMIN_CLAIMS,
      alertId,
      'c0000000-0000-4000-8000-000000000008',
      {
        area: 'warehouse',
        severity: 'critical',
        category: 'dock_blockage',
        title: 'Bloqueo total en muelle principal de expedición',
        description: 'Camión atascado bloqueando acceso a 3 muelles de carga.',
        locationRef: 'MUELLE-EXPEDICION-PRINCIPAL'
      },
      { now: () => NOW }
    )

    const escalateCommandId = 'c0000000-0000-4000-8000-000000000009'
    const escalateInput: OperationalAlertEscalateInput = {
      expectedVersion: 1,
      targetTier: 2,
      escalationReason: 'Sin resolución en 15 minutos en muelle. Se escala a dirección de operaciones.'
    }

    const escalated = await escalateD1OperationalAlert(
      db,
      SUPERVISOR_CLAIMS,
      alertId,
      escalateCommandId,
      escalateInput,
      { now: () => '2026-10-29T14:15:00Z' }
    )

    expect(escalated.status).toBe('escalated')
    expect(escalated.escalationTier).toBe(2)
    expect(escalated.escalatedAt).toBe('2026-10-29T14:15:00Z')
    expect(escalated.escalationReason).toContain('dirección de operaciones')

    // Verifies redundant escalation dispatch
    const updated = await getD1OperationalAlert(db, ADMIN_CLAIMS, alertId)
    const redundantDispatches = updated.dispatches.filter((d) => d.isRedundant)
    expect(redundantDispatches.length).toBeGreaterThanOrEqual(2)
  })

  it('resolves an alert recording the resolution note and closing the exception lifecycle', async () => {
    const alertId = 'a0000000-0000-4000-8000-000000000010'
    await createD1OperationalAlert(
      db,
      ADMIN_CLAIMS,
      alertId,
      'c0000000-0000-4000-8000-000000000010',
      {
        area: 'delivery',
        severity: 'warning',
        category: 'critical_delivery_delay',
        title: 'Retraso crítico por tráfico denso en circunvalación',
        description: 'Retraso estimado de 45 minutos en entregas de la tarde.',
        locationRef: 'CIRCUNVALACION-KM-12'
      },
      { now: () => NOW }
    )

    const resolveInput: OperationalAlertResolveInput = {
      expectedVersion: 1,
      resolutionNote: 'Tráfico descongestionado. Entregas completadas dentro del margen de seguridad ampliado.'
    }

    const resolved = await resolveD1OperationalAlert(
      db,
      ADMIN_CLAIMS,
      alertId,
      'c0000000-0000-4000-8000-000000000011',
      resolveInput,
      { now: () => '2026-10-29T15:00:00Z' }
    )

    expect(resolved.status).toBe('resolved')
    expect(resolved.resolvedBy).toBe(ADMIN_ID)
    expect(resolved.resolvedAt).toBe('2026-10-29T15:00:00Z')
  })

  it('guarantees idempotency on repeated command submission with matching payload', async () => {
    const alertId = 'a0000000-0000-4000-8000-000000000012'
    const commandId = 'c0000000-0000-4000-8000-000000000012'
    const input: OperationalAlertInput = {
      area: 'warehouse',
      severity: 'info',
      category: 'general_operational',
      title: 'Mantenimiento preventivo carretilla 03',
      description: 'Revisión periódica de batería y horquillas.',
      locationRef: 'TALLER-MANTENIMIENTO'
    }

    const first = await createD1OperationalAlert(db, ADMIN_CLAIMS, alertId, commandId, input, { now: () => NOW })
    const second = await createD1OperationalAlert(db, ADMIN_CLAIMS, alertId, commandId, input, { now: () => NOW })

    expect(first.id).toBe(second.id)
    expect(first.version).toBe(second.version)
  })

  it('rejects unauthenticated requests or sessions with revoked status', async () => {
    const alertId = 'a0000000-0000-4000-8000-000000000013'
    const commandId = 'c0000000-0000-4000-8000-000000000013'
    const fakeClaims = { identityId: '00000000-0000-4000-8000-000000000999', sessionId: '00000000-0000-4000-8000-000000000999', sessionVersion: 1 }

    await expect(
      createD1OperationalAlert(
        db,
        fakeClaims,
        alertId,
        commandId,
        {
          area: 'warehouse',
          severity: 'info',
          category: 'general_operational',
          title: 'Intento sin autenticación válida',
          description: 'No debería permitirse.',
          locationRef: 'TEST'
        },
        { now: () => NOW }
      )
    ).rejects.toThrow(OperationalAlertsError)
  })

  it('lists operational alerts with state and severity filters', async () => {
    const alertId1 = 'a0000000-0000-4000-8000-000000000021'
    const alertId2 = 'a0000000-0000-4000-8000-000000000022'
    await createD1OperationalAlert(
      db,
      ADMIN_CLAIMS,
      alertId1,
      'c0000000-0000-4000-8000-000000000021',
      {
        area: 'warehouse',
        severity: 'critical',
        category: 'chemical_spill',
        title: 'Alerta crítica activa',
        description: 'Fuga controlada.',
        locationRef: 'PASILLO-1'
      },
      { now: () => NOW }
    )
    await createD1OperationalAlert(
      db,
      ADMIN_CLAIMS,
      alertId2,
      'c0000000-0000-4000-8000-000000000022',
      {
        area: 'delivery',
        severity: 'info',
        category: 'general_operational',
        title: 'Alerta info activa',
        description: 'Información general.',
        locationRef: 'RUTA-1'
      },
      { now: () => NOW }
    )

    const criticalList = await listD1OperationalAlerts(db, ADMIN_CLAIMS, { severity: 'critical' })
    expect(criticalList.items.some((i) => i.id === alertId1)).toBe(true)
    expect(criticalList.items.some((i) => i.id === alertId2)).toBe(false)
  })
})
