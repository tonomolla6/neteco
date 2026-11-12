import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  customerChannelPreferencesSchema,
  orchestrateMultichannelInputSchema,
  orchestrateMultichannelResultSchema
} from '../../shared/multichannel-orchestration'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleAccountNotificationsHttp } from '../../workers/communications/account-notifications-http'
import { handleMultichannelHttp } from '../../workers/communications/multichannel-http'
import {
  orchestrateMultichannelDelivery,
  readCustomerChannelPreferences
} from '../../workers/communications/multichannel-orchestrator'
import { ADMIN_CLAIMS, BUYER_CLAIMS, CUSTOMER, multichannelFixture, utc } from './d1-multichannel-fixture'

describe('multichannel preference UUID compatibility', () => {
  let fixture: Awaited<ReturnType<typeof multichannelFixture>>
  const legacyId = '10000000-0000-0000-0000-000000000009'

  beforeEach(async () => {
    fixture = await multichannelFixture()
  })
  afterEach(() => fixture.sqlite.close())

  it('accepts UUID-shaped identifiers previously accepted by the preferences schema', () => {
    expect(customerChannelPreferencesSchema.shape.commandId.safeParse(legacyId).success).toBe(true)
    expect(customerChannelPreferencesSchema.shape.customerId.safeParse(legacyId).success).toBe(true)
    expect(orchestrateMultichannelInputSchema.shape.customerId.safeParse(legacyId).success).toBe(true)
    expect(orchestrateMultichannelResultSchema.shape.commandId.safeParse(legacyId).success).toBe(true)
    expect(orchestrateMultichannelResultSchema.shape.customerId.safeParse(legacyId).success).toBe(true)
    expect(orchestrateMultichannelResultSchema.shape.inAppNotificationId.safeParse(legacyId).success).toBe(true)
    expect(customerChannelPreferencesSchema.shape.commandId.safeParse('invalid').success).toBe(false)
  })

  it('reads default preferences for a legacy-shaped customer identifier', async () => {
    expect(await readCustomerChannelPreferences(fixture.database, legacyId)).toMatchObject({
      customerId: legacyId,
      version: 0
    })
    await expect(readCustomerChannelPreferences(fixture.database, 'invalid')).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })

  it('updates and reads persisted preferences through HTTP with a legacy command identifier', async () => {
    fixture.sqlite
      .prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?')
      .run('2099-01-01T00:00:00Z', BUYER_CLAIMS.sessionId)
    const config = { password: 'synthetic-multichannel-cookie-password-at-least-32-chars', maxAgeSeconds: 3600 }
    const cookie = await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, config)
    expect(cookie).not.toBeNull()
    const origin = 'https://multichannel.neteco.test'
    const deps = { database: fixture.database, origin, sessionCookieConfiguration: config, now: () => utc() }
    const response = await handleAccountNotificationsHttp(
      new Request(`${origin}/api/account/multichannel-preferences`, {
        method: 'PUT',
        headers: {
          Cookie: cookie!.split(';')[0]!,
          Origin: origin,
          'Content-Type': 'application/json',
          'Idempotency-Key': legacyId
        },
        body: JSON.stringify({ expectedVersion: 0, smsEnabled: false })
      }),
      deps
    )
    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ commandId: legacyId, version: 1, smsEnabled: false })
    const read = await handleAccountNotificationsHttp(
      new Request(`${origin}/api/account/multichannel-preferences`, {
        headers: { Cookie: cookie!.split(';')[0]!, Origin: origin }
      }),
      deps
    )
    expect(read?.status).toBe(200)
    expect(await read?.json()).toMatchObject({ commandId: legacyId, version: 1, smsEnabled: false })
  })

  it('retains customer filtering and dispatch with legacy identifiers on the admin API', async () => {
    fixture.sqlite
      .prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?')
      .run('2099-01-01T00:00:00Z', ADMIN_CLAIMS.sessionId)
    fixture.sqlite
      .prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?')
      .run('2099-01-01T00:00:00Z', BUYER_CLAIMS.sessionId)
    const config = { password: 'synthetic-multichannel-cookie-password-at-least-32-chars', maxAgeSeconds: 3600 }
    const cookie = await issueD1SessionCookie(fixture.database, ADMIN_CLAIMS, config)
    const buyerCookie = await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, config)
    expect(cookie).not.toBeNull()
    expect(buyerCookie).not.toBeNull()
    const origin = 'https://multichannel.neteco.test'
    const transports = {
      email: { send: async () => ({ success: true }) },
      sms: { send: async () => ({ success: true }) },
      whatsapp: { send: async () => ({ success: true }) }
    }
    const deps = {
      database: fixture.database,
      origin,
      sessionCookieConfiguration: config,
      now: () => utc(),
      transports
    }
    const denied = await handleMultichannelHttp(
      new Request(`${origin}/api/admin/communications/multichannel/logs?customerId=${legacyId}`, {
        headers: { Cookie: buyerCookie!.split(';')[0]!, Origin: origin }
      }),
      deps
    )
    expect(denied?.status).toBe(403)
    const input = {
      customerId: CUSTOMER,
      dedupKey: 'existing-dispatch',
      category: 'pedido',
      eventType: 'order.update',
      title: 'Pedido',
      body: 'Detalle'
    }
    await orchestrateMultichannelDelivery(fixture.database, '20000000-0000-4000-8000-000000000099', input, {
      now: () => utc(),
      transports
    })
    const logs = await handleMultichannelHttp(
      new Request(`${origin}/api/admin/communications/multichannel/logs?customerId=${legacyId}`, {
        headers: { Cookie: cookie!.split(';')[0]!, Origin: origin }
      }),
      deps
    )
    expect(logs?.status).toBe(200)
    expect(await logs?.json()).toMatchObject({ total: 0, items: [] })
    const dispatch = await handleMultichannelHttp(
      new Request(`${origin}/api/admin/communications/multichannel/dispatch`, {
        method: 'POST',
        headers: {
          Cookie: cookie!.split(';')[0]!,
          Origin: origin,
          'Content-Type': 'application/json',
          'Idempotency-Key': legacyId
        },
        body: JSON.stringify({ ...input, dedupKey: 'legacy-dispatch' })
      }),
      deps
    )
    expect(dispatch?.status).toBe(200)
    expect(await dispatch?.json()).toMatchObject({ commandId: legacyId, customerId: CUSTOMER })
    const prefs = await handleMultichannelHttp(
      new Request(`${origin}/api/admin/communications/multichannel/preferences/${legacyId}`, {
        headers: { Cookie: cookie!.split(';')[0]!, Origin: origin }
      }),
      deps
    )
    expect(prefs?.status).toBe(200)
    expect(await prefs?.json()).toMatchObject({ customerId: legacyId, version: 0 })
  })
})
