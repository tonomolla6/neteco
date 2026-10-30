import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { multichannelFixture, CUSTOMER, BUYER_CLAIMS, ADMIN_CLAIMS, utc } from './d1-multichannel-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleAccountNotificationsHttp } from '../../workers/communications/account-notifications-http'
import { handleMultichannelHttp } from '../../workers/communications/multichannel-http'
import { deterministicUuid } from '../fixtures/deterministic'

describe('COM-015 & COM-016 Multichannel & Notification Center HTTP endpoints', () => {
  let f: Awaited<ReturnType<typeof multichannelFixture>>
  let customerCookie: string
  let adminCookie: string

  const origin = 'https://multichannel.neteco.test'
  const config = {
    password: 'synthetic-multichannel-cookie-password-at-least-32-chars',
    maxAgeSeconds: 3600
  }
  const edgeLimiter = {
    limit: async () => ({ success: true })
  } as unknown as RateLimit
  const pepper = 'synthetic-multichannel-pepper-at-least-32-chars'

  const deps = () => ({
    database: f.database,
    origin,
    sessionCookieConfiguration: config,
    edgeLimiter,
    rateLimitPepper: pepper,
    now: () => utc(),
    transports: {
      email: { send: async () => ({ success: true, messageId: 'http-email-id' }) },
      sms: { send: async () => ({ success: true, messageId: 'http-sms-id' }) },
      whatsapp: { send: async () => ({ success: true, messageId: 'http-wa-id' }) }
    }
  })

  const customerRequest = (path: string, method = 'GET', body?: unknown, cookie = customerCookie) =>
    new Request(`${origin}${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '192.0.2.15',
        'Idempotency-Key': deterministicUuid('req-' + path + '-' + method)
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    })

  const adminRequest = (path: string, method = 'GET', body?: unknown, cookie = adminCookie) =>
    new Request(`${origin}${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '192.0.2.16',
        'Idempotency-Key': deterministicUuid('admin-req-' + path + '-' + method)
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    })

  beforeEach(async () => {
    f = await multichannelFixture()
    customerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, config))!.split(';')[0]!
    adminCookie = (await issueD1SessionCookie(f.database, ADMIN_CLAIMS, config))!.split(';')[0]!
  })

  afterEach(() => {
    f.sqlite.close()
  })

  it('handles GET /api/account/notifications and summary', async () => {
    // Initially empty
    const res = await handleAccountNotificationsHttp(
      customerRequest('/api/account/notifications?category=all&status=all'),
      deps()
    )
    expect(res).not.toBeNull()
    expect(res?.status).toBe(200)
    const data = (await res?.json()) as { total: number; items: unknown[] }
    expect(data.total).toBe(0)
    expect(data.items).toEqual([])

    // Summary endpoint
    const summaryRes = await handleAccountNotificationsHttp(
      customerRequest('/api/account/notifications/summary'),
      deps()
    )
    expect(summaryRes?.status).toBe(200)
    const summary = (await summaryRes?.json()) as { total: number; unread: number }
    expect(summary.total).toBe(0)
    expect(summary.unread).toBe(0)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const unauthReq = new Request(`${origin}/api/account/notifications`, {
      method: 'GET',
      headers: { Origin: origin }
    })
    const res = await handleAccountNotificationsHttp(unauthReq, deps())
    expect(res?.status).toBe(401)
    const err = (await res?.json()) as { error: { code: string } }
    expect(err.error.code).toBe('unauthenticated')
  })

  it('updates and reads customer multichannel preferences via HTTP', async () => {
    // Read initial preferences
    const getRes = await handleAccountNotificationsHttp(
      customerRequest('/api/account/multichannel-preferences'),
      deps()
    )
    expect(getRes?.status).toBe(200)
    const initialPrefs = (await getRes?.json()) as {
      priorityOrder: string[]
      version: number
      emailEnabled: boolean
    }
    expect(initialPrefs.priorityOrder).toEqual(['whatsapp', 'sms', 'email'])
    expect(initialPrefs.version).toBe(0)

    // Update preferences
    const putRes = await handleAccountNotificationsHttp(
      customerRequest('/api/account/multichannel-preferences', 'PUT', {
        expectedVersion: 0,
        priorityOrder: ['email', 'whatsapp', 'sms'],
        smsEnabled: false
      }),
      deps()
    )
    expect(putRes?.status).toBe(200)
    const updated = (await putRes?.json()) as {
      priorityOrder: string[]
      version: number
      smsEnabled: boolean
    }
    expect(updated.priorityOrder).toEqual(['email', 'whatsapp', 'sms'])
    expect(updated.smsEnabled).toBe(false)
    expect(updated.version).toBe(1)
  })

  it('dispatches multichannel delivery via admin API and writes orchestration logs', async () => {
    const dispatchReq = adminRequest('/api/admin/communications/multichannel/dispatch', 'POST', {
      customerId: CUSTOMER,
      dedupKey: 'admin-dispatch-test-1',
      category: 'pedido',
      eventType: 'order.delivered',
      title: 'Pedido entregado',
      body: 'Tu paquete ha llegado a tu dirección.',
      mandatory: false
    })

    const res = await handleMultichannelHttp(dispatchReq, deps())
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as { status: string; selectedChannel: string; commandId: string }
    expect(body.status).toBe('delivered')
    expect(body.selectedChannel).toBe('whatsapp')

    // Read logs
    const logsReq = adminRequest(`/api/admin/communications/multichannel/logs?customerId=${CUSTOMER}`)
    const logsRes = await handleMultichannelHttp(logsReq, deps())
    expect(logsRes?.status).toBe(200)
    const logs = (await logsRes?.json()) as { total: number; items: Array<{ dedupKey: string; status: string }> }
    expect(logs.total).toBe(1)
    expect(logs.items[0].dedupKey).toBe('admin-dispatch-test-1')
    expect(logs.items[0].status).toBe('delivered')
  })

  it('supports marking notifications read via POST /api/account/notifications/mark-read', async () => {
    // First trigger a dispatch to generate an in-app notification
    await handleMultichannelHttp(
      adminRequest('/api/admin/communications/multichannel/dispatch', 'POST', {
        customerId: CUSTOMER,
        dedupKey: 'notif-http-mark-1',
        category: 'soporte',
        eventType: 'support.ticket.reply',
        title: 'Mensaje de soporte',
        body: 'Te contestamos al ticket.',
        inAppCenter: true
      }),
      deps()
    )

    // Query notifications
    const listRes = await handleAccountNotificationsHttp(
      customerRequest('/api/account/notifications?status=unread'),
      deps()
    )
    const list = (await listRes?.json()) as { total: number; items: Array<{ id: string }> }
    expect(list.total).toBe(1)
    const notifId = list.items[0].id

    // Mark as read
    const markRes = await handleAccountNotificationsHttp(
      customerRequest('/api/account/notifications/mark-read', 'POST', {
        notificationIds: [notifId]
      }),
      deps()
    )
    expect(markRes?.status).toBe(200)
    const markResult = (await markRes?.json()) as { affectedCount: number }
    expect(markResult.affectedCount).toBe(1)

    // Verify unread count is now 0
    const summaryRes = await handleAccountNotificationsHttp(
      customerRequest('/api/account/notifications/summary'),
      deps()
    )
    const summary = (await summaryRes?.json()) as { unread: number }
    expect(summary.unread).toBe(0)
  })

  it('rejects cross-site and CSRF requests on mutating endpoints', async () => {
    // Bad origin header on POST
    const crossSiteReq = new Request(`${origin}/api/account/notifications/mark-read`, {
      method: 'POST',
      headers: {
        Cookie: customerCookie,
        Origin: 'https://evil.attacker.invalid',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ all: true })
    })

    const res = await handleAccountNotificationsHttp(crossSiteReq, deps())
    expect(res?.status).toBe(403)
    const err = (await res?.json()) as { error: { code: string } }
    expect(err.error.code).toBe('csrf_rejected')
  })

  it('rejects unsupported HTTP methods with 405 Method Not Allowed', async () => {
    const patchReq = customerRequest('/api/account/notifications', 'DELETE')
    const res = await handleAccountNotificationsHttp(patchReq, deps())
    expect(res?.status).toBe(405)
  })

  it('handles malformed JSON body gracefully with 400 Bad Request', async () => {
    const malformedReq = new Request(`${origin}/api/account/notifications/mark-read`, {
      method: 'POST',
      headers: {
        Cookie: customerCookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': deterministicUuid('malformed-json-test')
      },
      body: 'this-is-not-valid-json'
    })

    const res = await handleAccountNotificationsHttp(malformedReq, deps())
    expect(res?.status).toBe(400)
    const err = (await res?.json()) as { error: { code: string } }
    expect(err.error.code).toBe('invalid_input')
  })
})
