import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openMigratedDatabase, d1OverSqlite, seedInventoryFixture } from '../support/d1-sqlite'
import {
  submitProductReview,
  submitProductQuestion,
  moderateProductReview,
  merchantReplyProductReview,
  officialAnswerProductQuestion,
  revokeReviewQaConsent,
  listPublicProductReviews,
  listPublicProductQuestions,
  ProductReviewsQaError
} from '../../workers/catalog/product-reviews-qa'

const now = '2026-10-29T12:00:00Z'

async function fixture() {
  const sqlite = await openMigratedDatabase()
  try {
    seedInventoryFixture(sqlite)
    const migration = await readFile('db/d1/migrations/0113_product_reviews_qa_and_media_guides.sql', 'utf8')
    sqlite.exec(migration)

    // Seed test customers and identities
    sqlite.exec(`
      INSERT INTO customers(id, created_at, updated_at) VALUES
      ('cust-buyer-1', '${now}', '${now}'),
      ('cust-guest-2', '${now}', '${now}');

      INSERT INTO identities(id, customer_id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at) VALUES
      ('id-buyer-1', 'cust-buyer-1', 'buyer@example.invalid', 'syn', '${now}', 'active', 1, '${now}', '${now}'),
      ('id-guest-2', 'cust-guest-2', 'guest@example.invalid', 'syn', '${now}', 'active', 1, '${now}', '${now}'),
      ('id-admin-1', NULL, 'staff@example.invalid', 'syn', '${now}', 'active', 1, '${now}', '${now}');

      INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('sess-buyer-1', 'id-buyer-1', 1, 1, '${now}', '2026-10-30T12:00:00Z'),
      ('sess-guest-2', 'id-guest-2', 1, 0, '${now}', '2026-10-30T12:00:00Z'),
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

describe('PDP-016: Verified reviews and moderated Q&A domain', () => {
  it('marks review as verified buyer ONLY when customer has an order for the product', async () => {
    const { sqlite, db } = await fixture()
    try {
      // 1. Genuine buyer with delivered/placed order
      const verifiedResult = await submitProductReview(db, {
        productId: 'p-1',
        customerId: 'cust-buyer-1',
        actorId: 'id-buyer-1',
        orderId: 'ord-buyer-1',
        rating: 5,
        title: 'Excelente desengrasante industrial',
        content: 'Limpia residuos químicos sin dañar superficies. Muy recomendable.',
        displayName: 'Carlos M.',
        consentAccepted: true,
        commandId: 'cmd-rev-01',
        now
      })

      expect(verifiedResult.isVerifiedBuyer).toBe(true)
      expect(verifiedResult.moderationStatus).toBe('pending')
      expect(verifiedResult.fraudStatus).toBe('clean')
      expect(verifiedResult.version).toBe(1)

      // 2. Guest / non-buyer who never purchased this product
      const unverifiedResult = await submitProductReview(db, {
        productId: 'p-1',
        customerId: 'cust-guest-2',
        actorId: 'id-guest-2',
        rating: 4,
        title: 'Parece buen producto',
        content: 'Lo he visto en la descripción y tiene buenas características técnicas.',
        displayName: 'Invitado',
        consentAccepted: true,
        commandId: 'cmd-rev-02',
        now
      })

      expect(unverifiedResult.isVerifiedBuyer).toBe(false)
      expect(unverifiedResult.moderationStatus).toBe('pending')
      expect(unverifiedResult.fraudStatus).toBe('clean')
    } finally {
      sqlite.close()
    }
  })

  it('detects fraud and flags reviews containing suspicious external links or spam velocity', async () => {
    const { sqlite, db } = await fixture()
    try {
      // Review with external spam links
      const spamResult = await submitProductReview(db, {
        productId: 'p-1',
        customerId: 'cust-guest-2',
        actorId: 'id-guest-2',
        rating: 5,
        title: 'Ver más en http://external-info.example.org',
        content: 'Consulte la web externa https://external-info.example.org para otros químicos.',
        displayName: 'Spammer',
        consentAccepted: true,
        commandId: 'cmd-rev-spam',
        now
      })

      expect(spamResult.fraudStatus).toBe('flagged')
      expect(spamResult.fraudScore).toBeGreaterThanOrEqual(0.5)
      expect(spamResult.moderationStatus).toBe('quarantined')
    } finally {
      sqlite.close()
    }
  })

  it('guarantees idempotency on duplicate review submissions with identical commandId', async () => {
    const { sqlite, db } = await fixture()
    try {
      const payload = {
        productId: 'p-1',
        customerId: 'cust-buyer-1',
        actorId: 'id-buyer-1',
        orderId: 'ord-buyer-1',
        rating: 5,
        title: 'Excelente desengrasante industrial',
        content: 'Limpia residuos químicos sin dañar superficies.',
        displayName: 'Carlos M.',
        consentAccepted: true,
        commandId: 'cmd-rev-idempotent',
        now
      }

      const first = await submitProductReview(db, payload)
      const second = await submitProductReview(db, payload)

      expect(first.id).toBe(second.id)
      expect(first.version).toBe(second.version)
    } finally {
      sqlite.close()
    }
  })

  it('handles question submission, admin moderation, and official answers', async () => {
    const { sqlite, db } = await fixture()
    try {
      // 1. Submit question
      const q = await submitProductQuestion(db, {
        productId: 'p-1',
        customerId: 'cust-buyer-1',
        actorId: 'id-buyer-1',
        title: '¿Es apto para aluminio anodizado?',
        content: 'Necesitamos saber si el pH ataca el aluminio antes de aplicarlo en tanques.',
        displayName: 'Carlos M.',
        consentAccepted: true,
        commandId: 'cmd-q-01',
        now
      })

      expect(q.moderationStatus).toBe('pending')
      expect(q.officialAnswer).toBeNull()

      // Before moderation, question is not in public listing
      const publicBefore = await listPublicProductQuestions(db, 'p-1')
      expect(publicBefore.items.find((item) => item.id === q.id)).toBeUndefined()

      // 2. Admin moderates and publishes official answer
      const answered = await officialAnswerProductQuestion(db, {
        questionId: q.id,
        actorId: 'id-admin-1',
        officialAnswer: 'Sí, a dilución 1:20 es completamente seguro para aluminio anodizado.',
        expectedVersion: 1,
        commandId: 'cmd-q-answer',
        now
      })

      expect(answered.moderationStatus).toBe('answered')
      expect(answered.officialAnswer).toContain('dilución 1:20')
      expect(answered.version).toBe(2)

      // Now it appears in public Q&A
      const publicAfter = await listPublicProductQuestions(db, 'p-1')
      const publicItem = publicAfter.items.find((item) => item.id === q.id)
      expect(publicItem).toBeDefined()
      expect(publicItem?.officialAnswer).toContain('dilución 1:20')
      expect(publicItem?.isVerifiedBuyer).toBe(true)
    } finally {
      sqlite.close()
    }
  })

  it('allows merchant to reply to a verified review and displays it publicly', async () => {
    const { sqlite, db } = await fixture()
    try {
      const review = await submitProductReview(db, {
        productId: 'p-1',
        customerId: 'cust-buyer-1',
        actorId: 'id-buyer-1',
        orderId: 'ord-buyer-1',
        rating: 5,
        title: 'Muy eficaz',
        content: 'Eficacia comprobada en taller mecánico.',
        displayName: 'Carlos M.',
        consentAccepted: true,
        commandId: 'cmd-rev-rep-01',
        now
      })

      // Admin approves review
      await moderateProductReview(db, {
        reviewId: review.id,
        actorId: 'id-admin-1',
        action: 'approve',
        reason: 'Contenido verificado legítimo',
        expectedVersion: 1,
        commandId: 'cmd-mod-rev-01',
        now
      })

      // Merchant reply
      const replied = await merchantReplyProductReview(db, {
        reviewId: review.id,
        actorId: 'id-admin-1',
        merchantResponse: 'Gracias Carlos por confiar en Neteco para el mantenimiento de tu taller.',
        expectedVersion: 2,
        commandId: 'cmd-merchant-rep-01',
        now
      })

      expect(replied.merchantResponse).toContain('Gracias Carlos')
      expect(replied.version).toBe(3)

      const publicList = await listPublicProductReviews(db, 'p-1')
      const pubRev = publicList.items.find((r) => r.id === review.id)
      expect(pubRev?.merchantResponse).toContain('Gracias Carlos')
      expect(pubRev?.isVerifiedBuyer).toBe(true)
    } finally {
      sqlite.close()
    }
  })

  it('supports GDPR consent withdrawal with anonymization of reviewer display name', async () => {
    const { sqlite, db } = await fixture()
    try {
      const review = await submitProductReview(db, {
        productId: 'p-1',
        customerId: 'cust-buyer-1',
        actorId: 'id-buyer-1',
        orderId: 'ord-buyer-1',
        rating: 5,
        title: 'Buen producto',
        content: 'Cumple perfectamente las especificaciones técnicas del fabricante.',
        displayName: 'Carlos Moreno',
        consentAccepted: true,
        commandId: 'cmd-rev-gdpr',
        now
      })

      await moderateProductReview(db, {
        reviewId: review.id,
        actorId: 'id-admin-1',
        action: 'approve',
        reason: 'Aprobado',
        expectedVersion: 1,
        commandId: 'cmd-mod-gdpr',
        now
      })

      // Customer revokes consent to display their full name
      await revokeReviewQaConsent(db, {
        entityId: review.id,
        entityType: 'review',
        customerId: 'cust-buyer-1',
        actorId: 'id-buyer-1',
        anonymizeOnly: true,
        expectedVersion: 2,
        commandId: 'cmd-gdpr-revoke',
        now
      })

      const publicList = await listPublicProductReviews(db, 'p-1')
      const pub = publicList.items.find((r) => r.id === review.id)
      expect(pub?.displayName).toBe('Cliente verificado')
    } finally {
      sqlite.close()
    }
  })

  it('enforces CAS version check when concurrent moderation occurs', async () => {
    const { sqlite, db } = await fixture()
    try {
      const review = await submitProductReview(db, {
        productId: 'p-1',
        customerId: 'cust-buyer-1',
        actorId: 'id-buyer-1',
        orderId: 'ord-buyer-1',
        rating: 4,
        title: 'Buen resultado',
        content: 'Resultado óptimo en limpieza de suelos.',
        displayName: 'Carlos M.',
        consentAccepted: true,
        commandId: 'cmd-rev-cas',
        now
      })

      // Attempt moderation with stale version 0 should fail
      await expect(
        moderateProductReview(db, {
          reviewId: review.id,
          actorId: 'id-admin-1',
          action: 'approve',
          reason: 'Aprobado',
          expectedVersion: 0, // Wrong expected version (current is 1)
          commandId: 'cmd-mod-cas-wrong',
          now
        })
      ).rejects.toThrow(ProductReviewsQaError)
    } finally {
      sqlite.close()
    }
  })
})
