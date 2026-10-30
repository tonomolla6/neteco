import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listPublicUgcReviews,
  moderateUgcReview,
  submitUgcReview,
  withdrawUgcReview,
  UgcReviewError
} from '../../workers/media/ugc-reviews'
import {
  ADMIN_IDENTITY,
  CUSTOMER_IDENTITY,
  NOW,
  OTHER_IDENTITY,
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

const code = (e: unknown) => (e instanceof UgcReviewError ? e.code : `unknown:${String(e)}`)
const fails = (p: Promise<unknown>) => p.then(() => 'resolved', code)

const EICAR_BASE64 = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*').toString(
  'base64'
)

describe('MED-018: D1 UGC Reviews with Photos, Antivirus & Moderation', () => {
  it('submits a valid review with clean photo, consent and no incentives', async () => {
    const res = await submitUgcReview(world.db, {
      actorId: CUSTOMER_IDENTITY,
      now: NOW,
      input: {
        productId: PROD_1,
        orderId: ORDER_1,
        rating: 5,
        title: 'Excelente limpiador industrial',
        content: 'Limpia de manera impecable maquinaria pesada sin dejar residuos grasos.',
        displayName: 'Taller Mecánico Paco',
        consentAccepted: true,
        consentVersion: '2026-ugc-v1',
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: false,
        incentiveType: 'none',
        photos: [
          {
            storageKey: 'ugc/reviews/r1/clean.png',
            photoUrl: 'https://media.neteco.es/ugc/reviews/r1/clean.png',
            mimeType: 'image/png',
            fileSizeBytes: 1024,
            sha256: 'a'.repeat(64),
            width: 800,
            height: 600
          }
        ],
        commandId: 'cmd-sub-1'
      }
    })

    expect(res.id).toBeDefined()
    expect(res.productId).toBe(PROD_1)
    expect(res.rating).toBe(5)
    expect(res.moderationStatus).toBe('pending')
    expect(res.isVerifiedBuyer).toBe(true) // Matches seeded order
    expect(res.photos).toHaveLength(1)
    expect(res.photos[0].antivirusStatus).toBe('clean')
  })

  it('detects malware infected photo upload and quarantines review', async () => {
    const res = await submitUgcReview(world.db, {
      actorId: CUSTOMER_IDENTITY,
      now: NOW,
      input: {
        productId: PROD_1,
        rating: 4,
        title: 'Producto con foto extraña',
        content: 'Adjunto foto del resultado tras aplicar el producto.',
        displayName: 'Usuario Test',
        consentAccepted: true,
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: false,
        photos: [
          {
            storageKey: 'ugc/reviews/r-mal/eicar.png',
            photoUrl: 'https://media.neteco.es/ugc/reviews/r-mal/eicar.png',
            mimeType: 'image/png',
            fileSizeBytes: 2048,
            sha256: 'b'.repeat(64),
            width: 400,
            height: 400,
            base64Data: EICAR_BASE64
          }
        ],
        commandId: 'cmd-sub-mal'
      }
    })

    expect(res.moderationStatus).toBe('quarantined')
    expect(res.photos[0].antivirusStatus).toBe('infected')
    expect(res.photos[0].moderationStatus).toBe('quarantined')
  })

  it('scans and flags PII in submitted content', async () => {
    const res = await submitUgcReview(world.db, {
      actorId: CUSTOMER_IDENTITY,
      now: NOW,
      input: {
        productId: PROD_1,
        rating: 5,
        title: 'Buen servicio',
        content: 'Para más dudas podéis contactarme al 612345678 o soporte@taller.es.',
        displayName: 'Carlos',
        consentAccepted: true,
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: false,
        commandId: 'cmd-sub-pii'
      }
    })

    expect(res.piiDetected).toBe(true)
    expect(res.piiDetails.length).toBeGreaterThanOrEqual(2)
    expect(res.piiRedactedContent).toContain('[TELÉFONO REDACTADO]')
    expect(res.piiRedactedContent).toContain('[EMAIL REDACTADO]')
  })

  it('flags review for hidden incentives when user declares none but text references rewards', async () => {
    const res = await submitUgcReview(world.db, {
      actorId: CUSTOMER_IDENTITY,
      now: NOW,
      input: {
        productId: PROD_1,
        rating: 5,
        title: 'Regalo recibido',
        content: 'Me dieron este producto gratis a cambio de poner 5 estrellas en una reseña.',
        displayName: 'Cliente Recompensado',
        consentAccepted: true,
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: false,
        commandId: 'cmd-sub-hidden-inc'
      }
    })

    expect(res.hiddenIncentiveSuspected).toBe(true)
  })

  it('enforces idempotency on replayed submission commands', async () => {
    const input = {
      productId: PROD_1,
      rating: 5,
      title: 'Review Idempotente',
      content: 'Contenido consistente de prueba de idempotencia garantizada.',
      displayName: 'Empresa Test',
      consentAccepted: true as const,
      consentVersion: '2026-ugc-v1',
      licenseTerms: 'royalty_free_commercial_display' as const,
      rightsConfirmed: true as const,
      hasIncentive: false,
      incentiveType: 'none' as const,
      photos: [],
      commandId: 'cmd-idemp-1'
    }

    const first = await submitUgcReview(world.db, { actorId: CUSTOMER_IDENTITY, now: NOW, input })
    const second = await submitUgcReview(world.db, { actorId: CUSTOMER_IDENTITY, now: NOW, input })

    expect(first.id).toBe(second.id)

    // Differing payload with same commandId throws idempotency_conflict
    const conflict = fails(
      submitUgcReview(world.db, {
        actorId: CUSTOMER_IDENTITY,
        now: NOW,
        input: { ...input, rating: 1 }
      })
    )
    expect(await conflict).toBe('idempotency_conflict')
  })

  it('allows live admin to moderate and approve a review with CAS verification', async () => {
    const created = await submitUgcReview(world.db, {
      actorId: CUSTOMER_IDENTITY,
      now: NOW,
      input: {
        productId: PROD_1,
        rating: 5,
        title: 'Para moderar',
        content: 'Excelente poder desengrasante para mantenimiento de motores.',
        displayName: 'Taller',
        consentAccepted: true,
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: false,
        photos: [
          {
            storageKey: 'ugc/p1.png',
            photoUrl: 'https://media.neteco.es/ugc/p1.png',
            mimeType: 'image/png',
            fileSizeBytes: 1024,
            sha256: 'c'.repeat(64),
            width: 800,
            height: 600
          }
        ],
        commandId: 'cmd-mod-sub'
      }
    })

    // Non-admin cannot moderate
    const nonAdminFails = fails(
      moderateUgcReview(world.db, {
        actorId: OTHER_IDENTITY,
        now: NOW,
        input: {
          reviewId: created.id,
          action: 'approve',
          reason: 'Aprobado sin permisos',
          expectedVersion: created.version,
          commandId: 'cmd-mod-fail'
        }
      })
    )
    expect(await nonAdminFails).toBe('forbidden')

    // Mismatched version throws version_conflict
    const versionMismatch = fails(
      moderateUgcReview(world.db, {
        actorId: ADMIN_IDENTITY,
        now: NOW,
        input: {
          reviewId: created.id,
          action: 'approve',
          reason: 'Aprobado',
          expectedVersion: 999, // wrong version
          commandId: 'cmd-mod-cas-err'
        }
      })
    )
    expect(await versionMismatch).toBe('version_conflict')

    // Admin successfully approves
    const approved = await moderateUgcReview(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        reviewId: created.id,
        action: 'approve',
        reason: 'Contenido técnico y fotos verificadas',
        expectedVersion: created.version,
        photoModerations: [
          {
            photoId: created.photos[0].id,
            action: 'approve',
            reason: 'Foto clara y limpia'
          }
        ],
        commandId: 'cmd-mod-ok'
      }
    })

    expect(approved.moderationStatus).toBe('approved')
    expect(approved.version).toBe(created.version + 1)

    // Now it appears in public reviews!
    const publicList = await listPublicUgcReviews(world.db, { productId: PROD_1 })
    expect(publicList.reviews.some((r) => r.id === created.id)).toBe(true)
    expect(publicList.reviews[0].photos).toHaveLength(1)
  })

  it('allows customer or admin to withdraw a review (retirada / derecho de revocación)', async () => {
    const created = await submitUgcReview(world.db, {
      actorId: CUSTOMER_IDENTITY,
      now: NOW,
      input: {
        productId: PROD_1,
        rating: 4,
        title: 'Review a retirar',
        content: 'Buena calidad general, cumple con las especificaciones técnicas.',
        displayName: 'Cliente Arrepentido',
        consentAccepted: true,
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: false,
        commandId: 'cmd-with-sub'
      }
    })

    // Third party cannot withdraw customer's review
    const thirdPartyFails = fails(
      withdrawUgcReview(world.db, {
        actorId: OTHER_IDENTITY,
        now: NOW,
        input: {
          reviewId: created.id,
          reason: 'customer_revocation',
          expectedVersion: created.version,
          commandId: 'cmd-with-err'
        }
      })
    )
    expect(await thirdPartyFails).toBe('forbidden')

    // Author customer withdraws
    const withdrawn = await withdrawUgcReview(world.db, {
      actorId: CUSTOMER_IDENTITY,
      now: NOW,
      input: {
        reviewId: created.id,
        reason: 'customer_revocation',
        notes: 'Cliente retira consentimiento de publicación',
        expectedVersion: created.version,
        commandId: 'cmd-with-ok'
      }
    })

    expect(withdrawn.moderationStatus).toBe('withdrawn')

    // Public list never shows withdrawn reviews
    const publicList = await listPublicUgcReviews(world.db, { productId: PROD_1 })
    expect(publicList.reviews.some((r) => r.id === created.id)).toBe(false)
  })
})
