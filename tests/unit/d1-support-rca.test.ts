import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  type CreateRcaInput,
  type UpdateRcaInput,
  type VerifyRcaInput,
  SupportRcaError
} from '../../shared/support-rca'
import {
  createD1SupportRca,
  updateD1SupportRca,
  verifyD1SupportRca,
  readD1SupportRca,
  listD1SupportRcas
} from '../../workers/support/rca'
import { testUuid } from '../support/deterministic'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: ADMIN_ID, sessionId: '20000000-0000-4000-8000-000000000001', sessionVersion: 1 }

async function setupRcaDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0110_rca_copilot_audiences.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Fixture admin'),
      ('operator', 'Operador', 'Fixture operator');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('support.manage', 'support', 'manage', 'Fixture support manage'),
      ('support.rca', 'support', 'rca', 'Fixture support rca');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'support.manage'),
      ('admin', 'support.rca');
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-rca@example.invalid', 'hash', 'active', '${NOW}', '${NOW}');
  `)
  return sqlite
}

describe('SUP-018: Systematic Root Cause Analysis (RCA) for operational incidents', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupRcaDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('creates an RCA for each of the 5 required operational incident categories', async () => {
    const categories = ['damage', 'picking_error', 'delay', 'stock_discrepancy', 'documentation'] as const

    for (const cat of categories) {
      const input: CreateRcaInput = {
        incidentCategory: cat,
        title: `Incidencia operativa de tipo ${cat}`,
        severity: 'high',
        rootCauseSummary: `Causa raíz detallada para ${cat} identificada en revisión de turno`,
        fiveWhys: [
          '¿Por qué falló el proceso?',
          '¿Por qué no se detectó en almacén?',
          '¿Por qué faltaba el checklist?',
          '¿Por qué se omitió la formación?',
          '¿Por qué no había protocolo preventivo?'
        ],
        preventiveActions: [
          {
            id: testUuid(),
            actionType: 'process_change',
            description: `Actualizar protocolo operativo para ${cat}`,
            assignee: 'Responsable de Calidad',
            targetDate: '2026-11-15T00:00:00Z',
            status: 'pending'
          }
        ]
      }

      const res = await createD1SupportRca(db, CLAIMS, input, {
        idempotencyKey: `idemp-create-${cat}`,
        now: () => NOW
      })

      expect(res.rcaId).toMatch(/^[0-9a-f-]{36}$/)
      expect(res.publicRef).toMatch(/^RCA-[0-9A-F]{20}$/)
      expect(res.version).toBe(1)
      expect(res.status).toBe('action_planned')

      const rca = await readD1SupportRca(db, res.rcaId)
      expect(rca).not.toBeNull()
      expect(rca!.incidentCategory).toBe(cat)
      expect(rca!.preventiveActions.length).toBe(1)
      expect(rca!.preventiveActions[0]!.actionType).toBe('process_change')
      expect(rca!.verificationStatus).toBe('unverified')
    }
  })

  it('rejects an invalid incident category outside the 5 required types', async () => {
    const input = {
      incidentCategory: 'marketing_mishap' as unknown as CreateRcaInput['incidentCategory'],
      title: 'Incidencia no válida',
      severity: 'medium',
      rootCauseSummary: 'Causa no categorizable',
      fiveWhys: ['1', '2', '3', '4', '5'],
      preventiveActions: []
    }

    await expect(
      createD1SupportRca(db, CLAIMS, input as CreateRcaInput, {
        idempotencyKey: 'idemp-invalid-cat',
        now: () => NOW
      })
    ).rejects.toThrow(SupportRcaError)
  })

  it('updates RCA investigation details with CAS version control', async () => {
    const createInput: CreateRcaInput = {
      incidentCategory: 'damage',
      title: 'Rotura de garrafas en flejado de palé',
      severity: 'critical',
      rootCauseSummary: 'Embalaje secundario insuficiente para envases de 5L de desengrasante',
      fiveWhys: [
        'Envase perforado',
        'Flejado con tensión excesiva',
        'Falta de cantoneras',
        'Ausencia de stock cantoneras',
        'Fallo aprovisionamiento'
      ],
      preventiveActions: [
        {
          id: testUuid(),
          actionType: 'packaging_update',
          description: 'Incorporar cantoneras reforzadas de cartón kraft en todos los palés químicos',
          assignee: 'Jefe de Almacén',
          targetDate: '2026-11-05T00:00:00Z',
          status: 'pending'
        }
      ]
    }

    const created = await createD1SupportRca(db, CLAIMS, createInput, {
      idempotencyKey: 'idemp-cas-1',
      now: () => NOW
    })

    // Update with correct expectedVersion = 1
    const updateInput: UpdateRcaInput = {
      expectedVersion: 1,
      severity: 'high',
      rootCauseSummary: 'Revisión técnica: flejado automático calibrado incorrectamente + embalaje corregido',
      preventiveActions: [
        {
          id: createInput.preventiveActions[0]!.id,
          actionType: 'packaging_update',
          description: 'Cantoneras reforzadas instaladas y calibración de flejadora terminada',
          assignee: 'Jefe de Almacén',
          targetDate: '2026-11-05T00:00:00Z',
          status: 'implemented',
          completedAt: '2026-10-29T12:00:00Z'
        }
      ]
    }

    const updated = await updateD1SupportRca(db, CLAIMS, created.rcaId, updateInput, {
      idempotencyKey: 'idemp-cas-update-1',
      now: () => NOW
    })

    expect(updated.version).toBe(2)

    // Attempt concurrent update with stale expectedVersion = 1 must fail with conflict
    await expect(
      updateD1SupportRca(db, CLAIMS, created.rcaId, updateInput, {
        idempotencyKey: 'idemp-cas-stale',
        now: () => NOW
      })
    ).rejects.toThrow(SupportRcaError)
  })

  it('verifies preventive action effectiveness and closes RCA', async () => {
    const createInput: CreateRcaInput = {
      incidentCategory: 'picking_error',
      title: 'Envío de lejía neutra en lugar de hipoclorito sódico concentrado',
      severity: 'high',
      rootCauseSummary: 'Etiquetas de estantería contiguas con códigos QR desgastados',
      fiveWhys: [
        'Error operario',
        'Ubicaciones pegadas',
        'QR ilegible',
        'Sin código de control visual',
        'Falta de auditoría periódica'
      ],
      preventiveActions: [
        {
          id: testUuid(),
          actionType: 'training',
          description: 'Recolocación física en pasillos distintos y reetiquetado reflectante',
          assignee: 'Supervisor Logística',
          targetDate: '2026-10-28T00:00:00Z',
          status: 'implemented',
          completedAt: '2026-10-28T18:00:00Z'
        }
      ]
    }

    const created = await createD1SupportRca(db, CLAIMS, createInput, {
      idempotencyKey: 'idemp-verify-1',
      now: () => NOW
    })

    // Verify effectiveness
    const verifyInput: VerifyRcaInput = {
      expectedVersion: 1,
      verificationStatus: 'verified_effective',
      verificationNotes: 'Comprobación tras 2 semanas: 0 errores de picking en pasillos 4 y 7 con doble escaneo'
    }

    const verified = await verifyD1SupportRca(db, CLAIMS, created.rcaId, verifyInput, {
      idempotencyKey: 'idemp-verify-cmd-1',
      now: () => NOW
    })

    expect(verified.version).toBe(2)
    expect(verified.verificationStatus).toBe('verified_effective')
    expect(verified.status).toBe('verified')

    const rca = await readD1SupportRca(db, created.rcaId)
    expect(rca!.verificationStatus).toBe('verified_effective')
    expect(rca!.verifiedBy).toBe(ADMIN_ID)
    expect(rca!.verificationNotes).toContain('0 errores de picking')
  })

  it('handles idempotency cleanly: exact duplicate idempotencyKey returns cached response without duplicate records', async () => {
    const input: CreateRcaInput = {
      incidentCategory: 'delay',
      title: 'Retraso en expedición por rotura de stock de bidones 25L',
      severity: 'medium',
      rootCauseSummary: 'Alerta de stock mínimo no configurada para envases industriales',
      fiveWhys: [
        'Sin stock',
        'Sin pedido a proveedor',
        'Sin umbral automatizado',
        'Migración incompleta',
        'Falta de checklist'
      ],
      preventiveActions: []
    }

    const res1 = await createD1SupportRca(db, CLAIMS, input, {
      idempotencyKey: 'idemp-repeat-key',
      now: () => NOW
    })

    const res2 = await createD1SupportRca(db, CLAIMS, input, {
      idempotencyKey: 'idemp-repeat-key',
      now: () => NOW
    })

    expect(res2.rcaId).toBe(res1.rcaId)
    expect(res2.version).toBe(res1.version)

    const list = await listD1SupportRcas(db, { category: 'delay' })
    expect(list.items.length).toBe(1)
  })

  it('rejects duplicate idempotency key with conflicting payload', async () => {
    const input1: CreateRcaInput = {
      incidentCategory: 'stock_discrepancy',
      title: 'Descuadre de 12 unidades en limpiador clorado',
      severity: 'medium',
      rootCauseSummary: 'Fuga interna no contabilizada como merma',
      fiveWhys: [
        'Descuadre físico',
        'Garrafa rota no registrada',
        'Sin parte de mermas',
        'Falta de formación',
        'Falta de procedimiento'
      ],
      preventiveActions: []
    }

    await createD1SupportRca(db, CLAIMS, input1, {
      idempotencyKey: 'idemp-conflict-test',
      now: () => NOW
    })

    const input2: CreateRcaInput = {
      ...input1,
      title: 'Descuadre diferente con la misma clave idempotente'
    }

    await expect(
      createD1SupportRca(db, CLAIMS, input2, {
        idempotencyKey: 'idemp-conflict-test',
        now: () => NOW
      })
    ).rejects.toThrow(SupportRcaError)
  })
})
