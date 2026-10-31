import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  type GameDayScenarioInput,
  GAME_DAY_SCENARIOS,
  GAME_DAY_RUNBOOKS,
  evaluateScenarioResult,
  evaluateTrafficExpansionGate,
  gameDayDrillCreateInputSchema,
  gameDayScenarioInputSchema
} from '../../shared/game-day-resilience'
import {
  GameDayResilienceError,
  createD1GameDayDrill,
  recordD1GameDayScenarioResult,
  completeD1GameDayDrill,
  getD1GameDayDrillDetail,
  listD1GameDayDrills,
  evaluateD1TrafficExpansionGate
} from '../../workers/observability/game-day-resilience'
import { handleGameDayHttp, ownsGameDayNamespace } from '../../workers/observability/game-day-resilience-http'

const NOW = '2026-10-31T10:00:00Z'
const PAST_DATE = '2026-10-01T08:00:00Z'
const EXPIRED_DATE = '2026-09-01T08:00:00Z'

const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }

const OPERATOR_ID = '10000000-0000-4000-8000-000000000002'
const OPERATOR_SESSION = '20000000-0000-4000-8000-000000000002'
const OPERATOR_CLAIMS = { identityId: OPERATOR_ID, sessionId: OPERATOR_SESSION, sessionVersion: 1 }

async function setupTestDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0144_game_day_and_marketing_automation_observability.sql', import.meta.url),
      'utf8'
    )
  )

  // Roles & permissions
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Fixture admin'),
      ('operator', 'Operador', 'Fixture operador');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin'),
      ('inventory.read', 'inventory', 'read', 'Fixture operador');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('operator', 'inventory.read');
  `)

  // Admin identity & session with MFA
  sqlite.exec(`
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
    VALUES ('${ADMIN_ID}', 'admin-gameday@neteco.es', 'hash', 'active', 1, '${PAST_DATE}', '${PAST_DATE}', '${PAST_DATE}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
    VALUES ('${ADMIN_SESSION}', '${ADMIN_ID}', 1, 1, '${PAST_DATE}', '2030-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at)
    VALUES ('${ADMIN_ID}', 'admin', '${PAST_DATE}');
  `)

  // Operator without administration.manage
  sqlite.exec(`
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
    VALUES ('${OPERATOR_ID}', 'operator-gameday@neteco.es', 'hash', 'active', 1, '${PAST_DATE}', '${PAST_DATE}', '${PAST_DATE}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
    VALUES ('${OPERATOR_SESSION}', '${OPERATOR_ID}', 1, 1, '${PAST_DATE}', '2030-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at)
    VALUES ('${OPERATOR_ID}', 'operator', '${PAST_DATE}');
  `)

  return sqlite
}

describe('Game Day Resilience & Traffic Expansion Gate (OBS-024)', () => {
  let sqlite: DatabaseSync
  let d1: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDatabase()
    d1 = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  describe('Scenario Evaluation Logic (Domain)', () => {
    it('contains all 7 governed fault scenarios in GAME_DAY_SCENARIOS', () => {
      expect(GAME_DAY_SCENARIOS).toEqual([
        'beply_outage',
        'carrier_outage',
        'd1_outage',
        'durable_object_outage',
        'queue_outage',
        'r2_outage',
        'worker_deployment_failure'
      ])
    })

    it('contains valid runbooks for all 7 scenarios', () => {
      for (const scenarioId of GAME_DAY_SCENARIOS) {
        const runbook = GAME_DAY_RUNBOOKS[scenarioId]
        expect(runbook).toBeDefined()
        expect(runbook.id).toMatch(/^RB-GAME-/)
        expect(runbook.title.length).toBeGreaterThan(5)
        expect(runbook.steps.length).toBeGreaterThanOrEqual(3)
        expect(runbook.mitigationActions.length).toBeGreaterThanOrEqual(1)
      }
    })

    it('evaluates scenario as PASSED when detection, recovery and alerts meet target SLOs', () => {
      const input: GameDayScenarioInput = {
        scenarioId: 'beply_outage',
        targetDetectionSeconds: 60,
        actualDetectionSeconds: 25,
        targetRecoverySeconds: 300,
        actualRecoverySeconds: 120,
        targetDataLossSeconds: 0,
        actualDataLossSeconds: 0,
        alertTriggered: true,
        alertSeverity: 'critical',
        alertChannel: 'pagerduty',
        rollbackRestoreStatus: 'restore_completed',
        coordinationStatus: 'completed',
        runbookReference: 'RB-GAME-BEPLY',
        details: { simulatedError: 'HTTP 503 Backend Fetch Failed', retryBufferSuccess: true }
      }
      const evaluation = evaluateScenarioResult(input)
      expect(evaluation.status).toBe('passed')
      expect(evaluation.targetMet).toBe(true)
      expect(evaluation.breaches).toHaveLength(0)
    })

    it('evaluates scenario as FAILED when detection exceeds target', () => {
      const input: GameDayScenarioInput = {
        scenarioId: 'd1_outage',
        targetDetectionSeconds: 30,
        actualDetectionSeconds: 95, // Breached
        targetRecoverySeconds: 180,
        actualRecoverySeconds: 120,
        targetDataLossSeconds: 0,
        actualDataLossSeconds: 0,
        alertTriggered: true,
        alertSeverity: 'critical',
        alertChannel: 'pagerduty',
        rollbackRestoreStatus: 'restore_completed',
        coordinationStatus: 'completed',
        runbookReference: 'RB-GAME-D1'
      }
      const evaluation = evaluateScenarioResult(input)
      expect(evaluation.status).toBe('failed')
      expect(evaluation.targetMet).toBe(false)
      expect(evaluation.breaches).toContain('detection_time_exceeded')
    })

    it('evaluates scenario as FAILED when alert was NOT triggered', () => {
      const input: GameDayScenarioInput = {
        scenarioId: 'queue_outage',
        targetDetectionSeconds: 60,
        actualDetectionSeconds: 30,
        targetRecoverySeconds: 300,
        actualRecoverySeconds: 150,
        targetDataLossSeconds: 0,
        actualDataLossSeconds: 0,
        alertTriggered: false, // Critical failure
        alertSeverity: 'warning',
        alertChannel: 'slack_sre',
        rollbackRestoreStatus: 'not_needed',
        coordinationStatus: 'completed',
        runbookReference: 'RB-GAME-QUEUE'
      }
      const evaluation = evaluateScenarioResult(input)
      expect(evaluation.status).toBe('failed')
      expect(evaluation.breaches).toContain('alert_not_triggered')
    })

    it('evaluates scenario as FAILED when rollback/restore failed on worker deployment failure', () => {
      const input: GameDayScenarioInput = {
        scenarioId: 'worker_deployment_failure',
        targetDetectionSeconds: 30,
        actualDetectionSeconds: 20,
        targetRecoverySeconds: 120,
        actualRecoverySeconds: 400, // Breached
        targetDataLossSeconds: 0,
        actualDataLossSeconds: 0,
        alertTriggered: true,
        alertSeverity: 'critical',
        alertChannel: 'pagerduty',
        rollbackRestoreStatus: 'failed', // Failed rollback
        coordinationStatus: 'delayed',
        runbookReference: 'RB-GAME-WORKER'
      }
      const evaluation = evaluateScenarioResult(input)
      expect(evaluation.status).toBe('failed')
      expect(evaluation.breaches).toContain('rollback_restore_failed')
      expect(evaluation.breaches).toContain('recovery_time_exceeded')
    })

    it('evaluates scenario as WARNING when coordination was delayed but recovery was within target', () => {
      const input: GameDayScenarioInput = {
        scenarioId: 'carrier_outage',
        targetDetectionSeconds: 60,
        actualDetectionSeconds: 45,
        targetRecoverySeconds: 300,
        actualRecoverySeconds: 250,
        targetDataLossSeconds: 0,
        actualDataLossSeconds: 0,
        alertTriggered: true,
        alertSeverity: 'warning',
        alertChannel: 'slack_sre',
        rollbackRestoreStatus: 'not_needed',
        coordinationStatus: 'delayed', // Delayed coordination
        runbookReference: 'RB-GAME-CARRIER'
      }
      const evaluation = evaluateScenarioResult(input)
      expect(evaluation.status).toBe('warning')
      expect(evaluation.warnings).toContain('coordination_delayed')
    })
  })

  describe('Traffic Expansion Gate Evaluation', () => {
    it('APPROVES traffic expansion when all 7 scenarios passed within freshness window (<= 30 days)', () => {
      const scenarios = GAME_DAY_SCENARIOS.map((id) => ({
        scenarioId: id,
        status: 'passed' as const,
        targetMet: true,
        breaches: [],
        warnings: []
      }))

      const gate = evaluateTrafficExpansionGate({
        completedAt: '2026-10-25T12:00:00Z',
        now: NOW,
        scenarios
      })

      expect(gate.status).toBe('approved')
      expect(gate.approved).toBe(true)
      expect(gate.scenariosTotal).toBe(7)
      expect(gate.scenariosPassed).toBe(7)
      expect(gate.reasons).toEqual([])
    })

    it('BLOCKS traffic expansion when any scenario failed', () => {
      const scenarios = GAME_DAY_SCENARIOS.map((id) => ({
        scenarioId: id,
        status: (id === 'beply_outage' ? 'failed' : 'passed') as 'passed' | 'failed',
        targetMet: id !== 'beply_outage',
        breaches: id === 'beply_outage' ? ['detection_time_exceeded'] : [],
        warnings: []
      }))

      const gate = evaluateTrafficExpansionGate({
        completedAt: '2026-10-25T12:00:00Z',
        now: NOW,
        scenarios
      })

      expect(gate.status).toBe('blocked')
      expect(gate.approved).toBe(false)
      expect(gate.reasons).toContain('scenario_failed: beply_outage (detection_time_exceeded)')
    })

    it('BLOCKS traffic expansion when scenarios are incomplete (< 7 scenarios)', () => {
      const scenarios = GAME_DAY_SCENARIOS.slice(0, 5).map((id) => ({
        scenarioId: id,
        status: 'passed' as const,
        targetMet: true,
        breaches: [],
        warnings: []
      }))

      const gate = evaluateTrafficExpansionGate({
        completedAt: '2026-10-25T12:00:00Z',
        now: NOW,
        scenarios
      })

      expect(gate.status).toBe('blocked')
      expect(gate.approved).toBe(false)
      expect(gate.reasons).toContain('incomplete_scenarios: missing 2 required fault scenarios')
    })

    it('BLOCKS traffic expansion when latest drill is expired (> 30 days old)', () => {
      const scenarios = GAME_DAY_SCENARIOS.map((id) => ({
        scenarioId: id,
        status: 'passed' as const,
        targetMet: true,
        breaches: [],
        warnings: []
      }))

      const gate = evaluateTrafficExpansionGate({
        completedAt: EXPIRED_DATE,
        now: NOW,
        scenarios
      })

      expect(gate.status).toBe('blocked')
      expect(gate.approved).toBe(false)
      expect(gate.reasons).toContain('drill_expired: last game day executed > 30 days ago')
    })
  })

  describe('D1 Database & Drill Lifecycle Operations', () => {
    it('creates a drill, records scenarios, and completes drill with CAS versioning', async () => {
      // 1. Create Drill
      const createInput = gameDayDrillCreateInputSchema.parse({
        cohort: 'Campana Quimicos Otono 2026 - Trafico 3x',
        notes: 'Simulacro previo a campana masiva B2B'
      })

      const drill = await createD1GameDayDrill(
        d1,
        ADMIN_CLAIMS,
        createInput,
        { commandId: '40000000-0000-4000-8000-000000000001', idempotencyKey: 'cmd-create-01' },
        { now: () => NOW }
      )

      expect(drill.id).toBeDefined()
      expect(drill.cohort).toBe('Campana Quimicos Otono 2026 - Trafico 3x')
      expect(drill.status).toBe('in_progress')
      expect(drill.version).toBe(1)
      expect(drill.scenariosPassed).toBe(0)

      // 2. Record all 7 scenarios
      for (const [idx, scenarioId] of GAME_DAY_SCENARIOS.entries()) {
        const scenarioInput = gameDayScenarioInputSchema.parse({
          scenarioId,
          targetDetectionSeconds: 60,
          actualDetectionSeconds: 20 + idx,
          targetRecoverySeconds: 300,
          actualRecoverySeconds: 90 + idx * 5,
          targetDataLossSeconds: 0,
          actualDataLossSeconds: 0,
          alertTriggered: true,
          alertSeverity: 'critical',
          alertChannel: 'pagerduty',
          rollbackRestoreStatus: scenarioId === 'worker_deployment_failure' ? 'rollback_executed' : 'restore_completed',
          coordinationStatus: 'completed',
          runbookReference: GAME_DAY_RUNBOOKS[scenarioId].id
        })

        const result = await recordD1GameDayScenarioResult(
          d1,
          ADMIN_CLAIMS,
          drill.id,
          scenarioInput,
          { commandId: `40000000-0000-4000-8000-00000000001${idx}`, idempotencyKey: `cmd-scen-${scenarioId}` },
          { now: () => NOW }
        )

        expect(result.status).toBe('passed')
        expect(result.scenarioId).toBe(scenarioId)
      }

      // 3. Complete Drill
      const completed = await completeD1GameDayDrill(
        d1,
        ADMIN_CLAIMS,
        drill.id,
        { expectedVersion: 1, notes: 'Completado con exito rotundo los 7 fallos controlados.' },
        { commandId: '40000000-0000-4000-8000-000000000099', idempotencyKey: 'cmd-complete-01' },
        { now: () => NOW }
      )

      expect(completed.status).toBe('passed')
      expect(completed.expansionGate).toBe('approved')
      expect(completed.scenariosTotal).toBe(7)
      expect(completed.scenariosPassed).toBe(7)
      expect(completed.scenariosFailed).toBe(0)
      expect(completed.version).toBe(2)

      // 4. Retrieve detail
      const detail = await getD1GameDayDrillDetail(d1, ADMIN_CLAIMS, drill.id)
      expect(detail.scenarios).toHaveLength(7)
      expect(detail.expansionGate).toBe('approved')

      // 5. Query overall traffic expansion gate
      const gateCheck = await evaluateD1TrafficExpansionGate(d1, ADMIN_CLAIMS, { now: () => NOW })
      expect(gateCheck.status).toBe('approved')
      expect(gateCheck.approved).toBe(true)
      expect(gateCheck.latestDrillId).toBe(drill.id)
    })

    it('enforces CAS optimistic concurrency on drill completion', async () => {
      const drill = await createD1GameDayDrill(
        d1,
        ADMIN_CLAIMS,
        { cohort: 'CAS Concurrency Test Cohort', notes: '' },
        { commandId: '40000000-0000-4000-8000-000000000002', idempotencyKey: 'cmd-create-cas' },
        { now: () => NOW }
      )

      await expect(
        completeD1GameDayDrill(
          d1,
          ADMIN_CLAIMS,
          drill.id,
          { expectedVersion: 99, notes: 'Wrong version' }, // Wrong version!
          { commandId: '40000000-0000-4000-8000-000000000003', idempotencyKey: 'cmd-complete-cas' },
          { now: () => NOW }
        )
      ).rejects.toThrow(GameDayResilienceError)
    })

    it('blocks duplicate scenario recording in same drill', async () => {
      const drill = await createD1GameDayDrill(
        d1,
        ADMIN_CLAIMS,
        { cohort: 'Duplicate Scenario Test', notes: '' },
        { commandId: '40000000-0000-4000-8000-000000000004', idempotencyKey: 'cmd-create-dup' },
        { now: () => NOW }
      )

      const scenInput: GameDayScenarioInput = {
        scenarioId: 'beply_outage',
        targetDetectionSeconds: 60,
        actualDetectionSeconds: 30,
        targetRecoverySeconds: 300,
        actualRecoverySeconds: 100,
        targetDataLossSeconds: 0,
        actualDataLossSeconds: 0,
        alertTriggered: true,
        alertSeverity: 'critical',
        alertChannel: 'pagerduty',
        rollbackRestoreStatus: 'restore_completed',
        coordinationStatus: 'completed',
        runbookReference: 'RB-GAME-BEPLY'
      }

      await recordD1GameDayScenarioResult(
        d1,
        ADMIN_CLAIMS,
        drill.id,
        scenInput,
        { commandId: '40000000-0000-4000-8000-000000000005', idempotencyKey: 'cmd-scen-beply-1' },
        { now: () => NOW }
      )

      await expect(
        recordD1GameDayScenarioResult(
          d1,
          ADMIN_CLAIMS,
          drill.id,
          scenInput,
          { commandId: '40000000-0000-4000-8000-000000000006', idempotencyKey: 'cmd-scen-beply-2' },
          { now: () => NOW }
        )
      ).rejects.toThrow(GameDayResilienceError)
    })

    it('enforces table immutability: deletion of drill or scenario is aborted by SQLite trigger', async () => {
      const drill = await createD1GameDayDrill(
        d1,
        ADMIN_CLAIMS,
        { cohort: 'Immutable Drill Test', notes: '' },
        { commandId: '40000000-0000-4000-8000-000000000007', idempotencyKey: 'cmd-immut-1' },
        { now: () => NOW }
      )

      expect(() => {
        sqlite.exec(`DELETE FROM game_day_drills WHERE id = '${drill.id}'`)
      }).toThrow(/game_day_drill_immutable/)
    })
  })

  describe('Authorization and Security', () => {
    it('rejects unauthenticated requests without valid session', async () => {
      const fakeClaims = {
        identityId: '00000000-0000-4000-8000-000000000000',
        sessionId: '00000000-0000-4000-8000-000000000000',
        sessionVersion: 1
      }
      await expect(listD1GameDayDrills(d1, fakeClaims)).rejects.toThrow(GameDayResilienceError)
    })

    it('rejects operator without administration.manage permission', async () => {
      await expect(
        createD1GameDayDrill(
          d1,
          OPERATOR_CLAIMS,
          { cohort: 'Unauthorized Cohort', notes: '' },
          { commandId: '40000000-0000-4000-8000-000000000008', idempotencyKey: 'cmd-unauth-1' },
          { now: () => NOW }
        )
      ).rejects.toThrow(GameDayResilienceError)
    })
  })

  describe('HTTP Handler (Canary API Integration)', () => {
    it('accurately identifies owned paths with ownsGameDayNamespace', () => {
      expect(ownsGameDayNamespace('/api/admin/observability/game-day')).toBe(true)
      expect(ownsGameDayNamespace('/api/admin/observability/game-day/drills')).toBe(true)
      expect(ownsGameDayNamespace('/api/admin/observability/game-day/gate')).toBe(true)
      expect(ownsGameDayNamespace('/api/admin/observability/game-day/runbooks')).toBe(true)
      expect(ownsGameDayNamespace('/api/admin/observability/anomalies')).toBe(false)
      expect(ownsGameDayNamespace('/api/products')).toBe(false)
    })

    it('serves runbooks via GET /runbooks', async () => {
      const req = new Request('https://admin.neteco.es/api/admin/observability/game-day/runbooks', {
        method: 'GET'
      })
      const res = await handleGameDayHttp(req, {
        database: d1,
        sessionCookieConfiguration: null,
        claimsResolver: async () => ADMIN_CLAIMS,
        now: () => NOW
      })

      expect(res).toBeDefined()
      expect(res!.status).toBe(200)
      const data = (await res!.json()) as { runbooks: Record<string, unknown> }
      expect(data.runbooks).toBeDefined()
      expect(Object.keys(data.runbooks)).toHaveLength(7)
    })

    it('creates drill via POST /drills and returns 201', async () => {
      const req = new Request('https://admin.neteco.es/api/admin/observability/game-day/drills', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://admin.neteco.es',
          'sec-fetch-site': 'same-origin',
          'x-idempotency-key': 'http-create-01'
        },
        body: JSON.stringify({
          cohort: 'HTTP Test Expansion Drill',
          notes: 'Executed via HTTP Canary'
        })
      })

      const res = await handleGameDayHttp(req, {
        database: d1,
        sessionCookieConfiguration: null,
        origin: 'https://admin.neteco.es',
        claimsResolver: async () => ADMIN_CLAIMS,
        now: () => NOW
      })

      expect(res).toBeDefined()
      expect(res!.status).toBe(201)
      const data = (await res!.json()) as { drill: { id: string; cohort: string } }
      expect(data.drill.cohort).toBe('HTTP Test Expansion Drill')
    })

    it('rejects cross-site CSRF attacks on POST endpoints', async () => {
      const req = new Request('https://admin.neteco.es/api/admin/observability/game-day/drills', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil-hacker.com',
          'sec-fetch-site': 'cross-site'
        },
        body: JSON.stringify({ cohort: 'Evil', notes: '' })
      })

      const res = await handleGameDayHttp(req, {
        database: d1,
        sessionCookieConfiguration: null,
        origin: 'https://admin.neteco.es',
        claimsResolver: async () => ADMIN_CLAIMS,
        now: () => NOW
      })

      expect(res).toBeDefined()
      expect(res!.status).toBe(403)
      const data = (await res!.json()) as { error: { code: string } }
      expect(data.error.code).toBe('cross_site_forbidden')
    })
  })
})
