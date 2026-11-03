/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON/fetch doubles in tests */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleUgcReviewsHttp, ownsUgcReviewsNamespace } from '../../workers/media/ugc-reviews-http'
import {
  ADMIN_IDENTITY,
  CUSTOMER_IDENTITY,
  NOW,
  PROD_1,
  ORDER_1,
  createUgcCaseWorld,
  type UgcCaseWorld
} from './ugc-case-fixture'

let world: UgcCaseWorld
beforeEach(async () => {
  world = await createUgcCaseWorld()
})
afterEach(() => world.close())

const deps = (actorId: string | null = null) => ({
  database: world.db,
  sessionProvider: async () => (actorId ? { identityId: actorId } : null),
  now: () => NOW
})

describe('MED-018: UGC Reviews HTTP Endpoints', () => {
  it('owns correct namespaces and ignores foreign paths', () => {
    expect(ownsUgcReviewsNamespace('/api/products/p1/ugc-reviews')).toBe(true)
    expect(ownsUgcReviewsNamespace('/api/ugc-reviews/rev-1/withdraw')).toBe(true)
    expect(ownsUgcReviewsNamespace('/api/admin/ugc-reviews')).toBe(true)
    expect(ownsUgcReviewsNamespace('/api/admin/ugc-reviews/rev-1/moderate')).toBe(true)
    expect(ownsUgcReviewsNamespace('/api/admin/orders')).toBe(false)
    expect(ownsUgcReviewsNamespace('/api/case-studies')).toBe(false)
  })

  it('handles public GET for product ugc reviews (empty initially)', async () => {
    const req = new Request(`https://neteco.es/api/products/${PROD_1}/ugc-reviews`, {
      method: 'GET'
    })
    const res = await handleUgcReviewsHttp(req, deps())
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)

    const data = (await res!.json()) as any
    expect(data.reviews).toEqual([])
    expect(data.total).toBe(0)
  })

  it('rejects POST submission without authentication with 401', async () => {
    const req = new Request(`https://neteco.es/api/products/${PROD_1}/ugc-reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://neteco.es' },
      body: JSON.stringify({
        rating: 5,
        title: 'Review no autenticada',
        content: 'Excelente producto químico para limpieza de motores.',
        displayName: 'Anonimo',
        consentAccepted: true,
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: false,
        commandId: 'cmd-http-unauth'
      })
    })

    const res = await handleUgcReviewsHttp(req, deps(null))
    expect(res!.status).toBe(401)
    const body = (await res!.json()) as any
    expect(body.error.code).toBe('unauthorized')
  })

  it('submits a review, moderates it by admin, and serves it via public GET', async () => {
    // 1. Submit review
    const submitReq = new Request(`https://neteco.es/api/products/${PROD_1}/ugc-reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://neteco.es' },
      body: JSON.stringify({
        orderId: ORDER_1,
        rating: 5,
        title: 'Desengrase potente y rápido',
        content: 'Utilizado en taller de automoción con excelentes resultados en llantas.',
        displayName: 'Taller M.',
        consentAccepted: true,
        consentVersion: '2026-ugc-v1',
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: false,
        photos: [
          {
            storageKey: 'ugc/http/p1.png',
            photoUrl: 'https://media.neteco.es/ugc/http/p1.png',
            mimeType: 'image/png',
            fileSizeBytes: 1024,
            sha256: '9'.repeat(64),
            width: 600,
            height: 400
          }
        ],
        commandId: 'cmd-http-sub-1'
      })
    })

    const submitRes = await handleUgcReviewsHttp(submitReq, deps(CUSTOMER_IDENTITY))
    expect(submitRes!.status).toBe(201)
    const reviewData = (await submitRes!.json()) as any
    expect(reviewData.moderationStatus).toBe('pending')

    // 2. Admin list
    const adminListReq = new Request('https://neteco.es/api/admin/ugc-reviews?status=pending', {
      method: 'GET'
    })
    const adminListRes = await handleUgcReviewsHttp(adminListReq, deps(ADMIN_IDENTITY))
    expect(adminListRes!.status).toBe(200)
    const adminListData = (await adminListRes!.json()) as any
    expect(adminListData.reviews.length).toBeGreaterThanOrEqual(1)

    // 3. Admin moderate (approve)
    const modReq = new Request(`https://neteco.es/api/admin/ugc-reviews/${reviewData.id}/moderate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://neteco.es' },
      body: JSON.stringify({
        action: 'approve',
        reason: 'Texto técnico verificado',
        expectedVersion: reviewData.version,
        commandId: 'cmd-http-mod-1'
      })
    })
    const modRes = await handleUgcReviewsHttp(modReq, deps(ADMIN_IDENTITY))
    expect(modRes!.status).toBe(200)

    // 4. Public list now returns the approved review
    const publicReq = new Request(`https://neteco.es/api/products/${PROD_1}/ugc-reviews`, {
      method: 'GET'
    })
    const publicRes = await handleUgcReviewsHttp(publicReq, deps())
    expect(publicRes!.status).toBe(200)
    const publicData = (await publicRes!.json()) as any
    expect(publicData.reviews.some((r: any) => r.id === reviewData.id)).toBe(true)
    expect(publicData.reviews[0].incentiveBadge).toBe('Compra verificada sin compensación')
  })

  it('allows author customer to withdraw their review', async () => {
    // Submit review first
    const submitReq = new Request(`https://neteco.es/api/products/${PROD_1}/ugc-reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://neteco.es' },
      body: JSON.stringify({
        rating: 4,
        title: 'Review a retirar por HTTP',
        content: 'Buen producto en general para limpieza general de superficies.',
        displayName: 'Cliente Retirada',
        consentAccepted: true,
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: false,
        commandId: 'cmd-http-sub-withdraw'
      })
    })
    const submitRes = await handleUgcReviewsHttp(submitReq, deps(CUSTOMER_IDENTITY))
    const reviewData = (await submitRes!.json()) as any

    // Withdraw review
    const withdrawReq = new Request(`https://neteco.es/api/ugc-reviews/${reviewData.id}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://neteco.es' },
      body: JSON.stringify({
        reason: 'customer_revocation',
        notes: 'Deseo retirar la reseña',
        expectedVersion: reviewData.version,
        commandId: 'cmd-http-withdraw-1'
      })
    })
    const withdrawRes = await handleUgcReviewsHttp(withdrawReq, deps(CUSTOMER_IDENTITY))
    expect(withdrawRes!.status).toBe(200)
    const withdrawnData = (await withdrawRes!.json()) as any
    expect(withdrawnData.moderationStatus).toBe('withdrawn')
  })

  it('rejects non-admin access to admin moderation list with 403', async () => {
    const req = new Request('https://neteco.es/api/admin/ugc-reviews', { method: 'GET' })
    const res = await handleUgcReviewsHttp(req, deps(CUSTOMER_IDENTITY))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('ignores spoofed x-user-identity header without session credentials', async () => {
    const req = new Request('https://neteco.es/api/admin/ugc-reviews', {
      method: 'GET',
      headers: { 'x-user-identity': ADMIN_IDENTITY }
    })
    const res = await handleUgcReviewsHttp(req, {
      database: world.db,
      now: () => NOW
    } as any)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
  })
})
