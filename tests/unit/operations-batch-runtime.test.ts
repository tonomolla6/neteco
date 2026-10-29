import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import worker from '../../workers/canary'
import { environment } from '../support/customer-operations-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION
} from '../support/admin-inventory-fixture'
import { supportFixture, CLAIMS, POLICY, utc, ORIGIN } from './d1-support-fixture'
import { shippingCalendarIntentHash } from '../../shared/shipping-calendar'
import { supportEscalationIntentHash } from '../../shared/support-escalations'

const origin = 'https://operations-batch.neteco.test'
const calendars = '/api/admin/shipping/calendars'

function dispatch(
  env: CloudflareEnv,
  base: string,
  path: string,
  cookie: string,
  input?: unknown,
  key = crypto.randomUUID(),
  hash?: string
) {
  return worker.fetch(
    new Request(base + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie,
        Origin: base,
        'CF-Connecting-IP': '192.0.2.79',
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) })
    }),
    env
  )
}

describe('root integration for shipping calendars and support escalation', () => {
  it.each([
    calendars,
    calendars + '/commands',
    '/api/admin/shipping%2Fcalendars',
    '/api/admin/%73hipping/calendars',
    '/API/ADMIN/SHIPPING/CALENDARS'
  ])('owns disabled shipping calendar namespace %s without legacy fallback or database access', async (path) => {
    const env = environment({ AUTH_ENABLED: 'false', AUTH_ORIGIN: origin })
    const response = await worker.fetch(new Request(origin + path), env as unknown as CloudflareEnv)
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(env.DB.prepare).not.toHaveBeenCalled()
    expect(env.DB.batch).not.toHaveBeenCalled()
  })

  it('applies the administrative rate limiter before calendar authentication or database access', async () => {
    const limit = vi.fn(async () => ({ success: false }))
    const env = environment({ AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, ADMIN_EDGE_LIMIT: { limit } })
    const response = await worker.fetch(
      new Request(origin + calendars, {
        headers: { 'CF-Connecting-IP': '192.0.2.78' }
      }),
      env as unknown as CloudflareEnv
    )
    expect(response.status).toBe(429)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: { code: 'rate_limited' } })
    expect(limit).toHaveBeenCalledOnce()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it.each([
    '/api/admin/support/escalations',
    '/api/admin/support/escalations/runbooks',
    '/api/admin/support/SOP-000000000000000000000001/escalation',
    '/api/admin/%73upport/escalations'
  ])('keeps support escalation %s disabled with the existing support feature', async (path) => {
    const env = environment({ AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, SUPPORT_ENABLED: 'false' })
    const response = await worker.fetch(new Request(origin + path), env as unknown as CloudflareEnv)
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(env.DB.prepare).not.toHaveBeenCalled()
    expect(env.DB.batch).not.toHaveBeenCalled()
  })

  it('records, recovers and replays one calendar revision through the actual Worker and reauthorizes a replay', async () => {
    const fixture = await openAdminInventoryFixture()
    try {
      fixture.sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0078_shipping_calendars.sql', import.meta.url), 'utf8')
      )
      fixture.sqlite.exec(
        "INSERT OR IGNORE INTO permissions VALUES('administration.manage','administration','manage','Synthetic'); INSERT INTO role_permissions VALUES('warehouse','administration.manage');"
      )
      const password = 'synthetic-calendar-runtime-password-more-than-32'
      const cookie = (await issueD1SessionCookie(
        fixture.database,
        {
          identityId: INVENTORY_FIXTURE_ACTOR,
          sessionId: INVENTORY_FIXTURE_SESSION,
          sessionVersion: 1
        },
        { password, maxAgeSeconds: 3600 }
      ))!.split(';')[0]!
      const env = environment({
        DB: fixture.database,
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: password
      }) as unknown as CloudflareEnv
      const send = (path: string, input?: unknown, key?: string, hash?: string) =>
        dispatch(env, origin, path, cookie, input, key, hash)
      const initial = await send(calendars)
      expect(initial.status).toBe(200)
      expect(await initial.json()).toMatchObject({ source: 'cloudflare', version: 0, configuration: null })
      const input = {
        expectedVersion: 0,
        reason: 'Synthetic review of the operating calendar',
        reviewReference: 'RUNTIME-78',
        configuration: {
          timeZone: 'Europe/Madrid',
          preparationBusinessDays: 1,
          cutoffLocalTime: '14:00',
          calendars: [
            {
              code: 'synthetic-national',
              name: 'Synthetic weekday schedule',
              scope: 'national',
              stage: 'both',
              operatingWeekdays: [1, 2, 3, 4, 5],
              closedDates: [],
              postalPrefixes: [],
              methodCodes: [],
              serviceProfiles: [],
              zoneCodes: []
            }
          ]
        }
      }
      const key = crypto.randomUUID(),
        result = await send(calendars + '/commands', input, key)
      expect(result.status).toBe(201)
      const receipt = await result.json()
      expect(receipt).toMatchObject({ commandId: key, expectedVersion: 0, version: 1 })
      const recovered = await send(
        calendars + '/commands/' + key,
        undefined,
        undefined,
        await shippingCalendarIntentHash(input)
      )
      expect(recovered.status).toBe(200)
      expect(await recovered.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
      expect(await (await send(calendars + '/commands', input, key)).json()).toEqual(receipt)
      fixture.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(INVENTORY_FIXTURE_SESSION)
      expect((await send(calendars + '/commands', input, key)).status).toBe(403)
      expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM shipping_calendar_commands').get()).toEqual({ n: 1 })
    } finally {
      fixture.sqlite.close()
    }
  })

  it('routes reviewed runbooks and a recoverable internal support handoff without leaking to customer support or changing economics', async () => {
    const fixture = await supportFixture()
    try {
      fixture.sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0079_support_escalations.sql', import.meta.url), 'utf8')
      )
      const ticket = await fixture.ticket(),
        before = fixture.economic()
      const env = environment({
        DB: fixture.database,
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: ORIGIN,
        SUPPORT_ENABLED: 'true',
        SUPPORT_POLICY: JSON.stringify(POLICY),
        NUXT_SESSION_PASSWORD: fixture.deps.sessionCookieConfiguration!.password
      }) as unknown as CloudflareEnv
      const send = (path: string, input?: unknown, key?: string, hash?: string) =>
        dispatch(env, ORIGIN, path, fixture.adminCookie, input, key, hash)
      const runbookId = crypto.randomUUID(),
        runbookPath = '/api/admin/support/escalations/runbooks/' + runbookId + '/commands'
      const draft = await send(runbookPath, {
        action: 'draft',
        expectedVersion: 0,
        queue: 'payment',
        title: 'Synthetic payment review',
        body: 'PRIVATE_RUNBOOK_RUNTIME_SENTINEL Check the existing payment records, never charge or refund automatically.',
        reason: 'Synthetic explicit internal runbook preparation'
      })
      expect(draft.status).toBe(201)
      expect(
        (
          await send(runbookPath, {
            action: 'approve',
            expectedVersion: 1,
            operationalReference: 'SYNTHETIC-RUNBOOK-79',
            reviewedAt: utc(-60000),
            expiresAt: utc(86400000),
            reason: 'Synthetic explicit operational approval'
          })
        ).status
      ).toBe(201)
      const path = '/api/admin/support/' + ticket.publicRef + '/escalation'
      const input = {
        action: 'handoff',
        expectedVersion: 0,
        expectedTicketVersion: ticket.version,
        queue: 'payment',
        severity: 'high',
        ownerId: CLAIMS.identityId,
        runbook: { id: runbookId, version: 2 },
        nextAction: 'PRIVATE_HANDOFF_RUNTIME_SENTINEL Review the existing receipt',
        nextActionAt: utc(3600000),
        reason: 'Synthetic internal payment escalation'
      }
      const key = crypto.randomUUID(),
        result = await send(path + '/commands', input, key)
      expect(result.status).toBe(201)
      expect(result.headers.get('cache-control')).toBe('private, no-store')
      const receipt = await result.json()
      expect(receipt).toMatchObject({
        commandId: key,
        version: 1,
        inventoryEffect: 'none',
        economicEffect: 'none',
        communicationEffect: 'none'
      })
      const recovered = await send(
        path + '/commands/' + key,
        undefined,
        undefined,
        await supportEscalationIntentHash(ticket.publicRef, input)
      )
      expect(recovered.status).toBe(200)
      expect(await recovered.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
      expect(await (await send(path + '/commands', input, key)).json()).toEqual(receipt)
      const snapshot = await send(path)
      expect(snapshot.status).toBe(200)
      expect(await snapshot.json()).toMatchObject({
        publicRef: ticket.publicRef,
        escalation: { queue: 'payment', version: 1 }
      })
      const customer = await dispatch(env, ORIGIN, '/api/account/support/' + ticket.publicRef, fixture.customerCookie)
      expect(customer.status).toBe(200)
      const customerBody = await customer.text()
      expect(customerBody).not.toContain('PRIVATE_RUNBOOK_RUNTIME_SENTINEL')
      expect(customerBody).not.toContain('PRIVATE_HANDOFF_RUNTIME_SENTINEL')
      expect(fixture.economic()).toEqual(before)
      fixture.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='support.manage'")
      expect((await send(path + '/commands', input, key)).status).toBe(403)
    } finally {
      fixture.sqlite.close()
    }
  })
})
