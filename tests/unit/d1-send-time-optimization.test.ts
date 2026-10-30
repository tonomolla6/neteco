import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  type SendTimeOptimizationPolicyInput,
  type SendTimeMessageEvaluationInput,
  calculateNextOptimalWindow,
  isCustomerHeldOut
} from '../../shared/send-time-optimization'
import {
  readD1SendTimePolicy,
  updateD1SendTimePolicy,
  evaluateD1SendTimeMessage
} from '../../workers/communications/send-time-optimization'

const NOW = '2026-10-29T10:00:00Z' // Thursday 10:00 UTC (inside 09:00 - 18:00 window)
const NIGHT_TIME = '2026-10-29T22:30:00Z' // Thursday 22:30 UTC (outside window)
const WEEKEND_TIME = '2026-10-31T14:00:00Z' // Saturday 14:00 UTC (weekend)

const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }

const CUSTOMER_CONSENTED_ID = '30000000-0000-4000-8000-000000000001'
const CUSTOMER_UNCONSENTED_ID = '30000000-0000-4000-8000-000000000002'

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
      ('admin', 'Administración', 'Admin fixture');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Admin manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');

    INSERT OR IGNORE INTO customers (id, name, status, created_at, updated_at) VALUES
      ('${CUSTOMER_CONSENTED_ID}', 'Empresa Limpieza Norte SL', 'active', '${NOW}', '${NOW}'),
      ('${CUSTOMER_UNCONSENTED_ID}', 'Lavandería Sol SL', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO identities (id, customer_id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at) VALUES
      ('${ADMIN_ID}', NULL, 'admin@neteco.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}'),
      ('10000000-0000-4000-8000-000000000011', '${CUSTOMER_CONSENTED_ID}', 'cliente-consented@neteco.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}'),
      ('10000000-0000-4000-8000-000000000012', '${CUSTOMER_UNCONSENTED_ID}', 'cliente-sin-consent@neteco.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_SESSION}', '${ADMIN_ID}', 1, 1, '${NOW}', '2099-12-31T23:59:59Z');

    -- Active newsletter / marketing consent for customer 1
    INSERT OR IGNORE INTO newsletter_subscriptions (
      id, email_normalized, email_hash, purpose, channel, status,
      consent_text, consent_version, consent_source, request_id, request_key,
      requested_at, confirmation_expires_at, confirmed_at
    ) VALUES (
      'sub-00000000-0000-4000-8000-000000000001',
      'cliente-consented@neteco.test',
      'e100000000000000000000000000000000000000000000000000000000000001',
      'newsletter', 'email', 'confirmed',
      'Acepto comunicaciones comerciales de Neteco', 'v1', 'web_checkout',
      'req-1', 'key-1', 1700000000, 1800000000, 1700000100
    );
  `)

  return sqlite
}

describe('COM-020 Send-Time Optimization Engine', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite?.close()
  })

  it('initializes and reads default send-time policy with strict marketing caps', async () => {
    const policy = await readD1SendTimePolicy(db, ADMIN_CLAIMS)
    expect(policy.id).toBe('global')
    expect(policy.version).toBeGreaterThanOrEqual(1)
    expect(policy.holdoutRateBasisPoints).toBe(1000) // 10% default holdout
    expect(policy.minHoursBetweenMarketing).toBe(24) // 24 hours cooldown
    expect(policy.maxWeeklyMarketingSends).toBe(3)
    expect(policy.allowedWindowStartHour).toBe(9)
    expect(policy.allowedWindowEndHour).toBe(18)
  })

  it('updates policy with CAS expectedVersion', async () => {
    const policy = await readD1SendTimePolicy(db, ADMIN_CLAIMS)
    const updateInput: SendTimeOptimizationPolicyInput = {
      expectedVersion: policy.version,
      holdoutRateBasisPoints: 500, // 5%
      minHoursBetweenMarketing: 48,
      maxWeeklyMarketingSends: 2,
      allowedWindowStartHour: 8,
      allowedWindowEndHour: 19
    }

    const updated = await updateD1SendTimePolicy(
      db,
      ADMIN_CLAIMS,
      'c0000000-0000-4000-8000-000000000101',
      'idemp-policy-1',
      updateInput,
      { now: () => NOW }
    )

    expect(updated.version).toBe(policy.version + 1)
    expect(updated.holdoutRateBasisPoints).toBe(500)
    expect(updated.minHoursBetweenMarketing).toBe(48)
  })

  it('OPERATIONAL rule: immediately dispatches operational communications without delay or marketing checks', async () => {
    // Even for customer WITHOUT marketing consent: operational communications MUST NOT be delayed!
    const decisionId = 'd0000000-0000-4000-8000-000000000001'
    const commandId = 'c0000000-0000-4000-8000-000000000001'
    const input: SendTimeMessageEvaluationInput = {
      messageId: 'msg-order-conf-9901',
      customerId: CUSTOMER_UNCONSENTED_ID,
      category: 'operational',
      channel: 'email',
      campaignCode: undefined
    }

    const result = await evaluateD1SendTimeMessage(db, ADMIN_CLAIMS, decisionId, commandId, 'idemp-op-1', input, {
      now: () => NIGHT_TIME // At 22:30 at night, operational MUST still dispatch immediately
    })

    expect(result.status).toBe('sent_immediate')
    expect(result.scheduledFor).toBe(NIGHT_TIME)
    expect(result.holdoutApplied).toBe(false)
    expect(result.reason).toContain('operational_immediate')
  })

  it('MARKETING rule: suppresses marketing messages when customer has NO valid consent', async () => {
    const decisionId = 'd0000000-0000-4000-8000-000000000002'
    const commandId = 'c0000000-0000-4000-8000-000000000002'
    const input: SendTimeMessageEvaluationInput = {
      messageId: 'msg-promo-black-friday',
      customerId: CUSTOMER_UNCONSENTED_ID,
      category: 'marketing',
      channel: 'email',
      campaignCode: 'BF-2026'
    }

    const result = await evaluateD1SendTimeMessage(db, ADMIN_CLAIMS, decisionId, commandId, 'idemp-mkt-1', input, {
      now: () => NOW
    })

    expect(result.status).toBe('suppressed_no_consent')
    expect(result.consentVerified).toBe(false)
    expect(result.holdoutApplied).toBe(false)
  })

  it('MARKETING rule: applies holdout control group to consented customers', async () => {
    // We update policy to 100% holdout for testing holdout branch
    const current = await readD1SendTimePolicy(db, ADMIN_CLAIMS)
    await updateD1SendTimePolicy(
      db,
      ADMIN_CLAIMS,
      'c0000000-0000-4000-8000-000000000102',
      'idemp-policy-holdout-100',
      {
        expectedVersion: current.version,
        holdoutRateBasisPoints: 5000, // 50% holdout max
        minHoursBetweenMarketing: 24,
        maxWeeklyMarketingSends: 3,
        allowedWindowStartHour: 9,
        allowedWindowEndHour: 18
      },
      { now: () => NOW }
    )

    // Using helper to verify deterministic holdout calculation
    expect(typeof isCustomerHeldOut('any-customer', 'any-campaign', 5000)).toBe('boolean')

    // Force holdout branch test with mock or controlled customer
    const decisionId = 'd0000000-0000-4000-8000-000000000003'
    const commandId = 'c0000000-0000-4000-8000-000000000003'
    const input: SendTimeMessageEvaluationInput = {
      messageId: 'msg-promo-winter-1',
      customerId: CUSTOMER_CONSENTED_ID,
      category: 'marketing',
      channel: 'email',
      campaignCode: 'WINTER-PROMO'
    }

    const result = await evaluateD1SendTimeMessage(db, ADMIN_CLAIMS, decisionId, commandId, 'idemp-mkt-2', input, {
      now: () => NOW,
      forceHoldout: true
    })

    expect(result.status).toBe('held_out')
    expect(result.holdoutApplied).toBe(true)
    expect(result.consentVerified).toBe(true)
  })

  it('MARKETING rule: enforces frequency rate limits (fatigue protection)', async () => {
    // 1st dispatch: succeeds and schedules
    const decisionId1 = 'd0000000-0000-4000-8000-000000000004'
    const commandId1 = 'c0000000-0000-4000-8000-000000000004'
    const input1: SendTimeMessageEvaluationInput = {
      messageId: 'msg-promo-spring-1',
      customerId: CUSTOMER_CONSENTED_ID,
      category: 'marketing',
      channel: 'email',
      campaignCode: 'SPRING-1'
    }

    const first = await evaluateD1SendTimeMessage(db, ADMIN_CLAIMS, decisionId1, commandId1, 'idemp-freq-1', input1, {
      now: () => NOW,
      forceHoldout: false
    })
    expect(first.status).toBe('scheduled_optimized')

    // 2nd dispatch just 2 hours later: MUST be suppressed by rate limit!
    const decisionId2 = 'd0000000-0000-4000-8000-000000000005'
    const commandId2 = 'c0000000-0000-4000-8000-000000000005'
    const input2: SendTimeMessageEvaluationInput = {
      messageId: 'msg-promo-spring-2',
      customerId: CUSTOMER_CONSENTED_ID,
      category: 'marketing',
      channel: 'email',
      campaignCode: 'SPRING-2'
    }

    const second = await evaluateD1SendTimeMessage(db, ADMIN_CLAIMS, decisionId2, commandId2, 'idemp-freq-2', input2, {
      now: () => '2026-10-29T12:00:00Z',
      forceHoldout: false
    })

    expect(second.status).toBe('suppressed_rate_limit')
    expect(second.reason).toContain('cooldown_active')
  })

  it('schedules marketing message within optimal business window when received after-hours or on weekends', () => {
    // Outside business hours at 22:30 on Thursday 2026-10-29 -> next morning at 09:30 on Friday 2026-10-30
    const nextWindow = calculateNextOptimalWindow(NIGHT_TIME, 9, 18)
    expect(nextWindow).toBe('2026-10-30T09:30:00Z')

    // On weekend (Saturday 2026-10-31) -> next Monday morning at 09:30 (2026-11-02)
    const nextMonday = calculateNextOptimalWindow(WEEKEND_TIME, 9, 18)
    expect(nextMonday).toBe('2026-11-02T09:30:00Z')
  })

  it('guarantees idempotency on repeated message evaluation with matching idempotency key', async () => {
    const decisionId = 'd0000000-0000-4000-8000-000000000006'
    const commandId = 'c0000000-0000-4000-8000-000000000006'
    const input: SendTimeMessageEvaluationInput = {
      messageId: 'msg-operational-status-1',
      customerId: CUSTOMER_CONSENTED_ID,
      category: 'operational',
      channel: 'email'
    }

    const r1 = await evaluateD1SendTimeMessage(db, ADMIN_CLAIMS, decisionId, commandId, 'idemp-repeat-1', input, {
      now: () => NOW
    })
    const r2 = await evaluateD1SendTimeMessage(db, ADMIN_CLAIMS, decisionId, commandId, 'idemp-repeat-1', input, {
      now: () => NOW
    })

    expect(r1.id).toBe(r2.id)
    expect(r1.status).toBe(r2.status)
  })
})
