import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleCustomerAccountManagerHttp,
  ownsCustomerAccountManagerNamespace
} from '../../workers/crm/account-manager-http'

const ORIGIN = 'https://crm.neteco.test'

interface VisibleContactResponse {
  hasAssignedManager: boolean
  manager?: {
    name: string
    email: string
  }
  generalSupport: {
    email: string
  }
}

interface OpportunityResponse {
  opportunity: {
    id: string
    stage: string
  }
}

interface CalendarEventsResponse {
  events: Array<{
    id: string
    subject: string
  }>
}

describe('SUP-016 Customer account manager HTTP routing and security', () => {
  let f: Awaited<ReturnType<typeof returnsFixture>>
  let adminCookie: string
  let buyerCookie: string
  const sessionConfig = { password: 'synthetic-crm-session-cookie-password-0123456789abcdef', maxAgeSeconds: 3600 }

  beforeEach(async () => {
    f = await returnsFixture()
    const migration = await readFile(
      new URL('../../db/d1/migrations/0102_support_live_chat_and_account_managers.sql', import.meta.url),
      'utf8'
    )
    f.sqlite.exec(migration)
    f.sqlite.exec(
      "INSERT INTO permissions VALUES('support.manage','support','manage','Synthetic test permission');" +
        "INSERT INTO role_permissions VALUES('operator','support.manage');"
    )
    adminCookie = (await issueD1SessionCookie(f.database, CLAIMS, sessionConfig))!.split(';')[0]!
    buyerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, sessionConfig))!.split(';')[0]!
  })

  afterEach(() => f.sqlite.close())

  const dispatch = (path: string, init: RequestInit = {}, cookie?: string) => {
    const headers = new Headers(init.headers)
    if (cookie) headers.set('Cookie', cookie)
    return handleCustomerAccountManagerHttp(
      new Request(`${ORIGIN}${path}`, {
        ...init,
        headers
      }),
      {
        database: f.database,
        sessionCookieConfiguration: sessionConfig,
        origin: ORIGIN,
        edgeGate: async () => 'allowed'
      }
    )
  }

  it('matches only owned account manager / CRM namespaces', () => {
    expect(ownsCustomerAccountManagerNamespace('/api/admin/crm/customers/123/account-manager')).toBe(true)
    expect(ownsCustomerAccountManagerNamespace('/api/customer/account-manager')).toBe(true)
    expect(ownsCustomerAccountManagerNamespace('/api/admin/crm/customers/123/notes')).toBe(true)
    expect(ownsCustomerAccountManagerNamespace('/api/customer/calendar-events')).toBe(true)
    expect(ownsCustomerAccountManagerNamespace('/api/catalog/products')).toBe(false)
  })

  it('provides visible contact endpoint for authenticated customers with fallback when unassigned', async () => {
    const res = await dispatch('/api/customer/account-manager', {}, buyerCookie)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const json = (await res!.json()) as VisibleContactResponse
    expect(json.hasAssignedManager).toBe(false)
    expect(json.generalSupport).toBeDefined()
    expect(json.generalSupport.email).toBe('soporte@neteco.es')
  })

  it('allows admin to assign manager and exposes visible contact to customer afterwards', async () => {
    const assignRes = await dispatch(
      `/api/admin/crm/customers/${CUSTOMER}/account-manager`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          managerIdentityId: CLAIMS.identityId,
          managerName: 'Sergio Navarro',
          managerEmail: 'sergio.navarro@neteco.es',
          managerPhone: '+34 962 333 444 ext 201',
          availabilitySchedule: 'L-V 09:00 - 18:00',
          slaTier: 'priority',
          slaResponseHours: 4,
          reason: 'Asignación de gestor B2B'
        })
      },
      adminCookie
    )
    expect(assignRes!.status).toBe(200)

    // Customer now sees their assigned manager!
    const customerRes = await dispatch('/api/customer/account-manager', {}, buyerCookie)
    expect(customerRes!.status).toBe(200)
    const custJson = (await customerRes!.json()) as VisibleContactResponse
    expect(custJson.hasAssignedManager).toBe(true)
    expect(custJson.manager?.name).toBe('Sergio Navarro')
    expect(custJson.manager?.email).toBe('sergio.navarro@neteco.es')
  })

  it('prevents customer from viewing or creating confidential internal notes', async () => {
    // Admin creates note
    const noteRes = await dispatch(
      `/api/admin/crm/customers/${CUSTOMER}/notes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'credit',
          confidentiality: 'admin_only',
          title: 'Límite de crédito comercial aprobado',
          content: 'Aprobada línea de crédito hasta 5.000€ a 30 días.'
        })
      },
      adminCookie
    )
    expect(noteRes!.status).toBe(201)

    // Customer attempts to read notes -> 403 Forbidden
    const forbiddenRes = await dispatch(`/api/admin/crm/customers/${CUSTOMER}/notes`, {}, buyerCookie)
    expect(forbiddenRes!.status).toBe(403)
  })

  it('manages opportunity creation and stage progression over HTTP', async () => {
    const createRes = await dispatch(
      `/api/admin/crm/customers/${CUSTOMER}/opportunities`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Suministro anual lavanderías industriales',
          estimatedValueCents: 1200000,
          stage: 'qualified',
          probabilityPercent: 50,
          expectedCloseDate: '2026-12-15'
        })
      },
      adminCookie
    )
    expect(createRes!.status).toBe(201)
    const { opportunity } = (await createRes!.json()) as OpportunityResponse

    const stageRes = await dispatch(
      `/api/admin/crm/opportunities/${opportunity.id}/stage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: 1,
          stage: 'proposal',
          probabilityPercent: 75,
          reason: 'Enviado pliego de condiciones técnicas y precios.'
        })
      },
      adminCookie
    )
    expect(stageRes!.status).toBe(200)
    const stageJson = (await stageRes!.json()) as OpportunityResponse
    expect(stageJson.opportunity.stage).toBe('proposal')
  })

  it('handles calendar events with consent check over HTTP', async () => {
    // Rejects if consent verification is false
    const badRes = await dispatch(
      `/api/admin/crm/customers/${CUSTOMER}/calendar-events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          managerIdentityId: CLAIMS.identityId,
          subject: 'Visita presencial instalaciones',
          scheduledAt: '2026-11-10T09:30:00Z',
          durationMinutes: 60,
          channel: 'in_person',
          customerConsentVerified: false
        })
      },
      adminCookie
    )
    expect(badRes!.status).toBe(400)

    // Valid with consent
    const goodRes = await dispatch(
      `/api/admin/crm/customers/${CUSTOMER}/calendar-events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          managerIdentityId: CLAIMS.identityId,
          subject: 'Visita presencial instalaciones',
          scheduledAt: '2026-11-10T09:30:00Z',
          durationMinutes: 60,
          channel: 'in_person',
          customerConsentVerified: true,
          consentReference: 'Email de confirmación de fecha por el cliente'
        })
      },
      adminCookie
    )
    expect(goodRes!.status).toBe(201)

    // Customer can view their scheduled appointments
    const custEventsRes = await dispatch('/api/customer/calendar-events', {}, buyerCookie)
    expect(custEventsRes!.status).toBe(200)
    const custEventsJson = (await custEventsRes!.json()) as CalendarEventsResponse
    expect(custEventsJson.events.length).toBe(1)
    expect(custEventsJson.events[0]?.subject).toBe('Visita presencial instalaciones')
  })
})
