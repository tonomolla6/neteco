import { describe, expect, it } from 'vitest'
import {
  calculateNextReviewDate,
  computeReviewGovernanceStatus,
  createCaseStudySchema,
  evaluatePublishReadiness,
  performPeriodicReviewSchema,
  validateStrictNoCommunityPayload
} from '../../shared/customer-case-studies'

describe('MED-020 & MKT-031: Customer Case Studies & Authorized Success Stories', () => {
  const validCaseStudy = {
    title: 'Descarbonización y reducción del 35% en costes de lavado en Lavanderías del Turia',
    subtitle: 'Optimización de dosis y eliminación de rechazos por incrustación calcárea en túnel continuo',
    slug: 'caso-lavanderias-turia-descarbonizacion',
    // Permiso firmado (Signed permission)
    signedPermission: {
      signerName: 'Elena Gómez Navarro',
      signerRole: 'Directora de Operaciones Industriales',
      companyName: 'Lavanderías Industriales del Turia S.L.',
      companyCif: 'B98765432',
      documentRef: 'DOC-AUTH-NETECO-2026-TURIA-01',
      documentSha256: 'e'.repeat(64),
      signedAt: '2026-05-10T10:00:00Z',
      scope: 'full_case_study_and_metrics',
      publishAuthorized: true
    },
    // Contexto (Context)
    context: {
      sector: 'Lavandería Industrial y Sanitaria',
      facilityDescription: 'Planta de 4.000m² con 2 túneles continuos de 50kg/h y 8 secadoras industriales',
      initialSituation:
        'Pérdidas continuas por manchas fijadas por calor e incrustación calcárea severa en aclarado final.',
      baselineMetrics: [
        { metric: 'Gasto mensual químico', value: 5800, unit: 'EUR/mes' },
        { metric: 'Tasa de rechazo en ropa blanca', value: 6.8, unit: '%' }
      ]
    },
    // Solución (Solution)
    solution: {
      netecoProducts: ['NET-LAV-OXIGEN-50', 'NET-LAV-ALCALINO-PRO', 'NET-ACID-NEUTRA'],
      dosageProtocol:
        'Dosificación peristáltica calibrada a 4.2 ml/kg en módulo alcalino a 58°C y neutralización con pH 6.2 en último baño.',
      implementationDurationWeeks: 3,
      solutionSummary:
        'Instalación de central de dosificación telemétrica con monitorización continua de conductividad y temperatura.'
    },
    // Resultado verificable (Verifiable outcome)
    verifiableOutcome: {
      outcomeMetrics: [
        {
          metric: 'Ahorro económico verificado',
          before: 5800,
          after: 3770,
          unit: 'EUR/mes',
          improvementPercent: 35.0
        },
        {
          metric: 'Tasa de rechazo en ropa blanca',
          before: 6.8,
          after: 0.4,
          unit: '%',
          improvementPercent: 94.1
        }
      ],
      verificationMethod:
        'Auditoría gravimétrica de blancura ISO 2267 y conciliación de consumo químico mensual certificado.',
      verifierIdentity: 'Instituto Tecnológico Textil Levante (Cert. AUD-TEX-9921)',
      certificateRef: 'CERT-TEXTIL-2026-08',
      evidenceSha256: 'f'.repeat(64)
    },
    // Revisión periódica (Periodic Governance Review)
    reviewIntervalMonths: 12 as const,
    coverImageUrl: 'https://media.neteco.es/cases/turia-cover.webp',
    commandId: 'cmd-case-001'
  }

  describe('Zod Schema Validation & Input Integrity', () => {
    it('accepts a fully configured case study with signed permission and verifiable metrics', () => {
      const parsed = createCaseStudySchema.safeParse(validCaseStudy)
      expect(parsed.success).toBe(true)
    })

    it('rejects case study if signed permission is missing mandatory CIF or document hash', () => {
      const invalid = {
        ...validCaseStudy,
        signedPermission: {
          ...validCaseStudy.signedPermission,
          companyCif: '', // missing CIF
          documentSha256: 'invalid-hash' // not 64 hex chars
        }
      }

      const res = createCaseStudySchema.safeParse(invalid)
      expect(res.success).toBe(false)
    })

    it('rejects case study with empty verifiable outcome metrics', () => {
      const invalid = {
        ...validCaseStudy,
        verifiableOutcome: {
          ...validCaseStudy.verifiableOutcome,
          outcomeMetrics: [] // empty metrics
        }
      }

      const res = createCaseStudySchema.safeParse(invalid)
      expect(res.success).toBe(false)
    })

    it('validates periodic review command input schema', () => {
      const reviewCmd = {
        caseId: 'case-turia-01',
        reviewNotes: 'Revisión anual completada con Elena Gómez. Datos vigentes sin cambios de contrato.',
        confirmedPermissionValid: true,
        nextReviewIntervalMonths: 12,
        expectedVersion: 1,
        commandId: 'cmd-rev-001'
      }

      const res = performPeriodicReviewSchema.safeParse(reviewCmd)
      expect(res.success).toBe(true)
    })
  })

  describe('Periodic Governance Review & Expiry Gate (MED-020)', () => {
    it('calculates next review due date accurately according to interval', () => {
      const lastReviewedAt = '2026-01-15T10:00:00Z'
      const next12Months = calculateNextReviewDate(lastReviewedAt, 12)
      expect(next12Months).toBe('2027-01-15T10:00:00Z')

      const next6Months = calculateNextReviewDate(lastReviewedAt, 6)
      expect(next6Months).toBe('2026-07-15T10:00:00Z')
    })

    it('computes review status as "current" when next review is well in the future', () => {
      const now = '2026-06-01T00:00:00Z'
      const nextDue = '2027-01-15T10:00:00Z'

      const status = computeReviewGovernanceStatus({ nextReviewDueAt: nextDue, now })
      expect(status).toBe('current')
    })

    it('computes review status as "due_soon" when next review is within 30 days', () => {
      const now = '2026-06-01T00:00:00Z'
      const nextDue = '2026-06-20T00:00:00Z' // 19 days away

      const status = computeReviewGovernanceStatus({ nextReviewDueAt: nextDue, now })
      expect(status).toBe('due_soon')
    })

    it('computes review status as "overdue" when next review due date has passed', () => {
      const now = '2026-06-01T00:00:00Z'
      const nextDue = '2026-05-30T00:00:00Z' // 2 days in the past

      const status = computeReviewGovernanceStatus({ nextReviewDueAt: nextDue, now })
      expect(status).toBe('overdue')
    })
  })

  describe('Publish Readiness Gate (MED-020 & MKT-031)', () => {
    it('allows publication when participant has signed permission and review is current', () => {
      const readiness = evaluatePublishReadiness({
        publishAuthorizedByCustomer: true,
        outcomeMetricsCount: 2,
        reviewStatus: 'current',
        signedDocumentSha256: 'e'.repeat(64)
      })

      expect(readiness.canPublish).toBe(true)
      expect(readiness.blockers).toHaveLength(0)
    })

    it('blocks publication if customer did not authorize publication', () => {
      const readiness = evaluatePublishReadiness({
        publishAuthorizedByCustomer: false,
        outcomeMetricsCount: 2,
        reviewStatus: 'current',
        signedDocumentSha256: 'e'.repeat(64)
      })

      expect(readiness.canPublish).toBe(false)
      expect(readiness.blockers).toContain('customer_authorization_required')
    })

    it('blocks publication if periodic review is overdue', () => {
      const readiness = evaluatePublishReadiness({
        publishAuthorizedByCustomer: true,
        outcomeMetricsCount: 2,
        reviewStatus: 'overdue',
        signedDocumentSha256: 'e'.repeat(64)
      })

      expect(readiness.canPublish).toBe(false)
      expect(readiness.blockers).toContain('review_overdue')
    })

    it('blocks publication if outcome metrics are missing', () => {
      const readiness = evaluatePublishReadiness({
        publishAuthorizedByCustomer: true,
        outcomeMetricsCount: 0,
        reviewStatus: 'current',
        signedDocumentSha256: 'e'.repeat(64)
      })

      expect(readiness.canPublish).toBe(false)
      expect(readiness.blockers).toContain('verifiable_outcomes_required')
    })
  })

  describe('Strict Anti-Social / No-Community Enforcement (MKT-031)', () => {
    it('rejects any payload attempting to attach community comments, ratings or social profiles', () => {
      const illegalPayloadWithComments = {
        ...validCaseStudy,
        comments: [{ author: 'User1', text: 'Gran caso!' }]
      }

      const validation = validateStrictNoCommunityPayload(illegalPayloadWithComments)
      expect(validation.isClean).toBe(false)
      expect(validation.violations).toContain('community_comments_forbidden')
    })

    it('rejects payloads attempting to attach user social profiles or follower counts', () => {
      const illegalPayloadWithSocial = {
        ...validCaseStudy,
        socialProfile: { twitter: '@empresa', followers: 5000 }
      }

      const validation = validateStrictNoCommunityPayload(illegalPayloadWithSocial)
      expect(validation.isClean).toBe(false)
      expect(validation.violations).toContain('social_profiles_forbidden')
    })

    it('passes verification when payload contains strictly professional editorial case study', () => {
      const validation = validateStrictNoCommunityPayload(validCaseStudy)
      expect(validation.isClean).toBe(true)
      expect(validation.violations).toHaveLength(0)
    })
  })
})
