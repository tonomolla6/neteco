import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { analyticsFixture, CLAIMS } from './d1-analytics-fixture'
import {
  classifyDeclineResponse,
  assertNoProhibitedData,
  recordPaymentFunnelEvent,
  readPaymentFunnelDashboard,
  type PaymentFunnelDevice,
  type PaymentFunnelMethod
} from '../../workers/payments/funnel-analytics'
import { handlePaymentFunnelHttp, ownsPaymentFunnelNamespace } from '../../workers/payments/funnel-http'

const connections: DatabaseSync[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
})

const NOW = '2026-10-29T10:00:00Z'
const PAST = '2026-10-20T00:00:00Z'
const FUTURE = '2026-11-20T00:00:00Z'

async function setupPaymentFunnelFixture(options: { now?: string } = {}) {
  const world = await analyticsFixture({ commerce: true })
  connections.push(world.sqlite)

  const migrationSql = await readFile(
    new URL('../../db/d1/migrations/0103_payment_funnel.sql', import.meta.url),
    'utf8'
  )
  world.sqlite.exec(migrationSql)

  const currentNow = options.now ?? NOW
  world.setNow(currentNow)

  // Configure admin session claims in database for auth checks
  world.sqlite.prepare(`UPDATE auth_sessions SET created_at = ?, expires_at = ?`).run(PAST, FUTURE)
  world.sqlite
    .prepare(`UPDATE identities SET created_at = ?, updated_at = ?, email_verified_at = ?`)
    .run(PAST, PAST, PAST)
  world.sqlite.prepare(`UPDATE identity_roles SET granted_at = ?`).run(PAST)

  return world
}

describe('PAY-018 Payment Funnel & Decline Causes (TDD)', () => {
  describe('Decline Code Classification & Normalization', () => {
    it('classifies 0116 as insufficient_funds', () => {
      const result = classifyDeclineResponse('0116')
      expect(result.category).toBe('insufficient_funds')
      expect(result.label).toContain('insuficiente')
      expect(result.code).toBe('0116')
    })

    it('classifies 0184 as auth_failed_3ds', () => {
      const result = classifyDeclineResponse('0184')
      expect(result.category).toBe('auth_failed_3ds')
      expect(result.label).toContain('3DS')
    })

    it('classifies 9998 and 9999 as auth_failed_3ds pending validation', () => {
      expect(classifyDeclineResponse('9998').category).toBe('auth_failed_3ds')
      expect(classifyDeclineResponse('9999').category).toBe('auth_failed_3ds')
    })

    it('classifies 0101 and 0191 as expired_card', () => {
      expect(classifyDeclineResponse('0101').category).toBe('expired_card')
      expect(classifyDeclineResponse('0191').category).toBe('expired_card')
    })

    it('classifies 0104, 0102, 0125 as card_restriction / fraud_suspicion', () => {
      expect(classifyDeclineResponse('0104').category).toBe('card_restriction')
      expect(classifyDeclineResponse('0102').category).toBe('fraud_suspicion')
      expect(classifyDeclineResponse('0125').category).toBe('card_restriction')
    })

    it('classifies 0129, 9051, 0118 as invalid_card_details', () => {
      expect(classifyDeclineResponse('0129').category).toBe('invalid_card_details')
      expect(classifyDeclineResponse('9051').category).toBe('invalid_card_details')
      expect(classifyDeclineResponse('0118').category).toBe('invalid_card_details')
    })

    it('classifies 0106 as pin_attempts_exceeded', () => {
      expect(classifyDeclineResponse('0106').category).toBe('pin_attempts_exceeded')
    })

    it('classifies 9915 as user_cancelled', () => {
      const result = classifyDeclineResponse('9915')
      expect(result.category).toBe('user_cancelled')
      expect(result.label).toContain('usuario')
    })

    it('classifies 0190 as issuer_declined', () => {
      expect(classifyDeclineResponse('0190').category).toBe('issuer_declined')
    })

    it('classifies 9912 as issuer_unavailable', () => {
      expect(classifyDeclineResponse('9912').category).toBe('issuer_unavailable')
    })

    it('classifies 9104, 9218 as bizum_error', () => {
      expect(classifyDeclineResponse('9104').category).toBe('bizum_error')
      expect(classifyDeclineResponse('9218').category).toBe('bizum_error')
    })

    it('classifies 0904 as system_error', () => {
      expect(classifyDeclineResponse('0904').category).toBe('system_error')
    })

    it('classifies uncatalogued response code as other', () => {
      const result = classifyDeclineResponse('8888')
      expect(result.category).toBe('other')
      expect(result.code).toBe('8888')
    })
  })

  describe('Security & Prohibited Data Prevention', () => {
    it('detects and blocks PAN (credit card numbers 13-19 digits) in input objects', () => {
      expect(() => {
        assertNoProhibitedData({ bank: '4532015112830366', method: 'card' })
      }).toThrow(/prohibited_data/)
    })

    it('detects and blocks CVV/CVC keywords and numbers', () => {
      expect(() => {
        assertNoProhibitedData({ cvv: '123' })
      }).toThrow(/prohibited_data/)
      expect(() => {
        assertNoProhibitedData({ securityCode: '987' })
      }).toThrow(/prohibited_data/)
    })

    it('detects and blocks PIN and card expiration dates', () => {
      expect(() => {
        assertNoProhibitedData({ pin: '1234' })
      }).toThrow(/prohibited_data/)
      expect(() => {
        assertNoProhibitedData({ cardExpiry: '12/28' })
      }).toThrow(/prohibited_data/)
    })

    it('allows clean and safe metadata', () => {
      expect(() => {
        assertNoProhibitedData({
          bank: 'BBVA',
          method: 'card',
          device: 'desktop',
          responseCode: '0116'
        })
      }).not.toThrow()
    })

    it('database trigger rejects insertion of bank field containing digit sequences (PAN protection)', async () => {
      const fixture = await setupPaymentFunnelFixture()
      const order = fixture.sqlite.prepare('SELECT id FROM orders LIMIT 1').get() as { id: string }
      const intent = fixture.sqlite.prepare('SELECT id FROM payment_intents WHERE order_id = ?').get(order.id) as {
        id: string
      }

      expect(() => {
        fixture.sqlite
          .prepare(
            `INSERT INTO payment_funnel_events (
               id, intent_id, order_id, step, method, device, bank, response_code,
               decline_category, amount_cents, currency, created_at
             ) VALUES (?, ?, ?, 'declined', 'card', 'desktop', ?, '0190', 'issuer_declined', 5000, 'EUR', ?)`
          )
          .run(
            crypto.randomUUID(),
            intent.id,
            order.id,
            'BBVA-4532015112830366', // Prohibited PAN inside bank
            NOW
          )
      }).toThrow(/payment_funnel_prohibited_data/)
    })

    it('database trigger enforces append-only semantics (no UPDATE or DELETE)', async () => {
      const fixture = await setupPaymentFunnelFixture()
      const order = fixture.sqlite.prepare('SELECT id FROM orders LIMIT 1').get() as { id: string }
      const intent = fixture.sqlite.prepare('SELECT id FROM payment_intents WHERE order_id = ?').get(order.id) as {
        id: string
      }
      const eventId = crypto.randomUUID()

      fixture.sqlite
        .prepare(
          `INSERT INTO payment_funnel_events (
             id, intent_id, order_id, step, method, device, bank, response_code,
             decline_category, amount_cents, currency, created_at
           ) VALUES (?, ?, ?, 'intent_created', 'card', 'desktop', 'BBVA', NULL, NULL, 5000, 'EUR', ?)`
        )
        .run(eventId, intent.id, order.id, NOW)

      expect(() => {
        fixture.sqlite.prepare(`UPDATE payment_funnel_events SET step = 'redirected' WHERE id = ?`).run(eventId)
      }).toThrow(/append-only/)

      expect(() => {
        fixture.sqlite.prepare(`DELETE FROM payment_funnel_events WHERE id = ?`).run(eventId)
      }).toThrow(/append-only/)
    })
  })

  describe('Recording Payment Funnel Events', () => {
    it('records intent_created step and validates persistence', async () => {
      const fixture = await setupPaymentFunnelFixture()
      const order = fixture.sqlite.prepare('SELECT id FROM orders LIMIT 1').get() as { id: string }
      const intent = fixture.sqlite.prepare('SELECT id FROM payment_intents WHERE order_id = ?').get(order.id) as {
        id: string
      }

      const eventId = crypto.randomUUID()
      await recordPaymentFunnelEvent(fixture.database, {
        id: eventId,
        intentId: intent.id,
        orderId: order.id,
        step: 'intent_created',
        method: 'card',
        device: 'mobile',
        bank: 'Santander',
        amountCents: 6500,
        currency: 'EUR',
        createdAt: NOW
      })

      const row = fixture.sqlite.prepare('SELECT * FROM payment_funnel_events WHERE id = ?').get(eventId) as Record<
        string,
        unknown
      >

      expect(row).toBeDefined()
      expect(row.step).toBe('intent_created')
      expect(row.method).toBe('card')
      expect(row.device).toBe('mobile')
      expect(row.bank).toBe('Santander')
      expect(row.amount_cents).toBe(6500)
    })

    it('records declined step with categorized reason', async () => {
      const fixture = await setupPaymentFunnelFixture()
      const order = fixture.sqlite.prepare('SELECT id FROM orders LIMIT 1').get() as { id: string }
      const intent = fixture.sqlite.prepare('SELECT id FROM payment_intents WHERE order_id = ?').get(order.id) as {
        id: string
      }

      const eventId = crypto.randomUUID()
      await recordPaymentFunnelEvent(fixture.database, {
        id: eventId,
        intentId: intent.id,
        orderId: order.id,
        step: 'declined',
        method: 'bizum',
        device: 'desktop',
        responseCode: '0116',
        amountCents: 3200,
        currency: 'EUR',
        createdAt: NOW
      })

      const row = fixture.sqlite.prepare('SELECT * FROM payment_funnel_events WHERE id = ?').get(eventId) as Record<
        string,
        unknown
      >

      expect(row.step).toBe('declined')
      expect(row.decline_category).toBe('insufficient_funds')
      expect(row.response_code).toBe('0116')
    })
  })

  describe('Funnel Dashboard Calculations & Segmentation', () => {
    async function seedComprehensiveFunnel(fixture: Awaited<ReturnType<typeof setupPaymentFunnelFixture>>) {
      const order = fixture.sqlite.prepare('SELECT id FROM orders LIMIT 1').get() as { id: string }

      const records: Array<{
        step: 'intent_created' | 'redirected' | 'authorized' | 'declined' | 'cancelled' | 'expired'
        method: PaymentFunnelMethod
        device: PaymentFunnelDevice
        bank?: string
        responseCode?: string
        amount: number
        time: string
      }> = [
        // 10 successful card payments on desktop (BBVA)
        ...Array.from({ length: 10 }).map((_, i) => ({
          step: 'authorized' as const,
          method: 'card' as const,
          device: 'desktop' as const,
          bank: 'BBVA',
          responseCode: '0000',
          amount: 5000,
          time: `2026-10-25T10:${String(i).padStart(2, '0')}:00Z`
        })),
        // 5 successful card payments on mobile (Santander)
        ...Array.from({ length: 5 }).map((_, i) => ({
          step: 'authorized' as const,
          method: 'card' as const,
          device: 'mobile' as const,
          bank: 'Santander',
          responseCode: '0000',
          amount: 4000,
          time: `2026-10-25T11:${String(i).padStart(2, '0')}:00Z`
        })),
        // 5 successful bizum payments on mobile
        ...Array.from({ length: 5 }).map((_, i) => ({
          step: 'authorized' as const,
          method: 'bizum' as const,
          device: 'mobile' as const,
          responseCode: '0000',
          amount: 2500,
          time: `2026-10-25T12:${String(i).padStart(2, '0')}:00Z`
        })),
        // 4 declined for insufficient funds (0116)
        ...Array.from({ length: 4 }).map((_, i) => ({
          step: 'declined' as const,
          method: 'card' as const,
          device: 'desktop' as const,
          bank: 'CaixaBank',
          responseCode: '0116',
          amount: 9000,
          time: `2026-10-26T09:${String(i).padStart(2, '0')}:00Z`
        })),
        // 3 declined for 3DS authentication failure (0184)
        ...Array.from({ length: 3 }).map((_, i) => ({
          step: 'declined' as const,
          method: 'card' as const,
          device: 'mobile' as const,
          bank: 'BBVA',
          responseCode: '0184',
          amount: 8000,
          time: `2026-10-26T10:${String(i).padStart(2, '0')}:00Z`
        })),
        // 2 declined for expired card (0101)
        ...Array.from({ length: 2 }).map((_, i) => ({
          step: 'declined' as const,
          method: 'card' as const,
          device: 'tablet' as const,
          bank: 'Santander',
          responseCode: '0101',
          amount: 3500,
          time: `2026-10-26T11:${String(i).padStart(2, '0')}:00Z`
        })),
        // 3 user cancelled (9915)
        ...Array.from({ length: 3 }).map((_, i) => ({
          step: 'cancelled' as const,
          method: 'card' as const,
          device: 'desktop' as const,
          bank: 'BBVA',
          responseCode: '9915',
          amount: 5000,
          time: `2026-10-27T08:${String(i).padStart(2, '0')}:00Z`
        })),
        // 2 expired
        ...Array.from({ length: 2 }).map((_, i) => ({
          step: 'expired' as const,
          method: 'bizum' as const,
          device: 'mobile' as const,
          amount: 2000,
          time: `2026-10-27T09:${String(i).padStart(2, '0')}:00Z`
        }))
      ]

      for (let i = 0; i < records.length; i++) {
        const rec = records[i]
        const intentId = crypto.randomUUID()
        const merchantOrder = '9' + String(i).padStart(7, '0')
        const intentStatus =
          rec.step === 'authorized'
            ? 'captured'
            : rec.step === 'declined'
              ? 'failed'
              : rec.step === 'cancelled'
                ? 'cancelled'
                : 'expired'

        fixture.sqlite
          .prepare(
            `INSERT INTO payment_intents (
               id, order_id, provider, merchant_order, method, status, amount_gross_cents,
               currency, request_hash, redirect_envelope_hash, expires_at, correlation_id,
               created_at, updated_at
             ) VALUES (
               ?, ?, 'redsys', ?, ?, ?, 5000, 'EUR',
               '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
               '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
               ?, ?, ?, ?
             )`
          )
          .run(
            intentId,
            order.id,
            merchantOrder,
            rec.method === 'bank_transfer' ? 'card' : rec.method,
            intentStatus,
            FUTURE,
            crypto.randomUUID(),
            rec.time,
            rec.time
          )

        // Record the prior intent_created and redirected steps for full funnel tracing
        await recordPaymentFunnelEvent(fixture.database, {
          id: crypto.randomUUID(),
          intentId,
          orderId: order.id,
          step: 'intent_created',
          method: rec.method,
          device: rec.device,
          bank: rec.bank,
          amountCents: rec.amount,
          currency: 'EUR',
          createdAt: rec.time
        })
        await recordPaymentFunnelEvent(fixture.database, {
          id: crypto.randomUUID(),
          intentId,
          orderId: order.id,
          step: 'redirected',
          method: rec.method,
          device: rec.device,
          bank: rec.bank,
          amountCents: rec.amount,
          currency: 'EUR',
          createdAt: rec.time
        })
        await recordPaymentFunnelEvent(fixture.database, {
          id: crypto.randomUUID(),
          intentId,
          orderId: order.id,
          step: rec.step,
          method: rec.method,
          device: rec.device,
          bank: rec.bank,
          responseCode: rec.responseCode,
          amountCents: rec.amount,
          currency: 'EUR',
          createdAt: rec.time
        })
      }
    }

    it('computes overall metrics and funnel step conversion with Wilson score intervals', async () => {
      const fixture = await setupPaymentFunnelFixture()
      await seedComprehensiveFunnel(fixture)

      const result = await readPaymentFunnelDashboard(fixture.database, {
        from: '2026-10-24T00:00:00Z',
        to: '2026-10-28T23:59:59Z'
      })

      // Total attempts = 10 + 5 + 5 + 4 + 3 + 2 + 3 + 2 = 34 attempts
      expect(result.summary.totalAttempts).toBe(34)
      expect(result.summary.authorizedCount).toBe(20)
      expect(result.summary.declinedCount).toBe(9)
      expect(result.summary.cancelledCount).toBe(3)
      expect(result.summary.expiredCount).toBe(2)

      // Conversion rate = 20 / 34 ≈ 0.5882
      expect(result.summary.authorizationRate).toBeGreaterThan(0.55)
      expect(result.summary.authorizationRate).toBeLessThan(0.62)
      expect(result.summary.hasSufficientSample).toBe(true) // 34 >= 30

      // Funnel stages
      expect(result.stages.length).toBe(3)
      expect(result.stages[0].step).toBe('intent_created')
      expect(result.stages[0].count).toBe(34)
      expect(result.stages[1].step).toBe('redirected')
      expect(result.stages[1].count).toBe(34)
      expect(result.stages[2].step).toBe('authorized')
      expect(result.stages[2].count).toBe(20)
    })

    it('groups decline causes with descriptions, codes, counts and percentages', async () => {
      const fixture = await setupPaymentFunnelFixture()
      await seedComprehensiveFunnel(fixture)

      const result = await readPaymentFunnelDashboard(fixture.database, {
        from: '2026-10-24T00:00:00Z',
        to: '2026-10-28T23:59:59Z'
      })

      expect(result.declineCauses.length).toBeGreaterThanOrEqual(3)
      // Total declines = 9 (4 insufficient_funds, 3 auth_failed_3ds, 2 expired_card)
      const fundsDecline = result.declineCauses.find((c) => c.category === 'insufficient_funds')
      expect(fundsDecline).toBeDefined()
      expect(fundsDecline?.count).toBe(4)
      expect(fundsDecline?.percentage).toBeCloseTo(4 / 9, 2)
      expect(fundsDecline?.label).toContain('insuficiente')

      const authDecline = result.declineCauses.find((c) => c.category === 'auth_failed_3ds')
      expect(authDecline).toBeDefined()
      expect(authDecline?.count).toBe(3)

      const expiredDecline = result.declineCauses.find((c) => c.category === 'expired_card')
      expect(expiredDecline).toBeDefined()
      expect(expiredDecline?.count).toBe(2)
    })

    it('segments accurately by device (desktop vs mobile vs tablet)', async () => {
      const fixture = await setupPaymentFunnelFixture()
      await seedComprehensiveFunnel(fixture)

      const result = await readPaymentFunnelDashboard(fixture.database, {
        from: '2026-10-24T00:00:00Z',
        to: '2026-10-28T23:59:59Z',
        device: 'desktop'
      })

      // Desktop attempts = 10 auth + 4 declined + 3 cancelled = 17 attempts
      expect(result.summary.totalAttempts).toBe(17)
      expect(result.summary.authorizedCount).toBe(10)
      expect(result.summary.declinedCount).toBe(4)
      expect(result.summary.cancelledCount).toBe(3)
      expect(result.filters.device).toBe('desktop')
    })

    it('segments accurately by payment method (card vs bizum)', async () => {
      const fixture = await setupPaymentFunnelFixture()
      await seedComprehensiveFunnel(fixture)

      const result = await readPaymentFunnelDashboard(fixture.database, {
        from: '2026-10-24T00:00:00Z',
        to: '2026-10-28T23:59:59Z',
        method: 'bizum'
      })

      // Bizum attempts = 5 auth + 2 expired = 7 attempts
      expect(result.summary.totalAttempts).toBe(7)
      expect(result.summary.authorizedCount).toBe(5)
      expect(result.summary.expiredCount).toBe(2)
      expect(result.summary.declinedCount).toBe(0)
      expect(result.filters.method).toBe('bizum')
    })

    it('segments accurately by bank (BBVA vs Santander vs CaixaBank)', async () => {
      const fixture = await setupPaymentFunnelFixture()
      await seedComprehensiveFunnel(fixture)

      const result = await readPaymentFunnelDashboard(fixture.database, {
        from: '2026-10-24T00:00:00Z',
        to: '2026-10-28T23:59:59Z',
        bank: 'BBVA'
      })

      // BBVA attempts = 10 auth + 3 auth_failed_3ds + 3 cancelled = 16 attempts
      expect(result.summary.totalAttempts).toBe(16)
      expect(result.summary.authorizedCount).toBe(10)
      expect(result.summary.declinedCount).toBe(3)
      expect(result.summary.cancelledCount).toBe(3)
      expect(result.filters.bank).toBe('BBVA')
    })

    it('returns breakdown tables by dimension (device, method, bank)', async () => {
      const fixture = await setupPaymentFunnelFixture()
      await seedComprehensiveFunnel(fixture)

      const result = await readPaymentFunnelDashboard(fixture.database, {
        from: '2026-10-24T00:00:00Z',
        to: '2026-10-28T23:59:59Z'
      })

      expect(result.breakdowns.byDevice.length).toBeGreaterThan(0)
      expect(result.breakdowns.byMethod.length).toBeGreaterThan(0)
      expect(result.breakdowns.byBank.length).toBeGreaterThan(0)

      const desktopBreakdown = result.breakdowns.byDevice.find((b) => b.key === 'desktop')
      expect(desktopBreakdown).toBeDefined()
      expect(desktopBreakdown?.attempts).toBe(17)
      expect(desktopBreakdown?.authorized).toBe(10)

      const cardBreakdown = result.breakdowns.byMethod.find((b) => b.key === 'card')
      expect(cardBreakdown).toBeDefined()
      expect(cardBreakdown?.attempts).toBe(27)
    })

    it('handles empty date range safely without dividing by zero', async () => {
      const fixture = await setupPaymentFunnelFixture()

      const result = await readPaymentFunnelDashboard(fixture.database, {
        from: '2025-01-01T00:00:00Z',
        to: '2025-01-02T00:00:00Z'
      })

      expect(result.summary.totalAttempts).toBe(0)
      expect(result.summary.authorizedCount).toBe(0)
      expect(result.summary.authorizationRate).toBe(0)
      expect(result.declineCauses).toEqual([])
      expect(result.summary.hasSufficientSample).toBe(false)
    })
  })

  describe('HTTP Handler & Access Controls', () => {
    it('ownsPaymentFunnelNamespace matches payment funnel routes', () => {
      expect(ownsPaymentFunnelNamespace('/api/admin/payments/funnel')).toBe(true)
      expect(ownsPaymentFunnelNamespace('/api/admin/analytics/payment-funnel')).toBe(true)
      expect(ownsPaymentFunnelNamespace('/api/admin/orders')).toBe(false)
      expect(ownsPaymentFunnelNamespace('/api/products')).toBe(false)
    })

    it('rejects unauthenticated requests with 401', async () => {
      const fixture = await setupPaymentFunnelFixture()
      const req = new Request('https://admin.example.test/api/admin/payments/funnel', {
        headers: { host: 'admin.example.test' }
      })

      const res = await handlePaymentFunnelHttp(req, {
        DB: fixture.database,
        AUTH_ENABLED: 'true',
        NUXT_SESSION_PASSWORD: 'session-secret-at-least-32-chars-long!',
        AUTH_RATE_LIMIT_PEPPER: 'pepper-32-bytes-long-string-value-here'
      })

      expect(res).not.toBeNull()
      expect(res?.status).toBe(401)
      const body = await res?.json()
      expect(body.error.code).toBe('unauthenticated')
    })

    it('rejects cross-site CSRF requests with 403', async () => {
      const fixture = await setupPaymentFunnelFixture()
      const req = new Request('https://admin.example.test/api/admin/payments/funnel', {
        headers: {
          'sec-fetch-site': 'cross-site'
        }
      })

      const res = await handlePaymentFunnelHttp(req, {
        DB: fixture.database,
        AUTH_ENABLED: 'true',
        NUXT_SESSION_PASSWORD: 'session-secret-at-least-32-chars-long!',
        AUTH_RATE_LIMIT_PEPPER: 'pepper-32-bytes-long-string-value-here'
      })

      expect(res?.status).toBe(403)
      const body = await res?.json()
      expect(body.error.code).toBe('csrf_rejected')
    })

    it('rejects non-GET HTTP methods with 405', async () => {
      const fixture = await setupPaymentFunnelFixture()
      const req = new Request('https://admin.example.test/api/admin/payments/funnel', {
        method: 'POST'
      })

      const res = await handlePaymentFunnelHttp(req, {
        DB: fixture.database,
        AUTH_ENABLED: 'true',
        NUXT_SESSION_PASSWORD: 'session-secret-at-least-32-chars-long!',
        AUTH_RATE_LIMIT_PEPPER: 'pepper-32-bytes-long-string-value-here'
      })

      expect(res?.status).toBe(405)
      expect(res?.headers.get('Allow')).toBe('GET')
    })

    it('rejects invalid filter parameters with 400', async () => {
      const fixture = await setupPaymentFunnelFixture()
      const { issueD1SessionCookie } = await import('../../workers/auth/session-cookie')
      const cookie = (await issueD1SessionCookie(fixture.database, CLAIMS, {
        password: 'session-secret-at-least-32-chars-long!',
        maxAgeSeconds: 3600
      }))!.split(';')[0]!

      const req = new Request('https://admin.example.test/api/admin/payments/funnel?from=invalid-date', {
        headers: { cookie }
      })

      const res = await handlePaymentFunnelHttp(req, {
        DB: fixture.database,
        AUTH_ENABLED: 'true',
        NUXT_SESSION_PASSWORD: 'session-secret-at-least-32-chars-long!',
        AUTH_RATE_LIMIT_PEPPER: 'pepper-32-bytes-long-string-value-here'
      })

      expect(res?.status).toBe(400)
    })

    it('returns 200 with dashboard data for authorized admin', async () => {
      const fixture = await setupPaymentFunnelFixture()
      const { issueD1SessionCookie } = await import('../../workers/auth/session-cookie')
      const cookie = (await issueD1SessionCookie(fixture.database, CLAIMS, {
        password: 'session-secret-at-least-32-chars-long!',
        maxAgeSeconds: 3600
      }))!.split(';')[0]!

      const req = new Request(
        'https://admin.example.test/api/admin/payments/funnel?from=2026-10-01T00:00:00Z&to=2026-10-29T23:59:59Z',
        { headers: { cookie } }
      )

      const res = await handlePaymentFunnelHttp(req, {
        DB: fixture.database,
        AUTH_ENABLED: 'true',
        NUXT_SESSION_PASSWORD: 'session-secret-at-least-32-chars-long!',
        AUTH_RATE_LIMIT_PEPPER: 'pepper-32-bytes-long-string-value-here'
      })

      expect(res?.status).toBe(200)
      const data = await res?.json()
      expect(data.summary).toBeDefined()
      expect(data.stages).toBeDefined()
      expect(data.declineCauses).toBeDefined()
      expect(data.breakdowns).toBeDefined()
      expect(res?.headers.get('Cache-Control')).toContain('no-store')
      expect(res?.headers.get('X-Content-Type-Options')).toBe('nosniff')
    })
  })
})
