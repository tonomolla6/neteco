import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleLearningCentreHttp, ownsLearningCentreNamespace } from '../../workers/learning/learning-centre-http'
import {
  handleTargetedCampaignsHttp,
  ownsTargetedCampaignsNamespace
} from '../../workers/marketing/targeted-campaigns-http'
import {
  handleRecurringIncentivesHttp,
  ownsRecurringIncentivesNamespace
} from '../../workers/b2b/recurring-incentives-http'
import {
  ADMIN_IDENTITY,
  COMPANY_ID_1,
  CUSTOMER_IDENTITY_1,
  NOW,
  createLearningCampaignsWorld,
  type LearningCampaignsWorld
} from './learning-campaigns-fixture'
import type { SessionCookieConfiguration } from '../../workers/auth/session-cookie'

const dummySessionConfig: SessionCookieConfiguration = {
  cookieName: 'neteco_session',
  password: 'test-session-password-at-least-32-chars-long!!',
  ttlSeconds: 3600
}

let world: LearningCampaignsWorld
beforeEach(async () => {
  world = await createLearningCampaignsWorld()
})
afterEach(() => world.close())

const adminClaims = {
  identityId: ADMIN_IDENTITY,
  customerId: null,
  sessionVersion: 1,
  roles: ['admin'],
  permissions: ['administration.manage']
}

const customerClaims = {
  identityId: CUSTOMER_IDENTITY_1,
  customerId: CUSTOMER_IDENTITY_1,
  sessionVersion: 1,
  roles: ['customer'],
  permissions: []
}

describe('MKT-033, MKT-035, MKT-036: HTTP API Endpoints', () => {
  it('owns expected URL namespaces correctly', () => {
    expect(ownsLearningCentreNamespace('/api/learning/courses')).toBe(true)
    expect(ownsLearningCentreNamespace('/api/admin/learning/courses')).toBe(true)
    expect(ownsLearningCentreNamespace('/api/other')).toBe(false)

    expect(ownsTargetedCampaignsNamespace('/api/customer/targeted-campaigns')).toBe(true)
    expect(ownsTargetedCampaignsNamespace('/api/admin/marketing/targeted-campaigns')).toBe(true)
    expect(ownsTargetedCampaignsNamespace('/api/other')).toBe(false)

    expect(ownsRecurringIncentivesNamespace('/api/b2b/recurring-incentives/my-overview')).toBe(true)
    expect(ownsRecurringIncentivesNamespace('/api/admin/b2b/recurring-incentives/agreements')).toBe(true)
    expect(ownsRecurringIncentivesNamespace('/api/other')).toBe(false)
  })

  it('handles learning centre HTTP: creates course and lists public courses', async () => {
    const deps = {
      database: world.db,
      sessionCookieConfiguration: dummySessionConfig,
      origin: 'https://neteco.es',
      claimsResolver: async () => adminClaims,
      now: () => NOW
    }

    // Admin creates course
    const reqCreate = new Request('https://neteco.es/api/admin/learning/courses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Manejo Seguro de Químicos y FDS',
        slug: 'manejo-seguro-quimicos-fds',
        description: 'Curso sobre interpretación de etiquetas SGA y fichas de seguridad.',
        category: 'chemical_safety',
        targetSector: 'lavanderia_industrial',
        estimatedDurationMinutes: 45,
        passingScorePercent: 80
      })
    })

    const resCreate = await handleLearningCentreHttp(reqCreate, deps)
    expect(resCreate?.status).toBe(201)
    const dataCreate = await resCreate?.json()
    expect(dataCreate.course.slug).toBe('manejo-seguro-quimicos-fds')

    // Public lists courses
    const reqList = new Request('https://neteco.es/api/learning/courses', { method: 'GET' })
    const resList = await handleLearningCentreHttp(reqList, deps)
    expect(resList?.status).toBe(200)
    const dataList = await resList?.json()
    expect(dataList.courses.length).toBeGreaterThan(0)
    expect(dataList.courses[0].slug).toBe('manejo-seguro-quimicos-fds')
  })

  it('handles targeted marketing campaigns HTTP: creates, retrieves reporting and customer offers', async () => {
    const adminDeps = {
      database: world.db,
      sessionCookieConfiguration: dummySessionConfig,
      origin: 'https://neteco.es',
      claimsResolver: async () => adminClaims,
      now: () => NOW
    }

    // Admin creates campaign
    const reqCreate = new Request('https://neteco.es/api/admin/marketing/targeted-campaigns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'camp-http-test-2026',
        name: 'Campaña Sectorial Lavanderías',
        description: '15% de descuento en peróxidos industriales',
        targetType: 'sector',
        targetId: 'lavanderia_industrial',
        tariffType: 'percentage_discount',
        discountPercent: 15,
        minOrderNetCents: 10000,
        marginFloorBasisPoints: 1500,
        startAt: '2026-10-01T00:00:00Z',
        endAt: '2026-12-31T23:59:59Z',
        status: 'active'
      })
    })
    const resCreate = await handleTargetedCampaignsHttp(reqCreate, adminDeps)
    expect(resCreate?.status).toBe(201)
    const dataCreate = await resCreate?.json()
    expect(dataCreate.campaign.code).toBe('camp-http-test-2026')

    // Customer with active consent fetches offers
    const custDeps = {
      database: world.db,
      sessionCookieConfiguration: dummySessionConfig,
      origin: 'https://neteco.es',
      claimsResolver: async () => customerClaims,
      now: () => NOW
    }
    const reqCust = new Request('https://neteco.es/api/customer/targeted-campaigns', { method: 'GET' })
    const resCust = await handleTargetedCampaignsHttp(reqCust, custDeps)
    expect(resCust?.status).toBe(200)
    const dataCust = await resCust?.json()
    expect(dataCust.campaigns.length).toBeGreaterThan(0)
    expect(dataCust.campaigns[0].code).toBe('camp-http-test-2026')
  })

  it('handles recurring B2B incentives HTTP: creates agreement, evaluates settlement and approves credit note', async () => {
    const adminDeps = {
      database: world.db,
      sessionCookieConfiguration: dummySessionConfig,
      origin: 'https://neteco.es',
      claimsResolver: async () => adminClaims,
      now: () => NOW
    }

    // Create agreement
    const reqAgr = new Request('https://neteco.es/api/admin/b2b/recurring-incentives/agreements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        companyId: COMPANY_ID_1,
        contractRef: 'CTR-HTTP-TURIA-2026',
        contractTermsVersion: '2026.1',
        contractSignedAt: '2026-01-01T00:00:00Z',
        periodFrequency: 'quarterly',
        volumeTiers: [{ minVolumeCents: 500000, rebatePercentBasisPoints: 300 }],
        minGrossMarginBasisPoints: 2000,
        slaPunctualPaymentRequired: true,
        slaMinAvgOrderNetCents: 20000,
        slaEinvoiceRequired: true,
        fiscalNotes: 'Rappel comercial regulado conforme Art. 80 Ley 37/1992 del IVA.'
      })
    })
    const resAgr = await handleRecurringIncentivesHttp(reqAgr, adminDeps)
    expect(resAgr?.status).toBe(201)
    const dataAgr = await resAgr?.json()
    expect(dataAgr.agreement.contractRef).toBe('CTR-HTTP-TURIA-2026')

    // Evaluate settlement
    const reqEval = new Request('https://neteco.es/api/admin/b2b/recurring-incentives/settlements/evaluate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agreementId: dataAgr.agreement.id,
        settlementPeriod: '2026-Q3',
        periodStart: '2026-07-01T00:00:00Z',
        periodEnd: '2026-09-30T23:59:59Z',
        marginAchievedBasisPoints: 2500,
        slaPaymentMet: true,
        slaOrderSizeMet: true,
        slaEinvoiceMet: true
      })
    })
    const resEval = await handleRecurringIncentivesHttp(reqEval, adminDeps)
    expect(resEval?.status).toBe(201)
    const dataEval = await resEval?.json()
    expect(dataEval.settlement.appliedRebateBasisPoints).toBe(300)
    expect(dataEval.settlement.rebateNetCents).toBe(63000)

    // Approve settlement
    const reqApprove = new Request(
      `https://neteco.es/api/admin/b2b/recurring-incentives/settlements/${dataEval.settlement.id}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          creditNoteRef: 'ABONO-HTTP-TURIA-Q3',
          notes: 'Aprobación fiscal completada.',
          version: dataEval.settlement.version
        })
      }
    )
    const resApprove = await handleRecurringIncentivesHttp(reqApprove, adminDeps)
    expect(resApprove?.status).toBe(200)
    const dataApprove = await resApprove?.json()
    expect(dataApprove.settlement.settlementStatus).toBe('approved')
    expect(dataApprove.settlement.creditNoteRef).toBe('ABONO-HTTP-TURIA-Q3')
  })
})
