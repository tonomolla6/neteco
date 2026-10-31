import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  type MarketingAutomationWorkflow,
  type MarketingObservabilityEventInput,
  MARKETING_AUTOMATION_WORKFLOWS,
  MARKETING_OBSERVABILITY_EVENT_TYPES,
  MARKETING_SUPPRESSION_REASONS,
  calculateAutomationMargin,
  calculateMarginBasisPoints,
  marketingObservabilityEventInputSchema
} from '../../shared/marketing-automation-observability'
import {
  MarketingObservabilityError,
  recordD1MarketingAutomationEvent,
  getD1WorkflowMetricsSummary,
  getD1WorkflowMetricsDetail,
  listD1MarketingEvents
} from '../../workers/marketing/marketing-automation-observability'
import {
  handleMarketingObservabilityHttp,
  ownsMarketingObservabilityNamespace
} from '../../workers/marketing/marketing-automation-observability-http'

const NOW = '2026-10-31T12:00:00Z'
const PAST_DATE = '2026-10-25T10:00:00Z'

const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }

const CUSTOMER_ID_1 = '30000000-0000-4000-8000-000000000001'
const CUSTOMER_ID_2 = '30000000-0000-4000-8000-000000000002'

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

  // Customer profiles
  sqlite.exec(`
    INSERT OR IGNORE INTO customers (id, name, status, created_at, updated_at)
    VALUES
      ('${CUSTOMER_ID_1}', 'Lavandería Central SL', 'active', '${PAST_DATE}', '${PAST_DATE}'),
      ('${CUSTOMER_ID_2}', 'Restaurante El Puerto', 'active', '${PAST_DATE}', '${PAST_DATE}');
  `)

  // Admin identity & session with MFA
  sqlite.exec(`
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
    VALUES ('${ADMIN_ID}', 'admin-mkt@neteco.es', 'hash', 'active', 1, '${PAST_DATE}', '${PAST_DATE}', '${PAST_DATE}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
    VALUES ('${ADMIN_SESSION}', '${ADMIN_ID}', 1, 1, '${PAST_DATE}', '2030-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at)
    VALUES ('${ADMIN_ID}', 'admin', '${PAST_DATE}');
  `)

  // Operator without administration.manage
  sqlite.exec(`
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
    VALUES ('${OPERATOR_ID}', 'operator-mkt@neteco.es', 'hash', 'active', 1, '${PAST_DATE}', '${PAST_DATE}', '${PAST_DATE}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
    VALUES ('${OPERATOR_SESSION}', '${OPERATOR_ID}', 1, 1, '${PAST_DATE}', '2030-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at)
    VALUES ('${OPERATOR_ID}', 'operator', '${PAST_DATE}');
  `)

  return sqlite
}

describe('Marketing Automation Observability (OBS-027)', () => {
  let sqlite: DatabaseSync
  let d1: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDatabase()
    d1 = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  describe('Domain & Financial Calculations', () => {
    it('covers all required workflows and event types in constants', () => {
      expect(MARKETING_AUTOMATION_WORKFLOWS).toContain('welcome_series')
      expect(MARKETING_AUTOMATION_WORKFLOWS).toContain('abandoned_cart')
      expect(MARKETING_AUTOMATION_WORKFLOWS).toContain('inactivity_winback')
      expect(MARKETING_AUTOMATION_WORKFLOWS).toContain('postpurchase_replenishment')

      expect(MARKETING_OBSERVABILITY_EVENT_TYPES).toEqual([
        'trigger',
        'suppression',
        'delivery',
        'conversion',
        'complaint',
        'error'
      ])

      expect(MARKETING_SUPPRESSION_REASONS).toContain('fatigue_limit')
      expect(MARKETING_SUPPRESSION_REASONS).toContain('unsubscribed')
      expect(MARKETING_SUPPRESSION_REASONS).toContain('quiet_hours')
      expect(MARKETING_SUPPRESSION_REASONS).toContain('no_consent')
      expect(MARKETING_SUPPRESSION_REASONS).toContain('open_debt')
      expect(MARKETING_SUPPRESSION_REASONS).toContain('inventory_out_of_stock')
    })

    it('calculates net margin correctly: revenue - cost - discount', () => {
      // 100 EUR revenue, 40 EUR cost, 15 EUR discount = 45 EUR net margin
      expect(calculateAutomationMargin(10000, 4000, 1500)).toBe(4500)
      // Negative margin when cost + discount exceed revenue
      expect(calculateAutomationMargin(5000, 4000, 2000)).toBe(-1000)
    })

    it('validates event input schema using Zod', () => {
      const parsed = marketingObservabilityEventInputSchema.safeParse({
        workflowId: 'welcome_series',
        executionId: 'exec-valid-01',
        eventType: 'trigger',
        channel: 'email',
        occurredAt: NOW
      })
      expect(parsed.success).toBe(true)
    })

    it('calculates margin basis points accurately', () => {
      // 45 EUR margin on 100 EUR revenue = 45% = 4500 bps
      expect(calculateMarginBasisPoints(4500, 10000)).toBe(4500)
      // Handles 0 revenue without division by zero
      expect(calculateMarginBasisPoints(0, 0)).toBe(0)
      // Handles negative margin in basis points
      expect(calculateMarginBasisPoints(-1000, 5000)).toBe(-2000)
    })
  })

  describe('D1 Database & Metrics Aggregation Operations', () => {
    it('records telemetry events across all dimensions and aggregates workflow metrics', async () => {
      const workflowId: MarketingAutomationWorkflow = 'abandoned_cart'

      // Ingest 10 Triggers
      for (let i = 1; i <= 10; i++) {
        await recordD1MarketingAutomationEvent(
          d1,
          ADMIN_CLAIMS,
          {
            workflowId,
            executionId: `exec-cart-${i}`,
            eventType: 'trigger',
            channel: 'email',
            customerId: CUSTOMER_ID_1,
            occurredAt: NOW
          },
          {
            commandId: `50000000-0000-4000-8000-0000000000${i.toString().padStart(2, '0')}`,
            idempotencyKey: `key-trig-${i}`
          },
          { now: () => NOW }
        )
      }

      // Ingest 2 Suppressions (1 fatigue, 1 quiet hours)
      await recordD1MarketingAutomationEvent(
        d1,
        ADMIN_CLAIMS,
        {
          workflowId,
          executionId: 'exec-cart-supp-1',
          eventType: 'suppression',
          channel: 'email',
          customerId: CUSTOMER_ID_1,
          suppressionReason: 'fatigue_limit',
          occurredAt: NOW
        },
        { commandId: '50000000-0000-4000-8000-000000000021', idempotencyKey: 'key-supp-1' },
        { now: () => NOW }
      )

      await recordD1MarketingAutomationEvent(
        d1,
        ADMIN_CLAIMS,
        {
          workflowId,
          executionId: 'exec-cart-supp-2',
          eventType: 'suppression',
          channel: 'email',
          customerId: CUSTOMER_ID_2,
          suppressionReason: 'quiet_hours',
          occurredAt: NOW
        },
        { commandId: '50000000-0000-4000-8000-000000000022', idempotencyKey: 'key-supp-2' },
        { now: () => NOW }
      )

      // Ingest 7 Deliveries
      for (let i = 1; i <= 7; i++) {
        await recordD1MarketingAutomationEvent(
          d1,
          ADMIN_CLAIMS,
          {
            workflowId,
            executionId: `exec-cart-deliv-${i}`,
            eventType: 'delivery',
            channel: 'email',
            customerId: CUSTOMER_ID_1,
            occurredAt: NOW
          },
          { commandId: `50000000-0000-4000-8000-00000000003${i}`, idempotencyKey: `key-deliv-${i}` },
          { now: () => NOW }
        )
      }

      // Ingest 1 Error
      await recordD1MarketingAutomationEvent(
        d1,
        ADMIN_CLAIMS,
        {
          workflowId,
          executionId: 'exec-cart-err-1',
          eventType: 'error',
          channel: 'email',
          errorCode: 'provider_timeout',
          errorMessage: 'SendGrid webhook connection timeout',
          occurredAt: NOW
        },
        { commandId: '50000000-0000-4000-8000-000000000041', idempotencyKey: 'key-err-1' },
        { now: () => NOW }
      )

      // Ingest 2 Conversions with Financials
      // Conversion 1: 80 EUR rev, 30 EUR cost, 10 EUR discount -> 40 EUR margin
      await recordD1MarketingAutomationEvent(
        d1,
        ADMIN_CLAIMS,
        {
          workflowId,
          executionId: 'exec-cart-conv-1',
          eventType: 'conversion',
          channel: 'email',
          customerId: CUSTOMER_ID_1,
          grossRevenueCents: 8000,
          costCents: 3000,
          discountCents: 1000,
          occurredAt: NOW
        },
        { commandId: '50000000-0000-4000-8000-000000000051', idempotencyKey: 'key-conv-1' },
        { now: () => NOW }
      )

      // Conversion 2: 120 EUR rev, 50 EUR cost, 15 EUR discount -> 55 EUR margin
      await recordD1MarketingAutomationEvent(
        d1,
        ADMIN_CLAIMS,
        {
          workflowId,
          executionId: 'exec-cart-conv-2',
          eventType: 'conversion',
          channel: 'email',
          customerId: CUSTOMER_ID_2,
          grossRevenueCents: 12000,
          costCents: 5000,
          discountCents: 1500,
          occurredAt: NOW
        },
        { commandId: '50000000-0000-4000-8000-000000000052', idempotencyKey: 'key-conv-2' },
        { now: () => NOW }
      )

      // Ingest 1 Complaint
      await recordD1MarketingAutomationEvent(
        d1,
        ADMIN_CLAIMS,
        {
          workflowId,
          executionId: 'exec-cart-comp-1',
          eventType: 'complaint',
          channel: 'email',
          customerId: CUSTOMER_ID_2,
          occurredAt: NOW
        },
        { commandId: '50000000-0000-4000-8000-000000000061', idempotencyKey: 'key-comp-1' },
        { now: () => NOW }
      )

      // Query workflow metrics summary
      const summaryList = await getD1WorkflowMetricsSummary(d1, ADMIN_CLAIMS, { now: () => NOW })
      const workflowMetrics = summaryList.find((w) => w.workflowId === 'abandoned_cart')

      expect(workflowMetrics).toBeDefined()
      expect(workflowMetrics!.triggers).toBe(10)
      expect(workflowMetrics!.suppressions).toBe(2)
      expect(workflowMetrics!.deliveries).toBe(7)
      expect(workflowMetrics!.conversions).toBe(2)
      expect(workflowMetrics!.complaints).toBe(1)
      expect(workflowMetrics!.errors).toBe(1)

      // Financials: Total Revenue 20000, Cost 8000, Discount 2500, Net Margin = 9500 (47.5% = 4750 bps)
      expect(workflowMetrics!.totalGrossRevenueCents).toBe(20000)
      expect(workflowMetrics!.totalCostCents).toBe(8000)
      expect(workflowMetrics!.totalDiscountCents).toBe(2500)
      expect(workflowMetrics!.totalNetMarginCents).toBe(9500)
      expect(workflowMetrics!.marginBasisPoints).toBe(4750)

      // Rates:
      // Conversion rate % = 2 / 7 deliveries * 100 = 28.57% -> 28.6%
      expect(workflowMetrics!.conversionRatePercent).toBeCloseTo(28.57, 1)
      // Complaint rate % = 1 / 7 deliveries * 100 = 14.29%
      expect(workflowMetrics!.complaintRatePercent).toBeCloseTo(14.29, 1)

      // Query workflow detail with reason breakdowns
      const detail = await getD1WorkflowMetricsDetail(d1, ADMIN_CLAIMS, 'abandoned_cart', { now: () => NOW })
      expect(detail.suppressionBreakdown.fatigue_limit).toBe(1)
      expect(detail.suppressionBreakdown.quiet_hours).toBe(1)
      expect(detail.errorBreakdown.provider_timeout).toBe(1)

      // Query raw event list via listD1MarketingEvents
      const eventList = await listD1MarketingEvents(
        d1,
        ADMIN_CLAIMS,
        { workflowId: 'abandoned_cart' },
        { now: () => NOW }
      )
      expect(eventList.length).toBeGreaterThan(0)
    })

    it('enforces append-only immutability: updates or deletes on events table are aborted by SQLite trigger', async () => {
      await recordD1MarketingAutomationEvent(
        d1,
        ADMIN_CLAIMS,
        {
          workflowId: 'welcome_series',
          executionId: 'exec-immut-1',
          eventType: 'trigger',
          channel: 'email',
          occurredAt: NOW
        },
        { commandId: '50000000-0000-4000-8000-000000000071', idempotencyKey: 'cmd-immut-event' },
        { now: () => NOW }
      )

      expect(() => {
        sqlite.exec("DELETE FROM marketing_automation_observability_events WHERE workflow_id = 'welcome_series'")
      }).toThrow(/marketing_automation_event_immutable/)

      expect(() => {
        sqlite.exec(
          "UPDATE marketing_automation_observability_events SET channel = 'sms' WHERE workflow_id = 'welcome_series'"
        )
      }).toThrow(/marketing_automation_event_immutable/)
    })

    it('handles idempotent re-submission with same commandId and payload hash', async () => {
      const eventInput: MarketingObservabilityEventInput = {
        workflowId: 'inactivity_winback',
        executionId: 'exec-idemp-1',
        eventType: 'trigger',
        channel: 'email',
        occurredAt: NOW
      }

      const res1 = await recordD1MarketingAutomationEvent(
        d1,
        ADMIN_CLAIMS,
        eventInput,
        { commandId: '50000000-0000-4000-8000-000000000081', idempotencyKey: 'key-idemp-winback' },
        { now: () => NOW }
      )

      const res2 = await recordD1MarketingAutomationEvent(
        d1,
        ADMIN_CLAIMS,
        eventInput,
        { commandId: '50000000-0000-4000-8000-000000000081', idempotencyKey: 'key-idemp-winback' },
        { now: () => NOW }
      )

      expect(res1.eventId).toBe(res2.eventId)
    })

    it('rejects duplicate idempotency key with conflicting payload', async () => {
      await recordD1MarketingAutomationEvent(
        d1,
        ADMIN_CLAIMS,
        {
          workflowId: 'inactivity_winback',
          executionId: 'exec-idemp-2',
          eventType: 'trigger',
          channel: 'email',
          occurredAt: NOW
        },
        { commandId: '50000000-0000-4000-8000-000000000082', idempotencyKey: 'key-conflict-test' },
        { now: () => NOW }
      )

      await expect(
        recordD1MarketingAutomationEvent(
          d1,
          ADMIN_CLAIMS,
          {
            workflowId: 'welcome_series', // Different workflow!
            executionId: 'exec-idemp-2',
            eventType: 'trigger',
            channel: 'email',
            occurredAt: NOW
          },
          { commandId: '50000000-0000-4000-8000-000000000082', idempotencyKey: 'key-conflict-test' },
          { now: () => NOW }
        )
      ).rejects.toThrow(MarketingObservabilityError)
    })
  })

  describe('Authorization and Security', () => {
    it('rejects operator without administration.manage permission', async () => {
      await expect(
        recordD1MarketingAutomationEvent(
          d1,
          OPERATOR_CLAIMS,
          {
            workflowId: 'welcome_series',
            executionId: 'exec-unauth-1',
            eventType: 'trigger',
            channel: 'email',
            occurredAt: NOW
          },
          { commandId: '50000000-0000-4000-8000-000000000091', idempotencyKey: 'unauth-key-1' },
          { now: () => NOW }
        )
      ).rejects.toThrow(MarketingObservabilityError)
    })
  })

  describe('HTTP Handler (Canary API Integration)', () => {
    it('accurately identifies owned paths with ownsMarketingObservabilityNamespace', () => {
      expect(ownsMarketingObservabilityNamespace('/api/admin/marketing/observability')).toBe(true)
      expect(ownsMarketingObservabilityNamespace('/api/admin/marketing/observability/workflows')).toBe(true)
      expect(ownsMarketingObservabilityNamespace('/api/admin/marketing/observability/workflows/welcome_series')).toBe(
        true
      )
      expect(ownsMarketingObservabilityNamespace('/api/admin/marketing/observability/events')).toBe(true)
      expect(ownsMarketingObservabilityNamespace('/api/admin/observability/game-day')).toBe(false)
      expect(ownsMarketingObservabilityNamespace('/api/products')).toBe(false)
    })

    it('returns workflow summaries via GET /workflows', async () => {
      const req = new Request('https://admin.neteco.es/api/admin/marketing/observability/workflows', {
        method: 'GET'
      })
      const res = await handleMarketingObservabilityHttp(req, {
        database: d1,
        sessionCookieConfiguration: null,
        claimsResolver: async () => ADMIN_CLAIMS,
        now: () => NOW
      })

      expect(res).toBeDefined()
      expect(res!.status).toBe(200)
      const data = (await res!.json()) as { workflows: Array<{ workflowId: string }> }
      expect(data.workflows).toBeInstanceOf(Array)
    })

    it('records telemetry event via POST /events and returns 201', async () => {
      const req = new Request('https://admin.neteco.es/api/admin/marketing/observability/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://admin.neteco.es',
          'sec-fetch-site': 'same-origin',
          'x-idempotency-key': 'http-event-01'
        },
        body: JSON.stringify({
          workflowId: 'welcome_series',
          executionId: 'exec-http-01',
          eventType: 'trigger',
          channel: 'email',
          occurredAt: NOW
        })
      })

      const res = await handleMarketingObservabilityHttp(req, {
        database: d1,
        sessionCookieConfiguration: null,
        origin: 'https://admin.neteco.es',
        claimsResolver: async () => ADMIN_CLAIMS,
        now: () => NOW
      })

      expect(res).toBeDefined()
      expect(res!.status).toBe(201)
      const data = (await res!.json()) as { eventId: string }
      expect(data.eventId).toBeDefined()
    })

    it('rejects cross-site CSRF on POST /events', async () => {
      const req = new Request('https://admin.neteco.es/api/admin/marketing/observability/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://attacker.site',
          'sec-fetch-site': 'cross-site'
        },
        body: JSON.stringify({
          workflowId: 'welcome_series',
          executionId: 'exec-cross-1',
          eventType: 'trigger',
          channel: 'email',
          occurredAt: NOW
        })
      })

      const res = await handleMarketingObservabilityHttp(req, {
        database: d1,
        sessionCookieConfiguration: null,
        origin: 'https://admin.neteco.es',
        claimsResolver: async () => ADMIN_CLAIMS,
        now: () => NOW
      })

      expect(res).toBeDefined()
      expect(res!.status).toBe(403)
    })
  })
})
