import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { supportFixture, CLAIMS, BUYER_CLAIMS, ORIGIN } from './d1-support-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleSupportLiveChatHttp, ownsSupportLiveChatNamespace } from '../../workers/support/live-chat-http'

interface AvailabilityResponse {
  disclaimer: string
  operatingHours: unknown
}

interface SessionResponse {
  session: {
    id: string
    publicRef: string
    queuePosition: number
    currentVersion: number
    status: string
  }
}

interface QueueResponse {
  queue: unknown[]
}

interface MessageResponse {
  message: {
    isHuman: number
  }
}

interface TranscriptResponse {
  transcript: {
    messages: unknown[]
  }
}

// Next weekday 10:00 UTC at or after the real clock. The HTTP handler reads the clock itself and the
// support chat is only open in business hours, so only `Date` is pinned (real timers), and only after
// the fixture rows exist so they never lie in the pinned clock's future.
function nextBusinessInstant(): Date {
  const d = new Date()
  d.setUTCHours(10, 0, 0, 0)
  if (d.getTime() < Date.now()) d.setUTCDate(d.getUTCDate() + 1)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1)
  return d
}

describe('SUP-011 Live chat HTTP routing and authorization', () => {
  let f: Awaited<ReturnType<typeof supportFixture>>
  let adminCookie: string
  let buyerCookie: string
  const policyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  const sessionConfig = { password: 'synthetic-support-session-cookie-password-0123456789abcdef', maxAgeSeconds: 3600 }

  beforeEach(async () => {
    f = await supportFixture()
    // Fixture sessions stay valid for the pinned instant; cookies are issued after pinning.
    f.sqlite.exec("UPDATE auth_sessions SET expires_at='2099-12-31T23:59:59Z'")
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(nextBusinessInstant())
    const migration = await readFile(
      new URL('../../db/d1/migrations/0102_support_live_chat_and_account_managers.sql', import.meta.url),
      'utf8'
    )
    f.sqlite.exec(migration)
    adminCookie = (await issueD1SessionCookie(f.database, CLAIMS, sessionConfig))!.split(';')[0]!
    buyerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, sessionConfig))!.split(';')[0]!
  })

  afterEach(() => {
    f.sqlite.close()
    vi.useRealTimers()
  })

  const dispatch = (path: string, init: RequestInit = {}, cookie?: string) => {
    const headers = new Headers(init.headers)
    if (cookie) headers.set('Cookie', cookie)
    return handleSupportLiveChatHttp(
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

  it('matches only owned live chat namespaces', () => {
    expect(ownsSupportLiveChatNamespace('/api/support/live-chat/availability')).toBe(true)
    expect(ownsSupportLiveChatNamespace('/api/support/live-chat/sessions')).toBe(true)
    expect(ownsSupportLiveChatNamespace('/api/admin/support/live-chat/queue')).toBe(true)
    expect(ownsSupportLiveChatNamespace('/api/support/tickets')).toBe(false)
    expect(ownsSupportLiveChatNamespace('/api/catalog/products')).toBe(false)
  })

  it('serves public availability with human-only disclaimer without authentication', async () => {
    const res = await dispatch('/api/support/live-chat/availability')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const json = (await res!.json()) as AvailabilityResponse
    expect(json.disclaimer).toContain('humana')
    expect(json.disclaimer).toContain('No utilizamos bots')
    expect(json.operatingHours).toBeDefined()
  })

  it('allows starting a live chat session with consent', async () => {
    const res = await dispatch(
      '/api/support/live-chat/sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          consentGiven: true,
          consentPolicyHash: policyHash,
          department: 'general',
          customerName: 'Cliente Web',
          context: { url: 'https://neteco.test/ayuda' }
        })
      },
      buyerCookie
    )

    expect(res!.status).toBe(201)
    const json = (await res!.json()) as SessionResponse
    expect(json.session.id).toBeDefined()
    expect(json.session.publicRef).toMatch(/^CHAT-/)
    expect(json.session.queuePosition).toBe(1)
  })

  it('protects admin queue endpoint against unauthenticated or non-admin users', async () => {
    // Unauthenticated
    const anonRes = await dispatch('/api/admin/support/live-chat/queue')
    expect(anonRes!.status).toBe(401)

    // Authenticated regular customer
    const buyerRes = await dispatch('/api/admin/support/live-chat/queue', {}, buyerCookie)
    expect(buyerRes!.status).toBe(403)

    // Authorized operator
    const adminRes = await dispatch('/api/admin/support/live-chat/queue', {}, adminCookie)
    expect(adminRes!.status).toBe(200)
    const json = (await adminRes!.json()) as QueueResponse
    expect(Array.isArray(json.queue)).toBe(true)
  })

  it('allows full operator workflow: claim, message, and close', async () => {
    // 1. Create session
    const createRes = await dispatch('/api/support/live-chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        consentGiven: true,
        consentPolicyHash: policyHash,
        department: 'sales',
        customerName: 'Cliente Presupuesto'
      })
    })
    const { session } = (await createRes!.json()) as SessionResponse

    // 2. Operator claims session
    const claimRes = await dispatch(
      `/api/admin/support/live-chat/sessions/${session.id}/claim`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: session.currentVersion,
          operatorName: 'Marta Comercial'
        })
      },
      adminCookie
    )
    expect(claimRes!.status).toBe(200)
    const claimedJson = (await claimRes!.json()) as SessionResponse
    expect(claimedJson.session.status).toBe('in_progress')

    // 3. Operator sends message
    const msgRes = await dispatch(
      `/api/support/live-chat/sessions/${session.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Buenos días, le atiende Marta. ¿En qué le puedo asistir?'
        })
      },
      adminCookie
    )
    expect(msgRes!.status).toBe(201)
    const msgJson = (await msgRes!.json()) as MessageResponse
    expect(msgJson.message.isHuman).toBe(1)

    // 4. Close session
    const closeRes = await dispatch(
      `/api/admin/support/live-chat/sessions/${session.id}/close`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: claimedJson.session.currentVersion,
          closureReason: 'resolved',
          resolutionSummary: 'Presupuesto enviado por email corporativo.'
        })
      },
      adminCookie
    )
    expect(closeRes!.status).toBe(200)

    // 5. Read transcript
    const transRes = await dispatch(`/api/support/live-chat/sessions/${session.id}/transcript`)
    expect(transRes!.status).toBe(200)
    const transJson = (await transRes!.json()) as TranscriptResponse
    expect(transJson.transcript.messages.length).toBeGreaterThan(0)
  })
})
