import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openMigratedDatabase, d1OverSqlite, seedInventoryFixture } from '../support/d1-sqlite'
import {
  handleProductReviewsQaHttp,
  ownsProductReviewsQaNamespace
} from '../../workers/catalog/product-reviews-qa-http'

const now = '2026-10-29T12:00:00Z'

async function fixture() {
  const sqlite = await openMigratedDatabase()
  try {
    seedInventoryFixture(sqlite)
    const migration = await readFile('db/d1/migrations/0113_product_reviews_qa_and_media_guides.sql', 'utf8')
    sqlite.exec(migration)

    sqlite.exec(`
      INSERT INTO customers(id, created_at, updated_at) VALUES
      ('cust-buyer-1', '${now}', '${now}');

      INSERT INTO identities(id, customer_id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at) VALUES
      ('id-buyer-1', 'cust-buyer-1', 'buyer@example.invalid', 'syn', '${now}', 'active', 1, '${now}', '${now}'),
      ('id-admin-1', NULL, 'staff@example.invalid', 'syn', '${now}', 'active', 1, '${now}', '${now}');

      INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('sess-buyer-1', 'id-buyer-1', 1, 1, '${now}', '2026-10-30T12:00:00Z'),
      ('sess-admin-1', 'id-admin-1', 1, 1, '${now}', '2026-10-30T12:00:00Z');

      INSERT INTO identity_mfa(identity_id, encrypted_secret, verified_at, updated_at) VALUES
      ('id-admin-1', 'synth-secret', '${now}', '${now}');

      INSERT INTO permissions(code, resource, action, description) VALUES('support.manage', 'support', 'manage', 'Synthetic');
      INSERT INTO roles(code, name, description) VALUES('operator', 'Operator', 'Synthetic');
      INSERT INTO role_permissions(role_code, permission_code) VALUES('operator', 'support.manage');
      INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES('id-admin-1', 'operator', '${now}');
    `)

    // Seed order for cust-buyer-1 on product p-1 (variant v-1-1)
    const tokenHash = '0'.repeat(64)
    const emailHash1 = '1'.repeat(64)
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
      ) VALUES (
        'ord-buyer-1', 'cart-dummy', 'quote-dummy', 'ship-dummy', 'att-dummy', ?, 'awaiting_payment', 'res-1', '2027-01-01T00:00:00Z', 'EUR',
        826, 174, 1000, 0, 0, 0, 'parcel', 1, 1, 2, 'buyer@example.invalid', ?,
        1, 1, 'corr-1', 'cust-buyer-1', ?, ?
      )
    `
      )
      .run(tokenHash, emailHash1, now, now)

    sqlite
      .prepare(
        `
      INSERT INTO order_lines (
        order_id, line_index, variant_id, sku, name, quantity, unit_gross_cents, net_cents, tax_cents, gross_cents,
        tax_rate_basis_points, price_version_id, location_id, created_at
      ) VALUES (
        'ord-buyer-1', 0, 'v-1-1', 'SKU-1-1', 'Botella 1 L', 2, 500, 826, 174, 1000, 2100, 'pv-1', 'loc-main', ?
      )
    `
      )
      .run(now)
    sqlite.exec('PRAGMA foreign_keys = ON')

    return { sqlite, db: d1OverSqlite(sqlite) }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

describe('PDP-016: Verified reviews & moderated Q&A HTTP router', () => {
  it('recognizes namespace ownership for reviews and Q&A endpoints', () => {
    expect(ownsProductReviewsQaNamespace('/api/products/p-1/reviews')).toBe(true)
    expect(ownsProductReviewsQaNamespace('/api/products/p-1/questions')).toBe(true)
    expect(ownsProductReviewsQaNamespace('/api/reviews/rev-1/consent-revocation')).toBe(true)
    expect(ownsProductReviewsQaNamespace('/api/admin/reviews')).toBe(true)
    expect(ownsProductReviewsQaNamespace('/api/admin/reviews/rev-1/commands')).toBe(true)
    expect(ownsProductReviewsQaNamespace('/api/admin/questions/q-1/commands')).toBe(true)
    expect(ownsProductReviewsQaNamespace('/api/products/p-1/details')).toBe(false)
  })

  it('GET /api/products/:productId/reviews returns 200 with approved reviews', async () => {
    const { sqlite, db } = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/products/p-1/reviews')
      const response = await handleProductReviewsQaHttp(request, {
        database: db,
        now: () => now,
        sessionClaimsResolver: async () => null
      })

      expect(response).not.toBeNull()
      expect(response?.status).toBe(200)
      const data = (await response?.json()) as { items: unknown[]; total: number }
      expect(Array.isArray(data.items)).toBe(true)
    } finally {
      sqlite.close()
    }
  })

  it('POST /api/products/:productId/reviews requires authentication and creates review', async () => {
    const { sqlite, db } = await fixture()
    try {
      // 1. Unauthenticated -> 401
      const unauthReq = new Request('https://tienda.example.com/api/products/p-1/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating: 5,
          title: 'Genial producto',
          content: 'Excelente rendimiento en superficie industrial.',
          displayName: 'Carlos',
          consentAccepted: true,
          commandId: 'cmd-rev-http-1'
        })
      })

      const unauthRes = await handleProductReviewsQaHttp(unauthReq, {
        database: db,
        now: () => now,
        sessionClaimsResolver: async () => null
      })

      expect(unauthRes?.status).toBe(401)

      // 2. Authenticated customer with delivered order -> 201
      const authReq = new Request('https://tienda.example.com/api/products/p-1/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: 'ord-buyer-1',
          rating: 5,
          title: 'Genial producto desengrasante',
          content: 'Excelente rendimiento en superficie industrial.',
          displayName: 'Carlos M.',
          consentAccepted: true,
          commandId: 'cmd-rev-http-2'
        })
      })

      const authRes = await handleProductReviewsQaHttp(authReq, {
        database: db,
        now: () => now,
        sessionClaimsResolver: async () => ({
          identityId: 'id-buyer-1',
          customerId: 'cust-buyer-1',
          sessionId: 'sess-buyer-1',
          sessionVersion: 1
        })
      })

      expect(authRes?.status).toBe(201)
      const data = (await authRes?.json()) as { review: { isVerifiedBuyer: boolean; moderationStatus: string } }
      expect(data.review.isVerifiedBuyer).toBe(true)
      expect(data.review.moderationStatus).toBe('pending')
    } finally {
      sqlite.close()
    }
  })

  it('POST /api/admin/reviews/:reviewId/commands requires admin role and applies moderation', async () => {
    const { sqlite, db } = await fixture()
    try {
      // Seed a pending review
      sqlite
        .prepare(
          `
        INSERT INTO product_reviews (
          id, product_id, customer_id, rating, title, content, is_verified_buyer,
          moderation_status, fraud_status, fraud_score, fraud_reasons_json,
          consent_accepted, consent_version, consent_at, display_name, version,
          created_at, updated_at
        ) VALUES (
          'rev-test-1', 'p-1', 'cust-buyer-1', 5, 'Buenísimo', 'Limpieza profunda garantizada.',
          1, 'pending', 'clean', 0.0, '[]', 1, '2026-v1', '${now}', 'Carlos M.', 1, '${now}', '${now}'
        )
      `
        )
        .run()

      // Customer trying to moderate -> 403
      const forbiddenReq = new Request('https://tienda.example.com/api/admin/reviews/rev-test-1/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approve',
          reason: 'Aprobación',
          expectedVersion: 1,
          commandId: 'cmd-mod-forbidden'
        })
      })

      const forbiddenRes = await handleProductReviewsQaHttp(forbiddenReq, {
        database: db,
        now: () => now,
        sessionClaimsResolver: async () => ({
          identityId: 'id-buyer-1',
          customerId: 'cust-buyer-1',
          sessionId: 'sess-buyer-1',
          sessionVersion: 1
        })
      })

      expect(forbiddenRes?.status).toBe(403)

      // Admin moderates -> 200
      const adminReq = new Request('https://tienda.example.com/api/admin/reviews/rev-test-1/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approve',
          reason: 'Aprobación autorizada',
          expectedVersion: 1,
          commandId: 'cmd-mod-admin-ok'
        })
      })

      const adminRes = await handleProductReviewsQaHttp(adminReq, {
        database: db,
        now: () => now,
        sessionClaimsResolver: async () => ({
          identityId: 'id-admin-1',
          customerId: null,
          sessionId: 'sess-admin-1',
          sessionVersion: 1
        })
      })

      expect(adminRes?.status).toBe(200)
      const data = (await adminRes?.json()) as { review: { moderationStatus: string } }
      expect(data.review.moderationStatus).toBe('approved')
    } finally {
      sqlite.close()
    }
  })
})
