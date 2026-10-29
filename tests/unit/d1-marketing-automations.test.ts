import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  type CustomerPreferencesInput,
  type MarketingAutomationPolicyInput,
  calculateReplenishmentDays,
  checkMarginAllowed
} from '../../shared/marketing-automations'
import {
  MarketingAutomationError,
  dispatchD1Postpurchase,
  dispatchD1WelcomeStep,
  evaluateD1Winback,
  getD1AutomationsOverview,
  readD1AutomationsPolicy,
  readD1CustomerPreferences,
  saveD1CustomerPreferences,
  updateD1AutomationsPolicy
} from '../../workers/marketing/marketing-automations'

const NOW = '2026-10-29T12:00:00Z'
const PAST_90_DAYS = '2026-07-20T10:00:00Z'
const PAST_30_DAYS = '2026-09-29T10:00:00Z'
const _RECENT_DATE = '2026-10-25T10:00:00Z'

const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }

const CUSTOMER_ID_1 = '30000000-0000-4000-8000-000000000001'
const CUSTOMER_IDENTITY_1 = '10000000-0000-4000-8000-000000000011'
const CUSTOMER_SESSION_1 = '20000000-0000-4000-8000-000000000011'
const CUSTOMER_CLAIMS_1 = { identityId: CUSTOMER_IDENTITY_1, sessionId: CUSTOMER_SESSION_1, sessionVersion: 1 }

const CUSTOMER_ID_INCIDENT = '30000000-0000-4000-8000-000000000002'
const CUSTOMER_ID_DEBT = '30000000-0000-4000-8000-000000000003'
const CUSTOMER_ID_SUPPRESSED = '30000000-0000-4000-8000-000000000004'

const ORDER_ID_1 = '50000000-0000-4000-8000-000000000001'
const ORDER_ID_DEBT = '50000000-0000-4000-8000-000000000002'
const _ORDER_ID_RECENT = '50000000-0000-4000-8000-000000000003'

async function setupTestDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile(new URL('../../db/d1/migrations/0107_marketing_automations.sql', import.meta.url), 'utf8'))

  // Roles & permissions
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Fixture admin');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');
  `)

  // Admin identity
  sqlite
    .prepare(
      `INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
       VALUES (?, 'admin@neteco.test', 'fixture-hash', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    )
    .run(ADMIN_ID)

  sqlite
    .prepare(
      `INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
       VALUES (?, ?, 1, 1, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')`
    )
    .run(ADMIN_SESSION, ADMIN_ID)

  sqlite
    .prepare(
      `INSERT INTO identity_roles (identity_id, role_code, granted_at) VALUES (?, 'admin', '2026-01-01T00:00:00Z')`
    )
    .run(ADMIN_ID)

  // Customers
  for (const [cid, name, status] of [
    [CUSTOMER_ID_1, 'Lavandería Central SL', 'active'],
    [CUSTOMER_ID_INCIDENT, 'Restaurante El Puerto', 'active'],
    [CUSTOMER_ID_DEBT, 'Limpiezas Levante', 'active'],
    [CUSTOMER_ID_SUPPRESSED, 'Clínica Dental Baja', 'blocked']
  ] as const) {
    sqlite
      .prepare(
        `INSERT INTO customers (id, name, status, created_at, updated_at)
         VALUES (?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
      )
      .run(cid, name, status)
  }

  // Customer 1 identity
  sqlite
    .prepare(
      `INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, customer_id, created_at, updated_at)
       VALUES (?, 'cliente1@neteco.test', 'fixture-hash', 'active', 1, '2026-01-01T00:00:00Z', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    )
    .run(CUSTOMER_IDENTITY_1, CUSTOMER_ID_1)

  sqlite
    .prepare(
      `INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
       VALUES (?, ?, 1, 0, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')`
    )
    .run(CUSTOMER_SESSION_1, CUSTOMER_IDENTITY_1)

  // Newsletter subscriptions
  const emailHash1 = 'a'.repeat(64)
  const emailHashIncident = 'b'.repeat(64)
  const emailHashDebt = 'c'.repeat(64)
  const emailHashSuppressed = 'd'.repeat(64)

  sqlite
    .prepare(
      `INSERT INTO newsletter_subscriptions (id, email_normalized, email_hash, status, consent_text, consent_version, consent_source, request_id, request_key, requested_at, confirmation_expires_at, confirmed_at, unsubscribed_at)
       VALUES ('sub-1', 'cliente1@neteco.test', ?, 'confirmed', 'Acepto recibir comunicaciones', 'v1', 'web', 'req-1', 'key-1', 1700000000, 1800000000, 1700000010, NULL),
              ('sub-2', 'puerto@neteco.test', ?, 'confirmed', 'Acepto recibir comunicaciones', 'v1', 'web', 'req-2', 'key-2', 1700000000, 1800000000, 1700000010, NULL),
              ('sub-3', 'deuda@neteco.test', ?, 'pending', 'Acepto recibir comunicaciones', 'v1', 'web', 'req-3', 'key-3', 1700000000, 1800000000, NULL, NULL),
              ('sub-4', 'baja@neteco.test', ?, 'unsubscribed', 'Acepto recibir comunicaciones', 'v1', 'web', 'req-4', 'key-4', 1700000000, 1800000000, 1700000010, 1700000050)`
    )
    .run(emailHash1, emailHashIncident, emailHashDebt, emailHashSuppressed)

  // Newsletter suppressions for CUSTOMER_ID_SUPPRESSED
  sqlite
    .prepare(
      `INSERT INTO newsletter_suppressions (email_hash, reason, source, created_at, updated_at)
       VALUES (?, 'unsubscribe', 'user_preference', 1700000050, 1700000050)`
    )
    .run(emailHashSuppressed)

  // Orders helper
  function insertOrderFixture(
    orderId: string,
    customerId: string,
    email: string,
    emailHash: string,
    createdAt: string,
    paymentStatus: string
  ) {
    const dummyId = `cart-${orderId}`
    const tokenHash = `${orderId.replace(/-/g, '')}${'0'.repeat(32)}`.slice(0, 64)
    const expiresAt = new Date(Date.parse(createdAt) + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at) VALUES(?, ?, 'active', 1, ?, 'corr-1', ?, ?)`
      )
      .run(dummyId, tokenHash, expiresAt, createdAt, createdAt)

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO checkout_quotes(id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents, shipping_pending, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at)
       VALUES(?, ?, 1, ?, 'EUR', 0, 1, 10000, 2100, 12100, ?, 'corr-1', ?)`
      )
      .run(dummyId, dummyId, createdAt, tokenHash, createdAt)

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO shipping_quotes(id, cart_id, cart_version, destination_hash, options_json, option_count, snapshot_hash, expires_at, correlation_id, created_at)
       VALUES(?, ?, 1, ?, '[]', 0, ?, ?, 'corr-1', ?)`
      )
      .run(dummyId, dummyId, tokenHash, tokenHash, expiresAt, createdAt)

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO checkout_attempts(id, cart_id, command_key, state, correlation_id, payload_hash, created_at, updated_at)
       VALUES(?, ?, 'key-1', 'failed', 'corr-1', ?, ?, ?)`
      )
      .run(dummyId, dummyId, tokenHash, createdAt, createdAt)

    sqlite
      .prepare(
        `INSERT INTO orders(
         id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status,
         reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents,
         shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version,
         shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy,
         correlation_id, customer_id, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, 'awaiting_payment', 'res-1', ?, 'EUR', 10000, 2100, 12100,
         0, 0, 0, 'standard', 1, 1, 3, ?, ?, 1, 1,
         'corr-1', ?, ?, ?
       )`
      )
      .run(
        orderId,
        dummyId,
        dummyId,
        dummyId,
        dummyId,
        tokenHash,
        expiresAt,
        email,
        emailHash,
        customerId,
        createdAt,
        createdAt
      )

    sqlite
      .prepare(
        `INSERT INTO order_payment_states(order_id, status, paid_gross_cents, updated_at)
       VALUES(?, ?, ?, ?)`
      )
      .run(orderId, paymentStatus, paymentStatus === 'paid' ? 12100 : 0, createdAt)
  }

  insertOrderFixture(ORDER_ID_1, CUSTOMER_ID_1, 'cliente1@neteco.test', emailHash1, PAST_90_DAYS, 'paid')
  insertOrderFixture(ORDER_ID_DEBT, CUSTOMER_ID_DEBT, 'deuda@neteco.test', emailHashDebt, PAST_90_DAYS, 'failed')

  // Support ticket for CUSTOMER_ID_INCIDENT: open incident
  const suppCmdId = '11111111-0000-4000-8000-000000000001'
  const suppTicketId = '33333333-0000-4000-8000-000000000001'
  const suppRef = 'SOP-000000000000000000000001'

  sqlite
    .prepare(
      `INSERT INTO support_commands (
         id, nonce, actor_key, actor_id, actor_type, ticket_id, public_ref, action,
         idempotency_key, payload_hash, input, snapshot, expected_version, result_version,
         from_state, to_state, response, created_at
       ) VALUES (
         ?, '22222222-0000-4000-8000-000000000001', 'key-1', ?, 'customer',
         ?, ?, 'created', 'idem-supp-1', '${'f'.repeat(64)}', '{}',
         ?, 0, 1, NULL, 'open',
         ?, ?
       )`
    )
    .run(
      suppCmdId,
      ADMIN_ID,
      suppTicketId,
      suppRef,
      JSON.stringify({
        priority: 'high',
        customerId: CUSTOMER_ID_INCIDENT,
        orderId: null,
        nextActionAt: null,
        slaDueAt: null
      }),
      JSON.stringify({
        commandId: suppCmdId,
        publicRef: suppRef,
        version: 1,
        state: 'open',
        inventoryEffect: 'none',
        economicEffect: 'none'
      }),
      PAST_30_DAYS
    )

  sqlite
    .prepare(
      `INSERT INTO support_tickets (
         id, public_ref, customer_id, category, subject, requester, state, priority,
         version, last_command_id, created_at, updated_at
       ) VALUES (
         ?, ?, ?, 'product', 'Problema con bidón deteriorado',
         '{"email":"puerto@neteco.test"}', 'open', 'high', 1, ?, ?, ?
       )`
    )
    .run(suppTicketId, suppRef, CUSTOMER_ID_INCIDENT, suppCmdId, PAST_30_DAYS, PAST_30_DAYS)

  return sqlite
}

describe('Marketing Automations D1 suite (MKT-015, MKT-018, MKT-019)', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupTestDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite?.close()
  })

  describe('Policy Management and CAS', () => {
    it('initializes default policy and reads it', async () => {
      const policy = await readD1AutomationsPolicy(db)
      expect(policy.id).toBe('global')
      expect(policy.welcomeSeriesEnabled).toBe(true)
      expect(policy.welcomeDiscountEnabled).toBe(true)
      expect(policy.welcomeDiscountPercent).toBe(10)
      expect(policy.winbackEnabled).toBe(true)
      expect(policy.winbackInactivityDays).toBe(90)
      expect(policy.postpurchaseEnabled).toBe(true)
    })

    it('updates policy with CAS version check', async () => {
      const input: MarketingAutomationPolicyInput = {
        welcomeSeriesEnabled: true,
        welcomeDiscountEnabled: true,
        welcomeDiscountPercent: 15,
        welcomeDiscountMaxCents: 2000,
        welcomeMinOrderCents: 6000,
        welcomeMarginFloorBasisPoints: 2500,
        winbackEnabled: true,
        winbackInactivityDays: 60,
        winbackCooldownDays: 90,
        winbackDiscountPercent: 12,
        winbackDiscountMaxCents: 2500,
        winbackMarginFloorBasisPoints: 2200,
        postpurchaseEnabled: true,
        postpurchaseDelayHours: 24,
        expectedVersion: 1
      }
      const receipt = await updateD1AutomationsPolicy(db, ADMIN_CLAIMS, input, 'idem-policy-1', NOW)
      expect(receipt.appliedVersion).toBe(2)
      expect(receipt.action).toBe('update_policy')

      const updated = await readD1AutomationsPolicy(db)
      expect(updated.version).toBe(2)
      expect(updated.welcomeDiscountPercent).toBe(15)
      expect(updated.winbackInactivityDays).toBe(60)
    })

    it('rejects update when version conflict occurs (CAS)', async () => {
      const input: MarketingAutomationPolicyInput = {
        welcomeSeriesEnabled: true,
        welcomeDiscountEnabled: true,
        welcomeDiscountPercent: 12,
        welcomeDiscountMaxCents: 1500,
        welcomeMinOrderCents: 5000,
        welcomeMarginFloorBasisPoints: 2000,
        winbackEnabled: true,
        winbackInactivityDays: 90,
        winbackCooldownDays: 90,
        winbackDiscountPercent: 10,
        winbackDiscountMaxCents: 2000,
        winbackMarginFloorBasisPoints: 2000,
        postpurchaseEnabled: true,
        postpurchaseDelayHours: 12,
        expectedVersion: 999 // wrong version
      }
      await expect(updateD1AutomationsPolicy(db, ADMIN_CLAIMS, input, 'idem-policy-cas-fail', NOW)).rejects.toThrow(
        MarketingAutomationError
      )
    })

    it('idempotently returns existing receipt on identical idempotency key', async () => {
      const input: MarketingAutomationPolicyInput = {
        welcomeSeriesEnabled: true,
        welcomeDiscountEnabled: true,
        welcomeDiscountPercent: 10,
        welcomeDiscountMaxCents: 1500,
        welcomeMinOrderCents: 5000,
        welcomeMarginFloorBasisPoints: 2000,
        winbackEnabled: true,
        winbackInactivityDays: 90,
        winbackCooldownDays: 90,
        winbackDiscountPercent: 10,
        winbackDiscountMaxCents: 2000,
        winbackMarginFloorBasisPoints: 2000,
        postpurchaseEnabled: true,
        postpurchaseDelayHours: 12,
        expectedVersion: 1
      }
      const receipt1 = await updateD1AutomationsPolicy(db, ADMIN_CLAIMS, input, 'idem-policy-repeat', NOW)
      const receipt2 = await updateD1AutomationsPolicy(db, ADMIN_CLAIMS, input, 'idem-policy-repeat', NOW)
      expect(receipt1.commandId).toBe(receipt2.commandId)
      expect(receipt1.appliedVersion).toBe(receipt2.appliedVersion)
    })
  })

  describe('MKT-015: Serie de Bienvenida (Welcome Series)', () => {
    it('dispatches step 1: professional_value with B2B value proposition', async () => {
      const res = await dispatchD1WelcomeStep(
        db,
        ADMIN_CLAIMS,
        { customerId: CUSTOMER_ID_1, step: 'professional_value', idempotencyKey: 'idem-welcome-1' },
        NOW
      )
      expect(res.step).toBe('professional_value')
      expect(res.status).toBe('delivered')
      expect(res.discountCode).toBeNull()
    })

    it('dispatches step 2: categories_overview and step 3: local_service', async () => {
      const res2 = await dispatchD1WelcomeStep(
        db,
        ADMIN_CLAIMS,
        { customerId: CUSTOMER_ID_1, step: 'categories_overview', idempotencyKey: 'idem-welcome-2' },
        NOW
      )
      expect(res2.step).toBe('categories_overview')
      expect(res2.status).toBe('delivered')

      const res3 = await dispatchD1WelcomeStep(
        db,
        ADMIN_CLAIMS,
        { customerId: CUSTOMER_ID_1, step: 'local_service', idempotencyKey: 'idem-welcome-3' },
        NOW
      )
      expect(res3.step).toBe('local_service')
      expect(res3.status).toBe('delivered')
    })

    it('saves and reads customer preferences (step 4 preference prompt)', async () => {
      const input: CustomerPreferencesInput = {
        preferredCategories: ['degreasers', 'sanitizers', 'cellulose'],
        frequency: 'biweekly',
        channel: 'email',
        technicalContentOptIn: true,
        expectedVersion: 0
      }
      const receipt = await saveD1CustomerPreferences(db, CUSTOMER_CLAIMS_1, CUSTOMER_ID_1, input, 'idem-pref-1', NOW)
      expect(receipt.appliedVersion).toBe(1)

      const prefs = await readD1CustomerPreferences(db, CUSTOMER_ID_1)
      expect(prefs).not.toBeNull()
      expect(prefs?.preferredCategories).toEqual(['degreasers', 'sanitizers', 'cellulose'])
      expect(prefs?.frequency).toBe('biweekly')
    })

    it('dispatches step 5: welcome_discount with margin, cap and minimum order controls', async () => {
      const res5 = await dispatchD1WelcomeStep(
        db,
        ADMIN_CLAIMS,
        { customerId: CUSTOMER_ID_1, step: 'welcome_discount', idempotencyKey: 'idem-w5-001' },
        NOW
      )
      expect(res5.step).toBe('welcome_discount')
      expect(res5.status).toBe('delivered')
      expect(res5.discountCode).toMatch(/^BIENVENIDA-[A-Z0-9]+$/)
      expect(res5.discountCentsCap).toBe(1500)
      expect(res5.minOrderCents).toBe(5000)
      expect(res5.marginFloorBasisPoints).toBe(2000)
    })

    it('rejects sending the same step twice to the same customer', async () => {
      await dispatchD1WelcomeStep(
        db,
        ADMIN_CLAIMS,
        { customerId: CUSTOMER_ID_1, step: 'local_service', idempotencyKey: 'idem-dup-1' },
        NOW
      )
      await expect(
        dispatchD1WelcomeStep(
          db,
          ADMIN_CLAIMS,
          { customerId: CUSTOMER_ID_1, step: 'local_service', idempotencyKey: 'idem-dup-2' },
          NOW
        )
      ).rejects.toThrow(MarketingAutomationError)
    })

    it('marks as suppressed if customer is unsubscribed or blocked', async () => {
      const res = await dispatchD1WelcomeStep(
        db,
        ADMIN_CLAIMS,
        { customerId: CUSTOMER_ID_SUPPRESSED, step: 'professional_value', idempotencyKey: 'idem-supp-1' },
        NOW
      )
      expect(res.status).toBe('suppressed')
    })
  })

  describe('MKT-018: Win-back por Inactividad (Win-back Automation)', () => {
    it('evaluates eligible inactive customer beyond inactivity window and grants margin-controlled offer', async () => {
      const evaluation = await evaluateD1Winback(db, ADMIN_CLAIMS, CUSTOMER_ID_1, 'idem-winback-1', NOW)
      expect(evaluation.eligibilityStatus).toBe('eligible')
      expect(evaluation.daysInactive).toBeGreaterThanOrEqual(90)
      expect(evaluation.discountCode).toMatch(/^VUELVE-[A-Z0-9]+$/)
      expect(evaluation.discountPercent).toBe(10)
      expect(evaluation.marginFloorBasisPoints).toBe(2000)
    })

    it('excludes customer with active support incidents (open tickets)', async () => {
      const evaluation = await evaluateD1Winback(db, ADMIN_CLAIMS, CUSTOMER_ID_INCIDENT, 'idem-winback-incident', NOW)
      expect(evaluation.eligibilityStatus).toBe('excluded_incidents')
      expect(evaluation.discountCode).toBeNull()
      expect(evaluation.exclusionReason).toContain('incidencia')
    })

    it('excludes customer with pending debt or failed order payments', async () => {
      const evaluation = await evaluateD1Winback(db, ADMIN_CLAIMS, CUSTOMER_ID_DEBT, 'idem-winback-debt', NOW)
      expect(evaluation.eligibilityStatus).toBe('excluded_debt')
      expect(evaluation.discountCode).toBeNull()
      expect(evaluation.exclusionReason).toContain('deuda')
    })

    it('excludes customer who is suppressed, unsubscribed or blocked', async () => {
      const evaluation = await evaluateD1Winback(
        db,
        ADMIN_CLAIMS,
        CUSTOMER_ID_SUPPRESSED,
        'idem-winback-suppressed',
        NOW
      )
      expect(evaluation.eligibilityStatus).toBe('excluded_suppressed')
      expect(evaluation.discountCode).toBeNull()
      expect(evaluation.exclusionReason).toContain('baja')
    })

    it('excludes customer who already received a winback within cooldown window (anti-abuso / gaming)', async () => {
      // First evaluation qualifies
      const first = await evaluateD1Winback(db, ADMIN_CLAIMS, CUSTOMER_ID_1, 'idem-winback-cooldown-1', NOW)
      expect(first.eligibilityStatus).toBe('eligible')

      // Second evaluation within cooldown is excluded
      const second = await evaluateD1Winback(db, ADMIN_CLAIMS, CUSTOMER_ID_1, 'idem-winback-cooldown-2', NOW)
      expect(second.eligibilityStatus).toBe('excluded_cooldown')
      expect(second.exclusionReason).toContain('cooldown')
    })
  })

  describe('MKT-019: Postcompra Útil (Useful Post-purchase)', () => {
    it('dispatches both transactional usage/safety and commercial replenishment when consent is granted', async () => {
      const dispatches = await dispatchD1Postpurchase(db, ADMIN_CLAIMS, ORDER_ID_1, 'idem-post-1', NOW)
      expect(dispatches).toHaveLength(2)

      const transactional = dispatches.find((d) => d.streamType === 'transactional_safety_usage')
      expect(transactional).toBeDefined()
      expect(transactional?.status).toBe('delivered')
      const txContent = JSON.parse(transactional!.contentJson)
      expect(txContent.dilutionProtocol).toBeDefined()
      expect(txContent.sdsUrl).toBeDefined()
      expect(txContent.ppeRequirements).toBeInstanceOf(Array)
      expect(txContent.supportContact).toBeDefined()

      const commercial = dispatches.find((d) => d.streamType === 'commercial_replenishment')
      expect(commercial).toBeDefined()
      expect(commercial?.status).toBe('delivered')
      const commContent = JSON.parse(commercial!.contentJson)
      expect(commContent.estimatedReplenishmentDays).toBeGreaterThan(0)
      expect(commContent.recommendedAccessories).toBeInstanceOf(Array)
    })

    it('strictly separates streams: delivers transactional but skips commercial when customer has NO marketing consent', async () => {
      // Order debt's customer or a customer without confirmed subscription
      const dispatches = await dispatchD1Postpurchase(db, ADMIN_CLAIMS, ORDER_ID_DEBT, 'idem-post-no-consent', NOW)
      expect(dispatches).toHaveLength(2)

      const transactional = dispatches.find((d) => d.streamType === 'transactional_safety_usage')
      expect(transactional?.status).toBe('delivered') // Safety and usage always delivered

      const commercial = dispatches.find((d) => d.streamType === 'commercial_replenishment')
      // Since CUSTOMER_ID_DEBT has no confirmed newsletter consent or is unconfirmed, commercial is skipped
      expect(commercial?.status).toBe('skipped_no_consent')
    })
  })

  describe('Overview and Helper calculations', () => {
    it('returns aggregated metrics in overview', async () => {
      const overview = await getD1AutomationsOverview(db)
      expect(overview.policy).toBeDefined()
      expect(overview.counts.welcomeDispatches).toBeDefined()
      expect(overview.counts.winbackEvaluations).toBeDefined()
      expect(overview.counts.postpurchaseDispatches).toBeDefined()
    })

    it('calculates replenishment cadence based on volume', () => {
      expect(calculateReplenishmentDays(5)).toBe(30)
      expect(calculateReplenishmentDays(25)).toBe(60)
      expect(calculateReplenishmentDays(60)).toBe(90)
      expect(calculateReplenishmentDays(200)).toBe(120)
    })

    it('verifies margin floor protection logic', () => {
      // 100 EUR order, 10 EUR discount -> 90 EUR effective revenue. Cost 60 EUR -> Margin 30 EUR -> 33.33% margin
      expect(checkMarginAllowed(10000, 1000, 6000, 2000)).toBe(true)
      // 100 EUR order, 40 EUR discount -> 60 EUR effective revenue. Cost 55 EUR -> Margin 5 EUR -> 8.33% < 20%
      expect(checkMarginAllowed(10000, 4000, 5500, 2000)).toBe(false)
    })
  })
})
