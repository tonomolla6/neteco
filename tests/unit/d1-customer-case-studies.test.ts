/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed doubles in tests */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createCaseStudy,
  getPublicCaseStudyBySlug,
  listAdminCaseStudies,
  listPublicCaseStudies,
  performPeriodicReview,
  publishCaseStudy,
  CaseStudyError
} from '../../workers/cms/customer-case-studies'
import { ADMIN_IDENTITY, NOW, OTHER_IDENTITY, createUgcCaseWorld, type UgcCaseWorld } from './ugc-case-fixture'

let world: UgcCaseWorld
beforeEach(async () => {
  world = await createUgcCaseWorld()
})
afterEach(() => world.close())

const code = (e: unknown) => (e instanceof CaseStudyError ? e.code : `unknown:${String(e)}`)
const fails = (p: Promise<unknown>) => p.then(() => 'resolved', code)

const validCaseInput = {
  title: 'Optimización de lavado en Hostelería Costa',
  subtitle: 'Reducción del 28% de consumo y eliminación de depósitos calcáreos',
  slug: 'optimizacion-lavado-hosteleria-costa',
  signedPermission: {
    signerName: 'Mario Ruiz',
    signerRole: 'Gerente de Mantenimiento',
    companyName: 'Hostelería Costa Brava S.L.',
    companyCif: 'B12345678',
    documentRef: 'DOC-AUTH-2026-COSTA-01',
    documentSha256: 'd'.repeat(64),
    signedAt: '2026-03-01T10:00:00Z',
    scope: 'full_case_study_and_metrics',
    publishAuthorized: true
  },
  context: {
    sector: 'Hostelería y Restauración',
    facilityDescription: '3 restaurantes con tren de lavado de vajilla continuo',
    initialSituation: 'Pérdida de brillo en cristalería y atasco continuo de boquillas por dureza del agua.',
    baselineMetrics: [{ metric: 'Cristalería desechada', value: 120, unit: 'copas/semana' }]
  },
  solution: {
    netecoProducts: ['NET-LAVAVAJILLAS-ECO', 'NET-ABRILLANTADOR-PRO'],
    dosageProtocol: 'Dosificación electrónica por conductividad a 2.8 ml/L con agua osmotizada',
    implementationDurationWeeks: 2,
    solutionSummary: 'Instalación de bombas peristálticas automáticas y ajuste fino de abrillantador neutro.'
  },
  verifiableOutcome: {
    outcomeMetrics: [
      {
        metric: 'Reducción de rotura de cristalería',
        before: 120,
        after: 12,
        unit: 'copas/semana',
        improvementPercent: 90.0
      }
    ],
    verificationMethod: 'Registro de mermas mensual contrastado con compras de menaje',
    verifierIdentity: 'Auditoría Técnica Interna Costa Brava',
    certificateRef: 'AUD-CB-2026-04',
    evidenceSha256: 'c'.repeat(64)
  },
  reviewIntervalMonths: 12 as const,
  coverImageUrl: 'https://media.neteco.es/cases/costa-cover.webp',
  commandId: 'cmd-create-case-1'
}

describe('MED-020 & MKT-031: Customer Case Studies & Authorized Success Stories in D1', () => {
  it('creates a draft case study with signed permission and verifiable evidence', async () => {
    const res = await createCaseStudy(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: validCaseInput
    })

    expect(res.id).toBeDefined()
    expect(res.slug).toBe(validCaseInput.slug)
    expect(res.publicationStatus).toBe('draft')
    expect(res.reviewStatus).toBe('current')
    expect(res.nextReviewDueAt).toBe('2027-10-29T10:00:00Z') // +12 months from NOW
    expect(res.version).toBe(1)
  })

  it('rejects creation if non-admin attempts to create case study', async () => {
    const res = fails(
      createCaseStudy(world.db, {
        actorId: OTHER_IDENTITY,
        now: NOW,
        input: { ...validCaseInput, commandId: 'cmd-unauth-1' }
      })
    )
    expect(await res).toBe('forbidden')
  })

  it('rejects payloads attempting to attach community comments or social profiles (MKT-031)', async () => {
    const res = fails(
      createCaseStudy(world.db, {
        actorId: ADMIN_IDENTITY,
        now: NOW,
        input: {
          ...validCaseInput,
          comments: [{ text: 'Comentario no permitido' }],
          commandId: 'cmd-social-err'
        } as any
      })
    )
    expect(await res).toBe('community_features_forbidden')
  })

  it('publishes case study when customer has authorized publication and review is current', async () => {
    const created = await createCaseStudy(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: validCaseInput
    })

    const published = await publishCaseStudy(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        caseId: created.id,
        expectedVersion: created.version,
        commandId: 'cmd-pub-1'
      }
    })

    expect(published.publicationStatus).toBe('published')
    expect(published.publishedAt).toBe(NOW)

    // Verify it is accessible via public read-only API
    const publicList = await listPublicCaseStudies(world.db, { now: NOW })
    expect(publicList.cases.some((c) => c.slug === validCaseInput.slug)).toBe(true)

    const single = await getPublicCaseStudyBySlug(world.db, validCaseInput.slug, NOW)
    expect(single.title).toBe(validCaseInput.title)
    expect(single.permissionCompanyName).toBe('Hostelería Costa Brava S.L.')
    expect(single.outcomeMetrics[0].improvementPercent).toBe(90.0)

    // Strict no community verification on public DTO:
    expect((single as any).comments).toBeUndefined()
    expect((single as any).socialProfile).toBeUndefined()
  })

  it('blocks publication if customer did not authorize publication', async () => {
    const created = await createCaseStudy(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        ...validCaseInput,
        slug: 'sin-autorizacion',
        signedPermission: {
          ...validCaseInput.signedPermission,
          publishAuthorized: false // Customer did not authorize public release
        },
        commandId: 'cmd-noauth-create'
      }
    })

    const pubFail = fails(
      publishCaseStudy(world.db, {
        actorId: ADMIN_IDENTITY,
        now: NOW,
        input: {
          caseId: created.id,
          expectedVersion: created.version,
          commandId: 'cmd-pub-denied'
        }
      })
    )
    expect(await pubFail).toBe('publish_not_allowed')
  })

  it('enforces periodic review governance and hides overdue case studies from public listing', async () => {
    const created = await createCaseStudy(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        ...validCaseInput,
        slug: 'caso-con-revision',
        commandId: 'cmd-rev-create'
      }
    })

    await publishCaseStudy(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        caseId: created.id,
        expectedVersion: 1,
        commandId: 'cmd-pub-rev'
      }
    })

    // Advance time beyond next_review_due_at (+13 months)
    const futureTime = '2027-12-01T00:00:00Z'
    const publicFuture = await listPublicCaseStudies(world.db, { now: futureTime })
    // Must be suppressed from public view due to overdue review!
    expect(publicFuture.cases.some((c) => c.slug === 'caso-con-revision')).toBe(false)

    // Public detail throws not_found for overdue review
    const singleFutureFail = fails(getPublicCaseStudyBySlug(world.db, 'caso-con-revision', futureTime))
    expect(await singleFutureFail).toBe('not_found')

    // Admin performs periodic review and re-validates permission
    const currentCase = (await listAdminCaseStudies(world.db, {})).cases.find((c) => c.slug === 'caso-con-revision')!
    const reviewed = await performPeriodicReview(world.db, {
      actorId: ADMIN_IDENTITY,
      now: futureTime,
      input: {
        caseId: created.id,
        reviewNotes: 'Revisión técnica anual realizada con Mario Ruiz. Condiciones y métricas vigentes.',
        confirmedPermissionValid: true,
        nextReviewIntervalMonths: 12,
        expectedVersion: currentCase.version,
        commandId: 'cmd-exec-review'
      }
    })

    expect(reviewed.reviewStatus).toBe('current')
    expect(reviewed.nextReviewDueAt).toBe('2028-12-01T00:00:00Z')

    // Now it is public again!
    const publicAfterReview = await listPublicCaseStudies(world.db, { now: futureTime })
    expect(publicAfterReview.cases.some((c) => c.slug === 'caso-con-revision')).toBe(true)
  })
})
