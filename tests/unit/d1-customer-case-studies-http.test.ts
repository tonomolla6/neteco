/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON/fetch doubles in tests */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  handleCustomerCaseStudiesHttp,
  ownsCustomerCaseStudiesNamespace
} from '../../workers/cms/customer-case-studies-http'
import { ADMIN_IDENTITY, CUSTOMER_IDENTITY, NOW, createUgcCaseWorld, type UgcCaseWorld } from './ugc-case-fixture'

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

const casePayload = {
  title: 'Desengrase de cadenas en Factoría Metalúrgica Levante',
  subtitle: 'Reducción de paradas de mantenimiento no programadas',
  slug: 'desengrase-cadenas-factoria-metalurgica-levante',
  signedPermission: {
    signerName: 'Andrés Gil',
    signerRole: 'Jefe de Planta',
    companyName: 'Metalúrgica Levante S.A.',
    companyCif: 'A12345678',
    documentRef: 'DOC-AUTH-2026-MET-01',
    documentSha256: '7'.repeat(64),
    signedAt: '2026-02-15T10:00:00Z',
    scope: 'full_case_study_and_metrics',
    publishAuthorized: true
  },
  context: {
    sector: 'Metalurgia y Mecanizado',
    facilityDescription: 'Línea de producción continua con 4 baños de desengrase',
    initialSituation: 'Acumulación de virutas y lodos que provocaban paradas de 2h diarias.',
    baselineMetrics: [{ metric: 'Horas de parada mensual', value: 48, unit: 'horas/mes' }]
  },
  solution: {
    netecoProducts: ['NET-DESENGRASE-ULTRASONIDOS-PRO'],
    dosageProtocol: 'Inmersión al 8% a 65°C con agitación ultrasónica',
    implementationDurationWeeks: 1,
    solutionSummary: 'Sustitución de disolvente clorado por agente alcalino biodegradable Neteco.'
  },
  verifiableOutcome: {
    outcomeMetrics: [
      {
        metric: 'Reducción de paradas',
        before: 48,
        after: 4,
        unit: 'horas/mes',
        improvementPercent: 91.6
      }
    ],
    verificationMethod: 'Telemetría SCADA de línea de producción contrastada con partes de mantenimiento',
    verifierIdentity: 'Dirección Técnica Metalúrgica Levante',
    evidenceSha256: '8'.repeat(64)
  },
  reviewIntervalMonths: 12,
  commandId: 'cmd-http-case-1'
}

describe('MED-020 & MKT-031: Customer Case Studies HTTP Endpoints', () => {
  it('owns correct namespaces and ignores foreign paths', () => {
    expect(ownsCustomerCaseStudiesNamespace('/api/case-studies')).toBe(true)
    expect(ownsCustomerCaseStudiesNamespace('/api/case-studies/caso-1')).toBe(true)
    expect(ownsCustomerCaseStudiesNamespace('/api/admin/case-studies')).toBe(true)
    expect(ownsCustomerCaseStudiesNamespace('/api/admin/case-studies/c1/publish')).toBe(true)
    expect(ownsCustomerCaseStudiesNamespace('/api/admin/case-studies/c1/periodic-review')).toBe(true)
    expect(ownsCustomerCaseStudiesNamespace('/api/products/p1')).toBe(false)
  })

  it('strictly rejects any social action or community comments with 405/400 (MKT-031)', async () => {
    const commentReq = new Request('https://neteco.es/api/case-studies/desengrase-cadenas/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'Excelente caso!' })
    })

    const res = await handleCustomerCaseStudiesHttp(commentReq, deps(CUSTOMER_IDENTITY))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(405)
    const data = (await res!.json()) as any
    expect(data.error.code).toBe('community_features_forbidden')
    expect(data.error.message).toContain('comunidad')
  })

  it('creates draft, publishes it, and serves read-only via public endpoint', async () => {
    // 1. Admin creates draft
    const createReq = new Request('https://neteco.es/api/admin/case-studies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(casePayload)
    })
    const createRes = await handleCustomerCaseStudiesHttp(createReq, deps(ADMIN_IDENTITY))
    expect(createRes!.status).toBe(201)
    const caseData = (await createRes!.json()) as any
    expect(caseData.publicationStatus).toBe('draft')

    // 2. Draft is NOT in public listing
    const publicList1 = await handleCustomerCaseStudiesHttp(new Request('https://neteco.es/api/case-studies'), deps())
    const list1Data = (await publicList1!.json()) as any
    expect(list1Data.cases.some((c: any) => c.slug === casePayload.slug)).toBe(false)

    // 3. Admin publishes
    const pubReq = new Request(`https://neteco.es/api/admin/case-studies/${caseData.id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: caseData.version,
        commandId: 'cmd-http-pub-1'
      })
    })
    const pubRes = await handleCustomerCaseStudiesHttp(pubReq, deps(ADMIN_IDENTITY))
    expect(pubRes!.status).toBe(200)

    // 4. Public listing now contains the published case study
    const publicList2 = await handleCustomerCaseStudiesHttp(new Request('https://neteco.es/api/case-studies'), deps())
    const list2Data = (await publicList2!.json()) as any
    expect(list2Data.cases.some((c: any) => c.slug === casePayload.slug)).toBe(true)

    // 5. Public single slug view
    const singleReq = new Request(`https://neteco.es/api/case-studies/${casePayload.slug}`)
    const singleRes = await handleCustomerCaseStudiesHttp(singleReq, deps())
    expect(singleRes!.status).toBe(200)
    const singleData = (await singleRes!.json()) as any
    expect(singleData.title).toBe(casePayload.title)
    expect(singleData.permissionCompanyName).toBe('Metalúrgica Levante S.A.')
    // Strictly verify no comments or social profile:
    expect(singleData.comments).toBeUndefined()
    expect(singleData.socialProfiles).toBeUndefined()
  })

  it('allows admin to perform periodic governance review', async () => {
    // Create draft
    const createReq = new Request('https://neteco.es/api/admin/case-studies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...casePayload, slug: 'caso-revision-http', commandId: 'cmd-rev-draft' })
    })
    const createRes = await handleCustomerCaseStudiesHttp(createReq, deps(ADMIN_IDENTITY))
    const caseData = (await createRes!.json()) as any

    // Periodic review command
    const revReq = new Request(`https://neteco.es/api/admin/case-studies/${caseData.id}/periodic-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewNotes: 'Revisión técnica anual con Andrés Gil confirmada.',
        confirmedPermissionValid: true,
        nextReviewIntervalMonths: 12,
        expectedVersion: caseData.version,
        commandId: 'cmd-http-exec-rev'
      })
    })
    const revRes = await handleCustomerCaseStudiesHttp(revReq, deps(ADMIN_IDENTITY))
    expect(revRes!.status).toBe(200)
    const revData = (await revRes!.json()) as any
    expect(revData.reviewStatus).toBe('current')
  })

  it('rejects non-admin access to admin case studies list with 403', async () => {
    const req = new Request('https://neteco.es/api/admin/case-studies', { method: 'GET' })
    const res = await handleCustomerCaseStudiesHttp(req, deps(CUSTOMER_IDENTITY))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('ignores spoofed x-user-identity header without session credentials', async () => {
    const req = new Request('https://neteco.es/api/admin/case-studies', {
      method: 'GET',
      headers: { 'x-user-identity': ADMIN_IDENTITY }
    })
    const res = await handleCustomerCaseStudiesHttp(req, {
      database: world.db,
      now: () => NOW
    } as any)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
  })
})
