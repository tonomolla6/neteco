import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNotificationInputSchema, markNotificationsReadInputSchema } from '../../shared/account-notifications'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleAccountNotificationsHttp } from '../../workers/communications/account-notifications-http'
import {
  createAccountNotification,
  listAccountNotifications,
  markAccountNotificationsRead
} from '../../workers/communications/account-notifications'
import { BUYER_CLAIMS, CUSTOMER, multichannelFixture, OTHER_BUYER_CLAIMS, utc } from './d1-multichannel-fixture'

describe('notification identifiers retain Zod 3 compatibility', () => {
  let fixture: Awaited<ReturnType<typeof multichannelFixture>>
  const notificationId = '10000000-0000-0000-0000-000000000001'
  const commandId = '10000000-0000-0000-0000-000000000002'

  beforeEach(async () => {
    fixture = await multichannelFixture()
  })
  afterEach(() => fixture.sqlite.close())

  it('accepts the formerly valid UUID-shaped identifiers while rejecting malformed ones', () => {
    expect(createNotificationInputSchema.shape.customerId.safeParse(notificationId).success).toBe(true)
    expect(markNotificationsReadInputSchema.safeParse({ notificationIds: [notificationId] }).success).toBe(true)
    const invalid = createNotificationInputSchema.shape.customerId.safeParse('invalid')
    expect(invalid.success).toBe(false)
    if (!invalid.success) expect(invalid.error.issues[0]?.message).toBe('Invalid uuid')
  })

  it('persists, reads and marks a legacy identifier without exposing it to another customer', async () => {
    const item = await createAccountNotification(
      fixture.database,
      notificationId,
      { customerId: CUSTOMER, category: 'pedido', title: 'Pedido', body: 'Detalle' },
      { now: () => utc() }
    )
    expect(item.id).toBe(notificationId)
    expect((await listAccountNotifications(fixture.database, OTHER_BUYER_CLAIMS, {})).items).toHaveLength(0)
    const foreign = await markAccountNotificationsRead(
      fixture.database,
      OTHER_BUYER_CLAIMS,
      '10000000-0000-0000-0000-000000000003',
      { notificationIds: [notificationId] },
      { now: () => utc() }
    )
    expect(foreign.affectedCount).toBe(0)
    const own = await listAccountNotifications(fixture.database, BUYER_CLAIMS, {})
    expect(own.items.map((notification) => notification.id)).toContain(notificationId)
    expect(own.items[0]?.read).toBe(false)
    const result = await markAccountNotificationsRead(
      fixture.database,
      BUYER_CLAIMS,
      commandId,
      { notificationIds: [notificationId] },
      { now: () => utc() }
    )
    expect(result.affectedCount).toBe(1)
    const replay = await markAccountNotificationsRead(
      fixture.database,
      BUYER_CLAIMS,
      commandId,
      { notificationIds: [notificationId] },
      { now: () => utc() }
    )
    expect(replay).toEqual(result)
    expect((await listAccountNotifications(fixture.database, BUYER_CLAIMS, {})).items[0]?.read).toBe(true)
  })

  it('accepts the legacy command identifier through the authenticated HTTP endpoint', async () => {
    fixture.sqlite
      .prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?')
      .run('2099-01-01T00:00:00Z', BUYER_CLAIMS.sessionId)
    const config = { password: 'synthetic-notification-cookie-password-at-least-32-chars', maxAgeSeconds: 3600 }
    const cookie = await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, config)
    expect(cookie).not.toBeNull()
    await createAccountNotification(
      fixture.database,
      notificationId,
      { customerId: CUSTOMER, category: 'pedido', title: 'Pedido', body: 'Detalle' },
      { now: () => utc() }
    )
    const origin = 'https://notifications.neteco.test'
    const response = await handleAccountNotificationsHttp(
      new Request(`${origin}/api/account/notifications/mark-read`, {
        method: 'POST',
        headers: {
          Cookie: cookie!.split(';')[0]!,
          Origin: origin,
          'Content-Type': 'application/json',
          'Idempotency-Key': commandId
        },
        body: JSON.stringify({ notificationIds: [notificationId] })
      }),
      { database: fixture.database, origin, sessionCookieConfiguration: config, now: () => utc() }
    )
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ affectedCount: 1 })

    const invalid = await handleAccountNotificationsHttp(
      new Request(`${origin}/api/account/notifications/mark-read`, {
        method: 'POST',
        headers: { Cookie: cookie!.split(';')[0]!, Origin: origin, 'Idempotency-Key': 'invalid' },
        body: JSON.stringify({ notificationIds: [notificationId] })
      }),
      { database: fixture.database, origin, sessionCookieConfiguration: config }
    )
    expect(invalid?.status).toBe(400)

    const unauthenticated = await handleAccountNotificationsHttp(
      new Request(`${origin}/api/account/notifications/mark-read`, { method: 'POST', headers: { Origin: origin } }),
      { database: fixture.database, origin, sessionCookieConfiguration: config }
    )
    expect(unauthenticated?.status).toBe(401)

    const crossOrigin = await handleAccountNotificationsHttp(
      new Request(`${origin}/api/account/notifications/mark-read`, {
        method: 'POST',
        headers: { Cookie: cookie!.split(';')[0]!, Origin: 'https://elsewhere.invalid' }
      }),
      { database: fixture.database, origin, sessionCookieConfiguration: config }
    )
    expect(crossOrigin?.status).toBe(403)
  })
})
