import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { supportFixture } from './d1-support-fixture'
import {
  handleSupportCopilotHttp,
  ownsSupportCopilotNamespace,
  type SupportCopilotHttpDependencies
} from '../../workers/support/copilot-http'

const ORIGIN = 'https://admin.neteco.test'

describe('SUP-019: Support Copilot HTTP endpoints', () => {
  let f: Awaited<ReturnType<typeof supportFixture>>
  let ticketId: string
  let deps: SupportCopilotHttpDependencies

  beforeEach(async () => {
    f = await supportFixture()
    f.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0110_rca_copilot_audiences.sql', import.meta.url), 'utf8')
    )
    const ticket = await f.ticket()
    const row = f.sqlite.prepare('SELECT id FROM support_tickets WHERE public_ref = ?').get(ticket.publicRef) as {
      id: string
    }
    ticketId = row.id

    deps = {
      database: f.database,
      sessionCookieConfiguration: f.deps.sessionCookieConfiguration,
      origin: ORIGIN,
      edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
      rateLimitPepper: 'pepper-1234567890abcdef'
    }
  })

  afterEach(() => {
    f.sqlite.close()
  })

  it('recognizes namespace correctly', () => {
    expect(ownsSupportCopilotNamespace('/api/admin/support/copilot/draft')).toBe(true)
    expect(ownsSupportCopilotNamespace('/api/admin/support/copilot/123/decision')).toBe(true)
    expect(ownsSupportCopilotNamespace('/api/admin/support/copilot/123/evaluate')).toBe(true)
    expect(ownsSupportCopilotNamespace('/api/admin/support/copilot/tickets/123')).toBe(true)
    expect(ownsSupportCopilotNamespace('/api/admin/support/chat')).toBe(false)
  })

  it('generates draft via POST endpoint', async () => {
    const req = new Request(`${ORIGIN}/api/admin/support/copilot/draft`, {
      method: 'POST',
      headers: {
        Cookie: f.adminCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-copilot-draft-1'
      },
      body: JSON.stringify({
        ticketId,
        query: 'Consulta de entrega'
      })
    })

    const res = await handleSupportCopilotHttp(req, deps)
    expect(res!.status).toBe(201)
    const data = (await res!.json()) as { interactionId: string; proposedReply: string; citations: unknown[] }
    expect(data.interactionId).toBeDefined()
    expect(data.proposedReply).toBeDefined()
    expect(data.citations.length).toBeGreaterThan(0)
  })

  it('records human approval decision via POST endpoint', async () => {
    // First generate draft
    const draftReq = new Request(`${ORIGIN}/api/admin/support/copilot/draft`, {
      method: 'POST',
      headers: {
        Cookie: f.adminCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-copilot-draft-2'
      },
      body: JSON.stringify({ ticketId })
    })
    const draftRes = await handleSupportCopilotHttp(draftReq, deps)
    const { interactionId } = (await draftRes!.json()) as { interactionId: string }

    // Human decision
    const decReq = new Request(`${ORIGIN}/api/admin/support/copilot/${interactionId}/decision`, {
      method: 'POST',
      headers: {
        Cookie: f.adminCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-copilot-dec-1'
      },
      body: JSON.stringify({
        expectedVersion: 1,
        decision: 'approve'
      })
    })

    const decRes = await handleSupportCopilotHttp(decReq, deps)
    expect(decRes!.status).toBe(200)
    const decData = (await decRes!.json()) as { approvalStatus: string }
    expect(decData.approvalStatus).toBe('approved')
  })

  it('rejects access when session authorization expires mid-flight', async () => {
    let count = 0
    const req = new Request(`${ORIGIN}/api/admin/support/copilot/tickets/${ticketId}`, {
      headers: { Cookie: f.adminCookie }
    })
    const proxyDeps = {
      ...deps,
      now: () => {
        count++
        if (count > 1) {
          return '2099-01-01T00:00:00Z'
        }
        return '2026-10-29T12:00:00Z'
      }
    }
    const res = await handleSupportCopilotHttp(req, proxyDeps)
    expect(res!.status).toBe(403)
    const data = (await res!.json()) as { error: { code: string } }
    expect(data.error.code).toBe('forbidden')
  })
})
