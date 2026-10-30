import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { supportFixture, CLAIMS, BUYER_CLAIMS } from './d1-support-fixture'
import {
  requestLiveChatSession,
  claimLiveChatSession,
  sendLiveChatMessage,
  handoffLiveChatSession,
  escalateLiveChatToTicket,
  closeLiveChatSession,
  readLiveChatSession,
  readLiveChatTranscript,
  listActiveLiveChatQueue,
  isSupportChatOperatingHours,
  SUPPORT_CHAT_DISCLAIMER
} from '../../workers/support/live-chat'

// Support chat only opens in business hours and `now` defaults to the real clock, so the tests that
// exercise an open chat use the next weekday 10:00 UTC at or after the real clock (never before the
// fixture rows) plus an offset in milliseconds.
function businessUtc(offset = 0): string {
  const d = new Date()
  d.setUTCHours(10, 0, 0, 0)
  if (d.getTime() < Date.now()) d.setUTCDate(d.getUTCDate() + 1)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1)
  return new Date(d.getTime() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

describe('SUP-011 Live human support chat with context', () => {
  let f: Awaited<ReturnType<typeof supportFixture>>
  const policyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  const SUNDAY_MIDNIGHT = '2026-10-25T00:00:00Z' // Outside business hours (Sunday)
  const WEDNESDAY_10AM = '2026-10-28T10:00:00Z' // Deterministic Wednesday 10:00 UTC

  beforeEach(async () => {
    f = await supportFixture()
    // Chat instants are shifted into business hours; keep the fixture sessions valid for any of them.
    f.sqlite.exec("UPDATE auth_sessions SET expires_at='2099-12-31T23:59:59Z'")
    const migration = await readFile(
      new URL('../../db/d1/migrations/0102_support_live_chat_and_account_managers.sql', import.meta.url),
      'utf8'
    )
    f.sqlite.exec(migration)
  })

  afterEach(() => f.sqlite.close())

  it('guarantees no bot mimicking person and exposes human-only disclaimer', () => {
    expect(SUPPORT_CHAT_DISCLAIMER).toContain('humana')
    expect(SUPPORT_CHAT_DISCLAIMER).toContain('No utilizamos bots')
  })

  it('evaluates business operating hours deterministically', () => {
    const openCheck = isSupportChatOperatingHours(WEDNESDAY_10AM)
    expect(openCheck.isOpen).toBe(true)

    const closedCheck = isSupportChatOperatingHours(SUNDAY_MIDNIGHT)
    expect(closedCheck.isOpen).toBe(false)
    expect(closedCheck.nextOpeningAt).toBeDefined()
  })

  it('rejects chat session creation outside operating hours', async () => {
    await expect(
      requestLiveChatSession(f.database, {
        consentGiven: true,
        consentPolicyHash: policyHash,
        department: 'general',
        customerName: 'Cliente Domingo',
        now: SUNDAY_MIDNIGHT
      })
    ).rejects.toThrow('outside_business_hours')
  })

  it('rejects chat session without mandatory consent', async () => {
    await expect(
      requestLiveChatSession(f.database, {
        consentGiven: false as unknown as true,
        consentPolicyHash: policyHash,
        department: 'general',
        now: WEDNESDAY_10AM
      })
    ).rejects.toThrow('consent_required')
  })

  it('enqueues chat session with queue position, estimated wait and context', async () => {
    const session1 = await requestLiveChatSession(f.database, {
      consentGiven: true,
      consentPolicyHash: policyHash,
      department: 'technical',
      customerName: 'Comprador Industrial',
      initialMessage: 'Tengo una duda con la ficha técnica del desengrasante.',
      context: {
        url: 'https://neteco.test/producto/desengrasante-industrial-5l',
        productSlug: 'desengrasante-industrial-5l',
        categorySlug: 'limpieza-industrial'
      },
      now: businessUtc(0)
    })

    expect(session1.id).toBeDefined()
    expect(session1.publicRef).toMatch(/^CHAT-[0-9A-Z]{19}$/)
    expect(session1.status).toBe('waiting_operator')
    expect(session1.queuePosition).toBe(1)
    expect(session1.estimatedWaitSeconds).toBeGreaterThan(0)
    expect(session1.isHumanOnlyNotice).toBe(SUPPORT_CHAT_DISCLAIMER)
    expect(session1.context.productSlug).toBe('desengrasante-industrial-5l')

    // Second session gets queue position 2 and higher wait time
    const session2 = await requestLiveChatSession(f.database, {
      consentGiven: true,
      consentPolicyHash: policyHash,
      department: 'general',
      customerName: 'Segundo Cliente',
      now: businessUtc(0)
    })
    expect(session2.queuePosition).toBe(2)
    expect(session2.estimatedWaitSeconds).toBeGreaterThan(session1.estimatedWaitSeconds)
  })

  it('allows authenticated customer session binding and verified identity', async () => {
    const session = await requestLiveChatSession(
      f.database,
      {
        consentGiven: true,
        consentPolicyHash: policyHash,
        department: 'sales',
        context: { orderReference: 'ORD-2026-TEST' },
        now: businessUtc(0)
      },
      { claims: BUYER_CLAIMS }
    )

    expect(session.customerId).toBeDefined()
    const read = await readLiveChatSession(f.database, session.id, { claims: BUYER_CLAIMS })
    expect(read.customerId).toBe(session.customerId)
    expect(read.context.orderReference).toBe('ORD-2026-TEST')
  })

  it('allows operator to claim session with CAS and send human messages', async () => {
    const session = await requestLiveChatSession(f.database, {
      consentGiven: true,
      consentPolicyHash: policyHash,
      department: 'general',
      customerName: 'Usuario Esperando',
      now: businessUtc(0)
    })

    // Operator claims session
    const claimed = await claimLiveChatSession(
      f.database,
      CLAIMS,
      session.id,
      { expectedVersion: session.currentVersion, operatorName: 'Ana Soporte' },
      { now: businessUtc(1000) }
    )
    expect(claimed.status).toBe('in_progress')
    expect(claimed.operatorId).toBe(CLAIMS.identityId)
    expect(claimed.operatorName).toBe('Ana Soporte')
    expect(claimed.currentVersion).toBe(session.currentVersion + 1)

    // Operator sends a human response
    const msg = await sendLiveChatMessage(f.database, session.id, {
      senderType: 'operator',
      senderId: CLAIMS.identityId,
      senderName: 'Ana Soporte',
      message: 'Hola, soy Ana de Neteco. ¿En qué puedo ayudarte hoy?',
      now: businessUtc(2000)
    })
    expect(msg.isHuman).toBe(1)
    expect(msg.sequence).toBeGreaterThan(0)
    expect(msg.message).toContain('Ana de Neteco')

    // Customer sends reply
    const reply = await sendLiveChatMessage(f.database, session.id, {
      senderType: 'customer',
      senderName: 'Usuario Esperando',
      message: 'Necesito consultar el plazo de entrega para Valencia.',
      now: businessUtc(3000)
    })
    expect(reply.isHuman).toBe(1)
    expect(reply.sequence).toBe(msg.sequence + 1)
  })

  it('enforces CAS on operator claim against concurrent claims', async () => {
    const session = await requestLiveChatSession(f.database, {
      consentGiven: true,
      consentPolicyHash: policyHash,
      department: 'general',
      now: businessUtc(0)
    })

    // First claim succeeds
    await claimLiveChatSession(
      f.database,
      CLAIMS,
      session.id,
      { expectedVersion: 1, operatorName: 'Operador 1' },
      { now: businessUtc(1000) }
    )

    // Second claim with stale expectedVersion 1 fails with version conflict
    await expect(
      claimLiveChatSession(
        f.database,
        CLAIMS,
        session.id,
        { expectedVersion: 1, operatorName: 'Operador 2' },
        { now: businessUtc(2000) }
      )
    ).rejects.toThrow('version_conflict')
  })

  it('supports department or operator handoff with context preservation', async () => {
    const session = await requestLiveChatSession(f.database, {
      consentGiven: true,
      consentPolicyHash: policyHash,
      department: 'general',
      now: businessUtc(0)
    })
    const claimed = await claimLiveChatSession(
      f.database,
      CLAIMS,
      session.id,
      { expectedVersion: 1, operatorName: 'Operador Triaje' },
      { now: businessUtc(1000) }
    )

    // Handoff to logistics department
    const handedOff = await handoffLiveChatSession(
      f.database,
      CLAIMS,
      session.id,
      {
        expectedVersion: claimed.currentVersion,
        targetDepartment: 'logistics',
        note: 'Cliente consulta incidencia con transportista regional.'
      },
      { now: businessUtc(2000) }
    )

    expect(handedOff.status).toBe('transferred')
    expect(handedOff.department).toBe('logistics')

    const transcript = await readLiveChatTranscript(f.database, session.id)
    const systemNotes = transcript.messages.filter((m) => m.senderType === 'system')
    expect(systemNotes.some((m) => m.message.includes('logistics') || m.message.includes('transferido'))).toBe(true)
  })

  it('escalates chat to formal support ticket when issue cannot be resolved in live chat', async () => {
    const session = await requestLiveChatSession(f.database, {
      consentGiven: true,
      consentPolicyHash: policyHash,
      department: 'technical',
      customerName: 'Cliente Ficha Seguridad',
      context: { productSlug: 'lejia-alimentaria-10l' },
      now: businessUtc(0)
    })
    const claimed = await claimLiveChatSession(
      f.database,
      CLAIMS,
      session.id,
      { expectedVersion: 1, operatorName: 'Carlos Técnico' },
      { now: businessUtc(1000) }
    )

    const escalated = await escalateLiveChatToTicket(
      f.database,
      CLAIMS,
      session.id,
      {
        expectedVersion: claimed.currentVersion,
        category: 'product',
        priority: 'high',
        summary: 'Requiere revisión formal de la ficha de seguridad certificada por laboratorio.'
      },
      { now: businessUtc(2000) }
    )

    expect(escalated.status).toBe('escalated_ticket')
    expect(escalated.ticketId).toBeDefined()
    expect(escalated.ticketRef).toMatch(/^SOP-[0-9A-F]{24}$/)
  })

  it('closes live chat cleanly and records performance duration metrics', async () => {
    const session = await requestLiveChatSession(f.database, {
      consentGiven: true,
      consentPolicyHash: policyHash,
      department: 'sales',
      now: businessUtc(0)
    })
    const claimed = await claimLiveChatSession(
      f.database,
      CLAIMS,
      session.id,
      { expectedVersion: 1, operatorName: 'Beatriz Ventas' },
      { now: businessUtc(120000) } // 2 minutes later
    )

    const closed = await closeLiveChatSession(
      f.database,
      CLAIMS,
      session.id,
      {
        expectedVersion: claimed.currentVersion,
        closureReason: 'resolved',
        resolutionSummary: 'Consulta resuelta favorablemente con enlace a presupuesto.'
      },
      { now: businessUtc(900000) } // 15 minutes later
    )

    expect(closed.status).toBe('resolved')
    expect(closed.waitedSeconds).toBe(120)
    expect(closed.durationSeconds).toBe(780) // 900 - 120 = 780s
  })

  it('provides immutable audit transcript with timestamps and proof of consent', async () => {
    const session = await requestLiveChatSession(f.database, {
      consentGiven: true,
      consentPolicyHash: policyHash,
      department: 'general',
      customerName: 'Auditor Calidad',
      initialMessage: 'Verificación de trazabilidad.',
      now: businessUtc(0)
    })

    const transcript = await readLiveChatTranscript(f.database, session.id)
    expect(transcript.sessionRef).toBe(session.publicRef)
    expect(transcript.consent.givenAt).toBeDefined()
    expect(transcript.consent.policyHash).toBe(policyHash)
    expect(transcript.messages.length).toBeGreaterThan(0)
    expect(transcript.messages[0]?.message).toBe('Verificación de trazabilidad.')
  })

  it('lists active live chat queue for authorized operators', async () => {
    const session = await requestLiveChatSession(f.database, {
      consentGiven: true,
      consentPolicyHash: policyHash,
      department: 'billing',
      customerName: 'Cliente Cola',
      now: businessUtc(0)
    })

    const queue = await listActiveLiveChatQueue(f.database, CLAIMS, { now: businessUtc(1000) })
    expect(queue.length).toBeGreaterThan(0)
    expect(queue.some((s) => s.id === session.id)).toBe(true)
  })
})
