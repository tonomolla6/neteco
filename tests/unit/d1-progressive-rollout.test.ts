import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { CreateRolloutInput, RecordRolloutMetricsInput } from '../../shared/progressive-rollout'
import {
  createProgressiveRollout,
  evaluateProgressiveRollout,
  manualRollbackProgressiveRollout,
  promoteProgressiveRolloutFull,
  recordRolloutMetrics,
  updateProgressiveRollout
} from '../../workers/release/progressive-rollout'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'

async function setupDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0134_release_gates_progressive_rollout_policy_campaigns.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin@example.invalid', 'hash', 'active', '${NOW}', '${NOW}');
  `)
  return sqlite
}

const SAMPLE_NOTICE = {
  title: 'Acceso a Beta de Checkout B2B',
  summary: 'Está probando la versión Beta de cálculo de pedidos en tiempo real.',
  limitations: ['Límite de 50 líneas por pedido', 'Soporte directo disponible en soporte-beta@neteco.es'],
  learnMoreUrl: 'https://neteco.es/beta/b2b-checkout'
}

const SAMPLE_GUARDRAILS = {
  maxErrorRatePercent: 2.0, // Máximo 2% de error
  maxP95LatencyMs: 600, // Máximo 600ms de p95
  minSampleCount: 20 // Al menos 20 muestras antes de evaluar breach
}

describe('CIC-029: Despliegue progresivo por tráfico/cliente/zona y guardrails', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('crea y activa un despliegue progresivo por tráfico, cohortes y zonas', async () => {
    const input: CreateRolloutInput = {
      commandId: 'cmd-rollout-01',
      featureKey: 'b2b_checkout_v2',
      name: 'Nuevo Checkout B2B Progresivo',
      trafficPercentage: 25,
      cohorts: ['b2b_gold', 'beta_testers'],
      zones: ['ES-MD', 'ES-CT'],
      guardrails: SAMPLE_GUARDRAILS,
      betaScopeNotice: SAMPLE_NOTICE
    }

    const created = await createProgressiveRollout(db, input, ADMIN_ID, NOW)
    expect(created.status).toBe('draft')
    expect(created.trafficPercentage).toBe(25)
    expect(created.cohorts).toContain('b2b_gold')

    // Activación
    const activated = await updateProgressiveRollout(
      db,
      {
        commandId: 'cmd-rollout-activate',
        rolloutId: created.id,
        expectedVersion: created.version,
        status: 'active'
      },
      ADMIN_ID,
      NOW
    )
    expect(activated.status).toBe('active')
  })

  it('habilita la feature y entrega aviso de alcance Beta cuando el cliente pertenece a una cohorte asignada', async () => {
    const input: CreateRolloutInput = {
      commandId: 'cmd-rollout-02',
      featureKey: 'instant_invoice',
      name: 'Facturación Inmediata Beta',
      trafficPercentage: 0, // 0% de tráfico general
      cohorts: ['vip_partner'],
      zones: ['ES-MD'],
      guardrails: SAMPLE_GUARDRAILS,
      betaScopeNotice: SAMPLE_NOTICE
    }

    const rollout = await createProgressiveRollout(db, input, ADMIN_ID, NOW)
    await updateProgressiveRollout(
      db,
      { commandId: 'cmd-act-02', rolloutId: rollout.id, expectedVersion: 1, status: 'active' },
      ADMIN_ID,
      NOW
    )

    // Cliente en cohorte vip_partner
    const evalVip = await evaluateProgressiveRollout(db, {
      featureKey: 'instant_invoice',
      subjectId: 'cust_123',
      cohort: 'vip_partner'
    })

    expect(evalVip.enabled).toBe(true)
    expect(evalVip.reason).toBe('cohort_match')
    expect(evalVip.betaScopeNotice).toEqual(SAMPLE_NOTICE)

    // Cliente sin cohorte asignada y sin porcentaje de tráfico
    const evalStandard = await evaluateProgressiveRollout(db, {
      featureKey: 'instant_invoice',
      subjectId: 'cust_999',
      cohort: 'standard'
    })

    expect(evalStandard.enabled).toBe(false)
    expect(evalStandard.betaScopeNotice).toBeNull()
  })

  it('distribuye deterministicamente por tráfico entre zonas configuradas', async () => {
    const input: CreateRolloutInput = {
      commandId: 'cmd-rollout-03',
      featureKey: 'warehouse_route_opt',
      name: 'Optimización de rutas',
      trafficPercentage: 50,
      cohorts: [],
      zones: ['ES-MD'],
      guardrails: SAMPLE_GUARDRAILS,
      betaScopeNotice: SAMPLE_NOTICE
    }

    const rollout = await createProgressiveRollout(db, input, ADMIN_ID, NOW)
    await updateProgressiveRollout(
      db,
      { commandId: 'cmd-act-03', rolloutId: rollout.id, expectedVersion: 1, status: 'active' },
      ADMIN_ID,
      NOW
    )

    // Fuera de zona ES-MD
    const evalOutsideZone = await evaluateProgressiveRollout(db, {
      featureKey: 'warehouse_route_opt',
      subjectId: 'sub_test_01',
      zone: 'ES-SE'
    })
    expect(evalOutsideZone.enabled).toBe(false)

    // Mismo subject da siempre el mismo resultado determinista dentro de ES-MD
    const eval1 = await evaluateProgressiveRollout(db, {
      featureKey: 'warehouse_route_opt',
      subjectId: 'deterministic_user_xyz',
      zone: 'ES-MD'
    })
    const eval2 = await evaluateProgressiveRollout(db, {
      featureKey: 'warehouse_route_opt',
      subjectId: 'deterministic_user_xyz',
      zone: 'ES-MD'
    })
    expect(eval1.enabled).toBe(eval2.enabled)
  })

  it('auto-dispara rollback (tripped) ante violación de guardrails de tasa de error o latencia', async () => {
    const input: CreateRolloutInput = {
      commandId: 'cmd-rollout-guard',
      featureKey: 'fast_quote_calc',
      name: 'Cotización rápida',
      trafficPercentage: 100,
      cohorts: [],
      zones: [],
      guardrails: { maxErrorRatePercent: 1.5, maxP95LatencyMs: 400, minSampleCount: 10 },
      betaScopeNotice: SAMPLE_NOTICE
    }

    const rollout = await createProgressiveRollout(db, input, ADMIN_ID, NOW)
    await updateProgressiveRollout(
      db,
      { commandId: 'cmd-act-guard', rolloutId: rollout.id, expectedVersion: 1, status: 'active' },
      ADMIN_ID,
      NOW
    )

    // 1. Muestras saludables: 100 peticiones, 0 errores, p95 120ms
    const healthyMetrics: RecordRolloutMetricsInput = {
      commandId: 'cmd-metric-01',
      rolloutId: rollout.id,
      expectedVersion: 2,
      windowStart: '2026-10-29T11:50:00Z',
      windowEnd: '2026-10-29T11:55:00Z',
      sampleCount: 100,
      errorCount: 0,
      p95LatencyMs: 120
    }
    const evalHealthy = await recordRolloutMetrics(db, healthyMetrics, ADMIN_ID, NOW)
    expect(evalHealthy.breached).toBe(false)
    expect(evalHealthy.rolloutStatus).toBe('active')

    // 2. Muestras degradadas: 100 peticiones, 5 errores (5% > 1.5%), disparando breach
    const degradedMetrics: RecordRolloutMetricsInput = {
      commandId: 'cmd-metric-02',
      rolloutId: rollout.id,
      expectedVersion: 2, // versión no cambia en métrica no-breach, o se comprueba CAS
      windowStart: '2026-10-29T11:55:00Z',
      windowEnd: '2026-10-29T12:00:00Z',
      sampleCount: 100,
      errorCount: 5,
      p95LatencyMs: 250
    }
    const evalDegraded = await recordRolloutMetrics(db, degradedMetrics, ADMIN_ID, NOW)
    expect(evalDegraded.breached).toBe(true)
    expect(evalDegraded.rolloutStatus).toBe('tripped')

    // 3. Inmediatamente el evaluador desactiva el tráfico
    const evalAfterTrip = await evaluateProgressiveRollout(db, {
      featureKey: 'fast_quote_calc',
      subjectId: 'user_any'
    })
    expect(evalAfterTrip.enabled).toBe(false)
    expect(evalAfterTrip.status).toBe('tripped')
  })

  it('permite rollback manual inmediato por operador', async () => {
    const input: CreateRolloutInput = {
      commandId: 'cmd-rollout-manual',
      featureKey: 'test_manual_rb',
      name: 'Test Manual Rollback',
      trafficPercentage: 50,
      cohorts: [],
      zones: [],
      guardrails: SAMPLE_GUARDRAILS,
      betaScopeNotice: SAMPLE_NOTICE
    }

    const rollout = await createProgressiveRollout(db, input, ADMIN_ID, NOW)
    const active = await updateProgressiveRollout(
      db,
      { commandId: 'cmd-act-man', rolloutId: rollout.id, expectedVersion: 1, status: 'active' },
      ADMIN_ID,
      NOW
    )

    const rolledBack = await manualRollbackProgressiveRollout(
      db,
      {
        commandId: 'cmd-rb-action',
        rolloutId: rollout.id,
        expectedVersion: active.version,
        reason: 'Incidencia externa con proveedor logístico'
      },
      ADMIN_ID,
      NOW
    )
    expect(rolledBack.status).toBe('rolled_back')
    expect(rolledBack.tripReason).toContain('Incidencia externa')

    const evaluation = await evaluateProgressiveRollout(db, {
      featureKey: 'test_manual_rb',
      subjectId: 'any_subject'
    })
    expect(evaluation.enabled).toBe(false)
  })

  it('permite promoción al 100% (promoted_full) eliminando aviso de Beta para clientes', async () => {
    const input: CreateRolloutInput = {
      commandId: 'cmd-rollout-full',
      featureKey: 'feature_to_full',
      name: 'Feature Full',
      trafficPercentage: 50,
      cohorts: [],
      zones: [],
      guardrails: SAMPLE_GUARDRAILS,
      betaScopeNotice: SAMPLE_NOTICE
    }

    const rollout = await createProgressiveRollout(db, input, ADMIN_ID, NOW)
    const full = await promoteProgressiveRolloutFull(
      db,
      { commandId: 'cmd-full-promo', rolloutId: rollout.id, expectedVersion: 1 },
      ADMIN_ID,
      NOW
    )
    expect(full.status).toBe('promoted_full')
    expect(full.trafficPercentage).toBe(100)

    const evaluation = await evaluateProgressiveRollout(db, {
      featureKey: 'feature_to_full',
      subjectId: 'guest_user'
    })
    expect(evaluation.enabled).toBe(true)
    expect(evaluation.reason).toBe('promoted_full')
    expect(evaluation.betaScopeNotice).toBeNull() // Ya no es Beta, es producción general
  })
})
