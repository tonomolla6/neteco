import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  type CreateSegmentInput,
  type UpdateSegmentRulesInput,
  AdminAudiencesError
} from '../../shared/admin-audiences'
import {
  createD1AudienceSegment,
  updateD1AudienceSegmentRules,
  estimateD1AudienceSegment,
  previewD1AudienceUsers,
  readD1AudienceSegment,
  listD1AudienceSegmentVersions
} from '../../workers/marketing/audiences'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: ADMIN_ID, sessionId: '20000000-0000-4000-8000-000000000001', sessionVersion: 1 }

// 3 customers:
// 1. B2B, active newsletter consent, 2 orders
// 2. B2C, unsubscribed newsletter, 1 order
// 3. B2B, suppressed, 0 orders
const C1_ID = '30000000-0000-4000-8000-000000000001'
const C2_ID = '30000000-0000-4000-8000-000000000002'
const C3_ID = '30000000-0000-4000-8000-000000000003'

async function setupAudiencesDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile(new URL('../../db/d1/migrations/0110_rca_copilot_audiences.sql', import.meta.url), 'utf8'))

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Fixture admin');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin'),
      ('audiences.manage', 'audiences', 'manage', 'Fixture audiences manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('admin', 'audiences.manage');

    -- Customers first (for foreign keys)
    INSERT OR IGNORE INTO customers (id, name, phone, status, created_at, updated_at) VALUES
      ('${C1_ID}', 'Lavanderias Centrales SL', '+34960111111', 'active', '${NOW}', '${NOW}'),
      ('${C2_ID}', 'Maria Garcia Lopez', '+34960222222', 'active', '${NOW}', '${NOW}'),
      ('${C3_ID}', 'Quimica Industrial SA', '+34960333333', 'active', '${NOW}', '${NOW}');

    -- Companies (C1 and C3 are B2B)
    INSERT OR IGNORE INTO companies (id, customer_id, legal_name, trade_name, tax_id, country_code, status, created_at, updated_at) VALUES
      ('40000000-0000-4000-8000-000000000001', '${C1_ID}', 'Lavanderias Centrales SL', 'Lavanderias Central', 'B12345678', 'ES', 'approved', '${NOW}', '${NOW}'),
      ('40000000-0000-4000-8000-000000000003', '${C3_ID}', 'Quimica Industrial SA', 'Quimica Ind', 'A87654321', 'ES', 'approved', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO identities (id, customer_id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at) VALUES
      ('${ADMIN_ID}', NULL, 'audiences-admin@example.invalid', 'hash', '${NOW}', 'active', 1, '${NOW}', '${NOW}'),
      ('10000000-0000-4000-8000-000000000011', '${C1_ID}', 'lavanderias@example.invalid', 'hash', '${NOW}', 'active', 1, '${NOW}', '${NOW}'),
      ('10000000-0000-4000-8000-000000000012', '${C2_ID}', 'maria.garcia@example.invalid', 'hash', '${NOW}', 'active', 1, '${NOW}', '${NOW}'),
      ('10000000-0000-4000-8000-000000000013', '${C3_ID}', 'quimica@example.invalid', 'hash', '${NOW}', 'active', 1, '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000001', '${ADMIN_ID}', 1, 1, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');

    -- Newsletter Consents
    -- C1: Confirmed newsletter
    INSERT OR IGNORE INTO newsletter_subscriptions (
      id, email_normalized, email_hash, purpose, channel, status, consent_text, consent_version, consent_source,
      request_id, request_key, requested_at, confirmation_expires_at, confirmed_at
    ) VALUES (
      'sub-1', 'lavanderias@example.invalid', 'c100000000000000000000000000000000000000000000000000000000000001',
      'newsletter', 'email', 'confirmed', 'Acepto ofertas y novedades Neteco', 'v1', 'web_footer',
      'req-1', 'key-1', 1700000000, 1700086400, 1700000100
    );

    -- C2: Unsubscribed
    INSERT OR IGNORE INTO newsletter_subscriptions (
      id, email_normalized, email_hash, purpose, channel, status, consent_text, consent_version, consent_source,
      request_id, request_key, requested_at, confirmation_expires_at, confirmed_at, unsubscribed_at
    ) VALUES (
      'sub-2', 'maria.garcia@example.invalid', 'c200000000000000000000000000000000000000000000000000000000000002',
      'newsletter', 'email', 'unsubscribed', 'Acepto ofertas', 'v1', 'checkout',
      'req-2', 'key-2', 1700000000, 1700086400, 1700000100, 1700050000
    );

    -- C3: Suppressed
    INSERT OR IGNORE INTO newsletter_suppressions (
      email_hash, channel, reason, source, created_at, updated_at
    ) VALUES (
      'c300000000000000000000000000000000000000000000000000000000000003',
      'email', 'manual', 'gdpr_request', 1700000000, 1700000000
    );

    -- Carts & Quotes for 3 Orders
    INSERT OR IGNORE INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at) VALUES
      ('cart-1', '1000000000000000000000000000000000000000000000000000000000000001', 'active', 1, '2027-01-01T00:00:00Z', 'corr-1', '${NOW}', '${NOW}'),
      ('cart-2', '1000000000000000000000000000000000000000000000000000000000000002', 'active', 1, '2027-01-01T00:00:00Z', 'corr-1', '${NOW}', '${NOW}'),
      ('cart-3', '1000000000000000000000000000000000000000000000000000000000000003', 'active', 1, '2027-01-01T00:00:00Z', 'corr-1', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO checkout_quotes(id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents, shipping_pending, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at) VALUES
      ('cart-1', 'cart-1', 1, '${NOW}', 'EUR', 0, 1, 37190, 7810, 45000, '2000000000000000000000000000000000000000000000000000000000000001', 'corr-1', '${NOW}'),
      ('cart-2', 'cart-2', 1, '${NOW}', 'EUR', 0, 1, 20661, 4339, 25000, '2000000000000000000000000000000000000000000000000000000000000002', 'corr-1', '${NOW}'),
      ('cart-3', 'cart-3', 1, '${NOW}', 'EUR', 0, 1, 2893, 607, 3500, '2000000000000000000000000000000000000000000000000000000000000003', 'corr-1', '${NOW}');

    INSERT OR IGNORE INTO shipping_quotes(id, cart_id, cart_version, destination_hash, options_json, option_count, snapshot_hash, expires_at, correlation_id, created_at) VALUES
      ('cart-1', 'cart-1', 1, '3000000000000000000000000000000000000000000000000000000000000001', '[]', 0, '4000000000000000000000000000000000000000000000000000000000000001', '2027-01-01T00:00:00Z', 'corr-1', '${NOW}'),
      ('cart-2', 'cart-2', 1, '3000000000000000000000000000000000000000000000000000000000000002', '[]', 0, '4000000000000000000000000000000000000000000000000000000000000002', '2027-01-01T00:00:00Z', 'corr-1', '${NOW}'),
      ('cart-3', 'cart-3', 1, '3000000000000000000000000000000000000000000000000000000000000003', '[]', 0, '4000000000000000000000000000000000000000000000000000000000000003', '2027-01-01T00:00:00Z', 'corr-1', '${NOW}');

    INSERT OR IGNORE INTO checkout_attempts(id, cart_id, command_key, state, correlation_id, payload_hash, created_at, updated_at) VALUES
      ('cart-1', 'cart-1', 'key-1', 'failed', 'corr-1', '5000000000000000000000000000000000000000000000000000000000000001', '${NOW}', '${NOW}'),
      ('cart-2', 'cart-2', 'key-2', 'failed', 'corr-1', '5000000000000000000000000000000000000000000000000000000000000002', '${NOW}', '${NOW}'),
      ('cart-3', 'cart-3', 'key-3', 'failed', 'corr-1', '5000000000000000000000000000000000000000000000000000000000000003', '${NOW}', '${NOW}');

    -- Orders
    INSERT OR IGNORE INTO orders (
      id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status,
      reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents,
      shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version,
      shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy,
      correlation_id, customer_id, created_at, updated_at
    ) VALUES
      ('50000000-0000-4000-8000-000000000001', 'cart-1', 'cart-1', 'cart-1', 'cart-1', '6000000000000000000000000000000000000000000000000000000000000001', 'awaiting_payment', 'res-1', '2027-01-01T00:00:00Z', 'EUR', 37190, 7810, 45000, 0, 0, 0, 'std', 1, 1, 3, 'lavanderias@example.invalid', 'c100000000000000000000000000000000000000000000000000000000000001', 1, 1, 'corr-1', '${C1_ID}', '${NOW}', '${NOW}'),
      ('50000000-0000-4000-8000-000000000002', 'cart-2', 'cart-2', 'cart-2', 'cart-2', '6000000000000000000000000000000000000000000000000000000000000002', 'awaiting_payment', 'res-2', '2027-01-01T00:00:00Z', 'EUR', 20661, 4339, 25000, 0, 0, 0, 'std', 1, 1, 3, 'lavanderias@example.invalid', 'c100000000000000000000000000000000000000000000000000000000000001', 1, 1, 'corr-1', '${C1_ID}', '${NOW}', '${NOW}'),
      ('50000000-0000-4000-8000-000000000003', 'cart-3', 'cart-3', 'cart-3', 'cart-3', '6000000000000000000000000000000000000000000000000000000000000003', 'awaiting_payment', 'res-3', '2027-01-01T00:00:00Z', 'EUR', 2893, 607, 3500, 0, 0, 0, 'std', 1, 1, 3, 'maria.garcia@example.invalid', 'c200000000000000000000000000000000000000000000000000000000000002', 1, 1, 'corr-1', '${C2_ID}', '${NOW}', '${NOW}');
  `)
  return sqlite
}

describe('ADM-027: Customer segments and audiences with versioned rules, size estimation, and privacy preview', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupAudiencesDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('creates an audience segment with versioned rules', async () => {
    const input: CreateSegmentInput = {
      slug: 'b2b-active-buyers',
      name: 'Clientes Profesionales B2B Activos',
      description: 'Empresas con al menos 1 pedido confirmado',
      targetType: 'b2b',
      rules: {
        logic: 'AND',
        conditions: [
          { field: 'customer_type', operator: 'eq', value: 'b2b' },
          { field: 'orders_count', operator: 'gte', value: 1 }
        ]
      }
    }

    const created = await createD1AudienceSegment(db, CLAIMS, input, {
      idempotencyKey: 'idemp-seg-create-1',
      now: () => NOW
    })

    expect(created.segmentId).toBeDefined()
    expect(created.version).toBe(1)
    expect(created.slug).toBe('b2b-active-buyers')

    const segment = await readD1AudienceSegment(db, created.segmentId)
    expect(segment).not.toBeNull()
    expect(segment!.rules.conditions.length).toBe(2)
    expect(segment!.version).toBe(1)

    // Version history must record version 1
    const versions = await listD1AudienceSegmentVersions(db, created.segmentId)
    expect(versions.length).toBe(1)
    expect(versions[0]!.version).toBe(1)
  })

  it('updates audience rules and creates version 2 with CAS', async () => {
    const createInput: CreateSegmentInput = {
      slug: 'high-value-customers',
      name: 'Clientes de Alto Valor',
      targetType: 'all',
      rules: {
        logic: 'AND',
        conditions: [{ field: 'orders_count', operator: 'gte', value: 1 }]
      }
    }

    const created = await createD1AudienceSegment(db, CLAIMS, createInput, {
      idempotencyKey: 'idemp-seg-create-2',
      now: () => NOW
    })

    const updateInput: UpdateSegmentRulesInput = {
      expectedVersion: 1,
      name: 'Clientes VIP (> 500€)',
      rules: {
        logic: 'AND',
        conditions: [
          { field: 'orders_count', operator: 'gte', value: 1 },
          { field: 'total_spent_cents', operator: 'gte', value: 50000 }
        ]
      },
      changeSummary: 'Añadido umbral de gasto mínimo de 500€'
    }

    const updated = await updateD1AudienceSegmentRules(db, CLAIMS, created.segmentId, updateInput, {
      idempotencyKey: 'idemp-seg-update-1',
      now: () => NOW
    })

    expect(updated.version).toBe(2)

    // Stale version update must fail
    await expect(
      updateD1AudienceSegmentRules(db, CLAIMS, created.segmentId, updateInput, {
        idempotencyKey: 'idemp-seg-update-stale',
        now: () => NOW
      })
    ).rejects.toThrow(AdminAudiencesError)

    const versions = await listD1AudienceSegmentVersions(db, created.segmentId)
    expect(versions.length).toBe(2)
    expect(versions[1]!.version).toBe(2)
    expect(versions[1]!.changeSummary).toContain('500€')
  })

  it('estimates audience size and consent breakdown accurately', async () => {
    // Segment: B2B customers
    const input: CreateSegmentInput = {
      slug: 'all-b2b',
      name: 'Todos los B2B',
      targetType: 'b2b',
      rules: {
        logic: 'AND',
        conditions: [{ field: 'customer_type', operator: 'eq', value: 'b2b' }]
      }
    }

    const created = await createD1AudienceSegment(db, CLAIMS, input, {
      idempotencyKey: 'idemp-estimate-seg',
      now: () => NOW
    })

    const estimation = await estimateD1AudienceSegment(db, created.segmentId, { now: () => NOW })

    // Total B2B = 2 (C1 and C3)
    // C1 has confirmed consent
    // C3 is suppressed
    expect(estimation.totalMatchingUsers).toBe(2)
    expect(estimation.consentedUsers).toBe(1)
    expect(estimation.unconsentedUsers).toBe(1)
    expect(estimation.consentPercentage).toBe(50)
  })

  it('previews users without exporting unnecessary PII (privacy-safe masking)', async () => {
    const input: CreateSegmentInput = {
      slug: 'preview-test',
      name: 'Audiencia para Preview',
      targetType: 'all',
      rules: {
        logic: 'AND',
        conditions: [{ field: 'orders_count', operator: 'gte', value: 1 }]
      }
    }

    const created = await createD1AudienceSegment(db, CLAIMS, input, {
      idempotencyKey: 'idemp-preview-seg',
      now: () => NOW
    })

    const preview = await previewD1AudienceUsers(db, created.segmentId, { limit: 10 })

    expect(preview.items.length).toBe(2) // C1 and C2 have >= 1 order

    for (const user of preview.items) {
      // PII Protection checks:
      // 1. No plaintext email
      expect(user.maskedIdentifier).toMatch(/^[a-z0-9]?[*]{3}[a-z0-9]?@[a-z0-9.-]+\.[a-z]{2,}$/i)
      // 2. No phone number field exported
      expect((user as unknown as Record<string, unknown>).phone).toBeUndefined()
      // 3. No street addresses or tax credentials exported
      expect((user as unknown as Record<string, unknown>).shippingAddress).toBeUndefined()
      expect((user as unknown as Record<string, unknown>).taxId).toBeUndefined()
      // 4. Safe metrics included
      expect(typeof user.orderCount).toBe('number')
      expect(typeof user.totalSpentCents).toBe('number')
      expect(typeof user.hasConsent).toBe('boolean')
    }
  })
})
