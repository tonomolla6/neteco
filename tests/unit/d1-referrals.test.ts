import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { evaluateReferralFraud, isReturnWindowElapsed, calculateReturnWindowEndsAt } from '../../shared/referrals'
import {
  ReferralError,
  readD1ReferralPolicy,
  updateD1ReferralPolicy,
  enrollD1ReferralAdvocate,
  attributeD1ReferralOrder,
  settleD1ReferralAttributions,
  rejectD1ReferralAttribution,
  getD1CustomerReferralOverview
} from '../../workers/marketing/referrals'

const NOW = '2026-10-29T12:00:00Z'
const PAST_30_DAYS = '2026-09-29T12:00:00Z'
const PAST_10_DAYS = '2026-10-19T12:00:00Z'

const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: '20000000-0000-4000-8000-000000000001', sessionVersion: 1 }

const ADVOCATE_CUSTOMER_ID = '30000000-0000-4000-8000-000000000001'
const ADVOCATE_IDENTITY_ID = '10000000-0000-4000-8000-000000000011'
const ADVOCATE_CLAIMS = {
  identityId: ADVOCATE_IDENTITY_ID,
  sessionId: '20000000-0000-4000-8000-000000000011',
  sessionVersion: 1
}

const REFEREE_CUSTOMER_ID = '30000000-0000-4000-8000-000000000002'
const REFEREE_IDENTITY_ID = '10000000-0000-4000-8000-000000000012'
const REFEREE_CLAIMS = {
  identityId: REFEREE_IDENTITY_ID,
  sessionId: '20000000-0000-4000-8000-000000000012',
  sessionVersion: 1
}

const ORDER_ID_1 = '50000000-0000-4000-8000-000000000001'
const ORDER_ID_RETURNED = '50000000-0000-4000-8000-000000000002'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const sql = await readFile(
    new URL('../../db/d1/migrations/0112_bundles_referrals_events.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(sql)
  // SEC-036: settlement consults promotional-fraud cases.
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0147_category_merchandising_promo_fraud.sql', import.meta.url),
      'utf8'
    )
  )

  // Roles & permissions & customers & identities
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Fixture admin');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');

    INSERT OR IGNORE INTO customers (id, name, status, created_at, updated_at) VALUES
      ('${ADVOCATE_CUSTOMER_ID}', 'Empresa A', 'active', '${NOW}', '${NOW}'),
      ('${REFEREE_CUSTOMER_ID}', 'Empresa B', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO identities (id, customer_id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at) VALUES
      ('${ADMIN_ID}', NULL, 'admin@neteco.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}'),
      ('${ADVOCATE_IDENTITY_ID}', '${ADVOCATE_CUSTOMER_ID}', 'advocate@empresa-a.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}'),
      ('${REFEREE_IDENTITY_ID}', '${REFEREE_CUSTOMER_ID}', 'referee@empresa-b.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_CLAIMS.sessionId}', '${ADMIN_ID}', 1, 1, '${NOW}', '2027-01-01T00:00:00Z'),
      ('${ADVOCATE_CLAIMS.sessionId}', '${ADVOCATE_IDENTITY_ID}', 1, 1, '${NOW}', '2027-01-01T00:00:00Z'),
      ('${REFEREE_CLAIMS.sessionId}', '${REFEREE_IDENTITY_ID}', 1, 1, '${NOW}', '2027-01-01T00:00:00Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');
  `)

  // Initial global referral policy
  sqlite.exec(`
    INSERT INTO referral_policies (
      id, version, is_active, terms_version, reward_cents, referee_discount_cents,
      min_order_cents, return_window_days, max_referrals_per_advocate, updated_at, updated_by
    ) VALUES (
      'global', 1, 1, 'terms-v1-2026', 1500, 1000, 5000, 14, 10, '${NOW}', '${ADMIN_ID}'
    );
  `)

  // Insert test orders
  const token1 = '0'.repeat(64)
  const token2 = '1'.repeat(64)
  const emailHash = 'e'.repeat(64)
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite
    .prepare(
      `
    INSERT INTO orders (
      id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id,
      reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents,
      shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code,
      shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email,
      contact_email_hash, consent_tos, consent_privacy, correlation_id, customer_id, created_at, updated_at
    ) VALUES
      ('${ORDER_ID_1}', 'cart-1', 'quote-1', 'ship-1', 'att-1', '${token1}', 'awaiting_payment', 'res-1', '2027-01-01T00:00:00Z', 'EUR', 6000, 1500, 7500, 0, 0, 0, 'parcel', 1, 1, 2, 'referee@empresa-b.test', '${emailHash}', 1, 1, 'corr-1', '${REFEREE_CUSTOMER_ID}', '${PAST_30_DAYS}', '${PAST_30_DAYS}'),
      ('${ORDER_ID_RETURNED}', 'cart-2', 'quote-2', 'ship-2', 'att-2', '${token2}', 'cancelled', 'res-2', '2027-01-01T00:00:00Z', 'EUR', 6500, 1500, 8000, 0, 0, 0, 'parcel', 1, 1, 2, 'referee@empresa-b.test', '${emailHash}', 1, 1, 'corr-2', '${REFEREE_CUSTOMER_ID}', '${PAST_10_DAYS}', '${PAST_10_DAYS}')
  `
    )
    .run()
  sqlite.exec('PRAGMA foreign_keys = ON')

  return sqlite
}

describe('MKT-026 Referral Program - Fraud, Consent & Return Window Settlement', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite?.close()
  })

  describe('Pure helper logic & anti-fraud evaluation', () => {
    it('detects self-referral abuse', () => {
      const evaluation = evaluateReferralFraud({
        advocateCustomerId: 'cust-1',
        refereeCustomerId: 'cust-1',
        advocateEmailHash: 'hash-a',
        refereeEmailHash: 'hash-a',
        priorOrdersCount: 0,
        activeAdvocateReferralsCount: 0,
        maxReferralsAllowed: 10
      })
      expect(evaluation.passed).toBe(false)
      expect(evaluation.reasons).toContain('self_referral')
    })

    it('detects same email / identity match', () => {
      const evaluation = evaluateReferralFraud({
        advocateCustomerId: 'cust-1',
        refereeCustomerId: 'cust-2',
        advocateEmailHash: 'same-hash',
        refereeEmailHash: 'same-hash',
        priorOrdersCount: 0,
        activeAdvocateReferralsCount: 0,
        maxReferralsAllowed: 10
      })
      expect(evaluation.passed).toBe(false)
      expect(evaluation.reasons).toContain('duplicate_identity_or_email')
    })

    it('detects referee not being a new customer', () => {
      const evaluation = evaluateReferralFraud({
        advocateCustomerId: 'cust-1',
        refereeCustomerId: 'cust-2',
        advocateEmailHash: 'hash-a',
        refereeEmailHash: 'hash-b',
        priorOrdersCount: 2,
        activeAdvocateReferralsCount: 0,
        maxReferralsAllowed: 10
      })
      expect(evaluation.passed).toBe(false)
      expect(evaluation.reasons).toContain('referee_not_new_customer')
    })

    it('detects velocity cap exceeded', () => {
      const evaluation = evaluateReferralFraud({
        advocateCustomerId: 'cust-1',
        refereeCustomerId: 'cust-2',
        advocateEmailHash: 'hash-a',
        refereeEmailHash: 'hash-b',
        priorOrdersCount: 0,
        activeAdvocateReferralsCount: 10,
        maxReferralsAllowed: 10
      })
      expect(evaluation.passed).toBe(false)
      expect(evaluation.reasons).toContain('advocate_referral_cap_reached')
    })

    it('passes clean referral between legitimate independent customers', () => {
      const evaluation = evaluateReferralFraud({
        advocateCustomerId: 'cust-1',
        refereeCustomerId: 'cust-2',
        advocateEmailHash: 'hash-a',
        refereeEmailHash: 'hash-b',
        priorOrdersCount: 0,
        activeAdvocateReferralsCount: 2,
        maxReferralsAllowed: 10
      })
      expect(evaluation.passed).toBe(true)
      expect(evaluation.reasons).toHaveLength(0)
    })

    it('calculates return window elapsed accurately', () => {
      expect(isReturnWindowElapsed(PAST_30_DAYS, 14, NOW)).toBe(true)
      expect(isReturnWindowElapsed(PAST_10_DAYS, 14, NOW)).toBe(false)
      const endsAt = calculateReturnWindowEndsAt(PAST_30_DAYS, 14)
      expect(new Date(endsAt).getTime()).toBeGreaterThan(new Date(PAST_30_DAYS).getTime())
    })
  })

  describe('D1 Referral Enrollment, Attribution and Settlement', () => {
    it('reads and updates global referral policy with CAS and authorization check', async () => {
      const policy = await readD1ReferralPolicy(db)
      expect(policy.rewardCents).toBe(1500)
      expect(policy.returnWindowDays).toBe(14)

      const updated = await updateD1ReferralPolicy(db, ADMIN_CLAIMS, {
        expectedVersion: 1,
        rewardCents: 2000,
        refereeDiscountCents: 1200,
        minOrderCents: 6000,
        returnWindowDays: 20,
        maxReferralsPerAdvocate: 15,
        isActive: true,
        termsVersion: 'terms-v2-2026',
        commandId: '90000000-0000-4000-8000-000000000099',
        idempotencyKey: 'idem-update-policy-1',
        now: NOW
      })
      expect(updated.rewardCents).toBe(2000)
      expect(updated.version).toBe(2)

      await expect(
        updateD1ReferralPolicy(db, ADMIN_CLAIMS, {
          expectedVersion: 1,
          rewardCents: 2500,
          refereeDiscountCents: 1200,
          minOrderCents: 6000,
          returnWindowDays: 20,
          maxReferralsPerAdvocate: 15,
          isActive: true,
          termsVersion: 'terms-v2-2026',
          commandId: '90000000-0000-4000-8000-000000000098',
          idempotencyKey: 'idem-update-policy-conflict',
          now: NOW
        })
      ).rejects.toThrow(ReferralError)
    })

    it('enrolls advocate with explicit terms consent and generates unique code', async () => {
      const enrollment = await enrollD1ReferralAdvocate(db, ADVOCATE_CLAIMS, {
        termsVersion: 'terms-v1-2026',
        consentedAt: NOW
      })

      expect(enrollment.referralCode).toBeDefined()
      expect(enrollment.referralCode.length).toBeGreaterThanOrEqual(8)
      expect(enrollment.termsVersion).toBe('terms-v1-2026')
      expect(enrollment.status).toBe('active')

      // Overview
      const overview = await getD1CustomerReferralOverview(db, ADVOCATE_CUSTOMER_ID)
      expect(overview.enrolled).toBe(true)
      expect(overview.referralCode).toBe(enrollment.referralCode)
    })

    it('attributes referral order with pending return window', async () => {
      const enrollment = await enrollD1ReferralAdvocate(db, ADVOCATE_CLAIMS, {
        termsVersion: 'terms-v1-2026',
        consentedAt: NOW
      })

      const attribution = await attributeD1ReferralOrder(db, {
        commandId: 'a0000000-0000-4000-8000-000000000001',
        idempotencyKey: 'idem-attr-1',
        referralCode: enrollment.referralCode,
        refereeCustomerId: REFEREE_CUSTOMER_ID,
        orderId: ORDER_ID_1,
        now: NOW
      })

      expect(attribution.status).toBe('pending_window')
      expect(attribution.fraudCheckPassed).toBe(true)
      expect(attribution.returnWindowEndsAt).toBeDefined()
    })

    it('settles rewards ONLY when return window has elapsed without return/refund', async () => {
      const enrollment = await enrollD1ReferralAdvocate(db, ADVOCATE_CLAIMS, {
        termsVersion: 'terms-v1-2026',
        consentedAt: NOW
      })

      // Insert attribution completed 30 days ago (window elapsed)
      sqlite.exec(`
        INSERT INTO referral_attributions (
          id, referral_code, advocate_customer_id, referee_customer_id, order_id,
          order_amount_cents, order_completed_at, return_window_ends_at, status,
          fraud_check_passed, reward_cents, created_at
        ) VALUES (
          'a0000000-0000-4000-8000-000000000010',
          '${enrollment.referralCode}',
          '${ADVOCATE_CUSTOMER_ID}',
          '${REFEREE_CUSTOMER_ID}',
          '${ORDER_ID_1}',
          7500,
          '${PAST_30_DAYS}',
          '2026-10-13T12:00:00Z',
          'pending_window',
          1,
          1500,
          '${PAST_30_DAYS}'
        );
      `)

      const settlement = await settleD1ReferralAttributions(db, ADMIN_CLAIMS, {
        commandId: 'a0000000-0000-4000-8000-000000000011',
        idempotencyKey: 'idem-settle-1',
        now: NOW
      })

      expect(settlement.settledCount).toBe(1)
      expect(settlement.settledRewardCentsTotal).toBe(1500)

      const overview = await getD1CustomerReferralOverview(db, ADVOCATE_CUSTOMER_ID)
      expect(overview.totalRewardedCents).toBe(1500)
    })

    it('rejects reward if order is returned or cancelled during window', async () => {
      const enrollment = await enrollD1ReferralAdvocate(db, ADVOCATE_CLAIMS, {
        termsVersion: 'terms-v1-2026',
        consentedAt: NOW
      })

      // Attribution for returned order
      sqlite.exec(`
        INSERT INTO referral_attributions (
          id, referral_code, advocate_customer_id, referee_customer_id, order_id,
          order_amount_cents, order_completed_at, return_window_ends_at, status,
          fraud_check_passed, reward_cents, created_at
        ) VALUES (
          'a0000000-0000-4000-8000-000000000020',
          '${enrollment.referralCode}',
          '${ADVOCATE_CUSTOMER_ID}',
          '${REFEREE_CUSTOMER_ID}',
          '${ORDER_ID_RETURNED}',
          8000,
          '${PAST_10_DAYS}',
          '2026-11-02T12:00:00Z',
          'pending_window',
          1,
          1500,
          '${PAST_10_DAYS}'
        );
      `)

      const rejected = await rejectD1ReferralAttribution(db, ADMIN_CLAIMS, {
        commandId: 'a0000000-0000-4000-8000-000000000021',
        idempotencyKey: 'idem-reject-ret',
        attributionId: 'a0000000-0000-4000-8000-000000000020',
        reason: 'order_returned_or_refunded',
        now: NOW
      })

      expect(rejected.status).toBe('rejected')
      expect(rejected.rejectionReason).toBe('order_returned_or_refunded')
    })
  })
})
