import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  multichannelFixture,
  CUSTOMER,
  BUYER_CLAIMS,
  ADMIN_CLAIMS,
  OTHER_CUSTOMER,
  utc
} from './d1-multichannel-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleMultichannelHttp } from '../../workers/communications/multichannel-http'
import { testUuid } from '../support/deterministic'

// COM-015 admin API: a signed-in storefront buyer must not dispatch messages, read other
// customers' orchestration logs or read/rewrite another customer's channel preferences.
describe('COM-015: el API admin multicanal exige autoridad administrativa viva', () => {
  let f: Awaited<ReturnType<typeof multichannelFixture>>
  let buyerCookie: string
  let adminCookie: string
  const origin = 'https://multichannel.neteco.test'
  const config = { password: 'synthetic-multichannel-cookie-password-at-least-32-chars', maxAgeSeconds: 3600 }
  const deps = () => ({
    database: f.database,
    origin,
    sessionCookieConfiguration: config,
    now: () => utc(),
    transports: {
      email: { send: async () => ({ success: true, messageId: 'e' }) },
      sms: { send: async () => ({ success: true, messageId: 's' }) },
      whatsapp: { send: async () => ({ success: true, messageId: 'w' }) }
    }
  })
  const request = (path: string, cookie: string, method = 'GET', body?: unknown) =>
    new Request(`${origin}${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': testUuid()
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    })

  beforeEach(async () => {
    f = await multichannelFixture()
    buyerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, config))!.split(';')[0]!
    adminCookie = (await issueD1SessionCookie(f.database, ADMIN_CLAIMS, config))!.split(';')[0]!
  })
  afterEach(() => f.sqlite.close())

  const DISPATCH = {
    customerId: OTHER_CUSTOMER,
    dedupKey: 'abuse-1',
    category: 'pedido',
    eventType: 'order.delivered',
    title: 'Titulo',
    body: 'Texto de prueba para el cliente',
    mandatory: false
  }

  it('un comprador no puede lanzar envíos a otros clientes', async () => {
    const response = await handleMultichannelHttp(
      request('/api/admin/communications/multichannel/dispatch', buyerCookie, 'POST', DISPATCH),
      deps()
    )
    expect(response?.status).toBe(403)
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM multichannel_orchestration_commands').get()).toEqual({ n: 0 })
  })

  it('un comprador no lee los registros de orquestación', async () => {
    const response = await handleMultichannelHttp(
      request(`/api/admin/communications/multichannel/logs?customerId=${CUSTOMER}`, buyerCookie),
      deps()
    )
    expect(response?.status).toBe(403)
  })

  it('un comprador no lee ni reescribe preferencias de otro cliente', async () => {
    const path = `/api/admin/communications/multichannel/preferences/${OTHER_CUSTOMER}`
    expect((await handleMultichannelHttp(request(path, buyerCookie), deps()))?.status).toBe(403)
    const write = await handleMultichannelHttp(
      request(path, buyerCookie, 'PUT', { expectedVersion: 0, smsEnabled: false }),
      deps()
    )
    expect(write?.status).toBe(403)
    expect(
      f.sqlite
        .prepare('SELECT COUNT(*) AS n FROM customer_channel_preferences WHERE customer_id = ?')
        .get(OTHER_CUSTOMER)
    ).toEqual({ n: 0 })
  })

  it('un administrador con MFA sigue operando', async () => {
    const response = await handleMultichannelHttp(
      request(`/api/admin/communications/multichannel/preferences/${CUSTOMER}`, adminCookie),
      deps()
    )
    expect(response?.status).toBe(200)
  })
})
